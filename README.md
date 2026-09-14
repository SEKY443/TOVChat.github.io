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
    — listen for a new `AckFrame` (mirrors `NackFrame`'s wire structure;
    see `textovervoice-core`) naming that message's id, and if none
    arrives within a grace period after the message finishes playing,
    resend automatically. Unlike request-resend, this needs nothing from
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
