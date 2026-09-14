# TOVChat

A browser-based client for [TextOverVoice](https://github.com/SEKY443/CLI-TextOverVoice)
(text transport over voice-grade audio channels — phone calls / VoIP), built
as a static page for GitHub Pages: the modem/FEC/protocol/crypto core
compiles to WebAssembly, and the Web Audio API replaces the native `cpal`
audio I/O the CLI uses.

No backend server — encode/decode/send/receive all happen in the browser.

## Status

**Phase 1: WASM build + offline encode/decode, validated. Resend/NACK
protocol primitive: implemented and tested.** No UI yet — `www/index.html`
is a bare functional test harness, not the real design (that's still
pending a visual-direction review, see below).

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
- `build_nack_pcm`/`scan_for_nack` — a resend request ("please resend
  message X") as a real wire-level frame (`protocol::NackFrame` in
  textovervoice-core), not another ad-hoc text convention: a short
  RS-protected 5-byte header (`dest_id`, `src_id`, 3-byte target message
  id), distinguished from an ordinary data frame right after the preamble
  via `codes::FEC_SCHEME_ID_HI` (reserved for exactly this: "a future
  third frame format"). No payload, no dictionary/charset decode needed —
  much shorter and cheaper to recognize than a real message. Verified
  round-trip (including scanning past a preceding data frame to find a
  later NACK, and rejecting a malformed target id cleanly) against the
  compiled `.wasm` binary.

## What's next

Per the project brief (see `NEXT_AGENT_WEB_PROMPT.md`), still pending
before the real UI gets built:

1. **Visual design** — strictly black-and-white, Special Elite typeface,
   "looks crude but is actually carefully designed" telegraph/teletype
   aesthetic. 2-3 direction sketches to be reviewed before the real build.
2. Live mic/speaker I/O via `AudioWorkletNode` (currently only
   offline/file-based encode-decode is validated).
3. The real UI: send/listen, message history with resend, the bell sound
   on transfer complete (`bell_sound.wav`, CC0/public domain), real-time
   streaming decode display, and the send-side wiring for the NACK
   primitive above (per-frame message-id tagging on send, local resend
   history, auto-retransmit on hearing a known id) — deliberately left for
   the real UI/app-state work rather than bolted on ahead of the visual
   design.
4. GitHub Pages deployment via Actions
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
