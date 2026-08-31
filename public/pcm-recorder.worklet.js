/**
 * Deliberately dumb PCM forwarder: copies each 128-sample render block to the
 * main thread and does nothing else. All DSP lives in src/dsp so that the live
 * and offline paths run byte-identical code; a worklet that analysed anything
 * would be a second implementation to keep in sync.
 *
 * Plain JS in public/ (not bundled) because AudioWorklet modules load through
 * their own URL, outside the module graph. Workbox precaches it via the `js`
 * glob — without that, the installed app breaks offline.
 */
registerProcessor(
  "pcm-recorder",
  class extends AudioWorkletProcessor {
    process(inputs) {
      const channel = inputs[0]?.[0];
      if (channel) {
        // A copy is mandatory: the render quantum buffer is reused every
        // block, so posting `channel` itself would hand over a view that has
        // already been overwritten by the time the main thread reads it.
        const block = channel.slice();
        this.port.postMessage(block, [block.buffer]); // transfer, don't clone
      }
      return true; // keep the node alive even while the mic is silent
    }
  },
);
