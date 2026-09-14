// Runs on the audio render thread: must return fast, never allocate/block.
// Just forwards each render quantum (typically 128 samples) to the main
// thread over the message port -- the actual demodulation work (expensive
// FFT-based decode) happens there in CaptureBuffer's poll loop, not here.
// Mirrors CLI-TextOverVoice's live.rs design: a non-blocking audio callback
// that only pushes into a buffer, with a separate loop doing the real work.
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      this.port.postMessage(input[0].slice());
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
