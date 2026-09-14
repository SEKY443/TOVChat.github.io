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

// Mirrors CLI-TextOverVoice's chat.rs all_candidates(): every (mode,
// parity_bytes) combination its adaptive ladder can reach, most robust
// first. calibrate-send transmits a known probe under each one in turn;
// calibrate-listen tries decoding under all of them and reports which
// setting(s) actually survived the real channel.
const CALIBRATE_CANDIDATES = [
  { mode: "phone", parity: 40 },
  { mode: "phone", parity: 20 },
  { mode: "phone", parity: 10 },
  { mode: "fast_air", parity: 40 },
  { mode: "fast_air", parity: 20 },
  { mode: "fast_air", parity: 10 },
];
const CALIBRATE_PROBE_GAP_MS = 500; // matches calibrate.rs's inter-probe gap

// Exact strings protocol::parse_frame's ParseResult::fail/fail_with use
// (see textovervoice-core's protocol.rs) for a frame that genuinely made
// it far enough to be a real (if corrupted) data-frame attempt -- as
// opposed to a preamble false-triggering on plain noise, which fails much
// earlier with a structural reason not in this map. Shown live so the
// FEC/CRC/decrypt verification is actually visible, not just the final
// text -- mapped to a short display label for the readout.
const MEANINGFUL_FAILURES = new Map([
  ["FEC uncorrectable", "FEC: UNCORRECTABLE"],
  ["CRC mismatch after FEC", "CRC: MISMATCH"],
  ["protected header FEC uncorrectable", "HEADER FEC: UNCORRECTABLE"],
  ["frame is encrypted but no session key was provided", "ENCRYPTED — NO KEY TO DECRYPT"],
]);
const TYPEWRITER_CHAR_MS = 18;
const LIVE_DECODE_FLASH_MS = 2500;
const LIVE_DECODE_COMPLETE_HOLD_MS = 2000;
const MIC_METER_UPDATE_MS = 80; // how often the level bar redraws, not how often it samples
const MIC_METER_FULL_SCALE = 0.3; // amplitude that reads as a full bar -- real speech/tones rarely approach 1.0
const NORMALIZE_TARGET_PEAK = 0.9; // gain-boost a captured buffer to this peak before scanning it, if quieter

// Exact reason strings protocol.rs reports when a frame ran out of REAL
// captured audio partway through reading it -- not corruption, just "the
// rest of this transmission hasn't arrived in the buffer yet" (confirmed
// directly: scanning a deliberately-truncated encode of a real message
// reproduces these exact strings, never seen on complete data). Live
// polling scans a buffer that's still GROWING while a transmission is in
// flight, unlike a fully-captured file, so this is routine, not rare.
//
// Deliberately NOT included: "protected header FEC uncorrectable" and the
// Legacy PARITY_START/END "marker not found" reasons. Those are ambiguous
// -- they can also mean genuine correction failure on already-complete
// data -- and, worse, live-testing showed ambient noise occasionally
// triggers a false preamble match that fails with exactly one of these.
// Treating those as "retry, don't advance" froze the scan position on the
// noise hit for the full retry window, causing a REAL transmission
// arriving during that window to be missed entirely (confirmed: "works
// once, then unreliable" was this). The reasons below can only be reached
// AFTER the header has already been successfully RS-corrected -- meaning
// a real, synced transmission is definitely in progress, not noise -- so
// they're safe to always wait out.
const TRUNCATION_REASONS = new Set([
  "unexpected end of frame", // Legacy header read hit EOF -- unambiguous, no FEC step to conflate with
  "payload extends past end of received data", // ProtectedHeader, header already validated
  "unexpected end of frame reading parity",
  "unexpected end of frame reading CRC",
]);
// Generous: since these reasons are now provably tied to a real, already-
// synced transmission, the bound only needs to comfortably cover the
// longest realistic message in the slowest mode, not guard against noise.
const TRUNCATION_RETRY_TIMEOUT_MS = 120000;

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

const calibratePanel = document.getElementById("calibrate-panel");
const calibrateOpenBtn = document.getElementById("calibrate-open");
const calibrateCloseBtn = document.getElementById("calibrate-close");
const calibrateCodeInput = document.getElementById("calibrate-code");
const calibrateStatusEl = document.getElementById("calibrate-status");
const calibrateSendBtn = document.getElementById("calibrate-send");
const calibrateListenBtn = document.getElementById("calibrate-listen");
const calibrateResultsEl = document.getElementById("calibrate-results");

const liveDecodeEl = document.getElementById("live-decode");
const liveDecodeStatusEl = document.getElementById("live-decode-status");
const liveDecodeTextEl = document.getElementById("live-decode-text");
const micLevelFillEl = document.getElementById("mic-level-fill");
const micLevelDbEl = document.getElementById("mic-level-db");

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
let scanStuckSince = { phone: null, fast_air: null }; // Date.now() a truncation-looking retry started, per mode
let liveReassembler = new Reassembler();
let pollTimer = null;

let calibrating = false;
let calibrateScanPos = new Map(); // "mode:parity" -> sample offset
let calibrateMatches = new Set(); // "mode:parity" already reported

let liveDecodeId = null; // message id currently shown in the live decode box
let liveDecodeUsername = "";
let liveDecodeRevealed = ""; // text already typewriter-revealed for liveDecodeId
let liveDecodeRevealToken = 0; // bumped to cancel an in-flight reveal when superseded
let liveDecodeStatusRestoreTimer = null;

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

/// Scales the whole buffer up so its peak reaches NORMALIZE_TARGET_PEAK,
/// if it isn't already at least that loud. This is deliberately the same
/// kind of post-hoc, whole-buffer-aware gain a recording app effectively
/// applies when it normalizes a finished file -- found live-testing that
/// it's what actually closes the gap between "a recorded file of a real
/// transmission decodes fine via DECODE FROM FILE" and "the identical
/// live signal doesn't decode": the browser's own real-time
/// autoGainControl is voice-tuned with a slow, causal ramp-up that a
/// short tone burst can come and go faster than, where this can just look
/// at the whole already-captured buffer and scale it correctly in one
/// step, no ramp-up needed. Uniform amplitude scaling only, same
/// reasoning as autoGainControl being safe to enable: it doesn't touch
/// frequency content the way noise suppression would.
function normalizePeak(buffer) {
  let peak = 0;
  for (let i = 0; i < buffer.length; i++) {
    const a = Math.abs(buffer[i]);
    if (a > peak) peak = a;
  }
  if (peak === 0 || peak >= NORMALIZE_TARGET_PEAK) return buffer;
  const gain = NORMALIZE_TARGET_PEAK / peak;
  const normalized = new Float32Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) normalized[i] = buffer[i] * gain;
  return normalized;
}

// ============================= live decode readout =============================
//
// Drives the box shown above the input while LISTEN is active: a
// typewriter-style reveal of each incoming frame's text as it decodes,
// plus the FEC/CRC/decrypt outcome for every frame attempt -- success or
// failure -- not just the final assembled message.

function steadyLiveDecodeStatus() {
  return liveDecodeId
    ? `● RECEIVING · ${liveDecodeUsername} · #${liveDecodeId}  [FEC ✓] [CRC ✓]`
    : "▪ AWAITING SIGNAL ▪";
}

function setLiveDecodeStatus(text) {
  liveDecodeStatusEl.textContent = text;
}

// A single shared timer for "the next thing that overwrites this status
// line" -- a failure flash and a just-completed message's hold both need
// one of these, and if they used independent timers, whichever was
// scheduled first could fire in the middle of the other and stomp it
// early (confirmed while testing: a completion's reset firing partway
// through a later failure flash cut the flash short). One timer means
// whichever transient status was shown LAST always owns however long it
// was supposed to display for.
function setTransientLiveDecodeStatus(text, holdMs, onExpire) {
  setLiveDecodeStatus(text);
  clearTimeout(liveDecodeStatusRestoreTimer);
  liveDecodeStatusRestoreTimer = setTimeout(onExpire, holdMs);
}

function flashLiveDecodeStatus(text) {
  setTransientLiveDecodeStatus(text, LIVE_DECODE_FLASH_MS, () => setLiveDecodeStatus(steadyLiveDecodeStatus()));
}

function resetLiveDecode() {
  liveDecodeId = null;
  liveDecodeUsername = "";
  liveDecodeRevealed = "";
  liveDecodeRevealToken++;
  liveDecodeTextEl.textContent = "";
  clearTimeout(liveDecodeStatusRestoreTimer);
  setLiveDecodeStatus("▪ AWAITING SIGNAL ▪");
}

function showLiveDecode() {
  liveDecodeEl.hidden = false;
  resetLiveDecode();
}

function hideLiveDecode() {
  liveDecodeEl.hidden = true;
  clearTimeout(liveDecodeStatusRestoreTimer);
}

async function typewriterReveal(fullText, startAt) {
  const token = ++liveDecodeRevealToken;
  for (let i = startAt; i <= fullText.length; i++) {
    if (token !== liveDecodeRevealToken) return; // superseded by a newer reveal
    liveDecodeTextEl.textContent = fullText.slice(0, i);
    await sleep(TYPEWRITER_CHAR_MS);
  }
}

function onLiveFrame(frame) {
  if (liveDecodeEl.hidden) return;
  if (frame.ok) {
    const tag = untagChunk(frame.text);
    if (!tag) return;
    if (tag.id !== liveDecodeId) {
      liveDecodeId = tag.id;
      liveDecodeUsername = tag.username;
      liveDecodeRevealed = "";
      liveDecodeTextEl.textContent = "";
    }
    clearTimeout(liveDecodeStatusRestoreTimer);
    setLiveDecodeStatus(steadyLiveDecodeStatus());
    const startAt = liveDecodeRevealed.length;
    liveDecodeRevealed += tag.text;
    typewriterReveal(liveDecodeRevealed, startAt);
  } else if (MEANINGFUL_FAILURES.has(frame.reason)) {
    flashLiveDecodeStatus(`✕ ${MEANINGFUL_FAILURES.get(frame.reason)}`);
  }
}

function onLiveMessageComplete() {
  setTransientLiveDecodeStatus("✓ MESSAGE COMPLETE", LIVE_DECODE_COMPLETE_HOLD_MS, resetLiveDecode);
}

function handleDecodedFrame(frame, mode) {
  onLiveFrame(frame);
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
    onLiveMessageComplete();
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
  scanStuckSince = { phone: null, fast_air: null };
}

async function handleNackFound(info) {
  const targetId = Array.from(info.target_id).map((b) => b.toString(16).padStart(2, "0")).join("");
  const entry = history.find((h) => h.id === targetId && h.dir === "tx");
  if (entry) await resendOwnMessage(targetId);
}

async function pollCapture(buffer) {
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

      if (!frame.ok && TRUNCATION_REASONS.has(frame.reason)) {
        if (scanStuckSince[mode] === null) scanStuckSince[mode] = Date.now();
        if (Date.now() - scanStuckSince[mode] < TRUNCATION_RETRY_TIMEOUT_MS) {
          // Leave pos where it was -- don't report this as a failure, and
          // retry this exact position next poll once more of the
          // transmission has arrived, rather than skipping past it.
          break;
        }
        // Waited long enough that this is more likely genuine corruption
        // than a message still arriving -- give up waiting and report it.
        scanStuckSince[mode] = null;
      } else {
        scanStuckSince[mode] = null;
      }

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

/// Starts mic capture (getUserMedia + AudioWorkletNode) and a poll
/// interval calling `onPoll` with the freshly materialized buffer every
/// `POLL_INTERVAL_MS`. Shared by normal listening and calibrate-listening
/// -- they differ only in what they DO with the captured audio, not in how
/// it's captured. Throws (with the mic-access-denied message already set)
/// if permission is refused; callers should not flip their own "active"
/// UI state until this resolves.
// A real, honest "is my mic hearing anything at all" readout -- added
// after live-testing where the send/receive pipeline was correct but a
// weak real-world acoustic path made it hard to tell whether the mic was
// picking up nothing, or picking up something too quiet/unclean to
// demodulate. Peak amplitude of every captured chunk, redrawn at most
// every MIC_METER_UPDATE_MS (chunks arrive far more often than that would
// be useful to redraw the DOM).
function resetMicLevel() {
  micLevelFillEl.style.width = "0%";
  micLevelDbEl.textContent = "−∞ dB";
}

function updateMicLevelDisplay(peak) {
  const pct = Math.min(100, (peak / MIC_METER_FULL_SCALE) * 100);
  micLevelFillEl.style.width = `${pct}%`;
  micLevelDbEl.textContent = peak > 0 ? `${(20 * Math.log10(peak)).toFixed(0)} dB` : "−∞ dB";
}

async function startCapture(onPoll) {
  // echoCancellation/noiseSuppression stay off -- both are voice-optimized
  // and can treat a steady tone as "noise" to suppress, which would
  // directly corrupt the modem's frequencies. autoGainControl is just
  // uniform amplitude scaling, not frequency-selective, so it's safe and
  // was re-enabled after live testing found it was the actual gap: a
  // recorded file (which passed through a recording app's own automatic
  // leveling) decoded fine via DECODE FROM FILE, while the live capture
  // (deliberately AGC-off) of the identical real-world weak signal did
  // not -- confirming the raw signal was clean enough, just too quiet
  // without any gain applied.
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
  });

  const ctx = await ensureAudioContext();
  await ctx.audioWorklet.addModule("./capture-worklet.js");
  captureSampleRate = ctx.sampleRate;
  captureChunks = [];
  resetMicLevel();

  let meterPeak = 0;
  let lastMeterUpdate = 0;
  const source = ctx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(ctx, "capture-processor");
  workletNode.port.onmessage = (e) => {
    captureChunks.push(e.data);
    for (const v of e.data) {
      const a = Math.abs(v);
      if (a > meterPeak) meterPeak = a;
    }
    const now = performance.now();
    if (now - lastMeterUpdate >= MIC_METER_UPDATE_MS) {
      lastMeterUpdate = now;
      updateMicLevelDisplay(meterPeak);
      meterPeak = 0;
    }
  };
  source.connect(workletNode);

  pollTimer = setInterval(() => {
    if (captureChunks.length === 0) return;
    const buffer = materializeCaptureBuffer();
    if (buffer.length > MAX_BUFFER_SECONDS * captureSampleRate) {
      captureChunks = [];
      return;
    }
    onPoll(normalizePeak(buffer));
  }, POLL_INTERVAL_MS);
}

function stopCapture() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (workletNode) workletNode.port.onmessage = null;
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
  workletNode = null;
  mediaStream = null;
  captureChunks = [];
  resetMicLevel();
}

async function startListening() {
  scanPos = { phone: 0, fast_air: 0 };
  scanStuckSince = { phone: null, fast_air: null };
  liveReassembler = new Reassembler();
  try {
    await startCapture(pollCapture);
  } catch (e) {
    setCarriageStatus(`▢ MICROPHONE ACCESS DENIED ▢`);
    return;
  }
  listening = true;
  listenKey.classList.add("listening");
  listenKey.textContent = "LISTENING";
  setCarriageStatus("● LISTENING…");
  showLiveDecode();
}

function stopListening() {
  listening = false;
  listenKey.classList.remove("listening");
  listenKey.textContent = "LISTEN";
  setCarriageStatus("▢ TYPE YOUR MESSAGE ▢");
  stopCapture();
  hideLiveDecode();
}

listenKey.addEventListener("click", () => {
  if (calibrating) return; // one mic session at a time -- see the calibrate panel
  if (listening) stopListening();
  else startListening();
});

// ============================= calibrate =============================
//
// Mirrors CLI-TextOverVoice's calibrate-send/calibrate-listen: find which
// (mode, parity_bytes) setting(s) actually survive this specific real
// channel, instead of guessing one and hoping. calibrate-send transmits a
// known code under every CALIBRATE_CANDIDATES entry in turn;
// calibrate-listen tries decoding incoming audio under all of them and
// reports which produced an exact match.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setCalibrateStatus(text) {
  calibrateStatusEl.textContent = text;
}

function candidateKey(mode, parity) {
  return `${mode}:${parity}`;
}

function renderCalibrateResults() {
  calibrateResultsEl.innerHTML = "";
  for (const { mode, parity } of CALIBRATE_CANDIDATES) {
    const key = candidateKey(mode, parity);
    const row = document.createElement("div");
    row.className = "calibrate-result-row" + (calibrateMatches.has(key) ? " match" : "");
    const label = document.createElement("span");
    label.textContent = `${mode.toUpperCase()} / PARITY ${parity}`;
    const verdict = document.createElement("span");
    verdict.className = "r-verdict";
    verdict.textContent = calibrateMatches.has(key) ? "MATCH" : "—";
    row.append(label, verdict);
    calibrateResultsEl.appendChild(row);
  }
}

function openCalibrate() {
  if (listening) stopListening(); // one mic session at a time
  calibrateMatches = new Set();
  renderCalibrateResults();
  setCalibrateStatus("▢ IDLE ▢");
  calibratePanel.hidden = false;
}

function closeCalibrate() {
  if (calibrating) stopCalibrateListening();
  calibratePanel.hidden = true;
}

async function sendCalibrateProbes() {
  const code = calibrateCodeInput.value.trim();
  if (!code) {
    setCalibrateStatus("▢ ENTER A CALIBRATION CODE ▢");
    return;
  }
  calibrateSendBtn.disabled = true;
  calibrateListenBtn.disabled = true;
  try {
    for (let i = 0; i < CALIBRATE_CANDIDATES.length; i++) {
      const { mode, parity } = CALIBRATE_CANDIDATES[i];
      setCalibrateStatus(
        `● [${i + 1}/${CALIBRATE_CANDIDATES.length}] SENDING ${mode.toUpperCase()} / PARITY ${parity}…`
      );
      const pcm = encode_frames_to_pcm([code], mode, undefined, undefined, undefined, parity);
      await playPcm(pcm, SR);
      if (i + 1 < CALIBRATE_CANDIDATES.length) await sleep(CALIBRATE_PROBE_GAP_MS);
    }
    setCalibrateStatus(`▢ SENT ALL ${CALIBRATE_CANDIDATES.length} PROBES ▢`);
  } finally {
    calibrateSendBtn.disabled = false;
    calibrateListenBtn.disabled = false;
  }
}

function pollCalibrateCapture(buffer) {
  const code = calibrateCodeInput.value.trim();
  for (const { mode, parity } of CALIBRATE_CANDIDATES) {
    const key = candidateKey(mode, parity);
    if (calibrateMatches.has(key)) continue; // already confirmed, no need to keep scanning for it
    let pos = calibrateScanPos.get(key) || 0;
    while (true) {
      let frame;
      try {
        frame = scan_next_frame(buffer, captureSampleRate, mode, pos, parity);
      } catch {
        break;
      }
      if (!frame) break;
      if (frame.ok && frame.text === code) {
        calibrateMatches.add(key);
        renderCalibrateResults();
        setCalibrateStatus(`● MATCH: ${mode.toUpperCase()} / PARITY ${parity} ●`);
      }
      pos = frame.next_start;
    }
    calibrateScanPos.set(key, pos);
  }
}

async function startCalibrateListening() {
  calibrateScanPos = new Map();
  try {
    await startCapture(pollCalibrateCapture);
  } catch (e) {
    setCalibrateStatus("▢ MICROPHONE ACCESS DENIED ▢");
    return;
  }
  calibrating = true;
  calibrateListenBtn.classList.add("active");
  calibrateListenBtn.textContent = "LISTENING…";
  calibrateSendBtn.disabled = true;
  setCalibrateStatus("● LISTENING FOR PROBES… ●");
}

function stopCalibrateListening() {
  calibrating = false;
  calibrateListenBtn.classList.remove("active");
  calibrateListenBtn.textContent = "LISTEN FOR PROBES";
  calibrateSendBtn.disabled = false;
  setCalibrateStatus("▢ IDLE ▢");
  stopCapture();
}

calibrateOpenBtn.addEventListener("click", openCalibrate);
calibrateCloseBtn.addEventListener("click", closeCalibrate);
calibrateSendBtn.addEventListener("click", sendCalibrateProbes);
calibrateListenBtn.addEventListener("click", () => {
  if (calibrating) stopCalibrateListening();
  else startCalibrateListening();
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
