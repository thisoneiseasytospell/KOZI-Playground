const NS = "http://www.w3.org/2000/svg";

const SCENE_WIDTH = 1920;
const SCENE_HEIGHT = 1080;
const SCENE_CENTER_X = SCENE_WIDTH / 2;
const SCENE_CENTER_Y = SCENE_HEIGHT / 2;
const NODE_INTERVAL_CELLS = 5;
const BASE_CELL = 24;

const board = document.getElementById("board");
const gridLayer = document.getElementById("grid-lines");
const vectorLayer = document.getElementById("vector-layer");
const hitLayer = document.getElementById("hit-layer");
const toggleTrailsBtn = document.getElementById("toggle-trails");
const toggleEraserBtn = document.getElementById("toggle-eraser");

const driverButtons = Array.from(document.querySelectorAll(".driver-btn"));
const randomFillBtn = document.getElementById("random-fill");
const clearBtn = document.getElementById("clear-all");
const toggleGridBtn = document.getElementById("toggle-grid");
const nodeSizeSlider = document.getElementById("node-size-slider");
const nodeSizeLabel = document.getElementById("size-label");
const gridSizeSlider = document.getElementById("grid-size-slider");
const gridSizeLabel = document.getElementById("grid-size-label");
const veinCountControl = document.getElementById("vein-count-control");
const veinCountSlider = document.getElementById("vein-count-slider");
const veinCountLabel = document.getElementById("vein-count-label");
const cloudSpeedControl = document.getElementById("cloud-speed-control");
const cloudSpeedSlider = document.getElementById("cloud-speed-slider");
const cloudSpeedLabel = document.getElementById("cloud-speed-label");
const brushSizeControl = document.getElementById("brush-size-control");
const brushSizeSlider = document.getElementById("brush-size-slider");
const brushSizeLabel = document.getElementById("brush-size-label");
const toggleMotionBtn = document.getElementById("toggle-motion");
const cameraPreview = document.getElementById("camera-preview");
const imagePreview = document.getElementById("image-preview");
const mediaBgEl = document.getElementById("media-bg");
const toggleMediaBgBtn = document.getElementById("toggle-media-bg");
const motionStatusEl = document.getElementById("motion-status");
const toggleUiBtn = document.getElementById("toggle-ui");
const bgColorPicker = document.getElementById("bg-color-picker");
const nodeColorPicker = document.getElementById("node-color-picker");
const bgColorHex = document.getElementById("bg-color-hex");
const nodeColorHex = document.getElementById("node-color-hex");

const DRIVER_LABELS = {
  hover: "Hover",
  ripple: "Ripple",
  arrow: "Arrow",
  camera: "Camera",
};

const LEGACY_VERTICAL_LINES = [66, 1854];
for (let i = 0; i < 29; i += 1) {
  LEGACY_VERTICAL_LINES.push(114 + i * 60, 126 + i * 60);
}
LEGACY_VERTICAL_LINES.sort((a, b) => a - b);

const LEGACY_HORIZONTAL_LINES = [36, 1044];
for (let i = 0; i < 16; i += 1) {
  LEGACY_HORIZONTAL_LINES.push(84 + i * 60, 96 + i * 60);
}
LEGACY_HORIZONTAL_LINES.sort((a, b) => a - b);

let slots = [];
const slotById = new Map();
const placed = new Map();
const renderedVectors = [];
const MAX_UNDO_STEPS = 45;
const undoStack = [];

const pointerState = {
  x: SCENE_CENTER_X,
  y: SCENE_CENTER_Y,
  inside: false,
};

let nodeScalePercent = Number(nodeSizeSlider.value);
let gridScalePercent = Number(gridSizeSlider.value);
let isGridVisible = false;
let motionEnabled = true;
let driverMode = "hover";
let dragAction = null;
const dragVisited = new Set();
let uiVisible = true;
let fillMode = "random";
let soloMode = false;
let soloType = 0;
let morphEnabled = true;
let hoverScaleEnabled = true;
let introRevealActive = true;
let introRevealStartMs = null;
const INTRO_REVEAL_DURATION = 2600;
let lastFrameMs = null;
let renderQueued = false;
let randomizerActive = false;
let randomizerTimer = null;
let veinsActive = false;
let veinCount = Number(veinCountSlider?.value ?? 6);
let cloudsActive = false;
let cloudSpeedPercent = Number(cloudSpeedSlider?.value ?? 100);
let eraserActive = false;
let mediaBgVisible = true;
let brushSize = Number(brushSizeSlider?.value ?? 2);
var tlScrubbing = false;
var tlPlaying = false;
var tlBaseNodeScale = 100;
let cursorInfluenceOff = false;
let autoRotateActive = false;

const HOVER_RADIUS = 360;
const CLICK_RIPPLE_WAVELENGTH = 180;
const CLICK_RIPPLE_SPEED = 0.9;
const CLICK_RIPPLE_DURATION_MS = 2400;
const CLICK_RIPPLE_DISPLACE_PX = 8;
const CLICK_RIPPLE_DISPLACE_RADIUS = 280;
const clickRipples = [];

let cellSize = BASE_CELL;
let cellMargin = BASE_CELL / 4;
let nodeStep = BASE_CELL * NODE_INTERVAL_CELLS;
let rippleRadiusMax = Math.hypot(SCENE_CENTER_X, SCENE_CENTER_Y);

let cameraStream = null;
let cameraEnabled = false;
let cameraPixels = null;
let cameraLumaMin = 0.12;
let cameraLumaMax = 0.9;
let sampleMirrorX = true;
let droppedMediaType = null;
let droppedMediaName = "";
let droppedMediaUrl = null;
let droppedImage = null;
let dropDepth = 0;
let DEFAULT_MARK_COLOR = "#998ed2";
const MIN_NODE_VARIANT_SCALE = 0.55;
const MAX_NODE_VARIANT_SCALE = 1.9;
const MEDIA_PALETTE_FALLBACK = ["#19002f", "#9584d1", "#bbb3d5", "#1a341f", "#6a8665", "#b1c0b3"];
let activeNodePalette = MEDIA_PALETTE_FALLBACK.slice();

const BRAND_COLORS = [
  "#1C1528", "#312B56", "#8B80B3", "#C9C3E5", "#EDE8CA", "#F4F0D8", "#FDFBF0",
  "#1E2624", "#3D4B44", "#929E94", "#C5CFC8", "#E4E0DC", "#EAE8E4", "#F8F6F2",
];
const BRAND_COMBOS = [
  { bg: "#1C1528", node: "#8B80B3" },
  { bg: "#312B56", node: "#C9C3E5" },
  { bg: "#8B80B3", node: "#C9C3E5" },
  { bg: "#1E2624", node: "#C5CFC8" },
  { bg: "#3D4B44", node: "#C5CFC8" },
  { bg: "#929E94", node: "#1E2624" },
];
const bgRect = board.querySelector("rect");

function applyBgColor(hex) {
  bgRect.setAttribute("fill", hex);
  board.style.background = hex;
  document.body.style.background = hex;
}

function applyNodeColor(hex) {
  DEFAULT_MARK_COLOR = hex.toLowerCase();
  for (const [id, entry] of placed) {
    if (entry.type !== 0) {
      entry.color = hex;
    }
  }
  renderVectors();
}

const cameraCanvas = document.createElement("canvas");
cameraCanvas.width = 640;
cameraCanvas.height = 360;
const cameraCtx = cameraCanvas.getContext("2d", { willReadFrequently: true });

function svg(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  Object.entries(attrs).forEach(([name, value]) => {
    el.setAttribute(name, String(value));
  });
  return el;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function gaussian(distance, sigma) {
  return Math.exp(-((distance * distance) / (2 * sigma * sigma)));
}

function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const wx = px - x1;
  const wy = py - y1;
  const len2 = vx * vx + vy * vy;

  if (len2 <= 0.000001) {
    return Math.hypot(px - x1, py - y1);
  }

  const t = clamp01((wx * vx + wy * vy) / len2);
  const cx = x1 + vx * t;
  const cy = y1 + vy * t;
  return Math.hypot(px - cx, py - cy);
}

function addClickRipple(x, y) {
  // In solo mode with morph, cycle to next vector type
  if (soloMode && morphEnabled) {
    soloType = soloType >= 3 ? 1 : soloType + 1;
  }
  clickRipples.push({ x, y, startMs: performance.now(), swapType: (soloMode && morphEnabled) ? soloType : 0, swapped: new Set() });
  if (clickRipples.length > 8) clickRipples.shift();
}

function clickRippleLevel(item, nowMs) {
  let level = 0;
  for (const rip of clickRipples) {
    const age = nowMs - rip.startMs;
    if (age > CLICK_RIPPLE_DURATION_MS) continue;
    const t = age / CLICK_RIPPLE_DURATION_MS;
    const dx = item.cx - rip.x;
    const dy = item.cy - rip.y;
    const dist = Math.hypot(dx, dy);
    const frontRadius = age * CLICK_RIPPLE_SPEED;
    const behind = dist - frontRadius;
    if (behind > CLICK_RIPPLE_WAVELENGTH * 0.5) continue;
    const phase = dist / CLICK_RIPPLE_WAVELENGTH - age * CLICK_RIPPLE_SPEED * 0.01;
    const wave = Math.sin(phase * Math.PI * 2);
    const fadeIn = smoothstep(frontRadius - CLICK_RIPPLE_WAVELENGTH * 3, frontRadius, dist);
    const fadeTime = 1 - t * t;
    level = Math.max(level, (wave * 0.5 + 0.5) * fadeIn * fadeTime);
  }
  return clamp01(level);
}

function clickRippleDisplacement(item, nowMs) {
  let totalX = 0, totalY = 0;
  for (const rip of clickRipples) {
    const age = nowMs - rip.startMs;
    if (age > CLICK_RIPPLE_DURATION_MS) continue;
    const t = age / CLICK_RIPPLE_DURATION_MS;
    const dx = item.cx - rip.x;
    const dy = item.cy - rip.y;
    const dist = Math.max(1, Math.hypot(dx, dy));
    if (dist > CLICK_RIPPLE_DISPLACE_RADIUS) continue;
    const nx = dx / dist;
    const ny = dy / dist;
    const proximity = 1 - smoothstep(0, CLICK_RIPPLE_DISPLACE_RADIUS, dist);
    // Single outward pulse that settles quickly
    const pulse = Math.sin(t * Math.PI) * (1 - t);
    const push = pulse * proximity * proximity * CLICK_RIPPLE_DISPLACE_PX;
    totalX += nx * push;
    totalY += ny * push;
  }
  return { x: totalX, y: totalY };
}


function canAutoToggleFromRipple() {
  return driverMode === "ripple" && fillMode !== "clear" && !eraserActive;
}

function applyRippleToggles(nowMs) {
  if (!canAutoToggleFromRipple()) return;
  let toggled = 0;
  for (const slot of slots) {
    if (toggled >= 12) break;
    const dx = slot.x - SCENE_CENTER_X;
    const dy = slot.y - SCENE_CENTER_Y;
    const distance = Math.hypot(dx, dy);
    const wave = rippleWave(distance, nowMs);
    if (wave > 0.7) {
      const current = normalizeEntry(placed.get(slot.id) ?? entryForNewSlot(slot), slot);
      const nextType = current.type <= 0 ? 1 : (current.type >= 3 ? 1 : current.type + 1);
      placed.set(slot.id, makeEntry(nextType, current.rotQ, current.size, current.color));
      toggled += 1;
    }
  }
  if (toggled > 0) queueRender();
}

/* ---- 2D gradient noise ---- */

const _perm = new Uint8Array(512);

function noiseSeed(s) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let v = Math.abs(s | 0) || 1;
  for (let i = 255; i > 0; i--) {
    v = (v * 1664525 + 1013904223) >>> 0;
    const j = v % (i + 1);
    const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
  }
  for (let i = 0; i < 512; i++) _perm[i] = p[i & 255];
}

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

function grad2d(hash, x, y) {
  const h = hash & 3;
  return (h & 1 ? -x : x) + (h & 2 ? -y : y);
}

function noise2d(x, y) {
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = fade(xf);
  const v = fade(yf);
  const aa = _perm[_perm[xi] + yi];
  const ab = _perm[_perm[xi] + yi + 1];
  const ba = _perm[_perm[xi + 1] + yi];
  const bb = _perm[_perm[xi + 1] + yi + 1];
  return lerp(
    lerp(grad2d(aa, xf, yf), grad2d(ba, xf - 1, yf), u),
    lerp(grad2d(ab, xf, yf - 1), grad2d(bb, xf - 1, yf - 1), u),
    v
  );
}

function fbm2d(x, y, octaves) {
  let value = 0, amp = 1, freq = 1, max = 0;
  for (let i = 0; i < octaves; i++) {
    value += noise2d(x * freq, y * freq) * amp;
    max += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return value / max;
}

/* ---- end noise ---- */

function softBand(x, start, end, softness) {
  if (end <= start) return 0;
  const lead = smoothstep(start - softness, start + softness, x);
  const tail = 1 - smoothstep(end - softness, end + softness, x);
  return clamp01(lead * tail);
}

function updateMotionStatus() {
  if (!motionStatusEl) return;

  if (!motionEnabled) {
    motionStatusEl.textContent = `${DRIVER_LABELS[driverMode]} paused`;
    return;
  }

  if (driverMode === "camera" && droppedMediaType) {
    motionStatusEl.textContent = `Media active (${droppedMediaName})`;
    return;
  }

  if (driverMode === "camera" && !cameraEnabled) {
    motionStatusEl.textContent = "Camera unavailable | drop image/mp4 or use localhost/https";
    return;
  }

  motionStatusEl.textContent = `${DRIVER_LABELS[driverMode]} active | drop image/mp4`;
}

function updateDriverButtons() {
  for (const btn of driverButtons) {
    btn.classList.toggle("is-active", btn.dataset.driver === driverMode);
  }
}

function updatePreviewState() {
  const showVideoPreview = driverMode === "camera" && (cameraEnabled || droppedMediaType === "video");
  const showImagePreview = driverMode === "camera" && droppedMediaType === "image";
  const mirrored = driverMode === "camera" && cameraEnabled && droppedMediaType !== "video";
  document.body.classList.toggle("camera-on", showVideoPreview);
  document.body.classList.toggle("image-on", showImagePreview);
  document.body.classList.toggle("camera-mirrored", mirrored);

  const hasMedia = driverMode === "camera" && droppedMediaType;
  toggleMediaBgBtn.style.display = hasMedia ? "" : "none";
}

function setUiVisible(nextVisible) {
  uiVisible = nextVisible;
  document.body.classList.toggle("ui-hidden", !nextVisible);
  toggleUiBtn.style.display = nextVisible ? "" : "none";
  toggleUiBtn.textContent = nextVisible ? "Hide UI" : "Show UI";
}

function setGridVisibility(nextVisible) {
  isGridVisible = nextVisible;
  document.body.classList.toggle("grid-hidden", !nextVisible);
  if (toggleGridBtn) {
    toggleGridBtn.classList.toggle("is-active", nextVisible);
  }
}

function setNodeScale(nextPercent) {
  nodeScalePercent = nextPercent;
  nodeSizeLabel.textContent = `Node ${nodeScalePercent.toFixed(0)}%`;
  renderVectors();
}

function setGridScale(nextPercent) {
  gridScalePercent = nextPercent;
  gridSizeLabel.textContent = `Grid ${gridScalePercent.toFixed(1)}%`;
  rebuildGridGeometry();
}

function setVeinCount(nextCount) {
  const safeCount = Math.max(1, Math.min(100, Math.round(nextCount)));
  veinCount = safeCount;
  if (veinCountSlider) {
    veinCountSlider.value = String(safeCount);
  }
  if (veinCountLabel) {
    veinCountLabel.textContent = `Veins ${safeCount}`;
  }
  if (veinsActive) {
    spawnInitialVeins();
  }
}

function updateVeinCountControl() {
  if (!veinCountControl) return;
  veinCountControl.classList.toggle("is-hidden", !veinsActive);
}

function setCloudSpeed(nextPercent) {
  const safePercent = Math.max(10, Math.min(350, Math.round(nextPercent)));
  cloudSpeedPercent = safePercent;
  if (cloudSpeedSlider) {
    cloudSpeedSlider.value = String(safePercent);
  }
  if (cloudSpeedLabel) {
    cloudSpeedLabel.textContent = `Cloud speed ${safePercent}%`;
  }
}

function updateCloudSpeedControl() {
  if (!cloudSpeedControl) return;
  cloudSpeedControl.classList.toggle("is-hidden", !cloudsActive);
}

function setBrushSize(nextSize) {
  const safeSize = Math.max(1, Math.min(7, Math.round(nextSize)));
  brushSize = safeSize;
  if (brushSizeSlider) {
    brushSizeSlider.value = String(safeSize);
  }
  if (brushSizeLabel) {
    brushSizeLabel.textContent = `Brush size ${safeSize}`;
  }
}

function updateBrushSizeControl() {
  if (!brushSizeControl) return;
  const active = fillMode === "clear";
  brushSizeControl.classList.toggle("is-hidden", !active);
  if (brushSizeSlider) {
    brushSizeSlider.disabled = !active;
  }
  if (brushSizeLabel) {
    brushSizeLabel.textContent = `Brush size ${brushSize}`;
  }
}

function setFillMode(nextMode) {
  fillMode = nextMode;
  if (fillMode === "clear" && eraserActive) {
    eraserActive = false;
    toggleEraserBtn.classList.remove("is-active");
  }
  clearBtn.classList.toggle("is-active", fillMode === "clear");
  updateBrushSizeControl();
}

function isMotionControlApplicable() {
  return introRevealActive || driverMode !== "hover" || veinsActive || cloudsActive;
}

function updateMotionControlVisibility() {
  const shouldShow = isMotionControlApplicable();
  toggleMotionBtn.hidden = !shouldShow;
  if (!shouldShow && !motionEnabled) {
    motionEnabled = true;
    toggleMotionBtn.classList.add("is-active");
    toggleMotionBtn.textContent = "Pause";
    updateMotionStatus();
  }
}

function setMotion(nextMotion) {
  if (!isMotionControlApplicable()) {
    nextMotion = true;
  }
  motionEnabled = nextMotion;
  toggleMotionBtn.classList.toggle("is-active", nextMotion);
  toggleMotionBtn.textContent = nextMotion ? "Pause" : "Play";
  updateMotionStatus();
  updateMotionControlVisibility();
}

function isSecureCameraContext() {
  const host = window.location.hostname;
  return window.location.protocol === "https:" || host === "localhost" || host === "127.0.0.1";
}

async function startCamera() {
  if (cameraEnabled) return true;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    updateMotionStatus();
    return false;
  }

  if (!isSecureCameraContext()) {
    updateMotionStatus();
    return false;
  }

  try {
    cameraPreview.pause();
    cameraPreview.removeAttribute("src");
    cameraPreview.load();

    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });

    cameraPreview.srcObject = cameraStream;
    await new Promise((resolve) => {
      const done = () => resolve();
      cameraPreview.onloadedmetadata = done;
      window.setTimeout(done, 450);
    });
    await cameraPreview.play().catch(() => {});

    const videoW = cameraPreview.videoWidth || 1280;
    const videoH = cameraPreview.videoHeight || 720;
    cameraCanvas.width = Math.max(480, Math.min(960, Math.round(videoW / 2)));
    cameraCanvas.height = Math.max(270, Math.min(540, Math.round(videoH / 2)));

    sampleMirrorX = true;
    cameraEnabled = true;
    updatePreviewState();
    updateMotionStatus();
    return true;
  } catch (error) {
    console.error("Camera start failed:", error);
    cameraEnabled = false;
    updateMotionStatus();
    return false;
  }
}

function stopCamera() {
  if (cameraStream) {
    for (const track of cameraStream.getTracks()) {
      track.stop();
    }
  }

  cameraStream = null;
  cameraPixels = null;
  cameraEnabled = false;
  cameraLumaMin = 0.12;
  cameraLumaMax = 0.9;
  if (cameraPreview.srcObject) {
    cameraPreview.srcObject = null;
  }
  updatePreviewState();
  updateMotionStatus();
  updateMotionControlVisibility();
}

async function setDriverMode(nextMode) {
  if (!Object.prototype.hasOwnProperty.call(DRIVER_LABELS, nextMode)) return;

  const previousMode = driverMode;
  driverMode = nextMode;
  updateDriverButtons();

  if (driverMode === "camera") {
    if (droppedMediaType) {
      if (cameraEnabled) {
        stopCamera();
      }
      if (droppedMediaType === "video") {
        await cameraPreview.play().catch(() => {});
      }
    } else {
      const started = await startCamera();
      if (!started) {
        driverMode = "hover";
        updateDriverButtons();
      }
    }
  } else if (previousMode === "camera" && cameraEnabled) {
    stopCamera();
  } else if (previousMode === "camera" && droppedMediaType === "video") {
    cameraPreview.pause();
  }


  if (driverMode === "hover" && !motionEnabled) {
    setMotion(true);
  }

  updatePreviewState();
  updateMotionStatus();
  updateMotionControlVisibility();
}

function isValidHexColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function rgbToHex(r, g, b) {
  const hex = (value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function hexToRgb(hex) {
  if (!isValidHexColor(hex)) return null;
  const clean = hex.slice(1);
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
    hex: `#${clean.toLowerCase()}`,
  };
}

function colorLuma01(color) {
  return (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
}

function ensureColorVisibility(hex, minLuma = 0.22) {
  const parsed = hexToRgb(hex);
  if (!parsed) return DEFAULT_MARK_COLOR;
  const luma = colorLuma01(parsed);
  if (luma >= minLuma) return parsed.hex;
  const mix = clamp((minLuma - luma) / Math.max(0.0001, 1 - luma), 0, 1);
  return rgbToHex(
    lerp(parsed.r, 236, mix),
    lerp(parsed.g, 236, mix),
    lerp(parsed.b, 236, mix)
  );
}

function colorDistanceSq(a, b) {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

function paletteAsRgb(paletteHex = activeNodePalette) {
  const parsed = paletteHex.map(hexToRgb).filter(Boolean);
  if (parsed.length > 0) return parsed;
  return MEDIA_PALETTE_FALLBACK.map(hexToRgb).filter(Boolean);
}

function nearestPaletteColor(r, g, b, paletteRgb = paletteAsRgb()) {
  if (!paletteRgb.length) return null;
  const input = { r, g, b };
  let best = paletteRgb[0];
  let bestDist = colorDistanceSq(input, best);
  for (let i = 1; i < paletteRgb.length; i += 1) {
    const candidate = paletteRgb[i];
    const distance = colorDistanceSq(input, candidate);
    if (distance < bestDist) {
      bestDist = distance;
      best = candidate;
    }
  }
  return best;
}

function entryStyleForSlot(slot) {
  const organic = fbm2d(slot.x * 0.013 + 930, slot.y * 0.013 - 640, 2);
  const size = clamp(1 + organic * 0.12, MIN_NODE_VARIANT_SCALE, MAX_NODE_VARIANT_SCALE);
  return { size, color: DEFAULT_MARK_COLOR };
}

function makeEntry(type, rotQ, size = 1, color = DEFAULT_MARK_COLOR) {
  return {
    type: clamp(Math.round(type), 0, 3),
    rotQ: ((Math.round(rotQ) % 4) + 4) % 4,
    size: clamp(Number.isFinite(size) ? size : 1, MIN_NODE_VARIANT_SCALE, MAX_NODE_VARIANT_SCALE),
    color: isValidHexColor(color) ? color.toLowerCase() : DEFAULT_MARK_COLOR,
  };
}

function normalizeEntry(entry, slot = null) {
  const source = entry && typeof entry === "object" ? entry : null;
  const type = clamp(Math.round(Number(source?.type ?? 0)), 0, 3);
  const rotQ = ((Math.round(Number(source?.rotQ ?? 0)) % 4) + 4) % 4;
  const defaultStyle = slot ? entryStyleForSlot(slot) : { size: 1, color: DEFAULT_MARK_COLOR };
  const size = Number.isFinite(source?.size) ? source.size : defaultStyle.size;
  const color = isValidHexColor(source?.color) ? source.color : defaultStyle.color;
  return makeEntry(type, rotQ, size, color);
}

function randomEntry(slot = null) {
  const style = slot ? entryStyleForSlot(slot) : { size: 1, color: DEFAULT_MARK_COLOR };
  return makeEntry(Math.floor(Math.random() * 3) + 1, Math.floor(Math.random() * 4), style.size, style.color);
}

function sampleEntry(slot) {
  const type = ((Math.abs(slot.i) + Math.abs(slot.j)) % 3) + 1;
  const rotQ = ((((slot.i * 3 + slot.j * 5) % 4) + 4) % 4);
  const style = entryStyleForSlot(slot);
  return makeEntry(type, rotQ, style.size, style.color);
}

function entryForNewSlot(slot) {
  if (fillMode === "clear") return makeEntry(0, 0);
  return fillMode === "random" ? randomEntry(slot) : sampleEntry(slot);
}

function extractPaletteFromCameraPixels(maxColors = 6) {
  if (!cameraPixels || cameraPixels.length < 4) {
    return MEDIA_PALETTE_FALLBACK.slice(0, maxColors);
  }

  const buckets = new Map();
  const pixelCount = cameraCanvas.width * cameraCanvas.height;
  const stridePx = clamp(Math.floor(pixelCount / 2200), 1, 14);
  const stride = stridePx * 4;
  const quant = 24;

  for (let index = 0; index < cameraPixels.length; index += stride) {
    const r = cameraPixels[index];
    const g = cameraPixels[index + 1];
    const b = cameraPixels[index + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const centerBias = 1 - Math.abs(luma - 0.46);
    const weight = Math.max(0.2, 0.6 + sat * 1.55 + centerBias * 0.45);

    const qr = clamp(Math.round(r / quant) * quant, 0, 255);
    const qg = clamp(Math.round(g / quant) * quant, 0, 255);
    const qb = clamp(Math.round(b / quant) * quant, 0, 255);
    const key = `${qr},${qg},${qb}`;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { w: 0, r: 0, g: 0, b: 0 };
      buckets.set(key, bucket);
    }

    bucket.w += weight;
    bucket.r += r * weight;
    bucket.g += g * weight;
    bucket.b += b * weight;
  }

  const candidates = [];
  for (const bucket of buckets.values()) {
    if (bucket.w <= 1.2) continue;
    const r = bucket.r / bucket.w;
    const g = bucket.g / bucket.w;
    const b = bucket.b / bucket.w;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    candidates.push({
      r,
      g,
      b,
      sat,
      score: bucket.w * (0.45 + sat * 2.2),
    });
  }
  candidates.sort((a, b) => b.score - a.score);

  const chosen = [];
  const minDistanceSq = 42 * 42;
  for (const candidate of candidates) {
    if (chosen.length >= maxColors) break;
    if (chosen.every((current) => colorDistanceSq(candidate, current) >= minDistanceSq)) {
      chosen.push(candidate);
    }
  }

  const fallbackRgb = MEDIA_PALETTE_FALLBACK.map(hexToRgb).filter(Boolean);
  for (const fallback of fallbackRgb) {
    if (chosen.length >= maxColors) break;
    if (chosen.every((current) => colorDistanceSq(fallback, current) >= 26 * 26)) {
      chosen.push(fallback);
    }
  }

  if (chosen.length === 0) {
    return MEDIA_PALETTE_FALLBACK.slice(0, maxColors);
  }

  return chosen.slice(0, maxColors).map((color) => rgbToHex(color.r, color.g, color.b));
}

function sampleMediaPixelAtScene(sceneX, sceneY) {
  if (!cameraPixels || cameraCanvas.width < 1 || cameraCanvas.height < 1) return null;
  const width = cameraCanvas.width;
  const height = cameraCanvas.height;
  const xNormRaw = sampleMirrorX ? 1 - sceneX / SCENE_WIDTH : sceneX / SCENE_WIDTH;
  const xNorm = clamp01(xNormRaw);
  const yNorm = clamp01(sceneY / SCENE_HEIGHT);
  const px = clamp(Math.round(xNorm * (width - 1)), 0, width - 1);
  const py = clamp(Math.round(yNorm * (height - 1)), 0, height - 1);
  const index = (py * width + px) * 4;
  const r = cameraPixels[index];
  const g = cameraPixels[index + 1];
  const b = cameraPixels[index + 2];
  return {
    r,
    g,
    b,
    luma: (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255,
  };
}

function imageEntryForSlot(slot, paletteRgb = paletteAsRgb()) {
  const center = sampleMediaPixelAtScene(slot.x, slot.y);
  if (!center) {
    return sampleEntry(slot);
  }

  const offset = Math.max(8, nodeStep * 0.65);
  const left = sampleMediaPixelAtScene(slot.x - offset, slot.y) ?? center;
  const right = sampleMediaPixelAtScene(slot.x + offset, slot.y) ?? center;
  const up = sampleMediaPixelAtScene(slot.x, slot.y - offset) ?? center;
  const down = sampleMediaPixelAtScene(slot.x, slot.y + offset) ?? center;

  const gradX = right.luma - left.luma;
  const gradY = down.luma - up.luma;
  const gradient = clamp01(Math.hypot(gradX, gradY) * 2.1);

  let type;
  if (center.luma < 0.34) {
    type = 3;
  } else if (center.luma < 0.65) {
    type = gradient > 0.34 ? 2 : 3;
  } else {
    type = gradient > 0.3 ? 1 : 2;
  }

  const angle = Math.atan2(gradY, gradX);
  const rotQ = ((Math.round(angle / (Math.PI * 0.5)) % 4) + 4) % 4;
  const noise = fbm2d(slot.x * 0.017 + 2100, slot.y * 0.017 - 1300, 2);
  const size = clamp(
    0.9 + (1 - center.luma) * 0.52 + gradient * 0.95 + noise * 0.14,
    0.78,
    MAX_NODE_VARIANT_SCALE
  );
  const paletteColor = nearestPaletteColor(center.r, center.g, center.b, paletteRgb);
  return makeEntry(type, rotQ, size, ensureColorVisibility(paletteColor?.hex ?? DEFAULT_MARK_COLOR, 0.2));
}

function paintDroppedImageToSlots() {
  if (droppedMediaType !== "image" || !cameraPixels || slots.length === 0) return false;
  const extracted = extractPaletteFromCameraPixels(6);
  const blendedPalette = [];
  for (let i = 0; i < Math.max(extracted.length, MEDIA_PALETTE_FALLBACK.length); i += 1) {
    if (i < extracted.length) blendedPalette.push(extracted[i]);
    if (i < MEDIA_PALETTE_FALLBACK.length) blendedPalette.push(MEDIA_PALETTE_FALLBACK[i]);
  }
  activeNodePalette = [...new Set(blendedPalette)].slice(0, 6);
  const paletteRgb = paletteAsRgb(activeNodePalette);
  for (const slot of slots) {
    placed.set(slot.id, imageEntryForSlot(slot, paletteRgb));
  }
  return true;
}

function restartIntroReveal() {
  introRevealActive = true;
  introRevealStartMs = null;
}

function stopIntroReveal() {
  introRevealActive = false;
  introRevealStartMs = null;
}

function clonePlacedState() {
  const snapshot = new Map();
  for (const slot of slots) {
    const entry = normalizeEntry(placed.get(slot.id), slot);
    snapshot.set(slot.id, {
      type: entry.type,
      rotQ: entry.rotQ,
      size: entry.size,
      color: entry.color,
    });
  }
  return snapshot;
}

function restorePlacedState(snapshot) {
  placed.clear();
  for (const slot of slots) {
    const entry = snapshot.get(slot.id) ?? makeEntry(0, 0);
    placed.set(slot.id, normalizeEntry(entry, slot));
  }
}

function pushUndoState() {
  if (slots.length === 0) return;
  undoStack.push(clonePlacedState());
  if (undoStack.length > MAX_UNDO_STEPS) {
    undoStack.shift();
  }
}

function clearUndoState() {
  undoStack.length = 0;
}

function stepBack() {
  if (undoStack.length === 0) return;
  stopRandomizer();
  const snapshot = undoStack.pop();
  if (!snapshot) return;
  restorePlacedState(snapshot);
  stopIntroReveal();
  renderVectors();
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  window.requestAnimationFrame(() => {
    renderQueued = false;
    renderVectors();
  });
}

function resetLumaRange() {
  cameraLumaMin = 0.12;
  cameraLumaMax = 0.9;
}

function sourceDimensions(source) {
  if (source instanceof HTMLVideoElement) {
    return { width: source.videoWidth || 0, height: source.videoHeight || 0 };
  }
  if (source instanceof HTMLImageElement) {
    return { width: source.naturalWidth || source.width || 0, height: source.naturalHeight || source.height || 0 };
  }
  return { width: 0, height: 0 };
}

function setSamplingCanvasSize(sourceWidth, sourceHeight) {
  const safeW = Math.max(1, sourceWidth);
  const safeH = Math.max(1, sourceHeight);
  const aspect = safeW / safeH;

  let targetW = Math.max(320, Math.min(960, Math.round(safeW / 2)));
  let targetH = Math.round(targetW / aspect);

  if (targetH < 180) {
    targetH = 180;
    targetW = Math.round(targetH * aspect);
  }

  if (targetH > 540) {
    targetH = 540;
    targetW = Math.round(targetH * aspect);
  }

  cameraCanvas.width = Math.max(1, targetW);
  cameraCanvas.height = Math.max(1, targetH);
}

function drawSourceToSamplingCanvas(source) {
  const { width: sourceW, height: sourceH } = sourceDimensions(source);
  if (sourceW < 1 || sourceH < 1) return false;

  const targetW = cameraCanvas.width;
  const targetH = cameraCanvas.height;
  const sourceAspect = sourceW / sourceH;
  const targetAspect = targetW / targetH;

  let sx = 0;
  let sy = 0;
  let sw = sourceW;
  let sh = sourceH;

  if (sourceAspect > targetAspect) {
    sw = sourceH * targetAspect;
    sx = (sourceW - sw) * 0.5;
  } else if (sourceAspect < targetAspect) {
    sh = sourceW / targetAspect;
    sy = (sourceH - sh) * 0.5;
  }

  cameraCtx.clearRect(0, 0, targetW, targetH);
  cameraCtx.drawImage(source, sx, sy, sw, sh, 0, 0, targetW, targetH);
  cameraPixels = cameraCtx.getImageData(0, 0, targetW, targetH).data;
  return true;
}

function adaptLumaRange() {
  if (!cameraPixels) return;
  const sampleStride = 32;
  let localMin = 1;
  let localMax = 0;

  for (let index = 0; index < cameraPixels.length; index += sampleStride) {
    const r = cameraPixels[index];
    const g = cameraPixels[index + 1];
    const b = cameraPixels[index + 2];
    const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (luma < localMin) localMin = luma;
    if (luma > localMax) localMax = luma;
  }

  if (localMax - localMin > 0.02) {
    cameraLumaMin = lerp(cameraLumaMin, localMin, 0.18);
    cameraLumaMax = lerp(cameraLumaMax, localMax, 0.18);
  }
}

function releaseDroppedMedia() {
  if (droppedMediaUrl) {
    URL.revokeObjectURL(droppedMediaUrl);
    droppedMediaUrl = null;
  }

  droppedMediaType = null;
  droppedMediaName = "";
  droppedImage = null;
  cameraPixels = null;
  activeNodePalette = MEDIA_PALETTE_FALLBACK.slice();

  imagePreview.removeAttribute("src");
  mediaBgEl.style.display = "none";
  mediaBgEl.removeAttribute("href");
  toggleMediaBgBtn.style.display = "none";

  if (!cameraPreview.srcObject) {
    cameraPreview.pause();
    cameraPreview.removeAttribute("src");
    cameraPreview.load();
  }

  updatePreviewState();
}

function isSupportedDroppedFile(file) {
  if (!file) return false;
  if (file.type.startsWith("image/")) return true;
  if (file.type === "video/mp4") return true;
  return file.type.startsWith("video/");
}

function pickDroppedFile(fileList) {
  if (!fileList || fileList.length === 0) return null;
  for (const file of fileList) {
    if (isSupportedDroppedFile(file)) {
      return file;
    }
  }
  return null;
}

async function loadDroppedImage(file) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";

  try {
    await new Promise((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Image load failed"));
      image.src = url;
    });
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }

  if (cameraEnabled) {
    stopCamera();
  }

  releaseDroppedMedia();
  droppedMediaType = "image";
  droppedMediaName = file.name;
  droppedMediaUrl = url;
  droppedImage = image;

  imagePreview.src = url;
  mediaBgEl.setAttribute("href", url);
  if (mediaBgVisible) mediaBgEl.style.display = "";
  mediaBgEl.style.opacity = "0.18";

  sampleMirrorX = false;
  resetLumaRange();
  setSamplingCanvasSize(image.naturalWidth, image.naturalHeight);
  drawSourceToSamplingCanvas(image);
  adaptLumaRange();
  if (slots.length > 0) {
    pushUndoState();
  }
  stopRandomizer();
  setFillMode("sample");
  if (paintDroppedImageToSlots()) {
    stopIntroReveal();
    renderVectors();
  }

  if (!motionEnabled) {
    setMotion(true);
  }
  if (driverMode !== "camera") {
    await setDriverMode("camera");
    return;
  }
  updatePreviewState();
  updateMotionStatus();
}

async function loadDroppedVideo(file) {
  const url = URL.createObjectURL(file);

  if (cameraEnabled) {
    stopCamera();
  }

  releaseDroppedMedia();
  droppedMediaType = "video";
  droppedMediaName = file.name;
  droppedMediaUrl = url;
  droppedImage = null;
  sampleMirrorX = false;
  resetLumaRange();

  cameraPreview.pause();
  cameraPreview.srcObject = null;
  cameraPreview.src = url;
  cameraPreview.loop = true;
  cameraPreview.muted = true;
  cameraPreview.playsInline = true;

  try {
    await new Promise((resolve, reject) => {
      const onLoaded = () => {
        cameraPreview.removeEventListener("loadeddata", onLoaded);
        cameraPreview.removeEventListener("error", onError);
        resolve();
      };
      const onError = () => {
        cameraPreview.removeEventListener("loadeddata", onLoaded);
        cameraPreview.removeEventListener("error", onError);
        reject(new Error("Video load failed"));
      };
      cameraPreview.addEventListener("loadeddata", onLoaded);
      cameraPreview.addEventListener("error", onError);
    });

    await cameraPreview.play().catch(() => {});
    setSamplingCanvasSize(cameraPreview.videoWidth || 1280, cameraPreview.videoHeight || 720);
    mediaBgEl.style.opacity = "0.18";

    stopIntroReveal();
    if (!motionEnabled) {
      setMotion(true);
    }
    if (driverMode !== "camera") {
      await setDriverMode("camera");
      return;
    }
    updatePreviewState();
    updateMotionStatus();
  } catch (error) {
    releaseDroppedMedia();
    throw error;
  }
}

async function loadDroppedMedia(file) {
  if (file.type.startsWith("image/")) {
    await loadDroppedImage(file);
    return;
  }
  await loadDroppedVideo(file);
}

function computeGeometry() {
  cellSize = Math.max(4, BASE_CELL * (gridScalePercent / 100));
  cellMargin = cellSize / 4;
  nodeStep = cellSize * NODE_INTERVAL_CELLS;
  rippleRadiusMax = Math.hypot(SCENE_CENTER_X, SCENE_CENTER_Y);
}

function drawLegacyGridLines() {
  gridLayer.replaceChildren();
  const fragment = document.createDocumentFragment();

  for (const x of LEGACY_VERTICAL_LINES) {
    fragment.appendChild(svg("line", { x1: x, y1: 36, x2: x, y2: 1044 }));
  }

  for (const y of LEGACY_HORIZONTAL_LINES) {
    fragment.appendChild(svg("line", { x1: 66, y1: y, x2: 1854, y2: y }));
  }

  gridLayer.appendChild(fragment);
}

function rebuildSlots() {
  slots = [];
  slotById.clear();

  const maxI = Math.ceil((SCENE_WIDTH / 2) / nodeStep) + 2;
  const maxJ = Math.ceil((SCENE_HEIGHT / 2) / nodeStep) + 2;

  for (let i = -maxI; i <= maxI; i += 1) {
    const x = SCENE_CENTER_X + i * nodeStep;
    if (x < -nodeStep || x > SCENE_WIDTH + nodeStep) continue;

    for (let j = -maxJ; j <= maxJ; j += 1) {
      const y = SCENE_CENTER_Y + j * nodeStep;
      if (y < -nodeStep || y > SCENE_HEIGHT + nodeStep) continue;

      const id = `n-${i}-${j}`;
      const slot = { id, i, j, x, y };
      slots.push(slot);
      slotById.set(id, slot);

      if (!placed.has(id)) {
        placed.set(id, entryForNewSlot(slot));
      } else {
        placed.set(id, normalizeEntry(placed.get(id), slot));
      }
    }
  }

  slots.sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));

  if (droppedMediaType === "image" && cameraPixels && fillMode !== "clear") {
    const paletteRgb = paletteAsRgb(activeNodePalette);
    for (const slot of slots) {
      placed.set(slot.id, imageEntryForSlot(slot, paletteRgb));
    }
  }
}

function rebuildGridGeometry() {
  computeGeometry();
  rebuildSlots();
  buildHitLayer();
  renderVectors();
}

function makeVectorGraphic(entry, slot) {
  const baseNode = cellSize - cellMargin * 2;
  const variant = clamp(Number.isFinite(entry.size) ? entry.size : 1, MIN_NODE_VARIANT_SCALE, MAX_NODE_VARIANT_SCALE);
  const scaled = Math.max(1.2, baseNode * (nodeScalePercent / 100) * variant);
  const rawColor = isValidHexColor(entry.color) ? entry.color : DEFAULT_MARK_COLOR;
  const fillColor = droppedMediaType === "image" ? ensureColorVisibility(rawColor, 0.2) : rawColor;
  let mark;

  if (entry.type === 1) {
    mark = svg("circle", {
      cx: slot.x.toFixed(2),
      cy: slot.y.toFixed(2),
      r: (scaled / 2).toFixed(2),
      fill: fillColor,
    });
  } else if (entry.type === 2) {
    mark = svg("rect", {
      x: (slot.x - scaled / 2).toFixed(2),
      y: (slot.y - scaled / 2).toFixed(2),
      width: scaled.toFixed(2),
      height: scaled.toFixed(2),
      fill: fillColor,
    });
  } else {
    const width = scaled;
    const barRatio = droppedMediaType === "image" ? 0.3 : 0.18;
    const minHeight = droppedMediaType === "image" ? 1.6 : 0.9;
    const height = Math.max(minHeight, scaled * barRatio);
    mark = svg("rect", {
      x: (slot.x - width / 2).toFixed(2),
      y: (slot.y - height / 2).toFixed(2),
      width: width.toFixed(2),
      height: height.toFixed(2),
      fill: fillColor,
    });
  }

  mark.classList.add("vector-mark");
  return mark;
}

function applyTransform(item, scale) {
  const rotation = item.rot ?? item.entry.rotQ * 90;
  const useImageCrispMode = droppedMediaType === "image";
  const safeScale = useImageCrispMode ? Math.round(scale * 24) / 24 : scale;
  const tx = item.dx || 0;
  const ty = item.dy || 0;
  const translate = (tx !== 0 || ty !== 0) ? `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) ` : "";
  item.el.style.transform = `${translate}rotate(${rotation.toFixed(1)}deg) scale(${safeScale.toFixed(3)})`;
  const alpha = useImageCrispMode ? 1 : item.opacity;
  item.el.style.opacity = alpha.toFixed(3);
}

function renderVectors() {
  const previousState = new Map();
  for (const item of renderedVectors) {
    previousState.set(item.slot.id, { scale: item.scale, motion: item.motion, opacity: item.opacity, dx: item.dx, dy: item.dy, rot: item.rot });
  }

  vectorLayer.replaceChildren();
  renderedVectors.length = 0;

  const fragment = document.createDocumentFragment();
  const imagePalette = droppedMediaType === "image" ? paletteAsRgb(activeNodePalette) : null;

  for (const slot of slots) {
    const rawEntry = placed.get(slot.id);
    let entry = normalizeEntry(rawEntry, slot);
    if ((!rawEntry || entry.type === 0) && droppedMediaType === "image" && cameraPixels && fillMode !== "clear") {
      entry = imageEntryForSlot(slot, imagePalette ?? paletteAsRgb(activeNodePalette));
      placed.set(slot.id, entry);
    } else if (
      !rawEntry
      || rawEntry.type !== entry.type
      || rawEntry.rotQ !== entry.rotQ
      || rawEntry.size !== entry.size
      || rawEntry.color !== entry.color
    ) {
      placed.set(slot.id, entry);
    }
    if (entry.type === 0) continue;

    const mark = makeVectorGraphic(entry, slot);
    const phase = ((slot.x * 0.021 + slot.y * 0.017) * Math.PI) / 180;
    const baseScale = introRevealActive ? 0.001 : 1;
    const prev = previousState.get(slot.id);
    const startScale = prev ? prev.scale : baseScale;
    const startMotion = prev ? prev.motion : 0;
    const startOpacity = prev ? prev.opacity : 1;
    const startDx = prev ? (prev.dx || 0) : 0;
    const startDy = prev ? (prev.dy || 0) : 0;
    const startRot = prev ? (prev.rot ?? entry.rotQ * 90) : entry.rotQ * 90;
    const item = { slot, entry, el: mark, cx: slot.x, cy: slot.y, phase, scale: startScale, motion: startMotion, opacity: startOpacity, dx: startDx, dy: startDy, rot: startRot };
    applyTransform(item, startScale);
    renderedVectors.push(item);
    fragment.appendChild(mark);
  }

  vectorLayer.appendChild(fragment);
}

function cycleSlot(slot, direction, defer = false) {
  const current = normalizeEntry(placed.get(slot.id) ?? entryForNewSlot(slot), slot);
  const nextType = ((current.type + direction) % 4 + 4) % 4;
  placed.set(slot.id, makeEntry(nextType, current.rotQ, current.size, current.color));
  if (defer) {
    queueRender();
  } else {
    renderVectors();
  }
}

function loadSample(skipUndo = false) {
  if (skipUndo !== true) {
    pushUndoState();
  }
  stopRandomizer();
  setFillMode("sample");
  for (const slot of slots) {
    placed.set(slot.id, sampleEntry(slot));
  }
  restartIntroReveal();
  renderVectors();
}

function randomizeOneNode() {
  if (slots.length === 0) return;
  const slot = slots[Math.floor(Math.random() * slots.length)];
  const newEntry = randomEntry(slot);
  placed.set(slot.id, newEntry);

  const item = renderedVectors.find(r => r.slot.id === slot.id);
  if (!item) {
    queueRender();
    return;
  }

  const newMark = makeVectorGraphic(newEntry, slot);
  vectorLayer.replaceChild(newMark, item.el);
  item.el = newMark;
  item.entry = newEntry;
  applyTransform(item, item.scale);
}

function randomizerTick() {
  const count = 1 + Math.floor(Math.random() * 4);
  for (let i = 0; i < count; i++) {
    randomizeOneNode();
  }
}

function stopRandomizer() {
  if (!randomizerActive) return;
  randomizerActive = false;
  if (randomizerTimer) {
    clearInterval(randomizerTimer);
    randomizerTimer = null;
  }
  randomFillBtn.classList.remove("is-active");
}

function randomFill() {
  if (randomizerActive) {
    stopRandomizer();
    return;
  }

  pushUndoState();

  soloMode = false;
  hoverScaleEnabled = true;
  document.getElementById("toggle-hover-scale").classList.add("is-active");
  setFillMode("random");

  // Organic noise fill as the base
  const seed = Math.floor(Math.random() * 100000);
  noiseSeed(seed);
  const typeScale = 0.005 + Math.random() * 0.009;
  const rotScale = 0.008 + Math.random() * 0.014;
  const offsetX = Math.random() * 500;
  const offsetY = Math.random() * 500;
  for (const slot of slots) {
    const nx = slot.x * typeScale + offsetX;
    const ny = slot.y * typeScale + offsetY;
    const n1 = fbm2d(nx, ny, 3);
    const n2 = fbm2d(slot.x * rotScale + offsetX + 300, slot.y * rotScale + offsetY + 300, 2);
    const type = n1 < -0.15 ? 1 : n1 < 0.2 ? 3 : 2;
    const rotQ = ((Math.floor((n2 + 1) * 2) % 4) + 4) % 4;
    const style = entryStyleForSlot(slot);
    placed.set(slot.id, makeEntry(type, rotQ, style.size, style.color));
  }
  stopIntroReveal();
  renderVectors();
}

function soloFill(type) {
  pushUndoState();
  soloMode = true;
  soloType = type;
  hoverScaleEnabled = false;
  document.getElementById("toggle-hover-scale").classList.remove("is-active");
  setFillMode("random");
  const seed = Math.floor(Math.random() * 100000);
  noiseSeed(seed);
  const rotScale = 0.008 + Math.random() * 0.014;
  const offsetX = Math.random() * 500;
  const offsetY = Math.random() * 500;
  for (const slot of slots) {
    const n = fbm2d(slot.x * rotScale + offsetX, slot.y * rotScale + offsetY, 2);
    const rotQ = ((Math.floor((n + 1) * 2) % 4) + 4) % 4;
    const style = entryStyleForSlot(slot);
    placed.set(slot.id, makeEntry(type, rotQ, style.size, style.color));
  }
  stopIntroReveal();
  renderVectors();
}

const veins = [];

function makeVein(spreadX) {
  const maxJ = Math.ceil((SCENE_HEIGHT / 2) / nodeStep);
  const j = Math.floor(Math.random() * (maxJ * 2 + 1)) - maxJ;
  const y = SCENE_CENTER_Y + j * nodeStep;
  const density = clamp01((veinCount - 10) / 12);
  const speedBase = 0.14 + Math.random() * 0.22;
  const speedVariance = 1 + (Math.random() * 2 - 1) * (0.14 + density * 0.6);
  const speed = Math.max(0.06, speedBase * speedVariance);
  const tailBase = 180 + Math.random() * 380;
  const tailVariance = 1 + (Math.random() * 2 - 1) * (0.12 + density * 0.7);
  const tailLen = Math.max(90, tailBase * tailVariance);
  const thick = nodeStep * (0.35 + Math.random() * (0.55 - density * 0.2));
  // Occasional row-step: after some x distance, jump to adjacent row
  const stepInterval = 200 + Math.random() * (400 + density * 300);
  const stepDir = Math.random() < 0.5 ? -1 : 1;

  return {
    headX: spreadX !== undefined ? spreadX : -(80 + Math.random() * 250),
    baseY: y,
    speed,
    tailLength: tailLen,
    thickness: thick,
    stepInterval,
    stepDir,
    birthX: spreadX !== undefined ? spreadX : -(80 + Math.random() * 250),
  };
}

function veinYAt(vein, x) {
  // Step to adjacent row every stepInterval pixels — gives blocky/techy path
  const travel = x - vein.birthX;
  const steps = Math.floor(Math.max(0, travel) / vein.stepInterval);
  const rowOffset = (steps % 3) * vein.stepDir;
  return vein.baseY + rowOffset * nodeStep;
}

function spawnInitialVeins() {
  veins.length = 0;
  for (let i = 0; i < veinCount; i++) {
    veins.push(makeVein(Math.random() * (SCENE_WIDTH + 400) - 200));
  }
}

function updateVeins(deltaMs) {
  for (let i = 0; i < veins.length; i++) {
    veins[i].headX += veins[i].speed * deltaMs;
    if (veins[i].headX - veins[i].tailLength > SCENE_WIDTH + 200) {
      veins[i] = makeVein();
    }
  }
}

function veinInfluence(item) {
  let maxLevel = 0;
  for (const vein of veins) {
    const dx = vein.headX - item.cx;
    if (dx < -30 || dx > vein.tailLength + 60) continue;

    const vy = veinYAt(vein, item.cx);
    const dy = Math.abs(item.cy - vy);
    if (dy > vein.thickness * 3) continue;

    // Sharp leading edge, longer tail fade
    let hLevel;
    if (dx < 0) {
      hLevel = smoothstep(0, 30, dx + 30) * 0.25;
    } else if (dx < 50) {
      hLevel = 1;
    } else {
      hLevel = 1 - Math.pow((dx - 50) / (vein.tailLength - 50), 0.55);
    }
    hLevel = clamp01(hLevel);

    const vLevel = gaussian(dy, vein.thickness * 0.32);
    maxLevel = Math.max(maxLevel, hLevel * vLevel);
  }
  return clamp01(maxLevel);
}

function toggleVeins() {
  veinsActive = !veinsActive;
  toggleTrailsBtn.classList.toggle("is-active", veinsActive);
  updateVeinCountControl();
  updateMotionControlVisibility();
  if (veinsActive) {
    spawnInitialVeins();
  } else {
    veins.length = 0;
  }
}

function cloudInfluence(item, nowMs) {
  const speed = 0.05 * (cloudSpeedPercent / 100);
  const scrollX = nowMs * speed;
  const s1 = 0.0032;
  const s2 = 0.0065;
  const x1 = (item.cx - scrollX) * s1 + 5000;
  const y1 = item.cy * s1 + 5000;
  const n1 = fbm2d(x1, y1, 3);
  const ridge1 = 1 - Math.abs(n1) * 3.2;
  const x2 = (item.cx - scrollX * 0.65) * s2 + 8000;
  const y2 = item.cy * s2 + 8000;
  const n2 = fbm2d(x2, y2, 2);
  const ridge2 = 1 - Math.abs(n2) * 4.0;
  return clamp01(Math.max(ridge1, ridge2 * 0.6));
}

function toggleClouds() {
  cloudsActive = !cloudsActive;
  document.getElementById("toggle-clouds").classList.toggle("is-active", cloudsActive);
  updateCloudSpeedControl();
  updateMotionControlVisibility();
}

function toggleEraser() {
  eraserActive = !eraserActive;
  if (eraserActive && fillMode === "clear") {
    setFillMode("random");
  }
  toggleEraserBtn.classList.toggle("is-active", eraserActive);
}


function emptyCanvas(skipUndo = false) {
  if (!skipUndo) {
    pushUndoState();
  }
  for (const slot of slots) {
    placed.set(slot.id, makeEntry(0, 0));
  }
  stopIntroReveal();
  renderVectors();
}

function clearAll() {
  stopRandomizer();
  setFillMode("clear");
  emptyCanvas();
}

function canPaintNodes() {
  return fillMode === "clear" || eraserActive;
}

function updateCameraPixels() {
  if (!cameraCtx) return;

  if (droppedMediaType === "image" && droppedImage) {
    if (!cameraPixels) {
      drawSourceToSamplingCanvas(droppedImage);
      adaptLumaRange();
      if (paintDroppedImageToSlots()) {
        queueRender();
      }
    }
    return;
  }

  if (droppedMediaType === "video") {
    if (cameraPreview.readyState < 2) return;
    if (drawSourceToSamplingCanvas(cameraPreview)) {
      adaptLumaRange();
      if (mediaBgVisible) {
        mediaBgEl.setAttribute("href", cameraCanvas.toDataURL("image/jpeg", 0.5));
        mediaBgEl.style.display = "";
      }
    }
    return;
  }

  if (!cameraEnabled || cameraPreview.readyState < 2) return;
  if (drawSourceToSamplingCanvas(cameraPreview)) {
    adaptLumaRange();
  }
}

function pointerToScene(event) {
  const ctm = board.getScreenCTM();
  if (!ctm) return;

  const point = board.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const scenePoint = point.matrixTransform(ctm.inverse());

  pointerState.x = Math.max(0, Math.min(SCENE_WIDTH, scenePoint.x));
  pointerState.y = Math.max(0, Math.min(SCENE_HEIGHT, scenePoint.y));
}

function slotFromPoint(x, y) {
  const i = Math.round((x - SCENE_CENTER_X) / nodeStep);
  const j = Math.round((y - SCENE_CENTER_Y) / nodeStep);
  return slotById.get(`n-${i}-${j}`) ?? null;
}

function slotsWithinBrush(centerSlot) {
  const radius = fillMode === "clear" ? Math.max(0, brushSize - 1) : 0;
  const targets = [];
  for (let di = -radius; di <= radius; di += 1) {
    for (let dj = -radius; dj <= radius; dj += 1) {
      if (di * di + dj * dj > radius * radius) continue;
      const slot = slotById.get(`n-${centerSlot.i + di}-${centerSlot.j + dj}`);
      if (slot) {
        targets.push(slot);
      }
    }
  }
  if (targets.length === 0) {
    targets.push(centerSlot);
  }
  return targets;
}

function paintSingleSlot(slot) {
  if (dragVisited.has(slot.id)) return;
  dragVisited.add(slot.id);

  if (eraserActive) {
    placed.set(slot.id, makeEntry(0, 0));
    queueRender();
    return;
  }

  if (fillMode === "clear" && dragAction === "forward") {
    const current = placed.get(slot.id) ? normalizeEntry(placed.get(slot.id), slot) : null;
    if (!current || current.type === 0) {
      placed.set(slot.id, randomEntry(slot));
    } else {
      const nextType = current.type >= 3 ? 1 : current.type + 1;
      placed.set(slot.id, makeEntry(nextType, current.rotQ, current.size, current.color));
    }
    queueRender();
    return;
  }

  if (dragAction === "forward") {
    const current = normalizeEntry(placed.get(slot.id) ?? entryForNewSlot(slot), slot);
    const nextType = current.type <= 0 ? 1 : (current.type >= 3 ? 1 : current.type + 1);
    placed.set(slot.id, makeEntry(nextType, current.rotQ, current.size, current.color));
    queueRender();
    return;
  }

  cycleSlot(slot, dragAction === "backward" ? -1 : 1, true);
}

function paintSlot(slot) {
  if (!slot || !dragAction || !canPaintNodes()) return;
  const targets = slotsWithinBrush(slot);
  for (const target of targets) {
    paintSingleSlot(target);
  }
}

function paintSegment(x0, y0, x1, y1) {
  if (!dragAction) return;

  const distance = Math.hypot(x1 - x0, y1 - y0);
  const step = Math.max(6, nodeStep * 0.45);
  const samples = Math.max(1, Math.ceil(distance / step));

  for (let index = 0; index <= samples; index += 1) {
    const t = index / samples;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    paintSlot(slotFromPoint(x, y));
  }
}

function beginDrag(direction, slot) {
  if (!canPaintNodes()) return;
  dragAction = direction;
  dragVisited.clear();
  pushUndoState();
  paintSlot(slot);
}

function endDrag() {
  dragAction = null;
  dragVisited.clear();
}

function levelHover(item, nowMs) {
  let level = 0;
  if (hoverScaleEnabled && pointerState.inside && !cursorInfluenceOff) {
    const distance = Math.hypot(item.cx - pointerState.x, item.cy - pointerState.y);
    level = 1 - smoothstep(0, HOVER_RADIUS, distance);
  }
  if (!cursorInfluenceOff) {
    const clickLevel = clickRippleLevel(item, nowMs);
    level = Math.max(level, clickLevel);
  }
  return clamp01(level);
}

const RIPPLE_SPEED = 0.22;
const RIPPLE_WAVELENGTH = 160;
const RIPPLE_TOGGLE_COOLDOWN_MS = 400;
const RIPPLE_TOGGLE_LIMIT = 12;
const RIPPLE_DISPLACE_PX = 18;

function rippleWave(distance, nowMs) {
  const phase = distance / RIPPLE_WAVELENGTH - nowMs * RIPPLE_SPEED * 0.01;
  const wave = Math.sin(phase * Math.PI * 2);
  const decay = Math.exp(-distance * 0.0004);
  const envelope = smoothstep(0, RIPPLE_WAVELENGTH * 0.3, distance);
  return wave * decay * envelope;
}

function levelRipple(item, nowMs) {
  const dx = item.cx - SCENE_CENTER_X;
  const dy = item.cy - SCENE_CENTER_Y;
  const distance = Math.hypot(dx, dy);
  const raw = rippleWave(distance, nowMs);
  return clamp01(raw * 0.5 + 0.5);
}

function rippleDisplacement(item, nowMs) {
  const dx = item.cx - SCENE_CENTER_X;
  const dy = item.cy - SCENE_CENTER_Y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const nx = dx / distance;
  const ny = dy / distance;
  const wave = rippleWave(distance, nowMs);
  const push = wave * RIPPLE_DISPLACE_PX;
  return { x: nx * push, y: ny * push };
}

function chevronStrokeLevel(item, x1, y1, x2, y2, thickness, blur) {
  const distance = pointToSegmentDistance(item.cx, item.cy, x1, y1, x2, y2);
  return 1 - smoothstep(thickness, thickness + blur, distance);
}

function chevronLevel(item, tipX, spanX, thickness, blur) {
  const halfY = SCENE_HEIGHT / 2;
  const leftX = tipX - spanX;

  const upper = chevronStrokeLevel(item, leftX, 0, tipX, halfY, thickness, blur);
  const lower = chevronStrokeLevel(item, leftX, SCENE_HEIGHT, tipX, halfY, thickness, blur);
  return clamp01(Math.max(upper, lower));
}

function levelArrow(item, nowMs) {
  const speed = 0.68;
  const travelPad = 760;
  const travel = SCENE_WIDTH + travelPad * 2;
  const spacing = 620;
  const count = 3;

  const spanX = Math.max(220, SCENE_HEIGHT * 0.5);
  const thickness = Math.max(14, nodeStep * 0.42);
  const blur = Math.max(20, nodeStep * 0.62);

  let level = 0;

  for (let i = 0; i < count; i += 1) {
    const tipX = ((nowMs * speed + i * spacing) % travel) - travelPad;
    const chevron = chevronLevel(item, tipX, spanX, thickness, blur);
    level = Math.max(level, chevron);
  }

  return clamp01(level);
}

function levelCamera(item, nowMs) {
  if (!cameraPixels) return 0.25 * levelHover(item, nowMs);
  const sample = sampleMediaPixelAtScene(item.cx, item.cy);
  if (!sample) return 0.25 * levelHover(item, nowMs);
  const luma = sample.luma;
  const span = Math.max(0.08, cameraLumaMax - cameraLumaMin);
  const normalized = clamp01((luma - cameraLumaMin) / span);
  const enhanced = Math.pow(normalized, 0.6);
  const pulse = 0.5 + 0.5 * Math.sin(nowMs * 0.003 + item.phase);
  const signal = clamp01(smoothstep(0.03, 0.94, enhanced) * (0.96 + pulse * 0.04));
  if (droppedMediaType === "image") {
    return clamp01(0.3 + signal * 0.7);
  }
  return signal;
}

function driverLevel(item, nowMs) {
  if (!motionEnabled) return 0;
  if (driverMode === "hover") return levelHover(item, nowMs);
  if (driverMode === "ripple") return levelRipple(item, nowMs);
  if (driverMode === "arrow") return levelArrow(item, nowMs);
  if (driverMode === "camera") return levelCamera(item, nowMs);
  return 0;
}

function introRevealLevel(item, nowMs) {
  if (!introRevealActive) return 1;

  if (introRevealStartMs === null) {
    introRevealStartMs = nowMs;
  }

  const elapsed = nowMs - introRevealStartMs;
  const progress = clamp01(elapsed / INTRO_REVEAL_DURATION);
  const soft = Math.max(22, nodeStep * 0.65);
  const distance = Math.hypot(item.cx - SCENE_CENTER_X, item.cy - SCENE_CENTER_Y);
  const front = -soft + progress * (rippleRadiusMax + soft * 2 + nodeStep * 2.2);
  const reveal = 1 - smoothstep(front - soft, front + soft, distance);

  if (progress >= 1) {
    introRevealActive = false;
    updateMotionControlVisibility();
    return 1;
  }

  return clamp01(reveal);
}

function animate(nowMs) {
  const deltaMs = lastFrameMs === null ? 16 : Math.max(1, Math.min(64, nowMs - lastFrameMs));
  lastFrameMs = nowMs;
  const isRipple = driverMode === "ripple";
  const levelFollow = 1 - Math.exp(-deltaMs / (isRipple ? 100 : 60));
  const scaleFollow = 1 - Math.exp(-deltaMs / (isRipple ? 90 : 55));

  if (driverMode === "camera") updateCameraPixels();
  if (veinsActive) updateVeins(deltaMs);
  if (driverMode === "ripple") {
    applyRippleToggles(nowMs);
  }

  // Clean up expired click ripples & swap vector types at wavefront
  let rippleSwapped = false;
  for (let i = clickRipples.length - 1; i >= 0; i--) {
    const rip = clickRipples[i];
    const age = nowMs - rip.startMs;
    if (age > CLICK_RIPPLE_DURATION_MS) {
      clickRipples.splice(i, 1);
      continue;
    }
    if (rip.swapType && driverMode === "hover") {
      const frontRadius = age * CLICK_RIPPLE_SPEED;
      const bandInner = Math.max(0, frontRadius - CLICK_RIPPLE_WAVELENGTH * 0.6);
      for (const slot of slots) {
        if (rip.swapped.has(slot.id)) continue;
        const dist = Math.hypot(slot.x - rip.x, slot.y - rip.y);
        if (dist < frontRadius && dist > bandInner) {
          const entry = placed.get(slot.id);
          if (entry && entry.type !== rip.swapType) {
            placed.set(slot.id, makeEntry(rip.swapType, entry.rotQ, entry.size, entry.color));
            rippleSwapped = true;
          }
          rip.swapped.add(slot.id);
        }
      }
    }
  }
  if (rippleSwapped) renderVectors();

  const isCameraActive = driverMode === "camera" && !introRevealActive;
  const opacityFollow = 1 - Math.exp(-deltaMs / 140);

  // Timeline tick
  if (typeof tlTick === "function") tlTick(nowMs);

  for (const item of renderedVectors) {
    const level = clamp01(driverLevel(item, nowMs));
    item.motion += (level - item.motion) * levelFollow;
    const reveal = introRevealLevel(item, nowMs);
    const revealEased = reveal * reveal * (3 - 2 * reveal);

    let targetScale, targetOpacity;
    if (isCameraActive) {
      targetScale = Math.max(0.001, revealEased * (0.18 + item.motion * 2.0));
      targetOpacity = droppedMediaType === "image" ? 1 : clamp01(0.12 + item.motion * 1.18);
    } else {
      const hoverBoost = driverMode === "hover" ? 1.2 : driverMode === "ripple" ? 3.5 : 0.95;
      targetScale = Math.max(0.001, revealEased * (1 + item.motion * hoverBoost));
      targetOpacity = 1;
    }

    if (veinsActive) {
      const vein = veinInfluence(item);
      targetScale *= (1 + vein * 2.8);
    }

    if (cloudsActive) {
      const cloud = cloudInfluence(item, nowMs);
      targetScale *= (1 + cloud * 2.2);
    }

    item.scale += (targetScale - item.scale) * scaleFollow;
    item.opacity += (targetOpacity - item.opacity) * opacityFollow;

    let targetDx = 0, targetDy = 0;
    if (driverMode === "ripple") {
      const disp = rippleDisplacement(item, nowMs);
      targetDx += disp.x;
      targetDy += disp.y;
    }
    if (driverMode === "hover" && clickRipples.length > 0) {
      const disp = clickRippleDisplacement(item, nowMs);
      targetDx += disp.x;
      targetDy += disp.y;
    }
    item.dx += (targetDx - item.dx) * scaleFollow;
    item.dy += (targetDy - item.dy) * scaleFollow;

    // Dashes rotate toward pointer or auto-animate
    let targetRot = item.entry.rotQ * 90;
    if (item.entry.type === 3) {
      if (autoRotateActive && motionEnabled) {
        // Organic wavy rotation — multi-octave noise with phase offset
        const t1 = nowMs * 0.0006;
        const t2 = nowMs * 0.0003;
        const n1 = fbm2d(item.cx * 0.003 + t1, item.cy * 0.003 - t1 * 0.7, 3);
        const n2 = noise2d(item.cx * 0.008 - t2, item.cy * 0.008 + t2 * 1.3);
        const wave = Math.sin(item.cx * 0.005 + item.cy * 0.003 + nowMs * 0.001) * 0.3;
        targetRot = (n1 * 280 + n2 * 80 + wave * 60);
      } else if (driverMode === "hover") {
        if (pointerState.inside && !cursorInfluenceOff) {
          const angle = Math.atan2(pointerState.y - item.cy, pointerState.x - item.cx) * (180 / Math.PI);
          const n = noise2d(
            item.cx * 0.005 + pointerState.x * 0.0003,
            item.cy * 0.005 + pointerState.y * 0.0003
          );
          targetRot = angle + n * 55;
        } else if (motionEnabled) {
          const n = noise2d(
            item.cx * 0.004 + nowMs * 0.00008,
            item.cy * 0.004 - nowMs * 0.00006
          );
          targetRot = n * 180;
        }
      }
    }
    // Shortest-path rotation lerp
    let rotDiff = ((targetRot - item.rot) % 360 + 540) % 360 - 180;
    item.rot += rotDiff * scaleFollow;

    applyTransform(item, item.scale);
  }

  requestAnimationFrame(animate);
}

function buildHitLayer() {
  hitLayer.replaceChildren();
  const fragment = document.createDocumentFragment();
  const hitSize = Math.max(10, Math.min(nodeStep * 0.72, cellSize * 2.6));

  for (const slot of slots) {
    const hitRect = svg("rect", {
      x: (slot.x - hitSize / 2).toFixed(2),
      y: (slot.y - hitSize / 2).toFixed(2),
      width: hitSize.toFixed(2),
      height: hitSize.toFixed(2),
    });

    hitRect.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.button !== 2) return;
      event.preventDefault();
      event.stopPropagation();
      pointerState.inside = true;
      pointerToScene(event);
      if (driverMode === "hover" && event.button === 0) {
        addClickRipple(pointerState.x, pointerState.y);
      }

      if (canPaintNodes()) {
        const direction = event.button === 2 || event.shiftKey ? "backward" : "forward";
        beginDrag(direction, slot);
      }
    });

    hitRect.addEventListener("pointerenter", (event) => {
      if (!dragAction) return;
      if (event.pointerType === "mouse" && event.buttons === 0) {
        endDrag();
        return;
      }
      paintSlot(slot);
    });

    hitRect.addEventListener("pointerup", () => {
      endDrag();
    });

    hitRect.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (canPaintNodes()) {
        cycleSlot(slot, -1);
      }
    });

    fragment.appendChild(hitRect);
  }

  hitLayer.appendChild(fragment);
}

function hasFileDragPayload(event) {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  for (const type of types) {
    if (type === "Files") return true;
  }
  return false;
}

function wireDropImport() {
  window.addEventListener("dragenter", (event) => {
    if (!hasFileDragPayload(event)) return;
    event.preventDefault();
    dropDepth += 1;
    document.body.classList.add("drop-active");
  });

  window.addEventListener("dragover", (event) => {
    if (!hasFileDragPayload(event)) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
    document.body.classList.add("drop-active");
  });

  window.addEventListener("dragleave", (event) => {
    if (!hasFileDragPayload(event)) return;
    event.preventDefault();
    dropDepth = Math.max(0, dropDepth - 1);
    if (dropDepth === 0) {
      document.body.classList.remove("drop-active");
    }
  });

  window.addEventListener("drop", async (event) => {
    if (!hasFileDragPayload(event)) return;
    event.preventDefault();
    dropDepth = 0;
    document.body.classList.remove("drop-active");

    const file = pickDroppedFile(event.dataTransfer?.files);
    if (!file) {
      motionStatusEl.textContent = "Unsupported file | drop image/* or video/mp4";
      return;
    }

    try {
      await loadDroppedMedia(file);
    } catch (error) {
      console.error("Dropped media load failed:", error);
      motionStatusEl.textContent = "Failed to load media file";
    }
  });
}

function wireControls() {
  for (const btn of driverButtons) {
    btn.addEventListener("click", async () => {
      await setDriverMode(btn.dataset.driver);
      updateDriverButtons();
    });
  }

  randomFillBtn.addEventListener("click", randomFill);
  document.getElementById("solo-1").addEventListener("click", () => soloFill(1));
  document.getElementById("solo-2").addEventListener("click", () => soloFill(2));
  document.getElementById("solo-3").addEventListener("click", () => soloFill(3));
  document.getElementById("rainbow-fill").addEventListener("click", rainbowFill);
  document.getElementById("random-loop").addEventListener("click", generateRandomLoop);
  document.getElementById("stop-loop").addEventListener("click", stopRandomLoop);
  clearBtn.addEventListener("click", clearAll);

  toggleMediaBgBtn.addEventListener("click", () => {
    mediaBgVisible = !mediaBgVisible;
    toggleMediaBgBtn.classList.toggle("is-active", mediaBgVisible);
    if (mediaBgVisible && droppedMediaType) {
      mediaBgEl.style.display = "";
    } else {
      mediaBgEl.style.display = "none";
    }
  });

  toggleTrailsBtn.addEventListener("click", toggleVeins);
  document.getElementById("toggle-clouds").addEventListener("click", toggleClouds);
  toggleEraserBtn.addEventListener("click", toggleEraser);

  if (toggleGridBtn) {
    toggleGridBtn.addEventListener("click", () => {
      setGridVisibility(!isGridVisible);
    });
  }

  nodeSizeSlider.addEventListener("input", () => {
    setNodeScale(Number(nodeSizeSlider.value));
  });

  gridSizeSlider.addEventListener("input", () => {
    setGridScale(Number(gridSizeSlider.value));
  });

  veinCountSlider.addEventListener("input", () => {
    setVeinCount(Number(veinCountSlider.value));
  });

  cloudSpeedSlider.addEventListener("input", () => {
    setCloudSpeed(Number(cloudSpeedSlider.value));
  });

  brushSizeSlider.addEventListener("input", () => {
    setBrushSize(Number(brushSizeSlider.value));
  });

  toggleMotionBtn.addEventListener("click", () => {
    setMotion(!motionEnabled);
  });

  const hoverScaleBtn = document.getElementById("toggle-hover-scale");
  hoverScaleBtn.addEventListener("click", () => {
    hoverScaleEnabled = !hoverScaleEnabled;
    hoverScaleBtn.classList.toggle("is-active", hoverScaleEnabled);
  });

  const morphBtn = document.getElementById("toggle-morph");
  morphBtn.addEventListener("click", () => {
    morphEnabled = !morphEnabled;
    morphBtn.classList.toggle("is-active", morphEnabled);
  });

  const autoRotateBtn = document.getElementById("toggle-auto-rotate");
  autoRotateBtn.addEventListener("click", () => {
    autoRotateActive = !autoRotateActive;
    autoRotateBtn.classList.toggle("is-active", autoRotateActive);
  });

  const cursorOffBtn = document.getElementById("toggle-cursor-off");
  cursorOffBtn.addEventListener("click", () => {
    cursorInfluenceOff = !cursorInfluenceOff;
    cursorOffBtn.classList.toggle("is-active", cursorInfluenceOff);
  });

  const swapColorsBtn = document.getElementById("swap-colors");
  swapColorsBtn.addEventListener("click", () => {
    const currentBg = bgColorPicker.value;
    const currentNode = nodeColorPicker.value;
    bgColorPicker.value = currentNode;
    bgColorHex.value = currentNode.toUpperCase();
    nodeColorPicker.value = currentBg;
    nodeColorHex.value = currentBg.toUpperCase();
    applyBgColor(currentNode);
    applyNodeColor(currentBg);
  });

  toggleUiBtn.addEventListener("click", () => {
    setUiVisible(!uiVisible);
  });



  function normalizeHexInput(raw) {
    let v = raw.trim().replace(/^#?/, "#");
    if (/^#[0-9a-f]{3}$/i.test(v)) {
      v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
    }
    return isValidHexColor(v) ? v.toLowerCase() : null;
  }

  bgColorPicker.addEventListener("input", () => {
    const c = bgColorPicker.value;
    bgColorHex.value = c.toUpperCase();
    bgColorHex.classList.remove("is-invalid");
    clearSwatchActive();
    applyBgColor(c);
  });

  bgColorHex.addEventListener("input", () => {
    const hex = normalizeHexInput(bgColorHex.value);
    if (hex) {
      bgColorHex.classList.remove("is-invalid");
      bgColorPicker.value = hex;
      clearSwatchActive();
      applyBgColor(hex);
    } else {
      bgColorHex.classList.add("is-invalid");
    }
  });

  bgColorHex.addEventListener("keydown", (e) => { e.stopPropagation(); });

  function clearSwatchActive() {
    for (const s of document.querySelectorAll("#brand-palette .combo-swatch")) s.classList.remove("is-active");
  }

  nodeColorPicker.addEventListener("input", () => {
    const c = nodeColorPicker.value;
    nodeColorHex.value = c.toUpperCase();
    nodeColorHex.classList.remove("is-invalid");
    clearSwatchActive();
    applyNodeColor(c);
  });

  nodeColorHex.addEventListener("input", () => {
    const hex = normalizeHexInput(nodeColorHex.value);
    if (hex) {
      nodeColorHex.classList.remove("is-invalid");
      nodeColorPicker.value = hex;
      clearSwatchActive();
      applyNodeColor(hex);
    } else {
      nodeColorHex.classList.add("is-invalid");
    }
  });

  nodeColorHex.addEventListener("keydown", (e) => { e.stopPropagation(); });

  // Brand combo swatches
  const comboSwatches = document.querySelectorAll("#brand-palette .combo-swatch");
  for (const sw of comboSwatches) {
    sw.addEventListener("click", () => {
      const bg = sw.dataset.bg;
      const node = sw.dataset.node;
      if (!bg || !node) return;
      bgColorPicker.value = bg;
      bgColorHex.value = bg.toUpperCase();
      bgColorHex.classList.remove("is-invalid");
      applyBgColor(bg);
      nodeColorPicker.value = node;
      nodeColorHex.value = node.toUpperCase();
      nodeColorHex.classList.remove("is-invalid");
      applyNodeColor(node);
      for (const s of comboSwatches) s.classList.remove("is-active");
      sw.classList.add("is-active");
    });
  }

  board.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.button !== 2) return;
    if (dragAction) return;
    pointerState.inside = true;
    pointerToScene(event);
    if (driverMode === "hover" && event.button === 0) {
      addClickRipple(pointerState.x, pointerState.y);
    }
    const slot = slotFromPoint(pointerState.x, pointerState.y);
    if (!slot) return;
    if (canPaintNodes()) {
      event.preventDefault();
      const direction = event.button === 2 || event.shiftKey ? "backward" : "forward";
      beginDrag(direction, slot);
    }
  });

  board.addEventListener("pointerenter", (event) => {
    pointerState.inside = true;
    pointerToScene(event);
  });

  board.addEventListener("pointermove", (event) => {
    const previousX = pointerState.x;
    const previousY = pointerState.y;
    pointerState.inside = true;
    pointerToScene(event);
    if (dragAction) {
      paintSegment(previousX, previousY, pointerState.x, pointerState.y);
    }
  });

  board.addEventListener("pointerleave", () => {
    pointerState.inside = false;
  });

  board.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });

  window.addEventListener("pointerup", () => {
    endDrag();
  });

  window.addEventListener("blur", () => {
    endDrag();
    pointerState.inside = false;
  });

  window.addEventListener("keydown", async (event) => {
    const key = event.key.toLowerCase();
    if (key === "backspace") {
      event.preventDefault();
      // If a keyframe is selected or timeline has undo history, undo keyframe action
      if (timeline.selectedKf) {
        tlRemoveKeyframe(timeline.selectedKf.param, timeline.selectedKf.index);
        timeline.selectedKf = null;
        tlRenderAllTracks();
        return;
      }
      if (timeline.undoStack.length > 0) {
        tlPopUndo();
        return;
      }
      stepBack();
      return;
    }
    if (key === "delete" && timeline.selectedKf) {
      event.preventDefault();
      tlRemoveKeyframe(timeline.selectedKf.param, timeline.selectedKf.index);
      timeline.selectedKf = null;
      tlRenderAllTracks();
      return;
    }
    if (key === "r") randomFill();
    if (key === "c") clearAll();
    if (key === "g") setGridVisibility(!isGridVisible);
    if (key === "m") setMotion(!motionEnabled);
    if (key === "/") setUiVisible(!uiVisible);
    if (key === "t") toggleVeins();
    if (key === "q") toggleClouds();
    if (key === "e") toggleEraser();
    if (key === "h") await setDriverMode("hover");
    if (key === "k") tlAddKeyframeAtCurrent();
    if (key === " ") {
      event.preventDefault();
      tlTogglePlay();
    }
  });
}

/* ===================== Keyframe Timeline ===================== */

const tlPanel = document.getElementById("timeline-panel");
const tlToggle = document.getElementById("timeline-toggle");
const tlBody = document.getElementById("timeline-body");
const tlPlayBtn = document.getElementById("tl-play");
const tlAddKfBtn = document.getElementById("tl-add-kf");
const tlTimeLabel = document.getElementById("tl-time");
const tlDurationInput = document.getElementById("tl-duration");
const tlLoopCheckbox = document.getElementById("tl-loop");
const tlScrub = document.getElementById("tl-scrub");
const tlPlayhead = document.getElementById("tl-playhead");
const tlRuler = document.getElementById("tl-ruler");
const contentLayer = document.getElementById("content-layer");

const timeline = {
  duration: 10,
  currentTime: 0,
  playing: false,
  loop: true,
  lastTickMs: null,
  tracks: {
    nodeScale: [],
    gridScale: [],
  },
  selectedKf: null,
  // Smooth playback state — avoids expensive DOM rebuilds per frame
  smoothNodeScale: null,   // current smoothed value
  smoothGridScale: null,
  baseNodeScale: null,     // value at last full rebuild
  baseGridScale: null,
  undoStack: [],           // [{tracks snapshot}]
};

const TL_MAX_UNDO = 50;

// Easy ease (cubic bezier approximation — slow start, slow end, fast middle)
function easyEase(t) {
  // Classic After Effects easy ease: sine-based
  return t * t * t * (t * (t * 6 - 15) + 10); // quintic smoothstep
}

function tlInitDefaults() {
  timeline.tracks.nodeScale = [{ time: 0, value: nodeScalePercent }];
  timeline.tracks.gridScale = [{ time: 0, value: gridScalePercent }];
  timeline.baseNodeScale = nodeScalePercent;
  timeline.baseGridScale = gridScalePercent;
  timeline.smoothNodeScale = nodeScalePercent;
  timeline.smoothGridScale = gridScalePercent;
  tlBaseNodeScale = nodeScalePercent;
}

function tlPushUndo() {
  const snapshot = {
    nodeScale: timeline.tracks.nodeScale.map(kf => ({ ...kf })),
    gridScale: timeline.tracks.gridScale.map(kf => ({ ...kf })),
  };
  timeline.undoStack.push(snapshot);
  if (timeline.undoStack.length > TL_MAX_UNDO) timeline.undoStack.shift();
}

function tlPopUndo() {
  if (timeline.undoStack.length === 0) return false;
  const snapshot = timeline.undoStack.pop();
  timeline.tracks.nodeScale = snapshot.nodeScale;
  timeline.tracks.gridScale = snapshot.gridScale;
  timeline.selectedKf = null;
  tlRenderAllTracks();
  return true;
}

function tlInsertKeyframe(param, time, value) {
  const track = timeline.tracks[param];
  if (!track) return;
  tlPushUndo();
  const existing = track.findIndex(kf => Math.abs(kf.time - time) < 0.02);
  if (existing >= 0) {
    track[existing].value = value;
  } else {
    track.push({ time, value });
  }
  track.sort((a, b) => a.time - b.time);
  tlRenderTrack(param);
}

function tlRemoveKeyframe(param, index) {
  const track = timeline.tracks[param];
  if (!track || index < 0 || index >= track.length) return;
  tlPushUndo();
  track.splice(index, 1);
  tlRenderTrack(param);
}

function tlLerpTrack(param, t) {
  const track = timeline.tracks[param];
  if (!track || track.length === 0) return null;
  if (track.length === 1) return track[0].value;
  if (t <= track[0].time) return track[0].value;
  if (t >= track[track.length - 1].time) return track[track.length - 1].value;
  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i];
    const b = track[i + 1];
    if (t >= a.time && t <= b.time) {
      const frac = (t - a.time) / (b.time - a.time);
      const s = easyEase(frac);
      return a.value + (b.value - a.value) * s;
    }
  }
  return track[track.length - 1].value;
}

// Apply timeline values by rebuilding geometry (same approach as sliders)
// so nodes always fill the viewport instead of CSS-scaling the whole canvas.
function tlApplySmooth(t) {
  let nodeChanged = false;
  let gridChanged = false;

  const nodeVal = tlLerpTrack("nodeScale", t);
  if (nodeVal !== null) {
    timeline.smoothNodeScale = nodeVal;
    nodeScalePercent = nodeVal;
    nodeSizeSlider.value = String(Math.round(nodeVal));
    nodeSizeLabel.textContent = `Node ${nodeVal.toFixed(0)}%`;
    nodeChanged = true;
  }
  const gridVal = tlLerpTrack("gridScale", t);
  if (gridVal !== null) {
    timeline.smoothGridScale = gridVal;
    gridScalePercent = gridVal;
    gridSizeSlider.value = String(gridVal.toFixed(1));
    gridSizeLabel.textContent = `Grid ${gridVal.toFixed(1)}%`;
    gridChanged = true;
  }
  // Rebuild geometry so grid slots always cover the viewport
  if (gridChanged) {
    rebuildGridGeometry(); // includes renderVectors()
  } else if (nodeChanged) {
    renderVectors();
  }
}

// Commit: clear any stale CSS transforms (geometry is already up to date)
function tlCommitValues() {
  contentLayer.style.transform = "";
  contentLayer.style.transformOrigin = "";
}

function tlSetTime(t) {
  timeline.currentTime = Math.max(0, Math.min(timeline.duration, t));
  tlUpdatePlayhead();
  tlTimeLabel.textContent = timeline.currentTime.toFixed(2) + "s";
}

function tlUpdatePlayhead() {
  const pct = (timeline.currentTime / timeline.duration) * 100;
  tlPlayhead.style.left = pct + "%";
}

function tlPlay() {
  if (timeline.tracks.nodeScale.length < 2 && timeline.tracks.gridScale.length < 2) return;
  timeline.playing = true;
  tlPlaying = true;
  timeline.lastTickMs = null;
  tlPlayBtn.textContent = "Stop";
  tlPlayBtn.classList.add("is-active");
}

function tlStop() {
  timeline.playing = false;
  tlPlaying = false;
  timeline.lastTickMs = null;
  tlPlayBtn.textContent = "Play";
  tlPlayBtn.classList.remove("is-active");
  tlCommitValues();
  // Hide stop button and deactivate loop button
  const stopBtn = document.getElementById("stop-loop");
  if (stopBtn) stopBtn.style.display = "none";
  const loopBtn = document.getElementById("random-loop");
  if (loopBtn) loopBtn.classList.remove("is-active");
}

function tlTogglePlay() {
  if (timeline.playing) {
    tlStop();
  } else {
    tlPlay();
  }
}

function tlTick(nowMs) {
  if (!timeline.playing) return;
  if (timeline.lastTickMs === null) {
    timeline.lastTickMs = nowMs;
    return;
  }
  const delta = (nowMs - timeline.lastTickMs) / 1000;
  timeline.lastTickMs = nowMs;
  let next = timeline.currentTime + delta;
  if (next >= timeline.duration) {
    if (timeline.loop) {
      next = next % timeline.duration;
    } else {
      next = timeline.duration;
      tlStop();
      return;
    }
  }
  tlSetTime(next);
  tlApplySmooth(next);
}

function tlRenderTrack(param) {
  const bar = document.querySelector(`.track-bar[data-param="${param}"] .track-bar-inner`);
  if (!bar) return;
  bar.innerHTML = "";
  const track = timeline.tracks[param];
  for (let i = 0; i < track.length; i++) {
    const kf = track[i];
    const pct = (kf.time / timeline.duration) * 100;
    const diamond = document.createElement("div");
    diamond.className = "kf-diamond";
    diamond.style.left = pct + "%";
    diamond.title = `${kf.time.toFixed(2)}s \u2192 ${kf.value.toFixed(1)}`;

    if (timeline.selectedKf && timeline.selectedKf.param === param && timeline.selectedKf.index === i) {
      diamond.classList.add("is-selected");
    }

    diamond.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (e.button === 2) {
        e.preventDefault();
        tlRemoveKeyframe(param, i);
        if (timeline.selectedKf?.param === param && timeline.selectedKf?.index === i) {
          timeline.selectedKf = null;
        }
        return;
      }
      timeline.selectedKf = { param, index: i };
      tlRenderAllTracks();

      const barRect = bar.closest(".track-bar").getBoundingClientRect();
      const onMove = (me) => {
        const x = me.clientX - barRect.left;
        const pctNew = Math.max(0, Math.min(1, x / barRect.width));
        const newTime = pctNew * timeline.duration;
        kf.time = Math.round(newTime * 50) / 50;
        track.sort((a, b) => a.time - b.time);
        const newIdx = track.indexOf(kf);
        timeline.selectedKf = { param, index: newIdx };
        tlRenderTrack(param);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });

    diamond.addEventListener("contextmenu", (e) => e.preventDefault());
    bar.appendChild(diamond);
  }
}

function tlRenderAllTracks() {
  tlRenderTrack("nodeScale");
  tlRenderTrack("gridScale");
}

function tlRenderRuler() {
  tlRuler.innerHTML = "";
  const dur = timeline.duration;
  const step = dur <= 5 ? 0.5 : dur <= 20 ? 1 : 2;
  for (let t = 0; t <= dur; t += step) {
    const pct = (t / dur) * 100;
    const isMajor = Math.abs(t - Math.round(t)) < 0.01;
    const tick = document.createElement("div");
    tick.className = "ruler-tick" + (isMajor ? " is-major" : "");
    tick.style.left = pct + "%";
    tlRuler.appendChild(tick);
    if (isMajor) {
      const label = document.createElement("span");
      label.className = "ruler-label";
      label.style.left = pct + "%";
      label.textContent = t + "s";
      tlRuler.appendChild(label);
    }
  }
}

function tlAddKeyframeAtCurrent() {
  const t = timeline.currentTime;
  tlInsertKeyframe("nodeScale", t, nodeScalePercent);
  tlInsertKeyframe("gridScale", t, gridScalePercent);
  tlRenderAllTracks();
}

// Scrub — uses smooth apply (no rebuild)
function tlScrubFromEvent(e) {
  const rect = tlScrub.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const pct = Math.max(0, Math.min(1, x / rect.width));
  const t = pct * timeline.duration;
  tlSetTime(t);
  tlApplySmooth(t);
}

tlScrub.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  tlScrubbing = true;
  tlScrubFromEvent(e);
  const onMove = (me) => tlScrubFromEvent(me);
  const onUp = () => {
    tlScrubbing = false;
    tlCommitValues();
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
});

// Track bar click to add keyframe at position
document.querySelectorAll(".track-bar").forEach((bar) => {
  bar.addEventListener("pointerdown", (e) => {
    if (e.target.classList.contains("kf-diamond")) return;
    const param = bar.dataset.param;
    const rect = bar.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));
    const t = pct * timeline.duration;
    const currentValue = param === "nodeScale" ? nodeScalePercent : gridScalePercent;
    tlInsertKeyframe(param, t, currentValue);
  });
});

tlToggle.addEventListener("click", () => {
  tlPanel.classList.toggle("is-collapsed");
});

tlPlayBtn.addEventListener("click", tlTogglePlay);
tlAddKfBtn.addEventListener("click", tlAddKeyframeAtCurrent);

tlDurationInput.addEventListener("change", () => {
  const v = parseFloat(tlDurationInput.value);
  if (v >= 1 && v <= 120) {
    timeline.duration = v;
    tlRenderRuler();
    tlRenderAllTracks();
    tlUpdatePlayhead();
  }
});

tlDurationInput.addEventListener("keydown", (e) => e.stopPropagation());

tlLoopCheckbox.addEventListener("change", () => {
  timeline.loop = tlLoopCheckbox.checked;
});

/* ===================== End Keyframe Timeline ===================== */

/* ===================== Rainbow Fill ===================== */

function rainbowFill() {
  pushUndoState();
  const seed = Math.floor(Math.random() * 100000);
  noiseSeed(seed);

  // Sort brand colors by luminance so we can map image brightness to them
  const brandWithLuma = BRAND_COLORS.map(c => {
    const rgb = hexToRgb(c);
    return { hex: ensureColorVisibility(c, 0.18), luma: rgb ? colorLuma01(rgb) : 0.5 };
  });
  brandWithLuma.sort((a, b) => a.luma - b.luma);

  const hasImage = droppedMediaType === "image" && cameraPixels;
  const noiseOffset = Math.random() * 500;

  for (const slot of slots) {
    const existing = placed.get(slot.id);
    let color;

    if (hasImage) {
      // Sample the image at this slot, pick brand color by luminance match + jitter
      const pixel = sampleMediaPixelAtScene(slot.x, slot.y);
      const luma = pixel ? pixel.luma : 0.5;
      const jitter = fbm2d(slot.x * 0.01 + noiseOffset, slot.y * 0.01 + noiseOffset, 2) * 0.15;
      const t = clamp01(luma + jitter);
      const idx = clamp(Math.round(t * (brandWithLuma.length - 1)), 0, brandWithLuma.length - 1);
      color = brandWithLuma[idx].hex;
    } else {
      // No image — use noise-based color
      const nc = fbm2d(slot.x * 0.008 + noiseOffset, slot.y * 0.008 + noiseOffset, 3);
      const idx = Math.floor(((nc + 1) / 2) * brandWithLuma.length) % brandWithLuma.length;
      color = brandWithLuma[idx].hex;
    }

    if (existing && existing.type !== 0) {
      existing.color = color;
    } else {
      const nt = fbm2d(slot.x * 0.008 + noiseOffset + 999, slot.y * 0.008 + noiseOffset + 999, 2);
      const type = nt < -0.15 ? 1 : nt < 0.2 ? 3 : 2;
      const rotQ = ((Math.floor((nt + 1) * 2) % 4) + 4) % 4;
      const organic = fbm2d(slot.x * 0.013 + 930, slot.y * 0.013 - 640, 2);
      const size = clamp(1 + organic * 0.12, MIN_NODE_VARIANT_SCALE, MAX_NODE_VARIANT_SCALE);
      placed.set(slot.id, makeEntry(type, rotQ, size, color));
    }
  }
  stopIntroReveal();
  renderVectors();
}

/* ===================== Random Loop ===================== */

function generateRandomLoop() {
  if (timeline.playing) tlStop();
  const dur = 5 + Math.random() * 10;
  timeline.duration = Math.round(dur * 2) / 2;
  document.getElementById("tl-duration").value = String(timeline.duration);
  timeline.loop = true;
  document.getElementById("tl-loop").checked = true;

  const kfCount = 3 + Math.floor(Math.random() * 3);

  // Pick a center value for each param, then vary around it
  const nodeMid = 70 + Math.random() * 80;
  const nodeSwing = 20 + Math.random() * 40;
  const gridMid = 25 + Math.random() * 25;
  const gridSwing = 5 + Math.random() * 15;

  timeline.tracks.nodeScale = [];
  timeline.tracks.gridScale = [];

  for (let i = 0; i < kfCount; i++) {
    const t = (i / (kfCount - 1)) * timeline.duration;
    const nodeVal = nodeMid + (Math.random() * 2 - 1) * nodeSwing;
    const gridVal = gridMid + (Math.random() * 2 - 1) * gridSwing;
    timeline.tracks.nodeScale.push({ time: Math.round(t * 100) / 100, value: Math.round(nodeVal * 10) / 10 });
    timeline.tracks.gridScale.push({ time: Math.round(t * 100) / 100, value: Math.round(gridVal * 10) / 10 });
  }

  // Ensure loop continuity: last keyframe matches first
  timeline.tracks.nodeScale[kfCount - 1].value = timeline.tracks.nodeScale[0].value;
  timeline.tracks.gridScale[kfCount - 1].value = timeline.tracks.gridScale[0].value;

  // Set current scale to first keyframe values
  const startNode = timeline.tracks.nodeScale[0].value;
  const startGrid = timeline.tracks.gridScale[0].value;
  nodeSizeSlider.value = String(Math.round(startNode));
  setNodeScale(startNode);
  gridSizeSlider.value = String(startGrid.toFixed(1));
  setGridScale(startGrid);

  tlSetTime(0);
  tlRenderRuler();
  tlRenderAllTracks();
  tlUpdatePlayhead();
  tlPlay();

  // Show stop button, highlight loop button
  document.getElementById("stop-loop").style.display = "";
  document.getElementById("random-loop").classList.add("is-active");
}

function stopRandomLoop() {
  if (timeline.playing) tlStop();
  document.getElementById("stop-loop").style.display = "none";
  document.getElementById("random-loop").classList.remove("is-active");
}

/* ===================== Random Init on Load ===================== */

function applyCombo(combo) {
  applyBgColor(combo.bg);
  bgColorPicker.value = combo.bg;
  bgColorHex.value = combo.bg.toUpperCase();
  applyNodeColor(combo.node);
  nodeColorPicker.value = combo.node;
  nodeColorHex.value = combo.node.toUpperCase();
}

function randomizeOnLoad() {
  // Random brand combo
  const combo = BRAND_COMBOS[Math.floor(Math.random() * BRAND_COMBOS.length)];
  applyCombo(combo);

  // Random slider values
  const nodeVal = 60 + Math.random() * 120;
  const gridVal = 15 + Math.random() * 55;
  nodeSizeSlider.value = String(Math.round(nodeVal));
  setNodeScale(Math.round(nodeVal));
  gridSizeSlider.value = String(Math.round(gridVal * 10) / 10);
  setGridScale(Math.round(gridVal * 10) / 10);

  // Random preset
  const presets = ["random", "solo1", "solo2", "solo3", "rainbow"];
  const pick = presets[Math.floor(Math.random() * presets.length)];
  if (pick === "solo1") soloFill(1);
  else if (pick === "solo2") soloFill(2);
  else if (pick === "solo3") soloFill(3);
  else if (pick === "rainbow") rainbowFill();
  else randomFill();

  // Highlight matching swatch
  const swatches = document.querySelectorAll("#brand-palette .combo-swatch");
  for (const s of swatches) {
    s.classList.toggle("is-active", s.dataset.bg === combo.bg && s.dataset.node === combo.node);
  }
}

/* ===================== Boot ===================== */

noiseSeed(Date.now());
drawLegacyGridLines();
wireControls();
wireDropImport();
setUiVisible(true);
setGridVisibility(false);
setNodeScale(Number(nodeSizeSlider.value));
setGridScale(Number(gridSizeSlider.value));
setVeinCount(Number(veinCountSlider.value));
updateVeinCountControl();
setCloudSpeed(Number(cloudSpeedSlider.value));
updateCloudSpeedControl();
setBrushSize(Number(brushSizeSlider.value));
updateBrushSizeControl();
toggleMediaBgBtn.classList.toggle("is-active", mediaBgVisible);
setMotion(true);
setDriverMode("hover");
updateDriverButtons();
updateMotionStatus();
setFillMode("random");
randomizeOnLoad();
clearUndoState();

// Init timeline
tlInitDefaults();
tlRenderRuler();
tlRenderAllTracks();
tlUpdatePlayhead();

requestAnimationFrame(animate);
