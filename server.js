const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { URL } = require("node:url");

const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULT_PORT = Number.parseInt(process.env.PORT || "3000", 10);
const MAX_JSON_BYTES = 128 * 1024;

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json; charset=utf-8"]
]);

const SIGNAL_TYPES = new Set(["offer", "answer", "candidate", "talking"]);

function sanitizeRoom(value) {
  const room = String(value || "deck")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

  return room || "deck";
}

function sanitizeText(value, fallback, maxLength) {
  const text = String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);

  return text || fallback;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";

    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_JSON_BYTES) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function clientPublicView(client) {
  return {
    id: client.id,
    name: client.name,
    joinedAt: client.joinedAt
  };
}

function createApp({ publicDir = PUBLIC_DIR } = {}) {
  const rooms = new Map();

  function getRoom(name) {
    const roomName = sanitizeRoom(name);
    let room = rooms.get(roomName);
    if (!room) {
      room = { name: roomName, clients: new Map() };
      rooms.set(roomName, room);
    }
    return room;
  }

  function pruneRoom(room) {
    if (room.clients.size === 0) {
      rooms.delete(room.name);
    }
  }

  function broadcast(room, event, payload, exceptClientId) {
    for (const [clientId, client] of room.clients) {
      if (clientId !== exceptClientId) {
        sendEvent(client.res, event, payload);
      }
    }
  }

  async function handleEvents(req, res, requestUrl) {
    const room = getRoom(requestUrl.searchParams.get("room"));
    const clientId = sanitizeText(requestUrl.searchParams.get("clientId"), "", 64);
    const name = sanitizeText(requestUrl.searchParams.get("name"), "Crew", 40);

    if (!clientId) {
      sendJson(res, 400, { error: "clientId is required" });
      return;
    }

    const peers = Array.from(room.clients.values()).map(clientPublicView);
    const previous = room.clients.get(clientId);
    if (previous) {
      sendEvent(previous.res, "replaced", { reason: "A newer tab joined with the same client id." });
      previous.res.end();
    }

    res.writeHead(200, {
      "cache-control": "no-cache, no-store",
      "connection": "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no"
    });
    res.write(": connected\n\n");

    const client = {
      id: clientId,
      name,
      joinedAt: new Date().toISOString(),
      res
    };
    room.clients.set(clientId, client);

    sendEvent(res, "ready", {
      room: room.name,
      self: clientPublicView(client)
    });
    sendEvent(res, "snapshot", { peers });
    broadcast(room, "peer-joined", { peer: clientPublicView(client) }, clientId);

    const heartbeat = setInterval(() => {
      sendEvent(res, "ping", { now: Date.now() });
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      if (room.clients.get(clientId) === client) {
        room.clients.delete(clientId);
        broadcast(room, "peer-left", { peerId: clientId }, clientId);
        pruneRoom(room);
      }
    });
  }

  async function handleSignal(req, res) {
    let message;
    try {
      message = await readJson(req);
    } catch (error) {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const room = getRoom(message.room);
    const from = sanitizeText(message.from, "", 64);
    const to = sanitizeText(message.to, "", 64);
    const type = sanitizeText(message.type, "", 24);

    if (!from || !SIGNAL_TYPES.has(type)) {
      sendJson(res, 400, { error: "Signal requires a valid from and type" });
      return;
    }

    if (type !== "talking" && !to) {
      sendJson(res, 400, { error: `${type} signals require a target peer` });
      return;
    }

    const sender = room.clients.get(from);
    const payload = {
      from,
      type,
      payload: message.payload || null,
      peer: sender ? clientPublicView(sender) : null,
      sentAt: Date.now()
    };

    if (to) {
      const target = room.clients.get(to);
      if (target) {
        sendEvent(target.res, "signal", payload);
      }
    } else {
      broadcast(room, "signal", payload, from);
    }

    sendJson(res, 202, { ok: true });
  }

  function handleStatic(req, res, requestUrl) {
    const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch (error) {
      sendJson(res, 400, { error: "Bad path" });
      return;
    }

    const filePath = path.resolve(publicDir, `.${decodedPath}`);
    const publicRoot = path.resolve(publicDir);

    if (filePath !== publicRoot && !filePath.startsWith(publicRoot + path.sep)) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }

    fs.stat(filePath, (statError, stat) => {
      if (statError || !stat.isFile()) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600",
        "content-type": MIME_TYPES.get(ext) || "application/octet-stream"
      });
      fs.createReadStream(filePath).pipe(res);
    });
  }

  return async function app(req, res) {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET,POST,OPTIONS"
      });
      res.end();
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        rooms: Array.from(rooms.values()).map((room) => ({
          name: room.name,
          peers: room.clients.size
        }))
      });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/events") {
      await handleEvents(req, res, requestUrl);
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/signal") {
      await handleSignal(req, res);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      handleStatic(req, res, requestUrl);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  };
}

function createServer(app = createApp()) {
  const keyPath = process.env.YACHTIE_TLS_KEY;
  const certPath = process.env.YACHTIE_TLS_CERT;

  if (keyPath && certPath) {
    return https.createServer(
      {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
      },
      app
    );
  }

  return http.createServer(app);
}

if (require.main === module) {
  const server = createServer();
  const scheme = process.env.YACHTIE_TLS_KEY && process.env.YACHTIE_TLS_CERT ? "https" : "http";

  server.listen(DEFAULT_PORT, "0.0.0.0", () => {
    const address = server.address();
    console.log(`Yachtie Radio listening on ${scheme}://localhost:${address.port}`);
    console.log(`On another device, open ${scheme}://<this-computer-lan-ip>:${address.port}`);
  });
}

module.exports = {
  createApp,
  createServer,
  sanitizeRoom,
  sanitizeText
};
