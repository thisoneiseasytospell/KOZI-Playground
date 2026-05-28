/* Enode Oker — KOZI Playground */
'use strict';

// ─── State ───────────────────────────────────────────────────────
const state = {
  mode: 'Video',          // Video | Image | Camera | Noise | Random
  aspect: '1:1',
  exportW: 1080,
  exportH: 1080,
  density: 60,
  cellSize: 1,
  morph: 1,
  speed: 0.3,
  reaction: 72,           // 1..100 → 0.01..1.0 lerp
  noiseScale: 22,
  angle: 0,               // halftone angle 0..45
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
  strips: {               // Strips mode parameters (blocky grid of rectangles)
    count: 6,
    phaseShift: 0.35,
    amplitude: 0.6,
    phaseMode: 'sine',    // sine | triangle | square | sawtooth
    threshold: 1.50,
    softness: 0.30,
    contrast: 3.2,
    quantize: 1,
    invertY: false,
    animSpeed: 1.4,
    noiseRatio: 18,
  },
};

const DEMO_VIDEO_URL = 'demo/demo.mp4';
const DEFAULT_IMAGE_URL = 'demo/default.png';

// ─── DOM ─────────────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const stage = document.getElementById('stage');
const stageInfo = document.getElementById('stageInfo');
const dropOverlay = document.getElementById('dropOverlay');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');

// ─── Source handling ─────────────────────────────────────────────
const simplex = new SimplexNoise();
const sampleCanvas = document.createElement('canvas');
const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

let activeVideo = null;
let lastVideoTime = 0;
let snapNextFrame = false;  // set when video loops, used to instant-snap smoothing
let imageEl = null;
let cameraStream = null;
let cameraVideo = null;
let time = 0;
let smoothed = [];
let lastDensity = 0;
let lastRows = 0;
let randomSourceCanvas = null; // grayscale rectangles painted here; fed to grid sampler

function createVideoEl() {
  const v = document.createElement('video');
  v.muted = true;
  v.loop = false; // we'll handle the loop ourselves
  v.playsInline = true;
  v.crossOrigin = 'anonymous';
  v.preload = 'auto';
  return v;
}

function setVideoSource(url) {
  if (!activeVideo) {
    activeVideo = createVideoEl();
    activeVideo.loop = true; // browser handles the loop; we hide the seam via snap
  }
  activeVideo.src = url;
  lastVideoTime = 0;
  activeVideo.play().catch(() => {});
}

function setImageSource(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => { imageEl = img; };
  img.src = url;
}

async function startCamera() {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    cameraVideo = createVideoEl();
    cameraVideo.srcObject = cameraStream;
    await cameraVideo.play();
  } catch (e) {
    alert('Camera access denied or unavailable.');
    cameraStream = null;
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  cameraVideo = null;
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

function rebuildRandomSource() {
  if (!randomSourceCanvas) randomSourceCanvas = document.createElement('canvas');
  const W = 512, H = Math.round(512 * state.exportH / state.exportW);
  randomSourceCanvas.width = W;
  randomSourceCanvas.height = H;
  const c = randomSourceCanvas.getContext('2d');
  c.fillStyle = '#808080';
  c.fillRect(0, 0, W, H);
  paintRectsTo(c, state.rects, W, H, state.gradient ? state.rectGradients : null);
  if (state.editRects) updateRectEditor();
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
// Discrete grid of rectangles, audio-visualizer style. The canvas is
// divided into `count` rows × `cols` columns (cols derived from phaseShift).
// Every cell holds one flat brightness value driven by a phase wave per
// (row, col) and per-cell noise. Hard edges, no flowing curves — every
// rectangle scales as a unit.
function stripsValue(x, y, t, p) {
  const yEff = p.invertY ? 1 - y : y;
  const TAU = Math.PI * 2;

  // Grid resolution: rows from `count`, cols mapped from phaseShift
  // (phaseShift 0 → ~2 cols, 2 → ~82 cols). Lets the slider stay meaningful.
  const rows = Math.max(1, Math.floor(p.count));
  const cols = Math.max(1, Math.round(2 + p.phaseShift * 40));

  const rowIdx = Math.min(rows - 1, Math.floor(yEff * rows));
  const colIdx = Math.min(cols - 1, Math.floor(x * cols));

  // Phase wave per block. Each row is phase-shifted so rows don't pulse in
  // lockstep — gives the EQ-stack look. Amplitude scales the wave frequency
  // across cols (so high amplitude = busier left-to-right variation).
  const colN = cols > 1 ? colIdx / (cols - 1) : 0;
  const cellPhase = colN * TAU * (0.5 + p.amplitude * 1.5) + rowIdx * 0.55 + t * p.animSpeed;
  let wave;
  switch (p.phaseMode) {
    case 'triangle': wave = 4 * Math.abs(((cellPhase / TAU) % 1 + 1) % 1 - 0.5) - 1; break;
    case 'square':   wave = Math.sin(cellPhase) >= 0 ? 1 : -1; break;
    case 'sawtooth': wave = 2 * (((cellPhase / TAU) % 1 + 1) % 1) - 1; break;
    case 'sine':
    default:         wave = Math.sin(cellPhase); break;
  }

  // Per-block noise jitter (samples at the block coord so all pixels in the
  // block get the same noise value — keeps each rectangle uniform).
  const ns = p.noiseRatio * 0.05;
  const noise = simplex.noise3D(colIdx * ns, rowIdx * ns, t * 0.35);

  // Blend wave + noise into 0..1, then bias by threshold (1.5 ≈ neutral).
  let v = ((wave + 1) * 0.5) * 0.65 + ((noise + 1) * 0.5) * 0.35;
  v += (p.threshold - 1.5) * 0.5;

  // Contrast steepens response around mid (sharper on/off).
  v = (v - 0.5) * p.contrast + 0.5;
  v = v < 0 ? 0 : v > 1 ? 1 : v;

  // Softness fades dots near the rectangle edges so blocks read as distinct
  // tiles instead of one continuous field. 0 = touching, 1 = strongly inset.
  if (p.softness > 0.01) {
    const fx = (x * cols) - colIdx;
    const fy = (yEff * rows) - rowIdx;
    const edgeDist = Math.min(fx, 1 - fx, fy, 1 - fy); // 0 at edge, 0.5 mid
    const edge = p.softness * 0.45;
    if (edgeDist < edge) v *= edgeDist / edge;
  }

  // Quantize to discrete brightness levels (1 = continuous).
  const q = Math.floor(p.quantize);
  if (q > 1) v = Math.round(v * (q - 1)) / (q - 1);

  return v;
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

// ─── Canvas sizing ──────────────────────────────────────────────
function setExportSize(w, h) {
  state.exportW = Math.max(2, Math.round(w));
  state.exportH = Math.max(2, Math.round(h));
  canvas.width = state.exportW;
  canvas.height = state.exportH;
  smoothed = []; lastDensity = 0; lastRows = 0; // force re-init
  fitCanvasToStage();
  stageInfo.textContent = `${state.exportW} × ${state.exportH}`;
  if (state.mode === 'Random') rebuildRandomSource();
}

function fitCanvasToStage() {
  const pad = 56;
  const aw = stage.clientWidth - pad;
  const ah = stage.clientHeight - pad;
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
}

window.addEventListener('resize', fitCanvasToStage);

// ─── Renderer ───────────────────────────────────────────────────
function drawScene(targetCtx, w, h, opts) {
  opts = opts || {};
  const density = Math.floor(opts.density != null ? opts.density : state.density);
  const cellSizeMul = opts.cellSize != null ? opts.cellSize : state.cellSize;
  const morph = state.morph;
  const angle = (opts.angle != null ? opts.angle : state.angle) * Math.PI / 180;
  const reactionLerp = state.reaction / 100;
  const invert = state.invert;
  const outline = state.outline;
  const stroke = state.stroke;
  const fg = state.fg;
  const bg = state.bg;
  const noiseScale = 1 / (state.noiseScale * 2 + 0.1);
  const mode = state.mode;

  // BG
  targetCtx.fillStyle = bg;
  targetCtx.fillRect(0, 0, w, h);

  // Grid modes — sample source / noise into a small buffer, then draw cells.
  const cellSize = w / density;
  const rows = Math.ceil(h / cellSize);
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
  if (src && mode !== 'Noise' && mode !== 'Strips') {
    sampleCanvas.width = density;
    sampleCanvas.height = rows;
    // Center-crop the source to the canvas aspect ratio so circles/cameras
    // don't get squished when the canvas aspect doesn't match the source.
    const srcW = src.videoWidth || src.naturalWidth || src.width || 1;
    const srcH = src.videoHeight || src.naturalHeight || src.height || 1;
    const srcAr = srcW / srcH;
    const dstAr = density / rows;
    let sx = 0, sy = 0, sw = srcW, sh = srcH;
    if (srcAr > dstAr) {
      sw = srcH * dstAr;
      sx = (srcW - sw) / 2;
    } else if (srcAr < dstAr) {
      sh = srcW / dstAr;
      sy = (srcH - sh) / 2;
    }
    try {
      sampleCtx.drawImage(src, sx, sy, sw, sh, 0, 0, density, rows);
      sampleData = sampleCtx.getImageData(0, 0, density, rows).data;
    } catch (e) {}
  }

  // Halftone angle: rotate the cell grid around the canvas center.
  // Oversample by sqrt(2) so corners stay covered when rotated.
  const cx = w / 2, cy = h / 2;
  if (angle !== 0) {
    targetCtx.save();
    targetCtx.translate(cx, cy);
    targetCtx.rotate(angle);
    targetCtx.translate(-cx, -cy);
  }

  // Effective grid extends past canvas when rotated. Compute extra rings.
  const pad = angle !== 0 ? Math.ceil(density * 0.4) : 0;

  targetCtx.fillStyle = fg;
  targetCtx.strokeStyle = fg;
  targetCtx.lineWidth = stroke;

  for (let i = -pad; i < density + pad; i++) {
    for (let j = -pad; j < rows + pad; j++) {
      let target;
      const inBounds = i >= 0 && i < density && j >= 0 && j < rows;
      if (mode === 'Noise') {
        target = (simplex.noise3D(i * noiseScale, j * noiseScale, time) + 1) / 2;
      } else if (mode === 'Strips') {
        const nx = density > 1 ? i / (density - 1) : 0;
        const ny = rows > 1 ? j / (rows - 1) : 0;
        target = stripsValue(nx, ny, time, state.strips);
      } else if (sampleData && inBounds) {
        const idx = (j * density + i) * 4;
        target = (0.299 * sampleData[idx] + 0.587 * sampleData[idx + 1] + 0.114 * sampleData[idx + 2]) / 255;
      } else if (sampleData) {
        // Out-of-bounds (rotation pad): sample nearest valid cell
        const ii = Math.max(0, Math.min(density - 1, i));
        const jj = Math.max(0, Math.min(rows - 1, j));
        const idx = (jj * density + ii) * 4;
        target = (0.299 * sampleData[idx] + 0.587 * sampleData[idx + 1] + 0.114 * sampleData[idx + 2]) / 255;
      } else if (useSmoothing && inBounds) {
        target = buf[i + j * density] || 0;
      } else {
        target = 0;
      }

      if (invert) target = 1 - target;

      let val;
      if (useSmoothing && inBounds) {
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
      const size = cellSize * cellSizeMul * val;
      const radius = (size / 2) * Math.min(1, val * morph);

      // Outline mode: skip cells that are too small for a clean stroke. A 1px
      // stroke on a sub-pixel rect causes anti-aliasing flicker as size lerps;
      // fill is forgiving but stroke shows it. Threshold = stroke * 3.
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
        if (outline) targetCtx.stroke();
        else targetCtx.fill();
      }
    }
  }

  if (angle !== 0) targetCtx.restore();
}

let _lastTickT = 0;
function tick(now) {
  requestAnimationFrame(tick);
  const dt = _lastTickT ? (now - _lastTickT) : 16;
  _lastTickT = now;
  if (state.playing && state.mode === 'Noise') time += state.speed * 0.01;
  if (state.playing && state.mode === 'Strips') time += (dt / 1000);
  // Detect video loop seam: time goes backward → next frame snaps smoothing
  // to current sample instead of lerping through the stale buffer.
  if (state.mode === 'Video' && activeVideo) {
    const t = activeVideo.currentTime;
    if (t < lastVideoTime - 0.4) snapNextFrame = true;
    lastVideoTime = t;
  }
  drawScene(ctx, canvas.width, canvas.height);
  snapNextFrame = false;
  if (typeof previewTick === 'function') previewTick(dt);
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
  } else if (cameraStream) {
    stopCamera();
  }
  if (val === 'Random') {
    if (state.rects.length === 0) regenerateRects();
    else rebuildRandomSource();
  }
  updateEditorVisibility();
  updateStripsVisibility();
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
    scheduleGlow();
  });
}

// "You've been tweaking sliders — try Variations" nudge after 5s of inactivity.
const GLOW_DELAY_MS = 5000;
let glowTimer = null;
function scheduleGlow() {
  clearTimeout(glowTimer);
  const btn = document.getElementById('variationsBtn');
  btn && btn.classList.remove('glow');
  glowTimer = setTimeout(() => {
    btn && btn.classList.add('glow');
  }, GLOW_DELAY_MS);
}
function clearGlow() {
  clearTimeout(glowTimer);
  const btn = document.getElementById('variationsBtn');
  btn && btn.classList.remove('glow');
}

wireSlider('density', 'density', 'densityVal', n => Math.round(n));
wireSlider('cellSize', 'cellSize', 'cellSizeVal', n => n.toFixed(2));
wireSlider('morph', 'morph', 'morphVal', n => n.toFixed(2));
wireSlider('speed', 'speed', 'speedVal', n => n.toFixed(2));
wireSlider('reaction', 'reaction', 'reactionVal', n => Math.round(n));
wireSlider('angle', 'angle', 'angleVal', n => Math.round(n) + '°');
wireSlider('stroke', 'stroke', 'strokeVal', n => n.toFixed(1));

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
    scheduleGlow();
  });
}

// Only the 5 sliders exposed in the sidebar are wired. The other params
// (amplitude, noiseRatio, threshold, softness, contrast, invertY) live in
// state.strips and are driven entirely by the preset buttons.
wireStripSlider('stripCount', 'count', 'stripCountVal', n => Math.round(n));
wireStripSlider('stripPhase', 'phaseShift', 'stripPhaseVal', n => n.toFixed(2));
wireStripSlider('stripAnim', 'animSpeed', 'stripAnimVal', n => n.toFixed(2));
wireStripSlider('stripQuant', 'quantize', 'stripQuantVal', n => Math.round(n));

const stripModeSel = document.getElementById('stripMode');
stripModeSel.addEventListener('change', e => {
  state.strips.phaseMode = e.target.value;
  clearActiveStripPreset();
});

const STRIP_PRESETS = {
  // Blocky rectangle grid, audio-EQ inspired. Tuned for the new stripsValue
  // (cell-based field), not the old wave-band version.
  fluid:    { count: 6,  phaseShift: 0.35, amplitude: 0.6,  phaseMode: 'sine',     threshold: 1.50, softness: 0.30, contrast: 3.2, quantize: 1, invertY: false, animSpeed: 1.4, noiseRatio: 18 },
  glitch:   { count: 5,  phaseShift: 0.70, amplitude: 1.8,  phaseMode: 'square',   threshold: 1.25, softness: 0.05, contrast: 9.5, quantize: 2, invertY: false, animSpeed: 3.0, noiseRatio: 38 },
  minimal:  { count: 3,  phaseShift: 0.18, amplitude: 0.4,  phaseMode: 'triangle', threshold: 1.35, softness: 0.15, contrast: 5.5, quantize: 4, invertY: false, animSpeed: 0.7, noiseRatio: 6  },
  vertical: { count: 12, phaseShift: 0.08, amplitude: 1.1,  phaseMode: 'sine',     threshold: 1.55, softness: 0.40, contrast: 4.0, quantize: 1, invertY: false, animSpeed: 2.0, noiseRatio: 12 },
};

function applyStripPreset(name) {
  const p = STRIP_PRESETS[name];
  if (!p) return;
  Object.assign(state.strips, p);
  syncStripsUI();
  document.querySelectorAll('#stripsPresets button').forEach(b => {
    b.classList.toggle('active', b.dataset.preset === name);
  });
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
  setS('stripCount', 'stripCountVal', s.count, n => Math.round(n));
  setS('stripPhase', 'stripPhaseVal', s.phaseShift, n => n.toFixed(2));
  setS('stripAnim', 'stripAnimVal', s.animSpeed, n => n.toFixed(2));
  setS('stripQuant', 'stripQuantVal', s.quantize, n => Math.round(n));
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
// Canvas-overlay button replaces the in-sidebar Edit Rectangles checkbox
const canvasEditBtn = document.getElementById('canvasEditBtn');
canvasEditBtn.addEventListener('click', () => {
  state.editRects = !state.editRects;
  canvasEditBtn.classList.toggle('active', state.editRects);
  canvasEditBtn.textContent = state.editRects ? 'Done editing' : 'Edit rectangles';
  updateEditorVisibility();
});

// ─── Drag/drop & file loading ───────────────────────────────────
function loadFile(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  if (file.type.startsWith('image/')) {
    setImageSource(url);
    state.mode = 'Image';
    syncModeUI();
  } else if (file.type.startsWith('video/')) {
    setVideoSource(url);
    state.mode = 'Video';
    syncModeUI();
  }
}

function syncModeUI() {
  document.querySelectorAll('#modeSeg button').forEach(b => {
    b.classList.toggle('active', b.dataset.val === state.mode);
  });
  document.getElementById('randomGroup').style.display = state.mode === 'Random' ? '' : 'none';
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

function makeVariations() {
  // 9 randomized combos of density / cellSize / angle.
  const rng = mulberry32(Math.floor(Math.random() * 1e9));
  variationPresets = [];
  for (let i = 0; i < 9; i++) {
    const densityChoices = [16, 28, 44, 60, 80, 100];
    const cellChoices = [0.6, 0.8, 1.0, 1.2, 1.6];
    // Heavy weight on 0° — only one in ~6 variations is rotated
    const angleChoices = [0, 0, 0, 0, 0, 0, 0, 0, 15, 30, 45];
    variationPresets.push({
      density: densityChoices[Math.floor(rng() * densityChoices.length)],
      cellSize: cellChoices[Math.floor(rng() * cellChoices.length)],
      angle: angleChoices[Math.floor(rng() * angleChoices.length)],
      randomSeed: Math.floor(rng() * 1e9),
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

function renderVariations() {
  modalGrid.innerHTML = '';
  const tileSize = 240;
  const ar = state.exportW / state.exportH;
  const tw = tileSize, th = Math.round(tileSize / ar);
  variationPresets.forEach((preset, idx) => {
    const tile = document.createElement('div');
    tile.className = 'modal-tile';
    tile.style.aspectRatio = `${state.exportW}/${state.exportH}`;
    const cv = document.createElement('canvas');
    cv.width = tw; cv.height = th;
    const c2 = cv.getContext('2d');

    // Render with the preset's params, using the snapshot source.
    const origDensity = state.density, origCell = state.cellSize, origAngle = state.angle, origSeed = state.randomSeed;
    state.density = preset.density;
    state.cellSize = preset.cellSize;
    state.angle = preset.angle;
    state.randomSeed = preset.randomSeed;

    let sourceOverride = null;
    if (state.mode === 'Random') {
      sourceOverride = buildRandomCanvas(preset.randomSeed, state.exportW, state.exportH, state.gradient);
    } else if (state.mode !== 'Noise' && frozenSource) {
      sourceOverride = frozenSource;
    }
    drawScene(c2, tw, th, { noSmoothing: true, sourceOverride });

    state.density = origDensity;
    state.cellSize = origCell;
    state.angle = origAngle;
    state.randomSeed = origSeed;

    tile.appendChild(cv);
    const meta = document.createElement('div');
    meta.className = 'modal-tile-meta';
    meta.textContent = `${preset.density} · ${preset.cellSize.toFixed(1)} · ${preset.angle}°`;
    tile.appendChild(meta);

    tile.addEventListener('click', () => {
      state.density = preset.density;
      state.cellSize = preset.cellSize;
      state.angle = preset.angle;
      state.randomSeed = preset.randomSeed;
      if (state.mode === 'Random') regenerateRects();
      // Sync UI
      document.getElementById('density').value = preset.density;
      document.getElementById('densityVal').textContent = preset.density;
      document.getElementById('cellSize').value = preset.cellSize;
      document.getElementById('cellSizeVal').textContent = preset.cellSize.toFixed(2);
      document.getElementById('angle').value = preset.angle;
      document.getElementById('angleVal').textContent = preset.angle + '°';
      closeVariations();
    });

    modalGrid.appendChild(tile);
  });
}

// Helper for variations + exports: build a random-source canvas off-state.
function buildRandomCanvas(seed, exportW, exportH, useGradient) {
  const cv = document.createElement('canvas');
  const W = 512, H = Math.round(512 * exportH / exportW);
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

variationsBtn.addEventListener('click', () => { clearGlow(); openVariations(); });
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

document.getElementById('exportPNG').addEventListener('click', () => {
  const [w, h] = getExportSize();
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c2 = cv.getContext('2d');
  const sourceOverride = state.mode === 'Random' ? buildRandomCanvas(state.randomSeed, w, h, state.gradient) : null;
  drawScene(c2, w, h, { noSmoothing: true, sourceOverride });
  cv.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `enode-${w}x${h}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }, 'image/png');
});

// ─── Export: SVG ───────────────────────────────────────────────
function buildSVG(w, h) {
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`];
  parts.push(`<rect width="${w}" height="${h}" fill="${state.bg}"/>`);

  // Grid mode: snapshot current smoothed buffer
  const density = Math.floor(state.density);
  const cellSize = w / density;
  const rows = Math.ceil(h / cellSize);
  const angle = state.angle;
  const cx = w / 2, cy = h / 2;
  const g = angle !== 0 ? `<g transform="rotate(${angle} ${cx} ${cy})">` : '<g>';
  parts.push(g);

  // Per-cell brightness: sample the current source (or random canvas)
  // with the same center-crop the renderer uses.
  const cv = document.createElement('canvas');
  cv.width = density;
  cv.height = rows;
  const c2 = cv.getContext('2d', { willReadFrequently: true });
  const src = state.mode === 'Random'
    ? buildRandomCanvas(state.randomSeed, w, h, state.gradient)
    : currentSource();
  let data = null;
  if (state.mode === 'Noise' || state.mode === 'Strips') {
    // Sampled per cell below
  } else if (src) {
    const sW = src.videoWidth || src.naturalWidth || src.width || 1;
    const sH = src.videoHeight || src.naturalHeight || src.height || 1;
    const sAr = sW / sH, dAr = density / rows;
    let sx = 0, sy = 0, sw = sW, sh = sH;
    if (sAr > dAr) { sw = sH * dAr; sx = (sW - sw) / 2; }
    else if (sAr < dAr) { sh = sW / dAr; sy = (sH - sh) / 2; }
    try {
      c2.drawImage(src, sx, sy, sw, sh, 0, 0, density, rows);
      data = c2.getImageData(0, 0, density, rows).data;
    } catch (e) {}
  }

  const ns = 1 / (state.noiseScale * 2 + 0.1);
  const pad = angle !== 0 ? Math.ceil(density * 0.4) : 0;
  for (let i = -pad; i < density + pad; i++) {
    for (let j = -pad; j < rows + pad; j++) {
      let v;
      if (state.mode === 'Noise') {
        v = (simplex.noise3D(i * ns, j * ns, time) + 1) / 2;
      } else if (state.mode === 'Strips') {
        const nx = density > 1 ? i / (density - 1) : 0;
        const ny = rows > 1 ? j / (rows - 1) : 0;
        v = stripsValue(nx, ny, time, state.strips);
      } else if (data) {
        const ii = Math.max(0, Math.min(density - 1, i));
        const jj = Math.max(0, Math.min(rows - 1, j));
        const idx = (jj * density + ii) * 4;
        v = (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]) / 255;
      } else {
        continue;
      }
      if (state.invert) v = 1 - v;
      const size = cellSize * state.cellSize * v;
      const minDrawSvg = state.outline ? Math.max(2, state.stroke * 3) : 0.5;
      if (size < minDrawSvg) continue;
      const x = i * cellSize + cellSize / 2 - size / 2;
      const y = j * cellSize + cellSize / 2 - size / 2;
      const r = (size / 2) * Math.min(1, v * state.morph);
      const fillOrStroke = state.outline
        ? `fill="none" stroke="${state.fg}" stroke-width="${state.stroke}"`
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
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `enode-${w}x${h}.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

// ─── Export: MP4 (WebCodecs + mp4-muxer) ───────────────────────
const REC_FPS = 25;
let _mp4Mod = null;
async function getMp4Muxer() {
  if (_mp4Mod) return _mp4Mod;
  _mp4Mod = await import(new URL('vendor/mp4-muxer.mjs', document.baseURI).href);
  return _mp4Mod;
}

const durationSlider = document.getElementById('duration');
const durVal = document.getElementById('durVal');
durationSlider.addEventListener('input', e => {
  durVal.textContent = parseFloat(e.target.value).toFixed(1) + 's';
});

document.getElementById('exportMP4').addEventListener('click', async () => {
  const btn = document.getElementById('exportMP4');
  if (btn.classList.contains('recording')) return;
  if (typeof VideoEncoder === 'undefined') {
    alert('MP4 export requires WebCodecs. Use Chrome or Edge.');
    return;
  }

  const [rawW, rawH] = getExportSize();
  const fw = rawW & ~1, fh = rawH & ~1; // H.264 needs even dims

  // Decide duration: for Video mode, match source duration for seamless loop.
  let durationSec = parseFloat(durationSlider.value);
  if (state.mode === 'Video' && activeVideo && isFinite(activeVideo.duration) && activeVideo.duration > 0) {
    durationSec = activeVideo.duration;
  }
  const totalFrames = Math.max(1, Math.round(durationSec * REC_FPS));

  btn.classList.add('recording');
  btn.textContent = 'Initializing…';

  const recCanvas = document.createElement('canvas');
  recCanvas.width = fw; recCanvas.height = fh;
  const recCtx = recCanvas.getContext('2d');

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
      bitrate: Math.min(50_000_000, Math.max(6_000_000, Math.round(fw * fh * REC_FPS * 0.25))),
      framerate: REC_FPS,
    });
  } catch (e) {
    console.error(e);
    alert('Encoder init failed: ' + e.message);
    btn.classList.remove('recording');
    btn.textContent = 'Export MP4';
    return;
  }

  // For Video mode: drive the video by seeking each frame for deterministic capture.
  // For Image/Random/Noise: render each frame with our own time progression.
  let videoForRec = null;
  if (state.mode === 'Video' && activeVideo) {
    videoForRec = document.createElement('video');
    videoForRec.src = activeVideo.currentSrc || activeVideo.src;
    videoForRec.muted = true;
    videoForRec.crossOrigin = 'anonymous';
    videoForRec.playsInline = true;
    await new Promise((res, rej) => {
      videoForRec.addEventListener('loadedmetadata', res, { once: true });
      videoForRec.addEventListener('error', rej, { once: true });
    });
  }

  async function seekVideoTo(v, t) {
    return new Promise((res) => {
      const onSeeked = () => { v.removeEventListener('seeked', onSeeked); res(); };
      v.addEventListener('seeked', onSeeked);
      v.currentTime = t;
    });
  }

  // Build a fixed Random source canvas (once) so all frames share the layout
  const recRandomSrc = state.mode === 'Random' ? buildRandomCanvas(state.randomSeed, fw, fh, state.gradient) : null;

  // Render frames sequentially
  for (let f = 0; f < totalFrames; f++) {
    if (f % 5 === 0) btn.textContent = `Recording ${(f / REC_FPS).toFixed(1)}s / ${durationSec.toFixed(1)}s`;

    let sourceOverride = null;
    if (videoForRec) {
      const t = (f / REC_FPS) % videoForRec.duration;
      await seekVideoTo(videoForRec, t);
      sourceOverride = videoForRec;
    } else if (state.mode === 'Noise') {
      time = (f / REC_FPS) * state.speed;
    } else if (state.mode === 'Strips') {
      time = (f / REC_FPS);
    } else if (state.mode === 'Random') {
      sourceOverride = recRandomSrc;
    }

    drawScene(recCtx, fw, fh, { noSmoothing: true, sourceOverride });

    const frame = new VideoFrame(recCanvas, { timestamp: f * (1_000_000 / REC_FPS) });
    encoder.encode(frame, { keyFrame: f % REC_FPS === 0 });
    frame.close();

    // Yield to UI
    if (f % 3 === 0) await new Promise(r => setTimeout(r, 0));
  }

  btn.textContent = 'Finalizing…';
  try {
    await encoder.flush();
    muxer.finalize();
    const blob = new Blob([muxerTarget.buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `enode-${fw}x${fh}.mp4`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (e) {
    console.error(e);
    alert('Finalize failed: ' + e.message);
  }
  if (videoForRec) videoForRec.src = '';
  btn.classList.remove('recording');
  btn.textContent = 'Export MP4';
});

// ─── Export: PNG sequence (zip) ────────────────────────────────
document.getElementById('exportPNGseq').addEventListener('click', async () => {
  const btn = document.getElementById('exportPNGseq');
  if (btn.classList.contains('recording')) return;
  if (typeof JSZip === 'undefined') {
    alert('JSZip not loaded — cannot package frame sequence.');
    return;
  }

  const [rawW, rawH] = getExportSize();
  const fw = rawW, fh = rawH;
  let durationSec = parseFloat(durationSlider.value);
  if (state.mode === 'Video' && activeVideo && isFinite(activeVideo.duration) && activeVideo.duration > 0) {
    durationSec = activeVideo.duration;
  }
  const totalFrames = Math.max(1, Math.round(durationSec * REC_FPS));

  btn.classList.add('recording');
  btn.textContent = 'Preparing…';

  const recCanvas = document.createElement('canvas');
  recCanvas.width = fw; recCanvas.height = fh;
  const recCtx = recCanvas.getContext('2d');

  // Prepare a deterministic video source if needed (mirrors MP4 path)
  let videoForRec = null;
  if (state.mode === 'Video' && activeVideo) {
    videoForRec = document.createElement('video');
    videoForRec.src = activeVideo.currentSrc || activeVideo.src;
    videoForRec.muted = true;
    videoForRec.crossOrigin = 'anonymous';
    videoForRec.playsInline = true;
    await new Promise((res, rej) => {
      videoForRec.addEventListener('loadedmetadata', res, { once: true });
      videoForRec.addEventListener('error', rej, { once: true });
    });
  }
  async function seekVideoTo(v, t) {
    return new Promise((res) => {
      const onSeeked = () => { v.removeEventListener('seeked', onSeeked); res(); };
      v.addEventListener('seeked', onSeeked);
      v.currentTime = t;
    });
  }

  const recRandomSrc = state.mode === 'Random' ? buildRandomCanvas(state.randomSeed, fw, fh, state.gradient) : null;
  const zip = new JSZip();
  const folder = zip.folder(`enode-${fw}x${fh}-${totalFrames}fr`);
  const pad = String(totalFrames).length;

  for (let f = 0; f < totalFrames; f++) {
    btn.textContent = `Rendering ${f + 1} / ${totalFrames}`;

    let sourceOverride = null;
    if (videoForRec) {
      const t = (f / REC_FPS) % videoForRec.duration;
      await seekVideoTo(videoForRec, t);
      sourceOverride = videoForRec;
    } else if (state.mode === 'Noise') {
      time = (f / REC_FPS) * state.speed;
    } else if (state.mode === 'Strips') {
      time = (f / REC_FPS);
    } else if (state.mode === 'Random') {
      sourceOverride = recRandomSrc;
    }

    drawScene(recCtx, fw, fh, { noSmoothing: true, sourceOverride });

    const blob = await new Promise(r => recCanvas.toBlob(r, 'image/png'));
    const name = `frame_${String(f).padStart(pad, '0')}.png`;
    folder.file(name, blob);

    if (f % 2 === 0) await new Promise(r => setTimeout(r, 0));
  }

  btn.textContent = 'Zipping…';
  try {
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `enode-${fw}x${fh}-${totalFrames}fr.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (e) {
    console.error(e);
    alert('Zip failed: ' + e.message);
  }
  if (videoForRec) videoForRec.src = '';
  btn.classList.remove('recording');
  btn.textContent = 'Export PNG sequence';
});

// ─── Source preview (sidebar thumbnail) ─────────────────────────
const sourcePreviewCanvas = document.getElementById('sourcePreviewCanvas');
const sourcePreviewCtx = sourcePreviewCanvas.getContext('2d');
const sourcePreviewWrap = document.getElementById('sourcePreview');
let lastPreviewMode = null;

function updateSourcePreview() {
  // Sized to fit container. Aspect ratio matches current export aspect.
  const targetH = 72;
  const targetW = Math.round(targetH * state.exportW / state.exportH);
  if (sourcePreviewCanvas.width !== targetW) sourcePreviewCanvas.width = targetW;
  if (sourcePreviewCanvas.height !== targetH) sourcePreviewCanvas.height = targetH;

  let src = null;
  if (state.mode === 'Strips') {
    sourcePreviewCtx.fillStyle = '#202020';
    sourcePreviewCtx.fillRect(0, 0, targetW, targetH);
    const step = 3;
    for (let i = 0; i < targetW; i += step) {
      for (let j = 0; j < targetH; j += step) {
        const v = stripsValue(i / Math.max(1, targetW - 1), j / Math.max(1, targetH - 1), time, state.strips);
        const g = Math.round(v * 255);
        sourcePreviewCtx.fillStyle = `rgb(${g},${g},${g})`;
        sourcePreviewCtx.fillRect(i, j, step, step);
      }
    }
    sourcePreviewWrap.classList.add('has-content');
    return;
  } else if (state.mode === 'Noise') {
    sourcePreviewCtx.fillStyle = '#202020';
    sourcePreviewCtx.fillRect(0, 0, targetW, targetH);
    // Sample a few noise points so user knows it's animating
    const ns = 1 / (state.noiseScale * 2 + 0.1);
    const step = 4;
    for (let i = 0; i < targetW; i += step) {
      for (let j = 0; j < targetH; j += step) {
        const v = (simplex.noise3D(i * ns * 0.5, j * ns * 0.5, time) + 1) / 2;
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
  const on = inRandom && state.editRects;
  rectEditor.classList.toggle('active', on);
  chipGradient.classList.toggle('hidden', !inRandom);
  canvasEditBtn.style.display = inRandom ? '' : 'none';
  if (!inRandom && state.editRects) {
    // Exiting Random mode while editing — turn off editing
    state.editRects = false;
    canvasEditBtn.classList.remove('active');
    canvasEditBtn.textContent = 'Edit rectangles';
  }
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
  if (e.key !== 'i' && e.key !== 'I') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  applyTheme(!document.body.classList.contains('light'));
});

// ─── Init ──────────────────────────────────────────────────────
setExportSize(1080, 1080);
setVideoSource(DEMO_VIDEO_URL);
regenerateRects(); // pre-populate so Random shows immediately on first switch
updateEditorVisibility(); // sync Gradient chip visibility with initial mode
updateStripsVisibility(); // hide Strips panel until user picks Strips mode
requestAnimationFrame(tick);
