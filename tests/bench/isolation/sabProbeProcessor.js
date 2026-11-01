// DX-SW, the audio row: an AudioWorklet module that answers whether a SharedArrayBuffer posted to it arrived, as the
// engine's mixer gets its slots (src/workers/audioMixerProcessor.js). Loaded by URL like the mixer, so the worklet
// follows the page's isolation the same way. isolationWorkerSmoke.mjs's 'audio' case.
class SabProbe extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = (e) => {
      const shared = typeof SharedArrayBuffer !== 'undefined' && e.data instanceof SharedArrayBuffer;
      this.port.postMessage({ shared, value: shared ? new Int32Array(e.data)[0] : null });
    };
    this.port.onmessageerror = () => this.port.postMessage({ shared: false, error: 'messageerror' });
  }

  process() {
    return true;
  }
}
registerProcessor('weed-sab-probe', SabProbe);
