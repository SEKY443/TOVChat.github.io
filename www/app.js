import init, {
  encode_frames_to_pcm,
  scan_next_frame,
  preview_frame,
  build_nack_pcm,
  scan_for_nack,
} from "./pkg/tovchat_wasm.js";

const SR = 8000; // modem::SR -- outgoing PCM is always synthesized at this rate

// ============================= debug log =============================
//
// A structured, always-on trail of the internal lifecycle events that
// actually matter for figuring out what happened during a real acoustic
// session -- frame scan attempts, ack/nack/retry state changes, carrier
// sense, reveal timing -- readable straight from the browser's own
// console (F12 -> Console, or filter for "[TOV") instead of needing to
// watch the screen and catch a fast-moving state in a screenshot. Quiet
// by design: skips the "polled, found nothing" case that fires every
// ~1.2s while idle, so a filtered console stays readable during a long
// listening session instead of scrolling past mostly noise.
function dbg(tag, ...args) {
  console.log(`[TOV:${tag}]`, ...args);
}

// Still persisted -- a device preference, not session content, unlike
// username/history (see the "storage" section below).
const STORAGE_MAX_RETRIES = "tovchat_max_retries";
const MAX_USERNAME_CHARS = 16;
const CHUNK_TEXT_CHARS = 700; // real-text budget per frame, leaving headroom for the envelope
const MAX_HISTORY_ENTRIES = 300; // in-memory cap for a long session, not a storage limit anymore
const DEFAULT_MAX_RETRIES = 3;
// Grace period after a message finishes playing before treating a missing
// ack as "resend": long enough for the other side to finish decoding, build
// an ack frame (short, but not instant), and for that ack's own preamble +
// header to arrive back -- not scaled to message length since that's
// already accounted for by scheduling this timer only after playback ends.
// Found live too tight at 6s: the full round trip (poll latency on their
// end + decode + carrier-sense wait if the channel was busy + the ack's
// own travel time + poll latency on this end) can genuinely run past 6s
// even when delivery is completely fine, triggering an unneeded resend --
// which the *receiver* then decodes a second time, ringing the bell twice
// for what the user rightly hears as one message (see handleDecodedFrame's
// alreadyReceived check, the other half of that fix).
//
// Raised again, from 10s to 14s, after adding mandatory contention jitter
// to every ack transmission (see CARRIER_SENSE_MAX_WAIT_MS/
// CARRIER_SENSE_JITTER_*_MS below): with three devices live, two receivers
// decoding the same broadcast at the same instant now each deliberately
// wait out carrier-sense contention -- up to CARRIER_SENSE_MAX_WAIT_MS in
// the worst case -- before their acks actually go out. That's exactly the
// same "outrun the grace period" failure mode as before, just with the
// collision-avoidance wait itself as the new dominant cost instead of
// decode/poll latency -- the fix is the same, give the round trip enough
// room to actually finish.
const RETRY_ACK_GRACE_MS = 14000;

const MSG_START = "\x02";
const USERNAME_SEP = "\x1F";
const MSG_SEP = "\x03";
// Delivery-confirmation marker -- the real ASCII ACK control character
// (0x06), not a spelled-out word, so an ack payload is as short as
// possible: this one byte plus the id being confirmed, nothing else. Sent
// through the exact same tagged-frame pipeline as an ordinary message, no
// separate wire frame type -- see textovervoice-core's removal of the
// previous custom AckFrame struct, after checking the actual
// CLI-TextOverVoice reference implementation (chat.rs) showed its real ack
// is exactly this shape: a short id-tagged text reply, not a dedicated
// binary frame.
const ACK_MARKER = "\x06";

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
const TYPEWRITER_CHAR_MS = 14;
// Per-character "decode" flicker -- raw guessed bits settling into the
// real 8-bit code, then resolving into the actual letter -- shown only in
// the live-decode preview box (see revealTo), never in a chat bubble (see
// renderEntry). Skipped for whitespace (nothing interesting to flicker
// through, and skipping keeps word-boundary pacing snappy).
const FLICKER_SKIP_THRESHOLD_MS = 16; // below this, no time to show anything but the resolved char
const FLICKER_BITS_ONLY_THRESHOLD_MS = 40; // below this, skip the scrambled-guess phase, go straight to real bits
const LIVE_DECODE_FLASH_MS = 2500;
const LIVE_DECODE_COMPLETE_HOLD_MS = 2000;
// Per-character flicker duration for newly-arrived (or newly-corrected)
// live-preview text. Fixed and short -- unlike an earlier version of this
// box that derived pacing from a whole frame's total over-the-air
// duration, real-time-ness here comes from WHEN a batch of characters
// shows up (an actual poll, seeing actual new demodulated bytes via
// preview_frame -- see updateLivePreview), not from how slowly this
// flicker plays each one back once it has arrived.
const LIVE_PREVIEW_CHAR_MS = 40;
const MIC_METER_UPDATE_MS = 80; // how often the level bar redraws, not how often it samples
const MIC_METER_FULL_SCALE = 0.3; // amplitude that reads as a full bar -- real speech/tones rarely approach 1.0
const NORMALIZE_TARGET_PEAK = 0.9; // gain-boost a captured buffer to this peak before scanning it, if quieter

// Collision avoidance, CSMA/CA-style (found live: two devices replying to
// each other in quick succession is exactly the scenario where both can
// end up transmitting at once -- playPcm's queue (see below) only
// serializes THIS device's own sends against each other, not against a
// different device's speaker on the same acoustic channel). Before each
// clip starts, if this device is listening, wait for the mic to read
// quiet; if it's currently busy, back off a random interval and re-check,
// the same shape as real CSMA/CA collision avoidance. A device that isn't
// listening has no way to sense the channel and transmits blind, same as
// before this existed.
//
// "Busy" itself is decided by an adaptive squelch, not a fixed threshold
// -- ported directly from CLI-TextOverVoice's live.rs Squelch (checked the
// actual reference implementation rather than guessing at one): a
// fast-moving recent-energy estimate (RMS per captured chunk, matching the
// CLI's own `rms()`) against a slow-moving ambient-noise floor, "busy"
// once the fast estimate is well above that floor. A single fixed
// number can't be right everywhere -- a loud room's ordinary ambient
// noise can sit above a quiet room's real signal -- so this tracks each
// device's own actual environment instead. The floor only updates while
// the channel currently reads quiet (fast estimate below the busy
// threshold); otherwise a loud, sustained tone burst would drag its own
// floor up and eventually stop looking "busy" at all, same rationale the
// CLI's own doc comment gives.
const SQUELCH_FAST_ALPHA = 0.3;
const SQUELCH_FLOOR_ALPHA = 0.01;
// Found live: a second message's send still collided with an incoming ack
// -- the CLI's own 4.0x ratio (ported faithfully) wasn't sensitive enough
// to reliably catch a real but relatively QUIET signal (an ack's own
// transmission volume, picked up from across a room, isn't necessarily as
// energetic as a full nearby data frame) against the now-correctly-
// calibrated ambient floor. Lowered to 2.0x -- verified by simulation this
// stays at essentially zero false positives (0-1/300 samples, even under
// deliberately extreme synthetic ambient jitter standing in for real-world
// AGC pumping) while correctly catching a signal only ~2.2x louder than
// ambient that 4.0x missed entirely.
const SQUELCH_BUSY_MULTIPLIER = 2.0;
const SQUELCH_MIN_FLOOR = 0.0005; // absolute floor so a near-silent source doesn't call every nonzero signal "busy"
// How many initial readings get folded into the floor unconditionally
// (bypassing the normal busy-gate) before switching to steady-state
// behavior -- see squelchUpdate. One sample is too noisy to trust as an
// entire ambient calibration (a single ~10-20ms chunk can easily be
// anomalously quiet or loud by pure chance); averaging a real stretch of
// them gives a floor that actually represents the room.
const SQUELCH_BOOTSTRAP_SAMPLES = 20;
let squelchFast = 0;
let squelchFloor = 0;
let squelchBootstrapCount = 0; // see squelchUpdate's bootstrap phase

/// Found live: this ported the CLI's Squelch::update faithfully, but the
/// port (and, on inspection, the reference it was ported from) has a real
/// bootstrap bug. Both fast and floor start at 0, and the floor only ever
/// updates while the CURRENT reading is judged "not busy" against the
/// CURRENT floor -- so if the very first real ambient reading is already
/// louder than the tiny MIN_FLOOR bootstrap value times the busy
/// multiplier (threshold ~0.002 linear amplitude, about -54dBFS -- quieter
/// than almost any real room's actual ambient noise), that first reading
/// gets judged "busy" against a floor that hasn't been given a chance to
/// calibrate yet, so the floor never updates, so fast (chasing the real,
/// perfectly ordinary ambient level) stays "busy" forever: the channel
/// reads permanently busy from the moment LISTEN turns on, `waitForClearChannel`
/// always times out and transmits blind after CARRIER_SENSE_MAX_WAIT_MS
/// regardless of what's actually on the channel -- collision avoidance in
/// name only. Reproduced directly: feeding a steady, realistic ambient
/// RMS of 0.01 (-40dBFS, an ordinary quiet room) through the unmodified
/// port leaves the floor at exactly 0 and `is_busy()` permanently true
/// after 300 updates.
///
/// First fix seeded the floor from just the very first reading. Still not
/// robust enough, found live again: a single ~10-20ms chunk is a noisy
/// sample of a real room -- if it happens to land during an anomalously
/// quiet instant, the floor seeds too low, and then perfectly ordinary
/// ambient fluctuation routinely reads 4x above it, right back to
/// "busy" most of the time, just less absolutely permanent than the
/// original zero-forever deadlock.
///
/// Second attempt folded the first SQUELCH_BOOTSTRAP_SAMPLES readings into
/// the floor unconditionally via the SAME slow EMA (SQUELCH_FLOOR_ALPHA =
/// 0.01) steady-state uses -- still wrong, caught by simulation before
/// this ever reached a real device: that alpha is deliberately slow so a
/// real transmission can't drag the floor up mid-message, which means it
/// ALSO barely moves within only 20 samples -- floor ends up nowhere near
/// the true ambient level, right back to "busy" almost all the time, just
/// with a nonzero floor instead of zero.
///
/// Now the bootstrap phase uses a true running mean (converges to the
/// exact average of the first SQUELCH_BOOTSTRAP_SAMPLES readings, not an
/// exponentially slow crawl toward it) -- fast, honest calibration for the
/// one-time "what does this room actually sound like" question -- and
/// only switches to the slow gated EMA once that's established, for
/// exactly the reason the slow alpha exists in steady state. Verified
/// with simulation: correct (not busy) for steady ambient, noisy/bursty
/// ambient (random 0.005-0.02 RMS), and an anomalous first sample: a real
/// burst is still correctly detected, and it recovers cleanly afterward.
function squelchUpdate(rms) {
  if (!Number.isFinite(rms)) return; // guard against a pathological driver producing NaN/Infinity, same as the CLI's Squelch::update
  squelchFast = SQUELCH_FAST_ALPHA * rms + (1 - SQUELCH_FAST_ALPHA) * squelchFast;
  if (squelchBootstrapCount < SQUELCH_BOOTSTRAP_SAMPLES) {
    squelchBootstrapCount++;
    squelchFloor += (squelchFast - squelchFloor) / squelchBootstrapCount; // true running mean
    return;
  }
  const effectiveFloor = Math.max(squelchFloor, SQUELCH_MIN_FLOOR);
  if (squelchFast < effectiveFloor * SQUELCH_BUSY_MULTIPLIER) {
    squelchFloor = SQUELCH_FLOOR_ALPHA * squelchFast + (1 - SQUELCH_FLOOR_ALPHA) * squelchFloor;
  }
}

function squelchIsBusy() {
  // Still bootstrapping (see squelchUpdate): no trustworthy floor yet, so
  // there's nothing meaningful to compare against -- assume clear rather
  // than busy, since the alternative (stuck reporting busy from a floor
  // that's still exactly 0 right after LISTEN turns on) is the ORIGINAL
  // deadlock this whole fix exists to avoid.
  if (squelchBootstrapCount < SQUELCH_BOOTSTRAP_SAMPLES) return false;
  return squelchFast > Math.max(squelchFloor, SQUELCH_MIN_FLOOR) * SQUELCH_BUSY_MULTIPLIER;
}

function squelchReset() {
  squelchFast = 0;
  squelchFloor = 0;
  squelchBootstrapCount = 0;
}

const CARRIER_SENSE_POLL_MS = 250; // base interval between busy re-checks
// Found live, after fixing the squelch bootstrap deadlock above: acks were
// STILL colliding with genuinely ongoing transmissions. Root cause was this
// value, not the squelch -- 4s is nowhere near long enough. Directly
// measured phone-mode transmissions elsewhere in this app taking 9-33+
// real seconds (see the reveal-pacing/frameMs logging), so a channel that's
// busy with one ordinary message routinely stays busy well past 4s of
// genuinely correct "busy" readings -- the "give up and transmit anyway"
// safety fallback was routinely firing DURING a real, still-arriving
// transmission, not after some pathologically stuck reading. Raised to
// comfortably exceed realistic worst-case single-message duration, the
// same reasoning TRUNCATION_RETRY_TIMEOUT_MS below already uses for "how
// long can a real transmission legitimately take" -- the fallback should
// only ever fire for a genuinely stuck squelch, not a normal-length
// message that just hasn't finished yet.
const CARRIER_SENSE_MAX_WAIT_MS = 60000;
// Found live with more than two listening devices: several receivers can
// finish decoding the SAME broadcast frame at essentially the same instant
// and each independently send its ack back. Every one of them checks the
// channel, finds it already clear (nobody else has keyed up yet), and --
// without this -- the old fast path returned immediately with no delay at
// all, so all of them transmitted in the same instant anyway. A busy-wait
// alone can't catch this: it only ever defers when it *already* detects
// energy on the channel, but at the moment every ack-sender checks, the
// channel genuinely is still idle -- the collision hasn't happened yet.
// Real CSMA/CA (802.11 DCF) doesn't skip contention just because the
// channel is idle either, for exactly this reason: it always makes a
// station wait a random backoff before transmitting, idle or not, so
// multiple stations ready at the same moment don't all fire on the first
// idle instant they see. This mirrors that -- a short mandatory random
// jitter before every transmission, re-checking the channel afterward in
// case someone else keyed up during the wait.
const CARRIER_SENSE_JITTER_MIN_MS = 40;
const CARRIER_SENSE_JITTER_MAX_MS = 300;

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
  "unexpected end of frame reading protected header", // ran out of tokens, not an RS failure -- see below
  "payload extends past end of received data", // ProtectedHeader, header already validated
  "unexpected end of frame reading parity",
  "unexpected end of frame reading CRC",
]);
// Found live: the header's own truncation case ("unexpected end of frame
// reading protected header") used to collapse into the same string as a
// genuinely uncorrectable header ("protected header FEC uncorrectable"),
// so it couldn't safely be added here -- a live poll catching a real
// transmission mid-header looked identical to real corruption. Now that
// textovervoice-core reports it as its own distinct reason (a pure "ran
// out of tokens" fact, only reachable when there truly isn't enough
// buffered audio yet -- never from a complete-but-corrupt header, so it's
// exactly as safe to retry as the other reasons here), it belongs in this
// set: a live-captured header cut short by buffer boundaries was silently
// reported as a hard failure and permanently skipped, even though the
// rest of the transmission arrived moments later and decoded cleanly.
// "protected header FEC uncorrectable" itself stays excluded -- still
// ambiguous, still reachable by a noise-triggered false preamble with a
// complete (if garbage) trailing buffer.
//
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
//
// Username and message history are deliberately NOT persisted -- this app
// keeps no record of who you are or what you've sent/received beyond the
// current tab's lifetime. exportData() (below, wired to the masthead's
// "EXPORT" button) is the only way to keep any of it: it hands the user a
// file to save themselves, on their own device, on their own terms.

function loadMaxRetries() {
  try {
    const raw = parseInt(localStorage.getItem(STORAGE_MAX_RETRIES), 10);
    return Number.isFinite(raw) && raw >= 0 && raw <= 20 ? raw : DEFAULT_MAX_RETRIES;
  } catch {
    return DEFAULT_MAX_RETRIES;
  }
}

function saveMaxRetries(n) {
  try {
    localStorage.setItem(STORAGE_MAX_RETRIES, String(n));
  } catch {
    // non-critical -- worst case the setting just doesn't persist across reloads
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
const exportDataBtn = document.getElementById("export-data");
const historyEl = document.getElementById("history");
const textInput = document.getElementById("text-input");
const sendKey = document.getElementById("send-key");
const listenKey = document.getElementById("listen-key");
const fileInput = document.getElementById("file-input");
const carriageStatus = document.getElementById("carriage-status");
const bellEl = document.getElementById("bell");
const modeKeys = Array.from(document.querySelectorAll(".mode-key"));
const retryCountInput = document.getElementById("retry-count");

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

let username = "";
let history = [];
let selectedMode = "phone";
let audioCtx = null;

let listening = false;
let mediaStream = null;
let workletNode = null;
let captureBuffer = new Float32Array(0); // see appendCaptureChunk -- grows in place, never rebuilt from scratch
let captureLength = 0; // how much of captureBuffer actually holds real samples
let captureSampleRate = SR;
let scanPos = { phone: 0, fast_air: 0 };
let scanStuckSince = { phone: null, fast_air: null }; // Date.now() a truncation-looking retry started, per mode
let liveReassembler = new Reassembler();
let pollTimer = null;

let calibrating = false;
let calibrateScanPos = new Map(); // "mode:parity" -> sample offset
let calibrateStuckSince = new Map(); // "mode:parity" -> Date.now() a truncation-looking retry started
let calibrateMatches = new Set(); // "mode:parity" already reported

let maxRetries = loadMaxRetries();
// id -> { chunks, mode, attempt, timer } -- an outgoing message still
// waiting for an ack, with a pending setTimeout to resend it if one
// doesn't arrive. In-memory only: a page reload doesn't resume retrying a
// message from before the reload (its status just stays whatever it last
// was), same tradeoff every other piece of live-session state here makes.
const pendingDeliveries = new Map();

let suppressCaptureUntil = 0; // performance.now() timestamp -- see playPcm
let currentMicPeak = 0; // last-measured mic peak, refreshed every MIC_METER_UPDATE_MS -- see waitForClearChannel
// rx message ids already fully received at least once this session -- lets
// handleDecodedFrame tell "a redundant resend of something we already got"
// apart from "genuinely new," so a resend triggered by a lost/late ack
// doesn't ring the bell again for what the user hears as one message.
const receivedMessageIds = new Set();

let liveDecodeId = null; // message id currently shown in the live decode box
let liveDecodeUsername = "";
// Text already CONFIRMED (via a real, FEC/CRC-verified scan_next_frame
// result) for liveDecodeId, across however many of its frames have
// completed so far -- authoritative, never revised.
let liveDecodeConfirmed = "";
// Text currently on screen: liveDecodeConfirmed plus whatever the live,
// pre-FEC preview (see updateLivePreview/preview_frame) has tentatively
// shown for the frame still arriving. May differ from what eventually
// gets confirmed -- see revealTo, which corrects it if so.
let liveDecodeShown = "";
// True once liveDecodeId's message has been confirmed complete (a real,
// FEC/CRC-verified result.ok) at least once -- lets ensureLiveDecodeTracking
// tell "still the same message still arriving" apart from "this id again,
// but as a NEW transmission" (a resend, heard because the sender's ack
// never arrived). Without this, a resend of the message the box is still
// showing the "MESSAGE COMPLETE" hold for -- same id, so the old id check
// alone treated it as a continuation -- got its text appended onto the
// already-complete text instead of the box starting over, and since it's
// a duplicate (see alreadyReceived) never got a fresh completion callback
// either, so it stayed stuck showing that broken, doubled text
// indefinitely instead of ever resetting again.
let liveDecodeCompleted = false;
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
  // Deferred to the next frame: reading scrollHeight immediately after
  // the DOM mutations above can race the browser's layout pass and scroll
  // by less than the full new height, especially for a taller entry.
  requestAnimationFrame(() => {
    historyEl.scrollTop = historyEl.scrollHeight;
  });
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
  // The character-by-character decode flicker belongs only to the
  // real-time preview box (see revealTo) -- by the time a message is a
  // chat bubble here, the decode already happened and was already watched
  // happen there; replaying the animation on the bubble too was
  // redundant, not informative.
  text.textContent = entry.text;

  slip.append(head, text);

  if (entry.dir === "tx") {
    const foot = document.createElement("div");
    foot.className = "slip-foot";
    const spacer = document.createElement("span");
    spacer.textContent = new Date(entry.time).toLocaleTimeString();
    foot.append(spacer);
    if (pendingDeliveries.has(entry.id)) {
      const stop = document.createElement("button");
      stop.className = "resend-tab";
      stop.textContent = "STOP ▶";
      stop.type = "button";
      stop.addEventListener("click", () => stopDeliveryRetry(entry.id));
      foot.append(stop);
    } else {
      const resend = document.createElement("button");
      resend.className = "resend-tab";
      resend.textContent = "RESEND ▶";
      resend.type = "button";
      resend.addEventListener("click", () => resendOwnMessage(entry.id));
      foot.append(resend);
    }
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

const utf8Encoder = new TextEncoder();

/// The character's real encoded bytes -- for a single-byte (ASCII/Latin-1)
/// character, its 8-bit binary, same as before. For anything wider (CJK,
/// emoji, accented characters outside Latin-1 -- multiple UTF-8 bytes per
/// character), `ch.codePointAt(0) & 0xff` used to silently discard every
/// bit above the low byte, showing a meaningless flicker for exactly the
/// characters where "watch it decode" mattered most -- found live sending
/// Chinese text, where the box never showed anything resembling a real
/// decode step. Now it shows the character's actual UTF-8 bytes in hex,
/// joined by "-" (marking a continuation byte, same idea as UTF-8's own
/// 10xxxxxx continuation-byte marker) and capped with "×" as the
/// terminator once the full sequence for this one character is shown.
/// Still not a literal reconstruction of this app's actual wire bytes
/// (which depend on charset/dictionary compression this layer doesn't
/// have visibility into) -- but now at least an honest, real encoding of
/// the character itself, not a value with no meaning at all.
function charBits(ch) {
  const bytes = utf8Encoder.encode(ch);
  if (bytes.length === 1) {
    return bytes[0].toString(2).padStart(8, "0");
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join("-") + "×";
}

/// A scrambled guess in the same shape charBits(ch) would resolve to --
/// same byte count, same hex/binary formatting -- so the flicker settles
/// from "plausible-looking guess" to "real bytes" without the shape
/// itself jumping partway through.
function scrambledBits(ch) {
  const byteCount = utf8Encoder.encode(ch).length;
  if (byteCount === 1) {
    return Array.from({ length: 8 }, () => (Math.random() < 0.5 ? "0" : "1")).join("");
  }
  return Array.from({ length: byteCount }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0").toUpperCase()).join("-") + "×";
}

/// Reveals one more character onto `prefix` via `setText` (a callback
/// given the full text-so-far) within `budgetMs` total -- for a
/// non-whitespace character, a scrambled 8-bit guess settling into the
/// real 8-bit code then the resolved letter, each phase getting a slice
/// of the budget; whitespace just appears, no flicker. Used only by
/// `revealTo` (the live-decode preview box) -- the chat bubble a
/// finished message ends up as (see renderEntry) shows its text plainly,
/// no flicker, since the decode was already watched happen here. A tight
/// budget (a long real message packed into a short transmission) degrades
/// gracefully: skip the scrambled-guess phase first, then skip straight
/// to the resolved character -- staying fast and legible instead of
/// stretching the animation past what the budget actually allows.
async function flickerInChar(setText, prefix, ch, budgetMs) {
  if (ch.trim() === "") {
    setText(prefix + ch);
    await sleep(Math.min(budgetMs, TYPEWRITER_CHAR_MS));
    return;
  }
  if (budgetMs < FLICKER_SKIP_THRESHOLD_MS) {
    setText(prefix + ch);
    await sleep(budgetMs);
    return;
  }
  if (budgetMs < FLICKER_BITS_ONLY_THRESHOLD_MS) {
    setText(prefix + charBits(ch));
    await sleep(budgetMs * 0.5);
    setText(prefix + ch);
    await sleep(budgetMs * 0.5);
    return;
  }
  setText(prefix + scrambledBits(ch));
  await sleep(budgetMs * 0.3);
  setText(prefix + charBits(ch));
  await sleep(budgetMs * 0.3);
  setText(prefix + ch);
  await sleep(budgetMs * 0.4);
}

function statusLabel(entry) {
  if (entry.dir === "tx") {
    switch (entry.status) {
      case "awaiting-ack":
        return "AWAITING ACK";
      case "resending":
        return `RESENDING (${entry.attempt}/${maxRetries})`;
      case "delivered":
        return "✓ DELIVERED";
      case "undelivered":
        return "✕ UNDELIVERED";
      default:
        return "SENT";
    }
  }
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

/// Hands the user a file with everything this tab currently holds --
/// username and full message history -- since none of it is kept any
/// other way (see the "storage" section). Purely a local file save: the
/// browser downloads it like any other file, nothing is sent anywhere.
function exportData() {
  const payload = {
    exportedAt: new Date().toISOString(),
    username,
    history,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  a.download = `tovchat-export-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

exportDataBtn.addEventListener("click", exportData);

// ============================= audio context =============================

// Found live: severely poor performance on a real phone. Every per-poll
// wasm call (preview_frame, scan_next_frame -- twice, once per mode --
// scan_for_nack, plus normalizePeak) does work that scales with the
// captured buffer's SAMPLE COUNT, and this context (and the capture
// pipeline built on it) was running at the browser's native rate --
// 44100 or 48000Hz on virtually every real device -- for no reason: every
// modem tone this protocol uses lives inside the 300-3400Hz telephone
// voice band (see textovervoice-core's modem.rs -- PREAMBLE_F1 and every
// data tone), and the wire format is itself designed natively around
// 8000Hz (`modem::SR`). Capturing at native rate was processing 3-6x more
// samples than the signal has any real content in, multiplying every one
// of those per-poll costs for zero benefit -- a much bigger and more
// direct hit on a phone's weaker CPU than on a desktop's. Requesting this
// rate up front makes the whole capture pipeline (the worklet, the
// buffer, every wasm call fed from it) operate on that many fewer samples
// from the start; `captureSampleRate = ctx.sampleRate` downstream already
// reads back whatever the browser actually grants, so this degrades
// safely on a browser that won't honor the exact request. 16000, not
// 8000 (`modem::SR`) exactly, to keep a comfortable 2x safety margin
// above the highest tone (8000Hz Nyquist vs. a 3400Hz ceiling) -- a real
// anti-aliasing filter isn't perfectly brick-wall, and this is capture,
// not the wire format itself, so there's no reason to cut it close.
// Playback is unaffected: `playPcm` already builds its buffer at the
// modem's own SR (8000) explicitly and Web Audio resamples on output
// regardless of what rate this context runs at.
const CAPTURE_TARGET_SAMPLE_RATE = 16000;

async function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: CAPTURE_TARGET_SAMPLE_RATE });
  }
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }
  return audioCtx;
}

// A silent lead-in before the real signal starts -- found live: repeated
// real (non-truncation) "HEADER FEC: UNCORRECTABLE" failures, specifically
// on the header, which is the very first thing sent right after the
// preamble. That points at something settling right at the start of
// playback -- autoGainControl adapting from silence to a loud tone,
// speaker reaching steady output, room reflections stabilizing -- landing
// squarely on the header instead of later in the transmission. Safe to
// add: the receiver already tolerates arbitrary leading silence by
// design (this doesn't need symbol 0 to start at sample 0).
const LEAD_IN_SILENCE_S = 0.3;

// Extra hold after playback ends before the mic capture buffer resumes
// accepting audio -- found live: a device with LISTEN left on while it
// also sends (a lone user's normal usage, not just the two-tab test) has
// its own mic pick up its own speaker's output, acoustically coupled on
// the same machine, and "receive" its own transmission back as if it were
// incoming. `playPcm` is the single choke point every send path (message
// send, resend, calibrate probes, an automatic NACK-triggered resend) goes
// through, so suppressing capture here covers all of them at once. The
// tail beyond the buffer's own duration accounts for room reverb/echo
// still ringing after the source node's `onended` fires.
const CAPTURE_SUPPRESS_TAIL_S = 0.4;

// Serializes every outgoing playback through one queue -- found live
// (a two-tab weather conversation): an incoming message's automatic ack
// (sendAckFor, fired from handleDecodedFrame without being awaited) and a
// reply typed and sent moments later both call playPcm independently, and
// with nothing to stop them, their two AudioBufferSourceNodes played
// concurrently on the same AudioContext -- both signals mixed together
// acoustically, garbling the ack (the sender's retry timer then genuinely
// never heard it, correctly marking the original message UNDELIVERED)
// *and* the reply (never decoded on the other end either). Chaining every
// call onto this promise, instead of starting playback immediately, makes
// "one clip plays at a time" true regardless of how many places call
// playPcm or whether the caller awaits the result. This queue only
// serializes THIS device's own sends against each other, though -- a
// different device transmitting at the same moment is a separate
// AudioContext entirely, which is what waitForClearChannel (called first,
// inside the queue) exists to avoid colliding with.
let playbackQueue = Promise.resolve();

// Found live: sending three messages in quick succession left all three
// UNDELIVERED even though the receiver genuinely decoded and re-acked
// every one of them (confirmed in its own console log -- ack-sent fired
// each time, with clean, short carrier-clear waits). The SENDER's own log
// showed zero ack-recv, ever. Root cause: three messages in flight means
// this device's own playbackQueue fills with the original sends plus every
// retry -- a dozen-plus of this device's OWN transmissions, one right
// after another with nothing but the random contention jitter between
// them. That leaves almost no real gap where this device is both quiet
// AND actually listening: the moment one of its own clips ends, the next
// queued one is already winding up to start (and re-arming
// suppressCaptureUntil the instant it does), so a reply arriving in that
// narrow window has a good chance of landing right as this device keys up
// again -- swallowed by its own suppression, not lost to the other side's
// carrier sense at all. A deliberate pause here, after every one of this
// device's own clips and before the next queued one is allowed to start,
// guarantees the other side a real listening window -- sized past a full
// poll cycle plus decode and their own contention jitter, comfortably
// enough time for a reply to actually get heard, not just technically
// permitted to transmit.
const POST_TRANSMISSION_LISTEN_GAP_MS = 2000;

function playPcm(float32Samples, sampleRate) {
  const task = playbackQueue.then(() =>
    waitForClearChannel().then(() => ensureAudioContext()).then((ctx) => {
      return new Promise((resolve) => {
        const leadIn = Math.round(LEAD_IN_SILENCE_S * sampleRate);
        const buffer = ctx.createBuffer(1, leadIn + float32Samples.length, sampleRate);
        buffer.copyToChannel(float32Samples, 0, leadIn);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        const durationMs = (buffer.length / sampleRate) * 1000;
        suppressCaptureUntil = performance.now() + durationMs + CAPTURE_SUPPRESS_TAIL_S * 1000;
        src.onended = resolve;
        src.start();
      });
    })
  );
  // The gap delays when this device's OWN next queued transmission is
  // allowed to start, not what the caller of this playPcm call is
  // awaiting -- `task` still resolves as soon as this clip's playback
  // genuinely ends, so callers (status updates, the retry scheduler) see
  // the same timing as before. Keep the queue moving even if this clip's
  // caller never awaits it (e.g. sendAckFor's fire-and-forget) or
  // playback fails -- one bad clip shouldn't wedge every later send
  // behind it forever.
  playbackQueue = task.then(() => sleep(POST_TRANSMISSION_LISTEN_GAP_MS)).catch(() => {});
  return task;
}

// ============================= send =============================

function addHistoryEntry(entry) {
  history.push(entry);
  if (history.length > MAX_HISTORY_ENTRIES) history = history.slice(-MAX_HISTORY_ENTRIES);
  renderHistory();
}

function updateHistoryEntry(id, dir, patch) {
  const entry = history.find((h) => h.id === id && h.dir === dir);
  if (!entry) return false;
  Object.assign(entry, patch);
  renderHistory();
  return true;
}

async function sendMessage() {
  const raw = textInput.value;
  if (raw.trim().length === 0) return;

  // Delivery tracking (the ack/retry cycle below) is worthless without the
  // mic actually running: an ack is just another incoming frame, and
  // nothing decodes incoming frames unless `listening` is on and
  // `pollCapture` is polling. Found live: send a message without ever
  // having clicked LISTEN, and it sits "AWAITING ACK" forever no matter
  // how cleanly the other side actually received and acked it -- this
  // device was never listening for the answer. Starting capture here,
  // automatically, closes that gap: sending a message now means "listen
  // for the reply" the same way it would for any real conversation,
  // instead of requiring a separate manual step the UI never explained
  // was necessary. A no-op if already listening; silently does nothing
  // (falls through to send anyway) if the mic is unavailable/denied --
  // no worse than the behavior before this existed.
  if (maxRetries > 0 && !listening) {
    await startListening();
  }

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
  dbg("send", id, selectedMode, JSON.stringify(raw.slice(0, 60)));
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

  if (maxRetries > 0) {
    pendingDeliveries.set(id, { chunks: taggedChunks, mode: selectedMode, attempt: 0, timer: null });
    updateHistoryEntry(id, "tx", { status: "awaiting-ack" });
    scheduleDeliveryRetry(id);
  }
}

/// Schedules the next auto-resend check for `id` -- called once right
/// after the initial send, then again after every retry attempt. Does
/// nothing if `id` isn't (or is no longer) pending, so a stray call after
/// an ack already arrived or the cycle was stopped is harmless.
function scheduleDeliveryRetry(id) {
  const pending = pendingDeliveries.get(id);
  if (!pending) return;
  pending.timer = setTimeout(() => attemptDeliveryRetry(id), RETRY_ACK_GRACE_MS);
}

async function attemptDeliveryRetry(id) {
  const pending = pendingDeliveries.get(id);
  if (!pending) return; // acked or stopped since this timer was scheduled

  if (pending.attempt >= maxRetries) {
    dbg("undelivered", id, "gave up after", maxRetries, "attempts");
    pendingDeliveries.delete(id);
    updateHistoryEntry(id, "tx", { status: "undelivered" });
    return;
  }

  pending.attempt += 1;
  dbg("retry", id, `attempt ${pending.attempt}/${maxRetries}`, "-- no ack within", RETRY_ACK_GRACE_MS + "ms");
  updateHistoryEntry(id, "tx", { status: "resending", attempt: pending.attempt });
  try {
    const pcm = encode_frames_to_pcm(pending.chunks, pending.mode, undefined, undefined, undefined);
    await playPcm(pcm, SR);
  } catch {
    // A transient encode/playback failure shouldn't silently end the retry
    // cycle -- fall through and schedule the next attempt anyway.
  }
  // Re-check: markDelivered/stopDeliveryRetry could have fired while the
  // resend above was playing.
  if (pendingDeliveries.has(id)) scheduleDeliveryRetry(id);
}

/// Called when an ack for `id` is heard -- cancels any pending retry and
/// marks the message delivered. A no-op if `id` isn't a message this
/// device is currently tracking (an ack for someone else's message, or one
/// already resolved).
function markDelivered(id) {
  const pending = pendingDeliveries.get(id);
  if (!pending) return;
  dbg("delivered", id, `after ${pending.attempt} resend(s)`);
  clearTimeout(pending.timer);
  pendingDeliveries.delete(id);
  updateHistoryEntry(id, "tx", { status: "delivered" });
}

/// User-initiated cancel of an in-progress auto-retry cycle (see the STOP
/// button rendered for a "resending"/"awaiting-ack" entry). Leaves the
/// message as already-sent -- stopping isn't undoing the send, just giving
/// up on hearing back.
function stopDeliveryRetry(id) {
  const pending = pendingDeliveries.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingDeliveries.delete(id);
  updateHistoryEntry(id, "tx", { status: "sent" });
}

/// Sends a delivery confirmation for a message this device just finished
/// decoding: the ACK byte plus the message id (see ACK_MARKER), sent as an
/// ordinary short frame through the same pipeline as any other message --
/// no separate wire frame type. Best-effort and fire-and-forget from the
/// caller's point of view (see `handleDecodedFrame`) -- a failed ack just
/// means the sender's own retry timer eventually tries again or gives up,
/// nothing to show the receiving side for that.
async function sendAckFor(id, mode) {
  dbg("ack-sent", id, mode);
  try {
    const pcm = encode_frames_to_pcm([ACK_MARKER + id], mode, undefined, undefined, undefined);
    await playPcm(pcm, SR);
  } catch (e) {
    dbg("ack-sent-failed", id, e);
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

retryCountInput.value = String(maxRetries);
retryCountInput.addEventListener("change", () => {
  const n = parseInt(retryCountInput.value, 10);
  maxRetries = Number.isFinite(n) && n >= 0 && n <= 20 ? n : DEFAULT_MAX_RETRIES;
  retryCountInput.value = String(maxRetries); // reflect any clamping back
  saveMaxRetries(maxRetries);
});

// ============================= receive: live mic =============================

/// Appends `chunk` onto `captureBuffer`, growing it (by doubling) only when
/// it's actually out of room, and returns a zero-copy view of everything
/// captured so far. Replaces the previous design, which kept every
/// worklet chunk in an array and re-concatenated the WHOLE thing into a
/// fresh Float32Array on every single poll tick -- O(already-captured
/// length) work, every 1.2s, for the entire lifetime of a listening
/// session, at the browser's native sample rate (44.1-48kHz, not the
/// modem's 8kHz) -- up to MAX_BUFFER_SECONDS worth, so a buffer nearing
/// that cap was being fully re-copied (roughly 2 million samples) on
/// every poll for no reason: almost none of it had changed since the
/// last poll. Appending in place and handing out a `subarray` (a view
/// into the same backing memory, not a copy) makes each poll's cost
/// proportional to what's NEW since last time, not to everything
/// captured so far.
function appendCaptureChunk(chunk) {
  if (captureLength + chunk.length > captureBuffer.length) {
    let newCap = captureBuffer.length * 2 || chunk.length;
    while (newCap < captureLength + chunk.length) newCap *= 2;
    const grown = new Float32Array(newCap);
    grown.set(captureBuffer.subarray(0, captureLength));
    captureBuffer = grown;
  }
  captureBuffer.set(chunk, captureLength);
  captureLength += chunk.length;
  return captureBuffer.subarray(0, captureLength);
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
  // Deliberately no "[FEC ✓] [CRC ✓]" here -- by the time this frame's text
  // reaches JS at all, the wasm side has already fully verified both (it
  // can't hand back partially-checked data), so claiming that here, before
  // the reveal has even started, was true but misleadingly early -- the
  // user watching the flicker resolve hasn't "seen" it happen yet. The
  // confirmation belongs at the end of the decode progress, once the
  // reveal actually catches up -- see onLiveMessageComplete.
  return liveDecodeId ? `● RECEIVING · ${liveDecodeUsername} · #${liveDecodeId}` : "▪ AWAITING SIGNAL ▪";
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
  liveDecodeConfirmed = "";
  liveDecodeShown = "";
  liveDecodeCompleted = false;
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

/// Starts tracking a (possibly new) message in the live-decode box: resets
/// confirmed/shown text and the on-screen element whenever `id` differs
/// from whatever was previously showing, OR the previously-showing id
/// already completed once (see liveDecodeCompleted) -- a resend of the
/// same message arriving is a NEW transmission event as far as the box is
/// concerned, not a continuation of the one it already finished showing.
/// A no-op otherwise, so callers can call this unconditionally on every
/// preview/confirmation without checking either condition themselves.
function ensureLiveDecodeTracking(id, username) {
  if (id === liveDecodeId && !liveDecodeCompleted) return;
  liveDecodeId = id;
  liveDecodeUsername = username;
  liveDecodeConfirmed = "";
  liveDecodeShown = "";
  liveDecodeCompleted = false;
  liveDecodeTextEl.textContent = "";
}

/// Animates the live-decode box from whatever it currently shows
/// (`liveDecodeShown`) to `targetText`, character by character via
/// `flickerInChar`, then commits `liveDecodeShown = targetText`. Finds the
/// first point the two diverge and re-flickers only from there onward --
/// so ordinary growth (new preview characters appended at the end) just
/// flickers the new tail in, while a correction (the confirmed, FEC/CRC-
/// verified text turns out to differ from what the raw preview had
/// tentatively shown -- see handleDecodedFrame) visibly re-resolves from
/// wherever it was actually wrong, instead of silently snapping to the
/// right answer.
///
/// `onDone`, if given, only runs once this reveal reaches the end of
/// `targetText` (not if a newer call -- a fresher preview, or the real
/// confirmation -- supersedes this one first, via the same token
/// cancellation the box has always used) -- lets a caller show "message
/// complete" exactly when the visual decode process the user is watching
/// genuinely finishes, instead of the instant the underlying frame
/// decoded (found live, before this box was preview-driven: firing that
/// immediately, before a still-animating reveal had caught up, reliably
/// wiped the box's text mid-flicker, looking like the animation had
/// simply stopped partway through).
async function revealTo(targetText, onDone) {
  const token = ++liveDecodeRevealToken;
  let matchLen = 0;
  while (
    matchLen < liveDecodeShown.length &&
    matchLen < targetText.length &&
    liveDecodeShown[matchLen] === targetText[matchLen]
  ) {
    matchLen++;
  }
  dbg("reveal-start", "token=" + token, `${matchLen}->${targetText.length} chars`);
  for (let i = matchLen; i < targetText.length; i++) {
    if (token !== liveDecodeRevealToken) {
      dbg("reveal-superseded", "token=" + token, "at char", i, "of", targetText.length);
      return;
    }
    await flickerInChar(
      (t) => { liveDecodeTextEl.textContent = t; },
      targetText.slice(0, i),
      targetText[i],
      LIVE_PREVIEW_CHAR_MS
    );
  }
  if (token !== liveDecodeRevealToken) return;
  liveDecodeShown = targetText;
  liveDecodeTextEl.textContent = targetText;
  dbg("reveal-done", "token=" + token);
  if (onDone) onDone();
}

function onLiveMessageComplete() {
  // This is where the FEC/CRC confirmation belongs (see
  // steadyLiveDecodeStatus) -- both are already known good by now (this
  // only runs once the reveal itself has finished), so showing it here
  // lines the checkmarks up with the moment the user actually finishes
  // watching the text resolve, not the instant the frame decoded.
  setTransientLiveDecodeStatus("✓ FEC OK · ✓ CRC OK · MESSAGE COMPLETE", LIVE_DECODE_COMPLETE_HOLD_MS, resetLiveDecode);
}

/// Polls the live, pre-FEC preview (see `preview_frame`) for whatever
/// frame is currently arriving at `scanPos[mode]`, and updates the
/// live-decode box if there's anything new to show. Called every poll,
/// independent of whether a frame has actually finished arriving yet --
/// this is what makes the box genuinely real-time: characters appear as
/// soon as they're demodulated from the growing capture buffer, not once
/// an entire frame (or a fixed timer standing in for one) completes.
///
/// Deliberately non-authoritative, same caveat as `preview_frame` itself:
/// what it shows can be wrong until `handleDecodedFrame`'s real,
/// FEC/CRC-verified result confirms or corrects it.
function updateLivePreview(mode) {
  if (liveDecodeEl.hidden) return;
  let preview;
  try {
    preview = preview_frame(captureBuffer.subarray(0, captureLength), captureSampleRate, mode, scanPos[mode], undefined);
  } catch {
    return;
  }
  if (!preview || preview.text.startsWith(ACK_MARKER)) return; // nothing yet, or a delivery ack -- not a message to preview
  const tag = untagChunk(preview.text);
  if (!tag) return; // envelope (id/username) hasn't fully arrived yet

  ensureLiveDecodeTracking(tag.id, tag.username);
  clearTimeout(liveDecodeStatusRestoreTimer);
  setLiveDecodeStatus(steadyLiveDecodeStatus());
  const target = liveDecodeConfirmed + tag.text;
  if (target !== liveDecodeShown) revealTo(target);
}

function handleDecodedFrame(frame, mode) {
  if (!frame.ok) {
    if (!liveDecodeEl.hidden && MEANINGFUL_FAILURES.has(frame.reason)) {
      flashLiveDecodeStatus(`✕ ${MEANINGFUL_FAILURES.get(frame.reason)}`);
    }
    return;
  }
  if (frame.text.startsWith(ACK_MARKER)) {
    // A delivery confirmation, not a real message -- see sendAckFor/
    // ACK_MARKER. Never shown in the live-decode box, and doesn't warrant
    // the full-buffer reset a completed message gets below (it's a tiny
    // frame; pollCapture's normal next_start advancement is enough to
    // move past it).
    const targetId = frame.text.slice(ACK_MARKER.length);
    dbg("ack-recv", "target=" + targetId);
    markDelivered(targetId);
    return false;
  }
  const tag = untagChunk(frame.text);
  if (!tag) return; // not one of ours (or a corrupted envelope) -- ignore, don't guess

  const result = liveReassembler.add(tag.id, tag.username, frame.seq, tag.text, frame.more_frames);
  // A resend the sender only sent because it never heard our first ack
  // (lost in transit, or just outrun by RETRY_ACK_GRACE_MS) looks
  // identical to a genuinely new message here -- same id, same content,
  // decoded clean. Used below to skip ringBell/history-duplication for a
  // duplicate -- but NOT to skip the live-decode box's own completion
  // (see revealTo's onDone below): the box reflects what's actually being
  // heard right now, and a resend really did just fully arrive again, so
  // it announces "complete" and resets on its own schedule regardless of
  // whether this is old news for the chat history.
  const alreadyReceived = result.ok && receivedMessageIds.has(tag.id);

  // Fold this frame's now-CONFIRMED (FEC/CRC-verified) text into the live
  // box, correcting anything the raw preview had tentatively gotten wrong
  // -- see revealTo/updateLivePreview.
  if (!liveDecodeEl.hidden) {
    ensureLiveDecodeTracking(tag.id, tag.username);
    liveDecodeConfirmed += tag.text;
    clearTimeout(liveDecodeStatusRestoreTimer);
    setLiveDecodeStatus(steadyLiveDecodeStatus());
    if (result.ok) liveDecodeCompleted = true;
    revealTo(liveDecodeConfirmed, result.ok ? onLiveMessageComplete : undefined);
  }

  if (result.ok) {
    dbg("complete", tag.id, alreadyReceived ? "(duplicate resend)" : "(new)", JSON.stringify(result.text.slice(0, 60)));
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
    // Re-send the ack regardless of alreadyReceived (that's the whole
    // point: the sender is still waiting), but don't re-ring the bell for
    // something the user already saw arrive once.
    receivedMessageIds.add(tag.id);
    if (!alreadyReceived) ringBell();
    sendAckFor(tag.id, mode); // fire-and-forget -- see sendAckFor
    // The buffer is never trimmed as it's consumed (only ever grows, up
    // to the hard MAX_BUFFER_SECONDS cap), so without this a long
    // listening session keeps re-materializing and re-scanning an
    // ever-larger buffer on every poll, and eventually hits that cap --
    // which used to leave scanPos stale relative to the freshly-emptied
    // buffer, silently breaking all further detection (found live: "works
    // a few times, then fails" was this). Clearing right after a full
    // message completes keeps the buffer bounded in normal use, so the
    // cap becomes a true just-in-case fallback instead of something
    // routinely hit. Signal the reset back to the caller (pollCapture) so
    // it stops scanning THIS poll cycle immediately, matching the
    // existing NACK-handling pattern -- continuing with the local `pos`/
    // `buffer` it already had would silently undo this reset the moment
    // it writes scanPos[mode] = pos at the end of its loop.
    resetCaptureBuffer();
    return true;
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
  return false;
}

function resetCaptureBuffer() {
  captureLength = 0; // keep the allocated capacity -- no need to reallocate on next use
  scanPos = { phone: 0, fast_air: 0 };
  scanStuckSince = { phone: null, fast_air: null };
}

async function handleNackFound(info) {
  const targetId = Array.from(info.target_id).map((b) => b.toString(16).padStart(2, "0")).join("");
  const entry = history.find((h) => h.id === targetId && h.dir === "tx");
  if (entry) await resendOwnMessage(targetId);
}

// Both throttle counters below exist for the same reason: found live,
// severely poor performance on a real phone. `updateLivePreview` and
// `scan_for_nack` each redo a full preamble search (`preview_frame` also
// redoes the full demodulation `scan_next_frame` is about to do again
// right after it, and `scan_for_nack` rescans the ENTIRE buffer, not just
// the unscanned tail) -- real, necessary costs, but ones that don't need
// to run on literally every single poll to still feel responsive.
let pollCount = 0;
const LIVE_PREVIEW_EVERY_N_POLLS = 2; // ~2.4s cadence -- still reads as "live," half the preview_frame calls
const NACK_SCAN_EVERY_N_POLLS = 3; // ~3.6s -- a NACK is a rare, user-initiated request, not the hot path

async function pollCapture(buffer) {
  pollCount++;
  for (const mode of LISTEN_MODES) {
    // Real-time decode preview: shows whatever's demodulated so far at the
    // CURRENT scan position, independent of whether a frame below actually
    // finishes arriving this poll -- see updateLivePreview.
    if (pollCount % LIVE_PREVIEW_EVERY_N_POLLS === 0) updateLivePreview(mode);

    let pos = scanPos[mode];
    while (true) {
      let frame;
      try {
        frame = scan_next_frame(buffer, captureSampleRate, mode, pos);
      } catch {
        break;
      }
      if (!frame) break;

      dbg("scan", mode, "pos=" + pos, "ok=" + frame.ok, frame.ok ? "" : frame.reason, "next=" + frame.next_start);

      if (!frame.ok && TRUNCATION_REASONS.has(frame.reason)) {
        if (scanStuckSince[mode] === null) scanStuckSince[mode] = Date.now();
        if (Date.now() - scanStuckSince[mode] < TRUNCATION_RETRY_TIMEOUT_MS) {
          // Leave pos where it was -- don't report this as a failure, and
          // retry this exact position next poll once more of the
          // transmission has arrived, rather than skipping past it.
          dbg("hold", mode, "stuck for", Date.now() - scanStuckSince[mode] + "ms", "reason=" + frame.reason);
          break;
        }
        // Waited long enough that this is more likely genuine corruption
        // than a message still arriving -- give up waiting and report it.
        scanStuckSince[mode] = null;
      } else {
        scanStuckSince[mode] = null;
      }

      if (handleDecodedFrame(frame, mode)) return; // buffer was reset on completion -- stop, buffer/pos are gone
      pos = frame.next_start;
    }
    scanPos[mode] = pos;

    // scan_for_nack has no position to resume from -- it re-scans the whole
    // buffer every time it runs, so a NACK sitting in it would otherwise be
    // found (and acted on) again on every subsequent poll until the buffer
    // moves past it. Wipe the buffer immediately after handling one, rather
    // than tracking yet another per-mode cursor just for this.
    if (pollCount % NACK_SCAN_EVERY_N_POLLS !== 0) continue;
    let nack;
    try {
      nack = scan_for_nack(buffer, captureSampleRate, mode);
    } catch {
      nack = null;
    }
    if (nack) {
      const targetId = Array.from(nack.target_id).map((b) => b.toString(16).padStart(2, "0")).join("");
      dbg("nack-recv", "target=" + targetId);
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
  currentMicPeak = 0;
  squelchReset();
}

function updateMicLevelDisplay(peak) {
  const pct = Math.min(100, (peak / MIC_METER_FULL_SCALE) * 100);
  micLevelFillEl.style.width = `${pct}%`;
  micLevelDbEl.textContent = peak > 0 ? `${(20 * Math.log10(peak)).toFixed(0)} dB` : "−∞ dB";
  currentMicPeak = peak;
}

/// Whether the channel should be treated as busy -- squelchIsBusy()
/// (amplitude-based, catches a transmission before this device has locked
/// onto anything) OR'd with a protocol-level signal: is pollCapture
/// CURRENTLY holding position on a real, already-preamble-and-header-
/// verified frame that just hasn't fully arrived yet (scanStuckSince, see
/// pollCapture)? Found live: a message's send still collided with an
/// incoming ack even after tuning the squelch's own sensitivity -- raw
/// amplitude alone can miss a real but relatively quiet signal (an ack's
/// own transmission, picked up from across a room, isn't necessarily as
/// energetic as a nearby full data frame). Once this device has actually
/// demodulated a valid preamble and header for something, that's a FAR
/// more reliable "someone is transmitting to me right now" signal than
/// any amplitude threshold -- it can't be fooled by ambient loudness or
/// AGC in either direction, because it's driven by the real protocol
/// state, not a guess about what a "loud enough" signal sounds like.
function channelLooksBusy() {
  return squelchIsBusy() || scanStuckSince.phone !== null || scanStuckSince.fast_air !== null;
}

/// Waits for the channel to sound quiet (per channelLooksBusy above)
/// before a transmission starts, then makes it wait a short random jitter
/// on top and re-checks -- see the CARRIER_SENSE_* constants for why the
/// jitter applies even on an already-clear channel, not just a busy one.
/// A device that isn't listening has no mic level to check and returns
/// immediately (transmits blind, same as before this existed).
async function waitForClearChannel() {
  if (!listening) return;
  const previousStatus = carriageStatus.textContent;
  const deadline = performance.now() + CARRIER_SENSE_MAX_WAIT_MS;
  let waited = 0;
  let lastLoggedAt = 0;
  while (performance.now() < deadline) {
    if (channelLooksBusy()) {
      // Logged periodically (not just once) so a real session's console
      // shows a time series of fast/floor while stuck waiting -- a single
      // snapshot from the first busy check can't tell "genuinely busy the
      // whole time" apart from "briefly busy, then stuck reporting busy
      // for an unrelated reason" (still calibrating, a squelch bug, real
      // sustained loud ambient noise, etc.) -- exactly the question that
      // needs answering when this wait is running out its full length
      // instead of clearing quickly the way a real quiet gap should let it.
      if (performance.now() - lastLoggedAt > 1000) {
        dbg("carrier-busy", "fast=" + squelchFast.toFixed(4), "floor=" + squelchFloor.toFixed(4), "threshold=" + (Math.max(squelchFloor, SQUELCH_MIN_FLOOR) * SQUELCH_BUSY_MULTIPLIER).toFixed(4), "midFrame=" + (scanStuckSince.phone !== null || scanStuckSince.fast_air !== null), "waited=" + Math.round(waited) + "ms");
        lastLoggedAt = performance.now();
      }
      setCarriageStatus("● CHANNEL BUSY, WAITING…");
      const backoff = CARRIER_SENSE_POLL_MS + Math.random() * CARRIER_SENSE_POLL_MS;
      waited += backoff;
      await sleep(backoff);
      continue;
    }
    // Channel reads clear -- still owe a mandatory random contention
    // jitter before actually transmitting (see the constants' comment),
    // then re-check: if someone else keyed up while this device was
    // jittering, loop back into the busy branch instead of transmitting
    // over them.
    const jitter = CARRIER_SENSE_JITTER_MIN_MS + Math.random() * (CARRIER_SENSE_JITTER_MAX_MS - CARRIER_SENSE_JITTER_MIN_MS);
    waited += jitter;
    await sleep(jitter);
    if (!channelLooksBusy()) {
      dbg("carrier-clear", "channel clear after", Math.round(waited) + "ms");
      setCarriageStatus(previousStatus); // restore whatever the caller had shown before we stepped on it
      return;
    }
  }
  dbg("carrier-clear", "gave up waiting after", Math.round(waited) + "ms");
  setCarriageStatus(previousStatus);
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
  captureBuffer = new Float32Array(0);
  captureLength = 0;
  resetMicLevel();

  let meterPeak = 0;
  let lastMeterUpdate = 0;
  const source = ctx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(ctx, "capture-processor");
  workletNode.port.onmessage = (e) => {
    if (performance.now() < suppressCaptureUntil) return; // ignore our own transmission -- see playPcm
    appendCaptureChunk(e.data);
    let sumSquares = 0;
    for (const v of e.data) {
      const a = Math.abs(v);
      if (a > meterPeak) meterPeak = a;
      sumSquares += v * v;
    }
    // Feed the adaptive squelch with this chunk's RMS, same signal (and
    // same per-callback cadence) the CLI's own Squelch::update is fed --
    // not the peak the level meter uses, which is spikier and less
    // representative of ongoing channel energy.
    if (e.data.length > 0) squelchUpdate(Math.sqrt(sumSquares / e.data.length));
    const now = performance.now();
    if (now - lastMeterUpdate >= MIC_METER_UPDATE_MS) {
      lastMeterUpdate = now;
      updateMicLevelDisplay(meterPeak);
      meterPeak = 0;
    }
  };
  source.connect(workletNode);

  pollTimer = setInterval(() => {
    if (captureLength === 0) return;
    if (captureLength > MAX_BUFFER_SECONDS * captureSampleRate) {
      // Reset every position-tracker this shared capture loop could be
      // feeding (normal listening's, calibrate-listen's), not just the
      // capture buffer itself -- whichever one is currently active,
      // leaving its scan position stale relative to the now-empty buffer
      // reproduces the exact bug this is fixing, just for that mode
      // instead.
      captureLength = 0;
      scanPos = { phone: 0, fast_air: 0 };
      scanStuckSince = { phone: null, fast_air: null };
      calibrateScanPos = new Map();
      calibrateStuckSince = new Map();
      return;
    }
    onPoll(normalizePeak(captureBuffer.subarray(0, captureLength)));
  }, POLL_INTERVAL_MS);
}

function stopCapture() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (workletNode) workletNode.port.onmessage = null;
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
  workletNode = null;
  mediaStream = null;
  captureLength = 0;
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

      // Same truncation-vs-corruption distinction pollCapture makes (see
      // its comments): a probe caught mid-transmission by a still-growing
      // buffer must hold and retry rather than being treated as a genuine
      // non-match and skipped past -- found live: without this, calibrate
      // routinely reported "no match" for candidates that were actually
      // fine, just caught mid-arrival, since this loop had no equivalent
      // of pollCapture's hold-and-retry and eagerly advanced past every
      // failed attempt regardless of cause.
      if (!frame.ok && TRUNCATION_REASONS.has(frame.reason)) {
        const stuckSince = calibrateStuckSince.get(key) ?? null;
        if (stuckSince === null) calibrateStuckSince.set(key, Date.now());
        if (Date.now() - (calibrateStuckSince.get(key) ?? Date.now()) < TRUNCATION_RETRY_TIMEOUT_MS) {
          break; // leave pos where it was, retry this exact position next poll
        }
        calibrateStuckSince.set(key, null);
      } else {
        calibrateStuckSince.set(key, null);
      }

      if (frame.ok && frame.text === code) {
        dbg("calibrate-match", key);
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
  calibrateStuckSince = new Map();
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
    showGate(); // username is never remembered across visits -- always start here
  } catch (e) {
    showFatalError("FAILED TO LOAD (WASM MODULE)", e);
  }
}

main();
