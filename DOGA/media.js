// Per-clip media engine: WebCodecs decoding into a real RAM frame cache, plus decoded audio.
//
// The preview used to drive <video> elements. That made playback hostage to how the file was
// encoded — a source with sparse keyframes turns every correction into a multi-second decode,
// and `video.buffered` (bytes downloaded) says nothing about whether a frame is ready to show.
// Here frames are decoded sequentially through WebCodecs and kept as canvases, so what is
// "cached" is exactly what can be painted this instant, and playback never seeks.

import { Input, ALL_FORMATS, BlobSource, CanvasSink } from './vendor/mediabunny.min.js';

// RAM ceiling for decoded preview frames (all clips together) and the longest edge a cached
// frame is allowed to have. Both step up in HQ: a bigger frame is worth more memory, and at
// 2160 the half-res softness is gone when you pause on a headline to read it.
const BUDGET = { lq: 400 * 1024 * 1024, hq: 720 * 1024 * 1024 };
const MAX_EDGE = { lq: 1200, hq: 2160 };
const WINDOW = 6;                  // seconds of lookahead a decode job aims for
const RESTART_MS = 90;             // debounce on re-targeting a job while scrubbing
const GAP = 0.25;                  // seconds; larger spacing than this splits a cached range
const STILL_DUR = 3600;            // an image can be stretched to any length; this is the cap

let quality = 'lq';
let bytesUsed = 0;
const registry = new Set();

const budget = () => BUDGET[quality];
const maxEdge = () => MAX_EDGE[quality];

// Long-edge-capped size for a source of nw x nh at the current quality.
function fitEdge(nw, nh) {
  const s = Math.min(1, maxEdge() / Math.max(nw, nh));
  return [Math.max(2, Math.round(nw * s)), Math.max(2, Math.round(nh * s))];
}

// Drop the frames furthest from each clip's playhead until we are back under budget.
// A still's single frame is never a victim — re-decoding it buys nothing and it would
// flicker out from under the playhead.
function evict() {
  if (bytesUsed <= budget()) return;
  const victims = [];
  for (const m of registry) {
    if (m.persistent) continue;
    for (const f of m.frames) victims.push({ m, f, d: Math.abs(f.t - m.want) });
  }
  victims.sort((a, b) => b.d - a.d);
  const target = budget() * 0.8;
  for (const v of victims) {
    if (bytesUsed <= target) break;
    v.m.drop(v.f);
  }
}

// Switching preview quality invalidates every cached frame — they were decoded at the old size.
export function setQuality(hq) {
  const next = hq ? 'hq' : 'lq';
  if (next === quality) return;
  quality = next;
  for (const m of registry) m.requantize();
  evict();
}

export class ClipMedia {
  constructor(file) {
    this.file = file;
    this.frames = [];       // {t, canvas, bytes}, kept sorted by t
    this.duration = 0;
    this.width = 0;
    this.height = 0;
    this.audio = null;      // AudioBuffer once decoded, null if the file has none
    this.persistent = false;
    this.error = null;
    this.ready = false;
    this.want = 0;          // source time last asked for — the centre eviction protects
    this.job = null;
    this.reached = -1;      // last timestamp the running job has decoded
    this.lastStart = 0;
    registry.add(this);
  }

  async load(audioCtx) {
    try {
      this.input = new Input({ source: new BlobSource(this.file), formats: ALL_FORMATS });
      this.track = await this.input.getPrimaryVideoTrack();
      if (!this.track) throw new Error('no video track');
      if (!(await this.track.canDecode())) throw new Error('codec not supported by this browser');
      this.duration = await this.input.computeDuration();
      this.natW = this.track.displayWidth;
      this.natH = this.track.displayHeight;
      this.#makeSink();

      this.decodeAudio(audioCtx);   // runs in the background; preview video does not wait on it
      this.ready = true;
    } catch (err) {
      this.error = err.message || String(err);
    }
    return this;
  }

  #makeSink() {
    [this.width, this.height] = fitEdge(this.natW, this.natH);
    this.sink = new CanvasSink(this.track, {
      width: this.width,
      height: this.height,
      fit: 'fill',
      decoderOptions: { optimizeForLatency: true },
    });
  }

  // Preview quality changed: throw away the cache, rebuild the sink, refill around the playhead.
  requantize() {
    if (!this.ready || this.error) return;
    if (this.job) this.job.cancelled = true;
    this.job = null;
    this.reached = -1;
    this.lastStart = 0;
    for (const f of [...this.frames]) this.drop(f);
    this.#makeSink();
    this.ensure(this.want);
  }

  async decodeAudio(audioCtx) {
    if (this.audioPromise) return this.audioPromise;
    this.audioPending = true;
    this.audioPromise = (async () => {
      try {
        this.audio = await audioCtx.decodeAudioData(await this.file.arrayBuffer());
      } catch {
        this.audio = null;   // silent clip; not an error
      }
      this.audioPending = false;
      return this.audio;
    })();
    return this.audioPromise;
  }

  // ---- frame cache ----

  // Index of the last frame at or before t, or -1.
  #search(t) {
    let lo = 0, hi = this.frames.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.frames[mid].t <= t + 1e-6) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best;
  }

  // The frame to paint for source time t: the most recent decoded frame at or before it.
  frameAt(t) {
    const i = this.#search(t);
    return i < 0 ? null : this.frames[i];
  }

  has(t) {
    const f = this.frameAt(t);
    return !!f && t - f.t < 0.5;
  }

  #store(wrapped) {
    const bytes = wrapped.canvas.width * wrapped.canvas.height * 4;
    const entry = { t: wrapped.timestamp, canvas: wrapped.canvas, bytes };
    const i = this.#search(entry.t);
    if (i >= 0 && Math.abs(this.frames[i].t - entry.t) < 1e-6) return;  // already have it
    this.frames.splice(i + 1, 0, entry);
    bytesUsed += bytes;
    evict();
  }

  drop(frame) {
    const i = this.frames.indexOf(frame);
    if (i < 0) return;
    this.frames.splice(i, 1);
    bytesUsed -= frame.bytes;
    frame.canvas.width = 0;   // release the backing store now rather than at GC's leisure
    frame.canvas.height = 0;
  }

  // Contiguous decoded ranges in source time — this is what the green bar draws.
  coverage() {
    const out = [];
    for (const f of this.frames) {
      const last = out[out.length - 1];
      if (last && f.t - last[1] <= GAP) last[1] = f.t;
      else out.push([f.t, f.t]);
    }
    return out;
  }

  // ---- decoding ----

  // Keep a decode job running that covers t and reads forward. Cheap to call every frame.
  ensure(t) {
    if (!this.ready || this.error) return;
    this.want = t;
    const covered = this.has(t) &&
      (this.reached >= t + 1.5 || this.reached >= this.duration - 0.05);
    if (covered) return;
    // an in-flight job that will reach t on its own
    if (this.job && !this.job.done && t >= this.job.from - 0.05 && t <= this.reached + 2) return;
    if (performance.now() - this.lastStart < RESTART_MS) return;
    this.#start(t);
  }

  async #start(from) {
    this.lastStart = performance.now();
    if (this.job) this.job.cancelled = true;
    const job = { from, cancelled: false, done: false };
    this.job = job;
    this.reached = from - 1e-3;

    const it = this.sink.canvases(Math.max(0, from), Math.min(this.duration, from + WINDOW));
    try {
      for await (const wrapped of it) {
        if (job.cancelled) break;
        this.#store(wrapped);
        this.reached = wrapped.timestamp + wrapped.duration;
      }
    } catch (err) {
      if (!job.cancelled) this.error = err.message || String(err);
    } finally {
      await it.return?.();
      job.done = true;
    }
  }

  destroy() {
    if (this.job) this.job.cancelled = true;
    for (const f of [...this.frames]) this.drop(f);
    registry.delete(this);
    this.input?.dispose?.();
  }
}

// A still image wearing the same coat as ClipMedia, so a clip never has to ask which it holds.
// One frame, no decoder, no audio; its `duration` is only the cap on how far it can be stretched.
export class ImageMedia {
  constructor(file) {
    this.file = file;
    this.frames = [];
    this.isImage = true;
    this.persistent = true;
    this.duration = STILL_DUR;
    this.width = 0;
    this.height = 0;
    this.audio = null;
    this.audioPending = false;
    this.error = null;
    this.ready = false;
    this.want = 0;
    registry.add(this);
  }

  async load() {
    try {
      this.bitmap = await createImageBitmap(this.file);
      this.natW = this.bitmap.width;
      this.natH = this.bitmap.height;
      this.#render();
      this.ready = true;
    } catch (err) {
      this.error = 'image could not be read';
    }
    return this;
  }

  #render() {
    for (const f of [...this.frames]) this.drop(f);
    [this.width, this.height] = fitEdge(this.natW, this.natH);
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    canvas.getContext('2d').drawImage(this.bitmap, 0, 0, this.width, this.height);
    const bytes = this.width * this.height * 4;
    this.frames = [{ t: 0, canvas, bytes }];
    bytesUsed += bytes;
    evict();
  }

  frameAt() { return this.frames[0] || null; }
  has() { return this.frames.length > 0; }
  coverage() { return this.frames.length ? [[0, this.duration]] : []; }
  ensure() { if (!this.frames.length && this.bitmap) this.#render(); }
  requantize() { if (this.ready) this.#render(); }

  drop(frame) {
    const i = this.frames.indexOf(frame);
    if (i < 0) return;
    this.frames.splice(i, 1);
    bytesUsed -= frame.bytes;
    frame.canvas.width = 0;
    frame.canvas.height = 0;
  }

  destroy() {
    for (const f of [...this.frames]) this.drop(f);
    registry.delete(this);
    this.bitmap?.close?.();
    this.bitmap = null;
  }
}

export const cacheBytes = () => bytesUsed;
export const cacheBudget = () => budget();
