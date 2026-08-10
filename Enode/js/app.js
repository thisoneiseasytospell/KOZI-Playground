/* Enode Oker — KOZI Playground */
'use strict';

// ─── State ───────────────────────────────────────────────────────
const state = {
  mode: 'Video',          // Video | Image | Camera | Strips | Random
  aspect: '1:1',
  exportW: 1080,
  exportH: 1080,
  density: 60,
  cellSize: 1,
  invert: false,
  outline: false,
  stroke: 1,
  gradient: false,        // Random mode: linear gradients in rectangles
  editRects: false,       // Random mode: show drag/resize handles
  fg: '#000000',
  bg: '#FFFFFF',
  playing: true,
  randomSeed: Math.floor(Math.random() * 1e9),
  rects: [],              // current rectangle list (flat, editable)
  rectGradients: [],      // parallel array: per-rect gradient params {ang, vStart, vEnd}
  artboard: {
    rotation: 0,          // clockwise quarter turns: 0 | 1 | 2 | 3
    flipX: false,
    flipY: false,
    pattern: 'single-down',
  },
  strips: {               // Strips mode — defaults mirror the reference sketch
    count: 7,             // vertical strips across the canvas
    phaseShift: 0.11,     // per-strip phase offset
    amplitude: 1.05,      // gradient scroll per wave cycle
    phaseMode: 'Sine',    // Linear | Sine | Random
    threshold: 1.74,      // gradient cutoff position
    softness: 0.46,       // smoothstep edge width at the cutoff
    contrast: 4.9,        // steepens the gradient around mid-grey
    levels: 3,            // posterize steps (0 = off)
    speed: 1.9,           // time advance (reference: time += speed * 0.01 / frame)
  },
  randomAudioDriven: false,// Random mode: each rect's value = its band level
  audioInfluence: 1.35,    // master multiplier for every audio modulation row
  cameraMicEnabled: true,
  // Modulation matrix: each row routes a SOURCE (band level, per-band hit, beat,
  // BPM tick, or a generator) to a visual TARGET through an attack/release
  // envelope. Loudness + mids affect every mode; the remaining rows give Strips
  // extra movement and deformation without introducing radial waves.
  audioMods: [
    { source: 'rms',     target: 'pulse',        depth: 0.75, attack: 12, release: 90,  chance: 1, invert: false, speed: 0.4, bpmSync: false, env: 0, phase: 0 },
    { source: 'mid',     target: 'cellContrast', depth: 0.45, attack: 18, release: 120, chance: 1, invert: false, speed: 0.4, bpmSync: false, env: 0, phase: 0 },
    { source: 'beat',    target: 'timeSpeed',    depth: 0.30, attack: 12, release: 110, chance: 1, invert: false, speed: 0.4, bpmSync: false, env: 0, phase: 0 },
    { source: 'bass',    target: 'stripAmp',     depth: 0.38, attack: 14, release: 100, chance: 1, invert: false, speed: 0.4, bpmSync: false, env: 0, phase: 0 },
    { source: 'treble', target: 'stripPhase',   depth: 0.25, attack: 16, release: 110, chance: 1, invert: false, speed: 0.4, bpmSync: false, env: 0, phase: 0 },
  ],
};

// Cell scale is capped at one grid slot. Outline geometry subtracts its stroke
// from this footprint below, so neighbouring cells can touch but never overlap.
const MAX_CELL_SIZE = 1;

const ARTBOARD_PATTERNS = [
  { id: 'single-up',    label: 'Up',       layout: 'single', directions: ['up'] },
  { id: 'single-left',  label: 'Left',     layout: 'single', directions: ['left'] },
  { id: 'single-right', label: 'Right',    layout: 'single', directions: ['right'] },
  { id: 'single-down',  label: 'Down',     layout: 'single', directions: ['down'] },
  { id: 'split-up',     label: 'Split up', layout: 'split-x', directions: ['up', 'up'] },
  { id: 'split-down',   label: 'Split down', layout: 'split-x', directions: ['down', 'down'] },
  { id: 'mirror-in',    label: 'Mirror in', layout: 'mirror-x', directions: ['right', 'left'] },
  { id: 'mirror-out',   label: 'Mirror out', layout: 'mirror-x', directions: ['left', 'right'] },
  { id: 'quad-out',     label: 'Quad out', layout: 'mirror-quad', directions: ['left', 'right', 'left', 'right'] },
  { id: 'quad-in',      label: 'Quad in', layout: 'mirror-quad', directions: ['right', 'left', 'right', 'left'] },
];
const ARTBOARD_PATTERN_MAP = Object.fromEntries(ARTBOARD_PATTERNS.map(p => [p.id, p]));

function _clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function smooth01(v) {
  v = _clamp(v, 0, 1);
  return v * v * (3 - 2 * v);
}

// ─── Modulation registries ───────────────────────────────────────
// TARGETS: how each routable parameter responds. `apply:'mul'` scales the base
// (effective = base × (1 + Σ·range)); `apply:'add'` offsets it (base + Σ·range).
// `pulse`/`cellContrast`/`scan`/`flicker`/`timeSpeed`/`hue` have no base slider — they read Σ via
// a synthetic base (0 or 1). New target = one entry here + one apply-site.
const MOD_TARGETS = {
  pulse:         { label: 'Cells · audio pulse', apply: 'add', range: 0.70 },
  cellContrast:  { label: 'Cells · contrast',    apply: 'add', range: 1.0 },
  scan:          { label: 'Scan (sweep)',   apply: 'add', range: 1.4 },
  flicker:       { label: 'Flicker (data)', apply: 'add', range: 1.0 },
  timeSpeed:     { label: 'Playback speed', apply: 'mul', range: 3.0 },
  density:       { label: 'Density',        apply: 'add', range: 36,  clamp: [4, 240] },
  hue:           { label: 'Hue rotate',     apply: 'add', range: 180 },
  stripCount:    { label: 'Strips · count', apply: 'add', range: 12,  clamp: [1, 50] },
  stripPhase:    { label: 'Strips · phase', apply: 'add', range: 1.0, clamp: [0, 5] },
  stripAnim:     { label: 'Strips · speed', apply: 'add', range: 3.0, clamp: [0, 5] },
  stripAmp:      { label: 'Strips · amp',   apply: 'add', range: 1.0, clamp: [0, 2] },
};

// SOURCES: what drives a row. kind 'level' = continuous 0..1; 'event' = momentary
// hit (drives a percussive attack/decay envelope); 'gen' = self-running LFO/saw/noise.
const MOD_SOURCES = {
  bass:         { label: 'Bass level',   kind: 'level', read: () => enodeAudio.levels.bass },
  mid:          { label: 'Mid level',    kind: 'level', read: () => enodeAudio.levels.mid },
  treble:       { label: 'Treble level', kind: 'level', read: () => enodeAudio.levels.treble },
  rms:          { label: 'Volume',       kind: 'level', read: () => enodeAudio.levels.rms },
  beat:         { label: 'Beat (kick)',  kind: 'event', read: () => enodeAudio.beat },
  'hit.bass':   { label: 'Hit · bass',   kind: 'event', read: () => enodeAudio.onsets.bass },
  'hit.mid':    { label: 'Hit · snare',  kind: 'event', read: () => enodeAudio.onsets.mid },
  'hit.treble': { label: 'Hit · hat',    kind: 'event', read: () => enodeAudio.onsets.treble },
  'beat/1':     { label: 'BPM · 1',      kind: 'event', read: () => bpmTick(1) },
  'beat/2':     { label: 'BPM · 2',      kind: 'event', read: () => bpmTick(2) },
  'beat/4':     { label: 'BPM · 4',      kind: 'event', read: () => bpmTick(4) },
  'beat/8':     { label: 'BPM · 8',      kind: 'event', read: () => bpmTick(8) },
  'beat/16':    { label: 'BPM · 16',     kind: 'event', read: () => bpmTick(16) },
  lfo:          { label: 'LFO (sine)',   kind: 'gen' },
  saw:          { label: 'Ramp (saw)',   kind: 'gen' },
  noise:        { label: 'Noise',        kind: 'gen' },
};
function bpmTick(n) { return !!(window.enodeBpm && enodeBpm.onBeat[n]); }

// Display order for the pickers.
const MOD_SOURCE_ORDER = ['bass','mid','treble','rms','beat','hit.bass','hit.mid','hit.treble','beat/1','beat/2','beat/4','beat/8','beat/16','lfo','saw','noise'];
const MOD_TARGET_ORDER = ['pulse','cellContrast','scan','flicker','timeSpeed','density','hue','stripCount','stripPhase','stripAnim','stripAmp'];

// Generators: free-run speed (slider 0..1 → ~0.15..2 Hz) or quantized BPM sync.
const GEN_SYNC_BEATS = [16, 8, 4, 2, 1];

// dt → EMA factor for a time constant (ms); framerate-independent.
function modAlpha(tau, dt) { return 1 - Math.exp(-(dt || 16) / Math.max(1, tau)); }
// Probability gate for event rows (chance < 1 thins out hits for variation).
function chance(p) { return p >= 1 || Math.random() < p; }

// Advance + sample a generator row → 0..1.
function generatorValue(m, dt) {
  let p;
  if (m.bpmSync && window.enodeBpm) {
    const i = _clamp(Math.floor(m.speed * GEN_SYNC_BEATS.length), 0, GEN_SYNC_BEATS.length - 1);
    p = enodeBpm.rhythm(GEN_SYNC_BEATS[i]);
  } else {
    m.phase = (m.phase || 0) + (0.15 + m.speed * 1.85) * ((dt || 16) / 1000);
    p = m.phase;
  }
  if (m.source === 'saw') return ((p % 1) + 1) % 1;
  if (m.source === 'noise') {
    if (m._seed === undefined) m._seed = Math.random() * 1000;
    return (simplex.noise3D(p * 1.3, m._seed, 0) + 1) / 2;
  }
  return 0.5 + 0.5 * Math.sin(p * Math.PI * 2); // lfo
}

// Per-frame: advance every row's envelope/generator → m.env (0..1) and m._value
// (depth-scaled, post-invert). `level` sources chase the band with attack/release;
// `event` sources snap to 1 on a hit (instant attack) then decay; `gen` is direct.
function updateMods(dt) {
  if (!window.enodeAudio || !state.audioMods) return;
  // No track or microphone → every row decays to silence, generators and
  // inverted rows included, so page load and pause are calm and deterministic.
  if (!enodeAudio.playing && !enodeAudio.micActive) {
    for (const m of state.audioMods) {
      m.env += (0 - m.env) * modAlpha(220, dt);
      m._value = 0;
    }
    return;
  }
  for (const m of state.audioMods) {
    const src = MOD_SOURCES[m.source];
    if (!src) { m.env = 0; m._value = 0; continue; }
    if (src.kind === 'gen') {
      m.env = generatorValue(m, dt);
    } else if (src.kind === 'event') {
      if (src.read() && chance(m.chance)) m.env = 1;
      else m.env += (0 - m.env) * modAlpha(m.release, dt);
    } else {
      const tgt = src.read() || 0;
      m.env += (tgt - m.env) * modAlpha(tgt > m.env ? m.attack : m.release, dt);
    }
    m._value = (m.invert ? 1 - m.env : m.env) * m.depth * state.audioInfluence;
  }
}

// Σ of depth-scaled values for a target across all rows.
function modSum(target) {
  if (!state.audioMods) return 0;
  let s = 0;
  for (const m of state.audioMods) if (m.target === target) s += (m._value || 0);
  return s;
}

// Apply a target's modulation to a base value (live render only). Returns the
// base unchanged when nothing drives that target.
function applyMods(base, target) {
  const t = MOD_TARGETS[target];
  if (!t) return base;
  const sum = modSum(target);
  if (sum === 0) return base;
  let v = t.apply === 'mul' ? base * (1 + sum * t.range) : base + sum * t.range;
  if (t.clamp) v = _clamp(v, t.clamp[0], t.clamp[1]);
  return v;
}

const DEMO_VIDEO_URL = 'demo/demo.mp4';
const DEFAULT_IMAGE_URL = 'demo/default.png';

// ─── DOM ─────────────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const stage = document.getElementById('stage');
const stageInfo = document.getElementById('stageInfo');
const fpsCounter = document.getElementById('fpsCounter');
const dropOverlay = document.getElementById('dropOverlay');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');

// ─── Source handling ─────────────────────────────────────────────
// Simplex is still used by the modulation matrix's `noise` generator source.
const simplex = new SimplexNoise();

const sampleCanvas = document.createElement('canvas');
const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

let activeVideo = null;
let lastVideoTime = 0;
let snapNextFrame = false;  // set when video loops, used to instant-snap smoothing
let imageEl = null;
let cameraStream = null;
let cameraMicStream = null;
let cameraVideo = null;
let time = 0;
let animClock = 0;          // wall-clock seconds; drives the per-cell effects in every mode
let videoRateSmooth = 1;    // smoothed video playback rate (gentle audio tempo lean)
let smoothed = [];
let lastDensity = 0;
let lastRows = 0;
let randomSourceCanvas = null; // grayscale rectangles painted here; fed to grid sampler
let mediaLoadToken = 0;
let gifPlayback = null;
let nativeGifEl = null;

function stopGifPlayback() {
  const playback = gifPlayback;
  gifPlayback = null;
  if (playback) {
    playback.cancelled = true;
    try { playback.decoder.close(); } catch (e) {}
    if (imageEl === playback.canvas) imageEl = null;
  }
  // Native fallback images stay in the document so their animation clock runs.
  if (nativeGifEl) {
    const objectUrl = nativeGifEl.dataset.enodeObjectUrl;
    if (imageEl === nativeGifEl) imageEl = null;
    nativeGifEl.remove();
    nativeGifEl = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

function createVideoEl() {
  const v = document.createElement('video');
  v.muted = true;
  v.loop = false; // we'll handle the loop ourselves
  v.playsInline = true;
  v.crossOrigin = 'anonymous';
  v.preload = 'auto';
  return v;
}

function setVideoSource(url, opts) {
  opts = opts || {};
  stopGifPlayback();
  if (!activeVideo) {
    activeVideo = createVideoEl();
    activeVideo.loop = true; // browser handles the loop; we hide the seam via snap
  }
  const token = ++mediaLoadToken;
  if (opts.matchAspect) {
    activeVideo.addEventListener('loadedmetadata', () => {
      if (token === mediaLoadToken) matchOutputToSource(activeVideo.videoWidth, activeVideo.videoHeight);
    }, { once: true });
  }
  activeVideo.src = url;
  lastVideoTime = 0;
  activeVideo.play().catch(() => {});
}

function setImageSource(url, opts) {
  opts = opts || {};
  stopGifPlayback();
  const token = ++mediaLoadToken;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  if (opts.animatedGif) {
    // Some engines stop detached GIF images on their default frame. Keeping the
    // fallback in the render tree gives it a real animation clock.
    img.className = 'gif-clock-source';
    img.dataset.enodeGifClock = 'true';
    img.dataset.enodeObjectUrl = url;
    img.setAttribute('aria-hidden', 'true');
    document.body.appendChild(img);
    nativeGifEl = img;
  }
  img.onload = () => {
    if (token !== mediaLoadToken) return;
    imageEl = img;
    if (opts.matchAspect) matchOutputToSource(img.naturalWidth, img.naturalHeight);
  };
  img.src = url;
}

async function decodeGifFrame(playback, frameIndex, scheduledAt) {
  if (!playback || playback.cancelled || playback.decoding) return;
  playback.decoding = true;
  let frame = null;
  try {
    const result = await playback.decoder.decode({ frameIndex, completeFramesOnly: true });
    frame = result.image;
    if (playback.cancelled || gifPlayback !== playback || playback.token !== mediaLoadToken) return;

    const width = frame.displayWidth || frame.codedWidth;
    const height = frame.displayHeight || frame.codedHeight;
    if (playback.canvas.width !== width || playback.canvas.height !== height) {
      playback.canvas.width = width;
      playback.canvas.height = height;
    }
    playback.ctx.clearRect(0, 0, width, height);
    playback.ctx.drawImage(frame, 0, 0, width, height);
    playback.frameIndex = frameIndex;

    // VideoFrame durations are microseconds. Respect the GIF timing but never
    // schedule faster than the app's 60 FPS render ceiling.
    const durationMs = Math.max(1000 / 60, frame.duration == null ? 100 : frame.duration / 1000);
    const now = performance.now();
    const intendedNext = scheduledAt == null ? now + durationMs : scheduledAt + durationMs;
    playback.nextFrameAt = intendedNext > now ? intendedNext : now + durationMs;
  } finally {
    if (frame) frame.close();
    playback.decoding = false;
  }
}

function startNativeGifFallback(file, opts) {
  const url = URL.createObjectURL(file);
  setImageSource(url, { ...opts, animatedGif: true });
}

async function setGifSource(file, opts) {
  opts = opts || {};
  stopGifPlayback();
  imageEl = null;
  const token = ++mediaLoadToken;

  try {
    const Decoder = window.ImageDecoder;
    if (!Decoder || !(await Decoder.isTypeSupported('image/gif'))) {
      if (token === mediaLoadToken) startNativeGifFallback(file, opts);
      return;
    }

    const data = await file.arrayBuffer();
    if (token !== mediaLoadToken) return;
    const decoder = new Decoder({ type: 'image/gif', data, preferAnimation: true });
    await decoder.tracks.ready;
    if (token !== mediaLoadToken) {
      decoder.close();
      return;
    }
    const track = decoder.tracks.selectedTrack;
    if (!track || track.frameCount < 1) throw new Error('The GIF contains no decodable frames.');

    const gifCanvas = document.createElement('canvas');
    const playback = {
      decoder,
      canvas: gifCanvas,
      ctx: gifCanvas.getContext('2d'),
      frameCount: track.frameCount,
      frameIndex: -1,
      nextFrameAt: 0,
      decoding: false,
      cancelled: false,
      token,
      file,
      opts,
    };
    gifPlayback = playback;
    await decodeGifFrame(playback, 0, null);
    if (gifPlayback !== playback || playback.cancelled) return;
    imageEl = gifCanvas;
    if (opts.matchAspect) matchOutputToSource(gifCanvas.width, gifCanvas.height);
    updateSourcePreview();
  } catch (error) {
    if (token !== mediaLoadToken) return;
    console.warn('Explicit GIF decoding failed; using native animation fallback.', error);
    stopGifPlayback();
    startNativeGifFallback(file, opts);
  }
}

function updateGifPlayback(now) {
  const playback = gifPlayback;
  if (!playback || playback.cancelled || playback.decoding || playback.frameCount < 2) return;
  if (now < playback.nextFrameAt) return;
  const nextFrame = (playback.frameIndex + 1) % playback.frameCount;
  const scheduledAt = playback.nextFrameAt;
  decodeGifFrame(playback, nextFrame, scheduledAt).catch(error => {
    if (gifPlayback !== playback || playback.cancelled) return;
    console.warn('GIF frame decode failed; using native animation fallback.', error);
    const { file, opts: fallbackOpts } = playback;
    stopGifPlayback();
    startNativeGifFallback(file, fallbackOpts);
  });
}

function syncCameraMicUI() {
  const button = document.getElementById('cameraMicToggle');
  const label = document.getElementById('cameraMicLabel');
  if (!button) return;
  const inCamera = state.mode === 'Camera';
  const active = !!(window.enodeAudio && enodeAudio.micActive);
  button.style.display = inCamera ? '' : 'none';
  button.classList.toggle('active', active);
  button.setAttribute('aria-pressed', String(active));
  if (label) label.textContent = active ? 'Camera microphone is driving visuals' : 'React to camera microphone';
}

function attachCameraMicrophone(stream) {
  if (!stream || !window.enodeAudio) return false;
  const connected = enodeAudio.useMicrophone(stream);
  if (connected) {
    const analysis = document.getElementById('soundAnalysis');
    if (analysis) analysis.style.display = '';
  }
  syncCameraMicUI();
  return connected;
}

async function enableCameraMicrophone() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
  try {
    cameraMicStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    state.cameraMicEnabled = true;
    return attachCameraMicrophone(cameraMicStream);
  } catch (error) {
    state.cameraMicEnabled = false;
    syncCameraMicUI();
    alert('Microphone access denied or unavailable. Camera video will keep working.');
    return false;
  }
}

function disableCameraMicrophone() {
  state.cameraMicEnabled = false;
  if (window.enodeAudio) enodeAudio.stopMicrophone();
  const streams = new Set([cameraStream, cameraMicStream]);
  for (const stream of streams) {
    if (!stream) continue;
    stream.getAudioTracks().forEach(track => track.stop());
  }
  cameraMicStream = null;
  syncCameraMicUI();
}

async function startCamera() {
  try {
    const wantsMic = state.cameraMicEnabled;
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: wantsMic ? { echoCancellation: true, noiseSuppression: false, autoGainControl: false } : false,
      });
    } catch (combinedError) {
      if (!wantsMic) throw combinedError;
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      state.cameraMicEnabled = false;
    }
    cameraVideo = createVideoEl();
    cameraVideo.srcObject = cameraStream;
    await cameraVideo.play();
    const hasMic = cameraStream.getAudioTracks().some(track => track.readyState === 'live');
    if (hasMic) {
      cameraMicStream = cameraStream;
      attachCameraMicrophone(cameraStream);
    } else {
      syncCameraMicUI();
    }
  } catch (e) {
    alert('Camera access denied or unavailable.');
    cameraStream = null;
    syncCameraMicUI();
  }
}

function stopCamera() {
  if (window.enodeAudio) enodeAudio.stopMicrophone();
  const streams = new Set([cameraStream, cameraMicStream]);
  for (const stream of streams) {
    if (stream) stream.getTracks().forEach(t => t.stop());
  }
  cameraStream = null;
  cameraMicStream = null;
  cameraVideo = null;
  syncCameraMicUI();
}

function currentSource() {
  if (state.mode === 'Video' && activeVideo && activeVideo.readyState >= 2 && !activeVideo.seeking) return activeVideo;
  if (state.mode === 'Image' && imageEl) return imageEl;
  if (state.mode === 'Camera' && cameraVideo && cameraVideo.readyState >= 2) return cameraVideo;
  if (state.mode === 'Random') {
    if (!randomSourceCanvas) rebuildRandomSource();
    return randomSourceCanvas;
  }
  return null;
}

// ─── Seeded RNG (mulberry32) ─────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Random (Mondrian-style) BSP layout ──────────────────────────
// Always produces at least one split (otherwise you'd see a single block).
// Layout is normalized 0..1 so edits work across aspect changes.
function generateRandomLayout(seed) {
  const rng = mulberry32(seed);
  const palette = [0, 0.13, 0.5, 0.85, 1.0];
  const rects = [];
  // Min block size is ~22% of the canvas — keeps blocks chunky like the reference.
  const minSize = 0.22;
  function split(x, y, rw, rh, depth) {
    // depth 0–1: mandatory split (so we always see structure); after that, probabilistic.
    const mandatory = depth < 2;
    const canSplit = (rw > minSize * 1.6 && rh > minSize * 1.6) && depth < 4 && (mandatory || rng() > 0.35);
    if (!canSplit) {
      const v = palette[Math.floor(rng() * palette.length)];
      rects.push({ x, y, w: rw, h: rh, v });
      return;
    }
    const splitH = rw > rh ? rng() > 0.3 : rng() > 0.7;
    if (splitH) {
      const cut = rw * (0.35 + rng() * 0.3);
      split(x, y, cut, rh, depth + 1);
      split(x + cut, y, rw - cut, rh, depth + 1);
    } else {
      const cut = rh * (0.35 + rng() * 0.3);
      split(x, y, rw, cut, depth + 1);
      split(x, y + cut, rw, rh - cut, depth + 1);
    }
  }
  split(0, 0, 1, 1, 0);
  return rects;
}

function regenerateRects() {
  state.rects = generateRandomLayout(state.randomSeed);
  // Pre-roll gradient params per rect (stable per layout, independent of toggle).
  const rng = mulberry32(state.randomSeed ^ 0x9e3779b9);
  state.rectGradients = state.rects.map(r => ({
    angle: Math.floor(rng() * 4) * 90, // 0/90/180/270 for clean axial gradients
    delta: 0.18 + rng() * 0.22,        // value swing across the gradient
  }));
  rebuildRandomSource();
}

function canonicalArtboardSize(w, h) {
  return state.artboard.rotation % 2 === 1 ? [h, w] : [w, h];
}

function rebuildRandomSource() {
  if (!randomSourceCanvas) randomSourceCanvas = document.createElement('canvas');
  const [canonicalW, canonicalH] = canonicalArtboardSize(state.exportW, state.exportH);
  const W = 512, H = Math.round(512 * canonicalH / canonicalW);
  randomSourceCanvas.width = W;
  randomSourceCanvas.height = H;
  const c = randomSourceCanvas.getContext('2d');
  c.fillStyle = '#808080';
  c.fillRect(0, 0, W, H);
  paintRectsTo(c, state.rects, W, H, state.gradient ? state.rectGradients : null);
  if (state.editRects) updateRectEditor();
}

// Repaint random canvas per-frame using each rectangle's frequency band as
// its brightness. Y-position determines the band (bottom = bass, top = treble),
// giving a multi-band EQ pattern across the layout.
const RANDOM_NUM_BANDS = 10;
function repaintRandomAudio() {
  if (!randomSourceCanvas || !state.rects.length) return;
  const W = randomSourceCanvas.width, H = randomSourceCanvas.height;
  const c = randomSourceCanvas.getContext('2d');
  c.fillStyle = '#000';
  c.fillRect(0, 0, W, H);
  for (const r of state.rects) {
    const yCenter = r.y + r.h * 0.5;
    // 1 - yCenter so the bottom row (yCenter=1) maps to band 0 (bass)
    const bandIdx = Math.min(RANDOM_NUM_BANDS - 1,
        Math.floor((1 - yCenter) * RANDOM_NUM_BANDS));
    const level = bandLevelForRow(bandIdx, RANDOM_NUM_BANDS);
    const g = Math.round(level * 255);
    c.fillStyle = `rgb(${g},${g},${g})`;
    c.fillRect(Math.floor(r.x * W), Math.floor(r.y * H),
               Math.ceil(r.w * W + 1), Math.ceil(r.h * H + 1));
  }
}

function paintRectsTo(c, rects, W, H, gradients) {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const px = r.x * W, py = r.y * H, pw = r.w * W + 1, ph = r.h * H + 1;
    if (gradients && gradients[i]) {
      const g = gradients[i];
      const v0 = Math.max(0, r.v - g.delta / 2);
      const v1 = Math.min(1, r.v + g.delta / 2);
      let x0, y0, x1, y1;
      switch (g.angle) {
        case 0:   x0 = px; y0 = py; x1 = px + pw; y1 = py; break;
        case 90:  x0 = px; y0 = py; x1 = px;      y1 = py + ph; break;
        case 180: x0 = px + pw; y0 = py; x1 = px; y1 = py; break;
        default:  x0 = px; y0 = py + ph; x1 = px; y1 = py; break;
      }
      const grd = c.createLinearGradient(x0, y0, x1, y1);
      const g0 = Math.round(v0 * 255), g1 = Math.round(v1 * 255);
      grd.addColorStop(0, `rgb(${g0},${g0},${g0})`);
      grd.addColorStop(1, `rgb(${g1},${g1},${g1})`);
      c.fillStyle = grd;
    } else {
      const g = Math.round(r.v * 255);
      c.fillStyle = `rgb(${g},${g},${g})`;
    }
    c.fillRect(px, py, pw, ph);
  }
}

// ─── Strips field ───────────────────────────────────────────────
// FFT-band averaging for the audio-driven Random rectangles. Logarithmic
// frequency mapping matches musical perception (each band covers an octave-ish
// range rather than a flat slice). bandRowIdx 0 = lowest band, rows-1 = highest.
function bandLevelForRow(bandRowIdx, totalRows) {
  if (!window.enodeAudio || !enodeAudio.freq || (!enodeAudio.loaded && !enodeAudio.micActive)) return 0;
  const freq = enodeAudio.freq;
  const usable = Math.floor(freq.length * 0.55); // ignore mostly-empty top bins
  const lo = Math.floor(Math.pow(bandRowIdx / totalRows, 2.3) * usable);
  const hi = Math.max(lo + 1, Math.floor(Math.pow((bandRowIdx + 1) / totalRows, 2.3) * usable));
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += freq[i];
  // Scale up so typical peaks reach 1.0
  return Math.min(1, (sum / (hi - lo)) / 255 * 1.7);
}

// Map destination artboard coordinates back into the canonical composition.
// Rotation/flips affect the whole composition; the selected pattern then
// repeats or mirrors that canonical field into one or four local panels.
function mapArtboardUV(u, v) {
  let x = u;
  let y = v;
  const a = state.artboard;

  // Flips operate in the visible artboard axes, after rotation.
  if (a.flipX) x = 1 - x;
  if (a.flipY) y = 1 - y;

  // Inverse-map a clockwise visual rotation.
  const q = ((a.rotation % 4) + 4) % 4;
  if (q === 1) {
    const ox = x;
    x = y;
    y = 1 - ox;
  } else if (q === 2) {
    x = 1 - x;
    y = 1 - y;
  } else if (q === 3) {
    const ox = x;
    x = 1 - y;
    y = ox;
  }

  const preset = ARTBOARD_PATTERN_MAP[a.pattern] || ARTBOARD_PATTERN_MAP['single-down'];
  let panel = 0;
  let mirroredX = false;
  let mirroredY = false;
  if (preset.layout === 'split-x') {
    panel = x < 0.5 ? 0 : 1;
    x = x < 0.5 ? x * 2 : (x - 0.5) * 2;
  } else if (preset.layout === 'mirror-x') {
    panel = x < 0.5 ? 0 : 1;
    mirroredX = panel === 1;
    x = x < 0.5 ? x * 2 : (1 - x) * 2;
  } else if (preset.layout === 'mirror-quad') {
    const col = x < 0.5 ? 0 : 1;
    const row = y < 0.5 ? 0 : 1;
    panel = row * 2 + col;
    mirroredX = col === 1;
    mirroredY = row === 1;
    x = col === 0 ? x * 2 : (1 - x) * 2;
    y = row === 0 ? y * 2 : (1 - y) * 2;
  }

  // Preset arrows describe movement on the visible panel. Reflected local
  // coordinates need the matching axis reversed before the field is sampled.
  let direction = preset.directions[panel] || preset.directions[0] || 'down';
  if (mirroredX && direction === 'left') direction = 'right';
  else if (mirroredX && direction === 'right') direction = 'left';
  if (mirroredY && direction === 'up') direction = 'down';
  else if (mirroredY && direction === 'down') direction = 'up';

  // Keep exact seam/edge coordinates inside addressable source pixels.
  const edge = 1 - 1e-7;
  return {
    u: _clamp(x, 0, edge),
    v: _clamp(y, 0, edge),
    direction,
  };
}

// Directional, oscillating strips. Each strip has its own phase, so neighbours
// can travel in opposite directions during the same frame and form a real wave.
// Up/down use vertical strips; left/right use horizontal strips. Direction sets
// the initial travel orientation; the sine oscillator always reverses naturally.
function stripsValue(x, y, t, p, direction) {
  direction = direction || 'down';
  const verticalMotion = direction === 'up' || direction === 'down';
  const cross = verticalMotion ? x : y;
  const along = verticalMotion ? y : x;
  const stripIndex = Math.min(Math.max(0, Math.floor(cross * p.count)), Math.max(0, Math.ceil(p.count) - 1));

  let phase;
  if (p.phaseMode === 'Linear') {
    phase = stripIndex * p.phaseShift;
  } else if (p.phaseMode === 'Random') {
    phase = ((Math.sin(stripIndex * 12.9898) * 43758.5453) % 1) * p.phaseShift * 10;
  } else { // Sine
    phase = Math.sin(stripIndex * p.phaseShift) * Math.PI;
  }

  // A feature in f(position + offset) moves opposite to the offset. Reversing
  // the clock preserves the selected initial direction without removing the
  // bidirectional motion of the sine wave.
  const travelSign = direction === 'up' || direction === 'left' ? 1 : -1;
  const offset = Math.sin(travelSign * t + phase) * p.amplitude;
  let wrapped = (along + offset) % 1;
  if (wrapped < 0) wrapped += 1;

  wrapped = (wrapped - 0.5) * p.contrast + 0.5;

  const edge0 = p.threshold + p.softness;
  const edge1 = p.threshold - p.softness;
  const tt = Math.max(0, Math.min(1, (wrapped - edge0) / (edge1 - edge0)));
  const cut = tt * tt * (3 - 2 * tt);

  let v = wrapped * cut;
  if (p.levels > 0.5) v = Math.floor(v * p.levels) / p.levels;
  v = v < 0 ? 0 : v > 1 ? 1 : v;

  // The reference applies its global "Source Contrast" (default 100 → ×2) on
  // top of every mode; baked in here so the strips look matches exactly.
  v = (v - 0.5) * 2 + 0.5;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ─── Color helpers ──────────────────────────────────────────────
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

// Rotate a hex color's hue by `deg` (for the `hue` mod target). Returns an hsl()
// string with the source saturation/lightness preserved.
function rotateHue(hex, deg) {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn)      h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else                 h = (rn - gn) / d + 4;
    h /= 6;
  }
  h = ((h * 360 + deg) % 360 + 360) % 360;
  return `hsl(${h.toFixed(1)}, ${(s * 100).toFixed(1)}%, ${(l * 100).toFixed(1)}%)`;
}

// ─── Canvas sizing ──────────────────────────────────────────────
function setExportSize(w, h, opts) {
  opts = opts || {};
  state.exportW = Math.max(2, Math.round(w));
  state.exportH = Math.max(2, Math.round(h));
  canvas.width = state.exportW;
  canvas.height = state.exportH;
  smoothed = []; lastDensity = 0; lastRows = 0; // force re-init
  fitCanvasToStage();
  stageInfo.textContent = `${state.exportW} × ${state.exportH}`;
  if (state.mode === 'Random' && !opts.preserveRandomSource) rebuildRandomSource();
}

function fitCanvasToStage() {
  const style = getComputedStyle(stage);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const aw = Math.max(2, stage.clientWidth - padX);
  const ah = Math.max(2, stage.clientHeight - padY);
  const ar = state.exportW / state.exportH;
  let cw, ch;
  if (aw / ah > ar) { ch = ah; cw = ah * ar; }
  else { cw = aw; ch = aw / ar; }
  canvas.style.width = Math.floor(cw) + 'px';
  canvas.style.height = Math.floor(ch) + 'px';
}

function applyAspect(val) {
  state.aspect = val;
  const map = { '1:1': [1080, 1080], '4:5': [1080, 1350], '9:16': [1080, 1920], '16:9': [1920, 1080], '3:2': [1500, 1000] };
  const [w, h] = map[val] || [1080, 1080];
  setExportSize(w, h);
  // Sync resolution select
  const sel = document.getElementById('resSelect');
  const key = `${w}x${h}`;
  if ([...sel.options].some(o => o.value === key)) sel.value = key;
  document.getElementById('customRes').style.display = 'none';
  document.getElementById('customW').value = w;
  document.getElementById('customH').value = h;
}

function evenPx(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

function matchOutputToSource(sourceW, sourceH) {
  if (!sourceW || !sourceH || !isFinite(sourceW) || !isFinite(sourceH)) return;
  const shortEdge = 1080;
  const ar = sourceW / sourceH;
  const w = ar >= 1 ? evenPx(shortEdge * ar) : shortEdge;
  const h = ar >= 1 ? shortEdge : evenPx(shortEdge / ar);
  const sel = document.getElementById('resSelect');
  const customRes = document.getElementById('customRes');
  const customW = document.getElementById('customW');
  const customH = document.getElementById('customH');
  if (sel) sel.value = 'custom';
  if (customRes) customRes.style.display = '';
  if (customW) customW.value = w;
  if (customH) customH.value = h;
  document.querySelectorAll('#aspectSeg button').forEach(b => b.classList.remove('active'));
  state.aspect = 'custom';
  setExportSize(w, h);
  updateSourcePreview();
  if (state.editRects) updateRectEditor();
}

window.addEventListener('resize', fitCanvasToStage);

// ─── Renderer ───────────────────────────────────────────────────
// Deterministic per-cell hash (0..1) — drives the Flicker effect's addressing.
function _hashCell(i, j, k) {
  const h = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
function drawScene(targetCtx, w, h, opts) {
  opts = opts || {};
  const liveMod = !opts.noSmoothing;

  // Each modulatable param reads its base from state and is pushed by the matrix
  // via applyMods() — but only on the live render. Large values are circles and
  // small values are squares; the user-controlled cell scale stays fixed.
  const density = Math.floor(opts.density != null ? opts.density
      : (liveMod ? applyMods(state.density, 'density') : state.density));
  const cellScale = _clamp(state.cellSize, 0, MAX_CELL_SIZE);
  // Pulse / contrast / timeSpeed / hue / the per-cell effects have no base slider.
  // Pulse and contrast are uniform across the artboard, never radial.
  const pulseAmt   = liveMod ? applyMods(0, 'pulse')   : 0;
  const cellContrastAmt = liveMod ? applyMods(0, 'cellContrast') : 0;
  const scanAmt    = liveMod ? applyMods(0, 'scan')    : 0;
  const flickerAmt = liveMod ? applyMods(0, 'flicker') : 0;
  const fxActive = scanAmt > 0.001 || flickerAmt > 0.001;
  const scanPos = (animClock * 0.35) % 1;           // scan sweep position 0..1
  const flickerFrame = Math.floor(animClock * 14);  // flicker refresh rate
  // Short time-based smoothing keeps movement crisp and audio-aligned at any
  // refresh rate. The old fixed 8% Strips blend added about 200 ms of lag at 60 Hz.
  const frameDt = _clamp(opts.dt != null ? opts.dt : 16.667, 1, 100);
  const reactionTau = state.mode === 'Strips' ? 42 : 14;
  const reactionLerp = 1 - Math.exp(-frameDt / reactionTau);
  const invert = state.invert;
  const outline = state.outline;
  const stroke = state.stroke;
  // A `hue` mod row can rotate the FG hue; otherwise the picked FG applies.
  const hueRot = liveMod ? modSum('hue') * MOD_TARGETS.hue.range : 0;
  const fg = hueRot !== 0 ? rotateHue(state.fg, hueRot) : state.fg;
  const bg = state.bg;
  const mode = state.mode;
  // Strips params: live modulation only on the live render (variation
  // thumbnails keep static param values). Speed is applied in tick(), where
  // the strips clock advances.
  let stripsParams = state.strips;
  if (mode === 'Strips' && liveMod) {
    stripsParams = { ...state.strips };
    stripsParams.count      = applyMods(state.strips.count,      'stripCount');
    stripsParams.phaseShift = applyMods(state.strips.phaseShift, 'stripPhase');
    stripsParams.amplitude  = applyMods(state.strips.amplitude,  'stripAmp');
  }

  // BG
  targetCtx.fillStyle = bg;
  targetCtx.fillRect(0, 0, w, h);

  // Grid modes — sample source / noise into a small buffer, then draw cells.
  const cellSize = w / density;
  const rows = Math.ceil(h / cellSize);
  const quarterTurn = ((state.artboard.rotation % 4) + 4) % 4;
  const sampleCols = quarterTurn % 2 ? rows : density;
  const sampleRows = quarterTurn % 2 ? density : rows;
  const src = opts.sourceOverride || currentSource();
  const useSmoothing = !opts.noSmoothing;
  let buf = opts.smoothed;
  if (useSmoothing) {
    if (!buf || buf.length !== density * rows) {
      if (!opts.smoothed) {
        if (density !== lastDensity || rows !== lastRows) {
          smoothed = new Array(density * rows).fill(0.5);
          lastDensity = density; lastRows = rows;
        }
        buf = smoothed;
      } else {
        buf = new Array(density * rows).fill(0.5);
      }
    }
  }

  let sampleData = null;
  if (src && mode !== 'Strips') {
    sampleCanvas.width = sampleCols;
    sampleCanvas.height = sampleRows;
    // Center-crop the source to the canvas aspect ratio so circles/cameras
    // don't get squished when the canvas aspect doesn't match the source.
    const srcW = src.videoWidth || src.naturalWidth || src.width || 1;
    const srcH = src.videoHeight || src.naturalHeight || src.height || 1;
    const srcAr = srcW / srcH;
    const dstAr = sampleCols / sampleRows;
    let sx = 0, sy = 0, sw = srcW, sh = srcH;
    if (srcAr > dstAr) {
      sw = srcH * dstAr;
      sx = (srcW - sw) / 2;
    } else if (srcAr < dstAr) {
      sh = srcW / dstAr;
      sy = (srcH - sh) / 2;
    }
    try {
      sampleCtx.drawImage(src, sx, sy, sw, sh, 0, 0, sampleCols, sampleRows);
      sampleData = sampleCtx.getImageData(0, 0, sampleCols, sampleRows).data;
    } catch (e) {}
  }

  targetCtx.fillStyle = fg;
  targetCtx.strokeStyle = fg;
  targetCtx.lineWidth = stroke;

  for (let i = 0; i < density; i++) {
    for (let j = 0; j < rows; j++) {
      const mapped = mapArtboardUV((i + 0.5) / density, (j + 0.5) / rows);
      let target;
      if (mode === 'Strips') {
        target = stripsValue(mapped.u, mapped.v, time, stripsParams, mapped.direction);
      } else if (sampleData) {
        const sampleX = Math.min(sampleCols - 1, Math.floor(mapped.u * sampleCols));
        const sampleY = Math.min(sampleRows - 1, Math.floor(mapped.v * sampleRows));
        const idx = (sampleY * sampleCols + sampleX) * 4;
        target = (0.299 * sampleData[idx] + 0.587 * sampleData[idx + 1] + 0.114 * sampleData[idx + 2]) / 255;
      } else if (useSmoothing) {
        target = buf[i + j * density] || 0;
      } else {
        target = 0;
      }

      if (invert) target = 1 - target;

      let val;
      if (useSmoothing) {
        if (snapNextFrame) {
          buf[i + j * density] = target;
        } else {
          buf[i + j * density] += (target - buf[i + j * density]) * reactionLerp;
        }
        val = buf[i + j * density];
      } else {
        val = target;
      }

      const x = i * cellSize + cellSize / 2;
      const y = j * cellSize + cellSize / 2;

      // Optional technical effects: scan sweeps a column across and flicker
      // addresses cells like device telemetry. They add to the cell value.
      if (fxActive) {
        const ncx = (i + 0.5) / density, ncy = (j + 0.5) / rows;
        let boost = 0;
        if (scanAmt > 0.001) {
          let d = Math.abs(ncx - scanPos); d = Math.min(d, 1 - d);
          boost += scanAmt * Math.max(0, 1 - d * 10);
        }
        if (flickerAmt > 0.001) {
          const r = _hashCell(i, j, flickerFrame);
          if (r > 0.62) boost += flickerAmt * (0.5 + r * 0.5);
        }
        val += boost;
        if (val < 0) val = 0; else if (val > 1) val = 1;
      }

      // Audio contrast spreads mid-tones before the uniform scale pulse. Both
      // affect Camera/Image/Video as clearly as Strips while preserving geometry.
      if (cellContrastAmt > 0.001) {
        val = _clamp(0.5 + (val - 0.5) * (1 + cellContrastAmt), 0, 1);
      }
      if (pulseAmt > 0.001) val = Math.min(1, val * (1 + pulseAmt));

      // Treat the slider value as the complete visual footprint. Canvas strokes
      // extend half their width beyond both sides of a path, so subtract one
      // stroke width from outlined paths to keep their outer edges in the slot.
      const footprint = cellSize * cellScale * val;
      const size = Math.max(0, footprint - (outline ? stroke : 0));
      const radius = (size / 2) * Math.min(1, Math.max(0, val));

      // Outline mode fades in from the old stability threshold instead of
      // popping on/off as small cells cross a single cutoff.
      const minDraw = outline ? Math.max(2, stroke * 3) : 0.5;
      if (size > minDraw) {
        targetCtx.beginPath();
        if (targetCtx.roundRect) {
          targetCtx.roundRect(x - size / 2, y - size / 2, size, size, radius);
        } else {
          // Fallback for older browsers
          const r = radius;
          const x0 = x - size / 2, y0 = y - size / 2, s = size;
          targetCtx.moveTo(x0 + r, y0);
          targetCtx.arcTo(x0 + s, y0, x0 + s, y0 + s, r);
          targetCtx.arcTo(x0 + s, y0 + s, x0, y0 + s, r);
          targetCtx.arcTo(x0, y0 + s, x0, y0, r);
          targetCtx.arcTo(x0, y0, x0 + s, y0, r);
        }
        if (outline) {
          const fadeSpan = Math.max(4, stroke * 4);
          const alpha = smooth01((size - minDraw) / fadeSpan);
          if (alpha < 1) {
            const prevAlpha = targetCtx.globalAlpha;
            targetCtx.globalAlpha = prevAlpha * alpha;
            targetCtx.stroke();
            targetCtx.globalAlpha = prevAlpha;
          } else {
            targetCtx.stroke();
          }
        } else {
          targetCtx.fill();
        }
      }
    }
  }
}

const MAX_RENDER_FPS = 60;
const RENDER_INTERVAL_MS = 1000 / MAX_RENDER_FPS;
let _lastRafT = 0;
let _renderBudgetMs = RENDER_INTERVAL_MS;
let _lastTickT = 0;
let _fpsElapsed = 0;
let _fpsFrames = 0;

function updateFpsCounter(dt) {
  if (!fpsCounter) return;
  if (!Number.isFinite(dt) || dt <= 0 || dt > 250) {
    _fpsElapsed = 0;
    _fpsFrames = 0;
    return;
  }
  _fpsElapsed += dt;
  _fpsFrames++;
  if (_fpsElapsed >= 500) {
    const measured = Math.round((_fpsFrames * 1000) / _fpsElapsed);
    fpsCounter.textContent = `${Math.min(MAX_RENDER_FPS, measured)} FPS`;
    _fpsElapsed = 0;
    _fpsFrames = 0;
  }
}

function tick(now) {
  requestAnimationFrame(tick);
  if (!_lastRafT) _lastRafT = now;
  else {
    _renderBudgetMs += Math.min(100, Math.max(0, now - _lastRafT));
    _lastRafT = now;
  }
  if (_renderBudgetMs < RENDER_INTERVAL_MS - 0.01) return;
  _renderBudgetMs = Math.max(0, _renderBudgetMs - RENDER_INTERVAL_MS);
  if (_renderBudgetMs > RENDER_INTERVAL_MS * 2) _renderBudgetMs %= RENDER_INTERVAL_MS;

  const rawDt = _lastTickT ? (now - _lastTickT) : RENDER_INTERVAL_MS;
  const dt = Math.min(100, rawDt);
  _lastTickT = now;
  updateFpsCounter(rawDt);
  animClock = now / 1000;   // always-advancing wall clock (drives the per-cell effects in all modes)
  updateGifPlayback(now);

  // Advance the BPM grid + audio first so this frame's modulators read fresh
  // band levels, onsets, and beat ticks.
  if (window.enodeBpm) enodeBpm.update();
  if (window.enodeAudio) {
    enodeAudio.update(dt);
    updateMods(dt);
  }

  // Bass-driven speed surge for the generative mode so Strips visibly
  // moves with the kick. (Video uses a much gentler, smoothed lean below.)
  const speedBoost = applyMods(1, 'timeSpeed');
  // Match the reference oscillator: `time += speed * 0.01` per 60 fps frame,
  // normalized by dt so speed is independent of the display refresh rate.
  if (state.playing && state.mode === 'Strips') {
    time += applyMods(state.strips.speed, 'stripAnim') * 0.01 * (dt / 16.667) * speedBoost;
  }
  // Video: a gentle, heavily-smoothed tempo lean — never the old 0.5–4× lurch.
  if (state.mode === 'Video' && activeVideo && activeVideo.readyState >= 2) {
    const targetRate = 1 + modSum('timeSpeed') * 0.35;   // ~1.0–1.35
    videoRateSmooth += (targetRate - videoRateSmooth) * (1 - Math.exp(-dt / 400));
    const rate = Math.max(0.9, Math.min(1.5, videoRateSmooth));
    if (Math.abs(activeVideo.playbackRate - rate) > 0.01) activeVideo.playbackRate = rate;
  }
  if (state.mode === 'Random' && state.randomAudioDriven) repaintRandomAudio();
  // Detect video loop seam: time goes backward → next frame snaps smoothing
  // to current sample instead of lerping through the stale buffer.
  if (state.mode === 'Video' && activeVideo) {
    const t = activeVideo.currentTime;
    if (t < lastVideoTime - 0.4) snapNextFrame = true;
    lastVideoTime = t;
  }

  drawScene(ctx, canvas.width, canvas.height, { dt });
  snapNextFrame = false;
  if (recording) captureTick(now);
  if (typeof previewTick === 'function') previewTick(dt);
  if (typeof audioVizTick === 'function') audioVizTick();
}

// ─── Tabs ───────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.querySelector(`[data-pane="${tab.dataset.tab}"]`).classList.add('active');
  });
});

// ─── Disclosures ────────────────────────────────────────────────
// Advanced sections ship collapsed so the default sidebar stays rookie-simple;
// everything inside keeps working while hidden.
function wireDisclosure(btnId, panelId) {
  const btn = document.getElementById(btnId);
  const panel = document.getElementById(panelId);
  if (!btn || !panel) return;
  btn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    btn.classList.toggle('open', !panel.hidden);
    const mark = btn.querySelector('.disclosure-mark');
    if (mark) mark.textContent = panel.hidden ? '+' : '–';
  });
}
wireDisclosure('modDisclosure', 'modPanel');
wireDisclosure('stripsDisclosure', 'stripsFine');

// ─── Segmented controls ─────────────────────────────────────────
function wireSeg(id, onChange) {
  const root = document.getElementById(id);
  root.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const wasActive = b.classList.contains('active');
    root.querySelectorAll('button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    onChange(b.dataset.val, wasActive);
  });
}

wireSeg('modeSeg', (val, wasActive) => {
  // Random button on click-when-already-active reshuffles the layout
  if (val === 'Random' && wasActive) {
    state.randomSeed = Math.floor(Math.random() * 1e9);
    regenerateRects();
    return;
  }
  state.mode = val;
  if (val === 'Camera') {
    if (!cameraStream) startCamera();
  } else if (cameraStream || cameraMicStream || (window.enodeAudio && enodeAudio.micActive)) {
    stopCamera();
  }
  if (val === 'Strips') applyStripLook();
  if (val === 'Random') {
    if (state.rects.length === 0) regenerateRects();
    else rebuildRandomSource();
  }
  updateEditorVisibility();
  updateStripsVisibility();
  updateRandomVisibility();
  syncCameraMicUI();
  updateSourcePreview();
});

wireSeg('aspectSeg', val => applyAspect(val));

// ─── Sliders ────────────────────────────────────────────────────
function wireSlider(id, key, valId, fmt) {
  const el = document.getElementById(id);
  const out = document.getElementById(valId);
  el.addEventListener('input', e => {
    const n = parseFloat(e.target.value);
    state[key] = n;
    if (out) out.textContent = fmt ? fmt(n) : n;
    if (state.mode === 'Random' && (key === 'density')) rebuildRandomSource();
  });
}

wireSlider('density', 'density', 'densityVal', n => Math.round(n));
wireSlider('cellSize', 'cellSize', 'cellSizeVal', n => n.toFixed(2));
wireSlider('stroke', 'stroke', 'strokeVal', n => n.toFixed(1));
wireSlider('audioInfluence', 'audioInfluence', 'audioInfluenceVal', n => n.toFixed(2) + '×');

// ─── Strips controls ───────────────────────────────────────────
const stripsGroup = document.getElementById('stripsGroup');

function wireStripSlider(id, key, valId, fmt) {
  const el = document.getElementById(id);
  if (!el) return;
  const out = document.getElementById(valId);
  el.addEventListener('input', e => {
    const n = parseFloat(e.target.value);
    state.strips[key] = n;
    if (out) out.textContent = fmt ? fmt(n) : n;
    clearActiveStripPreset();
  });
}

wireStripSlider('stripCount',    'count',      'stripCountVal',    n => Math.round(n));
wireStripSlider('stripPhase',    'phaseShift', 'stripPhaseVal',    n => n.toFixed(2));
wireStripSlider('stripAmp',      'amplitude',  'stripAmpVal',      n => n.toFixed(2));
wireStripSlider('stripAnim',     'speed',      'stripAnimVal',     n => n.toFixed(1));
wireStripSlider('stripThresh',   'threshold',  'stripThreshVal',   n => n.toFixed(2));
wireStripSlider('stripSoft',     'softness',   'stripSoftVal',     n => n.toFixed(2));
wireStripSlider('stripContrast', 'contrast',   'stripContrastVal', n => n.toFixed(1));
wireStripSlider('stripQuant',    'levels',     'stripQuantVal',    n => Math.round(n));

const stripModeSel = document.getElementById('stripMode');
stripModeSel.addEventListener('change', e => {
  state.strips.phaseMode = e.target.value;
  clearActiveStripPreset();
});

// The reference sketch's four presets, value-for-value. Each sets only the
// strip dynamics + grid density; the shared look comes from STRIP_LOOK below.
// (The sketch's "direct render" — raw grayscale blocks bypassing the grid —
// was dropped: strips always drive the brand dot pattern.)
const STRIP_PRESETS = {
  fluid:    { density: 100, strips: { count: 12, phaseShift: 0.8, amplitude: 0.5, phaseMode: 'Sine',   threshold: 1.0, softness: 0.10, contrast: 1.2, levels: 0, speed: 0.5 } },
  glitch:   { density: 120, strips: { count: 32, phaseShift: 2.5, amplitude: 1.2, phaseMode: 'Random', threshold: 0.8, softness: 0.01, contrast: 2.0, levels: 4, speed: 1.2 } },
  minimal:  { density: 80,  strips: { count: 5,  phaseShift: 0.2, amplitude: 0.1, phaseMode: 'Linear', threshold: 0.9, softness: 0.05, contrast: 1.0, levels: 8, speed: 0.3 } },
  vertical: { density: 100, strips: { count: 20, phaseShift: 0.5, amplitude: 0.3, phaseMode: 'Sine',   threshold: 1.0, softness: 0.02, contrast: 0.8, levels: 0, speed: 0.4 } },
};

// The reference sketch's default look — applied once, the first time the user
// enters Strips mode: the grey-on-grey outlined-squircle aesthetic. (The heavy
// smoothing essential to the fluid feel is applied per-mode in drawScene.)
const STRIP_LOOK = { density: 88, outline: true, stroke: 1, fg: '#919191', bg: '#DBD8D8' };
let stripLookApplied = false;
function applyStripLook() {
  if (stripLookApplied) return;
  stripLookApplied = true;
  Object.assign(state, STRIP_LOOK);
  syncStripLookUI();
}

function applyStripPreset(name) {
  const p = STRIP_PRESETS[name];
  if (!p) return;
  Object.assign(state.strips, p.strips);
  state.density = p.density;
  syncStripsUI();
  syncStripLookUI();
  document.querySelectorAll('#stripsPresets button').forEach(b => {
    b.classList.toggle('active', b.dataset.preset === name);
  });
}

// Sync the global controls the strips look/presets touch so the controls and
// swatches reflect the applied look.
function syncStripLookUI() {
  const setSlider = (id, valId, value, fmt) => {
    const el = document.getElementById(id);
    if (el) el.value = value;
    const out = document.getElementById(valId);
    if (out) out.textContent = fmt ? fmt(value) : value;
  };
  setSlider('density',  'densityVal',  state.density,  n => Math.round(n));
  setSlider('stroke',   'strokeVal',   state.stroke,   n => n.toFixed(1));
  const outlineChip = document.getElementById('chipOutline');
  if (outlineChip) outlineChip.classList.toggle('active', state.outline);
  const strokeRow = document.getElementById('strokeRow');
  if (strokeRow) strokeRow.style.display = state.outline ? '' : 'none';
  const fgSw = document.getElementById('fgSwatch');
  const bgSw = document.getElementById('bgSwatch');
  if (fgSw) fgSw.style.background = state.fg;
  if (bgSw) bgSw.style.background = state.bg;
}

function clearActiveStripPreset() {
  document.querySelectorAll('#stripsPresets button.active').forEach(b => b.classList.remove('active'));
}

function syncStripsUI() {
  const s = state.strips;
  const setS = (id, valId, value, fmt) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = value;
    const out = valId && document.getElementById(valId);
    if (out) out.textContent = fmt ? fmt(value) : value;
  };
  setS('stripCount',    'stripCountVal',    s.count,      n => Math.round(n));
  setS('stripPhase',    'stripPhaseVal',    s.phaseShift, n => n.toFixed(2));
  setS('stripAmp',      'stripAmpVal',      s.amplitude,  n => n.toFixed(2));
  setS('stripAnim',     'stripAnimVal',     s.speed,      n => n.toFixed(1));
  setS('stripThresh',   'stripThreshVal',   s.threshold,  n => n.toFixed(2));
  setS('stripSoft',     'stripSoftVal',     s.softness,   n => n.toFixed(2));
  setS('stripContrast', 'stripContrastVal', s.contrast,   n => n.toFixed(1));
  setS('stripQuant',    'stripQuantVal',    s.levels,     n => Math.round(n));
  if (stripModeSel) stripModeSel.value = s.phaseMode;
}

document.getElementById('stripsPresets').addEventListener('click', e => {
  const b = e.target.closest('button[data-preset]');
  if (!b) return;
  applyStripPreset(b.dataset.preset);
});

function updateStripsVisibility() {
  stripsGroup.style.display = state.mode === 'Strips' ? '' : 'none';
}

function updateRandomVisibility() {
  const el = document.getElementById('randomGroup');
  if (el) el.style.display = state.mode === 'Random' ? '' : 'none';
}

// Audio-driven Random rectangles
const randomAudioToggle = document.getElementById('randomAudioToggle');
randomAudioToggle.addEventListener('click', () => {
  state.randomAudioDriven = !state.randomAudioDriven;
  randomAudioToggle.classList.toggle('active', state.randomAudioDriven);
  // Repaint immediately so the visual reflects the toggle on next frame even
  // when audio is silent (resets to black) or rebuilds to original brightness.
  if (state.randomAudioDriven) repaintRandomAudio();
  else rebuildRandomSource();
});

// Big toggle chips replace the old <input type=checkbox> controls.
const chipInvert = document.getElementById('chipInvert');
const chipOutline = document.getElementById('chipOutline');
const chipGradient = document.getElementById('chipGradient');

chipInvert.addEventListener('click', () => {
  state.invert = !state.invert;
  chipInvert.classList.toggle('active', state.invert);
});
chipOutline.addEventListener('click', () => {
  state.outline = !state.outline;
  chipOutline.classList.toggle('active', state.outline);
  document.getElementById('strokeRow').style.display = state.outline ? '' : 'none';
});
chipGradient.addEventListener('click', () => {
  state.gradient = !state.gradient;
  chipGradient.classList.toggle('active', state.gradient);
  if (state.mode === 'Random') rebuildRandomSource();
});

// Color combo presets — pair of (fg, bg) one-click
document.querySelectorAll('.combo').forEach(c => {
  c.addEventListener('click', () => {
    state.fg = c.dataset.fg;
    state.bg = c.dataset.bg;
    document.getElementById('fgSwatch').style.background = state.fg;
    document.getElementById('bgSwatch').style.background = state.bg;
  });
});

document.getElementById('swapColors').addEventListener('click', () => {
  const tmp = state.fg;
  state.fg = state.bg;
  state.bg = tmp;
  document.getElementById('fgSwatch').style.background = state.fg;
  document.getElementById('bgSwatch').style.background = state.bg;
});

// ─── Artboard transform island ──────────────────────────────────
const rotateArtboardBtn = document.getElementById('rotateArtboard');
const flipArtboardXBtn = document.getElementById('flipArtboardX');
const flipArtboardYBtn = document.getElementById('flipArtboardY');
const resetArtboardBtn = document.getElementById('resetArtboard');
const patternMenuBtn = document.getElementById('patternMenuBtn');
const patternCurrentIcon = document.getElementById('patternCurrentIcon');
const patternPopover = document.getElementById('patternPopover');
const patternGrid = document.getElementById('patternGrid');

function patternArrowSvg(direction, cx, cy, length) {
  const vectors = {
    up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
  };
  const [dx, dy] = vectors[direction] || vectors.down;
  const half = length / 2;
  const sx = cx - dx * half;
  const sy = cy - dy * half;
  const ex = cx + dx * half;
  const ey = cy + dy * half;
  const head = Math.max(2.2, length * 0.26);
  const px = -dy;
  const py = dx;
  const hx = ex - dx * head;
  const hy = ey - dy * head;
  return `<path d="M${sx} ${sy}L${ex} ${ey}M${ex} ${ey}L${hx + px * head * 0.65} ${hy + py * head * 0.65}M${ex} ${ey}L${hx - px * head * 0.65} ${hy - py * head * 0.65}"/>`;
}

function patternIconSvg(patternId) {
  const preset = ARTBOARD_PATTERN_MAP[patternId] || ARTBOARD_PATTERN_MAP['single-down'];
  let dividers = '';
  let arrows = '';
  if (preset.layout === 'single') {
    arrows = patternArrowSvg(preset.directions[0], 24, 18, 15);
  } else if (preset.layout === 'split-x' || preset.layout === 'mirror-x') {
    dividers = '<path d="M24 2v32"/>';
    arrows = patternArrowSvg(preset.directions[0], 12, 18, 10)
      + patternArrowSvg(preset.directions[1], 36, 18, 10);
  } else {
    dividers = '<path d="M24 2v32M2 18h44"/>';
    arrows = patternArrowSvg(preset.directions[0], 12, 9, 8)
      + patternArrowSvg(preset.directions[1], 36, 9, 8)
      + patternArrowSvg(preset.directions[2], 12, 27, 8)
      + patternArrowSvg(preset.directions[3], 36, 27, 8);
  }
  return `<svg viewBox="0 0 48 36" aria-hidden="true"><rect x="1.5" y="1.5" width="45" height="33" rx="1.5"/>${dividers}${arrows}</svg>`;
}

function buildPatternMenu() {
  patternGrid.innerHTML = ARTBOARD_PATTERNS.map(p => `
    <button class="pattern-option" type="button" role="menuitem" data-pattern="${p.id}" aria-label="${p.label}">
      <span class="pattern-diagram">${patternIconSvg(p.id)}</span>
      <span class="pattern-label">${p.label}</span>
    </button>
  `).join('');
}

function resetTransformSmoothing() {
  smoothed = [];
  lastDensity = 0;
  lastRows = 0;
  snapNextFrame = true;
}

function syncOutputControlsToCanvas() {
  const sel = document.getElementById('resSelect');
  const customRes = document.getElementById('customRes');
  const customW = document.getElementById('customW');
  const customH = document.getElementById('customH');
  const key = `${state.exportW}x${state.exportH}`;
  const exact = sel && [...sel.options].some(o => o.value === key);
  if (sel) sel.value = exact ? key : 'custom';
  if (customRes) customRes.style.display = exact ? 'none' : '';
  if (customW) customW.value = state.exportW;
  if (customH) customH.value = state.exportH;

  const ratioMap = { '1:1': 1, '4:5': 4 / 5, '9:16': 9 / 16, '16:9': 16 / 9, '3:2': 3 / 2 };
  const ratio = state.exportW / state.exportH;
  let matched = null;
  for (const [name, value] of Object.entries(ratioMap)) {
    if (Math.abs(ratio - value) < 0.001) { matched = name; break; }
  }
  state.aspect = matched || 'custom';
  document.querySelectorAll('#aspectSeg button').forEach(b => {
    b.classList.toggle('active', b.dataset.val === matched);
  });
}

function syncArtboardTools() {
  const a = state.artboard;
  rotateArtboardBtn.classList.toggle('active', a.rotation !== 0);
  flipArtboardXBtn.classList.toggle('active', a.flipX);
  flipArtboardYBtn.classList.toggle('active', a.flipY);
  patternMenuBtn.classList.toggle('active', a.pattern !== 'single-down');
  patternCurrentIcon.innerHTML = patternIconSvg(a.pattern);
  patternGrid.querySelectorAll('.pattern-option').forEach(b => {
    b.classList.toggle('active', b.dataset.pattern === a.pattern);
  });
}

function closePatternMenu() {
  patternPopover.hidden = true;
  patternMenuBtn.setAttribute('aria-expanded', 'false');
}

rotateArtboardBtn.addEventListener('click', () => {
  const oldW = state.exportW;
  const oldH = state.exportH;
  state.artboard.rotation = (state.artboard.rotation + 1) % 4;
  setExportSize(oldH, oldW, { preserveRandomSource: true });
  syncOutputControlsToCanvas();
  syncArtboardTools();
  updateEditorVisibility();
});

flipArtboardXBtn.addEventListener('click', () => {
  state.artboard.flipX = !state.artboard.flipX;
  resetTransformSmoothing();
  syncArtboardTools();
  updateEditorVisibility();
});

flipArtboardYBtn.addEventListener('click', () => {
  state.artboard.flipY = !state.artboard.flipY;
  resetTransformSmoothing();
  syncArtboardTools();
  updateEditorVisibility();
});

resetArtboardBtn.addEventListener('click', () => {
  const wasOdd = state.artboard.rotation % 2 === 1;
  state.artboard.rotation = 0;
  state.artboard.flipX = false;
  state.artboard.flipY = false;
  state.artboard.pattern = 'single-down';
  if (wasOdd) {
    setExportSize(state.exportH, state.exportW, { preserveRandomSource: true });
    syncOutputControlsToCanvas();
  } else {
    resetTransformSmoothing();
  }
  syncArtboardTools();
  updateEditorVisibility();
});

patternMenuBtn.addEventListener('click', e => {
  e.stopPropagation();
  patternPopover.hidden = !patternPopover.hidden;
  patternMenuBtn.setAttribute('aria-expanded', String(!patternPopover.hidden));
});

patternGrid.addEventListener('click', e => {
  const button = e.target.closest('.pattern-option');
  if (!button) return;
  state.artboard.pattern = button.dataset.pattern;
  resetTransformSmoothing();
  syncArtboardTools();
  updateEditorVisibility();
  closePatternMenu();
});

document.addEventListener('click', e => {
  if (!e.target.closest('.island-menu-wrap')) closePatternMenu();
});

buildPatternMenu();
syncArtboardTools();

// Mode-specific rectangle editor lives in the same floating island.
const canvasEditBtn = document.getElementById('canvasEditBtn');
canvasEditBtn.addEventListener('click', () => {
  if (canvasEditBtn.disabled) return;
  state.editRects = !state.editRects;
  canvasEditBtn.classList.toggle('active', state.editRects);
  canvasEditBtn.setAttribute('aria-label', state.editRects ? 'Finish editing rectangles' : 'Edit rectangles');
  canvasEditBtn.dataset.tip = state.editRects ? 'Finish editing rectangles' : 'Edit rectangles';
  updateEditorVisibility();
});

// ─── Drag/drop & file loading ───────────────────────────────────
function loadFile(file) {
  if (!file) return;
  const isGif = file.type === 'image/gif' || /\.gif$/i.test(file.name || '');
  if (isGif) {
    setGifSource(file, { matchAspect: true });
    state.mode = 'Image';
    syncModeUI();
  } else if (file.type.startsWith('image/')) {
    const url = URL.createObjectURL(file);
    setImageSource(url, { matchAspect: true });
    state.mode = 'Image';
    syncModeUI();
  } else if (file.type.startsWith('video/')) {
    const url = URL.createObjectURL(file);
    setVideoSource(url, { matchAspect: true });
    state.mode = 'Video';
    syncModeUI();
  } else if (file.type.startsWith('audio/')) {
    const url = URL.createObjectURL(file);
    loadAudioTrack(url, file.name.replace(/\.[^.]+$/, ''));
  }
}

function syncModeUI() {
  document.querySelectorAll('#modeSeg button').forEach(b => {
    b.classList.toggle('active', b.dataset.val === state.mode);
  });
  updateEditorVisibility();
  updateStripsVisibility();
  updateRandomVisibility();
  syncCameraMicUI();
  updateSourcePreview();
}

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => loadFile(e.target.files[0]));

['dragenter', 'dragover'].forEach(ev => {
  dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.add('over'); });
});
['dragleave', 'drop'].forEach(ev => {
  dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.remove('over'); });
});
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  loadFile(e.dataTransfer.files[0]);
});

// Whole-stage drag/drop
['dragenter', 'dragover'].forEach(ev => {
  window.addEventListener(ev, e => {
    if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      dropOverlay.classList.add('active');
    }
  });
});
['dragleave', 'drop'].forEach(ev => {
  window.addEventListener(ev, e => {
    if (e.relatedTarget === null || ev === 'drop') {
      dropOverlay.classList.remove('active');
    }
  });
});
window.addEventListener('drop', e => {
  e.preventDefault();
  dropOverlay.classList.remove('active');
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});

// ─── Color picker ───────────────────────────────────────────────
const picker = document.getElementById('picker');
const pickerSV = document.getElementById('pickerSV');
const pickerSVHandle = document.getElementById('pickerSVHandle');
const pickerHue = document.getElementById('pickerHue');
const pickerHueHandle = document.getElementById('pickerHueHandle');
const pickerHex = document.getElementById('pickerHex');
const pickerPresets = document.getElementById('pickerPresets');

const PRESETS = ['#000000', '#1a1a1a', '#333333', '#666666', '#999999', '#cccccc', '#e6e6e6', '#ffffff',
                 '#ff3a2f', '#ffae00', '#ffd400', '#00d28d', '#00a8e8', '#3340ff', '#a83cff', '#ff37c0'];
PRESETS.forEach(c => {
  const b = document.createElement('button');
  b.className = 'picker-preset';
  b.style.background = c;
  b.addEventListener('click', () => setPickerColor(c, true));
  pickerPresets.appendChild(b);
});

let pickerTarget = null;
let pickerH = 0, pickerS = 0, pickerV = 0; // HSV 0..1

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h = (h * 60 + 360) % 360;
  return { h: h / 360, s: max === 0 ? 0 : d / max, v: max };
}

function hsvToHex(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  const toHex = n => Math.round(n * 255).toString(16).padStart(2, '0');
  return '#' + toHex(r) + toHex(g) + toHex(b);
}

function updatePickerVisual() {
  pickerSV.querySelector('.picker-sv-grad-s').style.background =
    `linear-gradient(to right, #fff, ${hsvToHex(pickerH, 1, 1)})`;
  pickerSVHandle.style.left = (pickerS * 100) + '%';
  pickerSVHandle.style.top = ((1 - pickerV) * 100) + '%';
  pickerHueHandle.style.left = (pickerH * 100) + '%';
  const hex = hsvToHex(pickerH, pickerS, pickerV);
  pickerHex.value = hex.toUpperCase();
  if (pickerTarget) {
    state[pickerTarget] = hex;
    document.getElementById(pickerTarget + 'Swatch').style.background = hex;
  }
}

function setPickerColor(hex, sync) {
  const rgb = hexToRgb(hex);
  const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
  pickerH = hsv.h; pickerS = hsv.s; pickerV = hsv.v;
  updatePickerVisual();
}

document.querySelectorAll('.swatch').forEach(sw => {
  sw.addEventListener('click', e => {
    e.stopPropagation();
    pickerTarget = sw.dataset.target;
    setPickerColor(state[pickerTarget], false);
    const r = sw.getBoundingClientRect();
    picker.style.display = 'block';
    // Position: aim left of sidebar, vertically centered on swatch
    const pw = 220 + 22, ph = 280;
    let left = r.left - pw;
    if (left < 8) left = 8;
    let top = r.top;
    if (top + ph > window.innerHeight - 8) top = window.innerHeight - ph - 8;
    picker.style.left = left + 'px';
    picker.style.top = top + 'px';
  });
});

document.addEventListener('click', e => {
  if (picker.style.display === 'block' && !picker.contains(e.target) && !e.target.classList.contains('swatch')) {
    picker.style.display = 'none';
  }
});

function dragArea(el, handler) {
  const update = e => {
    const r = el.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    handler(Math.max(0, Math.min(1, (cx - r.left) / r.width)),
            Math.max(0, Math.min(1, (cy - r.top) / r.height)));
  };
  el.addEventListener('mousedown', e => {
    update(e);
    const move = ev => update(ev);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

dragArea(pickerSV, (x, y) => { pickerS = x; pickerV = 1 - y; updatePickerVisual(); });
dragArea(pickerHue, x => { pickerH = x; updatePickerVisual(); });

pickerHex.addEventListener('change', e => {
  let v = e.target.value.trim();
  if (!v.startsWith('#')) v = '#' + v;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) setPickerColor(v, true);
  else e.target.value = hsvToHex(pickerH, pickerS, pickerV).toUpperCase();
});

// Init swatches
document.getElementById('fgSwatch').style.background = state.fg;
document.getElementById('bgSwatch').style.background = state.bg;

// ─── Variations modal ──────────────────────────────────────────
const modal = document.getElementById('modal');
const modalGrid = document.getElementById('modalGrid');
const modalClose = document.getElementById('modalClose');
const modalReroll = document.getElementById('modalReroll');
const modalBackdrop = document.getElementById('modalBackdrop');
const variationsBtn = document.getElementById('variationsBtn');

function snapshotSource() {
  // Capture current source frame into an offscreen canvas so all 9 previews
  // sample the same instant (no drift across the 9 renders).
  const src = currentSource();
  if (!src) return null;
  const cv = document.createElement('canvas');
  const sw = src.videoWidth || src.naturalWidth || src.width;
  const sh = src.videoHeight || src.naturalHeight || src.height;
  if (!sw || !sh) return null;
  cv.width = sw; cv.height = sh;
  cv.getContext('2d').drawImage(src, 0, 0);
  return cv;
}

let frozenSource = null;
let variationPresets = [];

// The state fields a variation carries. Thumbnails render by swapping these
// into state (drawScene reads them from there), then restoring the snapshot.
const VARIATION_KEYS = ['density', 'invert', 'outline', 'stroke', 'fg', 'bg', 'randomSeed'];

function makeVariations() {
  // 9 randomized combos across geometry, style and color — not just grid size,
  // so the tiles read as genuinely different directions, not nudges.
  const rng = mulberry32(Math.floor(Math.random() * 1e9));
  // Current colors weighted highest, then the three preset combos.
  const comboChoices = [
    { fg: state.fg, bg: state.bg },
    { fg: state.fg, bg: state.bg },
    { fg: state.fg, bg: state.bg },
    { fg: '#000000', bg: '#FFFFFF' },
    { fg: '#FFFFFF', bg: '#000000' },
    { fg: '#FF3A2F', bg: '#0a0a0a' },
  ];
  // Shuffled density deck cycled across the tiles guarantees a spread of
  // coarse-to-fine grids instead of clustering near one value.
  const densityDeck = [16, 28, 44, 60, 80, 100].sort(() => rng() - 0.5);
  const stripNames = Object.keys(STRIP_PRESETS);
  variationPresets = [];
  for (let i = 0; i < 9; i++) {
    const combo = comboChoices[Math.floor(rng() * comboChoices.length)];
    const outline = rng() < 0.2;
    variationPresets.push({
      density: densityDeck[i % densityDeck.length],
      invert: rng() < 0.35,
      outline,
      stroke: outline ? 1 + Math.round(rng()) : state.stroke,
      fg: combo.fg,
      bg: combo.bg,
      randomSeed: Math.floor(rng() * 1e9),
      strips: state.mode === 'Strips'
        ? { ...state.strips, ...STRIP_PRESETS[stripNames[Math.floor(rng() * stripNames.length)]].strips }
        : null,
    });
  }
}

function openVariations() {
  frozenSource = snapshotSource(); // null is fine; renderer falls back gracefully
  makeVariations();
  renderVariations();
  modal.style.display = 'flex';
}

function closeVariations() {
  modal.style.display = 'none';
  modalGrid.innerHTML = '';
  frozenSource = null;
}

function applyVariationToState(preset) {
  for (const k of VARIATION_KEYS) state[k] = preset[k];
  if (preset.strips) Object.assign(state.strips, preset.strips);
}

function renderVariations() {
  modalGrid.innerHTML = '';
  const tileSize = 240;
  const ar = state.exportW / state.exportH;
  const tw = tileSize, th = Math.round(tileSize / ar);
  variationPresets.forEach(preset => {
    const tile = document.createElement('div');
    tile.className = 'modal-tile';
    tile.style.aspectRatio = `${state.exportW}/${state.exportH}`;
    const cv = document.createElement('canvas');
    cv.width = tw; cv.height = th;
    const c2 = cv.getContext('2d');

    // Render with the preset's params swapped into state, then restore.
    const snapshot = {};
    for (const k of VARIATION_KEYS) snapshot[k] = state[k];
    const stripsSnapshot = { ...state.strips };
    applyVariationToState(preset);

    let sourceOverride = null;
    if (state.mode === 'Random') {
      sourceOverride = buildRandomCanvas(preset.randomSeed, state.exportW, state.exportH, state.gradient);
    } else if (frozenSource) {
      sourceOverride = frozenSource;
    }
    drawScene(c2, tw, th, { noSmoothing: true, sourceOverride });

    Object.assign(state, snapshot);
    Object.assign(state.strips, stripsSnapshot);

    tile.appendChild(cv);
    const meta = document.createElement('div');
    meta.className = 'modal-tile-meta';
    const flags = [preset.invert && 'inv', preset.outline && 'out'].filter(Boolean);
    meta.textContent = [preset.density, ...flags].join(' · ');
    tile.appendChild(meta);

    tile.addEventListener('click', () => {
      applyVariationToState(preset);
      if (state.mode === 'Random') regenerateRects();
      // Sync UI: sliders/chips/swatches for everything a variation can touch.
      syncStripLookUI();
      syncStripsUI();
      clearActiveStripPreset();
      chipInvert.classList.toggle('active', state.invert);
      closeVariations();
    });

    modalGrid.appendChild(tile);
  });
}

// Helper for variations + exports: build a random-source canvas off-state.
function buildRandomCanvas(seed, exportW, exportH, useGradient) {
  const cv = document.createElement('canvas');
  const [canonicalW, canonicalH] = canonicalArtboardSize(exportW, exportH);
  const W = 512, H = Math.round(512 * canonicalH / canonicalW);
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.fillStyle = '#808080';
  c.fillRect(0, 0, W, H);
  const rects = generateRandomLayout(seed);
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const grads = rects.map(() => ({ angle: Math.floor(rng() * 4) * 90, delta: 0.18 + rng() * 0.22 }));
  paintRectsTo(c, rects, W, H, useGradient ? grads : null);
  return cv;
}

variationsBtn.addEventListener('click', openVariations);
modalClose.addEventListener('click', closeVariations);
modalBackdrop.addEventListener('click', closeVariations);
modalReroll.addEventListener('click', () => { makeVariations(); renderVariations(); });

// ─── Export: PNG ───────────────────────────────────────────────
function getExportSize() {
  const sel = document.getElementById('resSelect');
  if (sel.value === 'custom') {
    return [parseInt(document.getElementById('customW').value) || 1080,
            parseInt(document.getElementById('customH').value) || 1080];
  }
  const [w, h] = sel.value.split('x').map(n => parseInt(n));
  return [w, h];
}

document.getElementById('resSelect').addEventListener('change', e => {
  document.getElementById('customRes').style.display = e.target.value === 'custom' ? '' : 'none';
  const [w, h] = getExportSize();
  setExportSize(w, h);
});

['customW', 'customH'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => {
    const [w, h] = getExportSize();
    setExportSize(w, h);
  });
});

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

document.getElementById('exportPNG').addEventListener('click', () => {
  // WYSIWYG: the live canvas bitmap is already at export resolution (the res
  // select drives setExportSize), so a direct snapshot captures smoothing,
  // modulation and FX exactly as on screen.
  canvas.toBlob(blob => {
    downloadBlob(blob, `enode-${canvas.width}x${canvas.height}.png`);
  }, 'image/png');
});

// ─── Export: SVG ───────────────────────────────────────────────
// Vector freeze-frame of the live render: cells come straight from the current
// smoothed buffer (post-invert, exactly what the canvas just drew), scaled
// from the live grid onto the requested export size.
function buildSVG(w, h) {
  const density = lastDensity || Math.floor(state.density);
  const rows = lastRows || Math.ceil(h / (w / Math.max(1, density)));
  const cellSize = w / density;
  const cellScale = _clamp(state.cellSize, 0, MAX_CELL_SIZE);

  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`];
  parts.push(`<rect width="${w}" height="${h}" fill="${state.bg}"/>`);
  parts.push('<g>');

  for (let i = 0; i < density; i++) {
    for (let j = 0; j < rows; j++) {
      const v = smoothed[i + j * density] || 0;
      const footprint = cellSize * cellScale * v;
      const size = Math.max(0, footprint - (state.outline ? state.stroke : 0));
      const minDrawSvg = state.outline ? Math.max(2, state.stroke * 3) : 0.5;
      if (size < minDrawSvg) continue;
      const opacity = state.outline ? smooth01((size - minDrawSvg) / Math.max(4, state.stroke * 4)) : 1;
      if (opacity <= 0) continue;
      const x = i * cellSize + cellSize / 2 - size / 2;
      const y = j * cellSize + cellSize / 2 - size / 2;
      const r = (size / 2) * Math.min(1, Math.max(0, v));
      const opacityAttr = state.outline && opacity < 1 ? ` opacity="${opacity.toFixed(3)}"` : '';
      const fillOrStroke = state.outline
        ? `fill="none" stroke="${state.fg}" stroke-width="${state.stroke}"${opacityAttr}`
        : `fill="${state.fg}"`;
      parts.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${size.toFixed(2)}" height="${size.toFixed(2)}" rx="${r.toFixed(2)}" ry="${r.toFixed(2)}" ${fillOrStroke}/>`);
    }
  }
  parts.push('</g></svg>');
  return parts.join('');
}

document.getElementById('exportSVG').addEventListener('click', () => {
  const [w, h] = getExportSize();
  const svg = buildSVG(w, h);
  downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `enode-${w}x${h}.svg`);
});

// ─── Export: MP4 / PNG sequence (real-time capture) ────────────
// Records the live canvas while it renders, so smoothing, audio modulation and
// FX land in the file exactly as seen — a 10 s export records for 10 s.
// captureTick() (called from tick() after drawScene) copies the canvas into
// the recorder at 60 fps slots; the recording object supplies captureFrame()
// and finish() per format.
const VIDEO_FPS = 60;
let gifExportFps = 30;
let recording = null;

// For Video mode, match the source duration for a seamless loop.
function exportDuration() {
  let durationSec = parseFloat(durationSlider.value);
  if (state.mode === 'Video' && activeVideo && isFinite(activeVideo.duration) && activeVideo.duration > 0) {
    durationSec = activeVideo.duration;
  }
  return durationSec;
}

function captureTick(nowMs) {
  const r = recording;
  const elapsed = nowMs - r.startMs;
  while (r.slot < r.totalFrames && r.slot * (1000 / r.fps) <= elapsed) {
    r.ctx.drawImage(canvas, 0, 0);
    r.captureFrame(r.slot);
    r.slot++;
  }
  r.btn.textContent = `Recording ${Math.min(elapsed / 1000, r.durationSec).toFixed(1)}s / ${r.durationSec.toFixed(1)}s`;
  if (r.slot >= r.totalFrames) {
    recording = null;
    r.finish();
  }
}

function startRecording(opts) {
  const recCanvas = document.createElement('canvas');
  recCanvas.width = opts.fw;
  recCanvas.height = opts.fh;
  recording = {
    startMs: performance.now(),
    slot: 0,
    canvas: recCanvas,
    ctx: recCanvas.getContext('2d'),
    fps: opts.fps || VIDEO_FPS,
    ...opts,
  };
}

let _mp4Mod = null;
let activeGifWorker = null;
async function getMp4Muxer() {
  if (_mp4Mod) return _mp4Mod;
  _mp4Mod = await import(new URL('vendor/mp4-muxer.mjs', document.baseURI).href);
  return _mp4Mod;
}

const durationSlider = document.getElementById('duration');
const durVal = document.getElementById('durVal');
wireSeg('gifFpsSeg', val => {
  gifExportFps = val === '60' ? 60 : 30;
});
durationSlider.addEventListener('input', e => {
  durVal.textContent = parseFloat(e.target.value).toFixed(1) + 's';
});

document.getElementById('exportMP4').addEventListener('click', async () => {
  const btn = document.getElementById('exportMP4');
  if (recording || activeGifWorker || btn.classList.contains('recording')) return;
  if (typeof VideoEncoder === 'undefined') {
    alert('MP4 export requires WebCodecs. Use Chrome or Edge.');
    return;
  }

  // Capture at the live canvas resolution (= the selected export resolution).
  const fw = canvas.width & ~1, fh = canvas.height & ~1; // H.264 needs even dims
  const durationSec = exportDuration();
  const totalFrames = Math.max(1, Math.round(durationSec * VIDEO_FPS));

  btn.classList.add('recording');
  btn.textContent = 'Initializing…';

  let muxer, encoder, muxerTarget;
  try {
    const { Muxer, ArrayBufferTarget } = await getMp4Muxer();
    muxerTarget = new ArrayBufferTarget();
    muxer = new Muxer({
      target: muxerTarget,
      video: { codec: 'avc', width: fw, height: fh },
      fastStart: 'in-memory',
    });
    encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: e => console.error('VideoEncoder error:', e),
    });
    encoder.configure({
      codec: 'avc1.640034',
      width: fw, height: fh,
      bitrate: Math.min(50_000_000, Math.max(6_000_000, Math.round(fw * fh * VIDEO_FPS * 0.25))),
      framerate: VIDEO_FPS,
    });
  } catch (e) {
    console.error(e);
    alert('Encoder init failed: ' + e.message);
    btn.classList.remove('recording');
    btn.textContent = 'Export MP4';
    return;
  }

  startRecording({
    fw, fh, totalFrames, durationSec, btn, fps: VIDEO_FPS,
    captureFrame(slot) {
      const frame = new VideoFrame(this.canvas, { timestamp: slot * (1_000_000 / VIDEO_FPS) });
      encoder.encode(frame, { keyFrame: slot % VIDEO_FPS === 0 });
      frame.close();
    },
    async finish() {
      btn.textContent = 'Finalizing…';
      try {
        await encoder.flush();
        muxer.finalize();
        downloadBlob(new Blob([muxerTarget.buffer], { type: 'video/mp4' }), `enode-${fw}x${fh}.mp4`);
      } catch (e) {
        console.error(e);
        alert('Finalize failed: ' + e.message);
      }
      btn.classList.remove('recording');
      btn.textContent = 'Export MP4';
    },
  });
});

// ─── Export: animated GIF (selectable 30/60fps, worker encoded) ─
document.getElementById('exportGIF').addEventListener('click', () => {
  const btn = document.getElementById('exportGIF');
  if (recording || activeGifWorker || btn.classList.contains('recording')) return;
  if (typeof Worker === 'undefined') {
    alert('Animated GIF export requires Web Worker support.');
    return;
  }

  const fw = canvas.width;
  const fh = canvas.height;
  if (fw * fh > 4_000_000) {
    alert('GIF export is limited to 4 megapixels. Choose a smaller output resolution.');
    return;
  }

  const durationSec = exportDuration();
  const fps = gifExportFps;
  const totalFrames = Math.max(1, Math.round(durationSec * fps));
  const worker = new Worker(new URL('js/gif-worker.js', document.baseURI), { type: 'module' });
  activeGifWorker = worker;
  btn.classList.add('recording');
  btn.textContent = 'Initializing…';
  let settled = false;

  const cleanup = () => {
    if (activeGifWorker === worker) activeGifWorker = null;
    worker.terminate();
    btn.classList.remove('recording');
    btn.textContent = 'Export GIF';
  };

  const fail = message => {
    if (settled) return;
    settled = true;
    if (recording && recording.btn === btn) recording = null;
    console.error('GIF export failed:', message);
    alert('GIF export failed: ' + message);
    cleanup();
  };

  worker.addEventListener('message', event => {
    const message = event.data || {};
    if (message.type === 'progress') {
      if (!recording || recording.btn !== btn) {
        btn.textContent = `Encoding ${message.encoded} / ${message.total}`;
      }
    } else if (message.type === 'done') {
      if (settled) return;
      settled = true;
      downloadBlob(new Blob([message.buffer], { type: 'image/gif' }), `enode-${fw}x${fh}-${fps}fps.gif`);
      cleanup();
    } else if (message.type === 'error') {
      fail(message.message || 'Unknown encoder error');
    }
  });
  worker.addEventListener('error', event => fail(event.message || 'Worker could not start'));

  worker.postMessage({ type: 'init', width: fw, height: fh, fps, totalFrames });
  startRecording({
    fw, fh, totalFrames, durationSec, btn, fps,
    captureFrame() {
      const image = this.ctx.getImageData(0, 0, fw, fh);
      worker.postMessage({ type: 'frame', rgba: image.data.buffer }, [image.data.buffer]);
    },
    finish() {
      btn.textContent = 'Encoding…';
      worker.postMessage({ type: 'finish' });
    },
  });
});

// ─── Export: PNG sequence (zip, real-time capture) ─────────────
document.getElementById('exportPNGseq').addEventListener('click', () => {
  const btn = document.getElementById('exportPNGseq');
  if (recording || activeGifWorker || btn.classList.contains('recording')) return;
  if (typeof JSZip === 'undefined') {
    alert('JSZip not loaded — cannot package frame sequence.');
    return;
  }

  const fw = canvas.width, fh = canvas.height;
  const durationSec = exportDuration();
  const totalFrames = Math.max(1, Math.round(durationSec * VIDEO_FPS));
  const frames = new Array(totalFrames);
  let pending = 0;

  btn.classList.add('recording');

  startRecording({
    fw, fh, totalFrames, durationSec, btn, fps: VIDEO_FPS,
    captureFrame(slot) {
      // toBlob copies the bitmap synchronously and encodes async — safe to
      // reuse the recorder canvas for the next slot immediately.
      pending++;
      this.canvas.toBlob(b => { frames[slot] = b; pending--; }, 'image/png');
    },
    async finish() {
      btn.textContent = 'Zipping…';
      while (pending > 0) await new Promise(r => setTimeout(r, 50));
      const zip = new JSZip();
      const folder = zip.folder(`enode-${fw}x${fh}-${totalFrames}fr`);
      const pad = String(totalFrames).length;
      frames.forEach((b, f) => {
        if (b) folder.file(`frame_${String(f).padStart(pad, '0')}.png`, b);
      });
      try {
        const blob = await zip.generateAsync({ type: 'blob' });
        downloadBlob(blob, `enode-${fw}x${fh}-${totalFrames}fr.zip`);
      } catch (e) {
        console.error(e);
        alert('Zip failed: ' + e.message);
      }
      btn.classList.remove('recording');
      btn.textContent = 'Export PNG sequence';
    },
  });
});

// ─── Source preview (sidebar thumbnail) ─────────────────────────
const sourcePreviewCanvas = document.getElementById('sourcePreviewCanvas');
const sourcePreviewCtx = sourcePreviewCanvas.getContext('2d');
const sourcePreviewWrap = document.getElementById('sourcePreview');
let lastPreviewMode = null;

function updateSourcePreview() {
  // Size bitmap to fit the container box (with DPR for crisp rendering) at
  // the current export aspect. CSS object-fit:contain handles the visual fit.
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = sourcePreviewWrap.clientWidth || 220;
  const ch = sourcePreviewWrap.clientHeight || 220;
  const ar = state.exportW / state.exportH;
  let dw, dh;
  if (cw / ch > ar) { dh = ch; dw = dh * ar; }
  else { dw = cw; dh = dw / ar; }
  const targetW = Math.max(2, Math.round(dw * dpr));
  const targetH = Math.max(2, Math.round(dh * dpr));
  if (sourcePreviewCanvas.width !== targetW) sourcePreviewCanvas.width = targetW;
  if (sourcePreviewCanvas.height !== targetH) sourcePreviewCanvas.height = targetH;

  let src = null;
  if (state.mode === 'Strips') {
    sourcePreviewCtx.fillStyle = '#202020';
    sourcePreviewCtx.fillRect(0, 0, targetW, targetH);
    const sp = state.strips;
    const step = 3;
    for (let i = 0; i < targetW; i += step) {
      for (let j = 0; j < targetH; j += step) {
        const v = stripsValue(i / Math.max(1, targetW - 1), j / Math.max(1, targetH - 1), time, sp);
        const g = Math.round(v * 255);
        sourcePreviewCtx.fillStyle = `rgb(${g},${g},${g})`;
        sourcePreviewCtx.fillRect(i, j, step, step);
      }
    }
    sourcePreviewWrap.classList.add('has-content');
    return;
  } else if (state.mode === 'Random') {
    src = randomSourceCanvas;
  } else {
    src = currentSource();
  }
  if (!src) {
    sourcePreviewCtx.clearRect(0, 0, targetW, targetH);
    sourcePreviewWrap.classList.remove('has-content');
    return;
  }
  sourcePreviewWrap.classList.add('has-content');
  sourcePreviewCtx.fillStyle = '#000';
  sourcePreviewCtx.fillRect(0, 0, targetW, targetH);
  // Center-crop source to thumbnail aspect (same as the renderer)
  const sW = src.videoWidth || src.naturalWidth || src.width || 1;
  const sH = src.videoHeight || src.naturalHeight || src.height || 1;
  const sAr = sW / sH, dAr = targetW / targetH;
  let sx = 0, sy = 0, sw = sW, sh = sH;
  if (sAr > dAr) { sw = sH * dAr; sx = (sW - sw) / 2; }
  else if (sAr < dAr) { sh = sW / dAr; sy = (sH - sh) / 2; }
  try { sourcePreviewCtx.drawImage(src, sx, sy, sw, sh, 0, 0, targetW, targetH); } catch (e) {}
}
// Run preview update at lower rate to save CPU
let _previewAccum = 0;
function previewTick(dt) {
  _previewAccum += dt;
  if (_previewAccum > 1000 / 12) { // ~12fps preview
    _previewAccum = 0;
    updateSourcePreview();
  }
}

// ─── Rect editor (drag/resize handles in Random mode) ───────────
const rectEditor = document.getElementById('rectEditor');

function updateEditorVisibility() {
  const inRandom = state.mode === 'Random';
  const pattern = ARTBOARD_PATTERN_MAP[state.artboard.pattern];
  const transformAllowsEditing = state.artboard.rotation === 0
    && !state.artboard.flipX
    && !state.artboard.flipY
    && pattern && pattern.layout === 'single';
  const canEdit = inRandom && transformAllowsEditing;
  if (!canEdit && state.editRects) state.editRects = false;
  const on = canEdit && state.editRects;
  rectEditor.classList.toggle('active', on);
  chipGradient.classList.toggle('hidden', !inRandom);
  canvasEditBtn.style.display = inRandom ? '' : 'none';
  document.getElementById('editToolDivider').style.display = inRandom ? '' : 'none';
  canvasEditBtn.disabled = inRandom && !transformAllowsEditing;
  canvasEditBtn.classList.toggle('active', on);
  canvasEditBtn.setAttribute('aria-label', on ? 'Finish editing rectangles' : 'Edit rectangles');
  canvasEditBtn.dataset.tip = !transformAllowsEditing && inRandom
    ? 'Reset artboard transforms to edit rectangles'
    : (on ? 'Finish editing rectangles' : 'Edit rectangles');
  if (on) updateRectEditor();
  else rectEditor.innerHTML = '';
}

function updateRectEditor() {
  const cr = canvas.getBoundingClientRect();
  const wr = rectEditor.parentElement.getBoundingClientRect();
  rectEditor.style.left = (cr.left - wr.left) + 'px';
  rectEditor.style.top = (cr.top - wr.top) + 'px';
  rectEditor.style.width = cr.width + 'px';
  rectEditor.style.height = cr.height + 'px';

  // Build (or update) one div per rect
  while (rectEditor.children.length > state.rects.length) {
    rectEditor.removeChild(rectEditor.lastChild);
  }
  while (rectEditor.children.length < state.rects.length) {
    const d = document.createElement('div');
    d.className = 'rect-handle';
    const g = document.createElement('div');
    g.className = 'grip';
    d.appendChild(g);
    rectEditor.appendChild(d);
    attachRectDrag(d, rectEditor.children.length - 1);
  }
  for (let i = 0; i < state.rects.length; i++) {
    const r = state.rects[i];
    const d = rectEditor.children[i];
    d.style.left = (r.x * cr.width) + 'px';
    d.style.top = (r.y * cr.height) + 'px';
    d.style.width = (r.w * cr.width) + 'px';
    d.style.height = (r.h * cr.height) + 'px';
  }
}

function attachRectDrag(el, idx) {
  let isResize = false, startX = 0, startY = 0, startRect = null;
  function onDown(e) {
    e.preventDefault();
    isResize = e.target.classList.contains('grip');
    startX = e.clientX; startY = e.clientY;
    startRect = { ...state.rects[idx] };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }
  function onMove(e) {
    const cr = canvas.getBoundingClientRect();
    const dx = (e.clientX - startX) / cr.width;
    const dy = (e.clientY - startY) / cr.height;
    const r = state.rects[idx];
    if (isResize) {
      r.w = Math.max(0.04, Math.min(1 - r.x, startRect.w + dx));
      r.h = Math.max(0.04, Math.min(1 - r.y, startRect.h + dy));
    } else {
      r.x = Math.max(0, Math.min(1 - startRect.w, startRect.x + dx));
      r.y = Math.max(0, Math.min(1 - startRect.h, startRect.y + dy));
    }
    rebuildRandomSource();
  }
  function onUp() {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  }
  el.addEventListener('mousedown', onDown);
}

// Keep editor aligned to canvas when stage resizes
window.addEventListener('resize', () => { if (state.editRects) updateRectEditor(); });

// ─── Default image ─────────────────────────────────────────────
// Pre-load the bundled default image so Image mode has something on first click.
const defaultImg = new Image();
defaultImg.onload = () => { if (!imageEl) imageEl = defaultImg; };
defaultImg.src = DEFAULT_IMAGE_URL;


// ─── Tooltips ──────────────────────────────────────────────────
const tooltipEl = document.createElement('div');
tooltipEl.className = 'tooltip';
document.body.appendChild(tooltipEl);

let tipShowTimer = null;
function showTooltip(text, targetEl) {
  clearTimeout(tipShowTimer);
  tipShowTimer = setTimeout(() => {
    tooltipEl.textContent = text;
    tooltipEl.classList.add('visible');
    // Position above the target label, aligned to its left edge.
    const r = targetEl.getBoundingClientRect();
    tooltipEl.style.left = Math.max(8, r.left) + 'px';
    // Render first to know height
    const th = tooltipEl.offsetHeight;
    let top = r.top - th - 8;
    if (top < 8) top = r.bottom + 8; // flip below if no room above
    tooltipEl.style.top = top + 'px';
  }, 250);
}
function hideTooltip() {
  clearTimeout(tipShowTimer);
  tooltipEl.classList.remove('visible');
}

document.addEventListener('mouseover', e => {
  const el = e.target.closest('[data-tip]');
  if (el) showTooltip(el.getAttribute('data-tip'), el);
});
document.addEventListener('mouseout', e => {
  const el = e.target.closest('[data-tip]');
  if (el) hideTooltip();
});

// ─── Light/dark theme toggle (press "i") ───────────────────────
function applyTheme(light) {
  document.body.classList.toggle('light', light);
  try { localStorage.setItem('enode-theme', light ? 'light' : 'dark'); } catch (e) {}
}
applyTheme(localStorage.getItem('enode-theme') === 'light');

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closePatternMenu();
    return;
  }
  if (e.key !== 'i' && e.key !== 'I') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  applyTheme(!document.body.classList.contains('light'));
});

// ─── Audio ─────────────────────────────────────────────────────
const audioTracksEl   = document.getElementById('audioTracks');
const audioTransport  = document.getElementById('audioTransport');
const audioPlayBtn    = document.getElementById('audioPlayBtn');
const audioPlayIcon   = document.getElementById('audioPlayIcon');
const audioSeek       = document.getElementById('audioSeek');
const audioTimeEl     = document.getElementById('audioTime');
const audioStatusEl   = document.getElementById('audioStatus');
const audioVizCanvas  = document.getElementById('audioViz');
const audioVizCtx     = audioVizCanvas.getContext('2d');
const soundAnalysisEl = document.getElementById('soundAnalysis');
const audioDrop       = document.getElementById('audioDrop');
const cameraMicToggle = document.getElementById('cameraMicToggle');

let audioSeekDragging = false;
let currentTrackUrl   = null;

cameraMicToggle.addEventListener('click', async () => {
  if (state.mode !== 'Camera') return;
  if (enodeAudio.micActive) {
    disableCameraMicrophone();
    return;
  }
  state.cameraMicEnabled = true;
  const cameraHasLiveMic = cameraStream
    && cameraStream.getAudioTracks().some(track => track.readyState === 'live');
  if (cameraHasLiveMic) attachCameraMicrophone(cameraStream);
  else await enableCameraMicrophone();
});

function formatTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return m + ':' + (s < 10 ? '0' + s : s);
}

function loadAudioTrack(url, displayName) {
  if (!window.enodeAudio) return;
  currentTrackUrl = url;
  enodeAudio.load(url);
  enodeAudio.play();
  // UI updates
  audioTransport.style.display = '';
  if (soundAnalysisEl) soundAnalysisEl.style.display = '';
  audioStatusEl.textContent = displayName || '';
  audioStatusEl.classList.add('live');
  // Highlight matching track button (if any)
  audioTracksEl.querySelectorAll('button').forEach(b => {
    b.classList.toggle('active', b.dataset.src === url);
  });
  updatePlayIcon();
}

// 3 preset track buttons
audioTracksEl.addEventListener('click', e => {
  const b = e.target.closest('button[data-src]');
  if (!b) return;
  // Click on the already-active track toggles play/pause
  if (b.dataset.src === currentTrackUrl) {
    enodeAudio.toggle();
    return;
  }
  loadAudioTrack(b.dataset.src, b.dataset.name || b.textContent);
});

// Transport: play/pause toggle
audioPlayBtn.addEventListener('click', () => {
  if (!currentTrackUrl) return;
  enodeAudio.toggle();
});

// Transport: scrub
audioSeek.addEventListener('input', () => {
  audioSeekDragging = true;
  const frac = parseFloat(audioSeek.value) / 1000;
  const t = frac * (enodeAudio.duration || 0);
  if (audioTimeEl) audioTimeEl.textContent = formatTime(t) + ' / ' + formatTime(enodeAudio.duration);
});
audioSeek.addEventListener('change', () => {
  const frac = parseFloat(audioSeek.value) / 1000;
  enodeAudio.seek(frac * (enodeAudio.duration || 0));
  audioSeekDragging = false;
});

// Dedicated drop target inside the Audio group
['dragenter', 'dragover'].forEach(ev => {
  audioDrop.addEventListener(ev, e => {
    e.preventDefault();
    e.stopPropagation();
    audioDrop.classList.add('over');
  });
});
['dragleave', 'drop'].forEach(ev => {
  audioDrop.addEventListener(ev, e => {
    e.preventDefault();
    audioDrop.classList.remove('over');
  });
});
audioDrop.addEventListener('drop', e => {
  e.preventDefault();
  e.stopPropagation();
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f && f.type.startsWith('audio/')) {
    const url = URL.createObjectURL(f);
    loadAudioTrack(url, f.name.replace(/\.[^.]+$/, ''));
  }
});

function updatePlayIcon() {
  if (!audioPlayIcon) return;
  // Play triangle vs pause bars
  if (enodeAudio.playing) {
    audioPlayIcon.setAttribute('d', 'M6 5h4v14H6zM14 5h4v14h-4z');
  } else {
    audioPlayIcon.setAttribute('d', 'M7 5l12 7-12 7z');
  }
}

enodeAudio.onTransport(updatePlayIcon);

// ─── Modulation matrix ─────────────────────────────────────────
// Each row routes a SOURCE (band level / per-band hit / beat / BPM tick /
// generator) to a visual TARGET. The advanced panel exposes the envelope, hit
// chance, and generator speed; its visible fields adapt to the source kind.
const modListEl = document.getElementById('modList');

function modOptions(ids, registry, selected) {
  return ids.map(id => `<option value="${id}"${id === selected ? ' selected' : ''}>${registry[id].label}</option>`).join('');
}

// Advanced controls vary by source kind: levels expose attack+release; events a
// decay + a probability gate; generators a speed + BPM-sync. All offer invert.
function modAdvHtml(m) {
  const kind = (MOD_SOURCES[m.source] || {}).kind || 'level';
  const sl = (k, label, min, max, step, val) =>
    `<label class="mod-adv-field"><span>${label}</span><input type="range" class="mod-adv" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${val}"></label>`;
  const cb = (k, label, val) =>
    `<label class="mod-adv-check"><input type="checkbox" class="mod-adv" data-k="${k}"${val ? ' checked' : ''}><span>${label}</span></label>`;
  // Attack/release are kept at sensible fixed defaults (snappy attack, musical
  // release) — only the controls users actually reach for are exposed.
  if (kind === 'level') return cb('invert', 'Invert', m.invert);
  if (kind === 'event') return sl('chance', 'Chance', 0, 1, 0.01, m.chance) + cb('invert', 'Invert', m.invert);
  return sl('speed', 'Speed', 0, 1, 0.01, m.speed) + cb('bpmSync', 'BPM sync', m.bpmSync) + cb('invert', 'Invert', m.invert);
}

function renderModList() {
  modListEl.innerHTML = '';
  state.audioMods.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'mod-row';
    row.dataset.index = String(i);
    row.innerHTML = `
      <div class="mod-row-head">
        <select class="mod-src" data-k="source" title="Source">${modOptions(MOD_SOURCE_ORDER, MOD_SOURCES, m.source)}</select>
        <span class="mod-arrow">→</span>
        <select class="mod-tgt" data-k="target" title="Target">${modOptions(MOD_TARGET_ORDER, MOD_TARGETS, m.target)}</select>
        <button class="mod-icon mod-adv-toggle" title="Advanced" aria-label="Advanced">⋯</button>
        <button class="mod-icon mod-remove" title="Remove" aria-label="Remove">×</button>
      </div>
      <div class="mod-depth-row">
        <input type="range" class="mod-depth" min="0" max="1" step="0.01" value="${m.depth}">
        <span class="mod-depth-val">${m.depth.toFixed(2)}</span>
      </div>
      <div class="mod-adv-panel" hidden>${modAdvHtml(m)}</div>
    `;
    modListEl.appendChild(row);
  });
}

function modRowOf(e) {
  const row = e.target.closest('.mod-row');
  return row ? { row, m: state.audioMods[+row.dataset.index] } : null;
}

modListEl.addEventListener('input', e => {
  const ctx = modRowOf(e); if (!ctx || !ctx.m) return;
  if (e.target.classList.contains('mod-depth')) {
    ctx.m.depth = parseFloat(e.target.value);
    ctx.row.querySelector('.mod-depth-val').textContent = ctx.m.depth.toFixed(2);
  } else if (e.target.classList.contains('mod-adv') && e.target.type === 'range') {
    ctx.m[e.target.dataset.k] = parseFloat(e.target.value);
  }
});

modListEl.addEventListener('change', e => {
  const ctx = modRowOf(e); if (!ctx || !ctx.m) return;
  const k = e.target.dataset.k;
  if (k === 'source') {
    ctx.m.source = e.target.value;
    ctx.m.env = 0; ctx.m.phase = 0; ctx.m._value = 0; delete ctx.m._seed;
    renderModList();                    // advanced fields depend on source kind
  } else if (k === 'target') {
    ctx.m.target = e.target.value;
  } else if (e.target.classList.contains('mod-adv') && e.target.type === 'checkbox') {
    ctx.m[k] = e.target.checked;
  }
});

modListEl.addEventListener('click', e => {
  if (e.target.classList.contains('mod-adv-toggle')) {
    const panel = e.target.closest('.mod-row').querySelector('.mod-adv-panel');
    if (panel) panel.hidden = !panel.hidden;
  } else if (e.target.classList.contains('mod-remove')) {
    const row = e.target.closest('.mod-row');
    state.audioMods.splice(+row.dataset.index, 1);
    renderModList();
  }
});

const modAddBtn = document.getElementById('modAddBtn');
if (modAddBtn) modAddBtn.addEventListener('click', () => {
  state.audioMods.push({ source: 'treble', target: 'hue', depth: 0.5, attack: 45, release: 220, chance: 1, invert: false, speed: 0.4, bpmSync: false, env: 0, phase: 0 });
  renderModList();
});

// Randomize: low-end and detected hits drive structural params, mids drive
// texture, highs drive fine/fast ones, and generators add free-running drift.
// The fixed BPM grid is deliberately excluded because it is not track-derived.
const RANDOM_POOLS = [
  { src: ['bass', 'beat', 'hit.bass'],           tgt: ['pulse', 'density', 'stripCount', 'timeSpeed'] },
  { src: ['mid', 'hit.mid', 'rms'],              tgt: ['cellContrast', 'stripPhase', 'scan'] },
  { src: ['treble', 'hit.treble'],               tgt: ['hue', 'flicker'] },
  { src: ['lfo', 'noise', 'saw'],                tgt: ['hue', 'stripAnim'] },
];
const _pick = a => a[Math.floor(Math.random() * a.length)];
function randomizeMods() {
  const used = new Set();
  const rows = [];
  for (const pool of RANDOM_POOLS) {
    const free = pool.tgt.filter(t => !used.has(t));
    if (!free.length) continue;
    const target = _pick(free);
    used.add(target);
    rows.push({
      source: _pick(pool.src), target,
      depth: +(0.45 + Math.random() * 0.45).toFixed(2),
      attack: 45, release: 220, chance: 1, invert: Math.random() < 0.15,
      speed: +(0.2 + Math.random() * 0.6).toFixed(2), bpmSync: false,
      env: 0, phase: 0,
    });
  }
  if (rows.length) { state.audioMods = rows; renderModList(); }
}
const modRandomBtn = document.getElementById('modRandomBtn');
if (modRandomBtn) modRandomBtn.addEventListener('click', randomizeMods);

renderModList();

// Per-frame: refresh transport readout and draw the mini FFT visualizer.
function audioVizTick() {
  if (!currentTrackUrl && !enodeAudio.micActive) return;
  if (currentTrackUrl) {
    const dur = enodeAudio.duration || 0;
    const t = enodeAudio.currentTime;
    if (!audioSeekDragging) {
      audioSeek.value = dur > 0 ? Math.round((t / dur) * 1000) : 0;
    }
    audioTimeEl.textContent = formatTime(t) + ' / ' + formatTime(dur);
  }
  drawAudioViz();
}

// Sound Analysis: a log-frequency spectrum with the Low/Mid/High bands marked.
function drawAudioViz() {
  const css = getComputedStyle(document.documentElement);
  const col = (name, fb) => css.getPropertyValue(name).trim() || fb;
  const c = audioVizCtx;
  const W = audioVizCanvas.width, H = audioVizCanvas.height;
  c.clearRect(0, 0, W, H);

  const specH = H;

  // ── Spectrum (log frequency) ──
  c.fillStyle = col('--bg-3', '#1e1e1e');
  c.fillRect(0, 0, W, specH);

  const F_MIN = 20, F_MAX = 20000;
  const lMin = Math.log(F_MIN), lSpan = Math.log(F_MAX) - lMin;
  const xForHz = hz => (Math.log(hz) - lMin) / lSpan * W;

  // Band regions behind the bars.
  const ranges = enodeAudio.bandRanges || { bass: [20, 180], mid: [180, 2000], treble: [2000, 9000] };
  const regions = [
    { key: 'bass',   label: 'Low'  },
    { key: 'mid',    label: 'Mid'  },
    { key: 'treble', label: 'High' },
  ];
  c.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  c.textBaseline = 'top';
  for (const r of regions) {
    const x0 = xForHz(ranges[r.key][0]), x1 = xForHz(ranges[r.key][1]);
    c.fillStyle = 'rgba(255,255,255,0.05)';
    c.fillRect(x0, 0, x1 - x0, specH);
    c.strokeStyle = 'rgba(255,255,255,0.10)';
    c.strokeRect(x0 + 0.5, 0.5, x1 - x0 - 1, specH - 1);
    c.fillStyle = col('--fg-mute', '#8a8a8a');
    c.fillText(r.label, x0 + 4, 3);
  }

  // Spectrum bars.
  const spec = enodeAudio.getSpectrumLog(Math.min(96, Math.floor(W / 3)), F_MIN, F_MAX);
  const bw = W / spec.length;
  c.fillStyle = col('--fg-dim', '#c8c8c8');
  for (let i = 0; i < spec.length; i++) {
    const h = Math.max(1, spec[i] * (specH - 2));
    c.fillRect(i * bw, specH - h, Math.max(1, bw - 1), h);
  }
}

// ─── Init ──────────────────────────────────────────────────────
setExportSize(1080, 1080);
setVideoSource(DEMO_VIDEO_URL);
regenerateRects(); // pre-populate so Random shows immediately on first switch
updateEditorVisibility(); // sync Gradient chip visibility with initial mode
updateStripsVisibility(); // hide Strips panel until user picks Strips mode
updateRandomVisibility(); // hide Random panel until user picks Random mode
requestAnimationFrame(tick);
