const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function storage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) || null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    }
  };
}

function createClassList() {
  return {
    values: new Set(),
    toggle(name, enabled) {
      if (enabled) {
        this.values.add(name);
      } else {
        this.values.delete(name);
      }
    }
  };
}

function createElement(tagName = "div") {
  const element = {
    ariaHidden: "",
    autoplay: false,
    children: [],
    classList: createClassList(),
    className: "",
    disabled: false,
    id: "",
    listeners: new Map(),
    playsInline: false,
    srcObject: null,
    textContent: "",
    value: "",
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    },
    append(...children) {
      this.children.push(...children);
    },
    prepend(child) {
      this.children.unshift(child);
    },
    remove() {
      this.removed = true;
    },
    replaceChildren(...children) {
      this.children = children;
    },
    setAttribute(name, value) {
      this[name] = value;
    }
  };

  if (tagName === "audio") {
    element.play = () => Promise.resolve();
  }

  Object.defineProperty(element, "lastElementChild", {
    get() {
      return this.children[this.children.length - 1] || null;
    }
  });

  Object.defineProperty(element, "innerHTML", {
    get() {
      return this._innerHTML || "";
    },
    set(value) {
      this._innerHTML = value;
      this.children = value ? [createElement()] : [];
    }
  });

  return element;
}

function createHarness({ fetch, getUserMedia, healthOk = true, healthPayload }) {
  const ids = [
    "copyAddressButton",
    "eventLog",
    "joinButton",
    "leaveButton",
    "nameInput",
    "networkAddress",
    "networkDetail",
    "networkPanel",
    "networkStatus",
    "peerCount",
    "peerList",
    "remoteAudio",
    "roomInput",
    "signalPill",
    "statusText",
    "talkButton",
    "talkButtonText"
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, createElement()]));

  class EventSourceMock {
    static instances = [];

    constructor(url) {
      this.listeners = new Map();
      this.url = url;
      EventSourceMock.instances.push(this);
    }

    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    }

    close() {
      this.closed = true;
    }
  }

  const defaultHealth = healthPayload || {
    ok: true,
    lanUrls: ["http://192.168.50.10:3000"],
    rooms: []
  };
  const fetchImpl = (url, options) => {
    if (String(url).includes("/api/health")) {
      return Promise.resolve({
        ok: healthOk,
        json: () => Promise.resolve(defaultHealth)
      });
    }

    if (fetch) {
      return fetch(url, options);
    }

    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({})
    });
  };

  const context = {
    EventSource: EventSourceMock,
    RTCPeerConnection: class {},
    crypto: {
      randomUUID: () => "client-a"
    },
    document: {
      body: createElement("body"),
      createElement,
      getElementById(id) {
        return elements[id];
      }
    },
    fetch: fetchImpl,
    localStorage: storage(),
    navigator: {
      clipboard: {
        writeText: () => Promise.resolve()
      },
      mediaDevices: {
        getUserMedia
      }
    },
    sessionStorage: storage(),
    URL,
    window: {
      addEventListener() {},
      clearTimeout,
      location: {
        origin: "http://localhost:3000"
      },
      setTimeout
    }
  };
  context.globalThis = context;

  const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  vm.runInNewContext(source, context);

  return { context, elements, EventSourceMock };
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test("hosted preview blocks channel join until the local radio server is available", async () => {
  const { elements, EventSourceMock } = createHarness({
    healthPayload: {
      error: "The hosted preview only serves the static app."
    },
    getUserMedia: () => Promise.resolve()
  });

  await flushAsync();
  assert.equal(elements.networkStatus.textContent, "Onboard radio server needed");
  assert.equal(elements.joinButton.disabled, true);

  elements.joinButton.listeners.get("click")();
  assert.equal(EventSourceMock.instances.length, 0);
});

test("join enters the channel even when microphone permission stalls", async () => {
  const { elements, EventSourceMock } = createHarness({
    getUserMedia: () => new Promise(() => {})
  });

  await flushAsync();
  elements.nameInput.value = "Alice";
  elements.roomInput.value = "Deck";
  elements.joinButton.listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(EventSourceMock.instances.length, 1);
  assert.match(EventSourceMock.instances[0].url.href, /room=deck/);
  assert.equal(elements.statusText.textContent, "Listening on #deck");
  assert.equal(elements.joinButton.disabled, true);
  assert.equal(elements.leaveButton.disabled, false);
});

test("holding talk reports microphone failures instead of falling back to listening", async () => {
  const error = new Error("Permission denied");
  error.name = "NotAllowedError";
  const { elements } = createHarness({
    getUserMedia: () => Promise.reject(error)
  });

  await flushAsync();
  elements.nameInput.value = "Alice";
  elements.roomInput.value = "Deck";
  await elements.joinButton.listeners.get("click")();
  await elements.talkButton.listeners.get("pointerdown")({
    currentTarget: elements.talkButton,
    pointerId: 1,
    preventDefault() {}
  });

  assert.match(elements.statusText.textContent, /Microphone is blocked/);
  assert.equal(elements.talkButtonText.textContent, "Try Talk Again");
});

test("holding talk enables the microphone track and sends a talking signal", async () => {
  const track = { enabled: true, stop() {} };
  const fetchCalls = [];
  const { elements } = createHarness({
    fetch: (url, options) => {
      fetchCalls.push({ url, options });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({})
      });
    },
    getUserMedia: () => Promise.resolve({
      getAudioTracks: () => [track],
      getTracks: () => [track]
    })
  });

  await flushAsync();
  elements.nameInput.value = "Alice";
  elements.roomInput.value = "Deck";
  await elements.joinButton.listeners.get("click")();
  await elements.talkButton.listeners.get("pointerdown")({
    currentTarget: elements.talkButton,
    pointerId: 1,
    preventDefault() {}
  });

  assert.equal(elements.statusText.textContent, "On Air");
  assert.equal(elements.talkButtonText.textContent, "Transmitting");
  assert.equal(track.enabled, true);

  const talkingSignal = fetchCalls
    .map((call) => JSON.parse(call.options.body))
    .find((body) => body.type === "talking" && body.payload.talking);
  assert.ok(talkingSignal);
});
