(function () {
  const $ = (id) => document.getElementById(id);

  const elements = {
    body: document.body,
    eventLog: $("eventLog"),
    joinButton: $("joinButton"),
    leaveButton: $("leaveButton"),
    nameInput: $("nameInput"),
    peerCount: $("peerCount"),
    peerList: $("peerList"),
    remoteAudio: $("remoteAudio"),
    roomInput: $("roomInput"),
    signalPill: $("signalPill"),
    statusText: $("statusText"),
    talkButton: $("talkButton"),
    talkButtonText: $("talkButtonText")
  };

  const state = {
    clientId: getClientId(),
    eventSource: null,
    joined: false,
    localStream: null,
    micError: "",
    microphonePromise: null,
    name: localStorage.getItem("yachtie-radio-name") || "",
    peers: new Map(),
    pressActive: false,
    remoteTalking: new Map(),
    room: localStorage.getItem("yachtie-radio-room") || "deck",
    transmitting: false
  };

  elements.nameInput.value = state.name;
  elements.roomInput.value = state.room;

  elements.joinButton.addEventListener("click", joinRadio);
  elements.leaveButton.addEventListener("click", leaveRadio);
  elements.talkButton.addEventListener("pointerdown", beginTransmit);
  elements.talkButton.addEventListener("pointerup", endTransmit);
  elements.talkButton.addEventListener("pointercancel", endTransmit);
  elements.talkButton.addEventListener("pointerleave", endTransmit);
  elements.talkButton.addEventListener("mousedown", beginTransmit);
  elements.talkButton.addEventListener("mouseup", endTransmit);
  elements.talkButton.addEventListener("mouseleave", endTransmit);
  elements.talkButton.addEventListener("touchstart", beginTransmit, { passive: false });
  elements.talkButton.addEventListener("touchend", endTransmit);
  elements.talkButton.addEventListener("keydown", (event) => {
    if (event.code === "Space" || event.code === "Enter") {
      beginTransmit(event);
    }
  });
  elements.talkButton.addEventListener("keyup", (event) => {
    if (event.code === "Space" || event.code === "Enter") {
      endTransmit(event);
    }
  });
  window.addEventListener("pagehide", () => {
    stopTransmit();
    leaveRadio();
  });

  render();

  function getClientId() {
    const existing = sessionStorage.getItem("yachtie-radio-client-id");
    if (existing) {
      return existing;
    }

    const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    sessionStorage.setItem("yachtie-radio-client-id", id);
    return id;
  }

  async function joinRadio() {
    if (state.joined) {
      return;
    }

    setBusy(true);
    state.name = normalizeInput(elements.nameInput.value, "Crew");
    state.room = normalizeInput(elements.roomInput.value, "deck").toLowerCase();
    localStorage.setItem("yachtie-radio-name", state.name);
    localStorage.setItem("yachtie-radio-room", state.room);

    try {
      connectEvents();
      state.joined = true;
      addLog(`Joined #${state.room} as ${state.name}`);
      render();
    } catch (error) {
      addLog(error.message || "Could not join radio");
      await leaveRadio();
    } finally {
      setBusy(false);
    }
  }

  async function prepareMicrophone() {
    if (state.localStream) {
      return state.localStream;
    }

    if (state.microphonePromise) {
      return state.microphonePromise;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Microphone access needs HTTPS on LAN or localhost during development.");
    }

    let timeoutId = 0;
    const timeout = new Promise((resolve, reject) => {
      timeoutId = window.setTimeout(() => {
        reject(new Error("Microphone permission is still waiting. Check the browser permission prompt."));
      }, 10000);
    });

    const microphone = navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      },
      video: false
    }).then((stream) => {
      for (const track of stream.getAudioTracks()) {
        track.enabled = false;
      }
      state.localStream = stream;
      addLog("Microphone ready");
      return stream;
    });

    state.microphonePromise = Promise.race([microphone, timeout]).finally(() => {
      window.clearTimeout(timeoutId);
      state.microphonePromise = null;
      render();
    });

    render();
    return state.microphonePromise;
  }

  function connectEvents() {
    const url = new URL("/api/events", window.location.origin);
    url.searchParams.set("room", state.room);
    url.searchParams.set("clientId", state.clientId);
    url.searchParams.set("name", state.name);

    const events = new EventSource(url);
    state.eventSource = events;

    events.addEventListener("ready", (event) => {
      const message = JSON.parse(event.data);
      state.room = message.room;
      addLog(`Channel ready: #${state.room}`);
      render();
    });

    events.addEventListener("snapshot", (event) => {
      const message = JSON.parse(event.data);
      for (const peer of message.peers || []) {
        ensurePeer(peer, true);
      }
      render();
    });

    events.addEventListener("peer-joined", (event) => {
      const message = JSON.parse(event.data);
      if (message.peer && message.peer.id !== state.clientId) {
        rememberPeer(message.peer);
        addLog(`${message.peer.name} joined`);
        render();
      }
    });

    events.addEventListener("peer-left", (event) => {
      const message = JSON.parse(event.data);
      removePeer(message.peerId);
      render();
    });

    events.addEventListener("signal", (event) => {
      handleSignal(JSON.parse(event.data));
    });

    events.addEventListener("replaced", () => {
      addLog("This tab was replaced by another tab.");
      leaveRadio();
    });

    events.onerror = () => {
      if (state.joined) {
        addLog("Signal link interrupted; retrying.");
      }
      render();
    };
  }

  async function ensurePeer(peer, shouldOffer) {
    if (!peer || peer.id === state.clientId) {
      return null;
    }

    let slot = state.peers.get(peer.id);
    if (slot && typeof slot.pc.createOffer === "function" && slot.pc.signalingState !== "closed") {
      slot.name = peer.name || slot.name;
      return slot;
    }

    const pc = new RTCPeerConnection({
      iceCandidatePoolSize: 2,
      iceServers: []
    });

    slot = {
      audio: null,
      audioSender: null,
      audioTransceiver: null,
      candidates: [],
      id: peer.id,
      name: peer.name || "Crew",
      pc
    };
    state.peers.set(peer.id, slot);

    if (pc.addTransceiver) {
      const transceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
      slot.audioSender = transceiver.sender;
      slot.audioTransceiver = transceiver;
    } else if (state.localStream && pc.addTrack) {
      slot.audioSender = pc.addTrack(state.localStream.getAudioTracks()[0], state.localStream);
    }
    await syncLocalAudioTrack(slot);

    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        sendSignal("candidate", peer.id, event.candidate);
      }
    });

    pc.addEventListener("track", (event) => {
      attachRemoteAudio(peer.id, event.streams[0]);
    });

    pc.addEventListener("connectionstatechange", render);
    pc.addEventListener("iceconnectionstatechange", render);

    if (shouldOffer) {
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await sendSignal("offer", peer.id, pc.localDescription);
    }

    return slot;
  }

  async function handleSignal(message) {
    if (!message || message.from === state.clientId) {
      return;
    }

    if (message.type === "talking") {
      const talking = Boolean(message.payload && message.payload.talking);
      state.remoteTalking.set(message.from, talking);
      if (message.peer) {
        rememberPeer(message.peer);
      }
      render();
      return;
    }

    const slot = await ensurePeer(message.peer || { id: message.from, name: "Crew" }, false);
    if (!slot) {
      return;
    }

    const pc = slot.pc;

    if (message.type === "offer") {
      await pc.setRemoteDescription(message.payload);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await flushCandidates(slot);
      await sendSignal("answer", message.from, pc.localDescription);
      addLog(`Linked with ${slot.name}`);
      return;
    }

    if (message.type === "answer") {
      await pc.setRemoteDescription(message.payload);
      await flushCandidates(slot);
      addLog(`Linked with ${slot.name}`);
      return;
    }

    if (message.type === "candidate" && message.payload) {
      if (pc.remoteDescription) {
        await pc.addIceCandidate(message.payload);
      } else {
        slot.candidates.push(message.payload);
      }
    }
  }

  async function flushCandidates(slot) {
    while (slot.candidates.length > 0) {
      await slot.pc.addIceCandidate(slot.candidates.shift());
    }
  }

  function rememberPeer(peer) {
    const existing = state.peers.get(peer.id);
    if (existing) {
      existing.name = peer.name || existing.name;
      return;
    }

    state.peers.set(peer.id, {
      audio: null,
      audioSender: null,
      audioTransceiver: null,
      candidates: [],
      id: peer.id,
      name: peer.name || "Crew",
      pc: { connectionState: "new", iceConnectionState: "new", signalingState: "stable" }
    });
  }

  function removePeer(peerId) {
    const slot = state.peers.get(peerId);
    if (slot && slot.pc && typeof slot.pc.close === "function") {
      slot.pc.close();
    }
    if (slot && slot.audio) {
      slot.audio.remove();
    }
    state.peers.delete(peerId);
    state.remoteTalking.delete(peerId);
    addLog("Peer left");
  }

  function attachRemoteAudio(peerId, stream) {
    const slot = state.peers.get(peerId);
    if (!slot || slot.audio) {
      return;
    }

    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    audio.srcObject = stream;
    elements.remoteAudio.append(audio);
    slot.audio = audio;
    audio.play().catch(() => addLog("Tap Join again if audio stays muted."));
  }

  async function beginTransmit(event) {
    if (event) {
      event.preventDefault();
      if (event.pointerId !== undefined && event.currentTarget && event.currentTarget.setPointerCapture) {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    }

    if (!state.joined || state.transmitting) {
      return;
    }

    state.pressActive = true;
    state.micError = "";
    render();

    if (state.microphonePromise) {
      return;
    }

    try {
      await prepareMicrophone();
      if (!state.pressActive || !state.joined) {
        return;
      }
      await syncLocalAudioTrack();
      setTransmit(true);
    } catch (error) {
      state.pressActive = false;
      state.micError = friendlyMicError(error);
      addLog(state.micError);
      render();
    }
  }

  function endTransmit(event) {
    if (event) {
      event.preventDefault();
      if (event.pointerId !== undefined && event.currentTarget && event.currentTarget.releasePointerCapture) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
    state.pressActive = false;
    stopTransmit();
    render();
  }

  function stopTransmit() {
    if (!state.transmitting) {
      return;
    }
    setTransmit(false);
  }

  function setTransmit(enabled) {
    state.transmitting = enabled;
    if (state.localStream) {
      for (const track of state.localStream.getAudioTracks()) {
        track.enabled = enabled;
      }
    }
    sendSignal("talking", "", { talking: enabled });
    render();
  }

  function friendlyMicError(error) {
    if (!error) {
      return "Microphone is not available.";
    }

    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Microphone is blocked. Allow mic access in the browser.";
    }

    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      return "No microphone was found on this device.";
    }

    return error.message || "Microphone is not available.";
  }

  async function syncLocalAudioTrack(targetSlot) {
    if (!state.localStream) {
      return;
    }

    const [audioTrack] = state.localStream.getAudioTracks();
    if (!audioTrack) {
      return;
    }

    const slots = targetSlot ? [targetSlot] : Array.from(state.peers.values());
    await Promise.all(slots.map(async (slot) => {
      if (slot.audioSender && slot.audioSender.replaceTrack) {
        await slot.audioSender.replaceTrack(audioTrack);
        return;
      }

      if (slot.pc && slot.pc.addTrack) {
        slot.audioSender = slot.pc.addTrack(audioTrack, state.localStream);
      }
    }));
  }

  async function sendSignal(type, to, payload) {
    if (!state.joined && type !== "candidate") {
      return;
    }

    await fetch("/api/signal", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from: state.clientId,
        payload,
        room: state.room,
        to,
        type
      })
    }).catch(() => {
      addLog("Signal send failed");
    });
  }

  async function leaveRadio() {
    stopTransmit();

    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }

    for (const slot of state.peers.values()) {
      if (slot.pc && typeof slot.pc.close === "function") {
        slot.pc.close();
      }
      if (slot.audio) {
        slot.audio.remove();
      }
    }

    state.peers.clear();
    state.remoteTalking.clear();
    state.joined = false;
    state.micError = "";
    state.microphonePromise = null;
    state.pressActive = false;

    if (state.localStream) {
      for (const track of state.localStream.getTracks()) {
        track.stop();
      }
      state.localStream = null;
    }

    render();
  }

  function normalizeInput(value, fallback) {
    return String(value || "")
      .replace(/[^a-zA-Z0-9 _-]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40) || fallback;
  }

  function setBusy(isBusy) {
    elements.joinButton.disabled = isBusy || state.joined;
    elements.leaveButton.disabled = isBusy || !state.joined;
  }

  function render() {
    const remoteTalkers = Array.from(state.remoteTalking.entries())
      .filter(([, talking]) => talking)
      .map(([peerId]) => state.peers.get(peerId))
      .filter(Boolean);

    elements.body.classList.toggle("is-live", state.transmitting || remoteTalkers.length > 0);
    elements.talkButton.classList.toggle("is-transmitting", state.transmitting);
    elements.talkButton.disabled = !state.joined;
    elements.talkButton.setAttribute("aria-pressed", String(state.transmitting));
    elements.talkButtonText.textContent = state.transmitting
      ? "Transmitting"
      : state.pressActive
        ? "Starting Mic"
        : state.micError
          ? "Try Talk Again"
          : "Hold to Talk";
    elements.joinButton.disabled = state.joined;
    elements.leaveButton.disabled = !state.joined;
    elements.nameInput.disabled = state.joined;
    elements.roomInput.disabled = state.joined;

    if (!state.joined) {
      elements.statusText.textContent = "Offline";
      elements.signalPill.textContent = "LAN";
    } else if (state.transmitting) {
      elements.statusText.textContent = "On Air";
      elements.signalPill.textContent = "TX";
    } else if (state.micError) {
      elements.statusText.textContent = state.micError;
      elements.signalPill.textContent = "Mic";
    } else if (state.microphonePromise) {
      elements.statusText.textContent = "Allow microphone";
      elements.signalPill.textContent = "Mic";
    } else if (state.pressActive) {
      elements.statusText.textContent = "Starting microphone";
      elements.signalPill.textContent = "Mic";
    } else if (remoteTalkers.length > 0) {
      elements.statusText.textContent = `${remoteTalkers[0].name} is speaking`;
      elements.signalPill.textContent = "RX";
    } else {
      elements.statusText.textContent = `Listening on #${state.room}`;
      elements.signalPill.textContent = "Ready";
    }

    renderPeers();
  }

  function renderPeers() {
    const peers = Array.from(state.peers.values()).filter((slot) => slot.id !== state.clientId);
    elements.peerCount.textContent = `${peers.length} ${peers.length === 1 ? "peer" : "peers"}`;

    if (peers.length === 0) {
      elements.peerList.innerHTML = '<div class="peer-card"><strong>No crew yet</strong><span class="peer-state">Standing by</span></div>';
      return;
    }

    elements.peerList.replaceChildren(...peers.map((peer) => {
      const card = document.createElement("article");
      const speaking = Boolean(state.remoteTalking.get(peer.id));
      const connection = peer.pc.connectionState || peer.pc.iceConnectionState || "new";
      card.className = `peer-card${speaking ? " is-speaking" : ""}`;

      const name = document.createElement("strong");
      name.textContent = peer.name;

      const status = document.createElement("span");
      status.className = "peer-state";
      status.textContent = speaking ? "Speaking" : connection;

      card.append(name, status);
      return card;
    }));
  }

  function addLog(message) {
    const item = document.createElement("li");
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    item.textContent = `${time} ${message}`;
    elements.eventLog.prepend(item);

    while (elements.eventLog.children.length > 6) {
      elements.eventLog.lastElementChild.remove();
    }
  }
})();
