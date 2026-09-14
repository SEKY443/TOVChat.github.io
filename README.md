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
  0), and played through the Web Audio API. Bell sound
  (`bell_sound.wav`, CC0/public domain) rings once playback completes.
- **Receive**, two ways:
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
  - **File upload**, for testing without two devices/a real acoustic
    path.
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

Verified as far as it can be without a live browser this session: every
wasm-bindgen primitive round-trip tested against the actual compiled
`.wasm` binary (see `wasm/src/lib.rs`'s doc comments), all JS syntax-
checked, all asset paths confirmed relative (needed for the
`/TOVChat.github.io/` subpath GitHub Pages serves this repo at — see
below) and resolving over a local static server. **Not yet confirmed
against a real microphone/speaker round trip** — needs a real browser
session to validate, unlike everything upstream of it which was checked
via Node against the compiled wasm directly.

v1 deliberately does not include: addressing/contacts UI, encryption key
exchange UX, `calibrate` mode. Broadcast + unencrypted only for now — the
username envelope is the "who's this from" mechanism in the meantime.

## What's next

1. **Validate live mic/speaker round trip** in a real browser — the one
   piece that couldn't be checked without one.
2. GitHub Pages: enable it once in this repo's Settings → Pages → "Build
   and deployment source: GitHub Actions" (one-time manual step, can't be
   done via git). The deploy workflow
   (`.github/workflows/deploy.yml`) builds the wasm module fresh and
   publishes `www/` via `actions/upload-pages-artifact` +
   `actions/deploy-pages` on every push to `main`. Served at
   `https://seky443.github.io/TOVChat.github.io/` (a subpath, not the
   domain root, since the GitHub account is `SEKY443` not `TOVChat`) —
   all asset paths are relative, already accounting for that.
3. Addressing/contacts UI, encryption key exchange UX, `calibrate` mode —
   each needs its own UX design before it's worth building.

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
