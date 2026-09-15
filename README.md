# Tovchat

A browser-based client for [TextOverVoice](https://github.com/SEKY443/CLI-TextOverVoice)
— text transport over voice-grade audio channels (phone calls / VoIP) — built
as a static page for GitHub Pages. No backend server: encoding, decoding,
sending, and receiving all happen in the browser.

Live at `https://seky443.github.io/TovChat/`.

## Relationship to TextOverVoice

TovChat is a browser port of
[CLI-TextOverVoice](https://github.com/SEKY443/CLI-TextOverVoice), built on
[textovervoice-core](https://github.com/SEKY443/textovervoice-core) — the
same modem/FEC/protocol/crypto core the CLI uses, compiled to WebAssembly
instead of running natively. The Web Audio API takes the place of the
native `cpal` audio I/O the CLI uses for capture and playback; everything
else (wire format, FEC, framing, crypto) is the same protocol the CLI
speaks, just with a browser front end instead of a terminal one.

## License

MIT, see [LICENSE](LICENSE). Same as CLI-TextOverVoice, copyright SEKY443.
