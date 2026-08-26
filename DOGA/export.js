// MP4 export: WebCodecs decode -> canvas composite -> H.264 encode + AAC audio, all in-browser.
// Clips are AE-style layers: each has a global `start`, `in`/`out` trim, and array order
// (index 0 on top). Overlapping layers stack visually and mix in audio.

import {
  Input, ALL_FORMATS, BlobSource, VideoSampleSink,
  Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource,
} from './vendor/mediabunny.min.js';
import { drawFrame } from './render.js';

const FPS = 30;
const VIDEO_BITRATE = 16_000_000;
const AUDIO_BITRATE = 192_000;
const SAMPLE_RATE = 48_000;

// Mixes all clip audio into one 48kHz stereo buffer laid out on the global timeline.
async function renderAudio(spec, onProgress) {
  const length = Math.max(1, Math.ceil(spec.totalDur * SAMPLE_RATE));
  const oc = new OfflineAudioContext(2, length, SAMPLE_RATE);
  for (const clip of spec.clips) {
    if (clip.muted || clip.still) continue;
    try {
      const ab = await clip.file.arrayBuffer();
      const buf = await oc.decodeAudioData(ab);
      const src = oc.createBufferSource();
      src.buffer = buf;
      src.connect(oc.destination);
      src.start(clip.start, clip.in, clip.out - clip.in);
    } catch {
      // clip has no decodable audio — leave silence
    }
  }
  onProgress?.(0.5);
  return oc.startRendering();
}

// Slice an AudioBuffer into ~2s chunks (AudioBufferSource wants sequential buffers from t=0).
function* chunkBuffer(buf) {
  const chunkLen = SAMPLE_RATE * 2;
  for (let off = 0; off < buf.length; off += chunkLen) {
    const len = Math.min(chunkLen, buf.length - off);
    const out = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate: SAMPLE_RATE });
    for (let ch = 0; ch < 2; ch++) {
      const data = new Float32Array(len);
      buf.copyFromChannel(data, ch, off);
      out.copyToChannel(data, ch);
    }
    yield out;
  }
}

// spec: { W, H, totalDur, clips: [{file, still, start, in, out, panX, panY, move}], texts: [...] }
// onProgress(phase, fraction) with phase 'audio' | 'video'.
export async function exportMovie(spec, onProgress) {
  const canvas = new OffscreenCanvas(spec.W, spec.H);
  const ctx = canvas.getContext('2d');

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  const videoSource = new CanvasSource(canvas, { codec: 'avc', bitrate: VIDEO_BITRATE });
  output.addVideoTrack(videoSource, { frameRate: FPS });
  const audioSource = new AudioBufferSource({ codec: 'aac', bitrate: AUDIO_BITRATE });
  output.addAudioTrack(audioSource);
  await output.start();

  onProgress?.('audio', 0);
  const mixed = await renderAudio(spec, f => onProgress?.('audio', f));
  for (const chunk of chunkBuffer(mixed)) {
    await audioSource.add(chunk);
  }
  audioSource.close();
  onProgress?.('audio', 1);

  const totalFrames = Math.max(1, Math.round(spec.totalDur * FPS));
  const frameTime = f => (f + 0.5) / FPS;

  // One sequential decoder per video layer, pulled exactly once per frame it is active in.
  // A still layer skips all of that and holds a single bitmap for its whole span.
  const layers = [];
  for (const clip of spec.clips) {
    const dur = clip.out - clip.in;
    const f0 = Math.max(0, Math.ceil(clip.start * FPS - 0.5));
    const f1 = Math.min(totalFrames - 1, Math.ceil((clip.start + dur) * FPS - 0.5) - 1);
    if (f1 < f0) continue;

    if (clip.still) {
      const bitmap = await createImageBitmap(clip.file);
      layers.push({ clip, f0, f1, bitmap, sample: null, vw: bitmap.width, vh: bitmap.height });
      continue;
    }

    const input = new Input({ source: new BlobSource(clip.file), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) continue;
    const timestamps = [];
    for (let f = f0; f <= f1; f++) {
      timestamps.push(Math.min(clip.in + (frameTime(f) - clip.start), clip.out - 1e-4));
    }
    const sink = new VideoSampleSink(track);
    layers.push({
      clip, f0, f1,
      iter: sink.samplesAtTimestamps(timestamps),
      sample: null,
      vw: track.displayWidth,
      vh: track.displayHeight,
    });
  }

  for (let f = 0; f < totalFrames; f++) {
    const t = frameTime(f);
    const sources = [];
    // iterate bottom layer first so the top layer (spec order index 0) draws last
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      if (f < L.f0 || f > L.f1) continue;
      if (L.bitmap) {
        sources.push({
          vw: L.vw, vh: L.vh, panX: L.clip.panX, panY: L.clip.panY,
          move: L.clip.move,
          u: (t - L.clip.start) / Math.max(1e-6, L.clip.out - L.clip.in),
          draw: (c, dx, dy, dw, dh) => c.drawImage(L.bitmap, dx, dy, dw, dh),
        });
        continue;
      }
      const r = await L.iter.next();
      if (!r.done && r.value) {
        L.sample?.close();
        L.sample = r.value;
      }
      if (!L.sample) continue;
      sources.push({
        vw: L.vw, vh: L.vh, panX: L.clip.panX, panY: L.clip.panY,
        draw: (c, dx, dy, dw, dh) => L.sample.draw(c, dx, dy, dw, dh),
      });
    }
    drawFrame(ctx, spec.W, spec.H, sources, spec.texts, t);
    await videoSource.add(f / FPS, 1 / FPS);
    if (f % 5 === 0) onProgress?.('video', f / totalFrames);
  }

  for (const L of layers) {
    L.sample?.close();
    L.bitmap?.close?.();
    L.iter?.return?.();
  }
  videoSource.close();
  onProgress?.('video', 1);
  await output.finalize();
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}
