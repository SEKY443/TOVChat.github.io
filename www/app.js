import init, {
  encode_frames_to_pcm,
  scan_next_frame,
  build_nack_pcm,
  scan_for_nack,
} from "./pkg/tovchat_wasm.js";

const SR = 8000; // modem::SR -- outgoing PCM is always synthesized at this rate

const STORAGE_USERNAME = "tovchat_username";
const STORAGE_HISTORY = "tovchat_history";
const MAX_USERNAME_CHARS = 16;
const CHUNK_TEXT_CHARS = 700; // real-text budget per frame, leaving headroom for the envelope
const MAX_HISTORY_ENTRIES = 300;

const MSG_START = "\x02";
const USERNAME_SEP = "\x1F";
const MSG_SEP = "\x03";

const LISTEN_MODES = ["phone", "fast_air"];
const POLL_INTERVAL_MS = 1200;
const MAX_BUFFER_SECONDS = 40; // hard safety cap on the live capture ring buffer

// ============================= fatal error display =============================

// Any uncaught error here previously meant the page just silently did
// nothing -- a click handler that throws partway through leaves no visible
// trace without opening devtools. Surface it on the page instead.
function showFatalError(context, err) {
  console.error(context, err);
  let banner = document.getElementById("fatal-error-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "fatal-error-banner";
    banner.className = "fatal-error";
    document.body.prepend(banner);
  }
  banner.textContent = `▢ ${context}: ${err && err.message ? err.message : err} ▢`;
  banner.hidden = false;
}

window.addEventListener("error", (e) => showFatalError("SCRIPT ERROR", e.error || e.message));
window.addEventListener("unhandledrejection", (e) => showFatalError("SCRIPT ERROR", e.reason));

// ============================= storage =============================

function loadUsername() {
  try {
    return localStorage.getItem(STORAGE_USERNAME) || "";
  } catch (e) {
    showFatalError("CANNOT READ LOCAL STORAGE", e);
    return "";
  }
}

function saveUsername(name) {
  try {
    localStorage.setItem(STORAGE_USERNAME, name);
  } catch (e) {
    showFatalError("CANNOT SAVE USERNAME (PRIVATE BROWSING / STORAGE BLOCKED?)", e);
  }
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_HISTORY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHistory(history) {
  try {
    const trimmed = history.slice(-MAX_HISTORY_ENTRIES);
    localStorage.setItem(STORAGE_HISTORY, JSON.stringify(trimmed));
  } catch (e) {
    showFatalError("CANNOT SAVE HISTORY (PRIVATE BROWSING / STORAGE BLOCKED?)", e);
  }
}

// ============================= envelope =============================

function randomMsgId() {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function chunkText(text, maxChars) {
  const codepoints = Array.from(text);
  if (codepoints.length === 0) return [""];
  const chunks = [];
  for (let i = 0; i < codepoints.length; i += maxChars) {
    chunks.push(codepoints.slice(i, i + maxChars).join(""));
  }
  return chunks;
}

function tagChunk(id, username, chunkText_) {
  return `${MSG_START}${id}${USERNAME_SEP}${username}${MSG_SEP}${chunkText_}`;
}

function untagChunk(decoded) {
  if (!decoded.startsWith(MSG_START)) return null;
  const sepIdx = decoded.indexOf(USERNAME_SEP, 1);
  const endIdx = decoded.indexOf(MSG_SEP, sepIdx + 1);
  if (sepIdx === -1 || endIdx === -1) return null;
  return {
    id: decoded.slice(1, sepIdx),
    username: decoded.slice(sepIdx + 1, endIdx),
    text: decoded.slice(endIdx + 1),
  };
}

// Port of textovervoice-core's MessageReassembler::add -- see that module's
// doc comment for why (per-frame independent sync, drift bounded per
// chunk). Keyed additionally by envelope id since several messages'
// frames can be interleaved on one shared channel.
class Reassembler {
  constructor() {
    this.byId = new Map();
  }
  add(id, username, seq, text, moreFrames) {
    let entry = this.byId.get(id);
    if (!entry) {
      entry = { username, parts: new Map(), lastSeq: null };
      this.byId.set(id, entry);
    }
    entry.parts.set(seq, text);
    if (!moreFrames) entry.lastSeq = seq;

    if (entry.lastSeq !== null) {
      let complete = true;
      for (let i = 0; i <= entry.lastSeq; i++) {
        if (!entry.parts.has(i)) { complete = false; break; }
      }
      if (complete) {
        let full = "";
        for (let i = 0; i <= entry.lastSeq; i++) full += entry.parts.get(i);
        return { ok: true, username: entry.username, text: full, framesReceived: entry.parts.size, framesExpected: entry.lastSeq + 1 };
      }
    }
    return { ok: false, username: entry.username, framesReceived: entry.parts.size, framesExpected: entry.lastSeq === null ? null : entry.lastSeq + 1 };
  }
}

// ============================= dom refs =============================

const gateEl = document.getElementById("gate");
const gateInput = document.getElementById("gate-input");
const gateError = document.getElementById("gate-error");
const gateSubmit = document.getElementById("gate-submit");
const appEl = document.getElementById("app");
const whoamiEl = document.getElementById("whoami");
const historyEl = document.getElementById("history");
const textInput = document.getElementById("text-input");
const sendKey = document.getElementById("send-key");
const listenKey = document.getElementById("listen-key");
const fileInput = document.getElementById("file-input");
const carriageStatus = document.getElementById("carriage-status");
const bellEl = document.getElementById("bell");
const modeKeys = Array.from(document.querySelectorAll(".mode-key"));

// ============================= state =============================

let username = loadUsername();
let history = loadHistory();
let selectedMode = "phone";
let audioCtx = null;

let listening = false;
let mediaStream = null;
let workletNode = null;
let captureChunks = [];
let captureSampleRate = SR;
let scanPos = { phone: 0, fast_air: 0 };
let liveReassembler = new Reassembler();
let pollTimer = null;

// ============================= rendering =============================

function ringBell() {
  bellEl.currentTime = 0;
  bellEl.play().catch(() => {}); // browser may block autoplay before any gesture; harmless if so
}

function renderHistory() {
  historyEl.innerHTML = "";
  for (const entry of history) {
    historyEl.appendChild(renderEntry(entry));
  }
  historyEl.scrollTop = historyEl.scrollHeight;
}

function renderEntry(entry) {
  const slip = document.createElement("div");
  slip.className = "slip" + (entry.status === "incomplete" ? " incomplete" : "");

  const head = document.createElement("div");
  head.className = "slip-head";
  const dirLabel = entry.dir === "tx" ? "OUTGOING" : "INCOMING";
  const left = document.createElement("span");
  left.textContent = `${dirLabel} · ${entry.username || "UNKNOWN"} · #${entry.id}`;
  const right = document.createElement("span");
  right.textContent = statusLabel(entry);
  head.append(left, right);

  const text = document.createElement("div");
  text.className = "slip-text";
  text.textContent = entry.text;

  slip.append(head, text);

  if (entry.dir === "tx") {
    const foot = document.createElement("div");
    foot.className = "slip-foot";
    const spacer = document.createElement("span");
    spacer.textContent = new Date(entry.time).toLocaleTimeString();
    const resend = document.createElement("button");
    resend.className = "resend-tab";
    resend.textContent = "RESEND ▶";
    resend.type = "button";
    resend.addEventListener("click", () => resendOwnMessage(entry.id));
    foot.append(spacer, resend);
    slip.append(foot);
  } else {
    // Received messages get the same one-click resend the brief asks for
    // on every message -- but for something the OTHER side sent, "resend"
    // can only mean asking them for a fresh copy over the channel (a NACK
    // request), never a local replay -- offered whether this message is
    // still incomplete or already came through clean.
    const foot = document.createElement("div");
    foot.className = "slip-foot";
    const info = document.createElement("span");
    info.textContent =
      entry.status === "incomplete"
        ? entry.framesExpected
          ? `${entry.framesReceived} OF ${entry.framesExpected} FRAMES`
          : `${entry.framesReceived} FRAME(S) RECEIVED`
        : new Date(entry.time).toLocaleTimeString();
    const req = document.createElement("button");
    req.className = "resend-tab";
    req.textContent = "REQUEST RESEND ▶";
    req.type = "button";
    req.addEventListener("click", () => requestResend(entry.id));
    foot.append(info, req);
    slip.append(foot);
  }

  return slip;
}

function statusLabel(entry) {
  if (entry.dir === "tx") return "SENT";
  return entry.status === "incomplete" ? "INCOMPLETE" : "RECEIVED";
}

function setCarriageStatus(text) {
  carriageStatus.textContent = text;
}

// ============================= username gate =============================

function showGate() {
  gateEl.hidden = false;
  appEl.hidden = true;
  gateInput.focus();
}

function showApp() {
  gateEl.hidden = true;
  appEl.hidden = false;
  whoamiEl.textContent = `▸ ${username}`;
  renderHistory();
}

function validateUsername(name) {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "A NAME IS REQUIRED.";
  if (Array.from(trimmed).length > MAX_USERNAME_CHARS) {
    return `MAX ${MAX_USERNAME_CHARS} CHARACTERS (GOT ${Array.from(trimmed).length}).`;
  }
  return null;
}

function submitGate() {
  try {
    const name = gateInput.value;
    const err = validateUsername(name);
    if (err) {
      gateError.textContent = err;
      gateError.hidden = false;
      return;
    }
    username = name.trim();
    saveUsername(username);
    gateError.hidden = true;
    showApp();
  } catch (e) {
    showFatalError("COULD NOT START", e);
  }
}

gateSubmit.addEventListener("click", submitGate);
gateInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitGate();
});
whoamiEl.addEventListener("click", () => {
  gateInput.value = username;
  showGate();
});

// ============================= audio context =============================

async function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }
  return audioCtx;
}

function playPcm(float32Samples, sampleRate) {
  return ensureAudioContext().then((ctx) => {
    return new Promise((resolve) => {
      const buffer = ctx.createBuffer(1, float32Samples.length, sampleRate);
      buffer.copyToChannel(float32Samples, 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.onended = resolve;
      src.start();
    });
  });
}

// ============================= send =============================

function addHistoryEntry(entry) {
  history.push(entry);
  saveHistory(history);
  renderHistory();
}

function updateHistoryEntry(id, dir, patch) {
  const entry = history.find((h) => h.id === id && h.dir === dir);
  if (!entry) return false;
  Object.assign(entry, patch);
  saveHistory(history);
  renderHistory();
  return true;
}

async function sendMessage() {
  const raw = textInput.value;
  if (raw.trim().length === 0) return;

  const id = randomMsgId();
  const textChunks = chunkText(raw, CHUNK_TEXT_CHARS);
  const taggedChunks = textChunks.map((c) => tagChunk(id, username, c));

  let pcm;
  try {
    pcm = encode_frames_to_pcm(taggedChunks, selectedMode, undefined, undefined, undefined);
  } catch (e) {
    setCarriageStatus(`▢ ENCODE FAILED: ${e} ▢`);
    return;
  }

  textInput.value = "";
  addHistoryEntry({
    id,
    dir: "tx",
    username,
    text: raw,
    chunks: taggedChunks,
    mode: selectedMode,
    time: Date.now(),
    status: "sent",
  });

  sendKey.disabled = true;
  setCarriageStatus("● TRANSMITTING…");
  try {
    await playPcm(pcm, SR);
    ringBell();
  } finally {
    sendKey.disabled = false;
    setCarriageStatus(listening ? "● LISTENING…" : "▢ TYPE YOUR MESSAGE ▢");
  }
}

async function resendOwnMessage(id) {
  const entry = history.find((h) => h.id === id && h.dir === "tx");
  if (!entry) return;
  sendKey.disabled = true;
  setCarriageStatus("● RESENDING…");
  try {
    const pcm = encode_frames_to_pcm(entry.chunks, entry.mode, undefined, undefined, undefined);
    await playPcm(pcm, SR);
    ringBell();
  } catch (e) {
    setCarriageStatus(`▢ RESEND FAILED: ${e} ▢`);
  } finally {
    sendKey.disabled = false;
    setCarriageStatus(listening ? "● LISTENING…" : "▢ TYPE YOUR MESSAGE ▢");
  }
}

async function requestResend(id) {
  try {
    const pcm = build_nack_pcm(selectedMode, undefined, undefined, hexToBytes(id));
    await playPcm(pcm, SR);
  } catch (e) {
    setCarriageStatus(`▢ RESEND REQUEST FAILED: ${e} ▢`);
  }
}

sendKey.addEventListener("click", sendMessage);
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

modeKeys.forEach((key) => {
  key.addEventListener("click", () => {
    selectedMode = key.dataset.mode;
    modeKeys.forEach((k) => k.classList.toggle("active", k === key));
  });
});

// ============================= receive: live mic =============================

function materializeCaptureBuffer() {
  let total = 0;
  for (const c of captureChunks) total += c.length;
  const merged = new Float32Array(total);
  let off = 0;
  for (const c of captureChunks) {
    merged.set(c, off);
    off += c.length;
  }
  return merged;
}

function handleDecodedFrame(frame, mode) {
  if (!frame.ok) return;
  const tag = untagChunk(frame.text);
  if (!tag) return; // not one of ours (or a corrupted envelope) -- ignore, don't guess

  const result = liveReassembler.add(tag.id, tag.username, frame.seq, tag.text, frame.more_frames);
  if (result.ok) {
    const updated = updateHistoryEntry(tag.id, "rx", {
      status: "received",
      text: result.text,
      username: result.username,
      framesReceived: result.framesReceived,
      framesExpected: result.framesExpected,
    });
    if (!updated) {
      addHistoryEntry({
        id: tag.id,
        dir: "rx",
        username: result.username,
        text: result.text,
        mode,
        time: Date.now(),
        status: "received",
        framesReceived: result.framesReceived,
        framesExpected: result.framesExpected,
      });
    }
    ringBell();
  } else {
    const patch = {
      status: "incomplete",
      text: "— — receiving, part of message pending — —",
      username: result.username,
      framesReceived: result.framesReceived,
      framesExpected: result.framesExpected,
    };
    const updated = updateHistoryEntry(tag.id, "rx", patch);
    if (!updated) {
      addHistoryEntry({ id: tag.id, dir: "rx", mode, time: Date.now(), ...patch });
    }
  }
}

function resetCaptureBuffer() {
  captureChunks = [];
  scanPos = { phone: 0, fast_air: 0 };
}

async function handleNackFound(info) {
  const targetId = Array.from(info.target_id).map((b) => b.toString(16).padStart(2, "0")).join("");
  const entry = history.find((h) => h.id === targetId && h.dir === "tx");
  if (entry) await resendOwnMessage(targetId);
}

async function pollCapture() {
  if (captureChunks.length === 0) return;
  const buffer = materializeCaptureBuffer();

  if (buffer.length > MAX_BUFFER_SECONDS * captureSampleRate) {
    resetCaptureBuffer();
    return;
  }

  for (const mode of LISTEN_MODES) {
    let pos = scanPos[mode];
    while (true) {
      let frame;
      try {
        frame = scan_next_frame(buffer, captureSampleRate, mode, pos);
      } catch {
        break;
      }
      if (!frame) break;
      handleDecodedFrame(frame, mode);
      pos = frame.next_start;
    }
    scanPos[mode] = pos;

    // scan_for_nack has no position to resume from -- it re-scans the whole
    // buffer every poll, so a NACK sitting in it would otherwise be found
    // (and acted on) again on every subsequent poll until the buffer moves
    // past it. Wipe the buffer immediately after handling one, rather than
    // tracking yet another per-mode cursor just for this.
    let nack;
    try {
      nack = scan_for_nack(buffer, captureSampleRate, mode);
    } catch {
      nack = null;
    }
    if (nack) {
      await handleNackFound(nack);
      resetCaptureBuffer();
      return;
    }
  }
}

async function startListening() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    setCarriageStatus(`▢ MICROPHONE ACCESS DENIED ▢`);
    return;
  }

  const ctx = await ensureAudioContext();
  await ctx.audioWorklet.addModule("./capture-worklet.js");
  captureSampleRate = ctx.sampleRate;
  captureChunks = [];
  scanPos = { phone: 0, fast_air: 0 };
  liveReassembler = new Reassembler();

  const source = ctx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(ctx, "capture-processor");
  workletNode.port.onmessage = (e) => {
    captureChunks.push(e.data);
  };
  source.connect(workletNode);

  listening = true;
  listenKey.classList.add("listening");
  listenKey.textContent = "LISTENING";
  setCarriageStatus("● LISTENING…");
  pollTimer = setInterval(pollCapture, POLL_INTERVAL_MS);
}

function stopListening() {
  listening = false;
  listenKey.classList.remove("listening");
  listenKey.textContent = "LISTEN";
  setCarriageStatus("▢ TYPE YOUR MESSAGE ▢");
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (workletNode) workletNode.port.onmessage = null;
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
  workletNode = null;
  mediaStream = null;
  captureChunks = [];
}

listenKey.addEventListener("click", () => {
  if (listening) stopListening();
  else startListening();
});

// ============================= receive: file upload =============================

fileInput.addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  fileInput.value = "";

  const ctx = await ensureAudioContext();
  let audioBuffer;
  try {
    const arrayBuf = await file.arrayBuffer();
    audioBuffer = await ctx.decodeAudioData(arrayBuf);
  } catch (e) {
    setCarriageStatus(`▢ COULD NOT READ THAT FILE ▢`);
    return;
  }
  const samples = audioBuffer.getChannelData(0);
  const fileReassembler = new Reassembler();

  for (const mode of LISTEN_MODES) {
    let pos = 0;
    while (true) {
      let frame;
      try {
        frame = scan_next_frame(samples, audioBuffer.sampleRate, mode, pos);
      } catch {
        break;
      }
      if (!frame) break;
      if (frame.ok) {
        const tag = untagChunk(frame.text);
        if (tag) {
          const result = fileReassembler.add(tag.id, tag.username, frame.seq, tag.text, frame.more_frames);
          if (result.ok) {
            const updated = updateHistoryEntry(tag.id, "rx", {
              status: "received",
              text: result.text,
              username: result.username,
              framesReceived: result.framesReceived,
              framesExpected: result.framesExpected,
            });
            if (!updated) {
              addHistoryEntry({
                id: tag.id,
                dir: "rx",
                username: result.username,
                text: result.text,
                mode,
                time: Date.now(),
                status: "received",
                framesReceived: result.framesReceived,
                framesExpected: result.framesExpected,
              });
            }
            ringBell();
          }
        }
      }
      pos = frame.next_start;
    }
  }
});

// ============================= init =============================

async function main() {
  try {
    await init();
    if (!username) {
      showGate();
    } else {
      showApp();
    }
  } catch (e) {
    showFatalError("FAILED TO LOAD (WASM MODULE)", e);
  }
}

main();
