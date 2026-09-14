//! wasm-bindgen glue exposing textovervoice-core's encode/decode pipeline
//! as raw PCM in/out, for driving via the Web Audio API instead of WAV
//! files on disk. Mirrors CLI-TextOverVoice's `src/commands.rs` (`encode`/
//! `decode`) as closely as possible -- same options, same edge-case
//! handling (repeat=0 rejection, oversized-payload rejection, non-finite
//! sample sanitization, degenerate sample-rate rejection) -- swapping only
//! the WAV file I/O for an in-memory `Vec<f32>`/`&[f32]` PCM buffer, since
//! that's what `AudioBuffer`/`AudioContext` deal in.
//!
//! "Never return wrong text, only a clean failure" (see CLI-TextOverVoice's
//! own hard-learned invariant) applies here too: `decode_from_pcm` returns
//! `Err` (a JS exception) rather than ever guessing at a partial/garbled
//! result.

use wasm_bindgen::prelude::*;

use textovervoice_core::protocol::{BROADCAST_ID, UNKNOWN_SRC_ID};
use textovervoice_core::{fec, message, modem, protocol};

const MAX_SYMBOLS_PER_FRAME: usize = 2000;
const PREAMBLE_BACKOFF_S: f64 = 0.1;
const SEARCH_WINDOW_S: f64 = 0.6;
const INTER_FRAME_SILENCE_S: f64 = 0.3;
const INTER_REPEAT_SILENCE_S: f64 = 0.6;

/// Installs a panic hook that forwards Rust panics to the browser console
/// with a real stack trace, instead of an opaque "unreachable executed"
/// trap. Call once at startup from JS.
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

fn parse_session_key(bytes: Option<Vec<u8>>) -> Result<Option<[u8; 32]>, JsValue> {
    match bytes {
        None => Ok(None),
        Some(v) => {
            let arr: [u8; 32] = v
                .try_into()
                .map_err(|v: Vec<u8>| JsValue::from_str(&format!(
                    "session key must be exactly 32 bytes, got {}",
                    v.len()
                )))?;
            Ok(Some(arr))
        }
    }
}

fn resolve_mode(mode: &str) -> Result<modem::ModeProfile, JsValue> {
    modem::mode_profile(mode)
        .ok_or_else(|| JsValue::from_str(&format!(
            "unknown mode {mode:?} (expected one of {:?})",
            modem::MODE_NAMES
        )))
}

/// Encodes `text` into 32-bit float PCM samples at [`modem::SR`] (8kHz
/// mono), using the default `ProtectedHeader` wire format. `dest_id`/
/// `src_id` default to broadcast/unknown when `None`. `session_key`, when
/// given, must be exactly 32 bytes (an X25519-derived shared secret) and
/// enables ChaCha20-Poly1305 encryption of the payload.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn encode_to_pcm(
    text: &str,
    mode: &str,
    dest_id: Option<u8>,
    src_id: Option<u8>,
    session_key: Option<Vec<u8>>,
    max_frame_chars: Option<usize>,
    repeat: Option<u32>,
) -> Result<Vec<f32>, JsValue> {
    let profile = resolve_mode(mode)?;
    let session_key = parse_session_key(session_key)?;
    let dest_id = dest_id.unwrap_or(BROADCAST_ID);
    let src_id = src_id.unwrap_or(UNKNOWN_SRC_ID);
    let max_frame_chars = max_frame_chars.unwrap_or(message::MAX_FRAME_CHARS);
    let repeat = repeat.unwrap_or(1);

    if repeat == 0 {
        return Err(JsValue::from_str("repeat must be at least 1, got 0"));
    }

    let frames_needed = message::frame_count(text, max_frame_chars);
    if frames_needed > 256 {
        return Err(JsValue::from_str(&format!(
            "message needs {frames_needed} frames, but a message can have at most 256 (seq is a \
             u8) -- raise max_frame_chars (currently {max_frame_chars}) or split the message \
             yourself"
        )));
    }

    let frames = message::build_message(
        text,
        &message::MessageBuildOptions {
            parity_bytes: fec::DEFAULT_PARITY_BYTES,
            use_dictionary: true,
            dest_id,
            src_id,
            session_key: session_key.as_ref(),
            max_frame_chars,
            frame_format: protocol::FrameFormat::default(),
        },
    )
    .ok_or_else(|| {
        JsValue::from_str(&format!(
            "a frame's encoded payload exceeded the wire format's {}-byte limit -- lower \
             max_frame_chars (currently {max_frame_chars})",
            protocol::MAX_PAYLOAD_BYTES
        ))
    })?;

    let inter_frame_silence = vec![0.0f64; (INTER_FRAME_SILENCE_S * modem::SR as f64) as usize];
    let inter_repeat_silence = vec![0.0f64; (INTER_REPEAT_SILENCE_S * modem::SR as f64) as usize];

    let mut audio = Vec::new();
    for rep in 0..repeat {
        if rep > 0 {
            audio.extend(&inter_repeat_silence);
        }
        for frame_codes in &frames {
            let symbols = modem::bytes_to_symbols(frame_codes);
            audio.extend(modem::modulate_frame(
                &symbols,
                profile.symbol_duration_s,
                profile.guard_s,
                modem::SR,
            ));
            audio.extend(&inter_frame_silence);
        }
    }

    Ok(audio.into_iter().map(|s| s as f32).collect())
}

/// Replaces non-finite samples with silence -- browser-decoded/uploaded
/// audio isn't trusted any more than a file read from disk was in the CLI.
fn sanitize_sample(v: f32) -> f64 {
    let v = v as f64;
    if v.is_finite() {
        v
    } else {
        0.0
    }
}

fn scan_for_preamble(audio: &[f64], start: usize, reference: &[f64], sr: u32) -> Option<(usize, f64)> {
    let search_window_n = (SEARCH_WINDOW_S * sr as f64) as usize;
    let preamble_len_n = (modem::PREAMBLE_DURATION_S * sr as f64) as usize;
    let mut pos = start;
    while pos < audio.len() {
        let end = (pos + search_window_n).min(audio.len());
        if let Some((offset, score)) = modem::find_preamble(&audio[pos..end], reference, 0.4) {
            return Some((pos + offset, score));
        }
        let window_actually_searched = end - pos;
        if window_actually_searched <= preamble_len_n {
            return None;
        }
        pos += window_actually_searched - preamble_len_n;
    }
    None
}

/// Decodes 32-bit float PCM samples (mono) captured/produced at `sample_rate`
/// Hz back into text. `my_id`, when given, filters to frames addressed to
/// that id (broadcast frames still match). `session_key` must match
/// whatever key the sender encrypted with, if any.
#[wasm_bindgen]
pub fn decode_from_pcm(
    samples: &[f32],
    sample_rate: u32,
    mode: &str,
    my_id: Option<u8>,
    session_key: Option<Vec<u8>>,
) -> Result<String, JsValue> {
    let profile = resolve_mode(mode)?;
    let session_key = parse_session_key(session_key)?;
    let sr = sample_rate;

    let audio: Vec<f64> = samples.iter().map(|&s| sanitize_sample(s)).collect();

    let step_n = ((profile.symbol_duration_s + profile.guard_s) * sr as f64) as usize;
    let preamble_len_n = (modem::PREAMBLE_DURATION_S * sr as f64) as usize;
    if step_n == 0 || preamble_len_n == 0 {
        return Err(JsValue::from_str(&format!(
            "unusable sample rate ({sr}Hz) for the requested timing -- expected something close \
             to {}Hz",
            modem::SR
        )));
    }

    let reference = modem::generate_preamble(
        modem::PREAMBLE_DURATION_S,
        modem::PREAMBLE_F0,
        modem::PREAMBLE_F1,
        sr,
    );
    let mut reassembler = message::MessageReassembler::new();
    let mut search_start = 0usize;

    while search_start < audio.len() {
        let Some((abs_offset, _score)) = scan_for_preamble(&audio, search_start, &reference, sr)
        else {
            break;
        };
        let payload_start = abs_offset + (modem::PREAMBLE_GUARD_S * sr as f64) as usize;
        let available = audio.len().saturating_sub(payload_start);
        let n_symbols = (available / step_n).min(MAX_SYMBOLS_PER_FRAME);

        let detections = modem::demodulate(
            &audio[payload_start..],
            n_symbols,
            profile.symbol_duration_s,
            profile.guard_s,
            sr,
            0,
        );
        let symbols: Vec<u8> = detections.iter().map(|d| d.symbol).collect();
        let n_bytes = (symbols.len() * modem::BITS_PER_SYMBOL as usize) / 8;
        let frame_codes = modem::symbols_to_bytes(&symbols, n_bytes);

        let result = protocol::parse_frame(
            &frame_codes,
            fec::DEFAULT_PARITY_BYTES,
            true,
            my_id,
            session_key.as_ref(),
        );

        let msg_result = reassembler.add(&result);
        if msg_result.ok {
            return Ok(msg_result.text.unwrap_or_default());
        }

        if let Some(consumed_codes) =
            protocol::frame_wire_length(&frame_codes, 0, fec::DEFAULT_PARITY_BYTES)
        {
            let consumed_symbols = (consumed_codes * 8).div_ceil(6);
            let exact_end = payload_start + consumed_symbols * step_n;
            search_start =
                payload_start.max(exact_end.saturating_sub((PREAMBLE_BACKOFF_S * sr as f64) as usize));
        } else {
            search_start = abs_offset + preamble_len_n;
        }
    }

    Err(JsValue::from_str(
        "decode failed: message incomplete (ran out of audio or preambles)",
    ))
}

/// A parsed resend request, as returned by [`scan_for_nack`]. `target_id`
/// is the 3-byte id (see `protocol::NackFrame`) naming which message to
/// resend -- callers correlate it against whatever id they tagged their
/// own sent messages with.
#[wasm_bindgen]
pub struct NackInfo {
    dest_id: u8,
    src_id: u8,
    target_id: Vec<u8>,
}

#[wasm_bindgen]
impl NackInfo {
    #[wasm_bindgen(getter)]
    pub fn dest_id(&self) -> u8 {
        self.dest_id
    }

    #[wasm_bindgen(getter)]
    pub fn src_id(&self) -> u8 {
        self.src_id
    }

    #[wasm_bindgen(getter)]
    pub fn target_id(&self) -> Vec<u8> {
        self.target_id.clone()
    }
}

fn parse_target_id(target_id: &[u8]) -> Result<[u8; 3], JsValue> {
    <[u8; 3]>::try_from(target_id)
        .map_err(|_| JsValue::from_str(&format!(
            "target_id must be exactly 3 bytes, got {}",
            target_id.len()
        )))
}

/// Encodes a resend-request signal (see `protocol::NackFrame`) into PCM.
/// Deliberately much shorter than a data message -- no payload, no FEC
/// budget beyond the 5-byte header's own protection -- since it only needs
/// to say "please resend id X".
#[wasm_bindgen]
pub fn build_nack_pcm(
    mode: &str,
    dest_id: Option<u8>,
    src_id: Option<u8>,
    target_id: &[u8],
) -> Result<Vec<f32>, JsValue> {
    let profile = resolve_mode(mode)?;
    let target_id = parse_target_id(target_id)?;

    let frame_codes = protocol::build_nack_frame(&protocol::NackFrame {
        dest_id: dest_id.unwrap_or(BROADCAST_ID),
        src_id: src_id.unwrap_or(UNKNOWN_SRC_ID),
        target_id,
    });
    let symbols = modem::bytes_to_symbols(&frame_codes);
    let audio = modem::modulate_frame(&symbols, profile.symbol_duration_s, profile.guard_s, modem::SR);
    Ok(audio.into_iter().map(|s| s as f32).collect())
}

/// Scans `samples` for the first resend-request signal, ignoring any
/// ordinary data frames encountered along the way (their preambles are
/// found and skipped past just like `decode_from_pcm` does, they're just
/// not what this function is looking for). Returns `None` if none is
/// found before the audio runs out -- a caller checks for a NACK on
/// received audio the same defensive way it checks for a decodable
/// message, never assuming one is present.
#[wasm_bindgen]
pub fn scan_for_nack(samples: &[f32], sample_rate: u32, mode: &str) -> Result<Option<NackInfo>, JsValue> {
    let profile = resolve_mode(mode)?;
    let sr = sample_rate;
    let audio: Vec<f64> = samples.iter().map(|&s| sanitize_sample(s)).collect();

    let step_n = ((profile.symbol_duration_s + profile.guard_s) * sr as f64) as usize;
    let preamble_len_n = (modem::PREAMBLE_DURATION_S * sr as f64) as usize;
    if step_n == 0 || preamble_len_n == 0 {
        return Err(JsValue::from_str(&format!(
            "unusable sample rate ({sr}Hz) for the requested timing -- expected something close \
             to {}Hz",
            modem::SR
        )));
    }

    let reference = modem::generate_preamble(
        modem::PREAMBLE_DURATION_S,
        modem::PREAMBLE_F0,
        modem::PREAMBLE_F1,
        sr,
    );
    let mut search_start = 0usize;

    while search_start < audio.len() {
        let Some((abs_offset, _score)) = scan_for_preamble(&audio, search_start, &reference, sr)
        else {
            break;
        };
        let payload_start = abs_offset + (modem::PREAMBLE_GUARD_S * sr as f64) as usize;
        let available = audio.len().saturating_sub(payload_start);
        let n_symbols = (available / step_n).min(MAX_SYMBOLS_PER_FRAME);

        let detections = modem::demodulate(
            &audio[payload_start..],
            n_symbols,
            profile.symbol_duration_s,
            profile.guard_s,
            sr,
            0,
        );
        let symbols: Vec<u8> = detections.iter().map(|d| d.symbol).collect();
        let n_bytes = (symbols.len() * modem::BITS_PER_SYMBOL as usize) / 8;
        let frame_codes = modem::symbols_to_bytes(&symbols, n_bytes);

        if let Some(nack) = protocol::parse_nack_frame(&frame_codes) {
            return Ok(Some(NackInfo {
                dest_id: nack.dest_id,
                src_id: nack.src_id,
                target_id: nack.target_id.to_vec(),
            }));
        }

        if let Some(consumed_codes) =
            protocol::frame_wire_length(&frame_codes, 0, fec::DEFAULT_PARITY_BYTES)
        {
            let consumed_symbols = (consumed_codes * 8).div_ceil(6);
            let exact_end = payload_start + consumed_symbols * step_n;
            search_start =
                payload_start.max(exact_end.saturating_sub((PREAMBLE_BACKOFF_S * sr as f64) as usize));
        } else {
            search_start = abs_offset + preamble_len_n;
        }
    }

    Ok(None)
}

/// Encodes `chunks` as a sequence of independently-addressed frames (one
/// per chunk, `seq` = index, `more_frames` = not the last one) -- unlike
/// [`encode_to_pcm`], which hands one whole string to
/// `message::build_message` and lets IT decide the split (so a caller-added
/// prefix, like a resend-target id, only lands on the first resulting
/// frame). Letting the caller pre-chunk means the caller can tag every
/// chunk identically before calling this (e.g. the same short id on every
/// frame of one message) so a single successfully-decoded frame reveals
/// which message it belongs to, even if earlier frames were lost -- see
/// textovervoice-core's `NackFrame` doc comment, which specifically calls
/// for this.
///
/// `chunks.len()` must be 1-256 (`seq` is a `u8`) and each chunk's encoded
/// payload must fit the wire format's length field, same constraints
/// [`encode_to_pcm`] enforces via `message::build_message` -- reported the
/// same way, as a clean `Err`, not a panic.
#[wasm_bindgen]
pub fn encode_frames_to_pcm(
    chunks: Vec<String>,
    mode: &str,
    dest_id: Option<u8>,
    src_id: Option<u8>,
    session_key: Option<Vec<u8>>,
) -> Result<Vec<f32>, JsValue> {
    let profile = resolve_mode(mode)?;
    let session_key = parse_session_key(session_key)?;
    let dest_id = dest_id.unwrap_or(BROADCAST_ID);
    let src_id = src_id.unwrap_or(UNKNOWN_SRC_ID);

    if chunks.is_empty() || chunks.len() > 256 {
        return Err(JsValue::from_str(&format!(
            "chunks.len() must be 1-256 (seq is a u8), got {}",
            chunks.len()
        )));
    }

    let mut frames = Vec::with_capacity(chunks.len());
    for (i, chunk) in chunks.iter().enumerate() {
        let frame = protocol::build_frame(
            chunk,
            &protocol::BuildOptions {
                parity_bytes: fec::DEFAULT_PARITY_BYTES,
                use_dictionary: true,
                dest_id,
                src_id,
                session_key: session_key.as_ref(),
                seq: i as u8,
                more_frames: i + 1 < chunks.len(),
                frame_format: protocol::FrameFormat::default(),
            },
        )
        .ok_or_else(|| {
            JsValue::from_str(&format!(
                "chunk {i}'s encoded payload exceeded the wire format's {}-byte limit -- use \
                 shorter chunks",
                protocol::MAX_PAYLOAD_BYTES
            ))
        })?;
        frames.push(frame);
    }

    let inter_frame_silence = vec![0.0f64; (INTER_FRAME_SILENCE_S * modem::SR as f64) as usize];
    let mut audio = Vec::new();
    for frame_codes in &frames {
        let symbols = modem::bytes_to_symbols(frame_codes);
        audio.extend(modem::modulate_frame(
            &symbols,
            profile.symbol_duration_s,
            profile.guard_s,
            modem::SR,
        ));
        audio.extend(&inter_frame_silence);
    }

    Ok(audio.into_iter().map(|s| s as f32).collect())
}

/// One frame's parse result, as returned by [`scan_next_frame`] -- the
/// single-frame-at-a-time counterpart to [`decode_from_pcm`]'s full
/// multi-frame reassembly. Lets a caller do its OWN reassembly
/// incrementally (tracking per-id progress, e.g. "2 of 3 frames") instead
/// of only finding out once a whole message either completes or the audio
/// runs out.
#[wasm_bindgen]
pub struct ScannedFrame {
    ok: bool,
    text: Option<String>,
    reason: String,
    src_id: Option<u8>,
    seq: Option<u8>,
    more_frames: Option<bool>,
    next_start: usize,
}

#[wasm_bindgen]
impl ScannedFrame {
    #[wasm_bindgen(getter)]
    pub fn ok(&self) -> bool {
        self.ok
    }
    #[wasm_bindgen(getter)]
    pub fn text(&self) -> Option<String> {
        self.text.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn reason(&self) -> String {
        self.reason.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn src_id(&self) -> Option<u8> {
        self.src_id
    }
    #[wasm_bindgen(getter)]
    pub fn seq(&self) -> Option<u8> {
        self.seq
    }
    #[wasm_bindgen(getter)]
    pub fn more_frames(&self) -> Option<bool> {
        self.more_frames
    }
    /// Sample offset to pass as `start_sample` on the next call, to
    /// continue scanning after this frame (whether or not it parsed ok --
    /// a caller should always advance past a found preamble, never retry
    /// the same one).
    #[wasm_bindgen(getter)]
    pub fn next_start(&self) -> usize {
        self.next_start
    }
}

/// Finds and parses the next single frame starting at `start_sample`,
/// ignoring NACK frames (returns `None` for them -- `scan_for_nack` is the
/// dedicated way to find those). Returns `None` once no further preamble
/// can be found before the audio runs out, matching `decode_from_pcm`'s
/// same "clean, honest absence" convention.
///
/// A caller polling live audio calls this in a loop from `start_sample =
/// 0`, feeding each result's `next_start` back in, until it gets `None`
/// for the current buffer -- then waits for more audio and resumes from
/// the last `next_start` it saw.
#[wasm_bindgen]
pub fn scan_next_frame(
    samples: &[f32],
    sample_rate: u32,
    mode: &str,
    start_sample: usize,
) -> Result<Option<ScannedFrame>, JsValue> {
    let profile = resolve_mode(mode)?;
    let sr = sample_rate;
    let audio: Vec<f64> = samples.iter().map(|&s| sanitize_sample(s)).collect();

    let step_n = ((profile.symbol_duration_s + profile.guard_s) * sr as f64) as usize;
    let preamble_len_n = (modem::PREAMBLE_DURATION_S * sr as f64) as usize;
    if step_n == 0 || preamble_len_n == 0 {
        return Err(JsValue::from_str(&format!(
            "unusable sample rate ({sr}Hz) for the requested timing -- expected something close \
             to {}Hz",
            modem::SR
        )));
    }
    if start_sample >= audio.len() {
        return Ok(None);
    }

    let reference = modem::generate_preamble(
        modem::PREAMBLE_DURATION_S,
        modem::PREAMBLE_F0,
        modem::PREAMBLE_F1,
        sr,
    );

    let Some((abs_offset, _score)) = scan_for_preamble(&audio, start_sample, &reference, sr)
    else {
        return Ok(None);
    };
    let payload_start = abs_offset + (modem::PREAMBLE_GUARD_S * sr as f64) as usize;
    let available = audio.len().saturating_sub(payload_start);
    let n_symbols = (available / step_n).min(MAX_SYMBOLS_PER_FRAME);

    let detections = modem::demodulate(
        &audio[payload_start..],
        n_symbols,
        profile.symbol_duration_s,
        profile.guard_s,
        sr,
        0,
    );
    let symbols: Vec<u8> = detections.iter().map(|d| d.symbol).collect();
    let n_bytes = (symbols.len() * modem::BITS_PER_SYMBOL as usize) / 8;
    let frame_codes = modem::symbols_to_bytes(&symbols, n_bytes);

    let next_start = match protocol::frame_wire_length(&frame_codes, 0, fec::DEFAULT_PARITY_BYTES)
    {
        Some(consumed_codes) => {
            let consumed_symbols = (consumed_codes * 8).div_ceil(6);
            let exact_end = payload_start + consumed_symbols * step_n;
            payload_start.max(exact_end.saturating_sub((PREAMBLE_BACKOFF_S * sr as f64) as usize))
        }
        None => abs_offset + preamble_len_n,
    };

    // A NACK frame here is legitimate audio, just not what this function
    // reports on -- skip it and let the caller's loop continue from
    // next_start, same as decode_from_pcm treats it as "not what I'm
    // looking for" rather than an error.
    if protocol::parse_nack_frame(&frame_codes).is_some() {
        return Ok(Some(ScannedFrame {
            ok: false,
            text: None,
            reason: "nack frame, not a data frame".to_string(),
            src_id: None,
            seq: None,
            more_frames: None,
            next_start,
        }));
    }

    let result = protocol::parse_frame(&frame_codes, fec::DEFAULT_PARITY_BYTES, true, None, None);
    Ok(Some(ScannedFrame {
        ok: result.ok,
        text: result.text,
        reason: result.reason,
        src_id: result.src_id,
        seq: result.seq,
        more_frames: result.more_frames,
        next_start,
    }))
}
