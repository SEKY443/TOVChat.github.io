# TOVChat

A browser-based client for [TextOverVoice](https://github.com/SEKY443/CLI-TextOverVoice)
(text transport over voice-grade audio channels — phone calls / VoIP), built
as a static page for GitHub Pages: the modem/FEC/protocol/crypto core
compiles to WebAssembly, and the Web Audio API replaces the native `cpal`
audio I/O the CLI uses.

No backend server — encode/decode/send/receive all happen in the browser.

## Status

**Phase 1 (this commit): WASM build + offline encode/decode, validated.**
No UI yet — `www/index.html` is a bare functional test harness, not the
real design (that's still pending a visual-direction review, see below).

- [`wasm/`](wasm) — a `wasm-bindgen` crate exposing `encode_to_pcm`/
  `decode_from_pcm` (raw `f32` PCM in/out) over
  [`textovervoice-core`](https://github.com/SEKY443/textovervoice-core),
  the portable modem/FEC/protocol/crypto modules extracted from
  CLI-TextOverVoice. Mirrors CLI-TextOverVoice's `commands.rs` `encode`/
  `decode` functions closely, including their edge-case handling (rejecting
  `repeat=0`, rejecting oversized payloads before synthesizing audio,
  sanitizing non-finite samples, rejecting a degenerate sample rate) — just
  with WAV file I/O swapped for in-memory PCM, since that's what
  `AudioBuffer`/`AudioContext` deal in.
- Verified with a round-trip test suite (ASCII, multibyte/CJK/emoji +
  dictionary compression, addressing match/mismatch, encryption +
  wrong-key rejection, multi-frame reassembly, and clean-failure paths for
  noise-only and NaN-filled input) run against the actual compiled `.wasm`
  binary.

## What's next

Per the project brief (see `NEXT_AGENT_WEB_PROMPT.md`), still pending
before the real UI gets built:

1. **Resend-request protocol design** — a receiver needs to be able to ask
   a sender to resend a specific message *over the audio channel itself*
   (no server, no back-channel). Uses the wire format's already-reserved
   but currently-unused `NACK` code. Needs a proposal + sign-off before
   implementation.
2. **Visual design** — strictly black-and-white, Special Elite typeface,
   "looks crude but is actually carefully designed" telegraph/teletype
   aesthetic. 2-3 direction sketches to be reviewed before the real build.
3. Live mic/speaker I/O via `AudioWorkletNode` (currently only
   offline/file-based encode-decode is validated).
4. The real UI: send/listen, message history with resend, the bell sound
   on transfer complete (`bell_sound.wav`, CC0/public domain), real-time
   streaming decode display.
5. GitHub Pages deployment via Actions
   (`actions/upload-pages-artifact` + `actions/deploy-pages`). Note: this
   repo is served at `https://seky443.github.io/TOVChat.github.io/` (a
   subpath, not the domain root) since the GitHub account is `SEKY443`,
   not `TOVChat` — asset paths need to account for that.

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
