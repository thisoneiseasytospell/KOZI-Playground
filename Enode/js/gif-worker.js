/* Enode GIF encoder worker — keeps palette work off the animation thread. */
import { GIFEncoder, quantize, applyPalette } from '../vendor/gifenc.esm.js';

let encoder = null;
let width = 0;
let height = 0;
let frameRate = 30;
let totalFrames = 0;
let encodedFrames = 0;

// GIF stores frame delays in centiseconds. Alternating the rounded cumulative
// delays represents 30 FPS as 30/40 ms frames and 60 FPS as 10/20 ms frames,
// keeping the full loop duration accurate instead of rounding every frame alike.
function frameDelayMs(frameIndex) {
  const startCs = Math.round((frameIndex * 100) / frameRate);
  const endCs = Math.round(((frameIndex + 1) * 100) / frameRate);
  return Math.max(1, endCs - startCs) * 10;
}

self.addEventListener('message', event => {
  const message = event.data || {};
  try {
    if (message.type === 'init') {
      width = Math.max(1, Math.floor(message.width));
      height = Math.max(1, Math.floor(message.height));
      frameRate = message.fps === 60 ? 60 : 30;
      totalFrames = Math.max(1, Math.floor(message.totalFrames));
      encodedFrames = 0;
      encoder = GIFEncoder({ initialCapacity: 1024 * 1024 });
      self.postMessage({ type: 'ready' });
      return;
    }

    if (message.type === 'frame') {
      if (!encoder) throw new Error('GIF encoder was not initialized.');
      const rgba = new Uint8ClampedArray(message.rgba);
      // The artwork is mostly flat colour, so 128 colours retain clean edges
      // while keeping per-frame palettes and file sizes under control.
      const palette = quantize(rgba, 128, { format: 'rgb444' });
      const indexed = applyPalette(rgba, palette, 'rgb444');
      encoder.writeFrame(indexed, width, height, {
        palette,
        delay: frameDelayMs(encodedFrames),
        repeat: 0,
        colorDepth: 8,
        dispose: 1,
      });
      encodedFrames++;
      self.postMessage({ type: 'progress', encoded: encodedFrames, total: totalFrames });
      return;
    }

    if (message.type === 'finish') {
      if (!encoder) throw new Error('GIF encoder was not initialized.');
      encoder.finish();
      const bytes = encoder.bytes();
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      encoder = null;
      self.postMessage({ type: 'done', buffer }, [buffer]);
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error && error.message ? error.message : String(error) });
  }
});
