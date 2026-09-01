// ══════════════════════════════════════════════════════════════
//  Flag Studio — WebGL cloth simulation for the
//  Willem de Kooning Academy Graduation Show 2026
// ══════════════════════════════════════════════════════════════

const DEFAULT_TEXTURE_PATH = 'demo%20flag.png';
const MOBILE_QUERY = window.matchMedia('(max-width: 740px)');
const isMobileViewport = () => MOBILE_QUERY.matches;
const TEXTURE_MAX_DIM = 4096;
const MOBILE_TEXTURE_MAX_DIM = 2048;
const LIVE_VIDEO_TEXTURE_MAX_DIM = 1024;
let forceFullTexture = false;

function liveTextureMaxDim() {
  return forceFullTexture || !isMobileViewport() ? TEXTURE_MAX_DIM : MOBILE_TEXTURE_MAX_DIM;
}

function prepareFullTextureForExport() {
  if (!isMobileViewport() || (!textTexActive && !imageTexActive)) return null;
  forceFullTexture = true;
  refreshTexture();
  forceFullTexture = false;
  return () => queueTextureRefresh();
}

// ─── Config ──────────────────────────────────────────────────
const DENSITY = 28;
let SUBSTEPS = 2;
const POLE_RADIUS = 0.026;
const POLE_SEGMENTS = 96;

let aspectW = 3, aspectH = 2;
let flagW, flagH, cols, rows, totalPts;
let restDx, restDy, restDiag;

function computeGrid(aw, ah) {
  const maxDim = 3.0;
  const maxArea = 6.0; // cap particle count so square-ish ratios don't tank perf
  if (aw >= ah) { flagW = maxDim; flagH = maxDim * (ah / aw); }
  else { flagH = maxDim; flagW = maxDim * (aw / ah); }
  const area = flagW * flagH;
  if (area > maxArea) {
    const s = Math.sqrt(maxArea / area);
    flagW *= s; flagH *= s;
  }
  cols = Math.round(flagW * DENSITY);
  rows = Math.round(flagH * DENSITY);
  if (cols < 4) cols = 4;
  if (rows < 4) rows = 4;
  totalPts = cols * rows;
  restDx = flagW / (cols - 1);
  restDy = flagH / (rows - 1);
  restDiag = Math.sqrt(restDx * restDx + restDy * restDy);
}
computeGrid(aspectW, aspectH);

// ─── Viking cloth model ──────────────────────────────────────
// Ported from the Viking sketch: heavy satin on a flexible mast. The wind is a
// coherent field — one vector per column plus a per-row bias — instead of
// per-particle noise, so the cloth rolls in big folds rather than buzzing. The
// weight comes from self-collision (folds cannot pass through each other) and
// long-range attachments (satin barely stretches).
const VK = {
  damp: 0.996,          // verlet velocity retention per substep
  kNormal: 0.62,        // aerodynamic pressure along the surface normal
  kTangent: 0.12,       // tangential drag
  kStruct: 1.0, kShear: 0.7, kBend: 0.45,
  itersA: 5, itersB: 2, // constraint passes before / after self-collision
  thickCells: 2.0,      // self-collision thickness, in cells
  lraSlack: 1.004,      // cap every particle at its taut geodesic to the hoist
  gravity: 7.4,         // downward accel at the default gravity slider (-1)
  windMax: 10.0,        // wind slider 100 → 0.7 × this, matching Viking's default
  timeScale: 0.85,      // < 1 reads heavier / bigger
  maxAccel: 90,
};

// The mast. Flag's cylinder runs far below the viewport for framing, so the
// bend is measured against a virtual mast with Viking's proportions (2.2× the
// flag height, hoist just under the tip) — that is what makes the sway read the
// same at any aspect ratio.
const POLE = {
  freq: 0.5,      // Hz — natural sway
  zeta: 0.07,     // damping ratio (low = keeps swaying)
  drive: 0.008,   // tip force per wind²
  couple: 9.0,    // how hard the flag's lateral swing drags the tip
  maxBend: 0.5,   // clamp on tip deflection at the reference mast length
  radius: 0.038,  // keep-out radius, a shade wider than the drawn mast
};
let poleLen = 4.4, poleBaseY = -2.68;
const sway = { x: 0, z: 0, vx: 0, vz: 0 };
function computePoleRig() {
  poleLen = flagH * 2.2;
  poleBaseY = flagH * 0.8 - poleLen * 0.973;   // hoist top sits just under the tip
}
computePoleRig();
// Quadratic from the base — a mast bends most at the tip.
function bendAt(y) { const k = clamp((y - poleBaseY) / poleLen, 0, 1); return k * k; }

const SIM = {
  windStrength: 100,
  turbulence: 30,
  windAngle: 90,
  stiffness: 40,
  damping: 92,
  gravity: -1,
  opacity: 0,
  flagColor: [0.831, 0.996, 0.827],
  bgColor: [0.831, 0.996, 0.827],
};

// Weather preset — 'normal' or 'storm'. Storm widens angle-drift for swirling gusts.
const WEATHER = { mode: 'normal', angleDriftMax: 24, angleDriftForce: 1.0 };

// Attachment: 'edge' pins the full hoist column (pole flag); 'corners' pins only
// top-left + bottom-left (banner/rope attachment) so the hoist edge itself flaps.
const ATTACH = { mode: 'edge' };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ─── 2D value noise + FBM (for fabric flutter) ──────────────
function _hash2(x, y) {
  const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return h - Math.floor(h);
}
function _noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = _hash2(xi, yi);
  const b = _hash2(xi + 1, yi);
  const c = _hash2(xi, yi + 1);
  const d = _hash2(xi + 1, yi + 1);
  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  return (ab + (cd - ab) * v) * 2.0 - 1.0;
}
function fbm2(x, y) {
  return (
    _noise2(x,         y)         * 1.00 +
    _noise2(x * 2.13,  y * 2.07)  * 0.50 +
    _noise2(x * 4.27,  y * 4.19)  * 0.25
  ) * 0.571; // 1 / (1 + 0.5 + 0.25)
}

// ─── Cloth arrays ────────────────────────────────────────────
let pos, prev, nrm, uv, fixed;
let numC, conA, conB, conR, conK;

// Pinned particles that actually ride the mast (as opposed to the out-of-shape
// particles parked in fixed[]) — the sway drives these every substep.
let pinList = null;        // flat [particle, row, particle, row, …]
let rowPinned = null;      // Uint8Array(rows) — row has a live hoist pin
let hoistCol = 0;          // leftmost column that still has cloth in it

// ── Render surface: the sim grid bicubically subdivided ──
// Viking's silhouette and shading smoothness come from here, not from a denser
// sim. The sim stays cheap; the surface the shader sees is SUBDIV× finer, with
// real tangents so the crease map and the anisotropic sheen have a weft to
// follow.
const SUBDIV = 2;
let RC = 0, RR = 0, RN = 0;
let rPos, rNrm, rTan, rUV, rowPass;
let rIndexData = null;
// Catmull-Rom weights for each sub-sample position.
const CRW = [];
for (let s = 0; s < SUBDIV; s++) {
  const f = s / SUBDIV;
  CRW.push([
    -0.5 * f + f * f - 0.5 * f * f * f,
    1 - 2.5 * f * f + 1.5 * f * f * f,
    0.5 * f + 2 * f * f - 1.5 * f * f * f,
    -0.5 * f * f + 0.5 * f * f * f,
  ]);
}

// ── Self-collision broadphase (spatial hash) ──
const SC_HASH_N = 1 << 15, SC_HASH_MASK = SC_HASH_N - 1;
const scCellStart = new Int32Array(SC_HASH_N + 1);
const scFillPtr = new Int32Array(SC_HASH_N);
let scCellOf = null, scSorted = null;

function allocArrays() {
  pos = new Float32Array(totalPts * 3);
  prev = new Float32Array(totalPts * 3);
  nrm = new Float32Array(totalPts * 3);
  uv = new Float32Array(totalPts * 2);
  fixed = new Uint8Array(totalPts);
  scCellOf = new Int32Array(totalPts);
  scSorted = new Int32Array(totalPts);
  rowPinned = new Uint8Array(rows);

  RC = (cols - 1) * SUBDIV + 1;
  RR = (rows - 1) * SUBDIV + 1;
  RN = RC * RR;
  rPos = new Float32Array(RN * 3);
  rNrm = new Float32Array(RN * 3);
  rTan = new Float32Array(RN * 3);
  rUV = new Float32Array(RN * 2);
  rowPass = new Float32Array(rows * RC * 3);
  for (let ry = 0; ry < RR; ry++) {
    for (let rx = 0; rx < RC; rx++) {
      const o = (ry * RC + rx) * 2;
      rUV[o] = rx / (RC - 1);
      rUV[o + 1] = ry / (RR - 1);
    }
  }
}

// ─── Custom shape (silhouette polygon) ───────────────────────
// shapePoints: null = plain rectangle. Otherwise a polygon in normalized flag
// space ([0..1]×[0..1], v down — same orientation as the cloth UVs), edited
// via the mini ratio box. The polygon trims the simulated mesh (particles
// outside go inactive) and an alpha mask cuts the exact silhouette in the
// fragment shader, so the staircase trim edge never shows.
let shapePoints = null;
let clothActive = null;   // Uint8Array(totalPts) | null (null = all active)
let cellActive = null;    // Uint8Array((cols-1)*(rows-1)) | null
let _lastValidShape = null;
const SHAPE_MARGIN_CELLS = 2; // keep a ring of live cells outside the polygon

function isCustomShape() { return shapePoints !== null; }

// Even-odd ray cast — must agree with the canvas fill('evenodd') used for the
// visual mask so the sim trim and the silhouette never disagree.
function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, k = pts.length - 1; i < pts.length; k = i++) {
    const xi = pts[i][0], yi = pts[i][1], xk = pts[k][0], yk = pts[k][1];
    if ((yi > y) !== (yk > y) && x < (xk - xi) * (y - yi) / (yk - yi) + xi) inside = !inside;
  }
  return inside;
}

// Mark particles inside the polygon (plus a margin ring, measured in grid
// cells) as active and derive per-cell renderability. Returns false when the
// polygon is degenerate (too few live cells to simulate), leaving the
// previous mask untouched so the caller can revert.
function computeActiveMask() {
  if (!shapePoints) { clothActive = null; cellActive = null; return true; }
  const pts = shapePoints;
  const act = new Uint8Array(totalPts);
  const m2 = SHAPE_MARGIN_CELLS * SHAPE_MARGIN_CELLS;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const u = i / (cols - 1), v = j / (rows - 1);
      let on = pointInPoly(u, v, pts);
      if (!on) {
        // distance to the polygon outline, measured in grid-index space
        for (let s = 0; s < pts.length && !on; s++) {
          const a = pts[s], b = pts[(s + 1) % pts.length];
          const ax = a[0] * (cols - 1), ay = a[1] * (rows - 1);
          const bx = b[0] * (cols - 1), by = b[1] * (rows - 1);
          const dx = bx - ax, dy = by - ay;
          const L2 = dx * dx + dy * dy;
          let t = L2 > 0 ? ((i - ax) * dx + (j - ay) * dy) / L2 : 0;
          if (t < 0) t = 0; else if (t > 1) t = 1;
          const ox = ax + dx * t - i, oy = ay + dy * t - j;
          if (ox * ox + oy * oy <= m2) on = true;
        }
      }
      act[j * cols + i] = on ? 1 : 0;
    }
  }
  const cell = new Uint8Array((cols - 1) * (rows - 1));
  let live = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i;
      if (act[a] && act[a + 1] && act[a + cols] && act[a + cols + 1]) {
        cell[j * (cols - 1) + i] = 1;
        live++;
      }
    }
  }
  if (live < 8) return false;
  clothActive = act;
  cellActive = cell;
  return true;
}

function initCloth() {
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      const i3 = idx * 3;
      const u = i / (cols - 1), v = j / (rows - 1);
      const x = u * flagW;
      const y = -v * flagH + flagH * 0.8;
      // Seed Z with gentle wave so cloth settles faster
      const z = (i % cols === 0) ? 0 : Math.sin(u * 4 + v * 3) * 0.08 * flagW;
      pos[i3] = prev[i3] = x;
      pos[i3 + 1] = prev[i3 + 1] = y;
      pos[i3 + 2] = prev[i3 + 2] = z;
      uv[idx * 2] = u;
      uv[idx * 2 + 1] = v;
    }
  }
}

let _lastPinKey = '';

// Where row j's hoist pin sits right now, including the mast's bend.
const _anc = [0, 0, 0];
function anchorFor(j, out) {
  const y = flagH * 0.8 - j * restDy;
  const k = bendAt(y);
  out[0] = hoistCol * restDx + sway.x * k;
  out[1] = y;
  out[2] = sway.z * k;
  return out;
}

// Pinned particles follow the mast rather than sitting at a fixed point, so a
// gust that bends the pole carries the whole flag with it.
function driveAnchors() {
  if (!pinList) return;
  for (let k = 0; k < pinList.length; k += 2) {
    const i3 = pinList[k] * 3;
    anchorFor(pinList[k + 1], _anc);
    pos[i3] = prev[i3] = _anc[0];
    pos[i3 + 1] = prev[i3 + 1] = _anc[1];
    pos[i3 + 2] = prev[i3 + 2] = _anc[2];
  }
}

function applyPinning() {
  const active = i => !clothActive || clothActive[i];
  // Particles outside the custom shape are parked as fixed — every sim pass
  // already skips fixed[], so they cost nothing and never move.
  for (let i = 0; i < totalPts; i++) fixed[i] = active(i) ? 0 : 1;
  // Hoist = leftmost column that still has active particles, so a shape cut
  // away from the pole edge stays attached instead of flying off.
  let L = 0;
  if (clothActive) {
    outer:
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        if (clothActive[j * cols + i]) { L = i; break outer; }
      }
    }
  }
  hoistCol = L;
  const pins = [];
  rowPinned.fill(0);
  if (ATTACH.mode === 'corners') {
    let topJ = -1, botJ = -1;
    for (let j = 0; j < rows; j++) {
      if (active(j * cols + L)) { if (topJ < 0) topJ = j; botJ = j; }
    }
    if (topJ < 0) { topJ = 0; botJ = rows - 1; }
    fixed[topJ * cols + L] = 1;
    fixed[botJ * cols + L] = 1;
    pins.push(topJ * cols + L, topJ, botJ * cols + L, botJ);
    const pinKey = `corners:${cols}x${rows}:${L}:${topJ}:${botJ}`;
    // Kickstart: nudge the now-free hoist column slightly outward in z so it
    // immediately starts billowing instead of hanging dead at z=0. Only when
    // the pinned set actually changed — re-running it on every live shape
    // tweak would keep resetting the hoist.
    if (pos && pinKey !== _lastPinKey) {
      for (let j = topJ + 1; j < botJ; j++) {
        const idx = j * cols + L;
        if (!active(idx)) continue;
        const i3 = idx * 3;
        const bow = Math.sin(j / (rows - 1) * Math.PI) * restDx * 0.8;
        pos[i3 + 2] = bow;
        prev[i3 + 2] = bow - 0.001;
      }
    }
    _lastPinKey = pinKey;
  } else {
    const pinKey = `edge:${cols}x${rows}:${L}`;
    // Snap hoist column back to its initial straight position — otherwise
    // particles stay pinned wherever they drifted to during 'corners' mode.
    const snap = pos && pinKey !== _lastPinKey;
    for (let j = 0; j < rows; j++) {
      const idx = j * cols + L;
      if (!active(idx)) continue;
      fixed[idx] = 1;
      pins.push(idx, j);
      rowPinned[j] = 1;
      if (snap) {
        const i3 = idx * 3;
        const y = -(j / (rows - 1)) * flagH + flagH * 0.8;
        pos[i3] = prev[i3] = L * restDx;
        pos[i3 + 1] = prev[i3 + 1] = y;
        pos[i3 + 2] = prev[i3 + 2] = 0;
      }
    }
    _lastPinKey = pinKey;
  }
  pinList = Int32Array.from(pins);
}

function buildMesh() {
  computeActiveMask();
  applyPinning();

  // The render surface inherits the sim's active cells — each render quad sits
  // inside exactly one sim cell, and the alpha mask cuts the exact silhouette.
  const rIdx = [];
  for (let ry = 0; ry < RR - 1; ry++) {
    const sj = Math.min((ry / SUBDIV) | 0, rows - 2);
    for (let rx = 0; rx < RC - 1; rx++) {
      const si = Math.min((rx / SUBDIV) | 0, cols - 2);
      if (cellActive && !cellActive[sj * (cols - 1) + si]) continue;
      const a = ry * RC + rx, b = (ry + 1) * RC + rx;
      rIdx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  rIndexData = new Uint32Array(rIdx);

  // Structural / shear / bend, each with its own stiffness. Satin holds its
  // length hard and resists shear almost as hard; bend is the soft one, which
  // is what lets it fold instead of dome.
  const cA = [], cB = [], cR = [], cKk = [];
  const act = i => !clothActive || clothActive[i];
  const addC = (a, b, r, k) => { if (act(a) && act(b)) { cA.push(a); cB.push(b); cR.push(r); cKk.push(k); } };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      if (i < cols - 1) addC(idx, idx + 1, restDx, VK.kStruct);
      if (j < rows - 1) addC(idx, idx + cols, restDy, VK.kStruct);
      if (i < cols - 1 && j < rows - 1) {
        addC(idx, idx + cols + 1, restDiag, VK.kShear);
        addC(idx + 1, idx + cols, restDiag, VK.kShear);
      }
      // Bend constraints also require the in-between particle — they must not
      // bridge across a notch cut into the shape (e.g. a swallowtail).
      if (i < cols - 2 && act(idx + 1)) addC(idx, idx + 2, restDx * 2, VK.kBend);
      if (j < rows - 2 && act(idx + cols)) addC(idx, idx + cols * 2, restDy * 2, VK.kBend);
    }
  }
  numC = cA.length;
  conA = new Uint32Array(cA);
  conB = new Uint32Array(cB);
  conR = new Float32Array(cR);
  conK = new Float32Array(cKk);
}

function rebuildGrid(aw, ah) {
  computeGrid(aw, ah);
  computePoleRig();
  sway.x = sway.z = sway.vx = sway.vz = 0;
  allocArrays();
  buildMesh();
  initCloth();
}
rebuildGrid(aspectW, aspectH);

// ─── Wind field + gusts ──────────────────────────────────────
// A gust is one coherent rise/hold/fall envelope that leans on the whole flag,
// not a drifting cloud of blobs. Holding the Gust button charges a bigger one.
let _loopSimPhase = -1;
let _loopGustBase = null;
let _loopSimStep = 0;
let _loopSimTotalSteps = 1;

const GUST_RISE = 1.6, GUST_FALL = 3.0;
const GUST = {
  start: -1, next: 4, lift: 0.9, side: 0.4,
  power: 1, hold: 0.8, pending: 0, last: 0,
};

function initGusts() {
  GUST.start = -1;
  GUST.next = 4 + Math.random() * 4;
  GUST.lift = 0.9; GUST.side = 0.4; GUST.power = 1; GUST.hold = 0.8;
  GUST.pending = 0; GUST.last = 0;
}
initGusts();

const smooth01 = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

// Turbulence sets how often the air decides to shove; a storm roughly doubles it.
function gustInterval() {
  const storm = WEATHER.mode === 'storm' ? 0.45 : 1;
  return (7 + Math.random() * 5) / (0.55 + (SIM.turbulence / 100) * 1.4) * storm;
}

function beginGust(t, power, resumeAt) {
  GUST.start = t - resumeAt;
  GUST.power = power;
  GUST.hold = 0.8 * power;
  GUST.lift = (0.6 + Math.random() * 0.9) * power;
  GUST.side = (Math.random() - 0.5) * 1.2 * power;
  GUST.next = t + gustInterval();
}

function triggerGust(power = 1) {
  // Mid-gust retrigger re-enters the rise where the envelope already is, so a
  // second press never drops the wind out from under the flag.
  if (GUST.start < 0) { GUST.pending = power; GUST.next = Math.min(GUST.next, simTime); }
  else beginGust(simTime, power, GUST_RISE * GUST.last);
}

function gustEnv(t) {
  // A seamless export drives the gust off the loop phase instead, so the
  // envelope closes exactly on itself at the seam.
  if (_loopSimPhase >= 0) {
    GUST.power = 1; GUST.lift = 0.8; GUST.side = 0.3;
    const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * _loopSimPhase);
    return (GUST.last = h * h);
  }
  if (GUST.start < 0) {
    if (t < GUST.next) return (GUST.last = 0);
    beginGust(t, GUST.pending || 1, 0);
    GUST.pending = 0;
  }
  const e = t - GUST.start, peak = GUST_RISE + GUST.hold;
  let g;
  if (e < GUST_RISE) g = smooth01(e / GUST_RISE);
  else if (e < peak) g = 1;
  else if (e < peak + GUST_FALL) g = 1 - smooth01((e - peak) / GUST_FALL);
  else { GUST.start = -1; g = 0; }
  return (GUST.last = g);
}

// ─── Physics simulation (Viking cloth model) ─────────────────
let simTime = 0;
let windAngleDrift = 0, windAngleVel = 0, windStrengthDrift = 0;
let windCol = new Float32Array(0), windRow = new Float32Array(0);

function windBaseSpeed() {
  const storm = WEATHER.mode === 'storm' ? 1.32 : 1;
  return clamp(SIM.windStrength / 100, 0, 3) * 0.7 * VK.windMax * storm;
}

function windMag(t, g, base) {
  const L = _loopSimPhase >= 0;
  const a = _loopSimPhase * Math.PI * 2;
  const breathe = L
    ? 0.85 + 0.15 * Math.sin(a) + 0.10 * Math.sin(3 * a + 1.3)
    : 0.85 + 0.15 * Math.sin(0.5 * t) + 0.10 * Math.sin(1.4 * t + 1.3);
  return base * (breathe + windStrengthDrift * 0.18) + g * GUST.power * (2.6 + base * 0.55);
}

// One wind vector per column plus a per-row bias, rebuilt every substep. This
// is the heart of the Viking feel: neighbouring particles see almost the same
// air, so the cloth answers in long folds instead of per-particle chatter.
// Under a seamless export every term becomes a whole harmonic of the loop.
function updateWindField(t, g, mag, wdx, wdz) {
  if (windCol.length !== cols * 3) windCol = new Float32Array(cols * 3);
  if (windRow.length !== rows) windRow = new Float32Array(rows);
  const turbK = (0.35 + (SIM.turbulence / 100) * 2.2) * (WEATHER.mode === 'storm' ? 1.35 : 1);
  const L = _loopSimPhase >= 0;
  const a = _loopSimPhase * Math.PI * 2;
  const cxx = -wdz, cxz = wdx;          // cross-wind axis in the XZ plane
  for (let i = 0; i < cols; i++) {
    const u = i / (cols - 1), o = i * 3;
    const lift = mag * turbK * (L
        ? 0.22 * Math.sin(2 * a + 3.0 * u) + 0.12 * Math.sin(4 * a - 5.0 * u + 1.0)
        : 0.22 * Math.sin(0.9 * t + 3.0 * u) + 0.12 * Math.sin(1.9 * t - 5.0 * u + 1.0))
      + g * GUST.lift * 2.4;
    const cross = mag * turbK * (L
        ? 0.35 * Math.sin(3 * a - 4.5 * u) + 0.18 * Math.sin(5 * a - 8.0 * u + 2.0) + 0.07 * Math.sin(9 * a - 15.0 * u + 1.0)
        : 0.35 * Math.sin(1.3 * t - 4.5 * u) + 0.18 * Math.sin(2.4 * t - 8.0 * u + 2.0) + 0.07 * Math.sin(4.2 * t - 15.0 * u + 1.0))
      + g * GUST.side * 2.0;
    windCol[o]     = wdx * mag + cxx * cross;
    windCol[o + 1] = lift;
    windCol[o + 2] = wdz * mag + cxz * cross;
  }
  for (let j = 0; j < rows; j++) {
    const v = j / (rows - 1);
    windRow[j] = mag * turbK * (L
      ? 0.10 * Math.sin(2 * a + 2.2 * v) + 0.05 * Math.sin(5 * a + 3.1 * v)
      : 0.10 * Math.sin(0.8 * t + 2.2 * v) + 0.05 * Math.sin(2.4 * t + 3.1 * v));
  }
}

// ── The mast ──
// A damped harmonic oscillator at the tip: the mean wind leans it downwind, and
// the flag's own lateral swing drags it sideways, which feeds back into the
// cloth through the anchors. That two-way coupling is why the whole rig
// breathes together instead of the flag flapping on a dead stick.
function updateSway(dt, mag, g, wdx, wdz) {
  let sx = 0, sz = 0, n = 0;
  const step = Math.max(1, (rows / 16) | 0);
  for (let j = 0; j < rows; j += step) {
    anchorFor(j, _anc);
    for (let i = hoistCol + 2; i <= hoistCol + 6 && i < cols; i += 2) {
      const pI = j * cols + i;
      if (clothActive && !clothActive[pI]) continue;
      const i3 = pI * 3;
      sx += pos[i3] - _anc[0];
      sz += pos[i3 + 2] - _anc[2];
      n++;
    }
  }
  if (n) { sx /= n; sz /= n; }
  const omega = 2 * Math.PI * POLE.freq, k = omega * omega, c = 2 * POLE.zeta * omega;
  const pullCross = -wdz * sx + wdx * sz;
  const fDown = POLE.drive * mag * mag * (1 + 0.4 * g);
  const fCross = POLE.couple * pullCross + POLE.drive * 0.6 * mag * mag * g * GUST.side;
  const fx = wdx * fDown - wdz * fCross;
  const fz = wdz * fDown + wdx * fCross;
  sway.vx += (fx - k * sway.x - c * sway.vx) * dt;
  sway.vz += (fz - k * sway.z - c * sway.vz) * dt;
  sway.x += sway.vx * dt;
  sway.z += sway.vz * dt;
  const maxBend = POLE.maxBend * (poleLen / 4.4);
  const m = Math.hypot(sway.x, sway.z);
  if (m > maxBend) { const s = maxBend / m; sway.x *= s; sway.z *= s; sway.vx *= 0.5; sway.vz *= 0.5; }
}

// Cheap central-difference normals — the aero term needs a surface normal every
// substep, and the smooth ones the shader uses are built later from the
// subdivided surface instead.
function computeAeroNormals() {
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const l = (j * cols + Math.max(i - 1, 0)) * 3, r = (j * cols + Math.min(i + 1, cols - 1)) * 3;
      const u = (Math.max(j - 1, 0) * cols + i) * 3, d = (Math.min(j + 1, rows - 1) * cols + i) * 3;
      const ax = pos[r] - pos[l], ay = pos[r + 1] - pos[l + 1], az = pos[r + 2] - pos[l + 2];
      const bx = pos[d] - pos[u], by = pos[d + 1] - pos[u + 1], bz = pos[d + 2] - pos[u + 2];
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      const i3 = (j * cols + i) * 3;
      nrm[i3] = nx / len; nrm[i3 + 1] = ny / len; nrm[i3 + 2] = nz / len;
    }
  }
}

function integrate(dt, wdx, wdz) {
  const dt2 = dt * dt, invDt = 1 / dt;
  // Damping slider around its 92 default reproduces Viking's 0.996; storm's 94
  // holds a touch more momentum, which is what makes soaked cloth feel heavy.
  const damp = 1 - (1 - SIM.damping / 100) * 0.05;
  const gravity = -SIM.gravity * VK.gravity;   // slider default -1 → 7.4 down
  const maxStep = Math.max(restDx, restDy) * 1.5;
  const kN = VK.kNormal, kT = VK.kTangent, maxA = VK.maxAccel;
  const crossX = -wdz, crossZ = wdx;
  const spin = Math.abs(orbitAngularVel) > 0.05 ? orbitAngularVel : 0;
  const invCols = 1 / (cols - 1);
  for (let j = 0; j < rows; j++) {
    const wRow = windRow[j], rowBase = j * cols;
    for (let i = 0; i < cols; i++) {
      const pI = rowBase + i;
      if (fixed[pI]) continue;
      const i3 = pI * 3, o = i * 3;
      const px = pos[i3], py = pos[i3 + 1], pz = pos[i3 + 2];
      let vx = (px - prev[i3]) * damp, vy = (py - prev[i3 + 1]) * damp, vz = (pz - prev[i3 + 2]) * damp;
      // Airflow relative to the particle — this single term is drag and push at once.
      const rx = windCol[o] + crossX * wRow - vx * invDt;
      const ry = windCol[o + 1] - vy * invDt;
      const rz = windCol[o + 2] + crossZ * wRow - vz * invDt;
      const nx = nrm[i3], ny = nrm[i3 + 1], nz = nrm[i3 + 2];
      const vn = rx * nx + ry * ny + rz * nz;
      const pn = vn * Math.abs(vn) * kN;                    // pressure across the sheet
      let ax = nx * pn + (rx - nx * vn) * kT;               // + skin friction along it
      let ay = ny * pn + (ry - ny * vn) * kT - gravity;
      let az = nz * pn + (rz - nz * vn) * kT;
      if (spin) {
        // Spinning the pole throws the cloth outward and drags it round.
        const rl = Math.sqrt(px * px + pz * pz) + 0.001;
        const uu = i * invCols;
        const cf = spin * spin * rl * uu * 0.95, tg = spin * uu * 0.55;
        ax += (px / rl) * cf + (-pz / rl) * tg;
        az += (pz / rl) * cf + (px / rl) * tg;
      }
      const am = Math.sqrt(ax * ax + ay * ay + az * az);
      if (am > maxA) { const s = maxA / am; ax *= s; ay *= s; az *= s; }
      vx += ax * dt2; vy += ay * dt2; vz += az * dt2;
      const vm = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (vm > maxStep) { const s = maxStep / vm; vx *= s; vy *= s; vz *= s; }
      prev[i3] = px; prev[i3 + 1] = py; prev[i3 + 2] = pz;
      pos[i3] = px + vx; pos[i3 + 1] = py + vy; pos[i3 + 2] = pz + vz;
    }
  }
}

function solveConstraints(iters) {
  for (let it = 0; it < iters; it++) {
    for (let c = 0; c < numC; c++) {
      const a = conA[c], b = conB[c];
      const af = fixed[a], bf = fixed[b];
      if (af && bf) continue;
      const a3 = a * 3, b3 = b * 3;
      const dx = pos[b3] - pos[a3], dy = pos[b3 + 1] - pos[a3 + 1], dz = pos[b3 + 2] - pos[a3 + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1e-7) continue;
      const diff = (d - conR[c]) / d * 0.5 * conK[c];
      const cx = dx * diff, cy = dy * diff, cz = dz * diff;
      if (!af && !bf) {
        pos[a3] += cx; pos[a3 + 1] += cy; pos[a3 + 2] += cz;
        pos[b3] -= cx; pos[b3 + 1] -= cy; pos[b3 + 2] -= cz;
      } else if (!af) {
        pos[a3] += cx * 2; pos[a3 + 1] += cy * 2; pos[a3 + 2] += cz * 2;
      } else {
        pos[b3] -= cx * 2; pos[b3 + 1] -= cy * 2; pos[b3 + 2] -= cz * 2;
      }
    }
  }
}

// Long-range attachments. Gauss-Seidel only carries the hoist's motion a few
// cells per substep, so a fast mast swing leaves the fabric near the pole
// rubbery. Capping every particle's distance to the pin in its own row — the
// shortest path through the cloth — takes that out in one O(N) pass, which is
// all the frame budget has room for. Only meaningful when the whole hoist is
// pinned; a two-corner banner is supposed to stretch along its free edge.
function longRangeAttach() {
  if (ATTACH.mode !== 'edge' || !rowPinned) return;
  for (let j = 0; j < rows; j++) {
    if (!rowPinned[j]) continue;
    anchorFor(j, _anc);
    const ax = _anc[0], ay = _anc[1], az = _anc[2];
    for (let i = hoistCol + 1; i < cols; i++) {
      const pI = j * cols + i;
      if (fixed[pI]) continue;
      const i3 = pI * 3;
      const dx = pos[i3] - ax, dy = pos[i3 + 1] - ay, dz = pos[i3 + 2] - az;
      const d2 = dx * dx + dy * dy + dz * dz;
      const max = (i - hoistCol) * restDx * VK.lraSlack;
      if (d2 <= max * max) continue;
      const k = max / Math.sqrt(d2);
      pos[i3] = ax + dx * k; pos[i3 + 1] = ay + dy * k; pos[i3 + 2] = az + dz * k;
    }
  }
}

// Self-collision: particles that are not grid neighbours stay a cloth-thickness
// apart. This is what gives the fabric volume — folds stack instead of passing
// through each other — and it is the single biggest difference from a plain
// mass-spring flag.
function selfCollide() {
  const thick = restDx * VK.thickCells, thick2 = thick * thick, inv = 1 / thick;
  scCellStart.fill(0);
  for (let pI = 0; pI < totalPts; pI++) {
    if (clothActive && !clothActive[pI]) { scCellOf[pI] = -1; continue; }
    const i3 = pI * 3;
    const h = (((Math.floor(pos[i3] * inv) * 73856093) ^ (Math.floor(pos[i3 + 1] * inv) * 19349663)
             ^ (Math.floor(pos[i3 + 2] * inv) * 83492791)) & SC_HASH_MASK);
    scCellOf[pI] = h;
    scCellStart[h + 1]++;
  }
  for (let h = 0; h < SC_HASH_N; h++) { scCellStart[h + 1] += scCellStart[h]; scFillPtr[h] = scCellStart[h]; }
  for (let pI = 0; pI < totalPts; pI++) { const h = scCellOf[pI]; if (h >= 0) scSorted[scFillPtr[h]++] = pI; }

  for (let pI = 0; pI < totalPts; pI++) {
    if (scCellOf[pI] < 0) continue;
    const i3 = pI * 3, px = pos[i3], py = pos[i3 + 1], pz = pos[i3 + 2];
    const pix = pI % cols, piy = (pI / cols) | 0;
    const cx = Math.floor(px * inv), cy = Math.floor(py * inv), cz = Math.floor(pz * inv);
    const pinnedP = fixed[pI];
    // Probing all 27 cells and keeping q > p looks redundant, but it always
    // moves the later-indexed particle, so every push is followed by that
    // particle's own pass. A forward-half probe is ~10% faster and leaves ~40%
    // more residual overlap.
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (let oz = -1; oz <= 1; oz++) {
      const h = (((((cx + ox) * 73856093) ^ ((cy + oy) * 19349663) ^ ((cz + oz) * 83492791))) & SC_HASH_MASK);
      for (let s = scCellStart[h], e = scCellStart[h + 1]; s < e; s++) {
        const q = scSorted[s];
        if (q <= pI) continue;
        const qix = q % cols, qiy = (q / cols) | 0;
        if (Math.abs(qix - pix) <= 2 && Math.abs(qiy - piy) <= 2) continue;
        const pinnedQ = fixed[q];
        if (pinnedP && pinnedQ) continue;
        const j3 = q * 3;
        const dx = pos[j3] - px, dy = pos[j3 + 1] - py, dz = pos[j3 + 2] - pz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= thick2 || d2 < 1e-10) continue;
        const d = Math.sqrt(d2), push = (thick - d) / d;
        const wp = pinnedP ? 0 : (pinnedQ ? 1 : 0.5), wq = pinnedQ ? 0 : (pinnedP ? 1 : 0.5);
        pos[i3] -= dx * push * wp; pos[i3 + 1] -= dy * push * wp; pos[i3 + 2] -= dz * push * wp;
        pos[j3] += dx * push * wq; pos[j3 + 1] += dy * push * wq; pos[j3 + 2] += dz * push * wq;
      }
    }
  }
}

// Keep the cloth off the mast it hangs from. The hoist itself is pinned on the
// axis, so the first couple of columns are left alone — pushing them out would
// only kink the fabric right where it is held. What matters is the fly, which a
// side gust can otherwise swing straight through the pole.
function poleCollide() {
  const r = POLE.radius, yTop = poleBaseY + poleLen + 0.15;
  const skipTo = hoistCol + 2;
  for (let pI = 0; pI < totalPts; pI++) {
    if (fixed[pI] || pI % cols <= skipTo) continue;
    const i3 = pI * 3, y = pos[i3 + 1];
    if (y < poleBaseY || y > yTop) continue;
    const k = bendAt(y);
    const qx = pos[i3] - (hoistCol * restDx + sway.x * k), qz = pos[i3 + 2] - sway.z * k;
    const len = Math.sqrt(qx * qx + qz * qz);
    if (len >= r) continue;
    if (len < 1e-5) { pos[i3 + 2] += r; continue; }
    const kk = (r - len) / len;
    pos[i3] += qx * kk; pos[i3 + 2] += qz * kk;
  }
}

// Particles trimmed away by a custom shape hold stale parked positions. The
// bicubic surface and the normals both reach two cells past the silhouette, so
// give those cells a sensible continuation of the live cloth rather than a cliff.
function extrapolateInactive() {
  if (!clothActive) return;
  let lastGoodRow = -1;
  for (let j = 0; j < rows; j++) {
    const rowBase = j * cols;
    let first = -1, last = -1;
    for (let i = 0; i < cols; i++) {
      if (clothActive[rowBase + i]) { if (first < 0) first = i; last = i; }
    }
    if (first < 0) {
      // Whole row trimmed — shadow the nearest live row, one cell lower.
      if (lastGoodRow < 0) continue;
      const srcBase = lastGoodRow * cols;
      const dy = (j - lastGoodRow) * restDy;
      for (let i = 0; i < cols; i++) {
        const d3 = (rowBase + i) * 3, s3 = (srcBase + i) * 3;
        pos[d3] = pos[s3]; pos[d3 + 1] = pos[s3 + 1] - dy; pos[d3 + 2] = pos[s3 + 2];
        prev[d3] = pos[d3]; prev[d3 + 1] = pos[d3 + 1]; prev[d3 + 2] = pos[d3 + 2];
      }
      continue;
    }
    lastGoodRow = j;
    // Leading run: continue backwards along the first live gradient.
    if (first > 0) {
      const a3 = (rowBase + first) * 3;
      const b3 = (rowBase + Math.min(first + 1, last)) * 3;
      const dx = pos[a3] - pos[b3], dy = pos[a3 + 1] - pos[b3 + 1], dz = pos[a3 + 2] - pos[b3 + 2];
      for (let i = first - 1; i >= 0; i--) {
        const k = first - i, o = (rowBase + i) * 3;
        pos[o] = pos[a3] + dx * k; pos[o + 1] = pos[a3 + 1] + dy * k; pos[o + 2] = pos[a3 + 2] + dz * k;
        prev[o] = pos[o]; prev[o + 1] = pos[o + 1]; prev[o + 2] = pos[o + 2];
      }
    }
    // Trailing run: continue forwards along the last live gradient.
    if (last < cols - 1) {
      const a3 = (rowBase + last) * 3;
      const b3 = (rowBase + Math.max(last - 1, first)) * 3;
      const dx = pos[a3] - pos[b3], dy = pos[a3 + 1] - pos[b3 + 1], dz = pos[a3 + 2] - pos[b3 + 2];
      for (let i = last + 1; i < cols; i++) {
        const k = i - last, o = (rowBase + i) * 3;
        pos[o] = pos[a3] + dx * k; pos[o + 1] = pos[a3 + 1] + dy * k; pos[o + 2] = pos[a3 + 2] + dz * k;
        prev[o] = pos[o]; prev[o + 1] = pos[o + 1]; prev[o + 2] = pos[o + 2];
      }
    }
    // Interior gaps: bridge straight between the live ends.
    let i = first;
    while (i < last) {
      if (clothActive[rowBase + i + 1]) { i++; continue; }
      let e = i + 1;
      while (e < last && !clothActive[rowBase + e]) e++;
      const a3 = (rowBase + i) * 3, b3 = (rowBase + e) * 3, span = e - i;
      for (let m = 1; m < span; m++) {
        const f = m / span, o = (rowBase + i + m) * 3;
        pos[o] = pos[a3] + (pos[b3] - pos[a3]) * f;
        pos[o + 1] = pos[a3 + 1] + (pos[b3 + 1] - pos[a3 + 1]) * f;
        pos[o + 2] = pos[a3 + 2] + (pos[b3 + 2] - pos[a3 + 2]) * f;
        prev[o] = pos[o]; prev[o + 1] = pos[o + 1]; prev[o + 2] = pos[o + 2];
      }
      i = e;
    }
  }
}

function simulate(frameDt) {
  // The fixed sim step is SIM_DT (0.02s @ 50 Hz); timeScale < 1 makes the cloth
  // read heavier and larger without changing the step count.
  const dt = clamp(frameDt, 0.004, 0.02) * VK.timeScale;
  const subDt = dt / SUBSTEPS;

  // Ambient wind drift — the mean direction wanders, more so in a storm.
  const driftMax = WEATHER.angleDriftMax;
  const turbNorm = SIM.turbulence / 100;
  if (_loopSimPhase >= 0) {
    const a = _loopSimPhase * Math.PI * 2;
    windAngleDrift = clamp(
      Math.sin(a) * driftMax * 0.36 + Math.sin(a * 2 + 0.7) * driftMax * 0.10, -driftMax, driftMax);
    windAngleVel = 0;
    windStrengthDrift = clamp(
      Math.sin(a + 1.2) * (0.10 + turbNorm * 0.18) + Math.sin(a * 2 - 0.4) * (0.04 + turbNorm * 0.08),
      -0.75, 0.75);
  } else {
    windAngleVel += (Math.random() - 0.5) * dt * (90 * WEATHER.angleDriftForce + driftMax * 4.5);
    windAngleVel += (-windAngleDrift * 0.55) * dt;
    windAngleVel *= Math.exp(-dt * 0.55);
    windAngleDrift = clamp(windAngleDrift + windAngleVel * dt, -driftMax, driftMax);
    windStrengthDrift += (Math.random() - 0.5) * dt * (1.8 + turbNorm * 8.0);
    windStrengthDrift *= Math.exp(-dt * 1.6);
    windStrengthDrift = clamp(windStrengthDrift, -0.75, 0.75);
  }
  // Decay orbit angular velocity (smooth stop after the user releases the mouse)
  orbitAngularVel *= Math.exp(-dt * 1.2);

  const aRad = (SIM.windAngle + windAngleDrift) * Math.PI / 180;
  const wdx = Math.sin(aRad), wdz = Math.cos(aRad);
  const base = windBaseSpeed();
  // Stiffer cloth just gets more constraint passes — the rest lengths never change.
  const itersA = VK.itersA + Math.round((SIM.stiffness - 40) / 100 * 3);

  for (let s = 0; s < SUBSTEPS; s++) {
    simTime += subDt;
    const g = gustEnv(simTime);
    const mag = windMag(simTime, g, base);
    updateSway(subDt, mag, g, wdx, wdz);
    updateWindField(simTime, g, mag, wdx, wdz);
    computeAeroNormals();
    integrate(subDt, wdx, wdz);
    driveAnchors();
    solveConstraints(itersA);
    longRangeAttach();
    // Self-collision once per frame, not per substep: the cloth barely moves
    // between substeps, and it is by far the most expensive pass.
    if (s === SUBSTEPS - 1) selfCollide();
    poleCollide();
    solveConstraints(VK.itersB);
    longRangeAttach();
  }
  extrapolateInactive();
  computeMeshNormals();
}

// ─── Render surface ──────────────────────────────────────────
// Catmull-Rom in u, then in v — the same two-pass bicubic Viking uses. It costs
// one O(N) sweep and buys a silhouette and a shading gradient that a grid this
// coarse could never carry on its own.
function buildRenderSurface() {
  for (let j = 0; j < rows; j++) {
    const rowBase = j * cols;
    for (let rx = 0; rx < RC; rx++) {
      const i = (rx / SUBDIV) | 0, s = rx - i * SUBDIV, o = (j * RC + rx) * 3;
      if (s === 0) {
        const p = (rowBase + i) * 3;
        rowPass[o] = pos[p]; rowPass[o + 1] = pos[p + 1]; rowPass[o + 2] = pos[p + 2];
      } else {
        const w = CRW[s];
        const i0 = (rowBase + Math.max(i - 1, 0)) * 3, i1 = (rowBase + i) * 3;
        const i2 = (rowBase + Math.min(i + 1, cols - 1)) * 3, i3 = (rowBase + Math.min(i + 2, cols - 1)) * 3;
        for (let k = 0; k < 3; k++) {
          rowPass[o + k] = w[0] * pos[i0 + k] + w[1] * pos[i1 + k] + w[2] * pos[i2 + k] + w[3] * pos[i3 + k];
        }
      }
    }
  }
  for (let ry = 0; ry < RR; ry++) {
    const j = (ry / SUBDIV) | 0, s = ry - j * SUBDIV;
    const r0 = Math.max(j - 1, 0) * RC, r1 = j * RC;
    const r2 = Math.min(j + 1, rows - 1) * RC, r3 = Math.min(j + 2, rows - 1) * RC;
    const w = CRW[s];
    for (let rx = 0; rx < RC; rx++) {
      const o = (ry * RC + rx) * 3;
      if (s === 0) {
        const p = (r1 + rx) * 3;
        rPos[o] = rowPass[p]; rPos[o + 1] = rowPass[p + 1]; rPos[o + 2] = rowPass[p + 2];
      } else {
        const i0 = (r0 + rx) * 3, i1 = (r1 + rx) * 3, i2 = (r2 + rx) * 3, i3 = (r3 + rx) * 3;
        for (let k = 0; k < 3; k++) {
          rPos[o + k] = w[0] * rowPass[i0 + k] + w[1] * rowPass[i1 + k] + w[2] * rowPass[i2 + k] + w[3] * rowPass[i3 + k];
        }
      }
    }
  }
  // Normals and a real weft tangent — the crease map and the anisotropic sheen
  // both need to know which way the weave runs.
  for (let ry = 0; ry < RR; ry++) {
    for (let rx = 0; rx < RC; rx++) {
      const o = (ry * RC + rx) * 3;
      const l = (ry * RC + Math.max(rx - 1, 0)) * 3, r = (ry * RC + Math.min(rx + 1, RC - 1)) * 3;
      const u = (Math.max(ry - 1, 0) * RC + rx) * 3, d = (Math.min(ry + 1, RR - 1) * RC + rx) * 3;
      const tx = rPos[r] - rPos[l], ty = rPos[r + 1] - rPos[l + 1], tz = rPos[r + 2] - rPos[l + 2];
      const bx = rPos[d] - rPos[u], by = rPos[d + 1] - rPos[u + 1], bz = rPos[d + 2] - rPos[u + 2];
      let nx = by * tz - bz * ty, ny = bz * tx - bx * tz, nz = bx * ty - by * tx;
      let len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      rNrm[o] = nx / len; rNrm[o + 1] = ny / len; rNrm[o + 2] = nz / len;
      len = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
      rTan[o] = tx / len; rTan[o + 1] = ty / len; rTan[o + 2] = tz / len;
    }
  }
}

// Kept under the original name because every export path calls it to refresh
// the surface after writing straight into pos[].
function computeMeshNormals() {
  computeAeroNormals();
  buildRenderSurface();
}

// ─── Shaders ─────────────────────────────────────────────────

// Background shader (HDRI-style gradient)
const bgVsrc = `
attribute vec2 aP;
varying vec2 vUV;
void main() { vUV = aP * 0.5 + 0.5; gl_Position = vec4(aP, 0.999, 1.0); }`;

const bgFsrc = `
precision highp float;
uniform vec3 uBg;
uniform sampler2D uBgTex;
uniform bool uHasBgTex;
uniform vec4 uBgTexCrop;
uniform float uLightning;
uniform int uSkyMode;
varying vec2 vUV;
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise21(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
void main() {
  vec3 bg = uBg;
  if (uHasBgTex) {
    vec2 tc = vUV * uBgTexCrop.xy + uBgTexCrop.zw;
    bg = texture2D(uBgTex, tc).rgb;
  } else if (uSkyMode == 2) {
    float horizon = smoothstep(0.02, 0.86, vUV.y);
    vec3 skyBase = max(uBg, vec3(0.018, 0.020, 0.030));
    bg = mix(skyBase * 0.74, skyBase * 1.48 + vec3(0.008, 0.010, 0.018), horizon);
    vec2 cell = floor(vUV * vec2(210.0, 118.0));
    vec2 local = fract(vUV * vec2(210.0, 118.0)) - 0.5;
    float seed = hash21(cell);
    float size = mix(0.030, 0.090, hash21(cell + 17.7));
    float star = smoothstep(size, 0.0, length(local));
    star *= step(0.982, seed) * smoothstep(0.08, 0.42, vUV.y);
    bg += vec3(0.68, 0.76, 1.0) * star * mix(0.45, 1.25, hash21(cell + 91.3));
  } else if (uSkyMode == 1) {
    float cloud = noise21(vUV * vec2(4.2, 2.3)) * 0.62
      + noise21(vUV * vec2(12.5, 7.0) + 18.4) * 0.28
      + noise21(vUV * vec2(32.0, 18.0) - 7.1) * 0.10;
    float bank = smoothstep(0.1, 1.0, vUV.y);
    bg = mix(bg * 0.55, vec3(0.018, 0.024, 0.034), bank);
    bg += vec3(0.018, 0.023, 0.032) * cloud * (0.35 + bank * 0.65);
  }
  float flash = clamp(uLightning, 0.0, 1.0);
  bg = mix(bg, vec3(0.86, 0.91, 1.0), flash * 0.78);
  gl_FragColor = vec4(bg, 1.0);
}`;

// Main scene shaders
const vsrc = `
attribute vec3 aPos, aNrm, aTan;
attribute vec2 aUV;
uniform mat4 uProj, uView, uModel;
varying vec3 vNrm, vPos, vLocalPos, vTan;
varying vec2 vUV;
void main() {
  vec4 wp = uModel * vec4(aPos, 1.0);
  vNrm = normalize(mat3(uModel) * aNrm);
  vTan = mat3(uModel) * aTan;
  vPos = wp.xyz;
  vLocalPos = aPos;
  vUV = aUV;
  gl_Position = uProj * uView * wp;
}`;

const fsrc = `
precision highp float;
varying vec3 vNrm, vPos, vLocalPos, vTan;
varying vec2 vUV;
uniform vec3 uLight, uColor, uEye;
uniform sampler2D uTex, uMask, uCrease;
uniform float uFace, uAlpha, uAmbient, uPartyTime, uMatte, uUnlit, uLightning, uMoonSurface;
uniform float uCreaseScale, uSheen, uAniso, uRough, uEnvInt, uSpecInt, uBackTint, uTransl, uExposure;
uniform float uClassic;
uniform bool uHasTex, uIsGlass, uHasMask;
// Narkowicz's fit of the ACES filmic curve — the tone response three.js uses,
// and the reason the satin rolls off into the highlights instead of clipping.
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise21(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
vec3 hsv(float h, float s, float v) {
  vec3 r = clamp(abs(mod(h*6.0+vec3(0,4,2),6.0)-3.0)-1.0,0.0,1.0);
  return v * mix(vec3(1), r, s);
}
void main() {
  vec3 n = normalize(vNrm) * uFace;
  vec3 vd = normalize(uEye - vPos);
  vec3 ld = normalize(uLight);
  vec3 hd = normalize(ld + vd);
  float flash = clamp(uLightning, 0.0, 1.0);

  if (uIsGlass) {
    float pndl = dot(n, ld);
    float pdiff = max(pndl, 0.0) * 0.42;
    float pfill = max(dot(n, normalize(vec3(-0.45, 0.35, -0.65))), 0.0) * 0.15;
    float pback = max(-pndl, 0.0) * 0.10;
    float pspec = pow(max(dot(n, hd), 0.0), 6.0) * 0.05;
    float plight = 0.42 + pdiff + pfill + pback + pspec + flash * 1.45;
    vec3 pc = mix(uColor, vec3(1.0), flash * 0.28);
    if (uPartyTime > 0.0) {
      float t = uPartyTime;
      float strobe = step(0.0, sin(t * 12.0));
      pc = uColor * mix(0.15, 1.8, strobe);
    }
    gl_FragColor = vec4(pc * plight, 1.0);
    return;
  }

  // Custom shape silhouette — sampled in cloth UV space, identical on both
  // faces (no back-face mirror: the mask is geometry, not print). LINEAR
  // filtering on the mask provides the anti-aliased edge; hard discard keeps
  // fully-outside fragments from polluting the depth buffer.
  float m = 1.0;
  if (uHasMask) {
    m = texture2D(uMask, vUV).r;
    if (m < 0.01) discard;
  }

  // Get base color + alpha from texture
  vec3 base = uColor;
  float alpha = uAlpha;
  if (uHasTex) {
    vec2 tc = vUV;
    if (uFace < 0.0) tc.x = 1.0 - tc.x;
    vec4 t = texture2D(uTex, tc);
    base = mix(base, t.rgb, t.a);
    alpha = t.a + uAlpha * (1.0 - t.a);
  }
  // The reverse of a flag is the same cloth seen through it — same print,
  // mirrored and a shade down.
  if (uFace < 0.0 && uUnlit < 0.5) base *= uBackTint;
  if (uMoonSurface > 0.5) {
    float dust = noise21(vLocalPos.xz * 12.0) * 0.55 + noise21(vLocalPos.xz * 46.0 + 31.7) * 0.45;
    vec2 craterCell = floor(vLocalPos.xz * 0.95);
    vec2 craterLocal = fract(vLocalPos.xz * 0.95) - 0.5;
    float craterSeed = hash21(craterCell);
    float craterR = mix(0.10, 0.26, hash21(craterCell + 8.2));
    float craterRing = 1.0 - smoothstep(0.012, 0.055, abs(length(craterLocal) - craterR));
    craterRing *= step(0.83, craterSeed);
    float craterShade = smoothstep(craterR, 0.0, length(craterLocal)) * step(0.83, craterSeed);
    base *= 0.78 + dust * 0.28 + craterRing * 0.14 - craterShade * 0.16;
    base = clamp(base, vec3(0.0), vec3(1.0));
  }

  // Party mode: black/white strobe flash
  if (uPartyTime > 0.0) {
    float t = uPartyTime;
    float strobe = step(0.0, sin(t * 12.0));
    vec3 lit = base * mix(0.02, 2.2, strobe);
    gl_FragColor = vec4(lit, alpha * m);
    return;
  }

  // Flat panel — no cloth shading at all, so the print reproduces the texture
  // colours 1:1 (true WYSIWYG poster). Without this the head-on diffuse term
  // (~0.55) darkens every colour, e.g. #B52C3A reds turn maroon.
  if (uUnlit > 0.5) {
    gl_FragColor = vec4(base, alpha * m);
    return;
  }

  // ── Classic ──
  // The pre-rebuild shading model, kept so the older look stays reachable.
  // Every term is summed in sRGB with no tone curve, so the albedo is only
  // ever scaled: saturation holds steady across the folds, where the satin
  // path below swings it as the grazing sheen piles on.
  if (uClassic > 0.5) {
    float cndl = dot(n, ld);
    float cem = 1.0 - uMatte;
    float cndv = max(dot(n, vd), 0.0);
    float cndh = max(dot(n, hd), 0.0);
    float clight = uAmbient
      + max(cndl, 0.0) * 0.50
      + max(dot(n, normalize(vec3(-0.45, 0.35, -0.65))), 0.0) * 0.14
      + max(-cndl, 0.0) * 0.20
      + pow(1.0 - cndv, 2.8) * 0.18 * cem
      + pow(cndh, 72.0) * 0.14 * cem
      + pow(cndh, 16.0) * 0.16 * cem
      + pow(cndh, 160.0) * 0.10 * cem;
    float csheen = pow(1.0 - cndv, 4.0) * 0.07 * cem;
    vec3 ctint = mix(vec3(0.84, 0.90, 0.98), vec3(0.98, 0.90, 0.84), vUV.y);
    vec3 clit = base * clight + ctint * csheen;
    clit = mix(clit, base * 2.45 + vec3(0.18, 0.22, 0.32), flash * 0.68);
    gl_FragColor = vec4(clit, alpha * m);
    return;
  }

  // ── Satin ──
  // Physically-shaded heavy cloth, lit the way the Viking sketch is: one warm
  // raking key, a cool studio environment, a broad retroreflective sheen and a
  // little light coming through from behind. Everything above works in sRGB, so
  // the albedo is linearised here and encoded again on the way out.
  vec3 alb = pow(base, vec3(2.2));

  // Tangent frame from the cloth's own weft direction, then the crease map.
  vec3 T = vTan - n * dot(n, vTan);
  float tl = length(T);
  T = tl > 1e-4 ? T / tl : normalize(cross(n, vec3(0.0, 1.0, 0.001)));
  vec3 Bt = cross(n, T);
  vec3 cn = texture2D(uCrease, vUV).xyz * 2.0 - 1.0;
  // uCreaseScale 0 collapses this to n, so no branch is needed.
  vec3 N = normalize(T * (cn.x * uCreaseScale) + Bt * (cn.y * uCreaseScale) + n * cn.z);
  Bt = normalize(cross(N, T));
  T = normalize(cross(Bt, N));

  float NdV = max(dot(N, vd), 1e-4);
  float NdL = max(dot(N, ld), 0.0);

  // Studio box: bright above, neutral at the sides, dark floor.
  vec3 envUp = vec3(1.00, 0.98, 0.94);
  vec3 envSide = vec3(0.55, 0.57, 0.62);
  vec3 envDown = vec3(0.16, 0.15, 0.14);
  float envI = uEnvInt * (uAmbient / 0.38);
  vec3 irr = N.y > 0.0 ? mix(envSide, envUp, N.y) : mix(envSide, envDown, -N.y);

  vec3 keyC = vec3(1.000, 0.945, 0.863);
  vec3 fillC = vec3(1.000, 0.902, 0.800);
  vec3 fillDir = normalize(vec3(0.62, -0.16, -0.47));
  vec3 rimDir = normalize(vec3(0.36, 0.44, -0.87));

  vec3 dif = alb * irr * envI;
  dif += alb * keyC * 1.082 * NdL;
  dif += alb * fillC * 0.089 * max(dot(N, fillDir), 0.0);
  dif += alb * 0.143 * max(dot(N, rimDir), 0.0);
  dif += alb * uTransl * max(dot(-N, ld), 0.0);   // light through the cloth

  // uMatte (0→1) fades every reflective term for a flat, glare-free print
  // surface, leaving the diffuse so the folds still read.
  float em = 1.0 - uMatte;

  // Anisotropic GGX — the highlight smears along the weave rather than
  // pooling. Rotated a quarter turn, so it runs up the height like satin.
  vec3 H = normalize(ld + vd);
  float NdH = max(dot(N, H), 0.0);
  float VdH = max(dot(vd, H), 1e-4);
  float ax = max(uRough * (1.0 + uAniso), 0.02);
  float ay = max(uRough * (1.0 - uAniso), 0.02);
  float th = dot(Bt, H) / ax;
  float bh = dot(T, H) / ay;
  float dd = th * th + bh * bh + NdH * NdH;
  float D = 1.0 / (3.14159265 * ax * ay * max(dd * dd, 1e-6));
  float kg = uRough * uRough * 0.5;
  float G = (NdL / (NdL * (1.0 - kg) + kg)) * (NdV / (NdV * (1.0 - kg) + kg));
  float F = 0.04 + 0.96 * pow(1.0 - VdH, 5.0);
  vec3 spec = keyC * 1.082 * (D * G * F / (4.0 * NdV)) * uSpecInt * em;

  // The broad grazing sheen is what separates satin from paper.
  vec3 sheen = vec3(1.000, 0.941, 0.847) * uSheen * pow(1.0 - NdV, 3.0) * (0.35 + 0.65 * NdL) * em;

  // Blurred environment reflection.
  vec3 R = reflect(-vd, N);
  vec3 envR = R.y > 0.0 ? mix(envSide, envUp, R.y) : mix(envSide, envDown, -R.y);
  float Fv = 0.04 + 0.96 * pow(1.0 - NdV, 5.0);
  vec3 envSpec = envR * envI * Fv * uSpecInt * (1.0 - uRough * 0.7) * em;

  vec3 lin = dif + spec + sheen + envSpec;
  lin = mix(lin, alb * 3.4 + vec3(0.35, 0.42, 0.60), flash * 0.68);
  gl_FragColor = vec4(pow(aces(lin * uExposure), vec3(1.0 / 2.2)), alpha * m);
}`;

// ─── WebGL init ──────────────────────────────────────────────
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl', { antialias: true, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
if (!gl) document.body.innerHTML = '<p style="padding:40px">WebGL not supported</p>';
gl.getExtension('OES_element_index_uint');
const anisoExt = gl.getExtension('EXT_texture_filter_anisotropic')
  || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic')
  || gl.getExtension('MOZ_EXT_texture_filter_anisotropic');
const maxAniso = anisoExt ? gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;
gl.enable(gl.DEPTH_TEST);

function compileShader(src, type) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
  return s;
}
// Background program
const bgProg = gl.createProgram();
gl.attachShader(bgProg, compileShader(bgVsrc, gl.VERTEX_SHADER));
gl.attachShader(bgProg, compileShader(bgFsrc, gl.FRAGMENT_SHADER));
gl.linkProgram(bgProg);
const bgLoc = {
  aP: gl.getAttribLocation(bgProg, 'aP'),
  uBg: gl.getUniformLocation(bgProg, 'uBg'),
  uBgTex: gl.getUniformLocation(bgProg, 'uBgTex'),
  uHasBgTex: gl.getUniformLocation(bgProg, 'uHasBgTex'),
  uBgTexCrop: gl.getUniformLocation(bgProg, 'uBgTexCrop'),
  uLightning: gl.getUniformLocation(bgProg, 'uLightning'),
  uSkyMode: gl.getUniformLocation(bgProg, 'uSkyMode'),
};
const quadBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, 1,1, -1,-1, 1,1, -1,1]), gl.STATIC_DRAW);

// Screen-space lightning bolt program
const boltVsrc = `
attribute vec2 aP;
void main() { gl_Position = vec4(aP, 0.998, 1.0); }`;

const boltFsrc = `
precision mediump float;
uniform vec4 uColor;
void main() { gl_FragColor = uColor; }`;

const boltProg = gl.createProgram();
gl.attachShader(boltProg, compileShader(boltVsrc, gl.VERTEX_SHADER));
gl.attachShader(boltProg, compileShader(boltFsrc, gl.FRAGMENT_SHADER));
gl.linkProgram(boltProg);
const boltLoc = {
  aP: gl.getAttribLocation(boltProg, 'aP'),
  uColor: gl.getUniformLocation(boltProg, 'uColor'),
};
const boltBuf = gl.createBuffer();

// Main scene program
const prog = gl.createProgram();
gl.attachShader(prog, compileShader(vsrc, gl.VERTEX_SHADER));
gl.attachShader(prog, compileShader(fsrc, gl.FRAGMENT_SHADER));
gl.linkProgram(prog); gl.useProgram(prog);

const loc = {};
['aPos', 'aNrm', 'aUV', 'aTan'].forEach(n => loc[n] = gl.getAttribLocation(prog, n));
['uProj', 'uView', 'uModel', 'uLight', 'uColor', 'uEye', 'uTex', 'uFace', 'uAlpha', 'uAmbient', 'uHasTex', 'uIsGlass', 'uPartyTime', 'uMatte', 'uUnlit', 'uMask', 'uHasMask', 'uLightning', 'uMoonSurface',
 'uCrease', 'uCreaseScale', 'uSheen', 'uAniso', 'uRough', 'uEnvInt', 'uSpecInt', 'uBackTint', 'uTransl', 'uExposure', 'uClassic']
  .forEach(n => loc[n] = gl.getUniformLocation(prog, n));

// Satin, matching the Viking material. These never change at runtime, so they
// are set once rather than per draw.
const SATIN = {
  crease: 0.45,   // strength of the baked packaging folds
  backTint: 0.74, // the reverse of the flag, a shade down
  transl: 0.32,   // light carried through the cloth
  // The rest is owned by the light mode below, which overwrites it wholesale.
  classic: 0,
  sheen: 0.18,
  aniso: 0.35,
  rough: 0.58,
  env: 0.45,
  spec: 0.60,
  exposure: 0.68,
};

// Light modes — every entry is a complete set, so switching never leaves a
// value behind from the mode before it.
//
// Satin renders in linear light and lands on an ACES curve, so exposure sets
// where the albedo sits on that curve, not just how bright it is. At 1.0 a
// saturated flag runs up onto the shoulder: #B52C3A read back as (203,40,55)
// instead of (181,44,58), and the sheen at 0.28 washed grazing folds out to a
// pale pink — saturation swung 0.53–0.82 across the cloth where the classic
// model held 0.73–0.76. 0.68 with a 0.18 sheen puts the red channel back on
// 181 and pulls the swing to 0.66–0.84.
const LIGHT_MODES = {
  studio:  { classic: 0, sheen: 0.18, aniso: 0.35, rough: 0.58, env: 0.45, spec: 0.60, exposure: 0.68 },
  soft:    { classic: 0, sheen: 0.10, aniso: 0.20, rough: 0.74, env: 0.62, spec: 0.30, exposure: 0.62 },
  classic: { classic: 1, sheen: 0.18, aniso: 0.35, rough: 0.58, env: 0.45, spec: 0.60, exposure: 0.68 },
};
let lightMode = 'studio';
function applySatinUniforms() {
  gl.useProgram(prog);
  gl.uniform1f(loc.uCreaseScale, SATIN.crease);
  gl.uniform1f(loc.uSheen, SATIN.sheen);
  gl.uniform1f(loc.uAniso, SATIN.aniso);
  gl.uniform1f(loc.uRough, SATIN.rough);
  gl.uniform1f(loc.uEnvInt, SATIN.env);
  gl.uniform1f(loc.uSpecInt, SATIN.spec);
  gl.uniform1f(loc.uBackTint, SATIN.backTint);
  gl.uniform1f(loc.uTransl, SATIN.transl);
  gl.uniform1f(loc.uExposure, SATIN.exposure);
  gl.uniform1f(loc.uClassic, SATIN.classic);
  gl.uniform1i(loc.uCrease, 3);
}

// These live on the program, not the draw call, so setting them once here
// carries into the preview, the export renders and the batch passes alike.
function setLightMode(mode) {
  if (!LIGHT_MODES[mode]) return;
  lightMode = mode;
  Object.assign(SATIN, LIGHT_MODES[mode]);
  applySatinUniforms();
}

// ─── Buffers ─────────────────────────────────────────────────
const posBuf = gl.createBuffer(), nrmBuf = gl.createBuffer();
const uvBuf = gl.createBuffer(), idxBuf = gl.createBuffer(), tanBuf = gl.createBuffer();
let polePosBuf = gl.createBuffer(), poleNrmBuf = gl.createBuffer();
let poleUVBuf = gl.createBuffer(), poleIdxBuf = gl.createBuffer();
let poleIdxCount = 0;
let moonPosBuf = gl.createBuffer(), moonNrmBuf = gl.createBuffer();
let moonUVBuf = gl.createBuffer(), moonIdxBuf = gl.createBuffer();
let moonIdxCount = 0;
const MOON = {
  active: false,
  center: [0, -9.35, 0],
  radius: 9.0,
  color: [0.58, 0.58, 0.55],
  yaw: 0,
  yawTarget: 0,
  autoSpin: 0.075,
  flagScale: 0.54,
  flagYOffset: 0.92,
};

// Everything the shader sees is the subdivided surface, not the sim grid.
function uploadStaticBuffers() {
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.bufferData(gl.ARRAY_BUFFER, rUV, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, rPos.byteLength, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
  gl.bufferData(gl.ARRAY_BUFFER, rNrm.byteLength, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, tanBuf);
  gl.bufferData(gl.ARRAY_BUFFER, rTan.byteLength, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, rIndexData, gl.STATIC_DRAW);
}

// One place that binds the cloth for drawing — the live view, the FBO preview
// and the still exporter all go through it.
function bindClothBuffers() {
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, rPos);
  gl.enableVertexAttribArray(loc.aPos);
  gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, rNrm);
  gl.enableVertexAttribArray(loc.aNrm);
  gl.vertexAttribPointer(loc.aNrm, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, tanBuf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, rTan);
  gl.enableVertexAttribArray(loc.aTan);
  gl.vertexAttribPointer(loc.aTan, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.enableVertexAttribArray(loc.aUV);
  gl.vertexAttribPointer(loc.aUV, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
}

// Cloth is double-sided: back faces first so the front overwrites where they meet.
function drawCloth(count) {
  gl.enable(gl.CULL_FACE);
  gl.uniform1f(loc.uFace, -1.0);
  gl.cullFace(gl.FRONT);
  gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, 0);
  gl.uniform1f(loc.uFace, 1.0);
  gl.cullFace(gl.BACK);
  gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, 0);
  gl.disable(gl.CULL_FACE);
}
uploadStaticBuffers();

// ─── Pole mesh ───────────────────────────────────────────────
// The mast is not a stick: it carries the same bend the sim drives the anchors
// with, so the pole and the cloth move as one rig.
let poleRest = null, polePos = null;
function updatePoleMesh() {
  if (!poleRest) return;
  const sx = sway.x, sz = sway.z;
  for (let i = 0; i < poleRest.length; i += 3) {
    const k = bendAt(poleRest[i + 1]);
    polePos[i] = poleRest[i] + sx * k;
    polePos[i + 1] = poleRest[i + 1];
    polePos[i + 2] = poleRest[i + 2] + sz * k;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, polePosBuf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, polePos);
}

function buildPole() {
  const r = POLE_RADIUS;
  const seg = POLE_SEGMENTS;
  const overhang = 0.15;
  // Flag top is at flagH * 0.8, bottom at flagH * 0.8 - flagH = -flagH * 0.2
  const flagTop = flagH * 0.8;
  const yTop = flagTop + overhang;
  const yBot = -Math.max(flagH * 4, 12.0); // extend far down so pole always reaches below viewport
  const finialR = r * 2.0;

  const positions = [], normals = [], uvs = [], indices = [];

  // Cylinder body. The mast runs far below the viewport for framing but only
  // bends over its top few units, so the rings are packed toward the tip —
  // that is the part on screen, and the part the sway has to curve smoothly.
  const cylRings = 32;
  for (let ring = 0; ring <= cylRings; ring++) {
    const t = ring / cylRings;
    const f = 1 - t;
    const y = yTop - (yTop - yBot) * f * f;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const nx = Math.cos(a), nz = Math.sin(a);
      positions.push(nx * r, y, nz * r);
      normals.push(nx, 0, nz);
      uvs.push(i / seg, t);
    }
  }
  for (let ring = 0; ring < cylRings; ring++) {
    for (let i = 0; i < seg; i++) {
      const a = ring * (seg + 1) + i;
      const b = a + 1;
      const c = a + seg + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  // Top cap
  let ci = positions.length / 3;
  positions.push(0, yTop, 0); normals.push(0, 1, 0); uvs.push(0.5, 0.5);
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    positions.push(Math.cos(a) * r, yTop, Math.sin(a) * r);
    normals.push(0, 1, 0); uvs.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
  }
  for (let i = 0; i < seg; i++) indices.push(ci, ci + 1 + i + 1, ci + 1 + i);

  // Ball finial. It is small but it is the one round thing on screen, so it
  // needs the density — 16 segments showed its facets on a large display.
  const ballSegs = 48, ballRings = 32;
  const ballY = yTop + finialR * 0.6;
  const bb = positions.length / 3;
  for (let lat = 0; lat <= ballRings; lat++) {
    const theta = (lat / ballRings) * Math.PI;
    const sinT = Math.sin(theta), cosT = Math.cos(theta);
    for (let lon = 0; lon <= ballSegs; lon++) {
      const phi = (lon / ballSegs) * Math.PI * 2;
      const nx = sinT * Math.cos(phi), ny = cosT, nz = sinT * Math.sin(phi);
      positions.push(nx * finialR, ballY + ny * finialR, nz * finialR);
      normals.push(nx, ny, nz);
      uvs.push(lon / ballSegs, lat / ballRings);
    }
  }
  for (let lat = 0; lat < ballRings; lat++) {
    for (let lon = 0; lon < ballSegs; lon++) {
      const a = bb + lat * (ballSegs + 1) + lon;
      indices.push(a, a + ballSegs + 1, a + 1, a + 1, a + ballSegs + 1, a + ballSegs + 2);
    }
  }

  poleIdxCount = indices.length;
  poleRest = new Float32Array(positions);
  polePos = new Float32Array(positions);
  gl.bindBuffer(gl.ARRAY_BUFFER, polePosBuf);
  gl.bufferData(gl.ARRAY_BUFFER, polePos, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, poleNrmBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normals), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, poleUVBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uvs), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, poleIdxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(indices), gl.STATIC_DRAW);
}

function buildMoonSphere() {
  const latBands = 96;
  const lonBands = 144;
  const positions = [], normals = [], uvs = [], indices = [];
  const c = MOON.center;
  const r = MOON.radius;
  for (let lat = 0; lat <= latBands; lat++) {
    const theta = (lat / latBands) * Math.PI;
    const sinT = Math.sin(theta), cosT = Math.cos(theta);
    for (let lon = 0; lon <= lonBands; lon++) {
      const phi = (lon / lonBands) * Math.PI * 2;
      const nx = sinT * Math.cos(phi);
      const ny = cosT;
      const nz = sinT * Math.sin(phi);
      const relief = 1 + fbm2(lon * 0.22, lat * 0.31) * 0.010
        + fbm2(lon * 0.71 + 11.7, lat * 0.67 - 4.3) * 0.005;
      positions.push(c[0] + nx * r * relief, c[1] + ny * r * relief, c[2] + nz * r * relief);
      normals.push(nx, ny, nz);
      uvs.push(lon / lonBands, lat / latBands);
    }
  }
  for (let lat = 0; lat < latBands; lat++) {
    for (let lon = 0; lon < lonBands; lon++) {
      const a = lat * (lonBands + 1) + lon;
      const b = a + lonBands + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  moonIdxCount = indices.length;
  gl.bindBuffer(gl.ARRAY_BUFFER, moonPosBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, moonNrmBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normals), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, moonUVBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uvs), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, moonIdxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(indices), gl.STATIC_DRAW);
}
buildPole();
buildMoonSphere();

// ─── Texture ─────────────────────────────────────────────────
let flagTex = null, hasTex = false;
let flagTexW = 0, flagTexH = 0;

function loadTexture(source) {
  if (flagTex) gl.deleteTexture(flagTex);
  flagTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, flagTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  if (anisoExt) gl.texParameterf(gl.TEXTURE_2D, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(maxAniso, 8));
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  flagTexW = source.width || source.videoWidth || 0;
  flagTexH = source.height || source.videoHeight || 0;
  hasTex = true;
}

function removeTexture() {
  if (flagTex) { gl.deleteTexture(flagTex); flagTex = null; }
  flagTexW = 0;
  flagTexH = 0;
  hasTex = false;
}

function updateTexturePixels(source) {
  const w = source.width || source.videoWidth || 0;
  const h = source.height || source.videoHeight || 0;
  if (!w || !h) return;
  if (!flagTex || !hasTex || flagTexW !== w || flagTexH !== h) {
    loadTexture(source);
    return;
  }
  gl.bindTexture(gl.TEXTURE_2D, flagTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
}

const BG_MEDIA_TEXTURE_MAX_DIM = 1920;
let bgMode = 'color';
let bgTex = null, bgTexW = 0, bgTexH = 0;
let bgImage = null, bgObjUrl = null;
let bgImageDirty = false;
const bgVideo = document.createElement('video');
bgVideo.muted = true;
bgVideo.loop = true;
bgVideo.playsInline = true;
const bgCanvas = document.createElement('canvas');
const bgCtx = bgCanvas.getContext('2d');

function clearBgTexture() {
  if (bgTex) { gl.deleteTexture(bgTex); bgTex = null; }
  bgTexW = 0;
  bgTexH = 0;
}

function setBgTextureFromSource(source) {
  const sourceW = source.videoWidth || source.naturalWidth || source.width || 0;
  const sourceH = source.videoHeight || source.naturalHeight || source.height || 0;
  if (!sourceW || !sourceH) return false;
  const scale = Math.min(1, BG_MEDIA_TEXTURE_MAX_DIM / Math.max(sourceW, sourceH));
  const w = Math.max(2, Math.round(sourceW * scale));
  const h = Math.max(2, Math.round(sourceH * scale));
  if (bgCanvas.width !== w || bgCanvas.height !== h) {
    bgCanvas.width = w;
    bgCanvas.height = h;
  }
  bgCtx.drawImage(source, 0, 0, w, h);
  if (!bgTex) {
    bgTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, bgTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  } else {
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, bgTex);
  }
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  if (bgTexW !== w || bgTexH !== h) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bgCanvas);
    bgTexW = w;
    bgTexH = h;
  } else {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bgCanvas);
  }
  gl.activeTexture(gl.TEXTURE0);
  return true;
}

function updateBackgroundMediaTexture() {
  if (bgMode === 'picture' && bgImage && bgImageDirty) {
    bgImageDirty = false;
    setBgTextureFromSource(bgImage);
  }
  else if (bgMode === 'video' && bgVideo.readyState >= 2) setBgTextureFromSource(bgVideo);
}

function drawBackgroundQuad(drawW, drawH) {
  updateBackgroundMediaTexture();
  gl.useProgram(bgProg);
  gl.uniform3f(bgLoc.uBg, SIM.bgColor[0], SIM.bgColor[1], SIM.bgColor[2]);
  gl.uniform1f(bgLoc.uLightning, lightningValue());
  gl.uniform1i(bgLoc.uSkyMode, MOON.active ? 2 : LIGHTNING.active ? 1 : 0);
  if (bgMode !== 'color' && bgTex && bgTexW > 0 && bgTexH > 0) {
    const sourceAsp = bgTexW / bgTexH;
    const drawAsp = Math.max(1, drawW) / Math.max(1, drawH);
    let cropX = 1, cropY = 1;
    if (sourceAsp > drawAsp) cropX = drawAsp / sourceAsp;
    else cropY = sourceAsp / drawAsp;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, bgTex);
    gl.uniform1i(bgLoc.uBgTex, 2);
    gl.uniform1i(bgLoc.uHasBgTex, 1);
    gl.uniform4f(bgLoc.uBgTexCrop, cropX, cropY, (1 - cropX) * 0.5, (1 - cropY) * 0.5);
    gl.activeTexture(gl.TEXTURE0);
  } else {
    gl.uniform1i(bgLoc.uHasBgTex, 0);
    gl.uniform4f(bgLoc.uBgTexCrop, 1, 1, 0, 0);
  }
  gl.disableVertexAttribArray(loc.aNrm); // avoid leftover state
  gl.disableVertexAttribArray(loc.aUV);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.enableVertexAttribArray(bgLoc.aP);
  gl.vertexAttribPointer(bgLoc.aP, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.disableVertexAttribArray(bgLoc.aP);
}

// ─── Crease map ──────────────────────────────────────────────
// A static tangent-space normal map: a handful of soft packaging folds plus
// low-frequency unevenness in the weave. It is what stops a flat-lit stretch of
// cloth from reading as plastic, and it costs nothing at runtime.
let creaseTex = null;
function buildCreaseMap() {
  const W = 512, H = Math.max(64, Math.round(W * flagH / flagW));
  const hgt = new Float32Array(W * H);
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const folds = [];
  for (let i = 0; i < 7; i++) {
    const ang = (i % 2 === 0 ? Math.PI / 2 : 0) + (rnd() - 0.5) * 0.25;
    folds.push({
      x: rnd() * W, y: rnd() * H,
      nx: Math.cos(ang), ny: Math.sin(ang),
      w: (6 + rnd() * 14) * (W / 1024),
      a: (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.5),
    });
  }
  const P = 64, grid = new Float32Array(P * P);
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const g00 = grid[(yi % P) * P + (xi % P)], g10 = grid[(yi % P) * P + ((xi + 1) % P)];
    const g01 = grid[((yi + 1) % P) * P + (xi % P)], g11 = grid[((yi + 1) % P) * P + ((xi + 1) % P)];
    return (g00 * (1 - sx) + g10 * sx) * (1 - sy) + (g01 * (1 - sx) + g11 * sx) * sy;
  };
  const ns = W / 1024;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (const f of folds) {
        const t = ((x - f.x) * f.nx + (y - f.y) * f.ny) / f.w;
        v += f.a * Math.exp(-t * t) * 0.35;
      }
      v += (noise(x / (140 * ns), y / (140 * ns)) - 0.5) * 0.6
         + (noise(x / (38 * ns) + 9, y / (38 * ns) + 5) - 0.5) * 0.25;
      hgt[y * W + x] = v;
    }
  }
  // Height → tangent-space normal. Tangent = +u, bitangent = +v (v runs down).
  const px = new Uint8Array(W * H * 4);
  const S = 14.0 * ns;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const xl = hgt[y * W + Math.max(x - 1, 0)], xr = hgt[y * W + Math.min(x + 1, W - 1)];
      const yu = hgt[Math.max(y - 1, 0) * W + x], yd = hgt[Math.min(y + 1, H - 1) * W + x];
      let nx = -(xr - xl) * 0.5 * S, ny = (yd - yu) * 0.5 * S, nz = 1;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const o = (y * W + x) * 4;
      px[o] = Math.round((nx / len * 0.5 + 0.5) * 255);
      px[o + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
      px[o + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
      px[o + 3] = 255;
    }
  }
  if (!creaseTex) creaseTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, creaseTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  // No mipmaps: the shader samples it inside branch-free code and the folds are
  // low-frequency anyway.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.activeTexture(gl.TEXTURE0);
}
// The fold pattern is baked at the current aspect, so a ratio change needs a
// repaint — but only once the ratio has settled, not on every tween frame.
let _creaseRaf = null;
function queueCreaseRebuild() {
  if (_creaseRaf) cancelAnimationFrame(_creaseRaf);
  _creaseRaf = requestAnimationFrame(() => { _creaseRaf = null; buildCreaseMap(); });
}

// ─── Shape mask texture (custom silhouette) ──────────────────
// 1×1 white fallback keeps the uMask sampler valid when no shape is active.
const whiteTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, whiteTex);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
  new Uint8Array([255, 255, 255, 255]));

let maskTex = null;
const maskCanvas = document.createElement('canvas');

function buildMaskTexture() {
  if (!shapePoints) {
    if (maskTex) { gl.deleteTexture(maskTex); maskTex = null; }
    return;
  }
  // 1024 on the longest side is plenty — the mask is a hard-edged polygon and
  // LINEAR filtering supplies the anti-aliasing.
  const MAX = 1024;
  let mw, mh;
  if (aspectW >= aspectH) { mw = MAX; mh = Math.max(2, Math.round(MAX * aspectH / aspectW)); }
  else { mh = MAX; mw = Math.max(2, Math.round(MAX * aspectW / aspectH)); }
  maskCanvas.width = mw; maskCanvas.height = mh;
  const mctx = maskCanvas.getContext('2d');
  mctx.fillStyle = '#000';
  mctx.fillRect(0, 0, mw, mh);
  mctx.fillStyle = '#fff';
  mctx.beginPath();
  for (let i = 0; i < shapePoints.length; i++) {
    const p = shapePoints[i];
    if (i === 0) mctx.moveTo(p[0] * mw, p[1] * mh);
    else mctx.lineTo(p[0] * mw, p[1] * mh);
  }
  mctx.closePath();
  mctx.fill('evenodd');
  if (!maskTex) maskTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, maskTex);
  // NPOT texture in WebGL1: clamp to edge, no mipmaps
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
  gl.activeTexture(gl.TEXTURE0);
}

// Bind mask state for the cloth draws (texture unit 1).
function setMaskUniforms(on) {
  const use = !!(on && maskTex);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, use ? maskTex : whiteTex);
  gl.activeTexture(gl.TEXTURE0);
  gl.uniform1i(loc.uMask, 1);
  gl.uniform1i(loc.uHasMask, use ? 1 : 0);
}

// ─── Custom shape application ────────────────────────────────
// Newly re-activated particles sat parked at stale lattice spots; clone the
// state of the nearest previously-live grid neighbor so they join the cloth
// without a visible snap.
function reseedNewParticles(oldActive) {
  if (!oldActive) return;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      if (oldActive[idx] || (clothActive && !clothActive[idx])) continue;
      let src = -1;
      for (let d = 1; d <= 4 && src < 0; d++) {
        if (i - d >= 0 && oldActive[idx - d]) src = idx - d;
        else if (i + d < cols && oldActive[idx + d]) src = idx + d;
        else if (j - d >= 0 && oldActive[idx - d * cols]) src = idx - d * cols;
        else if (j + d < rows && oldActive[idx + d * cols]) src = idx + d * cols;
      }
      const i3 = idx * 3;
      if (src >= 0) {
        const s3 = src * 3;
        pos[i3] = pos[s3]; pos[i3 + 1] = pos[s3 + 1]; pos[i3 + 2] = pos[s3 + 2];
        prev[i3] = prev[s3]; prev[i3 + 1] = prev[s3 + 1]; prev[i3 + 2] = prev[s3 + 2];
      } else {
        const u = i / (cols - 1), v = j / (rows - 1);
        pos[i3] = prev[i3] = u * flagW;
        pos[i3 + 1] = prev[i3 + 1] = -v * flagH + flagH * 0.8;
        pos[i3 + 2] = prev[i3 + 2] = 0;
      }
    }
  }
}

function applyShape(finalize = true) {
  const oldActive = clothActive;
  if (!computeActiveMask()) {
    // Degenerate polygon. Mid-drag (finalize=false): keep simulating the last
    // valid shape and let the user drag back. On release: revert for real.
    if (!finalize) return;
    shapePoints = _lastValidShape ? _lastValidShape.map(p => p.slice()) : null;
    computeActiveMask();
  } else {
    _lastValidShape = shapePoints ? shapePoints.map(p => p.slice()) : null;
  }
  buildMesh();
  reseedNewParticles(oldActive);
  computeMeshNormals();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, rIndexData, gl.STATIC_DRAW);
  buildMaskTexture();
}

let _shapeRaf = null;
function queueApplyShape() {
  if (_shapeRaf) return;
  _shapeRaf = requestAnimationFrame(() => { _shapeRaf = null; applyShape(false); });
}

// Drop shape state without rebuilding — fullRebuild() re-creates the whole
// grid right after, so only the mask + UI need clearing here.
function clearShapeState() {
  shapePoints = null;
  _lastValidShape = null;
  clothActive = null;
  cellActive = null;
  if (maskTex) { gl.deleteTexture(maskTex); maskTex = null; }
  updateShapeUI();
}

function resetShape() {
  shapePoints = null;
  _lastValidShape = null;
  applyShape();
  updateShapeUI();
}

// ─── Matrix utilities ────────────────────────────────────────
function perspective(fov, asp, near, far) {
  const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
  return new Float32Array([
    f / asp, 0, 0, 0, 0, f, 0, 0,
    0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0,
  ]);
}

function lookAt(e, t, u) {
  let zx = e[0] - t[0], zy = e[1] - t[1], zz = e[2] - t[2];
  let l = Math.sqrt(zx * zx + zy * zy + zz * zz);
  if (l < 1e-6) l = 1e-6;
  const z = [zx / l, zy / l, zz / l];
  let xx = u[1] * z[2] - u[2] * z[1], xy = u[2] * z[0] - u[0] * z[2], xz = u[0] * z[1] - u[1] * z[0];
  l = Math.sqrt(xx * xx + xy * xy + xz * xz);
  if (l < 1e-6) l = 1e-6;
  const x = [xx / l, xy / l, xz / l];
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return new Float32Array([
    x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -(x[0] * e[0] + x[1] * e[1] + x[2] * e[2]),
    -(y[0] * e[0] + y[1] * e[1] + y[2] * e[2]),
    -(z[0] * e[0] + z[1] * e[1] + z[2] * e[2]), 1,
  ]);
}

const MODEL_IDENTITY = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);
const MODEL_SCRATCH = new Float32Array(16);

function yRotationScaleModel(yaw, scale = 1, yOffset = 0) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  MODEL_SCRATCH[0] = c * scale;  MODEL_SCRATCH[1] = 0;      MODEL_SCRATCH[2] = -s * scale; MODEL_SCRATCH[3] = 0;
  MODEL_SCRATCH[4] = 0;          MODEL_SCRATCH[5] = scale;  MODEL_SCRATCH[6] = 0;          MODEL_SCRATCH[7] = 0;
  MODEL_SCRATCH[8] = s * scale;  MODEL_SCRATCH[9] = 0;      MODEL_SCRATCH[10] = c * scale; MODEL_SCRATCH[11] = 0;
  MODEL_SCRATCH[12] = 0;         MODEL_SCRATCH[13] = yOffset; MODEL_SCRATCH[14] = 0;       MODEL_SCRATCH[15] = 1;
  return MODEL_SCRATCH;
}

function moonSceneModel(scale = 1, yOffset = 0) {
  return MOON.active ? yRotationScaleModel(MOON.yaw, scale, yOffset) : MODEL_IDENTITY;
}

function moonFlagModel() {
  return moonSceneModel(MOON.flagScale, MOON.flagYOffset);
}

function setModelMatrix(mat) {
  gl.uniformMatrix4fv(loc.uModel, false, mat || MODEL_IDENTITY);
}

// ─── Camera (orbit + pan + zoom + roll) ──────────────────────
let showPole = true; // hidden in Export tab + all recordings
let poleColorOverride = null;
const cam = {
  tgtTheta: 0.0, tgtPhi: 0.12, tgtDist: 5,
  curTheta: 0.0, curPhi: 0.12, curDist: 5,
  tgtRoll: 0.0, roll: 0.0,
  tgtTarget: [0, 0, 0],
  target: [0, 0, 0],
};
let sceneViewMode = 'default';

const LIGHTNING = {
  active: false,
  intensity: 0,
  next: 0,
  burst: 0,
  bolts: [],
};

function setLightningActive(active) {
  LIGHTNING.active = active;
  LIGHTNING.intensity = active ? 0.12 : 0;
  LIGHTNING.next = active ? 0.12 : 0;
  LIGHTNING.burst = 0;
  LIGHTNING.bolts = [];
}

function updateLightning(dt) {
  if (!LIGHTNING.active) {
    LIGHTNING.intensity = 0;
    LIGHTNING.bolts = [];
    return;
  }
  for (const bolt of LIGHTNING.bolts) bolt.age += dt;
  LIGHTNING.bolts = LIGHTNING.bolts.filter(bolt => bolt.age < bolt.life);
  LIGHTNING.next -= dt;
  if (LIGHTNING.next <= 0) {
    LIGHTNING.intensity = Math.max(LIGHTNING.intensity, 0.72 + Math.random() * 0.38);
    LIGHTNING.bolts.push(createLightningBolt());
    if (Math.random() < 0.34) LIGHTNING.bolts.push(createLightningBolt());
    if (LIGHTNING.bolts.length > 6) LIGHTNING.bolts.splice(0, LIGHTNING.bolts.length - 6);
    if (LIGHTNING.burst > 0) {
      LIGHTNING.burst--;
      LIGHTNING.next = 0.05 + Math.random() * 0.11;
    } else {
      LIGHTNING.burst = Math.random() < 0.58 ? 1 + Math.floor(Math.random() * 2) : 0;
      LIGHTNING.next = 0.45 + Math.random() * 1.35;
    }
  }
  LIGHTNING.intensity *= Math.exp(-dt * 11.5);
}

function lightningValue() {
  return clamp(LIGHTNING.intensity, 0, 1);
}

function midpointBoltPath(a, b, depth, displacement) {
  if (depth <= 0) return [a, b];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const bend = (Math.random() - 0.5) * displacement;
  const drift = (Math.random() - 0.5) * displacement * 0.35;
  const mid = {
    x: (a.x + b.x) * 0.5 + (-dy / len) * bend + dx * drift,
    y: (a.y + b.y) * 0.5 + ( dx / len) * bend + dy * drift,
  };
  const left = midpointBoltPath(a, mid, depth - 1, displacement * 0.58);
  const right = midpointBoltPath(mid, b, depth - 1, displacement * 0.58);
  return left.slice(0, -1).concat(right);
}

function createLightningBolt() {
  const start = { x: -0.82 + Math.random() * 1.64, y: 1.08 };
  const end = {
    x: clamp(start.x + (Math.random() - 0.5) * 0.92, -0.92, 0.92),
    y: -0.22 - Math.random() * 0.58,
  };
  const points = midpointBoltPath(start, end, 6, 0.42);
  const branches = [];
  for (let i = 4; i < points.length - 4; i += 3 + Math.floor(Math.random() * 4)) {
    if (Math.random() > 0.38) continue;
    const p = points[i];
    const q = points[Math.min(points.length - 1, i + 1)];
    const dir = { x: q.x - p.x, y: q.y - p.y };
    const side = Math.random() < 0.5 ? -1 : 1;
    const len = 0.16 + Math.random() * 0.34;
    const tip = {
      x: clamp(p.x + (-dir.y * 1.8 + dir.x * 0.25) * side + (Math.random() - 0.5) * len, -1.06, 1.06),
      y: clamp(p.y + ( dir.x * 1.8 + dir.y * 0.25) * side - Math.random() * len * 0.55, -1.0, 1.05),
    };
    branches.push(midpointBoltPath(p, tip, 4, 0.16));
  }
  return {
    points,
    branches,
    age: 0,
    life: 0.26 + Math.random() * 0.14,
  };
}

function rotateMoonScene(delta) {
  if (!MOON.active) return;
  MOON.yawTarget += delta;
}

function updateMoonScene(dt) {
  if (!MOON.active) return;
  const activeDrag = orbiting || (typeof orbitDragging !== 'undefined' && orbitDragging);
  if (!activeDrag) MOON.yawTarget += MOON.autoSpin * dt;
  const lf = 1 - Math.pow(0.0008, dt);
  MOON.yaw += (MOON.yawTarget - MOON.yaw) * lf;
}

function applySceneFrameDistance() {
  if (sceneViewMode === 'storm') {
    cam.tgtDist = clamp(Math.max(cam.tgtDist * 1.28, 5.8), 1.5, 20.0);
  } else if (sceneViewMode === 'moon') {
    cam.tgtDist = clamp(Math.max(cam.tgtDist * 1.85, 9.4), 1.5, 20.0);
  }
}

// Up vector rolled around the view axis (Rodrigues; world-up = [0,1,0])
function rolledUp(eye, target, roll) {
  let fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2];
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;
  const c = Math.cos(roll), s = Math.sin(roll);
  // u = [0,1,0]; f × u = (fz, 0, -fx); f · u = fy
  const cx = fz, cy = 0, cz = -fx;
  const d = fy;
  return [
    0 * c + cx * s + fx * d * (1 - c),
    1 * c + cy * s + fy * d * (1 - c),
    0 * c + cz * s + fz * d * (1 - c),
  ];
}

function eyePos() {
  return [
    cam.target[0] + cam.curDist * Math.cos(cam.curPhi) * Math.sin(cam.curTheta),
    cam.target[1] + cam.curDist * Math.sin(cam.curPhi),
    cam.target[2] + cam.curDist * Math.cos(cam.curPhi) * Math.cos(cam.curTheta),
  ];
}

function autoFrame() {
  const fov = Math.PI / 4.5;
  const halfTan = Math.tan(fov / 2);
  const aspect = Math.max(canvas.width / Math.max(canvas.height, 1), 0.25);
  // Fit the full flag+pole in view (flag shifted up by 0.2*flagH)
  const totalH = flagH * 1.5;
  const fitHalf = Math.max(totalH * 0.55, (flagW * 0.65) / aspect);
  cam.tgtDist = clamp((fitHalf / halfTan) * 1.32, 1.5, 20.0);
  applySceneFrameDistance();
}

function updateCamera(dt) {
  const lf = 1 - Math.pow(0.0004, dt);
  // Apply spinning momentum — flag keeps rotating after flick.
  // Skip while actively dragging (canvas orbit or orbit ball) since those
  // paths drive tgtTheta directly; otherwise we'd double-integrate.
  const actDrag = orbiting || (typeof orbitDragging !== 'undefined' && orbitDragging);
  if (!MOON.active && !actDrag && Math.abs(orbitAngularVel) > 0.05) {
    cam.tgtTheta += orbitAngularVel * dt;
  }
  cam.curTheta += (cam.tgtTheta - cam.curTheta) * lf;
  cam.curPhi += (cam.tgtPhi - cam.curPhi) * lf;
  cam.curDist += (cam.tgtDist - cam.curDist) * lf;
  cam.roll += (cam.tgtRoll - cam.roll) * lf;
  cam.tgtPhi = clamp(cam.tgtPhi, -1.45, 1.45);
  cam.target[0] += (cam.tgtTarget[0] - cam.target[0]) * lf;
  cam.target[1] += (cam.tgtTarget[1] - cam.target[1]) * lf;
  cam.target[2] += (cam.tgtTarget[2] - cam.target[2]) * lf;
}

function panCamera(dx, dy) {
  const r = [Math.cos(cam.curTheta), 0, -Math.sin(cam.curTheta)];
  const sp = Math.sin(cam.curPhi), cp = Math.cos(cam.curPhi);
  const u = [-sp * Math.sin(cam.curTheta), cp, -sp * Math.cos(cam.curTheta)];
  const scale = cam.curDist * 0.002;
  cam.tgtTarget[0] += (-r[0] * dx + u[0] * dy) * scale;
  cam.tgtTarget[1] += (-r[1] * dx + u[1] * dy) * scale;
  cam.tgtTarget[2] += (-r[2] * dx + u[2] * dy) * scale;
}

// Camera controls: left-drag orbit, right-drag pan, scroll zoom
let orbiting = false, panning = false, lastM = [0, 0];
let orbitAngularVel = 0; // track orbit speed for centrifugal force
let touchMode = 'none', touchCenter = [0, 0], touchDist = 0;

canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('mousedown', e => {
  if (e.button === 0) {
    if (MOON.active) orbiting = true;
    else panning = true;
    lastM = [e.clientX, e.clientY];
    e.preventDefault();
  }
  else if (e.button === 2) { orbiting = true; lastM = [e.clientX, e.clientY]; e.preventDefault(); }
});
window.addEventListener('mouseup', () => { orbiting = false; panning = false; });
window.addEventListener('mousemove', e => {
  const dx = e.clientX - lastM[0], dy = e.clientY - lastM[1];
  if (panning) {
    panCamera(dx, dy);
  } else if (orbiting) {
    const thetaDelta = -dx * 0.006;
    if (MOON.active) {
      rotateMoonScene(-thetaDelta);
      orbitAngularVel = thetaDelta / 0.016;
    } else {
      cam.tgtTheta += thetaDelta;
      cam.tgtPhi = clamp(cam.tgtPhi + dy * 0.005, -1.45, 1.45);
      orbitAngularVel = thetaDelta / 0.016;
    }
  } else { return; }
  lastM = [e.clientX, e.clientY];
});
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const speed = (e.ctrlKey || e.metaKey) ? 0.003 : 0.0015;
  cam.tgtDist = clamp(cam.tgtDist * Math.exp(e.deltaY * speed), 1.0, 20);
}, { passive: false });

// Arrow keys: bank/roll the camera (like a plane).
// Shift+Arrow → snap to 0 / ±90° / 180°
window.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea') || e.target.isContentEditable) return;
  const step = e.shiftKey ? Math.PI / 2 : 0.06;
  if (e.key === 'ArrowLeft') {
    cam.tgtRoll -= step;
    e.preventDefault();
  } else if (e.key === 'ArrowRight') {
    cam.tgtRoll += step;
    e.preventDefault();
  } else if (e.key === 'ArrowDown') {
    cam.tgtRoll = 0; // reset bank
    e.preventDefault();
  }
});

// Touch: 1-finger orbit, 2-finger pinch+pan
canvas.addEventListener('touchstart', e => {
  if (e.touches.length === 1) {
    touchMode = 'orbit';
    lastM = [e.touches[0].clientX, e.touches[0].clientY];
  } else if (e.touches.length >= 2) {
    touchMode = 'zoom';
    touchDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    touchCenter = [
      (e.touches[0].clientX + e.touches[1].clientX) / 2,
      (e.touches[0].clientY + e.touches[1].clientY) / 2,
    ];
  }
  e.preventDefault();
}, { passive: false });
canvas.addEventListener('touchmove', e => {
  if (touchMode === 'orbit' && e.touches.length === 1) {
    const dx = e.touches[0].clientX - lastM[0], dy = e.touches[0].clientY - lastM[1];
    const thetaDelta = -dx * 0.006;
    if (MOON.active) {
      rotateMoonScene(-thetaDelta);
      orbitAngularVel = thetaDelta / 0.016;
    } else {
      cam.tgtTheta += thetaDelta;
      cam.tgtPhi = clamp(cam.tgtPhi + dy * 0.005, -1.45, 1.45);
      orbitAngularVel = thetaDelta / 0.016;
    }
    lastM = [e.touches[0].clientX, e.touches[0].clientY];
    e.preventDefault();
  } else if (touchMode === 'zoom' && e.touches.length >= 2) {
    const dist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    cam.tgtDist = clamp(cam.tgtDist * Math.exp((touchDist - dist) * 0.004), 1.0, 20);
    touchDist = dist;
    const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    panCamera(cx - touchCenter[0], cy - touchCenter[1]);
    touchCenter = [cx, cy];
    e.preventDefault();
  }
});
canvas.addEventListener('touchend', e => {
  if (e.touches.length === 0) touchMode = 'none';
  else if (e.touches.length === 1) {
    touchMode = 'orbit';
    lastM = [e.touches[0].clientX, e.touches[0].clientY];
  }
});
canvas.addEventListener('dblclick', () => {
  cam.tgtTheta = 0.0; cam.tgtPhi = 0.12;
  cam.tgtTarget[0] = 0; cam.tgtTarget[1] = 0; cam.tgtTarget[2] = 0;
  autoFrame();
});

function clearLookSceneEffects() {
  MOON.active = false;
  MOON.yaw = 0;
  MOON.yawTarget = 0;
  setLightningActive(false);
  sceneViewMode = 'default';
}

function restoreDefaultSceneCamera() {
  sceneViewMode = 'default';
  cam.tgtTheta = 0.0;
  cam.tgtPhi = 0.12;
  cam.tgtRoll = 0.0;
  cam.tgtTarget[0] = 0;
  cam.tgtTarget[1] = 0;
  cam.tgtTarget[2] = 0;
  autoFrame();
}

function applyStormCamera() {
  sceneViewMode = 'storm';
  cam.tgtTheta = -0.16;
  cam.tgtPhi = 0.07;
  cam.tgtRoll = -0.018;
  cam.tgtTarget[0] = 0.28;
  cam.tgtTarget[1] = 0.08;
  cam.tgtTarget[2] = 0.0;
  autoFrame();
}

function applyMoonCamera() {
  sceneViewMode = 'moon';
  MOON.yaw = -0.18;
  MOON.yawTarget = -0.18;
  cam.tgtTheta = -0.06;
  cam.tgtPhi = 0.035;
  cam.tgtRoll = 0.0;
  cam.tgtTarget[0] = 0.74;
  cam.tgtTarget[1] = 0.36;
  cam.tgtTarget[2] = 0.0;
  autoFrame();
}

// ─── Renderer ────────────────────────────────────────────────
// One warm key raking across the cloth from the hoist side — the same setup as
// the Viking sketch, which is what makes the folds read as folds.
const KEY_LIGHT = [-4.0, 5.0, 6.5];

function resize() {
  const rawDpr = window.devicePixelRatio || 1;
  const dpr = isMobileViewport() ? Math.min(rawDpr, 1.75) : rawDpr;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  gl.viewport(0, 0, canvas.width, canvas.height);
}
// Coalesce resize bursts — each resize() reallocates the backing canvas, so a
// window drag shouldn't pay that per event. Leading call keeps the canvas
// responsive, trailing call settles on the final size.
let _resizeLast = 0, _resizeTimer = null;
window.addEventListener('resize', () => {
  const t = performance.now();
  if (t - _resizeLast > 100) {
    _resizeLast = t;
    resize();
  } else {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => { _resizeLast = performance.now(); resize(); }, 120);
  }
});
resize();
autoFrame();
cam.curDist = cam.tgtDist; // no zoom animation on load
cam.curTheta = cam.tgtTheta;
cam.curPhi = cam.tgtPhi;

let partyMode = false, partyTime = 0;
// Matte print mode — when true the cloth shader drops all specular/rim/sheen
// (set live by the Matte toggle and forced on by the A5 print preset).
let matteMode = false;
// True-colour print mode — when true the cloth is drawn fully unlit, so the
// texture reproduces 1:1 (e.g. #B52C3A stays #B52C3A instead of darkening to
// maroon under the head-on diffuse term). Toggled by the "True color" control
// and defaulted on whenever a picture is dropped in.
let unlitMode = false;
// Cloth mode — 'full' = wind sim · 'slight' = gentle deterministic ripple
function strokePathTriangles(path, widthPx, drawW, drawH) {
  if (!path || path.length < 2) return null;
  const sx = drawW * 0.5;
  const sy = drawH * 0.5;
  const verts = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const dx = (b.x - a.x) * sx;
    const dy = (b.y - a.y) * sy;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) continue;
    const ox = (-dy / len) * widthPx / sx;
    const oy = ( dx / len) * widthPx / sy;
    verts.push(
      a.x - ox, a.y - oy,
      a.x + ox, a.y + oy,
      b.x - ox, b.y - oy,
      b.x - ox, b.y - oy,
      a.x + ox, a.y + oy,
      b.x + ox, b.y + oy,
    );
  }
  return verts.length ? new Float32Array(verts) : null;
}

function drawLightningPath(path, widthPx, r, g, b, a, drawW, drawH) {
  const verts = strokePathTriangles(path, widthPx, drawW, drawH);
  if (!verts) return;
  gl.uniform4f(boltLoc.uColor, r, g, b, a);
  gl.bindBuffer(gl.ARRAY_BUFFER, boltBuf);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STREAM_DRAW);
  gl.vertexAttribPointer(boltLoc.aP, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, verts.length / 2);
}

function drawLightningBolts(drawW, drawH) {
  if (!LIGHTNING.active || !LIGHTNING.bolts.length) return;
  gl.useProgram(boltProg);
  gl.enableVertexAttribArray(boltLoc.aP);
  gl.bindBuffer(gl.ARRAY_BUFFER, boltBuf);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.depthMask(false);
  for (const bolt of LIGHTNING.bolts) {
    const t = clamp(bolt.age / bolt.life, 0, 1);
    const fade = Math.pow(1 - t, 1.35) * (0.82 + Math.sin(t * Math.PI * 8.0) * 0.18);
    for (const branch of bolt.branches) {
      drawLightningPath(branch, 17, 0.20, 0.36, 1.00, 0.12 * fade, drawW, drawH);
      drawLightningPath(branch, 5, 0.72, 0.86, 1.00, 0.34 * fade, drawW, drawH);
      drawLightningPath(branch, 1.6, 1.00, 1.00, 1.00, 0.80 * fade, drawW, drawH);
    }
    drawLightningPath(bolt.points, 46, 0.12, 0.28, 1.00, 0.11 * fade, drawW, drawH);
    drawLightningPath(bolt.points, 17, 0.32, 0.55, 1.00, 0.24 * fade, drawW, drawH);
    drawLightningPath(bolt.points, 5.2, 0.78, 0.90, 1.00, 0.62 * fade, drawW, drawH);
    drawLightningPath(bolt.points, 1.7, 1.00, 1.00, 1.00, 0.96 * fade, drawW, drawH);
  }
  gl.depthMask(true);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.disableVertexAttribArray(boltLoc.aP);
}

function drawMoonSurface() {
  if (!MOON.active) return;
  if (loc.aTan >= 0) gl.disableVertexAttribArray(loc.aTan);
  setModelMatrix(moonSceneModel(1));
  gl.uniform1i(loc.uIsGlass, 0);
  gl.uniform1f(loc.uMatte, 1.0);
  gl.uniform1f(loc.uUnlit, 0.0);
  gl.uniform1f(loc.uMoonSurface, 1.0);
  gl.uniform1f(loc.uAmbient, 0.46);
  gl.uniform3f(loc.uColor, MOON.color[0], MOON.color[1], MOON.color[2]);
  gl.uniform1f(loc.uAlpha, 1.0);
  gl.uniform1i(loc.uHasTex, 0);
  setMaskUniforms(false);
  gl.bindBuffer(gl.ARRAY_BUFFER, moonPosBuf);
  gl.enableVertexAttribArray(loc.aPos);
  gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, moonNrmBuf);
  gl.enableVertexAttribArray(loc.aNrm);
  gl.vertexAttribPointer(loc.aNrm, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, moonUVBuf);
  gl.enableVertexAttribArray(loc.aUV);
  gl.vertexAttribPointer(loc.aUV, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, moonIdxBuf);
  gl.uniform1f(loc.uFace, 1.0);
  gl.disable(gl.CULL_FACE);
  gl.drawElements(gl.TRIANGLES, moonIdxCount, gl.UNSIGNED_INT, 0);
}

function drawPoleMesh() {
  if (loc.aTan >= 0) gl.disableVertexAttribArray(loc.aTan);
  updatePoleMesh();
  setModelMatrix(MOON.active ? moonFlagModel() : MODEL_IDENTITY);
  gl.uniform1i(loc.uIsGlass, 1);
  gl.uniform1f(loc.uMoonSurface, 0.0);
  gl.uniform1f(loc.uAmbient, MOON.active ? 1.05 : 0.38);
  const pd = 0.88;
  if (poleColorOverride) gl.uniform3f(loc.uColor, poleColorOverride[0], poleColorOverride[1], poleColorOverride[2]);
  else gl.uniform3f(loc.uColor, SIM.bgColor[0] * pd, SIM.bgColor[1] * pd, SIM.bgColor[2] * pd);
  gl.uniform1f(loc.uAlpha, 1.0);
  gl.uniform1i(loc.uHasTex, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, polePosBuf);
  gl.enableVertexAttribArray(loc.aPos);
  gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, poleNrmBuf);
  gl.enableVertexAttribArray(loc.aNrm);
  gl.vertexAttribPointer(loc.aNrm, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, poleUVBuf);
  gl.enableVertexAttribArray(loc.aUV);
  gl.vertexAttribPointer(loc.aUV, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, poleIdxBuf);
  gl.uniform1f(loc.uFace, 1.0);
  gl.drawElements(gl.TRIANGLES, poleIdxCount, gl.UNSIGNED_INT, 0);
}

function render(dt) {
  updateLightning(dt);
  updateLiveVideoTexture();
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // ── HDRI background ──
  gl.disable(gl.DEPTH_TEST);
  drawBackgroundQuad(canvas.width, canvas.height);
  drawLightningBolts(canvas.width, canvas.height);
  gl.enable(gl.DEPTH_TEST);

  // ── Scene ──
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const ld = MOON.active ? [-0.32, 1.0, 0.58] : KEY_LIGHT;
  const ll = Math.sqrt(ld[0] ** 2 + ld[1] ** 2 + ld[2] ** 2);
  const e = eyePos();

  gl.useProgram(prog);
  gl.uniform1f(loc.uPartyTime, 0.0);
  gl.uniformMatrix4fv(loc.uProj, false, perspective(Math.PI / 4.5, canvas.width / canvas.height, 0.1, 100));
  gl.uniformMatrix4fv(loc.uView, false, lookAt(e, cam.target, rolledUp(e, cam.target, cam.roll)));
  gl.uniform3f(loc.uLight, ld[0] / ll, ld[1] / ll, ld[2] / ll);
  gl.uniform3f(loc.uEye, e[0], e[1], e[2]);
  gl.uniform1f(loc.uAmbient, 0.38);
  gl.uniform1f(loc.uLightning, lightningValue());

  drawMoonSurface();

  // Draw pole — only in Studio/Wind tabs (hidden in Export preview and any recording).
  if (showPole && !someRecording) {
    drawPoleMesh();
  }

  // Draw flag (double-sided)
  setModelMatrix(MOON.active ? moonFlagModel() : MODEL_IDENTITY);
  gl.uniform1i(loc.uIsGlass, 0);
  gl.uniform1f(loc.uMoonSurface, 0.0);
  gl.uniform1f(loc.uAmbient, MOON.active ? 1.05 : 0.38);
  gl.uniform1f(loc.uMatte, matteMode ? 1.0 : 0.0);
  gl.uniform1f(loc.uUnlit, unlitMode ? 1.0 : 0.0);
  gl.uniform3f(loc.uColor, SIM.flagColor[0], SIM.flagColor[1], SIM.flagColor[2]);
  gl.uniform1f(loc.uAlpha, SIM.opacity);
  if (hasTex && flagTex) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, flagTex);
    gl.uniform1i(loc.uTex, 0);
    gl.uniform1i(loc.uHasTex, 1);
  } else {
    gl.uniform1i(loc.uHasTex, 0);
  }
  setMaskUniforms(isCustomShape());

  bindClothBuffers();
  drawCloth(rIndexData.length);
  gl.disable(gl.BLEND);
}

// ─── Text texture generation ─────────────────────────────────
const textCanvas = document.createElement('canvas');
const textCtx = textCanvas.getContext('2d');
let currentText = '', currentFontSize = 120, currentLineHeight = 0.85;
let currentTextColor = '#016F17';
let currentFont = 'jubilee'; // bundled key or local:<postscript/name>
let textLayout = 'repeat'; // 'repeat' | 'centered' | 'titleCard'
let textLayoutUserSet = false; // true once the user explicitly picks a layout
let textTexActive = false;
let textScrollSpeed = 0; // 0 = static, >0 = pixels/sec scroll
let textScrollTime = 0;

const FONT_DEFS = new Map([
  ['jubilee', {
    label: 'OT Jubilee Platinum',
    family: 'OT Jubilee Platinum',
    style: 'italic',
    weight: 200,
    fallback: '"Instrument Serif", serif',
    defaultLayout: 'repeat',
  }],
  ['diatype', {
    label: 'ABC Diatype',
    family: 'ABC Diatype',
    style: 'normal',
    weight: 700,
    fallback: 'sans-serif',
    defaultLayout: 'centered',
  }],
]);
const LOCAL_FONT_PREFIX = 'local:';

function quoteFontFamily(name) {
  return '"' + String(name).replace(/["\\]/g, '\\$&') + '"';
}

function fontCSS(fontKey, size) {
  const def = FONT_DEFS.get(fontKey) || FONT_DEFS.get('diatype');
  const family = quoteFontFamily(def.family);
  const fallback = def.fallback ? ', ' + def.fallback : '';
  return `${def.style || 'normal'} ${def.weight || 400} ${size}px ${family}${fallback}`;
}

function defaultLayoutForFont(fontKey) {
  return FONT_DEFS.get(fontKey)?.defaultLayout || 'centered';
}

function inferLocalFontWeight(style) {
  const s = String(style || '').toLowerCase();
  if (s.includes('black') || s.includes('heavy')) return 900;
  if (s.includes('extra bold') || s.includes('extrabold')) return 800;
  if (s.includes('bold')) return 700;
  if (s.includes('medium')) return 500;
  if (s.includes('light')) return 300;
  if (s.includes('thin')) return 200;
  return 400;
}

// Name-tag blocks — four centered blocks (Jubilee, Diatype, Diatype, Diatype).
// y is the vertical center as a fraction of flag height (0 = top, 1 = bottom).
// Block 0 = project title (serif), block 1 = name, block 2 = role line,
// block 3 = www / IG handle. Name + role default to the same Diatype size and
// sit right next to each other; the www/IG line drops below them. CSV batch
// fills these per row (columns: project, name, extra, www).
const titleBlocks = [
  { text: "What Design\nCan't Do", size: 94, font: 'jubilee', y: 0.21,  lineH: 1.00 },
  { text: 'Albert Kozikowski',     size: 30, font: 'diatype', y: 0.56,  lineH: 0.95 },
  { text: 'Graphic Design',        size: 30, font: 'diatype', y: 0.592, lineH: 0.95 },
  { text: '@albertkozikowski',     size: 30, font: 'diatype', y: 0.809, lineH: 0.95 },
];

// Deterministic pseudo-random per row (consistent across redraws)
const rowSeeds = [];
const scrollSeeds = [];
for (let i = 0; i < 200; i++) {
  rowSeeds.push(((i * 7919 + 1301) % 10000) / 10000);
  scrollSeeds.push(((i * 3571 + 907) % 10000) / 10000);
}

function generateTextTexture(scrollOffset) {
  scrollOffset = scrollOffset || 0;
  const text = currentText.trim();
  if (textLayout !== 'titleCard' && !text) {
    if (textTexActive && !imageTexActive) { removeTexture(); textTexActive = false; }
    return;
  }
  // Cap live texture size on phones, but allow full texture detail during
  // export via prepareFullTextureForExport().
  const MAX_DIM = liveTextureMaxDim();
  let texW, texH;
  if (aspectW >= aspectH) { texW = MAX_DIM; texH = Math.round(texW * (aspectH / aspectW)); }
  else                    { texH = MAX_DIM; texW = Math.round(texH * (aspectW / aspectH)); }
  textCanvas.width = texW; textCanvas.height = texH;
  textCtx.clearRect(0, 0, texW, texH);

  // Title-card layout: three independent blocks, each positioned by its own
  // y (fraction of flag height). Block 1 supports multi-line text via Enter
  // (preserved newlines) and auto-wraps if a line overflows.
  if (textLayout === 'titleCard') {
    textCtx.fillStyle = currentTextColor;
    textCtx.textBaseline = 'middle';
    textCtx.textAlign = 'center';
    const padX = texW * 0.06;
    const maxW = texW - padX * 2;
    const sizeScale = texW / 800;

    const setBlockFont = (font, size) => {
      textCtx.font = fontCSS(font, size);
    };

    for (let bi = 0; bi < titleBlocks.length; bi++) {
      const b = titleBlocks[bi];
      if (!b.text.trim()) continue;
      // Shrink-to-fit: CSV batches feed wildly varying lengths (long titles,
      // full names, long URLs) into fixed-size blocks. Start at the chosen size
      // and step down until every wrapped line fits the usable width, so text
      // never overflows the flag. Only shrinks — short text keeps its set size.
      let sz = b.size * sizeScale;
      const minSz = sz * 0.4;
      for (let guard = 0; guard < 40; guard++) {
        setBlockFont(b.font, sz);
        // Measure natural wrap (no force-break) so an over-wide token drives a
        // shrink — keeps URLs/handles whole instead of chopping them.
        const probe = wrapParagraph(textCtx, b.text, maxW, false);
        let widest = 0;
        for (const ln of probe) widest = Math.max(widest, textCtx.measureText(ln).width);
        if (widest <= maxW || sz <= minSz) break;
        sz *= 0.93;
      }
      setBlockFont(b.font, sz);
      // Final wrap force-breaks anything still too wide at the size floor.
      const lines = wrapParagraph(textCtx, b.text, maxW);
      const lineH = sz * (b.lineH || 1.0);
      const totalH = lines.length * lineH;
      const centerY = texH * b.y;
      const startY = centerY - totalH / 2 + lineH * 0.5;
      for (let i = 0; i < lines.length; i++) {
        textCtx.fillText(lines[i], texW / 2, startY + i * lineH);
      }
    }

    textCtx.textAlign = 'start';
    loadTexture(textCanvas);
    textTexActive = true;
    return;
  }

  const fontSize = currentFontSize * (texW / 800);
  textCtx.font = fontCSS(currentFont, fontSize);
  textCtx.fillStyle = currentTextColor;
  textCtx.textBaseline = 'middle';

  // Centered layout: single word-wrapped paragraph in the middle of the flag.
  // No repetition. Works for either font.
  if (textLayout === 'centered') {
    const padX = texW * 0.08;
    const maxW = texW - padX * 2;
    const lineH = fontSize * currentLineHeight;
    const lines = wrapParagraph(textCtx, text, maxW);
    // Fit vertically — if paragraph would overflow, it'll still render but clipped.
    const totalH = lines.length * lineH;
    const centerY = texH / 2;
    const startY = centerY - totalH / 2 + lineH * 0.5;
    textCtx.textAlign = 'center';
    for (let i = 0; i < lines.length; i++) {
      textCtx.fillText(lines[i], texW / 2, startY + i * lineH);
    }
    textCtx.textAlign = 'start';
    loadTexture(textCanvas);
    textTexActive = true;
    return;
  }

  const measured = textCtx.measureText(text + ' ');
  const chunk = measured.width;
  if (chunk < 1) return;

  const lineH = fontSize * currentLineHeight;
  const numRows = Math.ceil(texH / lineH) + 2;
  for (let row = 0; row < numRows; row++) {
    const y = row * lineH + lineH * 0.5;
    // Random offset per row (deterministic from seed)
    const seed = rowSeeds[row % rowSeeds.length];
    let offset = -seed * chunk;
    // Scroll: all rows move right-to-left, slight speed variation per row
    if (scrollOffset !== 0) {
      const speedVar = 0.7 + scrollSeeds[row % scrollSeeds.length] * 0.6;
      offset -= scrollOffset * speedVar;
    }
    // Wrap offset into [-chunk, 0] range for seamless tiling
    offset = ((offset % chunk) - chunk) % chunk;
    let x = offset;
    while (x < texW + chunk) { textCtx.fillText(text, x, y); x += chunk; }
  }
  loadTexture(textCanvas);
  textTexActive = true;
}

// Word-wrap a paragraph to fit within maxWidth. Respects explicit line breaks.
// hardBreak: split a single token too wide for the column (URLs, long handles,
// compound words) so it can't run off the flag. Off during shrink-to-fit
// measurement (so the caller sees the true overflow and shrinks instead), on
// for the final render as a last-resort safety net.
function wrapParagraph(ctx, text, maxWidth, hardBreak = true) {
  const paragraphs = text.split(/\r?\n/);
  const lines = [];
  for (const para of paragraphs) {
    if (!para.trim()) { lines.push(''); continue; }
    const words = para.split(/\s+/);
    let line = '';
    for (const word of words) {
      if (hardBreak && ctx.measureText(word).width > maxWidth) {
        if (line) { lines.push(line); line = ''; }
        const pieces = breakLongWord(ctx, word, maxWidth);
        for (let p = 0; p < pieces.length - 1; p++) lines.push(pieces[p]);
        line = pieces[pieces.length - 1];
        continue;
      }
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

// Greedy character split for a token too wide for the column. Last-resort
// safety net behind shrink-to-fit — keeps a runaway URL on the flag instead of
// bleeding past both edges.
function breakLongWord(ctx, word, maxWidth) {
  const pieces = [];
  let cur = '';
  for (const ch of word) {
    if (cur && ctx.measureText(cur + ch).width > maxWidth) { pieces.push(cur); cur = ch; }
    else cur += ch;
  }
  if (cur) pieces.push(cur);
  return pieces.length ? pieces : [word];
}

// ─── Image handling ──────────────────────────────────────────
let imageTexActive = false, loadedImage = null, fitMode = 'fit';
let liveVideoActive = false;
const imgCanvas = document.createElement('canvas');
const imgCtx = imgCanvas.getContext('2d');

function drawMediaToTexture(source, maxDim = liveTextureMaxDim()) {
  let texW, texH;
  if (aspectW >= aspectH) { texW = maxDim; texH = Math.round(texW * (aspectH / aspectW)); }
  else                    { texH = maxDim; texW = Math.round(texH * (aspectW / aspectH)); }
  imgCanvas.width = texW; imgCanvas.height = texH;
  imgCtx.clearRect(0, 0, texW, texH);
  if (fitMode === 'stretch') {
    imgCtx.drawImage(source, 0, 0, texW, texH);
  } else {
    const sourceW = source.videoWidth || source.naturalWidth || source.width;
    const sourceH = source.videoHeight || source.naturalHeight || source.height;
    const sourceAsp = sourceW / sourceH;
    const canAsp = texW / texH;
    let dw, dh;
    if (sourceAsp > canAsp) { dh = texH; dw = texH * sourceAsp; }
    else { dw = texW; dh = texW / sourceAsp; }
    imgCtx.drawImage(source, (texW - dw) / 2, (texH - dh) / 2, dw, dh);
  }
  updateTexturePixels(imgCanvas);
  imageTexActive = true;
  textTexActive = false;
}

function updateLiveVideoTexture() {
  if (!liveVideoActive || !previewVideo || previewVideo.readyState < 2) return;
  if (textLayout === 'titleCard' || currentText.trim()) return;
  drawMediaToTexture(previewVideo, Math.min(LIVE_VIDEO_TEXTURE_MAX_DIM, liveTextureMaxDim()));
}

function refreshTexture() {
  const text = currentText.trim();
  // When text is active, PNG is disabled (text-only mode).
  // When text is cleared, PNG comes back.
  if (textLayout === 'titleCard') {
    // FFI mode — drives its own text from titleBlocks, not currentText.
    generateTextTexture(0);
  } else if (text) {
    // Text only (even if image is loaded, we disable it while text is active)
    generateTextTexture(textScrollTime);
  } else if (liveVideoActive) {
    updateLiveVideoTexture();
  } else if (loadedImage) {
    // No text — show image
    drawMediaToTexture(loadedImage);
  } else {
    if (hasTex) { removeTexture(); textTexActive = false; imageTexActive = false; }
  }
}

// ─── Soft ratio update (smooth, no reallocation) ─────────────
// Keeps grid topology (cols/rows, indices, uv, constraint pairs) intact.
// Only updates flagW/flagH, rest lengths, scales positions. Cheap enough
// to run every slider input tick.
let _texRefreshRaf = null;
function queueTextureRefresh() {
  if (_texRefreshRaf) return;
  _texRefreshRaf = requestAnimationFrame(() => {
    _texRefreshRaf = null;
    refreshTexture();
  });
}
function softRatioUpdate(aw, ah) {
  const oldW = flagW, oldH = flagH;
  aspectW = aw; aspectH = ah;
  const maxDim = 3.0;
  if (aw >= ah) { flagW = maxDim; flagH = maxDim * (ah / aw); }
  else { flagH = maxDim; flagW = maxDim * (aw / ah); }
  restDx = flagW / (cols - 1);
  restDy = flagH / (rows - 1);
  restDiag = Math.sqrt(restDx * restDx + restDy * restDy);
  computePoleRig();

  const sx = flagW / oldW, sy = flagH / oldH, sz = Math.min(sx, sy);
  for (let k = 0; k < totalPts; k++) {
    const i3 = k * 3;
    pos[i3] *= sx; pos[i3 + 1] *= sy; pos[i3 + 2] *= sz;
    prev[i3] *= sx; prev[i3 + 1] *= sy; prev[i3 + 2] *= sz;
  }

  const dx2 = restDx * 2, dy2 = restDy * 2;
  for (let k = 0; k < numC; k++) {
    const d = conB[k] - conA[k];
    if (d === 1) conR[k] = restDx;
    else if (d === cols) conR[k] = restDy;
    else if (d === cols + 1 || d === cols - 1) conR[k] = restDiag;
    else if (d === 2) conR[k] = dx2;
    else if (d === 2 * cols) conR[k] = dy2;
  }

  buildPole();
  queueCreaseRebuild();
  queueTextureRefresh();
  autoFrame();
}

let ratioTransitionRaf = null;
function stopRatioTransition() {
  if (ratioTransitionRaf) {
    cancelAnimationFrame(ratioTransitionRaf);
    ratioTransitionRaf = null;
  }
}

function smoothRatioUpdate(aw, ah, duration = 420) {
  stopRatioTransition();
  const fromW = aspectW;
  const fromH = aspectH;
  if (Math.abs(fromW - aw) < 0.001 && Math.abs(fromH - ah) < 0.001) {
    softRatioUpdate(aw, ah);
    return;
  }
  const start = performance.now();
  const ease = t => t * t * (3 - 2 * t);
  const step = now => {
    const t = clamp((now - start) / duration, 0, 1);
    const e = ease(t);
    softRatioUpdate(fromW + (aw - fromW) * e, fromH + (ah - fromH) * e);
    if (t < 1) {
      ratioTransitionRaf = requestAnimationFrame(step);
    } else {
      ratioTransitionRaf = null;
      softRatioUpdate(aw, ah);
    }
  };
  ratioTransitionRaf = requestAnimationFrame(step);
}

// ─── Full rebuild ────────────────────────────────────────────
function fullRebuild(aw, ah, smooth) {
  stopRatioTransition();
  // Ratio presets / Reset All / print presets start from a clean rectangle —
  // the grid is rebuilt from scratch below, so only mask + UI need clearing.
  clearShapeState();
  const oldW = flagW, oldH = flagH;
  const oldCols = cols, oldRows = rows;
  const oldPos = smooth && pos ? new Float32Array(pos) : null;
  const oldPrev = smooth && prev ? new Float32Array(prev) : null;
  aspectW = aw; aspectH = ah;
  rebuildGrid(aw, ah);
  // Preserve cloth draping by scaling old positions to new dimensions
  if (oldPos && oldCols === cols && oldRows === rows && oldW > 0 && oldH > 0) {
    const sx = flagW / oldW, sy = flagH / oldH;
    for (let k = 0; k < totalPts; k++) {
      const i3 = k * 3;
      pos[i3] = oldPos[i3] * sx;
      pos[i3 + 1] = oldPos[i3 + 1] * sy;
      pos[i3 + 2] = oldPos[i3 + 2] * Math.min(sx, sy);
      prev[i3] = oldPrev[i3] * sx;
      prev[i3 + 1] = oldPrev[i3 + 1] * sy;
      prev[i3 + 2] = oldPrev[i3 + 2] * Math.min(sx, sy);
    }
  }
  uploadStaticBuffers();
  buildPole();
  queueCreaseRebuild();
  refreshTexture();
}

// ─── Load default demo texture ──────────────────────────────
function loadDefaultTexture() {
  const img = new Image();
  img.onload = () => {
    loadedImage = img;
    refreshTexture();
    const previewImg = document.getElementById('previewImg');
    const texPreview = document.getElementById('texPreview');
    const dropzone = document.getElementById('dropzone');
    const fitToggle = document.getElementById('fitToggle');
    previewImg.src = img.src;
    texPreview.style.display = 'block';
    dropzone.style.display = 'none';
    fitToggle.style.display = 'flex';
  };
  img.src = DEFAULT_TEXTURE_PATH;
}

// ─── UI ──────────────────────────────────────────────────────
const panel = document.getElementById('panel');
document.getElementById('panelClose').addEventListener('click', () => { panel.classList.add('collapsed'); if (someActive) initSomeCrop(); });

// About — what this is, how to drive it, and where it comes from.
const aboutToggle = document.getElementById('aboutToggle');
const panelAbout = document.getElementById('panelAbout');
if (aboutToggle && panelAbout) {
  aboutToggle.addEventListener('click', () => {
    const open = panelAbout.hidden;
    panelAbout.hidden = !open;
    aboutToggle.setAttribute('aria-expanded', String(open));
  });
}
document.getElementById('panelToggle').addEventListener('click', () => {
  closeMobileSheet();
  panel.classList.remove('collapsed');
  if (someActive) initSomeCrop();
});

function setActiveButton(group, selector, activeBtn) {
  if (!group) return;
  group.querySelectorAll(selector).forEach(b => b.classList.toggle('active', b === activeBtn));
}

function setActiveByData(group, selector, key, value) {
  if (!group) return;
  group.querySelectorAll(selector).forEach(b => b.classList.toggle('active', b.dataset[key] === value));
}

// Aspect ratio
const ratioRow = document.getElementById('ratioRow');
const customRatioDiv = document.getElementById('customRatio');
let activeRatio = '2:3';
let customAW = 3, customAH = 2;

ratioRow.addEventListener('click', e => {
  const btn = e.target.closest('[data-r]');
  if (!btn) return;
  const r = btn.dataset.r;
  setActiveButton(ratioRow, '[data-r]', btn);
  activeRatio = r;
  // data-r is H:W (flag convention) — height first, width second.
  const [h, w] = r.split(':').map(Number);
  customAW = w; customAH = h;
  updateMiniPreview();
  const hadShape = isCustomShape();
  clearShapeState();
  if (hadShape) {
    buildMesh();
    uploadStaticBuffers();
  }
  smoothRatioUpdate(w, h);
});
const miniFlagRect = document.getElementById('miniFlagRect');
const miniFlagStage = document.getElementById('miniFlagStage');
const miniDimW = document.getElementById('miniDimW');
const miniDimH = document.getElementById('miniDimH');

function updateMiniPreview() {
  const stageW = 170, stageH = 100, pad = 8;
  const scale = Math.min((stageW - pad * 2) / customAW, (stageH - pad * 2) / customAH);
  miniFlagRect.style.width = (customAW * scale) + 'px';
  miniFlagRect.style.height = (customAH * scale) + 'px';
  if (!miniDimW.classList.contains('editing')) miniDimW.textContent = customAW.toFixed(1);
  if (!miniDimH.classList.contains('editing')) miniDimH.textContent = customAH.toFixed(1);
}

function ensureCustomMode() {
  if (activeRatio === 'custom') return;
  activeRatio = 'custom';
  setActiveByData(ratioRow, '[data-r]', 'r', '__custom__');
}

function setEditingAxis(axis) {
  miniFlagRect.classList.toggle('editing-w', axis === 'w');
  miniFlagRect.classList.toggle('editing-h', axis === 'h');
}

// Click-to-edit on the dim labels. Enter/blur commits, Esc cancels.
[['w', miniDimW], ['h', miniDimH]].forEach(([axis, el]) => {
  const selectAll = () => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(r);
  };
  const beginEdit = () => {
    el.contentEditable = 'plaintext-only';
    el.classList.add('editing');
    setEditingAxis(axis);
    el.focus();
    selectAll();
  };
  const commit = () => {
    const raw = el.textContent.trim().replace(',', '.');
    let v = parseFloat(raw);
    if (!isFinite(v)) v = (axis === 'w' ? customAW : customAH);
    v = clamp(v, 1, 20);
    v = Math.round(v * 10) / 10;
    if (axis === 'w') customAW = v; else customAH = v;
    el.contentEditable = 'false';
    el.classList.remove('editing');
    setEditingAxis(null);
    window.getSelection()?.removeAllRanges();
    ensureCustomMode();
    updateMiniPreview();
    softRatioUpdate(customAW, customAH);
  };
  const cancel = () => {
    el.contentEditable = 'false';
    el.classList.remove('editing');
    setEditingAxis(null);
    window.getSelection()?.removeAllRanges();
    updateMiniPreview();
  };
  el.addEventListener('pointerdown', e => e.stopPropagation());
  el.addEventListener('click', () => { if (el.contentEditable !== 'plaintext-only') beginEdit(); });
  el.addEventListener('focus', () => { if (el.contentEditable !== 'plaintext-only') beginEdit(); });
  el.addEventListener('blur', commit);
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); el.blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const step = e.shiftKey ? 1 : 0.1;
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const cur = parseFloat(el.textContent) || 1;
      const next = clamp(Math.round((cur + dir * step) * 10) / 10, 1, 20);
      el.textContent = next.toFixed(1);
      selectAll();
    }
  });
});

// Interactive mini-flag edges / corner — drag to resize the ratio.
(function initMiniDrag() {
  let drag = null;
  const onMove = e => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    let aw = drag.startAw, ah = drag.startAh;
    if (drag.axis !== 'h') aw = clamp(drag.startAw + dx / drag.scale, 1, 20);
    if (drag.axis !== 'w') ah = clamp(drag.startAh + dy / drag.scale, 1, 20);
    aw = Math.round(aw * 10) / 10;
    ah = Math.round(ah * 10) / 10;
    customAW = aw;
    customAH = ah;
    ensureCustomMode();
    updateMiniPreview();
    softRatioUpdate(aw, ah);
  };
  const onUp = e => {
    if (!drag) return;
    drag.target.releasePointerCapture?.(e.pointerId);
    setEditingAxis(null);
    drag = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  miniFlagStage.addEventListener('pointerdown', e => {
    const edge = e.target.closest('[data-edge]');
    const handle = e.target.closest('[data-handle]');
    const hit = edge || handle;
    if (!hit) return;
    const axis = edge ? edge.dataset.edge : (handle.dataset.handle === 'wh' ? null : handle.dataset.handle);
    ensureCustomMode();
    const stageW = 170, stageH = 100, pad = 8;
    const scale = Math.min((stageW - pad * 2) / customAW, (stageH - pad * 2) / customAH);
    drag = { startX: e.clientX, startY: e.clientY, startAw: customAW, startAh: customAH, scale, axis, target: hit };
    hit.setPointerCapture?.(e.pointerId);
    setEditingAxis(axis || 'wh');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    e.preventDefault();
  });
})();

updateMiniPreview();

// ── Custom shape editor — drag the outline points, double-click the flag to
// add a point on the nearest edge, double-click a point to remove it. ──
const miniShapeSvg = document.getElementById('miniShapeSvg');
const miniShapePoly = document.getElementById('miniShapePoly');
const shapeResetBtn = document.getElementById('shapeResetBtn');

const RECT_POINTS = () => [[0, 0], [1, 0], [1, 1], [0, 1]];

function materializeShape() {
  if (!shapePoints) shapePoints = RECT_POINTS();
}

function shapePolyAttr() {
  return (shapePoints || RECT_POINTS()).map(p => p[0] + ',' + p[1]).join(' ');
}

function positionShapeDot(el, p) {
  el.style.left = (p[0] * 100) + '%';
  el.style.top = (p[1] * 100) + '%';
}

function syncShapeOutline() {
  const custom = isCustomShape();
  miniFlagRect.classList.toggle('shaped', custom);
  miniShapeSvg.style.display = custom ? 'block' : 'none';
  miniShapePoly.setAttribute('points', shapePolyAttr());
  shapeResetBtn.style.display = custom ? 'block' : 'none';
}

// Full refresh — also rebuilds the dot elements, so never call mid-drag
// (it would destroy the dot holding the pointer capture).
function updateShapeUI() {
  syncShapeOutline();
  miniFlagRect.querySelectorAll('.mini-shape-dot').forEach(el => el.remove());
  (shapePoints || RECT_POINTS()).forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'mini-shape-dot';
    el.dataset.pt = i;
    el.title = 'Drag to move · drag outside or double-click to remove';
    positionShapeDot(el, p);
    miniFlagRect.appendChild(el);
  });
}

function insertShapePoint(u, v, pxW, pxH) {
  let best = 0, bestPt = [u, v], bestD = Infinity;
  for (let i = 0; i < shapePoints.length; i++) {
    const a = shapePoints[i], b = shapePoints[(i + 1) % shapePoints.length];
    // project the click onto each segment in on-screen pixel space
    const ax = a[0] * pxW, ay = a[1] * pxH, bx = b[0] * pxW, by = b[1] * pxH;
    const px = u * pxW, py = v * pxH;
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0.5;
    t = clamp(t, 0.05, 0.95);
    const qx = ax + dx * t, qy = ay + dy * t;
    const d = (px - qx) ** 2 + (py - qy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
      bestPt = [Math.round(qx / pxW * 100) / 100, Math.round(qy / pxH * 100) / 100];
    }
  }
  shapePoints.splice(best + 1, 0, bestPt);
}

(function initShapeEditor() {
  let sdrag = null;
  const rectPosition = e => {
    const r = miniFlagRect.getBoundingClientRect();
    const rawU = (e.clientX - r.left) / r.width;
    const rawV = (e.clientY - r.top) / r.height;
    return {
      u: clamp(Math.round(rawU * 100) / 100, 0, 1),
      v: clamp(Math.round(rawV * 100) / 100, 0, 1),
      outside: rawU < 0 || rawU > 1 || rawV < 0 || rawV > 1,
    };
  };
  const onMove = e => {
    if (!sdrag) return;
    materializeShape();
    const { u, v, outside } = rectPosition(e);
    sdrag.remove = outside && shapePoints.length > 3;
    sdrag.el.classList.toggle('removing', sdrag.remove);
    const p = shapePoints[sdrag.idx];
    if (p[0] === u && p[1] === v) return;
    p[0] = u; p[1] = v;
    sdrag.moved = true;
    positionShapeDot(sdrag.el, p);
    syncShapeOutline();
    queueApplyShape();
  };
  const onUp = e => {
    if (!sdrag) return;
    const remove = rectPosition(e).outside && (shapePoints || RECT_POINTS()).length > 3;
    sdrag.el.releasePointerCapture?.(e.pointerId);
    const moved = sdrag.moved;
    const removeIdx = sdrag.idx;
    sdrag = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (remove) {
      materializeShape();
      shapePoints.splice(removeIdx, 1);
      applyShape();
      updateShapeUI();
      return;
    }
    if (!moved) return; // plain click (e.g. half of a dblclick) — nothing to do
    // Final apply — also snaps the UI back if the polygon went degenerate.
    applyShape();
    updateShapeUI();
  };
  miniFlagRect.addEventListener('pointerdown', e => {
    const dot = e.target.closest('.mini-shape-dot');
    if (!dot) return;
    e.stopPropagation();
    e.preventDefault();
    sdrag = { el: dot, idx: +dot.dataset.pt };
    dot.setPointerCapture?.(e.pointerId);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
  miniFlagRect.addEventListener('dblclick', e => {
    const dot = e.target.closest('.mini-shape-dot');
    if (dot) {
      const pts = shapePoints || RECT_POINTS();
      if (pts.length <= 3) return; // a flag needs at least a triangle
      materializeShape();
      shapePoints.splice(+dot.dataset.pt, 1);
      applyShape();
      updateShapeUI();
      return;
    }
    // Edge hit areas serve two gestures: drag to resize the ratio, and
    // double-click to add a polygon point. Do not discard the double-click
    // just because it landed on an edge overlay.
    if (e.target.closest('[data-handle], .mini-dim')) return;
    const r = miniFlagRect.getBoundingClientRect();
    const u = clamp((e.clientX - r.left) / r.width, 0, 1);
    const v = clamp((e.clientY - r.top) / r.height, 0, 1);
    materializeShape();
    insertShapePoint(u, v, r.width, r.height);
    applyShape();
    updateShapeUI();
  });
  shapeResetBtn.addEventListener('click', resetShape);
})();
updateShapeUI();

// Wind sliders
function slider(id, valId, fn) {
  const el = document.getElementById(id), v = document.getElementById(valId);
  el.addEventListener('input', () => { v.textContent = fn(el.value); });
}
slider('windStrength', 'windVal', v => { SIM.windStrength = +v; return v; });
slider('turbulence', 'turbVal', v => { SIM.turbulence = +v; return v; });
slider('gravity', 'gravityVal', v => { SIM.gravity = +v / 10; return (+v / 10).toFixed(1); });

// Weather preset — Normal / Storm segmented control
const weatherRow = document.getElementById('weatherRow');
let _savedWeather = null;
function setWeather(mode) {
  const windIn = document.getElementById('windStrength');
  const turbIn = document.getElementById('turbulence');
  const gravIn = document.getElementById('gravity');
  if (mode === 'storm' && WEATHER.mode !== 'storm') {
    _savedWeather = {
      wind: windIn.value,
      turb: turbIn.value,
      gravity: gravIn.value,
      stiffness: SIM.stiffness,
      damping: SIM.damping,
      substeps: SUBSTEPS,
    };
    windIn.value = 205; windIn.dispatchEvent(new Event('input'));
    turbIn.value = 64;  turbIn.dispatchEvent(new Event('input'));
    gravIn.value = -8;  gravIn.dispatchEvent(new Event('input'));
    SIM.stiffness = 66;
    SIM.damping = 94;
    SUBSTEPS = 2;
    WEATHER.angleDriftMax = 34;
    WEATHER.angleDriftForce = 1.45;
  } else if (mode === 'normal' && WEATHER.mode === 'storm') {
    if (_savedWeather) {
      windIn.value = _savedWeather.wind; windIn.dispatchEvent(new Event('input'));
      turbIn.value = _savedWeather.turb; turbIn.dispatchEvent(new Event('input'));
      gravIn.value = _savedWeather.gravity; gravIn.dispatchEvent(new Event('input'));
      SIM.stiffness = _savedWeather.stiffness;
      SIM.damping = _savedWeather.damping;
      SUBSTEPS = _savedWeather.substeps;
      _savedWeather = null;
    }
    WEATHER.angleDriftMax = 24;
    WEATHER.angleDriftForce = 1.0;
  }
  WEATHER.mode = mode;
}
weatherRow.addEventListener('click', e => {
  const btn = e.target.closest('[data-weather]');
  if (!btn || btn.classList.contains('active')) return;
  setActiveButton(weatherRow, '[data-weather]', btn);
  setWeather(btn.dataset.weather);
});

// Light — Studio / Soft / Classic
const lightRow = document.getElementById('lightRow');
if (lightRow) lightRow.addEventListener('click', e => {
  const btn = e.target.closest('[data-light]');
  if (!btn || btn.classList.contains('active')) return;
  setActiveButton(lightRow, '[data-light]', btn);
  setLightMode(btn.dataset.light);
});

// Attachment — Full edge / Two corners
const attachRow = document.getElementById('attachRow');
attachRow.addEventListener('click', e => {
  const btn = e.target.closest('[data-attach]');
  if (!btn || btn.classList.contains('active')) return;
  setActiveButton(attachRow, '[data-attach]', btn);
  ATTACH.mode = btn.dataset.attach;
  applyPinning();
});

// ─── Gust ────────────────────────────────────────────────────
// Hold the button (or G) to charge one; the fill is the charge, so the release
// is never a surprise. The air also throws its own gusts on a timer set by the
// Turbulence slider — this is just the manual trigger.
const GUST_CHARGE_T = 1.2;                  // seconds of hold for full power
const GUST_MIN = 0.7, GUST_MAX = 2.3;
const gustBtn = document.getElementById('gustBtn');
const gustFill = document.getElementById('gustFill');
let chargeT0 = -1;
const nowSec = () => performance.now() / 1000;
const chargeAmt = () => Math.min(1, (nowSec() - chargeT0) / GUST_CHARGE_T);
function startCharge() { if (chargeT0 < 0) chargeT0 = nowSec(); }
function releaseCharge() {
  if (chargeT0 < 0) return;
  const c = chargeAmt();
  chargeT0 = -1;
  if (gustFill) gustFill.style.width = '0%';
  triggerGust(GUST_MIN + (GUST_MAX - GUST_MIN) * c);
}
function updateGustCharge() {
  if (chargeT0 >= 0 && gustFill) gustFill.style.width = (chargeAmt() * 100).toFixed(1) + '%';
}
if (gustBtn) {
  gustBtn.addEventListener('pointerdown', e => {
    e.preventDefault();
    gustBtn.setPointerCapture(e.pointerId);
    startCharge();
  });
  gustBtn.addEventListener('pointerup', releaseCharge);
  gustBtn.addEventListener('pointercancel', releaseCharge);
}
window.addEventListener('blur', releaseCharge);   // never leave a charge stuck on tab-away
window.addEventListener('keydown', e => {
  if (e.key !== 'g' && e.key !== 'G') return;
  const t = e.target;
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
  if (!e.repeat) startCharge();
});
window.addEventListener('keyup', e => {
  if (e.key === 'g' || e.key === 'G') releaseCharge();
});

// Font picker — bundled fonts first, optional local fonts via browser permission.
document.fonts.load(fontCSS('diatype', 48)).catch(() => {});
document.fonts.load(fontCSS('jubilee', 48)).catch(() => {});
const fontSelect = document.getElementById('fontSelect');
const fontScanBtn = document.getElementById('fontScanBtn');

function syncFontSelectOptions() {
  if (!fontSelect) return;
  const previous = fontSelect.value || currentFont;
  fontSelect.textContent = '';
  for (const [key, def] of FONT_DEFS) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = def.label;
    fontSelect.appendChild(option);
  }
  fontSelect.value = FONT_DEFS.has(previous) ? previous : currentFont;
}

function setTextFont(fontKey) {
  if (!FONT_DEFS.has(fontKey)) fontKey = 'diatype';
  currentFont = fontKey;
  if (fontSelect) fontSelect.value = fontKey;
  if (!textLayoutUserSet) setTextLayout(defaultLayoutForFont(fontKey));
  document.fonts.load(fontCSS(fontKey, 48)).catch(() => {});
  refreshTexture();
}

async function loadLocalFonts() {
  if (!fontScanBtn) return;
  if (!('queryLocalFonts' in window)) {
    fontScanBtn.textContent = 'No local';
    setTimeout(() => { fontScanBtn.textContent = 'Local'; }, 1200);
    return;
  }
  const oldLabel = fontScanBtn.textContent;
  fontScanBtn.textContent = 'Loading';
  fontScanBtn.disabled = true;
  try {
    const fonts = await window.queryLocalFonts();
    const seen = new Set();
    for (const font of fonts) {
      const family = font.family || font.fullName || font.postscriptName;
      if (!family) continue;
      const style = font.style || '';
      const identity = (font.postscriptName || font.fullName || family) + ':' + style;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const key = LOCAL_FONT_PREFIX + identity;
      FONT_DEFS.set(key, {
        label: font.fullName || [family, style].filter(Boolean).join(' '),
        family,
        style: /italic|oblique/i.test(style) ? 'italic' : 'normal',
        weight: inferLocalFontWeight(style),
        fallback: 'sans-serif',
        defaultLayout: 'centered',
      });
    }
    syncFontSelectOptions();
    fontSelect.value = currentFont;
  } catch (err) {
    console.warn('Local font access failed:', err);
  } finally {
    fontScanBtn.disabled = false;
    fontScanBtn.textContent = oldLabel;
  }
}

syncFontSelectOptions();
fontSelect?.addEventListener('change', () => setTextFont(fontSelect.value));
fontScanBtn?.addEventListener('click', loadLocalFonts);

// Layout pill-row (Repeat / Centered)
const layoutRow = document.getElementById('layoutRow');
function setTextLayout(mode) {
  textLayout = mode;
  setActiveByData(layoutRow, '[data-layout]', 'layout', mode);
}
layoutRow.addEventListener('click', e => {
  const btn = e.target.closest('[data-layout]');
  if (!btn || btn.classList.contains('active')) return;
  textLayoutUserSet = true;
  setTextLayout(btn.dataset.layout);
  refreshTexture();
});

// Font size
const fontSizeSlider = document.getElementById('fontSize');
const fontSizeVal = document.getElementById('fontSizeVal');
fontSizeSlider.addEventListener('input', () => {
  currentFontSize = +fontSizeSlider.value;
  fontSizeVal.textContent = currentFontSize;
  refreshTexture();
});

// Line height
const lineHeightSlider = document.getElementById('lineHeight');
const lineHeightVal = document.getElementById('lineHeightVal');
lineHeightSlider.addEventListener('input', () => {
  currentLineHeight = +lineHeightSlider.value / 100;
  lineHeightVal.textContent = currentLineHeight.toFixed(2);
  refreshTexture();
});

// Scroll speed
const scrollSpeedSlider = document.getElementById('scrollSpeed');
const scrollVal = document.getElementById('scrollVal');
scrollSpeedSlider.addEventListener('input', () => {
  textScrollSpeed = +scrollSpeedSlider.value;
  scrollVal.textContent = scrollSpeedSlider.value;
});

// Snap the flag to a 5×5 square. Used when text is first typed and by the
// Title-card text reads best centred on a square.
function setSquareRatio() {
  customAW = 5; customAH = 5;
  ensureCustomMode();
  updateMiniPreview();
  smoothRatioUpdate(5, 5);
}

// Text input
const textInput = document.getElementById('textInput');
let textDebounce = null;
let _textWasEmpty = true; // tracks the empty→typed transition
textInput.addEventListener('input', () => {
  currentText = textInput.value;
  textScrollTime = 0; // reset scroll position on new text
  const nowEmpty = !currentText.trim();
  // The moment a blank field gets text, snap to a 5×5 square. Only fires on the
  // empty→typed transition so it never overrides a ratio the user picks later,
  // and never in print/title-card mode (that drives its own portrait flag).
  if (!nowEmpty && _textWasEmpty && textLayout !== 'titleCard') setSquareRatio();
  _textWasEmpty = nowEmpty;
  clearTimeout(textDebounce);
  textDebounce = setTimeout(() => refreshTexture(), 80);
});

// Color utilities
function hexToRgb(hex) {
  return [parseInt(hex.substr(1,2),16)/255, parseInt(hex.substr(3,2),16)/255, parseInt(hex.substr(5,2),16)/255];
}
function isValidHex(s) { return /^#[0-9A-Fa-f]{6}$/.test(s); }
function setPoleColorOverride(hex) {
  poleColorOverride = hex && isValidHex(hex) ? hexToRgb(hex) : null;
}

// Text color (swatch + hex input)
const textColorIn = document.getElementById('textColor');
const textColorHex = document.getElementById('textColorHex');
function setTextColor(hex, shouldRefresh = true) {
  if (!isValidHex(hex)) return;
  currentTextColor = hex.toUpperCase();
  textColorIn.value = currentTextColor;
  textColorHex.value = currentTextColor;
  if (shouldRefresh) refreshTexture();
}
textColorIn.addEventListener('input', () => {
  setTextColor(textColorIn.value);
});
textColorHex.addEventListener('input', () => {
  let v = textColorHex.value;
  if (v[0] !== '#') v = '#' + v;
  if (isValidHex(v)) setTextColor(v);
});

// Color pickers
const bgColorIn = document.getElementById('bgColor');
const bgColorHex = document.getElementById('bgColorHex');
function setBackgroundColor(hex) {
  if (!isValidHex(hex)) return;
  const v = hex.toUpperCase();
  const c = hexToRgb(v);
  SIM.bgColor[0] = c[0]; SIM.bgColor[1] = c[1]; SIM.bgColor[2] = c[2];
  if (!MOON.active) {
    SIM.flagColor[0] = c[0]; SIM.flagColor[1] = c[1]; SIM.flagColor[2] = c[2];
  }
  bgColorIn.value = v;
  bgColorHex.value = v;
}

function setFlagColorOnly(hex) {
  if (!isValidHex(hex)) return;
  const c = hexToRgb(hex.toUpperCase());
  SIM.flagColor[0] = c[0]; SIM.flagColor[1] = c[1]; SIM.flagColor[2] = c[2];
}

bgColorIn.addEventListener('input', () => {
  setBackgroundColor(bgColorIn.value);
});
bgColorHex.addEventListener('input', () => {
  let v = bgColorHex.value;
  if (v[0] !== '#') v = '#' + v;
  if (isValidHex(v)) setBackgroundColor(v);
});

const bgModeSelect = document.getElementById('bgModeSelect');
const bgMediaInput = document.getElementById('bgMediaInput');
const bgPickBtn = document.getElementById('bgPickBtn');
const bgClearBtn = document.getElementById('bgClearBtn');

function clearBackgroundMedia(resetMode = true) {
  bgImage = null;
  bgImageDirty = false;
  bgVideo.pause();
  bgVideo.removeAttribute('src');
  bgVideo.load();
  if (bgObjUrl) { URL.revokeObjectURL(bgObjUrl); bgObjUrl = null; }
  clearBgTexture();
  if (resetMode) {
    bgMode = 'color';
    if (bgModeSelect) bgModeSelect.value = 'color';
  }
  if (bgMediaInput) bgMediaInput.value = '';
}

function syncBackgroundInputAccept() {
  if (!bgMediaInput) return;
  bgMediaInput.accept = bgMode === 'video' ? 'video/*' : bgMode === 'picture' ? 'image/*' : 'image/*,video/*';
}

function setBackgroundMode(mode, shouldPick = false) {
  bgMode = mode || 'color';
  if (bgModeSelect) bgModeSelect.value = bgMode;
  syncBackgroundInputAccept();
  if (bgMode === 'video') {
    bgImage = null;
    if (bgVideo.src) bgVideo.play().catch(() => {});
  } else {
    bgVideo.pause();
  }
  if (shouldPick && bgMode !== 'color') bgMediaInput?.click();
}

function pickBackgroundMedia() {
  if (bgMode === 'color') {
    bgMode = 'picture';
    if (bgModeSelect) bgModeSelect.value = bgMode;
  }
  syncBackgroundInputAccept();
  bgMediaInput?.click();
}

function handleBackgroundMediaFile(file) {
  if (!file) return;
  clearBackgroundMedia(false);
  bgObjUrl = URL.createObjectURL(file);
  if (file.type.startsWith('video/')) {
    setBackgroundMode('video');
    bgVideo.src = bgObjUrl;
    bgVideo.onloadeddata = () => {
      setBgTextureFromSource(bgVideo);
      bgVideo.play().catch(() => {});
    };
    bgVideo.load();
  } else if (file.type.startsWith('image/')) {
    setBackgroundMode('picture');
    const img = new Image();
    img.onload = () => {
      bgImage = img;
      bgImageDirty = true;
      setBgTextureFromSource(bgImage);
      bgImageDirty = false;
    };
    img.src = bgObjUrl;
  }
}

bgModeSelect?.addEventListener('change', () => setBackgroundMode(bgModeSelect.value, bgModeSelect.value !== 'color'));
bgPickBtn?.addEventListener('click', pickBackgroundMedia);
bgClearBtn?.addEventListener('click', () => clearBackgroundMedia(true));
bgMediaInput?.addEventListener('change', e => handleBackgroundMediaFile(e.target.files[0]));

// Look presets for fast B&W/quote variations.
const LOOK_PRESETS = {
  gradshow: {
    text: '',
    font: 'jubilee',
    layout: 'repeat',
    textColor: '#016F17',
    bgColor: '#D4FED3',
    size: 116,
    lineHeight: 84,
    scroll: 0,
    ratio: [3, 2],
    weather: 'normal',
    wind: 100,
    turbulence: 30,
    gravity: -10,
    poleColor: null,
    defaultImage: true,
  },
  'bw-classic': {
    text: 'What if form remembers?',
    font: 'jubilee',
    layout: 'repeat',
    textColor: '#111111',
    bgColor: '#F7F7F4',
    size: 126,
    lineHeight: 82,
    scroll: 0,
    ratio: [5, 5],
    weather: 'normal',
    wind: 92,
    turbulence: 24,
    gravity: -10,
    poleColor: null,
  },
  'bw-invert': {
    text: 'Hold the signal.',
    font: 'diatype',
    layout: 'centered',
    textColor: '#FFFFFF',
    bgColor: '#070707',
    size: 96,
    lineHeight: 94,
    scroll: 0,
    ratio: [4, 5],
    weather: 'normal',
    wind: 86,
    turbulence: 18,
    gravity: -10,
    poleColor: '#FFFFFF',
  },
  kinetic: {
    text: 'Make it move',
    font: 'jubilee',
    layout: 'repeat',
    textColor: '#0A0A0A',
    bgColor: '#FFFFFF',
    size: 88,
    lineHeight: 76,
    scroll: 200,
    ratio: [7, 4],
    weather: 'normal',
    wind: 122,
    turbulence: 34,
    gravity: -10,
    poleColor: null,
  },
  'storm-signal': {
    text: 'Against the wind',
    font: 'diatype',
    layout: 'repeat',
    textColor: '#FFFFFF',
    bgColor: '#05070B',
    size: 104,
    lineHeight: 90,
    scroll: 0,
    ratio: [3, 2],
    weather: 'storm',
    wind: 188,
    turbulence: 58,
    gravity: -8,
    poleColor: '#FFFFFF',
    scene: 'storm',
  },
  moon: {
    text: '',
    font: 'jubilee',
    layout: 'repeat',
    textColor: '#111111',
    bgColor: '#0B1020',
    flagColor: '#F4F7EE',
    size: 112,
    lineHeight: 84,
    scroll: 0,
    ratio: [3, 2],
    weather: 'normal',
    wind: 82,
    turbulence: 18,
    gravity: -10,
    poleColor: '#FFFFFF',
    scene: 'moon',
    defaultImage: true,
  },
};

let bwToggleInverted = false;
function resetBwToggle() {
  bwToggleInverted = false;
  const btn = lookRow?.querySelector('[data-look="bw-toggle"]');
  if (btn) btn.textContent = 'B&W';
}
function resolveLookKey(key) {
  if (key !== 'bw-toggle') {
    resetBwToggle();
    return key;
  }
  const resolved = bwToggleInverted ? 'bw-invert' : 'bw-classic';
  bwToggleInverted = !bwToggleInverted;
  const btn = lookRow?.querySelector('[data-look="bw-toggle"]');
  if (btn) btn.textContent = resolved === 'bw-invert' ? 'Invert' : 'B&W';
  return resolved;
}

function matchingRatioPreset(aw, ah) {
  const target = aw / ah;
  for (const btn of ratioRow.querySelectorAll('[data-r]')) {
    const [h, w] = btn.dataset.r.split(':').map(Number);
    if (Math.abs((w / h) - target) < 0.01) return btn.dataset.r;
  }
  return null;
}

function setCustomRatioPreset(aw, ah) {
  customAW = aw;
  customAH = ah;
  const match = matchingRatioPreset(aw, ah);
  if (match) {
    activeRatio = match;
    setActiveByData(ratioRow, '[data-r]', 'r', match);
  } else {
    ensureCustomMode();
  }
  updateMiniPreview();
  smoothRatioUpdate(aw, ah);
}

function setRangeValue(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

function applyLookPreset(key) {
  if (key === 'camera') {
    resetBwToggle();
    clearLookSceneEffects();
    restoreDefaultSceneCamera();
    if (liveVideoActive) {
      clearImage();
      setActiveByData(lookRow, '[data-look]', 'look', 'gradshow');
      return;
    }
    setBackgroundMode('color');
    setBackgroundColor('#F7F7F4');
    setPoleColorOverride(null);
    toggleLiveCamera();
    return;
  }
  key = resolveLookKey(key);
  const preset = LOOK_PRESETS[key];
  if (!preset) return;
  const hadSceneView = sceneViewMode !== 'default' || MOON.active || LIGHTNING.active;
  clearLookSceneEffects();
  stopLiveCamera();
  setBackgroundMode('color');
  currentText = preset.text;
  textInput.value = preset.text;
  _textWasEmpty = !preset.text.trim();
  textLayoutUserSet = true;
  setTextFont(preset.font);
  setTextLayout(preset.layout);
  setRangeValue(fontSizeSlider, preset.size);
  setRangeValue(lineHeightSlider, preset.lineHeight);
  setRangeValue(scrollSpeedSlider, preset.scroll);
  setTextColor(preset.textColor, false);
  setBackgroundColor(preset.bgColor);
  if (preset.flagColor) setFlagColorOnly(preset.flagColor);
  setPoleColorOverride(preset.poleColor || null);
  if (preset.ratio) setCustomRatioPreset(preset.ratio[0], preset.ratio[1]);
  if (preset.weather) {
    setActiveByData(weatherRow, '[data-weather]', 'weather', preset.weather);
    setWeather(preset.weather);
  }
  if (Number.isFinite(preset.wind)) setRangeValue(document.getElementById('windStrength'), preset.wind);
  if (Number.isFinite(preset.turbulence)) setRangeValue(document.getElementById('turbulence'), preset.turbulence);
  if (Number.isFinite(preset.gravity)) setRangeValue(document.getElementById('gravity'), preset.gravity);
  setUnlitMode(false);
  if (preset.defaultImage) {
    clearBackgroundMedia(true);
    loadedImage = null;
    imageTexActive = false;
    if (activeObjUrl) { URL.revokeObjectURL(activeObjUrl); activeObjUrl = null; }
    loadDefaultTexture();
  }
  if (preset.scene === 'storm') {
    setLightningActive(true);
    applyStormCamera();
  } else if (preset.scene === 'moon') {
    MOON.active = true;
    applyMoonCamera();
  } else if (hadSceneView) {
    restoreDefaultSceneCamera();
  }
  refreshTexture();
}

const lookRow = document.getElementById('lookRow');
lookRow?.addEventListener('click', e => {
  const btn = e.target.closest('[data-look]');
  if (!btn) return;
  setActiveButton(lookRow, '[data-look]', btn);
  applyLookPreset(btn.dataset.look);
});

// File handling
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const texPreview = document.getElementById('texPreview');
const previewImg = document.getElementById('previewImg');
const previewVideo = document.getElementById('previewVideo');
const fitToggle = document.getElementById('fitToggle');
const cameraBtn = document.getElementById('cameraBtn');
const cameraInput = document.getElementById('cameraInput');
let activeObjUrl = null;
let cameraStream = null;

function showPreview(url) {
  if (previewVideo) previewVideo.style.display = 'none';
  previewImg.src = url;
  previewImg.style.display = 'block';
  texPreview.style.display = 'block';
  dropzone.style.display = 'none';
  fitToggle.style.display = 'flex';
}

function showVideoPreview() {
  previewImg.removeAttribute('src');
  previewImg.style.display = 'none';
  if (previewVideo) previewVideo.style.display = 'block';
  texPreview.style.display = 'block';
  dropzone.style.display = 'none';
  fitToggle.style.display = 'flex';
}

function stopLiveCamera() {
  liveVideoActive = false;
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
  if (previewVideo) {
    previewVideo.pause();
    previewVideo.srcObject = null;
    previewVideo.style.display = 'none';
  }
  if (cameraBtn) {
    cameraBtn.textContent = 'Live Camera';
    cameraBtn.classList.remove('active');
  }
}

function clearImage() {
  stopLiveCamera();
  loadedImage = null; imageTexActive = false;
  if (activeObjUrl) { URL.revokeObjectURL(activeObjUrl); activeObjUrl = null; }
  previewImg.removeAttribute('src');
  previewImg.style.display = 'block';
  texPreview.style.display = 'none';
  dropzone.style.display = 'block';
  fitToggle.style.display = 'none';
  fileInput.value = '';
  if (cameraInput) cameraInput.value = '';
  setUnlitMode(false); // back to the lit cloth surface once the picture is gone
  refreshTexture();
}

function handleImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  stopLiveCamera();
  const url = URL.createObjectURL(file);
  if (activeObjUrl) URL.revokeObjectURL(activeObjUrl);
  activeObjUrl = url;
  const img = new Image();
  img.onload = () => {
    loadedImage = img;
    showPreview(url);
    // A dropped picture is almost always finished artwork — default to the
    // unlit/true-colour surface so it prints exactly as designed.
    setUnlitMode(true);
    refreshTexture();
  };
  img.src = url;
}

fileInput.addEventListener('change', e => { if (e.target.files[0]) handleImageFile(e.target.files[0]); });
cameraInput?.addEventListener('change', e => { if (e.target.files[0]) handleImageFile(e.target.files[0]); });

async function toggleLiveCamera() {
  if (liveVideoActive) {
    clearImage();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !previewVideo) {
    cameraInput?.click();
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    loadedImage = null;
    if (activeObjUrl) { URL.revokeObjectURL(activeObjUrl); activeObjUrl = null; }
    currentText = '';
    textInput.value = '';
    _textWasEmpty = true;
    if (textLayout === 'titleCard') {
      textLayoutUserSet = false;
      setTextLayout(defaultLayoutForFont(currentFont));
    }
    previewVideo.srcObject = cameraStream;
    await previewVideo.play();
    liveVideoActive = true;
    imageTexActive = true;
    showVideoPreview();
    if (cameraBtn) {
      cameraBtn.textContent = 'Stop Camera';
      cameraBtn.classList.add('active');
    }
    setUnlitMode(true);
    refreshTexture();
  } catch (err) {
    console.warn('Camera access failed:', err);
    stopLiveCamera();
    cameraInput?.click();
  }
}

cameraBtn?.addEventListener('click', toggleLiveCamera);
dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', e => { e.preventDefault(); dropzone.classList.remove('dragover'); handleImageFile(e.dataTransfer.files[0]); });
document.getElementById('removeTexture').addEventListener('click', clearImage);

// Stretch/Fit
fitToggle.addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  fitMode = btn.dataset.mode;
  setActiveButton(fitToggle, 'button', btn);
  refreshTexture();
});

// Global drop
const globalDrop = document.getElementById('globalDrop');
let gdc = 0;
document.addEventListener('dragenter', e => {
  e.preventDefault(); gdc++;
  if (e.dataTransfer.types.includes('Files')) globalDrop.classList.add('active');
});
document.addEventListener('dragleave', e => {
  e.preventDefault(); gdc--;
  if (gdc <= 0) { gdc = 0; globalDrop.classList.remove('active'); }
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault(); gdc = 0; globalDrop.classList.remove('active');
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith('image/')) handleImageFile(f);
});

// Reset
document.getElementById('resetBtn').addEventListener('click', () => {
  SIM.windStrength = 100; SIM.turbulence = 30;
  SIM.windAngle = 90; SIM.stiffness = 40; SIM.damping = 92;
  SIM.gravity = -1;
  SIM.opacity = 0;
  SIM.flagColor = [0.831, 0.996, 0.827];
  SIM.bgColor = [0.831, 0.996, 0.827];
  SUBSTEPS = 2;
  WEATHER.mode = 'normal';
  WEATHER.angleDriftMax = 24;
  WEATHER.angleDriftForce = 1.0;
  _savedWeather = null;
  clearLookSceneEffects();
  setActiveByData(weatherRow, '[data-weather]', 'weather', 'normal');
  setLightMode('studio');
  setActiveByData(lightRow, '[data-light]', 'light', 'studio');
  document.getElementById('windStrength').value = 100;
  document.getElementById('turbulence').value = 30;
  document.getElementById('gravity').value = -10;
  document.getElementById('windVal').textContent = '100';
  document.getElementById('turbVal').textContent = '30';
  document.getElementById('gravityVal').textContent = '-1.0';
  setBackgroundColor('#D4FED3');
  fontSizeSlider.value = 120; fontSizeVal.textContent = '120'; currentFontSize = 120;
  lineHeightSlider.value = 85; lineHeightVal.textContent = '0.85'; currentLineHeight = 0.85;
  currentFont = 'jubilee';
  if (fontSelect) fontSelect.value = 'jubilee';
  textLayoutUserSet = false;
  setTextLayout('repeat');
  textInput.value = ''; currentText = ''; _textWasEmpty = true;
  textScrollSpeed = 0; textScrollTime = 0;
  scrollSpeedSlider.value = 0; scrollVal.textContent = '0';
  setTextColor('#016F17', false);
  setPoleColorOverride(null);
  clearBackgroundMedia(true);
  lookRow?.querySelectorAll('[data-look]').forEach(b => b.classList.remove('active'));
  setActiveByData(lookRow, '[data-look]', 'look', 'gradshow');
  clearImage();
  setActiveByData(ratioRow, '[data-r]', 'r', '3:2');
  customRatioDiv.classList.remove('visible');
  activeRatio = '3:2';
  fullRebuild(3, 2);
  autoFrame();
  cam.tgtDist = cam.curDist = cam.tgtDist; // snap immediately
  cam.tgtTheta = 0.0; cam.tgtPhi = 0.12;
  cam.tgtRoll = 0.0; cam.roll = 0.0;
  cam.tgtTarget[0] = 0; cam.tgtTarget[1] = 0; cam.tgtTarget[2] = 0;
  cam.target[0] = 0; cam.target[1] = 0; cam.target[2] = 0;
  orbitAngularVel = 0;
  initGusts();
  loadDefaultTexture();
});

// ─── Export flag PNG (high-res, no pole, no bg) ──────────────
document.getElementById('exportBtn').addEventListener('click', () => {
  const btn = document.getElementById('exportBtn');
  btn.textContent = 'Rendering...';
  btn.style.pointerEvents = 'none';

  // Use requestAnimationFrame so UI updates before heavy work
  requestAnimationFrame(() => {
    try { exportFlagPNG(); }
    catch (e) { console.error('Export failed:', e); }
    btn.textContent = 'Export Flag PNG';
    btn.style.pointerEvents = '';
  });
});

function exportFlagPNG() {
  const [outW, outH] = getExportSize();
  return renderFlagToBlob(outW, outH, matteMode)
    .then(blob => downloadBlob(blob, `flag-${outW}x${outH}.png`));
}

// Helper: trigger a browser download for a Blob. The anchor must be in the
// document — Firefox ignores clicks on detached anchors, and Safari is more
// reliable with it attached too.
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
}

// ── PDF export via jsPDF (loaded on demand from CDN, like the MP4 muxer) ──
let _jspdfMod = null;
async function getJsPDF() {
  if (_jspdfMod) return _jspdfMod;
  const mod = await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm');
  _jspdfMod = mod.jsPDF || (mod.default && (mod.default.jsPDF || mod.default)) || mod;
  return _jspdfMod;
}
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}
// Single-page PDF: A5 (mm, true print size) for the print preset, otherwise a
// page sized to the image pixels.
async function exportFlagPDF() {
  const btn = document.getElementById('pdfBtn');
  const prev = btn ? btn.textContent : '';
  if (btn) { btn.textContent = 'PDF…'; btn.style.pointerEvents = 'none'; }
  try {
    const [outW, outH] = getExportSize();
    const JsPDF = await getJsPDF();
    const blob = await renderFlagToBlob(outW, outH, matteMode);
    const dataUrl = await blobToDataURL(blob);
    const portrait = outH >= outW;
    const doc = someFormat === 'print'
      ? new JsPDF({ unit: 'mm', format: 'a5', orientation: portrait ? 'portrait' : 'landscape' })
      : new JsPDF({ unit: 'px', format: [outW, outH], orientation: portrait ? 'portrait' : 'landscape' });
    const pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight();
    doc.addImage(dataUrl, 'PNG', 0, 0, pw, ph);
    // Save through our own anchor download instead of doc.save() — jsPDF's
    // bundled FileSaver falls back to window.open on Safari, where the popup
    // blocker eats the PDF silently (no error, nothing in Downloads).
    downloadBlob(doc.output('blob'), `flag-${outW}x${outH}.pdf`);
  } catch (e) {
    console.error('PDF export failed:', e);
    alert('PDF export failed: ' + (e && e.message ? e.message : e));
  }
  if (btn) { btn.textContent = prev || 'Export PDF'; btn.style.pointerEvents = ''; }
}

// Render the current flag to a PNG Blob at outW×outH using the high-res
// interpolated mesh (+2× supersample when the GPU allows). matte=true drops
// all specular/sheen. Shared by the single-PNG button and the CSV batch.
function renderFlagToBlob(outW, outH, matte, transparent, mime = 'image/png', quality) {
  const restorePreviewTexture = prepareFullTextureForExport();
  // 2× supersample if the GPU can host the larger renderbuffer/texture.
  const maxRb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const maxDim = Math.min(maxRb, maxTex);
  const ss = (outW * 2 <= maxDim && outH * 2 <= maxDim) ? 2 : 1;
  const w = outW * ss, h = outH * ss;

  // ── Camera matching current view ──
  const mainFOV = Math.PI / 4.5;
  const vFrac = someActive ? (someCrop.h / window.innerHeight) : 1.0;
  const fov = 2 * Math.atan(vFrac * Math.tan(mainFOV / 2));
  const asp = w / h;
  const eye = eyePos();
  const target = cam.target;

  // ── Create FBO ──
  const fbo = gl.createFramebuffer();
  const fboTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, fboTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
  const depthBuf = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuf);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuf);

  // ── Render high-res flag to FBO ──
  gl.viewport(0, 0, w, h);
  // transparent → clear fully transparent and skip the bg quad so only the flag's
  // textured/opaque pixels survive (alpha channel preserved for compositing).
  gl.clearColor(transparent ? 0 : SIM.bgColor[0], transparent ? 0 : SIM.bgColor[1],
                transparent ? 0 : SIM.bgColor[2], transparent ? 0 : 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  if (!transparent) {
    // Background quad
    gl.disable(gl.DEPTH_TEST);
    drawBackgroundQuad(w, h);
    drawLightningBolts(w, h);
    gl.enable(gl.DEPTH_TEST);
  }

  gl.enable(gl.BLEND);
  // Separate alpha factors (src ONE) so the alpha channel accumulates straight
  // instead of being squared by SRC_ALPHA when drawing over the clear.
  if (transparent) gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const ld = KEY_LIGHT;
  const ll = Math.sqrt(ld[0] ** 2 + ld[1] ** 2 + ld[2] ** 2);

  gl.useProgram(prog);
  gl.uniform1f(loc.uPartyTime, 0.0);
  gl.uniformMatrix4fv(loc.uProj, false, perspective(fov, asp, 0.1, 100));
  gl.uniformMatrix4fv(loc.uView, false, lookAt(eye, target, rolledUp(eye, target, cam.roll)));
  gl.uniform3f(loc.uLight, ld[0] / ll, ld[1] / ll, ld[2] / ll);
  gl.uniform3f(loc.uEye, eye[0], eye[1], eye[2]);
  gl.uniform1f(loc.uAmbient, 0.38);
  gl.uniform1f(loc.uLightning, lightningValue());

  setModelMatrix(MODEL_IDENTITY);
  gl.uniform1i(loc.uIsGlass, 0);
  gl.uniform1f(loc.uMoonSurface, 0.0);
  gl.uniform1f(loc.uMatte, matte ? 1.0 : 0.0);
  gl.uniform1f(loc.uUnlit, unlitMode ? 1.0 : 0.0);
  gl.uniform3f(loc.uColor, SIM.flagColor[0], SIM.flagColor[1], SIM.flagColor[2]);
  gl.uniform1f(loc.uAlpha, SIM.opacity);
  if (hasTex && flagTex) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, flagTex);
    gl.uniform1i(loc.uTex, 0);
    gl.uniform1i(loc.uHasTex, 1);
  } else {
    gl.uniform1i(loc.uHasTex, 0);
  }
  setMaskUniforms(isCustomShape());

  bindClothBuffers();
  drawCloth(rIndexData.length);
  gl.disable(gl.BLEND);

  // Read pixels
  const pixels = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  if (transparent) {
    // GL left RGB premultiplied by alpha; un-premultiply for straight-alpha PNG
    // (otherwise text/edges pick up a dark fringe when composited).
    for (let p = 0; p < pixels.length; p += 4) {
      const a = pixels[p + 3];
      if (a === 0) { pixels[p] = pixels[p + 1] = pixels[p + 2] = 0; }
      else if (a < 255) {
        pixels[p]     = Math.min(255, Math.round(pixels[p]     * 255 / a));
        pixels[p + 1] = Math.min(255, Math.round(pixels[p + 1] * 255 / a));
        pixels[p + 2] = Math.min(255, Math.round(pixels[p + 2] * 255 / a));
      }
    }
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); // restore default blend
  }

  // Cleanup FBO + high-res buffers — restore main canvas
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(fboTex);
  gl.deleteRenderbuffer(depthBuf);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 1);

  // Flip Y → 2D canvas (at supersample resolution).
  const ssCanvas = document.createElement('canvas');
  ssCanvas.width = w; ssCanvas.height = h;
  const ssCtx = ssCanvas.getContext('2d');
  const imgData = ssCtx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4;
    const dst = y * w * 4;
    imgData.data.set(pixels.subarray(src, src + w * 4), dst);
  }
  ssCtx.putImageData(imgData, 0, 0);

  // Downscale to target with high-quality smoothing (poor-man's MSAA).
  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const ctx2 = out.getContext('2d');
  if (ss > 1) {
    ctx2.imageSmoothingEnabled = true;
    ctx2.imageSmoothingQuality = 'high';
    ctx2.drawImage(ssCanvas, 0, 0, outW, outH);
  } else {
    ctx2.drawImage(ssCanvas, 0, 0);
  }

  return new Promise(resolve => out.toBlob(blob => {
    if (restorePreviewTexture) restorePreviewTexture();
    resolve(blob);
  }, mime, quality));
}

// ─── SoMe Export ────────────────────────────────────────────
const SOME_FORMATS = { '1:1': [1080,1080], '4:5': [1080,1350], '9:16': [1080,1920], '16:9': [1920,1080], 'print': [1748,2480], 'tagsvideo': [1920,1080] };
let someFormat = '1:1', someActive = false, someRecording = false;
let someLoop = 'seamless'; // 'seamless' | 'cut'
let someAudio = 'none'; // 'none' | '1' | '2' | '3' | '4'
const SOUND_VOLUME = 0.3;
const AUDIO_TRACKS = {
  '1': 'music/1-WdKA-Low.wav',
  '2': 'music/2-WdKA-Mid.wav',
  '3': 'music/3-WdKA-High.wav',
  '4': 'music/4-WdKA-Very-High.wav',
};
const audioPreview = new Audio();
audioPreview.loop = true;
audioPreview.preload = 'auto';
audioPreview.volume = SOUND_VOLUME;
const someCrop = { x: 0, y: 0, w: 0, h: 0 };
const someFrame = document.getElementById('someFrame');
const someLabel = document.getElementById('someLabel');

function setActiveTab(which) {
  setActiveByData(document, '.panel-tab', 'tab', which);
  document.getElementById('tabStudio').classList.toggle('active', which === 'studio');
  document.getElementById('tabWind').classList.toggle('active', which === 'wind');
  document.getElementById('tabExport').classList.toggle('active', which === 'export');
  if (which === 'export') {
    someActive = true;
    initSomeCrop();
    someFrame.style.display = 'block';
    showPole = false;
  } else {
    someActive = false;
    someFrame.style.display = 'none';
    showPole = true;
  }
}

// Tab switching — auto-show/hide crop frame
document.querySelector('.panel-tabs').addEventListener('click', e => {
  const tab = e.target.closest('.panel-tab');
  if (!tab) return;
  setActiveTab(tab.dataset.tab);
});

const sizeWInput = document.getElementById('sizeW');
const sizeHInput = document.getElementById('sizeH');

function getExportSize() {
  const w = Math.max(64, Math.min(16384, parseInt(sizeWInput.value, 10) || 1080));
  const h = Math.max(64, Math.min(16384, parseInt(sizeHInput.value, 10) || 1080));
  return [w, h];
}

function initSomeCrop() {
  const [w, h] = getExportSize();
  const a = w / h;
  if (isMobileViewport()) {
    const sheet = document.getElementById('mobileSheet');
    const sheetOpen = document.body.classList.contains('mobile-sheet-open') && sheet;
    const bottomClear = sheetOpen ? sheet.getBoundingClientRect().height + 16 : 96;
    const maxW = Math.max(240, window.innerWidth - 24);
    const maxH = Math.max(180, window.innerHeight - bottomClear - 28);
    let cropW, cropH;
    if (maxW / maxH >= a) { cropH = maxH; cropW = cropH * a; }
    else { cropW = maxW; cropH = cropW / a; }
    someCrop.w = cropW; someCrop.h = cropH;
    someCrop.x = (window.innerWidth - cropW) / 2;
    someCrop.y = 14 + (maxH - cropH) / 2;
    updateSomeFrame();
    return;
  }
  // Make the crop (= exact export bounds) as large as the layout allows so the
  // preview reads as WYSIWYG. The crop stays centred — the export FOV math
  // assumes a centred crop — so reserve room on both sides to clear the left
  // control panel (off-screen when collapsed). Contain-fit the export aspect.
  const collapsed = panel.classList.contains('collapsed');
  const sideClear = collapsed ? 48 : 350; // 16 + 310 panel + margin
  const maxW = Math.max(240, window.innerWidth - sideClear * 2);
  const maxH = window.innerHeight * 0.86;
  let cropW, cropH;
  if (maxW / maxH >= a) { cropH = maxH; cropW = cropH * a; }
  else { cropW = maxW; cropH = cropW / a; }
  someCrop.w = cropW; someCrop.h = cropH;
  someCrop.x = (window.innerWidth - cropW) / 2;
  someCrop.y = (window.innerHeight - cropH) / 2;
  updateSomeFrame();
}

function updateSomeFrame() {
  const s = someFrame.style;
  s.left = someCrop.x + 'px'; s.top = someCrop.y + 'px';
  s.width = someCrop.w + 'px'; s.height = someCrop.h + 'px';
  const [w, h] = getExportSize();
  const suffix = someFormat === 'print' ? 'A5 \u00b7 300 DPI' : '@25fps';
  someLabel.textContent = w + '\u00d7' + h + ' \u00b7 ' + suffix;
}

function setDisplay(id, value) {
  const el = document.getElementById(id);
  if (el) el.style.display = value;
}

// The batch section serves two presets: print (CSV → ZIP/PDF stills) and
// tagsvideo (CSV → one 10s MP4 per row). Swap label + action buttons.
function setBatchSectionMode(isVideo) {
  const label = document.getElementById('batchSectionLabel');
  if (label) label.textContent = isVideo ? 'Batch · CSV → MP4s' : 'Batch · CSV → ZIP';
  setDisplay('batchExportBtn', isVideo ? 'none' : '');
  setDisplay('batchPdfBtn', isVideo ? 'none' : '');
  setDisplay('batchVideoBtn', isVideo ? '' : 'none');
  updateBatchLoadedStatus();
}

document.getElementById('someRow').addEventListener('click', e => {
  const btn = e.target.closest('[data-some]');
  if (!btn) return;
  someFormat = btn.dataset.some;
  setActiveButton(document.getElementById('someRow'), '.pill', btn);
  const ffiSection = document.getElementById('ffiSection');
  const batchSection = document.getElementById('batchSection');
  const singlePdfBtn = document.getElementById('pdfBtn');
  // Print and Tags Video are both title-card presets sharing the Name Tag Text
  // blocks; print gets the CSV→ZIP/PDF machinery, tagsvideo the CSV→MP4-per-row.
  if (someFormat === 'print' || someFormat === 'tagsvideo') {
    const isPrint = someFormat === 'print', isVideo = someFormat === 'tagsvideo';
    ffiSection.style.display = '';
    batchSection.style.display = (isPrint || isVideo) ? '' : 'none';
    setBatchSectionMode(isVideo);
    if (singlePdfBtn) singlePdfBtn.style.display = isPrint ? '' : 'none';
    // Video preset: 10s MP4 is the only deliverable — drop the stills buttons
    // and the cloth pills (full motion is forced by the preset).
    setDisplay('exportBtn', isVideo ? 'none' : '');
    setDisplay('someSeqBtn', isVideo ? 'none' : '');
    if (isPrint) applyPrintPreset();
    else applyTagsVideoPreset();
    someActive = true;
    initSomeCrop();
    someFrame.style.display = 'block';
    return;
  }
  ffiSection.style.display = 'none';
  batchSection.style.display = 'none';
  if (singlePdfBtn) singlePdfBtn.style.display = '';
  setDisplay('exportBtn', '');
  setDisplay('someSeqBtn', '');
  // Leaving print/tagsvideo — restore the studio surface + generic text rendering.
  matteMode = false;
  const mt = document.getElementById('matteToggle');
  if (mt) mt.checked = false;
  if (textLayout === 'titleCard') {
    textLayout = 'repeat';
    refreshTexture();
  }
  const [fw, fh] = SOME_FORMATS[someFormat];
  sizeWInput.value = fw;
  sizeHInput.value = fh;
  if (someActive) initSomeCrop();
});

document.getElementById('audioRow').addEventListener('click', e => {
  const btn = e.target.closest('[data-audio]');
  if (!btn) return;
  if (btn.classList.contains('active')) {
    someAudio = 'none';
    btn.classList.remove('active');
    stopAudioPreview();
    return;
  }
  someAudio = btn.dataset.audio;
  setActiveButton(document.getElementById('audioRow'), '.pill', btn);
  playAudioPreview(someAudio);
});

const loopModeRow = document.getElementById('loopModeRow');
if (loopModeRow) loopModeRow.addEventListener('click', e => {
  const btn = e.target.closest('[data-loop]');
  if (!btn || btn.classList.contains('active')) return;
  someLoop = btn.dataset.loop === 'cut' ? 'cut' : 'seamless';
  setActiveByData(loopModeRow, '[data-loop]', 'loop', someLoop);
});

function stopAudioPreview() {
  audioPreview.pause();
  audioPreview.removeAttribute('src');
  audioPreview.load();
}

function playAudioPreview(trackId) {
  const src = AUDIO_TRACKS[trackId];
  if (!src) return;
  audioPreview.pause();
  audioPreview.src = encodeURI(src);
  audioPreview.volume = SOUND_VOLUME;
  audioPreview.currentTime = 0;
  audioPreview.play().catch(e => console.warn('Audio preview failed:', e));
}


// ─── Film Festival Intro (FFI) ──────────────────────────────
// rAF-coalesced texture refresh so size sliders feel buttery.
let _ffiRefreshRaf = null;
function ffiQueueRefresh() {
  if (_ffiRefreshRaf || textLayout !== 'titleCard') return;
  _ffiRefreshRaf = requestAnimationFrame(() => { _ffiRefreshRaf = null; refreshTexture(); });
}

// Live block edits.
for (let i = 0; i < titleBlocks.length; i++) {
  const txt = document.getElementById('ffiText' + i);
  const sz = document.getElementById('ffiSize' + i);
  const szVal = document.getElementById('ffiSizeVal' + i);
  // Seed input values from titleBlocks defaults.
  txt.value = titleBlocks[i].text;
  sz.value = titleBlocks[i].size;
  szVal.textContent = titleBlocks[i].size;
  txt.addEventListener('input', () => {
    titleBlocks[i].text = txt.value;
    ffiQueueRefresh();
    updateFFILayoutBars();
  });
  sz.addEventListener('input', () => {
    titleBlocks[i].size = +sz.value;
    szVal.textContent = sz.value;
    ffiQueueRefresh();
    updateFFILayoutBars();
  });
}

// Mini-flag preview: render three draggable bars representing each block's
// vertical center. Bar height scales with font size; drag updates block.y.
const ffiLayoutFlag = document.getElementById('ffiLayoutFlag');
const ffiLayoutBars = ffiLayoutFlag ? ffiLayoutFlag.querySelectorAll('.ffi-layout-block') : [];
function updateFFILayoutBars() {
  if (!ffiLayoutFlag) return;
  const flagPxH = ffiLayoutFlag.clientHeight || 217;
  // Approximate the rendered text extent in the preview by mirroring the
  // texture math (size * texW/800), expressed as a fraction of texH and
  // scaled to flagPxH. Multi-line text grows the bar to match.
  const maxDim = liveTextureMaxDim();
  const tallW = aspectW >= aspectH ? maxDim : maxDim * (aspectW / aspectH);
  const tallH = aspectW >= aspectH ? maxDim * (aspectH / aspectW) : maxDim;
  for (let i = 0; i < ffiLayoutBars.length; i++) {
    const bar = ffiLayoutBars[i];
    const b = titleBlocks[i];
    if (!b) { bar.style.display = 'none'; continue; }
    const sz = b.size * (tallW / 800);
    const nLines = Math.max(1, b.text.split(/\r?\n/).length);
    const fracH = (nLines * sz * (b.lineH || 1.0)) / tallH;
    const barH = Math.max(10, fracH * flagPxH);
    bar.style.top = (b.y * 100) + '%';
    bar.style.height = barH + 'px';
    const label = bar.querySelector('span');
    if (label) label.textContent = b.text.trim()
      ? (i + 1) + ' · ' + b.text.split(/\r?\n/)[0].slice(0, 16)
      : String(i + 1);
  }
}

// Drag handling per bar.
ffiLayoutBars.forEach((bar, i) => {
  let dragging = false;
  const onDown = (clientY, e) => {
    dragging = true;
    bar.classList.add('dragging');
    e.preventDefault();
  };
  const onMove = (clientY) => {
    if (!dragging) return;
    const r = ffiLayoutFlag.getBoundingClientRect();
    const y = clamp((clientY - r.top) / r.height, 0, 1);
    titleBlocks[i].y = y;
    bar.style.top = (y * 100) + '%';
    ffiQueueRefresh();
  };
  const onUp = () => { dragging = false; bar.classList.remove('dragging'); };
  bar.addEventListener('mousedown', e => onDown(e.clientY, e));
  window.addEventListener('mousemove', e => onMove(e.clientY));
  window.addEventListener('mouseup', onUp);
  bar.addEventListener('touchstart', e => onDown(e.touches[0].clientY, e), { passive: false });
  window.addEventListener('touchmove', e => { if (dragging) { onMove(e.touches[0].clientY); e.preventDefault(); } }, { passive: false });
  window.addEventListener('touchend', onUp);
});
// Initial paint.
updateFFILayoutBars();

// ─── Mobile quick toolbar / modal sheets ─────────────────────
const mobileToolbar = document.getElementById('mobileToolbar');
const mobileSheet = document.getElementById('mobileSheet');
const mobileSheetTitle = document.getElementById('mobileSheetTitle');
const mobileSheetBody = document.getElementById('mobileSheetBody');
const mobileSheetClose = document.getElementById('mobileSheetClose');
const mobileSheetBackdrop = document.getElementById('mobileSheetBackdrop');
let mobileMovedNodes = [];
let mobileModeInitialized = false;

const mobileSheetConfig = {
  text: {
    title: 'Text',
    tab: 'studio',
    getNodes: () => [document.getElementById('sectionText'), document.getElementById('sectionLooks')],
  },
  image: {
    title: 'Image',
    tab: 'studio',
    getNodes: () => [document.getElementById('sectionImage')],
  },
  colors: {
    title: 'Colors',
    tab: 'studio',
    getNodes: () => [document.getElementById('sectionColors')],
  },
  ratio: {
    title: 'Ratio',
    tab: 'studio',
    getNodes: () => [document.getElementById('sectionRatio')],
  },
  export: {
    title: 'Export',
    tab: 'export',
    getNodes: () => Array.from(document.getElementById('tabExport').children)
      .filter(el => el.classList && el.classList.contains('section')),
  },
};

function setMobileToolActive(key) {
  if (!mobileToolbar) return;
  mobileToolbar.querySelectorAll('[data-mobile-sheet]')
    .forEach(btn => btn.classList.toggle('active', btn.dataset.mobileSheet === key));
}

function moveNodeToMobileSheet(node) {
  if (!node || !node.parentNode || node.parentNode === mobileSheetBody) return;
  const marker = document.createComment('mobile-sheet-placeholder');
  node.parentNode.insertBefore(marker, node);
  node.__mobileSheetMarker = marker;
  mobileMovedNodes.push(node);
  mobileSheetBody.appendChild(node);
}

function restoreMobileNodes() {
  if (!mobileSheetBody) return;
  for (const node of mobileMovedNodes) {
    const marker = node.__mobileSheetMarker;
    if (marker && marker.parentNode) {
      marker.parentNode.insertBefore(node, marker);
      marker.remove();
    }
    delete node.__mobileSheetMarker;
  }
  mobileMovedNodes = [];
  mobileSheetBody.textContent = '';
}

function closeMobileSheet() {
  if (!mobileSheet) return;
  restoreMobileNodes();
  mobileSheet.classList.remove('open');
  mobileSheet.setAttribute('aria-hidden', 'true');
  mobileSheetBackdrop?.classList.remove('active');
  document.body.classList.remove('mobile-sheet-open');
  setMobileToolActive(null);
  if (someActive) requestAnimationFrame(initSomeCrop);
}

function openMobileSheet(key) {
  const cfg = mobileSheetConfig[key];
  if (!cfg) return;
  if (!isMobileViewport()) {
    setActiveTab(cfg.tab);
    panel.classList.remove('collapsed');
    return;
  }
  restoreMobileNodes();
  setActiveTab(cfg.tab);
  panel.classList.add('collapsed');
  mobileSheetTitle.textContent = cfg.title;
  for (const node of cfg.getNodes()) moveNodeToMobileSheet(node);
  mobileSheet.classList.add('open');
  mobileSheet.setAttribute('aria-hidden', 'false');
  mobileSheetBackdrop?.classList.add('active');
  document.body.classList.add('mobile-sheet-open');
  setMobileToolActive(key);
  if (someActive) requestAnimationFrame(initSomeCrop);
}

function syncMobileMode() {
  if (isMobileViewport()) {
    if (!mobileModeInitialized) {
      panel.classList.add('collapsed');
      mobileModeInitialized = true;
    }
  } else {
    closeMobileSheet();
    panel.classList.remove('collapsed');
    mobileModeInitialized = false;
  }
  resize();
  if (someActive) initSomeCrop();
}

if (mobileToolbar) {
  mobileToolbar.addEventListener('click', e => {
    const btn = e.target.closest('[data-mobile-sheet]');
    if (!btn) return;
    openMobileSheet(btn.dataset.mobileSheet);
  });
}
mobileSheetClose?.addEventListener('click', closeMobileSheet);
mobileSheetBackdrop?.addEventListener('click', closeMobileSheet);
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('mobile-sheet-open')) closeMobileSheet();
});
if (MOBILE_QUERY.addEventListener) MOBILE_QUERY.addEventListener('change', syncMobileMode);
else MOBILE_QUERY.addListener(syncMobileMode);
syncMobileMode();

// ─── Name Tags print preset + CSV batch export ─────────────────────
function applyTitleCardPreset({ format, width, height, matte, cameraDist, updateBatch }) {
  textLayout = 'titleCard';        // cloth text comes from titleBlocks
  textLayoutUserSet = true;

  fullRebuild(2.4, 2.9);
  customAW = 2.4; customAH = 2.9;
  activeRatio = null;
  setActiveByData(ratioRow, '[data-r]', 'r', '__title-card__');
  if (typeof updateMiniPreview === 'function') updateMiniPreview();

  ATTACH.mode = 'edge';
  applyPinning();
  setActiveByData(attachRow, '.pill', 'attach', 'edge');

  matteMode = !!matte;
  if (matteToggle) matteToggle.checked = matteMode;

  setBackgroundColor('#D3FED1');
  setTextColor('#00330A', false);
  setPoleColorOverride(null);

  cam.tgtTheta = 0; cam.tgtPhi = 0; cam.tgtRoll = 0;
  cam.tgtTarget[0] = 1.191;
  cam.tgtTarget[1] = 0.782;
  cam.tgtTarget[2] = 0;
  cam.tgtDist = cameraDist;
  cam.curTheta = cam.tgtTheta;
  cam.curPhi = cam.tgtPhi;
  cam.curDist = cam.tgtDist;
  cam.curRoll = cam.roll = cam.tgtRoll;
  cam.target[0] = cam.tgtTarget[0];
  cam.target[1] = cam.tgtTarget[1];
  cam.target[2] = cam.tgtTarget[2];

  sizeWInput.value = width;
  sizeHInput.value = height;
  someFormat = format;
  setActiveByData(document.getElementById('someRow'), '.pill', 'some', format);
  if (updateBatch) updateBatchButtonLabels();

  refreshTexture(); // repaint title card with the seeded text colour
}

// Portrait A5 @ 300 DPI with matte on. It seeds the print palette but otherwise
// leaves fonts/sizes driven entirely by the live UI controls.
function applyPrintPreset() {
  applyTitleCardPreset({
    format: 'print',
    width: 1748,
    height: 2480,
    matte: true,
    cameraDist: 4.233,
    updateBatch: true,
  });
}

// Name Tags Video — the name-tag flag as a 16:9 video, batched: the CSV that
// feeds the print run feeds this too, but every row becomes its own 10s MP4
// (1920×1080). No PNG/PDF outputs here.
function applyTagsVideoPreset() {
  applyTitleCardPreset({
    format: 'tagsvideo',
    width: 1920,
    height: 1080,
    matte: false,
    cameraDist: 4.8,
  });
}

// CSV → records. Tolerates quotes, embedded delimiters/newlines, CRLF and a BOM.
function parseCSV(text, delim = ',') {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Sniff the delimiter from the header line. Excel in many (esp. European)
// locales saves `;`-separated CSVs; the old comma-only parser dumped a whole
// such row into one field, which then overflowed the tag as a single line.
function sniffDelimiter(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const line = text.split(/\r?\n/).find(l => l.trim() !== '') || '';
  let best = ',', bestN = -1;
  for (const d of [',', ';', '\t']) {
    let n = 0, inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQ = !inQ;
      else if (c === d && !inQ) n++;
    }
    if (n > bestN) { bestN = n; best = d; }
  }
  return best;
}

// Column header aliases → tag block. Lets people reorder/rename columns or
// add an "ig"/"instagram" handle column and still have it land correctly.
const CSV_ALIASES = {
  project: ['project', 'title', 'flag', 'headline', 'work'],
  name:    ['name', 'student', 'fullname', 'full name', 'author'],
  extra:   ['extra', 'discipline', 'course', 'programme', 'program', 'department', 'dept'],
  www:     ['www', 'ig', 'instagram', 'handle', 'social', 'url', 'web', 'website'],
};

function csvToRecords(text) {
  const delim = sniffDelimiter(text);
  const rows = parseCSV(text, delim).filter(r => r.some(c => c.trim() !== ''));
  if (!rows.length) return [];
  const head = rows[0].map(c => c.trim().toLowerCase());
  // Map each known field to a column by header name when a header is present.
  const idx = {};
  let hasHeader = false;
  for (const key in CSV_ALIASES) {
    const j = head.findIndex(h => CSV_ALIASES[key].includes(h));
    if (j !== -1) { idx[key] = j; hasHeader = true; }
  }
  // No recognizable header → assume the documented positional order.
  if (!hasHeader) { idx.project = 0; idx.name = 1; idx.extra = 2; idx.www = 3; }
  const body = (hasHeader ? rows.slice(1) : rows).slice(0, 300);
  const get = (r, k) => (idx[k] != null ? (r[idx[k]] || '') : '').trim();
  return body.map(r => ({
    project: get(r, 'project'),
    name:    get(r, 'name'),
    extra:   get(r, 'extra'),
    www:     get(r, 'www'),
  }));
}

// Canonical fillable template — single source of truth for both the in-app
// download button and the repo's flags-template.csv. `|` = forced line break.
const CSV_TEMPLATE = [
  'project,name,extra,www',
  "What Design|Can't Do,Albert Kozikowski,Graphic Design,@albertkozikowski",
  'Soft Systems,Mira Lindqvist,Social Practices,@miralindqvist',
  'After the Archive,Tomás Berg,Lens-Based Media,@tomasberg',
  'Holding Patterns,Yuki Tanaka,Graphic Design,@yukitanaka',
  'Ground Noise,Sam de Vries,Spatial Design,@samdevries',
  'Tender Machines,Noa Ben-Ami,,@noabenami',
  '',
].join('\n');

function downloadCSVTemplate() {
  downloadBlob(new Blob([CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' }), 'flags-template.csv');
}

// Filename-safe slug: strip accents, lowercase, dashes.
function slugify(s) {
  return (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Minimal dependency-free ZIP (STORE — PNGs are already compressed).
// files: [{ name, data: Uint8Array }] → Blob.
function makeZip(files) {
  const enc = new TextEncoder();
  const crcTable = makeZip._t || (makeZip._t = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })());
  const crc32 = (buf) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const u16 = n => new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF]);
  const u32 = n => new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]);
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name), data = f.data, crc = crc32(data);
    parts.push(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
               u32(crc), u32(data.length), u32(data.length),
               u16(nameBytes.length), u16(0), nameBytes, data);
    central.push({ nameBytes, crc, size: data.length, offset });
    offset += 30 + nameBytes.length + data.length;
  }
  const cd = []; let cdSize = 0;
  for (const c of central) {
    cd.push(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
            u32(c.crc), u32(c.size), u32(c.size),
            u16(c.nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0),
            u32(c.offset), c.nameBytes);
    cdSize += 46 + c.nameBytes.length;
  }
  const eocd = [u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
                u32(cdSize), u32(offset), u16(0)];
  return new Blob([...parts, ...cd, ...eocd], { type: 'application/zip' });
}

// Batch state + wiring.
const csvInput = document.getElementById('csvInput');
const csvDrop = document.getElementById('csvDrop');
const batchStatus = document.getElementById('batchStatus');
const batchExportBtn = document.getElementById('batchExportBtn');
const matteToggle = document.getElementById('matteToggle');
let batchRecords = [];
let batchExporting = false, batchCancel = false;
let batchVideoExporting = false, batchVideoCancel = false;

if (matteToggle) matteToggle.addEventListener('change', () => { matteMode = matteToggle.checked; });

function setUnlitMode(on) { unlitMode = on; }

// Friendly size descriptor for the batch buttons: the A-series paper name when
// the pixels match that paper at 300 DPI (either orientation), else raw px.
function batchSizeLabel(w, h) {
  if (w == null) { const s = getExportSize(); w = s[0]; h = s[1]; }
  const A = { A6: [1240, 1748], A5: [1748, 2480], A4: [2480, 3508], A3: [3508, 4961] };
  const near = (x, y) => Math.abs(x - y) <= 2;
  for (const name in A) {
    const [aw, ah] = A[name];
    if ((near(w, aw) && near(h, ah)) || (near(w, ah) && near(h, aw))) return name + ' 300dpi';
  }
  return w + '×' + h;
}

// Keep the ZIP/PDF batch buttons reflecting the live Export size — they used to
// hard-say "A5" even at custom dimensions. Skipped mid-export (the button text
// is then the Cancel counter).
function updateBatchButtonLabels() {
  if (batchExporting) return;
  const label = batchSizeLabel();
  const z = document.getElementById('batchExportBtn');
  const p = document.getElementById('batchPdfBtn');
  if (z) z.textContent = 'Export ZIP · ' + label;
  if (p) p.textContent = 'Export PDF · ' + label + ' (multi-page)';
}

// "N rows loaded → N PNGs/videos" — re-derived on preset switch so the noun
// matches the active batch output. No-op while an export owns the status line.
function updateBatchLoadedStatus() {
  if (!batchStatus || batchExporting || batchVideoExporting) return;
  const n = batchRecords.length;
  if (!n) return; // keep "No CSV loaded" / parse-error text as-is
  const noun = someFormat === 'tagsvideo' ? 'video' : 'PNG';
  batchStatus.textContent = `${n} row${n === 1 ? '' : 's'} loaded → ${n} ${noun}${n === 1 ? '' : 's'}`;
}

function loadCSVFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    batchRecords = csvToRecords(String(reader.result || ''));
    const n = batchRecords.length;
    if (n) updateBatchLoadedStatus();
    else if (batchStatus) batchStatus.textContent = 'No valid rows found in that CSV.';
    if (batchExportBtn) batchExportBtn.disabled = !n;
    const bp = document.getElementById('batchPdfBtn'); if (bp) bp.disabled = !n;
    const bv = document.getElementById('batchVideoBtn'); if (bv) bv.disabled = !n;
    if (csvDrop) csvDrop.classList.toggle('has-file', !!n);
  };
  reader.readAsText(file);
}

if (csvInput) csvInput.addEventListener('change', () => {
  loadCSVFile(csvInput.files[0]);
  // Reset so picking the same file again still fires `change`.
  csvInput.value = '';
});
const csvTemplateBtn = document.getElementById('csvTemplateBtn');
if (csvTemplateBtn) csvTemplateBtn.addEventListener('click', e => {
  e.stopPropagation(); downloadCSVTemplate();
});
if (csvDrop) {
  // The file input lives inside the dropzone, so a programmatic csvInput.click()
  // bubbles back here — re-opening the dialog and forcing a second pick. Ignore
  // clicks that originate from the input itself.
  csvDrop.addEventListener('click', e => { if (e.target !== csvInput) csvInput && csvInput.click(); });
  csvDrop.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); csvDrop.classList.add('drag'); });
  csvDrop.addEventListener('dragleave', () => csvDrop.classList.remove('drag'));
  csvDrop.addEventListener('drop', e => {
    e.preventDefault(); e.stopPropagation(); csvDrop.classList.remove('drag');
    if (e.dataTransfer.files[0]) loadCSVFile(e.dataTransfer.files[0]);
  });
}

async function runBatchExport(format = 'zip', btn = batchExportBtn) {
  if (batchExporting || batchVideoExporting || !batchRecords.length) return;
  const isPdf = format === 'pdf';
  // Ensure print framing (camera + A5 size + matte + crop) is in place.
  if (someFormat !== 'print') {
    applyPrintPreset();
    someActive = true; initSomeCrop(); someFrame.style.display = 'block';
  }
  // Honor the Export size field (WYSIWYG with the live crop frame) instead of
  // forcing portrait A5 — so landscape/custom name-tag sizes export correctly.
  const [outW, outH] = getExportSize();
  const doneLabel = isPdf
    ? `Export PDF · ${batchSizeLabel(outW, outH)} (multi-page)`
    : `Export ZIP · ${batchSizeLabel(outW, outH)}`;
  // PDF page = true print size of those pixels at 300 DPI. Orientation must
  // match the dims or jsPDF reorders the custom format array and distorts the page.
  const pageWmm = outW / 300 * 25.4, pageHmm = outH / 300 * 25.4;
  const pdfOrient = pageWmm >= pageHmm ? 'landscape' : 'portrait';
  // Pages embed as JPEG q0.95: jsPDF stores them compressed (DCTDecode), unlike
  // PNG which it expands toward raw pixels and overflows V8's max string length
  // in doc.output → "Invalid string length". Budget still rolls into a new PDF
  // as a safety net for very large batches (one file for normal-size classes).
  const PDF_JPEG_QUALITY = 0.95;
  const PDF_BYTE_BUDGET = 350 * 1024 * 1024, PDF_MAX_PAGES = 300;

  // Fonts must be ready or early rows render in a fallback face.
  try { await document.fonts.ready; } catch (e) {}

  let JsPDF = null;
  if (isPdf) {
    try { JsPDF = await getJsPDF(); }
    catch (e) { console.error(e); if (batchStatus) batchStatus.textContent = 'Could not load PDF library (offline?).'; return; }
  }

  batchExporting = true; batchCancel = false;
  btn.classList.add('batch-cancel');

  const files = [], usedNames = new Set();
  const pdfBlobs = [];
  let doc = null, docPages = 0, docBytes = 0, totalPages = 0;
  const finalizeDoc = () => { if (doc && docPages) pdfBlobs.push(doc.output('blob')); doc = null; docPages = 0; docBytes = 0; };
  const STEP_FRAMES = 28; // ~0.5s of wind between rows → every pose differs

  for (let i = 0; i < batchRecords.length; i++) {
    if (batchCancel) break;
    const rec = batchRecords[i];
    // `|` in a cell is an explicit line break.
    titleBlocks[0].text = (rec.project || '').replace(/\|/g, '\n');
    titleBlocks[1].text = (rec.name || '').replace(/\|/g, '\n');
    titleBlocks[2].text = (rec.extra || '').replace(/\|/g, '\n');
    titleBlocks[3].text = (rec.www || '').replace(/\|/g, '\n');
    generateTextTexture(0);

    // Advance the wind between rows so every tag gets its own pose.
    for (let s = 0; s < STEP_FRAMES; s++) simulate(SIM_DT);

    // JPEG for PDF (compact, jsPDF-safe), lossless PNG for the ZIP masters.
    const blob = await renderFlagToBlob(outW, outH, matteMode, false,
      isPdf ? 'image/jpeg' : 'image/png', isPdf ? PDF_JPEG_QUALITY : undefined);

    if (isPdf) {
      const dataUrl = await blobToDataURL(blob);
      // Roll over to a fresh PDF before this page would blow the budget.
      if (doc && (docBytes + dataUrl.length > PDF_BYTE_BUDGET || docPages >= PDF_MAX_PAGES)) finalizeDoc();
      if (!doc) doc = new JsPDF({ unit: 'mm', format: [pageWmm, pageHmm], orientation: pdfOrient });
      else doc.addPage([pageWmm, pageHmm], pdfOrient);
      const pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight();
      doc.addImage(dataUrl, 'JPEG', 0, 0, pw, ph);
      docPages++; docBytes += dataUrl.length; totalPages++;
    } else {
      const data = new Uint8Array(await blob.arrayBuffer());
      let base = slugify(rec.project) || ('flag-' + (i + 1));
      let name = base + '.png', n = 2;
      while (usedNames.has(name)) name = base + '-' + (n++) + '.png';
      usedNames.add(name);
      files.push({ name, data });
    }

    if (batchStatus) batchStatus.textContent = `Rendering ${i + 1} / ${batchRecords.length}…`;
    btn.textContent = `Cancel (${i + 1}/${batchRecords.length})`;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  const count = isPdf ? totalPages : files.length;
  batchExporting = false;
  btn.classList.remove('batch-cancel');
  btn.textContent = doneLabel;

  if (batchCancel || !count) {
    if (batchStatus) batchStatus.textContent = batchCancel
      ? `Cancelled — ${count} rendered, not saved.` : 'Nothing to export.';
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  if (isPdf) {
    finalizeDoc();
    const parts = pdfBlobs.length;
    if (batchStatus) batchStatus.textContent = parts > 1 ? `Saving ${parts} PDFs…` : 'Saving PDF…';
    await new Promise(r => requestAnimationFrame(r));
    // Same Safari-safe path as ZIP/PNG (see exportFlagPDF for why not doc.save).
    for (let p = 0; p < parts; p++) {
      const name = parts > 1
        ? `flags-${outW}x${outH}-${stamp}-part${p + 1}.pdf`
        : `flags-${outW}x${outH}-${stamp}.pdf`;
      downloadBlob(pdfBlobs[p], name);
      // Stagger multi-file downloads so the browser doesn't drop them.
      if (parts > 1 && p < parts - 1) await new Promise(r => setTimeout(r, 500));
    }
    if (batchStatus) batchStatus.textContent = parts > 1
      ? `Done — ${count} pages across ${parts} PDFs.` : `Done — ${count}-page PDF.`;
  } else {
    if (batchStatus) batchStatus.textContent = 'Packing ZIP…';
    await new Promise(r => requestAnimationFrame(r));
    downloadBlob(makeZip(files), `flags-${outW}x${outH}-${stamp}.zip`);
    if (batchStatus) batchStatus.textContent = `Done — ${count} PNGs zipped.`;
  }
}

if (batchExportBtn) batchExportBtn.addEventListener('click', () => {
  if (batchExporting) { batchCancel = true; return; }
  runBatchExport('zip', batchExportBtn);
});
const batchPdfBtn = document.getElementById('batchPdfBtn');
if (batchPdfBtn) batchPdfBtn.addEventListener('click', () => {
  if (batchExporting) { batchCancel = true; return; }
  runBatchExport('pdf', batchPdfBtn);
});

// ─── Name Tags Video batch: one 10s MP4 per CSV row ─────────────
// Sequential by design — only one ~20 MB MP4 buffer lives in memory at a time.
// Files land in a user-picked folder (File System Access API); browsers
// without the API fall back to one regular download per file.
const batchVideoBtn = document.getElementById('batchVideoBtn');
let batchVideoRowLabel = ''; // per-row prefix the recording loop appends time to

async function runBatchVideoExport() {
  if (batchVideoExporting || batchExporting || pngSeqExporting || someRecording || _precomputingLoop) return;
  if (!batchRecords.length) return;
  if (typeof VideoEncoder === 'undefined') {
    alert('WebCodecs not supported — use Chrome or Edge.');
    return;
  }
  // Ensure video framing (camera + 16:9 size + full cloth + crop) is in place.
  if (someFormat !== 'tagsvideo') {
    applyTagsVideoPreset();
    someActive = true; initSomeCrop(); someFrame.style.display = 'block';
  }

  // Pick the destination folder now, inside the click gesture — after a 10s
  // recording the user activation is long gone. Dismissing the picker cancels
  // the whole batch.
  let dir = null;
  if (window.showDirectoryPicker) {
    try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); }
    catch (e) { return; }
  }

  // Fonts must be ready or early rows render in a fallback face.
  try { await document.fonts.ready; } catch (e) {}

  // Decode the soundtrack once for the whole run (cached across runs too).
  let audioDecoded = null;
  if (someAudio !== 'none' && AUDIO_TRACKS[someAudio]
      && typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined') {
    if (batchStatus) batchStatus.textContent = 'Loading audio…';
    try { audioDecoded = await getDecodedAudio(someAudio, REC_TOTAL_FRAMES / REC_FPS); }
    catch (e) {
      console.error('Audio load failed:', e);
      if (batchStatus) batchStatus.textContent = 'Audio load failed — exporting without sound.';
    }
  }

  batchVideoExporting = true; batchVideoCancel = false;
  batchVideoBtn.classList.add('batch-cancel');

  const usedNames = new Set();
  let saved = 0, failed = false;
  const STEP_FRAMES = 28; // ~0.5s of wind between rows → each video opens on a different pose

  for (let i = 0; i < batchRecords.length; i++) {
    if (batchVideoCancel) break;
    const rec = batchRecords[i];
    // `|` in a cell is an explicit line break.
    titleBlocks[0].text = (rec.project || '').replace(/\|/g, '\n');
    titleBlocks[1].text = (rec.name || '').replace(/\|/g, '\n');
    titleBlocks[2].text = (rec.extra || '').replace(/\|/g, '\n');
    titleBlocks[3].text = (rec.www || '').replace(/\|/g, '\n');
    generateTextTexture(0);
    for (let s = 0; s < STEP_FRAMES; s++) simulate(SIM_DT);

    // These are name tags — name the file after the person on it.
    const base = slugify(rec.name) || slugify(rec.project) || ('flag-' + (i + 1));
    let name = base + '.mp4', n = 2;
    while (usedNames.has(name)) name = base + '-' + (n++) + '.mp4';
    usedNames.add(name);

    batchVideoRowLabel = `Recording ${i + 1} / ${batchRecords.length} · ${name}`;
    if (batchStatus) batchStatus.textContent = batchVideoRowLabel;
    batchVideoBtn.textContent = `Cancel (${i + 1}/${batchRecords.length})`;

    try { await initRecorder(audioDecoded); }
    catch (e) {
      console.error('Encoder init failed:', e);
      cleanupRecorder();
      failed = true;
      break;
    }
    if (batchVideoCancel) { cleanupRecorder(); break; }
    _recSink = async (blob) => {
      if (dir) {
        const fileHandle = await dir.getFileHandle(name, { create: true });
        const w = await fileHandle.createWritable();
        await w.write(blob);
        await w.close();
      } else {
        downloadBlob(blob, name);
      }
    };
    const ok = await new Promise(resolve => { _recDone = resolve; startRecording(); });
    if (batchVideoCancel) break;       // abortRecording already cleaned up
    if (!ok) { failed = true; break; } // encode/save error — stop, don't churn the rest
    saved++;
    if (batchStatus) batchStatus.textContent = `Saved ${saved} / ${batchRecords.length} · ${name}`;
    // Let the browser breathe (free the MP4 buffer, repaint) between rows.
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  batchVideoExporting = false;
  batchVideoBtn.classList.remove('batch-cancel');
  batchVideoBtn.textContent = 'Export MP4 per row · 10s';
  if (batchStatus) {
    if (batchVideoCancel) batchStatus.textContent = `Cancelled — ${saved} video${saved === 1 ? '' : 's'} saved.`;
    else if (failed) batchStatus.textContent = `Stopped after ${saved} saved — export failed (see console).`;
    else batchStatus.textContent = `Done — ${saved} video${saved === 1 ? '' : 's'} saved${dir ? '' : ' to Downloads'}.`;
  }
}

if (batchVideoBtn) batchVideoBtn.addEventListener('click', () => {
  if (batchVideoExporting) {
    batchVideoCancel = true;
    if (someRecording) abortRecording();
    return;
  }
  runBatchVideoExport();
});

// ── Cloth mode pills + single PDF + PNG-frame-sequence wiring ──
const pdfBtn = document.getElementById('pdfBtn');
if (pdfBtn) pdfBtn.addEventListener('click', exportFlagPDF);

let pngSeqExporting = false, pngSeqCancel = false;
async function runPngSequenceExport() {
  if (pngSeqExporting || batchExporting || batchVideoExporting || someRecording || _precomputingLoop) return;
  const btn = document.getElementById('someSeqBtn');
  const [outW, outH] = getExportSize();
  try { await document.fonts.ready; } catch (e) {}
  pngSeqExporting = true; pngSeqCancel = false;
  btn.classList.add('batch-cancel');

  const files = [];
  const total = REC_TOTAL_FRAMES; // 250 frames = 10s @ 25fps
  let loopPrep = null;
  try {
    if (someLoop === 'seamless') {
      loopPrep = await buildSeamlessLoopFrames((done, count) => {
        btn.textContent = `Preparing loop ${Math.round(done / count * 100)}%`;
      });
    }

    for (let f = 0; f < total; f++) {
      if (pngSeqCancel) break;
      if (loopPrep) applyLoopFrame(loopPrep.frames[f]);
      else advanceRecordingMotionFrame(true);

      const blob = await renderFlagToBlob(outW, outH, matteMode, true); // transparent bg
      files.push({ name: String(f + 1).padStart(4, '0') + '.png', data: new Uint8Array(await blob.arrayBuffer()) });
      btn.textContent = `Cancel (${f + 1}/${total})`;
      await new Promise(r => requestAnimationFrame(r));
    }
  } finally {
    if (loopPrep) restoreMotionState(loopPrep.restoreState);
    pngSeqExporting = false;
    btn.classList.remove('batch-cancel');
    btn.textContent = 'Export PNG sequence';
    lastTime = 0; // avoid a giant catch-up dt when the on-screen loop resumes
  }
  if (pngSeqCancel || !files.length) return;
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(makeZip(files), `flag-${outW}x${outH}-seq-${stamp}.zip`);
}
const someSeqBtn = document.getElementById('someSeqBtn');
if (someSeqBtn) someSeqBtn.addEventListener('click', () => {
  if (pngSeqExporting) { pngSeqCancel = true; return; }
  runPngSequenceExport();
});

window.addEventListener('resize', () => { if (someActive) initSomeCrop(); });

// Live-update crop frame when user edits W/H
[sizeWInput, sizeHInput].forEach(inp => {
  inp.addEventListener('input', () => {
    setActiveByData(document.getElementById('someRow'), '.pill', 'some', '__custom-size__');
    if (someActive) initSomeCrop();
    updateBatchButtonLabels();
  });
});

// FBO for high-quality export rendering
let _expFBO = null, _expTex = null, _expDepth = null, _expW = 0, _expH = 0;

function setupExpFBO(w, h) {
  if (_expFBO && _expW === w && _expH === h) return;
  if (_expFBO) { gl.deleteFramebuffer(_expFBO); gl.deleteTexture(_expTex); gl.deleteRenderbuffer(_expDepth); }
  _expW = w; _expH = h;
  _expFBO = gl.createFramebuffer();
  _expTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, _expTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  _expDepth = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, _expDepth);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, _expFBO);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, _expTex, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, _expDepth);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function renderToFBO(fw, fh) {
  setupExpFBO(fw, fh);
  gl.bindFramebuffer(gl.FRAMEBUFFER, _expFBO);
  gl.viewport(0, 0, fw, fh);
  gl.clearColor(SIM.bgColor[0], SIM.bgColor[1], SIM.bgColor[2], 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // Background
  gl.disable(gl.DEPTH_TEST);
  drawBackgroundQuad(fw, fh);
  drawLightningBolts(fw, fh);
  gl.enable(gl.DEPTH_TEST);

  // Camera matching the crop view
  const mainFOV = Math.PI / 4.5;
  const vFrac = someActive ? (someCrop.h / window.innerHeight) : 1.0;
  const expFOV = 2 * Math.atan(vFrac * Math.tan(mainFOV / 2));
  const e = eyePos();
  const ld = KEY_LIGHT;
  const ll = Math.sqrt(ld[0] ** 2 + ld[1] ** 2 + ld[2] ** 2);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(prog);
  gl.uniform1f(loc.uPartyTime, 0.0);
  gl.uniformMatrix4fv(loc.uProj, false, perspective(expFOV, fw / fh, 0.1, 100));
  gl.uniformMatrix4fv(loc.uView, false, lookAt(e, cam.target, rolledUp(e, cam.target, cam.roll)));
  gl.uniform3f(loc.uLight, ld[0] / ll, ld[1] / ll, ld[2] / ll);
  gl.uniform3f(loc.uEye, e[0], e[1], e[2]);
  gl.uniform1f(loc.uAmbient, 0.38);
  gl.uniform1f(loc.uLightning, lightningValue());

  // Flag only (no pole)
  setModelMatrix(MOON.active ? moonFlagModel() : MODEL_IDENTITY);
  gl.uniform1i(loc.uIsGlass, 0);
  gl.uniform1f(loc.uMoonSurface, 0.0);
  gl.uniform1f(loc.uMatte, matteMode ? 1.0 : 0.0);
  gl.uniform1f(loc.uUnlit, unlitMode ? 1.0 : 0.0);
  gl.uniform3f(loc.uColor, SIM.flagColor[0], SIM.flagColor[1], SIM.flagColor[2]);
  gl.uniform1f(loc.uAlpha, SIM.opacity);
  if (hasTex && flagTex) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, flagTex);
    gl.uniform1i(loc.uTex, 0);
    gl.uniform1i(loc.uHasTex, 1);
  } else {
    gl.uniform1i(loc.uHasTex, 0);
  }
  setMaskUniforms(isCustomShape());

  bindClothBuffers();
  drawCloth(rIndexData.length);
  gl.disable(gl.BLEND);

  // Read back
  const pixels = new Uint8Array(fw * fh * 4);
  gl.readPixels(0, 0, fw, fh, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  // Restore
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 1);
  return pixels;
}

// Flip pixel buffer Y and put on 2D canvas
function pixelsToCanvas(pixels, fw, fh, ctx) {
  const imgData = ctx.createImageData(fw, fh);
  for (let y = 0; y < fh; y++) {
    const src = (fh - 1 - y) * fw * 4;
    const dst = y * fw * 4;
    imgData.data.set(pixels.subarray(src, src + fw * 4), dst);
  }
  ctx.putImageData(imgData, 0, 0);
}

// HQ MP4 export via WebCodecs + mp4-muxer (hardware-accelerated H.264)
let _recCanvas = null, _recCtx = null;
// Supersample buffer: render the FBO at _recSS× the output size and downscale
// into _recCanvas for cleaner edges (poor-man's MSAA on WebGL1).
let _ssCanvas = null, _ssCtx = null, _recSS = 1;
let _encoder = null, _muxer = null, _muxerTarget = null, _frameIdx = 0;
let _mp4Mod = null;
let _audioEncoder = null;
// Batch hooks: when set, the finished MP4 goes to _recSink(blob) instead of an
// anchor download, and _recDone(ok) resolves the batch driver's per-row await.
let _recSink = null, _recDone = null;
let _useSeamless = false; // snapshot of someLoop at recording start
let _loopFrames = null;
let _recMotionRestore = null;
let _precomputingLoop = false;

function smootherstep01(t) {
  t = clamp(t, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function cloneCameraState() {
  return {
    tgtTheta: cam.tgtTheta, tgtPhi: cam.tgtPhi, tgtDist: cam.tgtDist,
    curTheta: cam.curTheta, curPhi: cam.curPhi, curDist: cam.curDist,
    tgtRoll: cam.tgtRoll, roll: cam.roll,
    tgtTarget: cam.tgtTarget.slice(),
    target: cam.target.slice(),
  };
}

function cloneMoonState() {
  return { yaw: MOON.yaw, yawTarget: MOON.yawTarget };
}

function applyMoonState(state) {
  if (!state) return;
  MOON.yaw = state.yaw;
  MOON.yawTarget = state.yawTarget;
}

function applyCameraState(state) {
  cam.tgtTheta = state.tgtTheta; cam.tgtPhi = state.tgtPhi; cam.tgtDist = state.tgtDist;
  cam.curTheta = state.curTheta; cam.curPhi = state.curPhi; cam.curDist = state.curDist;
  cam.tgtRoll = state.tgtRoll; cam.roll = state.roll;
  cam.tgtTarget[0] = state.tgtTarget[0]; cam.tgtTarget[1] = state.tgtTarget[1]; cam.tgtTarget[2] = state.tgtTarget[2];
  cam.target[0] = state.target[0]; cam.target[1] = state.target[1]; cam.target[2] = state.target[2];
}

function cloneGustState() {
  return { gust: { ...GUST }, sway: { ...sway } };
}

function restoreGustState(state) {
  Object.assign(GUST, state.gust);
  Object.assign(sway, state.sway);
}

function snapshotMotionState() {
  return {
    pos: new Float32Array(pos),
    prev: new Float32Array(prev),
    nrm: new Float32Array(nrm),
    gusts: cloneGustState(),
    simTime,
    windAngleDrift,
    windAngleVel,
    windStrengthDrift,
    orbitAngularVel,
    textScrollTime,
    cam: cloneCameraState(),
    moon: cloneMoonState(),
  };
}

function restoreMotionState(state) {
  if (!state) return;
  pos.set(state.pos);
  prev.set(state.prev);
  nrm.set(state.nrm);
  restoreGustState(state.gusts);
  simTime = state.simTime;
  windAngleDrift = state.windAngleDrift;
  windAngleVel = state.windAngleVel;
  windStrengthDrift = state.windStrengthDrift;
  orbitAngularVel = state.orbitAngularVel;
  textScrollTime = state.textScrollTime;
  applyCameraState(state.cam);
  applyMoonState(state.moon);
  if (textScrollSpeed > 0 && currentText.trim() && textLayout === 'repeat') {
    generateTextTexture(textScrollTime);
  }
  updateOrbitBall();
}

function advanceRecordingMotionFrame(updateTexture) {
  let scrollDirty = false;
  for (let i = 0; i < REC_STEPS; i++) {
    if (_loopGustBase) {
      _loopSimPhase = (_loopSimStep % _loopSimTotalSteps) / _loopSimTotalSteps;
      _loopSimStep++;
    }
    simulate(SIM_DT);
    if (_loopGustBase) _loopSimPhase = -1;
    updateCamera(SIM_DT);
    updateMoonScene(SIM_DT);
    if (textScrollSpeed > 0 && currentText.trim() && textLayout === 'repeat') {
      textScrollTime += SIM_DT * textScrollSpeed * 2.5;
      scrollDirty = true;
    }
  }
  if (updateTexture && scrollDirty) generateTextTexture(textScrollTime);
  updateOrbitBall();
  return scrollDirty;
}

async function buildSeamlessLoopFrames(onProgress) {
  const restoreState = snapshotMotionState();
  const frames = [];
  _precomputingLoop = true;
  _loopGustBase = cloneGustState();
  _loopSimStep = 0;
  _loopSimTotalSteps = REC_TOTAL_FRAMES * REC_STEPS;
  // One discarded lap first. Everything driving the cloth is already locked to
  // the loop phase, but heavy satin carries momentum for several seconds, so a
  // capture that starts cold still arrives somewhere else ten seconds later.
  // Running a full lap into the bin lets that transient die, and because the
  // lap is exactly one period the phase lands back on 0 for the real capture.
  const WARM = REC_TOTAL_FRAMES;
  const TOTAL = WARM + REC_TOTAL_FRAMES;
  try {
    const warmScroll = textScrollTime;
    for (let f = 0; f < WARM; f++) {
      advanceRecordingMotionFrame(false);
      if (f % 20 === 0) {
        if (onProgress) onProgress(f, TOTAL);
        await new Promise(r => requestAnimationFrame(r));
      }
    }
    // The cloth keeps its settled state; the text scroll goes back to the top.
    textScrollTime = warmScroll;
    for (let f = 0; f <= REC_TOTAL_FRAMES; f++) {
      advanceRecordingMotionFrame(false);
        frames.push({
          pos: new Float32Array(pos),
          cam: cloneCameraState(),
          moon: cloneMoonState(),
          textScrollTime,
        });
      if (f % 20 === 0) {
        if (onProgress) onProgress(WARM + f, TOTAL);
        await new Promise(r => requestAnimationFrame(r));
      }
    }

    const startPos = frames[0].pos;
    const endPos = frames[REC_TOTAL_FRAMES].pos;
    for (let f = 0; f < REC_TOTAL_FRAMES; f++) {
      const p = frames[f].pos;
      const w = smootherstep01(f / (REC_TOTAL_FRAMES - 1));
      for (let i = 0, n = p.length; i < n; i++) {
        p[i] -= (endPos[i] - startPos[i]) * w;
      }
    }
    frames.length = REC_TOTAL_FRAMES;
  } finally {
    _loopGustBase = null;
    _loopSimPhase = -1;
    restoreMotionState(restoreState);
    _precomputingLoop = false;
  }
  return { frames, restoreState };
}

function applyLoopFrame(frame) {
  pos.set(frame.pos);
  prev.set(frame.pos);
  textScrollTime = frame.textScrollTime;
  applyCameraState(frame.cam);
  applyMoonState(frame.moon);
  computeMeshNormals();
  if (textScrollSpeed > 0 && currentText.trim() && textLayout === 'repeat') {
    generateTextTexture(textScrollTime);
  }
  updateOrbitBall();
}

function renderAndEncodeRecordingFrame(outIdx) {
  render(SIM_DT);
  const fw = _recCanvas.width, fh = _recCanvas.height;
  const ssW = fw * _recSS, ssH = fh * _recSS;
  const pixels = renderToFBO(ssW, ssH);
  if (_recSS === 1) {
    pixelsToCanvas(pixels, fw, fh, _recCtx);
  } else {
    pixelsToCanvas(pixels, ssW, ssH, _ssCtx);
    _recCtx.imageSmoothingEnabled = true;
    _recCtx.imageSmoothingQuality = 'high';
    _recCtx.drawImage(_ssCanvas, 0, 0, fw, fh);
  }

  const frame = new VideoFrame(_recCanvas, {
    timestamp: outIdx * (1_000_000 / REC_FPS),
  });
  _encoder.encode(frame, { keyFrame: outIdx % REC_FPS === 0 });
  frame.close();
}

async function getMp4Muxer() {
  if (_mp4Mod) return _mp4Mod;
  _mp4Mod = await import('https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/+esm');
  return _mp4Mod;
}

// Fetch + decode a WAV track and return interleaved f32 PCM trimmed to the
// requested duration. Returned object also carries the audio config the
// muxer/encoder need.
async function decodeAudioTrack(trackId, maxDurationSec) {
  const url = encodeURI(AUDIO_TRACKS[trackId]);
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = await res.arrayBuffer();
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const audioBuffer = await ac.decodeAudioData(buf);
  ac.close();
  const numberOfChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const totalFrames = Math.min(audioBuffer.length, Math.round(sampleRate * maxDurationSec));
  const pcm = new Float32Array(totalFrames * numberOfChannels);
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < totalFrames; i++) {
      pcm[i * numberOfChannels + ch] = data[i] * SOUND_VOLUME;
    }
  }
  return { pcm, numberOfChannels, sampleRate, totalFrames };
}

// Decode-once cache so a 50-row batch doesn't re-fetch/re-decode the same WAV
// per video. Keyed by track id only — every caller asks for the same 10s.
let _audioDecCache = { id: null, decoded: null };
async function getDecodedAudio(trackId, maxDurationSec) {
  if (_audioDecCache.id === trackId && _audioDecCache.decoded) return _audioDecCache.decoded;
  const decoded = await decodeAudioTrack(trackId, maxDurationSec);
  _audioDecCache = { id: trackId, decoded };
  return decoded;
}

// Stream the decoded PCM into a fresh AudioEncoder that pushes AAC chunks
// straight into the muxer. Returns the encoder (caller flushes it).
function startAudioEncode(decoded, muxer) {
  const { pcm, numberOfChannels, sampleRate, totalFrames } = decoded;
  const enc = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: e => console.error('AudioEncoder error:', e),
  });
  enc.configure({
    codec: 'mp4a.40.2',
    numberOfChannels,
    sampleRate,
    bitrate: 192000,
  });
  const CHUNK = 1024;
  for (let off = 0; off < totalFrames; off += CHUNK) {
    const len = Math.min(CHUNK, totalFrames - off);
    const slice = pcm.subarray(off * numberOfChannels, (off + len) * numberOfChannels);
    const ad = new AudioData({
      format: 'f32',
      sampleRate,
      numberOfFrames: len,
      numberOfChannels,
      timestamp: Math.round(off * (1_000_000 / sampleRate)),
      data: slice,
    });
    enc.encode(ad);
    ad.close();
  }
  return enc;
}

// Drop every recorder resource (encoders closed, ~20 MB muxer buffer freed).
// Shared by the success, failure and abort paths.
function cleanupRecorder() {
  if (_encoder) { try { _encoder.close(); } catch (_) {} _encoder = null; }
  if (_audioEncoder) { try { _audioEncoder.close(); } catch (_) {} _audioEncoder = null; }
  restoreMotionState(_recMotionRestore);
  _muxer = null; _muxerTarget = null;
  _recCanvas = null; _recCtx = null;
  _ssCanvas = null; _ssCtx = null; _recSS = 1;
  _loopFrames = null;
  _recMotionRestore = null;
  someFrame.classList.remove('recording');
}

async function finalizeExport() {
  const btn = document.getElementById('someExportBtn');
  btn.textContent = 'Finalizing...';
  let ok = true;
  try {
    await _encoder.flush();
    if (_audioEncoder) await _audioEncoder.flush();
    _muxer.finalize();
    const blob = new Blob([_muxerTarget.buffer], { type: 'video/mp4' });
    if (_recSink) {
      await _recSink(blob);
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'flag-' + _recCanvas.width + 'x' + _recCanvas.height + '-10s.mp4';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
  } catch (e) {
    console.error('MP4 finalize failed:', e);
    ok = false;
  }
  const done = _recDone;
  _recDone = null; _recSink = null;
  cleanupRecorder();
  if (ok) {
    btn.textContent = 'Export 10s Video';
  } else {
    btn.textContent = 'Export failed';
    setTimeout(() => { btn.textContent = 'Export 10s Video'; }, 3000);
  }
  if (done) done(ok);
}

// Hard-stop a recording without saving (batch cancel mid-row).
function abortRecording() {
  someRecording = false;
  lastTime = 0;
  const done = _recDone;
  _recDone = null; _recSink = null;
  cleanupRecorder();
  document.getElementById('someExportBtn').textContent = 'Export 10s Video';
  if (done) done(false);
}

// Build the capture canvas + muxer + encoders for one 10s recording at the
// current export size. Throws on encoder-init failure. Shared by the single
// Export button and the CSV → MP4-per-row batch; caller starts the rAF
// recording via startRecording().
async function initRecorder(audioDecoded) {
  // H.264 requires even dimensions
  const [rawW, rawH] = getExportSize();
  const fw = rawW & ~1, fh = rawH & ~1;
  _recCanvas = document.createElement('canvas');
  _recCanvas.width = fw; _recCanvas.height = fh;
  _recCtx = _recCanvas.getContext('2d');
  // Pick a supersample factor (2 if the GPU can render the bigger buffer).
  const maxRb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const maxDim = Math.min(maxRb, maxTex);
  _recSS = (fw * 2 <= maxDim && fh * 2 <= maxDim) ? 2 : 1;
  if (_recSS > 1) {
    _ssCanvas = document.createElement('canvas');
    _ssCanvas.width = fw * _recSS; _ssCanvas.height = fh * _recSS;
    _ssCtx = _ssCanvas.getContext('2d');
  }
  _useSeamless = (someLoop === 'seamless');
  _loopFrames = null;
  _recMotionRestore = null;
  if (_useSeamless) {
    const prep = await buildSeamlessLoopFrames((done, total) => {
      const pct = Math.round(done / total * 100);
      if (batchVideoExporting && batchStatus) {
        batchStatus.textContent = `${batchVideoRowLabel} — preparing loop ${pct}%`;
      } else {
        const btn = document.getElementById('someExportBtn');
        if (btn) btn.textContent = `Preparing loop ${pct}%`;
      }
    });
    _loopFrames = prep.frames;
    _recMotionRestore = prep.restoreState;
  }

  const { Muxer, ArrayBufferTarget } = await getMp4Muxer();
  _muxerTarget = new ArrayBufferTarget();
  const muxerCfg = {
    target: _muxerTarget,
    video: { codec: 'avc', width: fw, height: fh },
    fastStart: 'in-memory',
  };
  if (audioDecoded) {
    muxerCfg.audio = {
      codec: 'aac',
      numberOfChannels: audioDecoded.numberOfChannels,
      sampleRate: audioDecoded.sampleRate,
    };
  }
  _muxer = new Muxer(muxerCfg);
  _encoder = new VideoEncoder({
    output: (chunk, meta) => _muxer.addVideoChunk(chunk, meta),
    error: e => console.error('VideoEncoder error:', e),
  });
  _encoder.configure({
    codec: 'avc1.640034',
    width: fw, height: fh,
    // ~0.3 bits/pixel for H.264 — visibly cleaner on textured content
    // (flag fabric, text) than the previous flat 10 Mbit/s.
    bitrate: Math.min(50_000_000, Math.max(8_000_000, Math.round(fw * fh * REC_FPS * 0.3))),
    framerate: 25,
  });
  if (audioDecoded) {
    _audioEncoder = startAudioEncode(audioDecoded, _muxer);
  }
  _frameIdx = 0;
}

function startRecording() {
  lastTime = 0; // prevent stale dt on first recording frame
  someRecording = true;
  someFrame.classList.add('recording');
}

document.getElementById('someExportBtn').addEventListener('click', async () => {
  if (someRecording || batchExporting || batchVideoExporting || pngSeqExporting || _precomputingLoop) return;
  if (typeof VideoEncoder === 'undefined') {
    alert('WebCodecs not supported — use Chrome or Edge.');
    return;
  }
  const btn = document.getElementById('someExportBtn');

  // Decode audio first (if selected) — we need its sampleRate/channels to
  // configure the muxer's audio track up front.
  let audioDecoded = null;
  if (someAudio !== 'none' && AUDIO_TRACKS[someAudio]) {
    if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') {
      alert('AudioEncoder not supported in this browser — exporting without sound.');
    } else {
      btn.textContent = 'Loading audio...';
      try {
        audioDecoded = await getDecodedAudio(someAudio, REC_TOTAL_FRAMES / REC_FPS);
      } catch (e) {
        console.error('Audio load failed:', e);
        alert('Audio load failed: ' + (e && e.message ? e.message : e));
        btn.textContent = 'Export 10s Video';
        return;
      }
    }
  }

  btn.textContent = 'Initializing...';
  try {
    await initRecorder(audioDecoded);
  } catch (e) {
    console.error('Encoder init failed:', e);
    cleanupRecorder();
    btn.textContent = 'Export failed';
    setTimeout(() => { btn.textContent = 'Export 10s Video'; }, 2000);
    return;
  }
  startRecording();
  btn.textContent = 'Recording 0.0s / 10s';
});

// ─── Orbit Ball ─────────────────────────────────────────────
const orbitBall = document.getElementById('orbitBall');
const orbitDot = document.getElementById('orbitDot');
const orbitEquator = orbitBall.querySelector('.orbit-ball-equator');
const orbitMeridian = orbitBall.querySelector('.orbit-ball-meridian');
let orbitDragging = false, orbitLast = [0, 0];
const BALL_R = 28; // usable radius inside the 72px ball

function updateOrbitBall() {
  // Map theta/phi to dot position on sphere surface projected to 2D
  const t = MOON.active ? MOON.yaw : cam.curTheta;
  const p = MOON.active ? 0.16 : cam.curPhi;
  const x = Math.sin(t) * Math.cos(p);
  const y = -Math.sin(p);
  const z = Math.cos(t) * Math.cos(p);
  // Simple projection (ignore z for front-facing dot, fade if behind)
  const px = 36 + x * BALL_R;
  const py = 36 + y * BALL_R;
  const opacity = 0.3 + 0.7 * Math.max(0, z);
  orbitDot.style.left = px + 'px';
  orbitDot.style.top = py + 'px';
  orbitDot.style.opacity = opacity;
  // Tilt rings to reflect current angles
  orbitEquator.style.transform = 'rotateX(' + (p * 57.3) + 'deg)';
  orbitMeridian.style.transform = 'rotateY(' + (t * 57.3) + 'deg)';
}

let orbitLastTime = 0;
function orbitBallApplyMove(dx, dy, now) {
  const thetaDelta = dx * 0.012;
  if (MOON.active) {
    rotateMoonScene(thetaDelta);
  } else {
    cam.tgtTheta += thetaDelta;
    cam.tgtPhi = clamp(cam.tgtPhi - dy * 0.012, -1.45, 1.45);
  }
  // Feed angular velocity into the cloth so centrifugal / tangential
  // forces in the physics loop respond to spinning via the orbit ball.
  const dt = Math.max(0.008, Math.min(0.05, (now - orbitLastTime) / 1000 || 0.016));
  // Blend with previous velocity for a smoother, more visible swing.
  orbitAngularVel = orbitAngularVel * 0.55 + (thetaDelta / dt) * 0.45;
  orbitLastTime = now;
}

orbitBall.addEventListener('mousedown', e => {
  orbitDragging = true; orbitLast = [e.clientX, e.clientY];
  orbitLastTime = performance.now();
  e.preventDefault();
});
window.addEventListener('mousemove', e => {
  if (!orbitDragging) return;
  const dx = e.clientX - orbitLast[0], dy = e.clientY - orbitLast[1];
  orbitBallApplyMove(dx, dy, performance.now());
  orbitLast = [e.clientX, e.clientY];
});
window.addEventListener('mouseup', () => { orbitDragging = false; });

orbitBall.addEventListener('touchstart', e => {
  orbitDragging = true;
  orbitLast = [e.touches[0].clientX, e.touches[0].clientY];
  orbitLastTime = performance.now();
  e.preventDefault();
}, { passive: false });
orbitBall.addEventListener('touchmove', e => {
  if (!orbitDragging) return;
  const dx = e.touches[0].clientX - orbitLast[0], dy = e.touches[0].clientY - orbitLast[1];
  orbitBallApplyMove(dx, dy, performance.now());
  orbitLast = [e.touches[0].clientX, e.touches[0].clientY];
  e.preventDefault();
}, { passive: false });
orbitBall.addEventListener('touchend', () => { orbitDragging = false; });

orbitBall.addEventListener('dblclick', () => {
  cam.tgtTheta = 0.0; cam.tgtPhi = 0.12;
});

// ─── Main loop ───────────────────────────────────────────────
let lastTime = 0, simAccum = 0;
let PAUSED = false;

// Pause indicator pill — shown at bottom-center while paused.
const pauseIndicator = document.createElement('div');
pauseIndicator.style.cssText = 'position:fixed;bottom:62px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.78);color:#fff;padding:8px 16px;font:700 13px "ABC Diatype",sans-serif;display:none;pointer-events:none;z-index:9999;letter-spacing:0.02em;';
pauseIndicator.textContent = 'Paused — Space to resume';
document.body.appendChild(pauseIndicator);

function togglePause() {
  if (someRecording) return; // don't allow mid-record
  PAUSED = !PAUSED;
  pauseIndicator.style.display = PAUSED ? 'block' : 'none';
}

window.addEventListener('keydown', e => {
  if (e.code !== 'Space') return;
  const t = e.target;
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
  e.preventDefault();
  togglePause();
});

const SIM_HZ = 50;
const SIM_DT = 1 / SIM_HZ;
const REC_FPS = 25;
const REC_STEPS = SIM_HZ / REC_FPS; // 2 physics steps per export frame
const REC_TOTAL_FRAMES = 10 * REC_FPS;      // 250 — output loop length

function loop(now) {
  requestAnimationFrame(loop);

  // During recording: 2 physics steps per frame, capture at 25fps.
  // Seamless mode encodes precomputed motion-warped frames. Raw mode keeps the
  // live sim path so the opt-out preserves the original export behavior.
  if (someRecording && _recCtx && _encoder) {
    if (_useSeamless && _loopFrames) applyLoopFrame(_loopFrames[_frameIdx]);
    else advanceRecordingMotionFrame(true);

    renderAndEncodeRecordingFrame(_frameIdx);
    _frameIdx++;

    const elapsed = _frameIdx / REC_FPS;
    document.getElementById('someExportBtn').textContent =
      'Recording ' + elapsed.toFixed(1) + 's / 10s';
    if (batchVideoExporting && batchStatus) batchStatus.textContent =
      batchVideoRowLabel + ' — ' + elapsed.toFixed(1) + 's / 10s';
    if (_frameIdx >= REC_TOTAL_FRAMES) {
      someRecording = false;
      lastTime = 0;
      finalizeExport();
    }
    return;
  }

  // CSV batch / PNG-sequence drive the cloth + render to their own FBO — skip
  // the on-screen render loop while they run.
  if (batchExporting || pngSeqExporting || _precomputingLoop) { lastTime = 0; return; }

  // Normal playback — 60hz physics via accumulator, render every frame
  if (!lastTime) { lastTime = now; return; }
  if (PAUSED) {
    // Keep camera responsive while physics is frozen.
    updateCamera(SIM_DT);
    updateMoonScene(SIM_DT);
    updateOrbitBall();
    lastTime = now;
    simAccum = 0;
    render(SIM_DT);
    return;
  }
  simAccum += (now - lastTime) / 1000;
  lastTime = now;
  if (simAccum > 0.1) simAccum = 0.1;
  let scrollDirty = false;
  while (simAccum >= SIM_DT) {
    simAccum -= SIM_DT;
    simulate(SIM_DT);
    updateCamera(SIM_DT);
    updateMoonScene(SIM_DT);
    if (textScrollSpeed > 0 && currentText.trim() && textLayout === 'repeat') {
      textScrollTime += SIM_DT * textScrollSpeed * 2.5;
      scrollDirty = true;
    }
  }
  // Regenerate the scrolled text texture once per rendered frame — repainting
  // the 4K canvas per substep compounded lag on slow frames (2-3 substeps).
  if (scrollDirty) generateTextTexture(textScrollTime);
  updateGustCharge();
  updateOrbitBall();
  render(SIM_DT);
}

// ─── Init ────────────────────────────────────────────────────
buildCreaseMap();
applySatinUniforms();
loadDefaultTexture();
requestAnimationFrame(loop);
