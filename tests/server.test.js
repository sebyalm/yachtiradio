const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createServer } = require("../server");

function listen() {
  const server = createServer();
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        server
      });
    });
  });
}

async function readUntil(reader, pattern) {
  const decoder = new TextDecoder();
  let buffer = "";

  for (let i = 0; i < 20; i += 1) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    if (buffer.includes(pattern)) {
      return buffer;
    }
  }

  return buffer;
}

test("serves the app shell and health endpoint", async (t) => {
  const { baseUrl, server } = await listen();
  t.after(() => server.close());

  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Yachtie Radio/);

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.deepEqual(healthBody.rooms, []);
  assert.ok(Array.isArray(healthBody.lanUrls));

  const appScript = await fetch(`${baseUrl}/app.js?v=test`);
  assert.equal(appScript.status, 200);
  assert.equal(appScript.headers.get("cache-control"), "no-cache");
});

test("validates malformed signal messages", async (t) => {
  const { baseUrl, server } = await listen();
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/api/signal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ room: "deck", type: "offer" })
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /valid from and type/);
});

test("broadcasts talking signals to room peers", async (t) => {
  const { baseUrl, server } = await listen();
  t.after(() => server.close());

  const events = await fetch(`${baseUrl}/api/events?room=deck&clientId=bravo&name=Bravo`);
  assert.equal(events.status, 200);
  const reader = events.body.getReader();
  t.after(() => reader.cancel());

  const ready = await readUntil(reader, "event: snapshot");
  assert.match(ready, /event: ready/);

  const signal = await fetch(`${baseUrl}/api/signal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      from: "alpha",
      payload: { talking: true },
      room: "deck",
      type: "talking"
    })
  });
  assert.equal(signal.status, 202);

  const received = await readUntil(reader, '"type":"talking"');
  assert.match(received, /"from":"alpha"/);
  assert.match(received, /"talking":true/);
});
