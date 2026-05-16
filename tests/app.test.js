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

function createHarness({ getUserMedia }) {
  const ids = [
    "eventLog",
    "joinButton",
    "leaveButton",
    "nameInput",
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
    fetch: () => Promise.resolve({ ok: true }),
    localStorage: storage(),
    navigator: {
      mediaDevices: {
        getUserMedia
      }
    },
    sessionStorage: storage(),
    URL,
    window: {
      addEventListener() {},
      location: {
        origin: "http://localhost:3000"
      }
    }
  };
  context.globalThis = context;

  const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  vm.runInNewContext(source, context);

  return { context, elements, EventSourceMock };
}

test("join enters the channel even when microphone permission stalls", async () => {
  const { elements, EventSourceMock } = createHarness({
    getUserMedia: () => new Promise(() => {})
  });

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

