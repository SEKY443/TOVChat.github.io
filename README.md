# Tovchat

A browser-based client for [TextOverVoice](https://github.com/SEKY443/CLI-TextOverVoice)
(text transport over voice-grade audio channels — phone calls / VoIP), built
as a static page for GitHub Pages: the modem/FEC/protocol/crypto core
compiles to WebAssembly, and the Web Audio API replaces the native `cpal`
audio I/O the CLI uses.

No backend server — encode/decode/send/receive all happen in the browser.

## Status

**The real site is built.** Strictly black-and-white, Special Elite
typeface, telegraph/teletype aesthetic: message history ("paper") on top,
a fixed inverted-black "machine" bar at the bottom holding the input and
typewriter-key-styled controls.

- **Username gate.** Required before the app is usable. Sent on every
  frame of every message via a small envelope —
  `\x02<6-hex-char msg id>\x1F<username>\x03<text>` — so the receiving
  side sees a human name, not just a numeric SRC_ID (matters most for
  `group` mode, where several people share one channel).
- **Nothing persists.** Username and message history live only in this
  tab's memory — closing or reloading the page loses both, and neither is
  ever written to `localStorage` (the only exception is the RETRIES
  device setting, a preference, not session content). The masthead's
  "▸ EXPORT" button is the only way to keep any of it: it downloads a
  JSON file (username, full history, an export timestamp) to the user's
  own device on demand — a real file save the browser handles, nothing
  sent anywhere. No import path back in yet; exporting is one-way.
- **Send.** Text is split into ≤700-character chunks, each tagged with
  the same message id + username, built into independently-addressed
  frames (`wasm/src/lib.rs`'s `encode_frames_to_pcm` — unlike
  `encode_to_pcm`, which hands one whole string to
  `message::build_message`'s own auto-splitter and would only tag frame
  0), and played through the Web Audio API.
- **Receive**, two ways, both ringing the bell
  (`bell_sound.wav`, CC0/public domain) only once a message actually
  decodes successfully — never on send, which just confirms audio played,
  not that anyone heard it:
  - **Live microphone** via an `AudioWorkletNode` (`capture-worklet.js`)
    forwarding raw samples to a polling loop — mirrors CLI-TextOverVoice's
    `live.rs` design (non-blocking audio callback pushes into a buffer, a
    separate loop does the expensive demodulation work). Polls with
    `scan_next_frame` (frame-at-a-time, not `decode_from_pcm`'s full
    reassembly) so the UI can show real incremental progress ("2 of 3
    frames") instead of only finding out once a message completes or
    times out, and reassembles in JS with the same algorithm as
    `MessageReassembler::add`. Tries both `phone` and `fast_air` timing
    each poll.

    **Found and fixed a real bug live-testing this against a real phone**:
    live polling scans a buffer that's still *growing* while a
    transmission is in flight, unlike `decode_from_pcm` scanning a fully-
    captured file in one shot. Catching a message mid-arrival produced a
    failure (`"payload extends past end of received data"`, etc. — exact
    strings confirmed by deliberately truncating a real encode and
    checking) that looked identical to genuine corruption, and the old
    code advanced past that position regardless — permanently skipping
    the message before the rest of it ever arrived, even though the same
    transmission recorded to a file and decoded via DECODE FROM FILE
    worked perfectly. Now those specific "ran out of real captured audio,
    not corrupted" reasons hold the scan position and retry instead of
    advancing, bounded by a timeout so genuinely corrupted data still
    eventually gets reported rather than stalling forever. Verified with
    a full growing-buffer poll simulation against the compiled `.wasm`
    binary: 6 polls correctly wait, the 7th (once the transmission has
    fully arrived) decodes successfully.

    **Second round, also found live**: the fix above worked once, then
    was unreliable on repeat sends. The retry set had included two
    *ambiguous* reasons (`"protected header FEC uncorrectable"`, the
    Legacy marker-not-found pair) that can also mean genuine corruption
    on complete data — and ambient noise occasionally triggers a false
    preamble match that fails with exactly one of these. Retrying those
    froze the scan position on the noise hit for the whole retry window,
    so a real transmission arriving during that window was missed
    entirely — silently, with no failure shown, since the code was still
    "waiting." Narrowed the retry set to only the reasons reachable *after*
    the header has already been successfully RS-corrected (meaning a
    real, synced transmission is definitely in progress, not noise) and
    extended the timeout to 120s now that it's provably safe to wait that
    long. The ambiguous ones revert to reporting immediately, accepting a
    narrow (~0.5–0.7s) window where a header genuinely split across a
    poll boundary might need a manual resend, in exchange for never
    blocking real signal detection on a noise blip again.

    **Third round, also found live**: still unreliable — worked several
    times, then failed again. Root cause: the captured buffer was never
    trimmed after a successful decode, only ever growing (up to a hard
    40s safety cap). Once that cap was hit, the code wiped the buffer but
    left `scanPos` (and the new `scanStuckSince`) pointing at a position
    from the old, now-discarded buffer — silently breaking all further
    detection, since every future poll starts scanning from a position
    the tiny fresh buffer hasn't grown long enough to even reach yet. Now
    the buffer resets (position trackers included) immediately after
    every successful decode, not just on overflow, so the cap becomes a
    true just-in-case fallback instead of something a real listening
    session routinely reaches. Verified with a full two-message session
    simulation against the compiled `.wasm` binary: message 1 decodes,
    the buffer is confirmed near-empty right after (not left growing),
    and message 2 — sent later in the same session — also decodes
    correctly, which is exactly the scenario the bug broke.

    **Fourth round**: after that fix, failures were finally genuine and
    visible instead of silent — the readout reported a real, repeated
    `"HEADER FEC: UNCORRECTABLE"`, specifically on the header, the very
    first thing sent right after the preamble. That points at something
    settling right at playback's *start* rather than a code bug: the
    `autoGainControl` enabled earlier adapting from silence to a loud
    tone, the speaker reaching steady output, room reflections
    stabilizing — all landing squarely on the header instead of later in
    the transmission. Added a 0.3s silent lead-in before every
    transmission (`playPcm`) so that settling happens before the header
    starts, not during it — safe to add since the receiver already
    tolerates arbitrary leading silence by design. This one is a
    hypothesis, not a proven root cause the way the previous three were
    (Node can confirm the receiver still decodes correctly with the added
    silence, which it does, but not whether it actually fixes real
    hardware timing — that needs another live test).

    **Fifth round**: after the tab-contamination bug (below) was fixed and
    testing resumed, `HEADER FEC: UNCORRECTABLE` remained the dominant
    failure most of the time. Root cause found by reading the wire format
    rather than more live trial and error:
    [`textovervoice-core`](https://github.com/SEKY443/textovervoice-core)'s
    `ProtectedHeader` format protects its 6-byte header with a *fixed* RS
    budget (`HEADER_PARITY_BYTES = 4`, correcting only 2 corrupted bytes)
    that never changes, while Calibrate mode's whole reason to exist is
    finding a payload `parity_bytes` (10/20/40) that survives this
    specific noisy channel. That meant Calibrate could hand back a payload
    setting well-protected enough to survive the channel, but the header
    riding in front of it stayed stuck at t=2 regardless — so on exactly
    the noisy channels Calibrate exists for, the header became the
    bottleneck and failed before the payload's own (now well-protected)
    FEC was ever exercised. Fixed at the core: raised `HEADER_PARITY_BYTES`
    (and the equivalent `NACK_PARITY_BYTES`) from 4 to 12, t=2 to t=6 — the
    header is only 6 bytes, so even a generous budget costs a handful of
    wire bytes per frame. `textovervoice-core`'s 117-test suite (widened
    two corruption-budget tests to still exceed the new, larger budget)
    confirms the stronger header still round-trips cleanly and still fails
    cleanly — never silently wrong — beyond it. This one is fully proven
    at the protocol level, not a live-only hypothesis — but like every
    wire-format change in this project, it still needs a real acoustic
    retest to confirm it actually moves the needle on real hardware.

    **Sixth round, and the actual root cause**: raising the header's FEC
    budget didn't help — `HEADER FEC: UNCORRECTABLE` kept appearing almost
    every send. Rather than keep guessing at the acoustic layer, a
    temporary `window.__tovDiag` hook was added to pull the *exact* raw
    PCM a failing live session had captured out of the browser (as a WAV
    download) for offline analysis against the compiled core directly.
    Decoding that captured audio standalone — the identical
    `find_preamble` → `demodulate` → `parse_frame` pipeline
    `scan_next_frame` uses, just run natively instead of through wasm —
    decoded it perfectly. The signal was never bad. The bug was in
    [`textovervoice-core`](https://github.com/SEKY443/textovervoice-core)'s
    error reporting: `read_protected_header` returned the same `None` (and
    therefore the same `"protected header FEC uncorrectable"` string) both
    when a complete header failed RS correction *and* when the reader
    simply ran out of tokens because a live capture buffer, still growing
    mid-transmission, hadn't reached the end of the header yet. Every
    other frame region (payload/parity/CRC) already reports its own
    distinct `"unexpected end of frame reading ..."` for exactly this
    ambiguity — the header was the one region that never got it. Since
    `app.js`'s `TRUNCATION_REASONS` set (the "hold and retry instead of
    reporting a hard failure" list — see the first round above)
    deliberately excluded `"protected header FEC uncorrectable"` as
    ambiguous, a header caught mid-arrival was reported as a hard failure
    and the scanner permanently skipped past it — even though the rest of
    that same transmission's audio arrived moments later and would have
    decoded cleanly, exactly as the offline replay proved.

    Fixed by giving the header its own truncation-vs-corruption
    distinction: `read_protected_header` now returns a `HeaderRead` enum
    (`Ok`/`Truncated`/`Uncorrectable`) instead of collapsing both failure
    modes into `Option::None`, so a truncated read reports the new, exact
    `"unexpected end of frame reading protected header"` — safe to add to
    `TRUNCATION_REASONS` since (unlike the RS-failure case) it's a pure
    "not enough buffered audio yet" fact, never reachable from a complete-
    but-corrupt header. `protected header FEC uncorrectable` itself stays
    excluded, still correctly ambiguous. Verified two ways against the
    compiled core: a new unit test asserts the two cases now produce
    different reasons from the same frame (one truncated, one corrupted);
    and, more concretely, feeding the decoder a version of the *actual
    failing user's captured audio* truncated to stop mid-header reproduces
    the exact new reason string, while the full, untruncated capture
    decodes the message correctly — closing the loop from a real reported
    failure to a proven, targeted fix.

    **Automated acoustic self-test, post-fix**: rather than rely solely on
    another round of phone-in-hand testing, five messages spanning the
    format's edge cases (a short word, a full sentence, CJK text, emoji,
    and a longer message forcing more than one RS block) were synthesized
    to real PCM with the compiled core, played through this machine's own
    speaker, and picked up by the deployed site's real microphone input —
    an actual acoustic round trip, not a loopback shortcut. All five
    decoded correctly. The longer message's *first* attempt appeared to
    hang with no result — traced to the browser tab being backgrounded
    (this machine's display went to sleep mid-test), which Chrome
    throttles `setInterval` polling under; the queued polls caught up and
    decoded correctly the moment the tab was active again, confirming the
    truncation-retry logic tolerates irregular poll timing correctly, not
    just the nominal 1.2s cadence.
  - **File upload**, for testing without two devices/a real acoustic
    path.
  - **Real-time decode readout**, shown above the input while LISTEN is
    active: a typewriter-style reveal of each incoming frame's text as it
    decodes, plus the FEC/CRC (and decrypt, if a frame turns out to be
    encrypted) outcome for *every* frame attempt — success or failure —
    not just the final message. Reuses `scan_next_frame`'s `reason`
    string (exact strings from `protocol.rs`'s `ParseResult::fail`/
    `fail_with`) to distinguish a genuine corrupted-frame attempt (FEC
    uncorrectable, CRC mismatch, encrypted-with-no-key) from a preamble
    false-triggering on plain noise, so it doesn't flash false alarms
    during ordinary idle listening. A message-complete hold and a
    failure flash share one timer rather than two independent ones —
    found and fixed a real race live-testing this: two separate timers
    let a completion's reset fire mid-flash and cut a later failure
    notice short.

    **Found live, again, after adding the binary-flicker decode
    animation**: the readout would reliably go blank partway through any
    message longer than a few characters, looking like it had just
    stopped. Cause: `onLiveMessageComplete` fired (and started its
    `LIVE_DECODE_COMPLETE_HOLD_MS` reset timer) the *instant* the
    underlying frame decoded, not once the on-screen reveal actually
    caught up to it -- fine when the reveal was a fast plain typewriter,
    but once the flicker made a full reveal take several seconds for
    anything but a short message, the 2s hold routinely elapsed and
    wiped the box (`resetLiveDecode`) while the animation was still
    mid-flicker. Fixed by chaining the completion callback onto the
    reveal's own end (`typewriterReveal`'s `onDone`, only invoked once
    the loop reaches the real end of the text, not when superseded by a
    newer one) instead of firing it independently. The FEC/CRC
    confirmation moved with it: showing `[FEC ✓] [CRC ✓]` the moment a
    frame decoded was technically true (the wasm side can't hand back a
    frame that hasn't already fully passed both) but misleadingly early
    against what the user watching the reveal has actually seen happen
    yet — the checkmarks now appear together with "MESSAGE COMPLETE"
    only once the reveal itself finishes, so the readout tells one
    coherent story end to end: raw bits flickering into letters, then,
    once the text is fully there, the verification it already passed.
  - **Mic level meter**, alongside the readout: a live peak-amplitude bar
    + dB readout, redrawn from every captured audio chunk. Added after
    live acoustic testing on real hardware where the send/receive
    pipeline was confirmed correct end-to-end but it was genuinely
    ambiguous whether a failed receive meant "mic hearing nothing" or
    "mic hearing something too quiet/unclean to demodulate" — this makes
    that distinction visible instead of needing an ad-hoc script to
    measure it.

    **Found live: the readout wasn't actually real-time.** The binary-
    flicker animation above played out over a fixed timer *after* a whole
    frame had already fully decoded (FEC-corrected, CRC-verified) — a
    polished-looking but entirely fake simulation of "watching it decode,"
    not a report of what was actually happening to the signal as it
    arrived. Digging into the actual
    [CLI-TextOverVoice](https://github.com/SEKY443/CLI-TextOverVoice)
    reference implementation (`live.rs`) confirmed the CLI has the same
    limitation — it's poll-and-retry against a growing buffer, not true
    per-symbol streaming — so there was nothing to port; this needed a
    real new capability. `textovervoice-core` gained
    `preview_frame_protected`: once a frame's small RS-protected header
    has resolved (fast — a handful of symbols), it decodes whatever raw
    payload bytes have arrived *so far* directly, skipping FEC correction
    and CRC verification entirely. This works because the RS coding here
    is systematic (data bytes travel as-is; parity is appended
    separately, never mixed in) — on a clean channel the raw bytes already
    equal what the real, verified decode will eventually produce, so this
    preview is usually correct *immediately*, not simulated. The wasm
    layer exposes it as `preview_frame`, called every poll (alongside, not
    instead of, `scan_next_frame`) at the same scan position — new
    characters appear the moment they're actually demodulated from a
    still-growing buffer, not once an artificial timer elapses.

    Because this preview is explicitly non-authoritative, the readout now
    tells the honest version of the story: the flicker plays out on
    whatever's newly arrived each poll, and once a frame's real,
    FEC/CRC-verified result lands, it's diffed against what was tentatively
    shown — if they match, nothing visible changes; if a genuine channel
    error made the preview guess wrong somewhere, that's exactly where the
    correction re-flickers from, resolving into the real text instead of
    silently snapping to it. This is the literal answer to "if it's wrong
    and CRC fixes it, show that too."
- **Ack redesign**: the delivery-confirmation ack used to be its own
  binary wire frame (`AckFrame`, mirroring `NackFrame`'s RS-protected
  5-byte header) — but checking the actual CLI-TextOverVoice reference
  implementation (`chat.rs`) showed its real ack mechanism is much
  lighter: an ordinary short text message, tagged with the id being
  confirmed, sent through the exact same encode/decode pipeline as any
  other frame (the reserved `codes::ACK`/`NACK` wire values the CLI
  defines are never actually used for this). `AckFrame` is gone from
  `textovervoice-core` entirely; an ack here is now just the real ASCII
  ACK control byte (`0x06`, not the CLI's spelled-out `"ACK:"` text)
  followed by the message id — e.g. `\x06d944b5` — built and recognized
  directly by the JS app (`sendAckFor`/`handleDecodedFrame`) using the
  same `encode_frames_to_pcm`/`scan_next_frame` path an ordinary message
  uses. Shorter on the wire, less code, and consistent with how the
  reference implementation actually solves this.

  **Found live: the readout could get stuck showing doubled text.**
  `ensureLiveDecodeTracking` only reset the box's state when a frame's
  message id differed from whatever it was already tracking — reasonable
  for ordinary growth (a multi-frame message's later frames share the
  first frame's id on purpose), but wrong for a *resend*: if the sender's
  ack was lost and it resent the same message while the receiver's box
  was still in its post-completion hold (showing "MESSAGE COMPLETE" for
  that same id), the id check saw no difference and treated the resend as
  a continuation — appending its text onto the already-complete text
  instead of starting over. Worse, because a resend is a duplicate for
  chat-history purposes, the box's own completion callback used to be
  skipped for it too, so nothing ever rescheduled the reset — the box
  stayed stuck on that doubled text until some unrelated later message
  came along. Now the box tracks whether its current id already completed
  once, and treats a same-id arrival after that as a new transmission
  event (reset first, then fill in) — while the live box's own
  complete/reset cycle always runs on a real confirmed result, whether or
  not that result happens to be a duplicate for the chat history.
- **Resend**, three ways:
  - A sent message always gets a local one-click resend (replays from
    its stored chunks/settings, no audio round trip needed).
  - A received message — complete or still incomplete — gets **request
    resend**, which transmits a `NackFrame` (see
    [`textovervoice-core`](https://github.com/SEKY443/textovervoice-core))
    naming its message id. The listen loop also polls `scan_for_nack`;
    hearing a NACK for a message id in this browser's own sent history
    triggers an automatic resend — no manual action needed on the
    sender's side, as long as it's listening. This needs the receiver to
    already have decoded *something* (to know a message id exists to ask
    for) — no help when nothing decoded at all, which is exactly when a
    resend matters most. **Automatic delivery retry** (below) fixes that
    by having the sender drive retry instead.
  - **Automatic delivery retry**: sending a message starts a retry cycle
    — listen for a short ack (the real ASCII ACK control byte, `0x06`,
    plus the message id, sent as an ordinary tagged frame — see "Ack
    redesign" below) naming that message's id, and if none arrives within
    a grace period after the message finishes playing, resend
    automatically. Unlike request-resend, this needs nothing from
    the receiver but successfully decoding and sending back one short ack
    — works even when the *first* attempt was never heard at all. Every
    successful `handleDecodedFrame` completion now fires one of these
    back automatically. Retry count is user-configurable (the machine
    bar's "RETRIES" field, default 3, persisted); an in-progress retry
    shows live status (`AWAITING ACK` → `RESENDING (n/N)` →
    `✓ DELIVERED` or `✕ UNDELIVERED`) and can be cancelled early with
    STOP. In-memory only — a page reload doesn't resume a retry cycle
    from before it, same tradeoff as the rest of this app's live-session
    state.

    **Found live, running an actual back-and-forth conversation between
    two tabs**: replying quickly to a message that had just arrived
    reliably left the *original* message UNDELIVERED and the reply itself
    never arrived either. Cause: `sendAckFor` (fired, not awaited, from
    `handleDecodedFrame`) and the reply's own `sendMessage` both call
    `playPcm` independently: with nothing serializing them, their two
    `AudioBufferSourceNode`s played concurrently on the same
    `AudioContext`, mixing both signals together acoustically and
    corrupting both — the ack never decoded on the sender's end (a
    correct, if confusing, `UNDELIVERED`, since it genuinely never heard
    one), and the reply never decoded on the receiver's end either. Fixed
    by giving `playPcm` a queue: every call chains onto the previous one
    and only starts once it finishes, so "one clip plays at a time" holds
    regardless of how many places call it or whether the caller awaits
    the result. Verified by replaying the same conversation after the
    fix — rapid back-to-back replies now both deliver cleanly.

    That queue only serializes *this device's own* sends against each
    other, though — it can't stop a *different* device's speaker from
    playing at the same real-world moment, a separate `AudioContext`
    entirely. **Collision avoidance, CSMA/CA-style**, closes that gap:
    before any clip starts playing, if this device is listening, it
    checks the live mic level (already tracked for the level meter) and,
    if the channel currently reads busy, waits a randomized interval and
    re-checks — the same carrier-sense-then-random-backoff shape real
    network collision avoidance uses — instead of transmitting blind into
    whatever the channel is doing. Gives up and sends anyway after a
    bounded wait rather than potentially waiting forever. A device that
    isn't listening has no mic level to check and transmits blind, same
    as always.

    **Also found live, with more than two listening devices**: several
    receivers can finish decoding the *same* broadcast frame at
    essentially the same instant and each independently send its ack back
    — and the busy-wait above didn't stop them from colliding, because it
    only ever defers when it *already* detects energy on the channel: at
    the moment every ack-sender checks, the channel genuinely is still
    idle, so the old fast path returned immediately with no delay at all
    and all of them transmitted in the same instant anyway. Real CSMA/CA
    (802.11 DCF) doesn't skip contention just because the channel is idle
    either, for exactly this reason — it always makes a station wait a
    random backoff before transmitting, idle or not. `waitForClearChannel`
    now does the same: even once the channel reads clear, it waits a
    short mandatory random jitter and re-checks before actually
    transmitting, looping back into the busy-wait if someone else keyed up
    during that jitter — so multiple devices all finding the channel idle
    at the same moment get staggered instead of firing together.

    **Busy detection itself switched from a fixed threshold to an adaptive
    squelch**, ported directly from CLI-TextOverVoice's `live.rs`
    `Squelch` (checked the actual reference implementation rather than
    picking a number by feel): a fast-moving RMS estimate against a
    slow-moving ambient-noise floor, "busy" once the fast estimate sits
    well above that floor, the floor itself only updating while the
    channel currently reads quiet (so a loud, sustained transmission can't
    drag its own floor up and eventually stop looking busy). A single
    fixed amplitude can't be right in every room — a loud environment's
    ordinary background noise can sit above a quiet room's real signal —
    so this tracks each device's own actual surroundings instead of
    guessing at one number for all of them.

    **Found live, and it was a real bug, not just a mirrored one**: the
    port above is faithful to the CLI's actual `Squelch::update`, but that
    reference implementation has a genuine bootstrap bug that its own test
    suite happens not to exercise. Both `fast` and `floor` start at 0, and
    the floor only ever updates while the *current* reading looks "not
    busy" against the *current* floor — so if the very first real ambient
    reading is already louder than the tiny `MIN_FLOOR` bootstrap value
    times the busy multiplier (about -54dBFS, quieter than almost any real
    room's actual noise floor), that first reading gets judged busy against
    a floor that never got a chance to calibrate, so the floor never
    updates, so the channel reads permanently busy from the moment LISTEN
    turns on — confirmed directly: feeding a steady, realistic ambient RMS
    of 0.01 (-40dBFS, an ordinary quiet room) through the unmodified port
    leaves the floor at exactly 0 and `is_busy()` permanently `true` after
    300 updates. In practice this meant `waitForClearChannel` always ran
    out its full `CARRIER_SENSE_MAX_WAIT_MS` and transmitted blind
    regardless of what was actually on the channel — collision avoidance
    that never actually avoided anything, which is exactly what it looked
    like live: an ack colliding with a real ongoing transmission it should
    have waited out. Fixed by seeding the floor directly from the first
    real reading instead of 0 — there's no prior estimate to protect on
    that first sample anyway — with every reading after that going through
    the normal gated EMA unchanged. Verified with the same synthetic
    sequence: ambient calibrates correctly (`busy: false`), a real burst is
    still detected (`busy: true`), and it recovers cleanly once the burst
    ends.

    **Found live again, right after the fix above**: acks were still
    colliding with a genuinely ongoing transmission — this time the squelch
    itself was correctly reporting busy the whole time, but
    `CARRIER_SENSE_MAX_WAIT_MS` was only 4s, and this app's own logging
    elsewhere had already directly measured real phone-mode transmissions
    taking 9–33+ seconds. A channel legitimately busy with one ordinary
    message routinely stays busy well past 4s of *correct* busy readings,
    so the "give up and transmit anyway" safety fallback — meant to catch a
    genuinely stuck squelch — was instead routinely firing in the middle of
    a real, still-arriving message. Raised to 60s: comfortably past any
    realistic single message's duration, the same "how long can a real
    transmission legitimately take" reasoning `TRUNCATION_RETRY_TIMEOUT_MS`
    below already uses.

    **Found live yet again — the squelch's calibration itself was still
    wrong, twice over.** With a 60s ceiling now in place to catch a
    genuinely stuck reading, a *stuck* reading became visible for what it
    was: the channel reading busy almost continuously, acks essentially
    never actually getting sent. Two compounding bugs, both caught by
    simulation before touching a real device again:
    1. The first bootstrap fix seeded the floor from just the *one* very
       first reading. A single ~10–20ms chunk is a noisy sample of a real
       room — if it happens to land during an anomalously quiet instant,
       the floor seeds too low, and ordinary ambient fluctuation
       afterward routinely reads 4x above it: "busy" most of the time,
       just not absolutely permanently anymore.
    2. The next attempt averaged the first 20 readings into the floor
       instead — but used the same slow `SQUELCH_FLOOR_ALPHA` (0.01)
       steady-state relies on, which is deliberately slow so a real
       transmission can't drag the floor up mid-message. That same
       slowness means it barely moves within only 20 samples either —
       floor ends up nowhere near the true ambient level, right back to
       "busy" almost always, just with a nonzero floor instead of zero.

    Fixed by giving the bootstrap phase its own true running mean (exact
    average of the first 20 readings, not an exponentially slow crawl
    toward it) for the one-time "what does this room actually sound like"
    question, only switching to the slow gated EMA once that's
    established. Verified with simulation across steady ambient, noisy/
    bursty ambient (random 0.005–0.02 RMS, standing in for real-world
    AGC jitter), and an anomalous first sample — all correctly read
    clear; a real burst is still correctly detected busy, and recovers
    cleanly once it ends. Also added periodic (not one-shot) busy-state
    logging (`[TOV:carrier-busy]`, every ~1s while waiting) so a real
    session's console shows a time series of fast/floor/threshold instead
    of a single snapshot from the moment the wait started — the fast/
    floor/threshold numbers a next report like this needs, without
    another guess-and-redeploy cycle.

    **Found live yet again: a send still collided with an incoming ack.**
    With the floor now calibrating correctly, this pointed at raw
    sensitivity, not calibration — the CLI's own 4.0x busy ratio (ported
    faithfully) isn't necessarily tuned for a relatively quiet real signal
    picked up from across a room, like an ack's own transmission volume
    against a nearby full data frame's. Two changes together:
    1. Lowered `SQUELCH_BUSY_MULTIPLIER` to 2.0x — verified by simulation
       this stays at essentially zero false positives (0–1 per 300
       samples, even under deliberately extreme synthetic ambient jitter
       standing in for real-world AGC pumping) while correctly catching a
       signal only ~2.2x louder than ambient that 4.0x missed entirely.
    2. Added a second, independent busy signal alongside the squelch:
       `channelLooksBusy()` now also treats the channel as busy whenever
       `pollCapture` is currently holding position on a real,
       already-preamble-and-header-verified frame that just hasn't fully
       arrived yet (`scanStuckSince`, the same state the truncation-retry
       logic already tracks). Once this device has actually demodulated a
       valid preamble and header for something, that is a far more
       reliable "someone is transmitting to me right now" signal than any
       amplitude threshold can be — it isn't fooled by ambient loudness or
       AGC in either direction, because it's driven by real protocol
       state, not a guess about what counts as "loud enough."

    **Found live with a third device**: even with the jitter fix above,
    testing with three tabs (one sender, two receivers both decoding the
    same broadcast) still occasionally triggered an unneeded resend.
    Cause: `RETRY_ACK_GRACE_MS` was tuned before contention jitter
    existed, and never accounted for it — with two receivers deliberately
    staggering their acks against each other, the genuinely-successful
    round trip can now take noticeably longer than before, and the old
    grace period didn't leave room for that extra, intentional delay.
    Raised from 10s to 14s to cover it.

    **Also found live**: replying quickly still sometimes rang the bell
    twice for what was clearly one message. Cause: `RETRY_ACK_GRACE_MS`
    (6s) was tight enough that a completely successful delivery could
    still occasionally outrun it — poll latency both ways, decode time,
    and now carrier-sense waiting all eat into that budget — triggering
    an unneeded resend that the receiver then decoded a second time,
    correctly ringing the bell again for what it had no way to know was a
    duplicate. Fixed on both ends: the grace period is more generous
    (10s), and `handleDecodedFrame` now tracks which message ids it's
    already fully received, so a redundant resend still gets re-acked
    (the sender genuinely needs to hear that) but doesn't re-announce
    itself to the user.
- **Calibrate** (the machine bar's "▸ CALIBRATE" link) — mirrors the CLI's
  `calibrate-send`/`calibrate-listen`: find which `(mode, parity_bytes)`
  setting(s) actually survive this specific real channel, instead of
  guessing one and hoping. Required exposing `parity_bytes` as a real
  parameter on `encode_to_pcm`/`encode_frames_to_pcm`/`decode_from_pcm`/
  `scan_next_frame` (it had been hardcoded to the default everywhere) —
  every one of the 6 candidates `chat.rs`'s adaptive ladder can reach
  (`phone`/`fast_air` × parity 40/20/10, most robust first) is a real,
  independently addressable setting now, not just a mode toggle. SEND
  PROBES transmits a known code under all 6 in turn; LISTEN FOR PROBES
  scans incoming audio under all 6 in parallel (each with its own scan
  cursor) and reports which one(s) produced an exact match. Verified live
  in a real browser: full probe-send sequence (progress through all 6,
  correct status/disabled-state transitions), and confirmed the
  discrimination property itself — a probe encoded under one setting does
  not falsely match when scanned under a different one — via the
  compiled `.wasm` binary directly.

  **Found live, after the above was already working**: calibrate reported
  "no match" for candidates that were actually fine, just caught
  mid-transmission by a still-growing buffer. `pollCapture` (ordinary
  chat) already holds and retries a frame caught this way instead of
  reporting a hard failure and skipping past it (see the sixth
  acoustic-debugging round below); `pollCalibrateCapture` had no
  equivalent and eagerly advanced past every failed attempt regardless of
  cause. Now shares the same `TRUNCATION_REASONS` hold-and-retry logic,
  keyed per candidate instead of per mode.
- **Decode flicker, real-time preview box only**: the character flicker
  (scrambled guesses → real byte code → resolved letter) used to replay a
  second time on a received message's finished chat bubble, on top of
  already having played once in the live-decode preview box moments
  earlier — repeating, with extra delay, something the user had just
  watched happen. A message in history is just history now: its bubble
  renders the text immediately, no animation. The flicker itself belongs
  to the live-decode box alone.

  **Found live sending Chinese text**: the flicker's "real bits" step
  used `codePointAt(0) & 0xff` — the code point's low byte — which is a
  correct 8-bit code for ASCII/Latin-1 but silently discards everything
  above 0xFF for anything wider, so a CJK character's "decode" flickered
  through a value with no relationship to the character at all. Now it
  encodes the character to its real UTF-8 bytes and, for anything wider
  than one byte, shows the actual hex bytes joined by `-` (the same role
  UTF-8's own continuation-byte marker plays) and capped with `×` once
  the sequence for that character is complete — e.g. 漢 flickers through
  `E6-BC-A2×` before resolving. ASCII is unchanged (still 8-bit binary).
  Still not a literal reconstruction of this app's actual wire bytes
  (those depend on charset/dictionary compression this layer doesn't have
  visibility into) — but now an honest encoding of the character itself
  instead of a value with no meaning.

- **Self-hearing, found live**: a device with LISTEN on while it also
  sends — completely normal single-device usage, not just the two-tab
  test below — had its own mic pick up its own speaker's output,
  acoustically coupled on the same machine, and "receive" its own
  transmission back as if it were incoming. `playPcm` is the one choke
  point every send path goes through (message send, resend, calibrate
  probes, an automatic NACK/ack-triggered resend), so it now suppresses
  the capture buffer for the duration of playback plus a short
  reverb-decay tail, rather than patching each call site separately.
- **Live text reveal**: a received message's chat bubble now types its
  text in character by character as it's decoded (or as each frame of a
  multi-frame message arrives), reusing the same reveal timing the
  real-time decode readout box already used, instead of the text just
  appearing fully formed the instant a frame completes. History loaded
  from storage on page load is seeded as already-fully-revealed so a
  reload never replays the animation for old messages. Refined per
  feedback: each character now flickers through a couple of scrambled
  8-bit binary guesses, settles on its real 8-bit code, then resolves
  into the actual letter — raw data to letters to words, leaning into
  the modem/teletype theme instead of just typing in plainly. Shared
  (`flickerInChar`) between this and the live-decode preview box so both
  reveals look and feel the same. Not a literal reconstruction of this
  app's actual wire bytes (those depend on charset/dictionary compression
  this layer doesn't have visibility into) — a plausible-looking flicker
  in service of the effect, not a debugging tool.

- **Sending required the mic to already be on, found live**: delivery
  tracking (the ack/retry cycle every send with `maxRetries > 0` enters)
  is useless without the mic actually running — an ack is just another
  incoming frame, and nothing decodes incoming frames unless `listening`
  is on and `pollCapture` is polling. A message sent without ever having
  clicked LISTEN sat "AWAITING ACK" forever no matter how cleanly the
  other side received and acked it, since this device was never listening
  for the answer — a UI gap the app never explained. `sendMessage` now
  starts listening automatically (same as clicking LISTEN) before it
  hands a message off to delivery tracking, if it isn't listening
  already; falls through and sends anyway if the mic is
  unavailable/denied, same as before this existed.
- **Capture buffer performance**: every poll tick re-concatenated the
  *entire* captured-so-far buffer from scratch into a fresh
  `Float32Array` — O(already-captured length) work, every 1.2s, for the
  whole lifetime of a listening session, at the browser's native sample
  rate (44.1–48kHz, not the modem's 8kHz), up to `MAX_BUFFER_SECONDS`
  worth — a buffer nearing that cap was being fully re-copied (roughly 2
  million samples) on every poll for no reason, since almost none of it
  had changed since the last one. Replaced with a persistent buffer that
  grows in place (doubling capacity only when it actually runs out of
  room) and hands each poll a zero-copy `subarray` view of what's been
  captured so far — poll cost now scales with what's new since last time,
  not with everything captured since LISTEN was turned on.

Verified live against the deployed site in a real browser (Chrome):
username gate, send (real speaker playback, history rendering), local
resend, mode toggle, and file-based decode (uploaded a real generated
WAV, decoded end-to-end with the correct username/id/text, bell ringing
on that successful decode, and a working request-resend affordance).
Also caught and fixed a real bug
this way that no amount of Node-level testing could have: `.gate` and
`.screen` both set `display: flex` unconditionally, which silently beat
the `hidden` attribute's implicit `display: none` (an attribute selector
has far lower CSS specificity than any class rule) — the app was
rendering correctly underneath the whole time, the gate just never
visually got out of the way after BEGIN. Below that layer, every
wasm-bindgen primitive is round-trip tested against the actual compiled
`.wasm` binary (see `wasm/src/lib.rs`'s doc comments).

**Not yet confirmed: a real microphone/speaker acoustic round trip.**
Getting a mic-permission grant through requires a real user action on a
real OS permission dialog (outside what any automation can click through
on its own) — live capture wiring (`AudioWorkletNode`, the polling loop)
is careful but unexercised beyond that.

v1 deliberately does not include: addressing/contacts UI, encryption key
exchange UX. Broadcast + unencrypted only for now — the username envelope
is the "who's this from" mechanism in the meantime.

## Performance

**Found live: severely poor performance on a real phone.** Every per-poll
wasm call while listening (`preview_frame` and `scan_next_frame` — once
each per mode — plus `scan_for_nack`) does work that scales with the
captured buffer's sample count, and the whole capture pipeline was running
at the browser's native `AudioContext` rate — 44100 or 48000Hz on
virtually every real device. Every modem tone this protocol uses lives
inside the 300–3400Hz telephone voice band (see
[`textovervoice-core`](https://github.com/SEKY443/textovervoice-core)'s
`modem.rs`), and the wire format is itself designed natively around
8000Hz (`modem::SR`) — capturing at native rate was processing 3–6x more
samples than the signal has any real content in, multiplying every one of
those costs for zero benefit. A much bigger hit on a phone's weaker CPU
than it ever looked like on a desktop testing it. Now requests the
context at 16000Hz — not 8000Hz (`modem::SR`) exactly, to keep a
comfortable 2x safety margin above the highest tone (8000Hz Nyquist vs. a
3400Hz ceiling), since a real anti-aliasing filter isn't perfectly
brick-wall and this is capture, not the wire format itself. Playback is
unaffected — `playPcm` already builds its buffer at the modem's own SR
(8000) explicitly, and Web Audio resamples on output regardless of what
rate the context runs at.

On top of that, two per-poll costs that don't need to run on literally
every single poll to still feel responsive are now throttled: the
real-time preview (`updateLivePreview`, which redoes the full demodulation
`scan_next_frame` is about to redo again right after it) to every 2nd
poll, and the NACK scan (`scan_for_nack`, which rescans the *entire*
buffer every time it runs, not just the unscanned tail — a rare,
user-initiated request, not the hot path) to every 3rd poll. The frame-
completion scan itself (`scan_next_frame`'s own loop) is untouched and
still runs every poll — throttling the thing actual message latency and
reliability depend on wasn't on the table.

## What's next

1. **Validate a real microphone/speaker acoustic round trip** — grant mic
   access when prompted and try sending between two tabs/devices.
2. Addressing/contacts UI, encryption key exchange UX — each needs its
   own UX design before it's worth building.

GitHub Pages is live at `https://seky443.github.io/TovChat/`
(Settings → Pages → "Build and deployment source: GitHub Actions" is
enabled) — a subpath, not the domain root, since the GitHub account is
`SEKY443` not `TovChat`; all asset paths are relative, already accounting
for that. `.github/workflows/deploy.yml` builds the wasm module fresh and
redeploys on every push to `main`.

## Debugging

`app.js` logs its internal lifecycle to the browser console, always on --
open DevTools (F12) → Console and filter for `[TOV` to see it without the
usual noise of scanning-and-finding-nothing that fires every ~1.2s while
idle. Covers: every frame scan attempt (`[TOV:scan]`, mode/position/
ok-or-reason), truncation hold-and-retry (`[TOV:hold]`), a completed
message (`[TOV:complete]`, including whether it was a fresh decode or a
duplicate resend), acks and nacks sent/received
(`[TOV:ack-sent]`/`[TOV:ack-recv]`/`[TOV:nack-recv]`), the delivery retry
cycle (`[TOV:retry]`/`[TOV:delivered]`/`[TOV:undelivered]`), collision
avoidance (`[TOV:carrier-busy]`/`[TOV:carrier-clear]`), the live-decode
reveal's own timing (`[TOV:reveal-start]`/`[TOV:reveal-done]`/
`[TOV:reveal-superseded]`), a send (`[TOV:send]`), and a calibrate match
(`[TOV:calibrate-match]`). Meant to make a real acoustic session
verifiable from the actual internal state and its timing, not just by
watching the screen and hoping a screenshot lands at the right moment.

## Building locally

```sh
cd wasm
wasm-pack build --target web --out-dir ../www/pkg
cd ../www
python3 -m http.server 8000   # or any static file server
```

Then open `http://localhost:8000/` — an ES module served over `file://`
won't work, it needs real HTTP.

## License

MIT, see [LICENSE](LICENSE). Same as CLI-TextOverVoice, copyright SEKY443.
