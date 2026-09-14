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

- **Username gate.** Required before the app is usable, stored locally.
  Sent on every frame of every message via a small envelope —
  `\x02<6-hex-char msg id>\x1F<username>\x03<text>` — so the receiving
  side sees a human name, not just a numeric SRC_ID (matters most for
  `group` mode, where several people share one channel).
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
    advancing, bounded by a 20s timeout so genuinely corrupted data still
    eventually gets reported rather than stalling forever. Verified with
    a full growing-buffer poll simulation against the compiled `.wasm`
    binary: 6 polls correctly wait, the 7th (once the transmission has
    fully arrived) decodes successfully.
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
  - **Mic level meter**, alongside the readout: a live peak-amplitude bar
    + dB readout, redrawn from every captured audio chunk. Added after
    live acoustic testing on real hardware where the send/receive
    pipeline was confirmed correct end-to-end but it was genuinely
    ambiguous whether a failed receive meant "mic hearing nothing" or
    "mic hearing something too quiet/unclean to demodulate" — this makes
    that distinction visible instead of needing an ad-hoc script to
    measure it.
- **Resend**, both directions:
  - A sent message always gets a local one-click resend (replays from
    its stored chunks/settings, no audio round trip needed).
  - A received message — complete or still incomplete — gets **request
    resend**, which transmits a `NackFrame` (see
    [`textovervoice-core`](https://github.com/SEKY443/textovervoice-core))
    naming its message id. The listen loop also polls `scan_for_nack`;
    hearing a NACK for a message id in this browser's own sent history
    triggers an automatic resend — no manual action needed on the
    sender's side, as long as it's listening.
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

GitHub Pages is live at `https://seky443.github.io/TOVChat.github.io/`
(Settings → Pages → "Build and deployment source: GitHub Actions" is
enabled) — a subpath, not the domain root, since the GitHub account is
`SEKY443` not `TOVChat`; all asset paths are relative, already accounting
for that. `.github/workflows/deploy.yml` builds the wasm module fresh and
redeploys on every push to `main`.

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
