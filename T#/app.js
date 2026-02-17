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
const sampleBtn = document.getElementById("load-sample");
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

const DRIVER_LABELS = {
  hover: "Hover",
  ripple: "Ripple",
  arrow: "Arrow",
  camera: "Camera",
};

const gridLineData = [];

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
let fillMode = "sample";
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

const FLUID_COLS = 120;
const FLUID_ROWS = 68;
const FLUID_SIZE = FLUID_COLS * FLUID_ROWS;
const FLUID_DIFFUSION = 1.05;
const FLUID_ITERATIONS = 5;
const FLUID_PROJECT_ITERATIONS = 10;
const FLUID_VELOCITY_DISSIPATION = 0.19;
const FLUID_DENSITY_DISSIPATION = 0.44;
const FLUID_STRENGTH = 1.28;
const HOVER_RADIUS_PX = 40;
const DRAG_BOOST_SCALE = 0.03;
const DRAG_BOOST_MAX_PX = 60;
const DRAG_THRESHOLD_PX = 6;
const HOVER_TOGGLE_RADIUS_MULT = 3.1;
const HOVER_TOGGLE_THRESHOLD = 0.09;
const HOVER_TOGGLE_LIMIT = 22;
const HOVER_TOGGLE_COOLDOWN_MS = 70;
const CLICK_WAVE_DURATION_MS = 1400;
const CLICK_WAVE_MAX_RADIUS = 560;
const CLICK_WAVE_THICKNESS_PX = 160;
const CLICK_WAVE_TOGGLE_LIMIT = 70;
const CLICK_WAVE_TOGGLE_COOLDOWN_MS = 140;
const SPLASH_RANGE_PX = 184;
const SPLASH_VELOCITY_SCALE = 3;
const SPLASH_FORCE_SCALE = 2;
const SPLASH_DENSITY = 0.048;
const SPLASH_RANDOMNESS = 0.14;
const SPLASH_THICKNESS_PX = 100;
const SPLASH_TRAVEL_EASE_POWER = 2.5;
const SPLASH_FORCE_DECAY_POWER = 1.2;
const SPLASH_DENSITY_DECAY_POWER = 2;
const SPLASH_DURATION_MS = 460;

const fluidDensity = new Float32Array(FLUID_SIZE);
const fluidDensityPrev = new Float32Array(FLUID_SIZE);
const fluidVelX = new Float32Array(FLUID_SIZE);
const fluidVelY = new Float32Array(FLUID_SIZE);
const fluidVelXPrev = new Float32Array(FLUID_SIZE);
const fluidVelYPrev = new Float32Array(FLUID_SIZE);
const fluidPressure = new Float32Array(FLUID_SIZE);
const fluidDivergence = new Float32Array(FLUID_SIZE);
const fluidDensitySmoothed = new Float32Array(FLUID_SIZE);
const DENSITY_SMOOTHING_MS = 300;
const hoverSplashes = [];
const clickWaves = [];
const slotToggleCooldownById = new Map();

let hoverPointerDown = false;
let hoverPrevX = pointerState.x;
let hoverPrevY = pointerState.y;
let hoverPrevMs = 0;
let hoverWaveStampMs = 0;
let hoverIdleMs = 0;
const HOVER_SETTLE_MS = 400;
const HOVER_SETTLE_FADE_MS = 600;

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

function fluidIndex(x, y) {
  return x + y * FLUID_COLS;
}

function fluidClampX(x) {
  return Math.max(0, Math.min(FLUID_COLS - 1, x));
}

function fluidClampY(y) {
  return Math.max(0, Math.min(FLUID_ROWS - 1, y));
}

function fluidSetBoundary(type, field) {
  for (let x = 1; x < FLUID_COLS - 1; x += 1) {
    field[fluidIndex(x, 0)] = type === 2 ? -field[fluidIndex(x, 1)] : field[fluidIndex(x, 1)];
    field[fluidIndex(x, FLUID_ROWS - 1)] = type === 2 ? -field[fluidIndex(x, FLUID_ROWS - 2)] : field[fluidIndex(x, FLUID_ROWS - 2)];
  }

  for (let y = 1; y < FLUID_ROWS - 1; y += 1) {
    field[fluidIndex(0, y)] = type === 1 ? -field[fluidIndex(1, y)] : field[fluidIndex(1, y)];
    field[fluidIndex(FLUID_COLS - 1, y)] = type === 1 ? -field[fluidIndex(FLUID_COLS - 2, y)] : field[fluidIndex(FLUID_COLS - 2, y)];
  }

  field[fluidIndex(0, 0)] = 0.5 * (field[fluidIndex(1, 0)] + field[fluidIndex(0, 1)]);
  field[fluidIndex(0, FLUID_ROWS - 1)] = 0.5 * (field[fluidIndex(1, FLUID_ROWS - 1)] + field[fluidIndex(0, FLUID_ROWS - 2)]);
  field[fluidIndex(FLUID_COLS - 1, 0)] = 0.5 * (field[fluidIndex(FLUID_COLS - 2, 0)] + field[fluidIndex(FLUID_COLS - 1, 1)]);
  field[fluidIndex(FLUID_COLS - 1, FLUID_ROWS - 1)] = 0.5 * (
    field[fluidIndex(FLUID_COLS - 2, FLUID_ROWS - 1)] + field[fluidIndex(FLUID_COLS - 1, FLUID_ROWS - 2)]
  );
}

function fluidLinearSolve(type, field, prevField, a, c, iterations) {
  for (let k = 0; k < iterations; k += 1) {
    for (let y = 1; y < FLUID_ROWS - 1; y += 1) {
      for (let x = 1; x < FLUID_COLS - 1; x += 1) {
        const idx = fluidIndex(x, y);
        field[idx] = (
          prevField[idx]
          + a * (
            field[fluidIndex(x - 1, y)]
            + field[fluidIndex(x + 1, y)]
            + field[fluidIndex(x, y - 1)]
            + field[fluidIndex(x, y + 1)]
          )
        ) / c;
      }
    }
    fluidSetBoundary(type, field);
  }
}

function fluidDiffuse(type, field, prevField, diff, dt) {
  const a = dt * diff * Math.min(FLUID_COLS, FLUID_ROWS);
  fluidLinearSolve(type, field, prevField, a, 1 + 4 * a, FLUID_ITERATIONS);
}

function fluidAdvect(type, field, prevField, velXField, velYField, dt) {
  const dtX = dt * (FLUID_COLS - 2);
  const dtY = dt * (FLUID_ROWS - 2);

  for (let y = 1; y < FLUID_ROWS - 1; y += 1) {
    for (let x = 1; x < FLUID_COLS - 1; x += 1) {
      const idx = fluidIndex(x, y);
      let backX = x - dtX * velXField[idx];
      let backY = y - dtY * velYField[idx];

      backX = Math.max(0.5, Math.min(FLUID_COLS - 1.5, backX));
      backY = Math.max(0.5, Math.min(FLUID_ROWS - 1.5, backY));

      const x0 = Math.floor(backX);
      const x1 = x0 + 1;
      const y0 = Math.floor(backY);
      const y1 = y0 + 1;

      const sx = backX - x0;
      const sy = backY - y0;

      const v00 = prevField[fluidIndex(x0, y0)];
      const v10 = prevField[fluidIndex(x1, y0)];
      const v01 = prevField[fluidIndex(x0, y1)];
      const v11 = prevField[fluidIndex(x1, y1)];

      field[idx] = (
        (1 - sx) * ((1 - sy) * v00 + sy * v01)
        + sx * ((1 - sy) * v10 + sy * v11)
      );
    }
  }

  fluidSetBoundary(type, field);
}

function fluidProject(velXField, velYField, pressureField, divergenceField) {
  for (let y = 1; y < FLUID_ROWS - 1; y += 1) {
    for (let x = 1; x < FLUID_COLS - 1; x += 1) {
      const idx = fluidIndex(x, y);
      divergenceField[idx] = -0.5 * (
        (velXField[fluidIndex(x + 1, y)] - velXField[fluidIndex(x - 1, y)]) / FLUID_COLS
        + (velYField[fluidIndex(x, y + 1)] - velYField[fluidIndex(x, y - 1)]) / FLUID_ROWS
      );
      pressureField[idx] = 0;
    }
  }

  fluidSetBoundary(0, divergenceField);
  fluidSetBoundary(0, pressureField);
  fluidLinearSolve(0, pressureField, divergenceField, 1, 4, FLUID_PROJECT_ITERATIONS);

  for (let y = 1; y < FLUID_ROWS - 1; y += 1) {
    for (let x = 1; x < FLUID_COLS - 1; x += 1) {
      const idx = fluidIndex(x, y);
      velXField[idx] -= 0.5 * FLUID_COLS * (pressureField[fluidIndex(x + 1, y)] - pressureField[fluidIndex(x - 1, y)]);
      velYField[idx] -= 0.5 * FLUID_ROWS * (pressureField[fluidIndex(x, y + 1)] - pressureField[fluidIndex(x, y - 1)]);
    }
  }

  fluidSetBoundary(1, velXField);
  fluidSetBoundary(2, velYField);
}

function fluidStep(dt) {
  const stepDt = Math.max(0.001, Math.min(0.033, dt));

  fluidVelXPrev.set(fluidVelX);
  fluidVelYPrev.set(fluidVelY);
  fluidDiffuse(1, fluidVelX, fluidVelXPrev, FLUID_DIFFUSION, stepDt);
  fluidDiffuse(2, fluidVelY, fluidVelYPrev, FLUID_DIFFUSION, stepDt);
  fluidProject(fluidVelX, fluidVelY, fluidPressure, fluidDivergence);

  fluidVelXPrev.set(fluidVelX);
  fluidVelYPrev.set(fluidVelY);
  fluidAdvect(1, fluidVelX, fluidVelXPrev, fluidVelXPrev, fluidVelYPrev, stepDt);
  fluidAdvect(2, fluidVelY, fluidVelYPrev, fluidVelXPrev, fluidVelYPrev, stepDt);
  fluidProject(fluidVelX, fluidVelY, fluidPressure, fluidDivergence);

  fluidDensityPrev.set(fluidDensity);
  fluidDiffuse(0, fluidDensity, fluidDensityPrev, FLUID_DIFFUSION, stepDt);
  fluidDensityPrev.set(fluidDensity);
  fluidAdvect(0, fluidDensity, fluidDensityPrev, fluidVelX, fluidVelY, stepDt);

  const velDecay = Math.exp(-FLUID_VELOCITY_DISSIPATION * stepDt * 3.2);
  const densityDecay = Math.exp(-FLUID_DENSITY_DISSIPATION * stepDt * 3.6);
  for (let i = 0; i < FLUID_SIZE; i += 1) {
    fluidVelX[i] *= velDecay;
    fluidVelY[i] *= velDecay;
    fluidDensity[i] *= densityDecay;
  }
}

function injectFluidAtScene(sceneX, sceneY, velSceneX, velSceneY, radiusPx, forceScale, densityAmount) {
  const gx = (sceneX / SCENE_WIDTH) * (FLUID_COLS - 1);
  const gy = (sceneY / SCENE_HEIGHT) * (FLUID_ROWS - 1);
  const radius = Math.max(1, (
    (radiusPx / SCENE_WIDTH) * FLUID_COLS
    + (radiusPx / SCENE_HEIGHT) * FLUID_ROWS
  ) * 0.5);

  const minX = fluidClampX(Math.floor(gx - radius));
  const maxX = fluidClampX(Math.ceil(gx + radius));
  const minY = fluidClampY(Math.floor(gy - radius));
  const maxY = fluidClampY(Math.ceil(gy + radius));

  const velGridX = (velSceneX / SCENE_WIDTH) * FLUID_COLS;
  const velGridY = (velSceneY / SCENE_HEIGHT) * FLUID_ROWS;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - gx;
      const dy = y - gy;
      const dist = Math.hypot(dx, dy);
      if (dist > radius) continue;
      const influence = 1 - smoothstep(0, radius, dist);
      const idx = fluidIndex(x, y);
      fluidVelX[idx] += velGridX * forceScale * influence;
      fluidVelY[idx] += velGridY * forceScale * influence;
      fluidDensity[idx] = Math.min(0.82, fluidDensity[idx] + densityAmount * influence);
    }
  }
}

function addHoverBurst(x, y, nowMs = performance.now()) {
  hoverSplashes.push({ x, y, startMs: nowMs, seed: Math.random() * 1000 });
  if (hoverSplashes.length > 10) {
    hoverSplashes.shift();
  }
}

function applyHoverSplashes(nowMs) {
  for (let index = hoverSplashes.length - 1; index >= 0; index -= 1) {
    const splash = hoverSplashes[index];
    const ageMs = nowMs - splash.startMs;
    if (ageMs >= SPLASH_DURATION_MS) {
      hoverSplashes.splice(index, 1);
      continue;
    }

    const t = clamp01(ageMs / SPLASH_DURATION_MS);
    const travel = 1 - Math.pow(1 - t, SPLASH_TRAVEL_EASE_POWER);
    const radius = SPLASH_RANGE_PX * travel;
    const forceDrop = Math.pow(1 - t, SPLASH_FORCE_DECAY_POWER);
    const densityDrop = Math.pow(1 - t, SPLASH_DENSITY_DECAY_POWER);
    const segments = 24;

    for (let segment = 0; segment < segments; segment += 1) {
      const angle = (segment / segments) * Math.PI * 2;
      const wave = (
        0.5 * Math.sin(6 * angle + splash.seed)
        + 0.25 * Math.sin(3 * angle + 0.05 * radius + 0.3 * splash.seed)
        + 0.5
      );
      const randomFactor = 1 + SPLASH_RANDOMNESS * (wave * 2 - 1);
      const ringRadius = radius + (wave - 0.5) * SPLASH_THICKNESS_PX * 0.35;
      const px = splash.x + Math.cos(angle) * ringRadius;
      const py = splash.y + Math.sin(angle) * ringRadius;
      const velocity = 240 * SPLASH_VELOCITY_SCALE * SPLASH_FORCE_SCALE * forceDrop * randomFactor;
      const vx = Math.cos(angle) * velocity;
      const vy = Math.sin(angle) * velocity;
      const density = SPLASH_DENSITY * densityDrop * randomFactor;
      injectFluidAtScene(px, py, vx, vy, HOVER_RADIUS_PX * 0.95, 1.05, density);
    }
  }
}

function applyHoverPointerFluid(nowMs) {
  if (!pointerState.inside || driverMode !== "hover") return;

  if (hoverPrevMs === 0) {
    hoverPrevMs = nowMs;
    hoverPrevX = pointerState.x;
    hoverPrevY = pointerState.y;
    injectFluidAtScene(pointerState.x, pointerState.y, 0, 0, HOVER_RADIUS_PX * 0.92, 0.12, 0.045);
    return;
  }

  const dtMs = Math.max(1, nowMs - hoverPrevMs);
  const dx = pointerState.x - hoverPrevX;
  const dy = pointerState.y - hoverPrevY;
  const speedPx = Math.hypot(dx, dy);
  const velX = (dx / dtMs) * 1000;
  const velY = (dy / dtMs) * 1000;

  // Track idle time and compute activity fade
  if (speedPx > 1.5 || hoverPointerDown) {
    hoverIdleMs = 0;
  } else {
    hoverIdleMs += dtMs;
  }
  const idleProgress = clamp01((hoverIdleMs - HOVER_SETTLE_MS) / HOVER_SETTLE_FADE_MS);
  const activity = 1 - idleProgress;

  if (activity <= 0) {
    hoverPrevX = pointerState.x;
    hoverPrevY = pointerState.y;
    hoverPrevMs = nowMs;
    return;
  }

  const dragBoost = speedPx > DRAG_THRESHOLD_PX ? Math.min(DRAG_BOOST_MAX_PX, speedPx * DRAG_BOOST_SCALE * 0.7) : 0;
  const radius = HOVER_RADIUS_PX + dragBoost + (hoverPointerDown ? 16 : 6);
  let density = hoverPointerDown ? 0.075 : 0.038;
  let force = hoverPointerDown ? 2.05 : 1.35;
  if (!hoverPointerDown && speedPx < 0.12) {
    density *= 0.65;
    force *= 0.6;
  }
  density *= activity;
  force *= activity;

  const speedDampen = smoothstep(0, 14, speedPx);
  const swirl = (organicHoverMask(pointerState.x, pointerState.y, nowMs) - 0.5) * 2;
  const swirlAmt = lerp(0.03, 1, speedDampen) * activity;
  const swirlVx = Math.cos(nowMs * 0.004 + pointerState.y * 0.011) * 115 * swirl * swirlAmt;
  const swirlVy = Math.sin(nowMs * 0.004 + pointerState.x * 0.011) * 115 * swirl * swirlAmt;

  injectFluidAtScene(pointerState.x, pointerState.y, velX + swirlVx, velY + swirlVy, radius, force, density);
  if (speedPx > DRAG_THRESHOLD_PX * 0.75 && nowMs - hoverWaveStampMs > 120) {
    addHoverBurst(pointerState.x, pointerState.y, nowMs);
    hoverWaveStampMs = nowMs;
  }

  hoverPrevX = pointerState.x;
  hoverPrevY = pointerState.y;
  hoverPrevMs = nowMs;
}

function resetHoverPointerState() {
  hoverPointerDown = false;
  hoverPrevMs = 0;
  hoverWaveStampMs = 0;
  hoverIdleMs = 0;
}

function canAutoToggleFromHover() {
  return driverMode === "hover" && fillMode !== "clear" && !eraserActive;
}

function canAutoToggleFromRipple() {
  return driverMode === "ripple" && fillMode !== "clear" && !eraserActive;
}

function applyRippleToggles(nowMs) {
  if (!canAutoToggleFromRipple()) return;

  const cycle = rippleRadiusMax + nodeStep * 8;
  const base = (nowMs * RIPPLE_SPEED) % cycle;
  const spacing = cycle / RIPPLE_WAVE_COUNT;
  const bandWidth = Math.max(30, nodeStep * 1.4);
  let toggled = 0;

  for (const slot of slots) {
    if (toggled >= RIPPLE_TOGGLE_LIMIT) break;
    if (!canToggleSlotNow(slot.id, nowMs, RIPPLE_TOGGLE_COOLDOWN_MS)) continue;

    const dx = slot.x - SCENE_CENTER_X;
    const dy = slot.y - SCENE_CENTER_Y;
    const distance = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);

    let hit = false;
    for (let w = 0; w < RIPPLE_WAVE_COUNT; w += 1) {
      const ringRadius = (base + w * spacing) % cycle;
      const distorted = rippleDistortedRadius(ringRadius, angle, nowMs, w);
      if (Math.abs(distance - distorted) < bandWidth) {
        hit = true;
        break;
      }
    }

    if (!hit) continue;
    advanceSlotType(slot);
    toggled += 1;
  }

  if (toggled > 0) {
    queueRender();
  }
}

function advanceSlotType(slot) {
  const current = placed.get(slot.id) ?? entryForNewSlot(slot);
  const nextType = current.type <= 0 ? 1 : (current.type >= 3 ? 1 : current.type + 1);
  placed.set(slot.id, { type: nextType, rotQ: current.rotQ });
}

function canToggleSlotNow(slotId, nowMs, cooldownMs) {
  const lastMs = slotToggleCooldownById.get(slotId) ?? -Infinity;
  if (nowMs - lastMs < cooldownMs) return false;
  slotToggleCooldownById.set(slotId, nowMs);
  return true;
}

function applyHoverFluidToggles(nowMs) {
  if (!canAutoToggleFromHover() || !pointerState.inside) return;

  const radius = Math.max(nodeStep * 1.8, HOVER_RADIUS_PX * HOVER_TOGGLE_RADIUS_MULT);
  const maxDist = radius * radius;
  const candidates = [];

  for (const slot of slots) {
    const dx = slot.x - pointerState.x;
    const dy = slot.y - pointerState.y;
    const dist2 = dx * dx + dy * dy;
    if (dist2 > maxDist) continue;

    const dist = Math.sqrt(dist2);
    const local = 1 - smoothstep(0, radius, dist);
    const fluid = sampleFluidDensityAtScene(slot.x, slot.y);
    const signal = fluid * (0.55 + local * 1.2);
    if (signal < HOVER_TOGGLE_THRESHOLD) continue;
    candidates.push({ slot, signal });
  }

  if (candidates.length === 0) return;
  candidates.sort((a, b) => b.signal - a.signal);

  const limit = hoverPointerDown ? Math.round(HOVER_TOGGLE_LIMIT * 1.6) : HOVER_TOGGLE_LIMIT;
  const cooldown = hoverPointerDown ? Math.round(HOVER_TOGGLE_COOLDOWN_MS * 0.72) : HOVER_TOGGLE_COOLDOWN_MS;
  let toggled = 0;

  for (const candidate of candidates) {
    if (!canToggleSlotNow(candidate.slot.id, nowMs, cooldown)) continue;
    advanceSlotType(candidate.slot);
    toggled += 1;
    if (toggled >= limit) break;
  }

  if (toggled > 0) {
    queueRender();
  }
}

function addClickWave(x, y, nowMs = performance.now()) {
  addHoverBurst(x, y, nowMs);
  injectFluidAtScene(x, y, 0, 0, HOVER_RADIUS_PX * 1.5, 0.18, 0.055);

  clickWaves.push({
    x,
    y,
    startMs: nowMs,
    maxRadius: Math.max(CLICK_WAVE_MAX_RADIUS, nodeStep * 8.8),
    thickness: Math.max(CLICK_WAVE_THICKNESS_PX, nodeStep * 1.4),
    allowToggle: canAutoToggleFromHover(),
    toggled: new Set(),
  });
  if (clickWaves.length > 5) {
    clickWaves.shift();
  }
}

function applyClickWaves(nowMs) {
  if (clickWaves.length === 0) return;

  let changed = false;

  for (let waveIndex = clickWaves.length - 1; waveIndex >= 0; waveIndex -= 1) {
    const wave = clickWaves[waveIndex];
    const ageMs = nowMs - wave.startMs;
    if (ageMs >= CLICK_WAVE_DURATION_MS) {
      clickWaves.splice(waveIndex, 1);
      continue;
    }

    const t = clamp01(ageMs / CLICK_WAVE_DURATION_MS);
    const radius = wave.maxRadius * (1 - Math.pow(1 - t, 1.8));
    const thickness = wave.thickness * (0.9 + t * 0.15);

    const ringSegments = 22;
    const impulse = (1 - t * t) * 160;
    for (let segment = 0; segment < ringSegments; segment += 1) {
      const angle = (segment / ringSegments) * Math.PI * 2;
      const px = wave.x + Math.cos(angle) * radius;
      const py = wave.y + Math.sin(angle) * radius;
      const vx = Math.cos(angle) * impulse;
      const vy = Math.sin(angle) * impulse;
      injectFluidAtScene(px, py, vx, vy, HOVER_RADIUS_PX * 1.1, 1.2, 0.014);
    }

    let toggledThisWave = 0;
    if (!wave.allowToggle) {
      continue;
    }
    for (const slot of slots) {
      if (wave.toggled.has(slot.id)) continue;
      if (!canToggleSlotNow(slot.id, nowMs, CLICK_WAVE_TOGGLE_COOLDOWN_MS)) continue;
      const dist = Math.hypot(slot.x - wave.x, slot.y - wave.y);
      const ringBand = 1 - smoothstep(thickness * 0.45, thickness, Math.abs(dist - radius));
      if (ringBand < 0.74) continue;
      advanceSlotType(slot);
      wave.toggled.add(slot.id);
      toggledThisWave += 1;
      changed = true;
      if (toggledThisWave >= CLICK_WAVE_TOGGLE_LIMIT) break;
    }
  }

  if (changed) {
    queueRender();
  }
}

function sampleFluidDensityAtScene(sceneX, sceneY) {
  const gx = (sceneX / SCENE_WIDTH) * (FLUID_COLS - 1);
  const gy = (sceneY / SCENE_HEIGHT) * (FLUID_ROWS - 1);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(FLUID_COLS - 1, x0 + 1);
  const y1 = Math.min(FLUID_ROWS - 1, y0 + 1);
  const tx = gx - x0;
  const ty = gy - y0;

  const d00 = fluidDensitySmoothed[fluidIndex(x0, y0)];
  const d10 = fluidDensitySmoothed[fluidIndex(x1, y0)];
  const d01 = fluidDensitySmoothed[fluidIndex(x0, y1)];
  const d11 = fluidDensitySmoothed[fluidIndex(x1, y1)];

  const d0 = d00 + (d10 - d00) * tx;
  const d1 = d01 + (d11 - d01) * tx;
  return clamp01((d0 + (d1 - d0) * ty) * FLUID_STRENGTH);
}

function organicHoverMask(sceneX, sceneY, nowMs) {
  const t = nowMs * 0.00009;
  const noise = fbm2d(sceneX * 0.0032 + t, sceneY * 0.0032 - t * 0.7, 3);
  return clamp01((noise + 1) * 0.5);
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

  if (driverMode !== "hover") {
    resetHoverPointerState();
  }

  if (driverMode === "hover" && !motionEnabled) {
    setMotion(true);
  }

  updatePreviewState();
  updateMotionStatus();
  updateMotionControlVisibility();
}

function randomEntry() {
  return {
    type: Math.floor(Math.random() * 3) + 1,
    rotQ: Math.floor(Math.random() * 4),
  };
}

function sampleEntry(slot) {
  const type = ((Math.abs(slot.i) + Math.abs(slot.j)) % 3) + 1;
  const rotQ = ((((slot.i * 3 + slot.j * 5) % 4) + 4) % 4);
  return { type, rotQ };
}

function entryForNewSlot(slot) {
  if (fillMode === "clear") return { type: 0, rotQ: 0 };
  return fillMode === "random" ? randomEntry() : sampleEntry(slot);
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
    const entry = placed.get(slot.id) ?? { type: 0, rotQ: 0 };
    snapshot.set(slot.id, { type: entry.type, rotQ: entry.rotQ });
  }
  return snapshot;
}

function restorePlacedState(snapshot) {
  placed.clear();
  for (const slot of slots) {
    const entry = snapshot.get(slot.id) ?? { type: 0, rotQ: 0 };
    placed.set(slot.id, { type: entry.type, rotQ: entry.rotQ });
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

function drawGridLines() {
  gridLayer.replaceChildren();
  gridLineData.length = 0;
  const fragment = document.createDocumentFragment();
  const maxI = Math.ceil((SCENE_WIDTH / 2) / nodeStep) + 2;
  const maxJ = Math.ceil((SCENE_HEIGHT / 2) / nodeStep) + 2;

  for (let i = -maxI; i <= maxI; i++) {
    const x = SCENE_CENTER_X + i * nodeStep;
    if (x < -nodeStep || x > SCENE_WIDTH + nodeStep) continue;
    const el = svg("line", { x1: x, y1: 0, x2: x, y2: SCENE_HEIGHT });
    fragment.appendChild(el);
    gridLineData.push({ el, orientation: "v", pos: x });
  }

  for (let j = -maxJ; j <= maxJ; j++) {
    const y = SCENE_CENTER_Y + j * nodeStep;
    if (y < -nodeStep || y > SCENE_HEIGHT + nodeStep) continue;
    const el = svg("line", { x1: 0, y1: y, x2: SCENE_WIDTH, y2: y });
    fragment.appendChild(el);
    gridLineData.push({ el, orientation: "h", pos: y });
  }

  gridLayer.appendChild(fragment);
}

function updateGridOpacities() {
  if (!isGridVisible || gridLineData.length === 0) return;

  for (const line of gridLineData) {
    let maxFluid = 0;
    const SAMPLES = 5;

    for (let s = 0; s <= SAMPLES; s++) {
      const t = s / SAMPLES;
      const sx = line.orientation === "v" ? line.pos : t * SCENE_WIDTH;
      const sy = line.orientation === "h" ? line.pos : t * SCENE_HEIGHT;
      const d = sampleFluidDensityAtScene(sx, sy);
      if (d > maxFluid) maxFluid = d;
    }

    let pointerReveal = 0;
    if (pointerState.inside) {
      const dist = line.orientation === "v"
        ? Math.abs(pointerState.x - line.pos)
        : Math.abs(pointerState.y - line.pos);
      pointerReveal = 1 - smoothstep(0, nodeStep * 5, dist);
    }

    const reveal = clamp01(Math.max(maxFluid * 1.6, pointerReveal));
    const opacity = 0.025 + reveal * 0.2;
    line.el.style.strokeOpacity = opacity.toFixed(3);
  }
}

function rebuildSlots() {
  slots = [];
  slotById.clear();

  const pad = nodeStep * 3;
  const maxI = Math.ceil((SCENE_WIDTH / 2 + pad) / nodeStep);
  const maxJ = Math.ceil((SCENE_HEIGHT / 2 + pad) / nodeStep);

  for (let i = -maxI; i <= maxI; i += 1) {
    const x = SCENE_CENTER_X + i * nodeStep;
    if (x < -pad || x > SCENE_WIDTH + pad) continue;

    for (let j = -maxJ; j <= maxJ; j += 1) {
      const y = SCENE_CENTER_Y + j * nodeStep;
      if (y < -pad || y > SCENE_HEIGHT + pad) continue;

      const id = `n-${i}-${j}`;
      const slot = { id, i, j, x, y };
      slots.push(slot);
      slotById.set(id, slot);

      if (!placed.has(id)) {
        placed.set(id, entryForNewSlot(slot));
      }
    }
  }

  slots.sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
}

function rebuildGridGeometry() {
  computeGeometry();
  drawGridLines();
  rebuildSlots();
  buildHitLayer();
  renderVectors();
}

function makeVectorGraphic(entry, slot) {
  const baseNode = cellSize - cellMargin * 2;
  const scaled = Math.max(1.2, baseNode * (nodeScalePercent / 100));
  let mark;

  if (entry.type === 1) {
    mark = svg("circle", {
      cx: slot.x.toFixed(2),
      cy: slot.y.toFixed(2),
      r: (scaled / 2).toFixed(2),
      fill: "#fff",
    });
  } else if (entry.type === 2) {
    mark = svg("rect", {
      x: (slot.x - scaled / 2).toFixed(2),
      y: (slot.y - scaled / 2).toFixed(2),
      width: scaled.toFixed(2),
      height: scaled.toFixed(2),
      fill: "#fff",
    });
  } else {
    const width = scaled;
    const height = scaled * 0.18;
    mark = svg("rect", {
      x: (slot.x - width / 2).toFixed(2),
      y: (slot.y - height / 2).toFixed(2),
      width: width.toFixed(2),
      height: height.toFixed(2),
      fill: "#fff",
    });
  }

  mark.classList.add("vector-mark");
  return mark;
}

function applyTransform(item, scale) {
  const rotation = item.entry.rotQ * 90;
  item.el.style.transform = `rotate(${rotation}deg) scale(${scale.toFixed(3)})`;
  item.el.style.opacity = item.opacity.toFixed(3);
}

function renderVectors() {
  const previousState = new Map();
  for (const item of renderedVectors) {
    previousState.set(item.slot.id, { scale: item.scale, motion: item.motion, opacity: item.opacity });
  }

  vectorLayer.replaceChildren();
  renderedVectors.length = 0;

  const fragment = document.createDocumentFragment();

  for (const slot of slots) {
    const entry = placed.get(slot.id);
    if (!entry || entry.type === 0) continue;

    const mark = makeVectorGraphic(entry, slot);
    const phase = ((slot.x * 0.021 + slot.y * 0.017) * Math.PI) / 180;
    const baseScale = introRevealActive ? 0.001 : 1;
    const prev = previousState.get(slot.id);
    const startScale = prev ? prev.scale : baseScale;
    const startMotion = prev ? prev.motion : 0;
    const startOpacity = prev ? prev.opacity : (introRevealActive ? 0 : 1);
    const item = { slot, entry, el: mark, cx: slot.x, cy: slot.y, phase, scale: startScale, motion: startMotion, opacity: startOpacity };
    applyTransform(item, startScale);
    renderedVectors.push(item);
    fragment.appendChild(mark);
  }

  vectorLayer.appendChild(fragment);
}

function cycleSlot(slot, direction, defer = false) {
  const current = placed.get(slot.id) ?? entryForNewSlot(slot);
  const nextType = ((current.type + direction) % 4 + 4) % 4;
  placed.set(slot.id, { type: nextType, rotQ: current.rotQ });
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
  const newEntry = randomEntry();
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
    placed.set(slot.id, { type, rotQ });
  }
  stopIntroReveal();
  renderVectors();

  // Start randomizer on top
  randomizerActive = true;
  randomFillBtn.classList.add("is-active");
  randomizerTimer = setInterval(randomizerTick, 80);
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
    setFillMode("sample");
  }
  toggleEraserBtn.classList.toggle("is-active", eraserActive);
}


function emptyCanvas(skipUndo = false) {
  if (!skipUndo) {
    pushUndoState();
  }
  for (const slot of slots) {
    placed.set(slot.id, { type: 0, rotQ: 0 });
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
    placed.set(slot.id, { type: 0, rotQ: 0 });
    queueRender();
    return;
  }

  if (fillMode === "clear" && dragAction === "forward") {
    const current = placed.get(slot.id);
    if (!current || current.type === 0) {
      placed.set(slot.id, randomEntry());
    } else {
      const nextType = current.type >= 3 ? 1 : current.type + 1;
      placed.set(slot.id, { type: nextType, rotQ: current.rotQ });
    }
    queueRender();
    return;
  }

  if (dragAction === "forward") {
    const current = placed.get(slot.id) ?? entryForNewSlot(slot);
    const nextType = current.type <= 0 ? 1 : (current.type >= 3 ? 1 : current.type + 1);
    placed.set(slot.id, { type: nextType, rotQ: current.rotQ });
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

function clickWaveRingLevel(cx, cy, nowMs) {
  let level = 0;
  for (const wave of clickWaves) {
    const ageMs = nowMs - wave.startMs;
    if (ageMs >= CLICK_WAVE_DURATION_MS) continue;
    const t = clamp01(ageMs / CLICK_WAVE_DURATION_MS);
    const radius = wave.maxRadius * (1 - Math.pow(1 - t, 1.8));
    const thickness = wave.thickness * (0.9 + t * 0.15);
    const dist = Math.hypot(cx - wave.x, cy - wave.y);
    const band = 1 - smoothstep(thickness * 0.3, thickness, Math.abs(dist - radius));
    const fade = Math.pow(1 - t, 0.6);
    level = Math.max(level, band * fade);
  }
  return level;
}

function levelHover(item, nowMs) {
  const fluidRaw = sampleFluidDensityAtScene(item.cx, item.cy);
  const organicMask = organicHoverMask(item.cx, item.cy, nowMs);
  const fluidLevel = smoothstep(0.03, 0.5, fluidRaw) * (0.82 + organicMask * 0.5);
  let pointerFocus = 0;
  if (pointerState.inside) {
    const distance = Math.hypot(item.cx - pointerState.x, item.cy - pointerState.y);
    pointerFocus = 1 - smoothstep(14, Math.max(240, nodeStep * 2.3), distance);
  }
  const ringLevel = clickWaveRingLevel(item.cx, item.cy, nowMs);
  return clamp01(Math.max(pointerFocus * 0.88, fluidLevel * 1.15, ringLevel * 0.95));
}

const RIPPLE_SPEED = 0.38;
const RIPPLE_WAVE_COUNT = 3;
const RIPPLE_TOGGLE_COOLDOWN_MS = 110;
const RIPPLE_TOGGLE_LIMIT = 40;
const RIPPLE_TRAIL_DURATION_MS = 420;

function rippleDistortedRadius(baseRadius, angle, nowMs, waveIndex) {
  const seed = waveIndex * 137.5;
  const n1 = noise2d(angle * 1.8 + seed, nowMs * 0.00025 + waveIndex * 3.7);
  const n2 = noise2d(angle * 3.1 + seed + 50, nowMs * 0.00018 - waveIndex * 2.1);
  const warp = n1 * 0.18 + n2 * 0.08;
  return baseRadius * (1 + warp);
}

function levelRipple(item, nowMs) {
  const cycle = rippleRadiusMax + nodeStep * 8;
  const base = (nowMs * RIPPLE_SPEED) % cycle;
  const spacing = cycle / RIPPLE_WAVE_COUNT;
  const sigma = Math.max(24, nodeStep * 0.65);
  const dx = item.cx - SCENE_CENTER_X;
  const dy = item.cy - SCENE_CENTER_Y;
  const distance = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);

  let level = 0;
  for (let w = 0; w < RIPPLE_WAVE_COUNT; w += 1) {
    const ringRadius = (base + w * spacing) % cycle;
    const distorted = rippleDistortedRadius(ringRadius, angle, nowMs, w);
    const strength = w === 0 ? 1 : (w === 1 ? 0.82 : 0.65);
    const wave = gaussian(distance - distorted, sigma);
    // Trailing wake: asymmetric falloff behind the wavefront
    const behind = distance - distorted;
    const trailSigma = sigma * 2.8;
    const trail = behind > 0 && behind < trailSigma
      ? smoothstep(trailSigma, 0, behind) * 0.35
      : 0;
    level = Math.max(level, (wave + trail) * strength);
  }

  // Noise-driven speckle in the trail zone for randomness
  const trailNoise = fbm2d(
    item.cx * 0.007 + nowMs * 0.00035,
    item.cy * 0.007 - nowMs * 0.00025,
    2
  );
  const speckle = clamp01((trailNoise + 0.3) * 0.6) * level * 0.3;

  return clamp01(level + speckle);
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
  const speed = 0.52;
  const travelPad = 900;
  const travel = SCENE_WIDTH + travelPad * 2;
  const spacing = 480;
  const count = 4;

  const spanX = Math.max(320, SCENE_HEIGHT * 0.6);
  const thickness = Math.max(28, nodeStep * 0.9);
  const blur = Math.max(36, nodeStep * 1.1);

  let level = 0;

  for (let i = 0; i < count; i += 1) {
    const tipX = ((nowMs * speed + i * spacing) % travel) - travelPad;
    const strength = 1 - i * 0.12;
    const chevron = chevronLevel(item, tipX, spanX, thickness, blur) * strength;
    level = Math.max(level, chevron);
  }

  return clamp01(level);
}

function levelCamera(item, nowMs) {
  if (!cameraPixels) return 0.25 * levelHover(item, nowMs);

  const width = cameraCanvas.width;
  const height = cameraCanvas.height;
  const xNorm = sampleMirrorX ? 1 - item.cx / SCENE_WIDTH : item.cx / SCENE_WIDTH;
  const px = Math.max(0, Math.min(width - 1, Math.round(xNorm * (width - 1))));
  const py = Math.max(0, Math.min(height - 1, Math.round((item.cy / SCENE_HEIGHT) * (height - 1))));
  const index = (py * width + px) * 4;

  const r = cameraPixels[index];
  const g = cameraPixels[index + 1];
  const b = cameraPixels[index + 2];
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const span = Math.max(0.08, cameraLumaMax - cameraLumaMin);
  const normalized = clamp01((luma - cameraLumaMin) / span);
  const enhanced = Math.pow(normalized, 0.6);
  const pulse = 0.5 + 0.5 * Math.sin(nowMs * 0.003 + item.phase);
  return clamp01(smoothstep(0.03, 0.94, enhanced) * (0.96 + pulse * 0.04));
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
  const levelFollow = 1 - Math.exp(-deltaMs / (isRipple ? 80 : 190));
  const scaleFollow = 1 - Math.exp(-deltaMs / (isRipple ? 75 : 170));

  if (driverMode === "camera") updateCameraPixels();
  if (veinsActive) updateVeins(deltaMs);
  if (driverMode === "hover") {
    applyHoverPointerFluid(nowMs);
    applyHoverSplashes(nowMs);
    applyClickWaves(nowMs);
  }
  fluidStep(deltaMs / 1000);

  // Smooth density for stable visual output (like Codex luma smoothing)
  const smoothAlpha = 1 - Math.exp(-deltaMs / DENSITY_SMOOTHING_MS);
  for (let i = 0; i < FLUID_SIZE; i += 1) {
    fluidDensitySmoothed[i] += (fluidDensity[i] - fluidDensitySmoothed[i]) * smoothAlpha;
  }

  // Ambient noise-driven currents near pointer for organic flow
  const ambientActivity = clamp01(1 - (hoverIdleMs - HOVER_SETTLE_MS) / HOVER_SETTLE_FADE_MS);
  if (pointerState.inside && driverMode === "hover" && ambientActivity > 0) {
    const pgx = (pointerState.x / SCENE_WIDTH) * (FLUID_COLS - 1);
    const pgy = (pointerState.y / SCENE_HEIGHT) * (FLUID_ROWS - 1);
    const ambientRadius = 14;
    const ambientStr = 0.06 * ambientActivity;
    const minAX = Math.max(1, Math.floor(pgx - ambientRadius));
    const maxAX = Math.min(FLUID_COLS - 2, Math.ceil(pgx + ambientRadius));
    const minAY = Math.max(1, Math.floor(pgy - ambientRadius));
    const maxAY = Math.min(FLUID_ROWS - 2, Math.ceil(pgy + ambientRadius));
    for (let ay = minAY; ay <= maxAY; ay += 2) {
      for (let ax = minAX; ax <= maxAX; ax += 2) {
        const dist = Math.hypot(ax - pgx, ay - pgy);
        if (dist > ambientRadius) continue;
        const falloff = 1 - smoothstep(0, ambientRadius, dist);
        const nx = ax * 0.11 + nowMs * 0.00013;
        const ny = ay * 0.11 - nowMs * 0.00009;
        const n = noise2d(nx, ny);
        const angle = n * Math.PI * 2;
        const idx = fluidIndex(ax, ay);
        fluidVelX[idx] += Math.cos(angle) * ambientStr * falloff;
        fluidVelY[idx] += Math.sin(angle) * ambientStr * falloff;
      }
    }
  }

  if (driverMode === "hover") {
    applyHoverFluidToggles(nowMs);
  }
  if (driverMode === "ripple") {
    applyRippleToggles(nowMs);
  }
  if (driverMode === "hover" && !pointerState.inside && hoverSplashes.length === 0) {
    for (let i = 0; i < FLUID_SIZE; i += 1) {
      fluidDensity[i] *= 0.93;
      fluidVelX[i] *= 0.9;
      fluidVelY[i] *= 0.9;
    }
  }

  const isCameraActive = driverMode === "camera" && !introRevealActive;
  const opacityFollow = 1 - Math.exp(-deltaMs / 140);

  for (const item of renderedVectors) {
    const level = clamp01(driverLevel(item, nowMs));
    item.motion += (level - item.motion) * levelFollow;
    const reveal = introRevealLevel(item, nowMs);
    const revealEased = reveal * reveal * (3 - 2 * reveal);

    let targetScale, targetOpacity;
    if (isCameraActive) {
      targetScale = Math.max(0.001, revealEased * (0.18 + item.motion * 2.0));
      targetOpacity = clamp01(0.12 + item.motion * 1.18);
    } else {
      const hoverBoost = driverMode === "hover" ? 2.6 : driverMode === "ripple" ? 2.2 : driverMode === "arrow" ? 2.4 : 0.95;
      targetScale = Math.max(0.001, revealEased * (1 + item.motion * hoverBoost));
      targetOpacity = introRevealActive ? clamp01(revealEased * 2.5) : 1;
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
    applyTransform(item, item.scale);
  }

  updateGridOpacities();
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
      hoverPointerDown = driverMode === "hover" && event.button === 0;
      if (hoverPointerDown) {
        addHoverBurst(pointerState.x, pointerState.y, performance.now());
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

  sampleBtn.addEventListener("click", loadSample);
  randomFillBtn.addEventListener("click", randomFill);
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

  toggleUiBtn.addEventListener("click", () => {
    setUiVisible(!uiVisible);
  });

  board.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.button !== 2) return;
    if (dragAction) return;
    pointerState.inside = true;
    pointerToScene(event);
    hoverPointerDown = driverMode === "hover" && event.button === 0;
    if (hoverPointerDown) {
      addHoverBurst(pointerState.x, pointerState.y, performance.now());
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
    resetHoverPointerState();
  });

  board.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });

  window.addEventListener("pointerup", () => {
    if (hoverPointerDown && driverMode === "hover") {
      addClickWave(pointerState.x, pointerState.y, performance.now());
    }
    resetHoverPointerState();
    endDrag();
  });

  window.addEventListener("blur", () => {
    resetHoverPointerState();
    endDrag();
    pointerState.inside = false;
  });

  window.addEventListener("keydown", async (event) => {
    const key = event.key.toLowerCase();
    if (key === "backspace") {
      event.preventDefault();
      stepBack();
      return;
    }
    if (key === "l") loadSample();
    if (key === "r") randomFill();
    if (key === "c") clearAll();
    if (key === "g") setGridVisibility(!isGridVisible);
    if (key === "m") setMotion(!motionEnabled);
    if (key === "/") setUiVisible(!uiVisible);
    if (key === "t") toggleVeins();
    if (key === "q") toggleClouds();
    if (key === "e") toggleEraser();
    if (key === "h") await setDriverMode("hover");
  });
}

noiseSeed(Date.now());
drawGridLines();
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
setFillMode("sample");
loadSample(true);
clearUndoState();

requestAnimationFrame(animate);
