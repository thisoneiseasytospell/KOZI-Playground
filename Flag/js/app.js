// ══════════════════════════════════════════════════════════════
//  WdKA Gradshow 2026 — WebGL cloth simulation
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
const CONSTRAINT_ITERS = 4;
const POLE_RADIUS = 0.018;
const POLE_SEGMENTS = 48;

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

// Fabric model: 'classic' = original; 'realistic' = noise flutter + one-sided aero + heavier sag.
const REALISM = {
  mode: 'realistic',
  noiseFlutter: true,
  oneSidedAero: true,
  gravityMul: 1.8,
};
function setFabricMode(mode) {
  REALISM.mode = mode;
  const r = mode === 'realistic';
  REALISM.noiseFlutter = r;
  REALISM.oneSidedAero = r;
  REALISM.gravityMul = r ? 1.8 : 1.0;
}

// Weather preset — 'normal' or 'storm'. Storm widens angle-drift for swirling gusts.
const WEATHER = { mode: 'normal', angleDriftMax: 24, angleDriftForce: 1.0 };

// Attachment: 'edge' pins the full hoist column (pole flag); 'corners' pins only
// top-left + bottom-left (banner/rope attachment) so the hoist edge itself flaps.
const ATTACH = { mode: 'corners' };

// Slight-wave cloth mode — hand-tuned ripple for the name-tag prints.
// amp is a fraction of flag width (caps text distortion so every tag stays
// legible); freqU/freqV set the fold count; drift paces the live preview.
// Tuned for the head-on matte print view, where shading is the only depth
// cue: amp 0.09 → ~±30% diffuse swing + a visibly wavy fly edge, while the
// worst-case perspective warp on the text stays under 5% (still legible).
// strength is the live multiplier driven by the Strength slider (1 = baked).
const GENTLE = { amp: 0.09, freqU: 3.5, freqV: 2.6, drift: 0.18, strength: 1 };

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
let pos, prev, nrm, smoothNrm, uv, fixed;
let indexData, triIdx, numC, conA, conB, conR;

function allocArrays() {
  pos = new Float32Array(totalPts * 3);
  prev = new Float32Array(totalPts * 3);
  nrm = new Float32Array(totalPts * 3);
  smoothNrm = new Float32Array(totalPts * 3);
  uv = new Float32Array(totalPts * 2);
  fixed = new Uint8Array(totalPts);
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

// Snap the cloth to a flat plane (z = 0) with zero velocity — used by the
// "Flat" cloth mode so the flag renders as a clean flat panel.
function flattenCloth() {
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i, i3 = idx * 3;
      const u = i / (cols - 1), v = j / (rows - 1);
      pos[i3] = prev[i3] = u * flagW;
      pos[i3 + 1] = prev[i3 + 1] = -v * flagH + flagH * 0.8;
      pos[i3 + 2] = prev[i3 + 2] = 0;
    }
  }
  computeMeshNormals();
}

// "Slight wave" cloth mode — a flat panel with a small deterministic FBM
// ripple instead of the wind sim. z-only displacement with the hoist column
// held flat, so the texture-mapped text can never fold over or drift off
// centre; GENTLE.amp caps how far it can distort. `seed` picks the fold
// pattern (batch export passes the row index: every tag differs, re-exports
// are identical); `time` slowly drifts the pattern for the live preview.
function gentleClothPose(seed = 0, time = 0) {
  const amp = flagW * GENTLE.amp * GENTLE.strength;
  for (let j = 0; j < rows; j++) {
    const v = j / (rows - 1);
    const row3 = j * cols * 3;
    for (let i = 0; i < cols; i++) {
      const u = i / (cols - 1);
      const i3 = row3 + i * 3;
      pos[i3] = u * flagW;
      pos[i3 + 1] = -v * flagH + flagH * 0.8;
      pos[i3 + 2] = fbm2(
        u * GENTLE.freqU + seed * 13.71 + time * GENTLE.drift,
        v * GENTLE.freqV + seed * 7.31
      ) * amp * Math.pow(u, 0.7);
    }
    // Re-space x so each row keeps its rest length in 3D — the fly edge pulls
    // in slightly where the wave is bigger, reading as fabric, not embossing.
    for (let i = 1; i < cols; i++) {
      const i3 = row3 + i * 3;
      const dz = pos[i3 + 2] - pos[i3 - 1];
      const dx2 = restDx * restDx - dz * dz;
      pos[i3] = pos[i3 - 3] + Math.sqrt(Math.max(dx2, restDx * restDx * 0.25));
    }
  }
  prev.set(pos); // zero velocity so switching back to Full doesn't pop
  computeMeshNormals();
}

let _lastPinKey = '';
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
  if (ATTACH.mode === 'corners') {
    let topJ = -1, botJ = -1;
    for (let j = 0; j < rows; j++) {
      if (active(j * cols + L)) { if (topJ < 0) topJ = j; botJ = j; }
    }
    if (topJ < 0) { topJ = 0; botJ = rows - 1; }
    fixed[topJ * cols + L] = 1;
    fixed[botJ * cols + L] = 1;
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
}

function buildMesh() {
  computeActiveMask();
  applyPinning();

  triIdx = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      if (cellActive && !cellActive[j * (cols - 1) + i]) continue;
      const a = j * cols + i;
      triIdx.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
    }
  }
  indexData = new Uint32Array(triIdx);

  const cA = [], cB = [], cR = [];
  const act = i => !clothActive || clothActive[i];
  const addC = (a, b, r) => { if (act(a) && act(b)) { cA.push(a); cB.push(b); cR.push(r); } };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      if (i < cols - 1) addC(idx, idx + 1, restDx);
      if (j < rows - 1) addC(idx, idx + cols, restDy);
      if (i < cols - 1 && j < rows - 1) {
        addC(idx, idx + cols + 1, restDiag);
        addC(idx + 1, idx + cols, restDiag);
      }
      // Bend constraints also require the in-between particle — they must not
      // bridge across a notch cut into the shape (e.g. a swallowtail).
      if (i < cols - 2 && act(idx + 1)) addC(idx, idx + 2, restDx * 2 * 0.98);
      if (j < rows - 2 && act(idx + cols)) addC(idx, idx + cols * 2, restDy * 2 * 0.98);
    }
  }
  numC = cA.length;
  conA = new Uint32Array(cA);
  conB = new Uint32Array(cB);
  conR = new Float32Array(cR);
}

function rebuildGrid(aw, ah) {
  computeGrid(aw, ah);
  allocArrays();
  buildMesh();
  initCloth();
}
rebuildGrid(aspectW, aspectH);

// ─── Wind gust blobs (ported from original for organic motion) ─
const NUM_GUSTS = 9;
const gusts = [];
const gustPulse = new Float32Array(NUM_GUSTS);
const gustSwirl = new Float32Array(NUM_GUSTS);
let _loopSimPhase = -1;
let _loopGustBase = null;
let _loopSimStep = 0;
let _loopSimTotalSteps = 1;

function initGusts() {
  gusts.length = 0;
  for (let i = 0; i < NUM_GUSTS; i++) {
    gusts.push({
      x: Math.random() * 1.4 - 0.2,
      y: Math.random() * 1.4 - 0.2,
      vx: (Math.random() - 0.5) * 0.28,
      vy: (Math.random() - 0.5) * 0.20,
      r: 0.10 + Math.random() * 0.26,
      sx: (Math.random() - 0.5) * 2.8,
      sz: (Math.random() - 0.5) * 2.8,
      phase: Math.random() * Math.PI * 2.0,
      phaseVel: 1.2 + Math.random() * 2.6,
      pulse: 0.35 + Math.random() * 1.45,
      spin: (Math.random() < 0.5 ? -1 : 1) * (0.9 + Math.random() * 1.4),
    });
  }
}
initGusts();

function updateGusts(dt) {
  for (const g of gusts) {
    g.x += g.vx * dt;
    g.y += g.vy * dt;
    if (g.x < -0.5) g.x += 2.0;
    if (g.x > 1.5) g.x -= 2.0;
    if (g.y < -0.5) g.y += 2.0;
    if (g.y > 1.5) g.y -= 2.0;
    g.vx += (Math.random() - 0.5) * dt * 0.9;
    g.vy += (Math.random() - 0.5) * dt * 0.7;
    g.vx *= 0.993; g.vy *= 0.993;
    g.vx = clamp(g.vx, -0.55, 0.55);
    g.vy = clamp(g.vy, -0.55, 0.55);
    g.sx += (Math.random() - 0.5) * dt * 4.0;
    g.sz += (Math.random() - 0.5) * dt * 4.0;
    g.sx *= 0.987; g.sz *= 0.987;
    g.sx = clamp(g.sx, -3.4, 3.4);
    g.sz = clamp(g.sz, -3.4, 3.4);
    g.phase += g.phaseVel * dt;
    if (g.phase > Math.PI * 2) g.phase -= Math.PI * 2;
    g.phaseVel += (Math.random() - 0.5) * dt * 1.5;
    g.phaseVel = clamp(g.phaseVel, 0.7, 5.2);
    g.pulse += (Math.random() - 0.5) * dt * 1.8;
    g.pulse = clamp(g.pulse, 0.15, 1.8);
  }
}

function updateLoopGusts(phase) {
  if (!_loopGustBase) return;
  const tau = Math.PI * 2;
  for (let i = 0; i < gusts.length; i++) {
    const g = gusts[i];
    const b = _loopGustBase[i];
    const a = tau * phase + i * 1.731;
    const b2 = tau * phase * 2 + i * 0.917;
    g.x = clamp(b.x + Math.cos(a) * 0.16 + Math.sin(b2) * 0.05, -0.5, 1.5);
    g.y = clamp(b.y + Math.sin(a + 0.8) * 0.12 + Math.cos(b2 + 0.4) * 0.04, -0.5, 1.5);
    g.vx = 0;
    g.vy = 0;
    g.r = b.r;
    g.sx = clamp(b.sx + Math.sin(a + 1.4) * 0.65 + Math.sin(b2) * 0.20, -3.4, 3.4);
    g.sz = clamp(b.sz + Math.cos(a + 0.3) * 0.65 + Math.cos(b2 + 1.1) * 0.20, -3.4, 3.4);
    g.phase = b.phase + tau * phase * (1 + (i % 3));
    g.phaseVel = b.phaseVel;
    g.pulse = clamp(b.pulse + Math.sin(a - 0.6) * 0.28, 0.15, 1.8);
    g.spin = b.spin;
  }
}

// ─── Physics simulation (ported from original) ──────────────
let simTime = 0;
let windAngleDrift = 0, windAngleVel = 0, windStrengthDrift = 0;

function simulate(frameDt) {
  // The fixed sim step is SIM_DT (0.02s @ 50 Hz). The old 0.016 ceiling clamped
  // every step down to 80% of its intended length, so both the live view and the
  // MP4 export ran ~20% slow ("slow-mo"). Cap at 0.02 so a full step integrates
  // fully; the lower bound still guards against zero/negative frame deltas.
  const dt = clamp(frameDt, 0.004, 0.02);
  const subDt = dt / SUBSTEPS;

  // Update gusts once per frame. Seamless export gets a phase-looped gust
  // field so the correction pass is not fighting a random walk at the seam.
  if (_loopSimPhase >= 0) updateLoopGusts(_loopSimPhase);
  else updateGusts(dt);
  // Decay orbit angular velocity (smooth stop after user releases mouse)
  orbitAngularVel *= Math.exp(-dt * 1.2);

  // Ambient wind drift
  const driftMax = WEATHER.angleDriftMax;
  const turbNorm = SIM.turbulence / 100;
  if (_loopSimPhase >= 0) {
    const tau = Math.PI * 2;
    const a = _loopSimPhase * tau;
    windAngleDrift = clamp(
      Math.sin(a) * driftMax * 0.36 + Math.sin(a * 2 + 0.7) * driftMax * 0.10,
      -driftMax,
      driftMax
    );
    windAngleVel = 0;
    windStrengthDrift = clamp(
      Math.sin(a + 1.2) * (0.10 + turbNorm * 0.18) + Math.sin(a * 2 - 0.4) * (0.04 + turbNorm * 0.08),
      -0.75,
      0.75
    );
  } else {
    windAngleVel += (Math.random() - 0.5) * dt * (90 * WEATHER.angleDriftForce + driftMax * 4.5);
    windAngleVel += (-windAngleDrift * 0.55) * dt;
    windAngleVel *= Math.exp(-dt * 0.55);
    windAngleDrift += windAngleVel * dt;
    windAngleDrift = clamp(windAngleDrift, -driftMax, driftMax);

    windStrengthDrift += (Math.random() - 0.5) * dt * (1.8 + turbNorm * 8.0);
    windStrengthDrift *= Math.exp(-dt * 1.6);
    windStrengthDrift = clamp(windStrengthDrift, -0.75, 0.75);
  }

  for (let s = 0; s < SUBSTEPS; s++) {
    const dt2 = subDt * subDt;
    simTime += subDt;

    const damp = Math.pow(SIM.damping / 100, subDt * 85);
    const stormBlend = WEATHER.mode === 'storm' ? 1 : 0;
    const baseWind = clamp((SIM.windStrength / 100) * (1.0 + windStrengthDrift), 0, 3.5);
    const windBase = baseWind * baseWind * (stormBlend ? 19.0 : 24.0) + baseWind * (stormBlend ? 3.2 : 2.5);
    const turbAmt = SIM.turbulence / 100;
    const aRad = (SIM.windAngle + windAngleDrift) * Math.PI / 180;
    const wdx = Math.sin(aRad), wdz = Math.cos(aRad);
    // More iterations + firmer solve as wind grows — keeps silk feel at low wind
    // while preventing visible stretch under high wind / storm forces.
    // Keep iteration count modest even under storm — extra iterations are O(numC)
    // and destroy perf. Rely on air resistance (tames motion) + the hard stretch
    // clamp below for anti-stretch insurance instead.
    const iterations = Math.floor(SIM.stiffness / 100 * 2) + 3 + Math.floor(baseWind * 0.8) + stormBlend;
    const solveStrength = clamp(0.55 + (SIM.stiffness / 100) * 0.3 + baseWind * 0.1 + stormBlend * 0.14, 0.2, 1.3);
    const dragK = 0.06 + (1.0 - SIM.damping / 100) * 0.85 + baseWind * 0.02 + stormBlend * 0.045;
    const gravity = SIM.gravity * REALISM.gravityMul;
    const maxStep = Math.max(restDx, restDy) * (stormBlend ? (1.12 + baseWind * 0.42) : (1.3 + baseWind * 0.9));
    const turbResponse = Math.pow(turbAmt, 0.82);
    const turbField = turbResponse * (0.45 + baseWind * 0.85);

    // Gust phase (once per substep, not per particle)
    const activeGusts = stormBlend ? 6 : NUM_GUSTS;
    for (let g = 0; g < activeGusts; g++) {
      const gust = gusts[g];
      gustPulse[g] = (0.72 + Math.sin(gust.phase) * 0.28) * (0.42 + gust.pulse * 0.58);
      gustSwirl[g] = gust.spin * (0.22 + 0.34 * Math.cos(gust.phase * 0.75));
    }

    // Verlet integration
    for (let p = 0; p < totalPts; p++) {
      if (fixed[p]) continue;
      const i3 = p * 3;
      const px = pos[i3], py = pos[i3 + 1], pz = pos[i3 + 2];
      const vx = (px - prev[i3]) * damp;
      const vy = (py - prev[i3 + 1]) * damp;
      const vz = (pz - prev[i3 + 2]) * damp;
      prev[i3] = px; prev[i3 + 1] = py; prev[i3 + 2] = pz;

      const uv2 = p * 2;
      const u = uv[uv2], v = uv[uv2 + 1];

      // Gust blob turbulence
      let gustX = 0, gustZ = 0, gustLift = 0;
      for (let g = 0; g < activeGusts; g++) {
        const gust = gusts[g];
        const gdx = u - gust.x, gdy = v - gust.y;
        const d2 = gdx * gdx + gdy * gdy;
        const r2 = gust.r * gust.r;
        if (d2 < r2) {
          const w = 1.0 - d2 / r2;
          const w2 = w * w, w3 = w2 * w;
          const pulse = w2 * gustPulse[g];
          const swirl = w3 * gustSwirl[g];
          gustX += gust.sx * pulse - gdy * swirl;
          gustZ += gust.sz * pulse + gdx * swirl;
          gustLift += swirl * 0.30 + (pulse - 0.50) * 0.10;
        }
      }

      // Normal + attack angle
      const npx = nrm[i3], npy = nrm[i3 + 1], npz = nrm[i3 + 2];
      const nLen2 = npx * npx + npy * npy + npz * npz;
      const attackAngle = nLen2 > 1e-4 ? Math.abs(npx * wdx + npz * wdz) : 1.0;

      // Multi-scale spatial flutter
      const t = simTime;
      let flutterX, flutterZ;
      if (REALISM.noiseFlutter) {
        // FBM noise — fractal, incoherent. Wrinkles travel hoist→fly.
        const travel = t * 1.8;
        const stormness = stormBlend ? clamp((baseWind - 0.7) / 1.6, 0, 1) : clamp((baseWind - 1.2) / 1.8, 0, 1);
        const waveScale = 1.0 - stormness * (stormBlend ? 0.12 : 0.22); // keep finer detail under storm
        const fluFocus = 1.0 + Math.min(baseWind * 0.3, 0.7);
        const fluBase = 0.22;
        // Storm uses tighter, heavier folds instead of elastic over-extension.
        const ampU = (fluBase + Math.pow(u, fluFocus) * (stormBlend ? 0.95 : 1.35)) * (1.0 + stormness * (stormBlend ? 0.18 : 0.55));
        // Keep fly-end cracking, but cap it in storm so the silhouette does not stretch.
        const edgeWhip = u * u * u * (stormBlend ? (0.22 + baseWind * 0.24) : (0.35 + baseWind * 0.45)) * (1.0 + stormness * (stormBlend ? 0.12 : 0.45));
        flutterX = fbm2(u * 5.0 * waveScale - travel,        v * 4.0 * waveScale + t * 0.4)        * ampU * 1.25
                 + fbm2(u * 9.5 - travel * 1.7,              v * 7.0 + t * 0.9 + 51.3)             * edgeWhip;
        flutterZ = fbm2(u * 5.3 * waveScale - travel + 17.3, v * 4.2 * waveScale + t * 0.5 + 29.1) * ampU * 1.25
                 + fbm2(u * 10.1 - travel * 1.9,             v * 7.3 + t * 1.1 + 73.9)             * edgeWhip;
        // 4th octave — ultra-fine crinkle. Only amps up with wind, concentrated on fly half.
        const crinkleAmp = (0.06 + baseWind * (stormBlend ? 0.12 : 0.22)) * Math.pow(u, 0.55) * (1.0 + stormness * (stormBlend ? 0.32 : 0.7));
        flutterX += _noise2(u * 22.0 - travel * 2.3,         v * 17.0 + t * 1.6)                    * crinkleAmp;
        flutterZ += _noise2(u * 24.0 - travel * 2.1 + 37.1,  v * 19.0 + t * 1.4 + 11.3)             * crinkleAmp;
      } else {
        flutterX = (
          Math.sin(u * 18.7 + v * 9.1 + t * 6.8)
          + Math.sin(u * 4.3 - v * 14.2 + t * 9.4)
        ) * 0.45;
        flutterZ = (
          Math.cos(u * 15.3 - v * 11.7 + t * 7.9)
          + Math.sin(u * 7.9 + v * 13.1 + t * 5.6)
        ) * 0.45;
      }

      // Compose forces
      const wm = (0.3 + u * 0.7) * attackAngle;
      // Linear in baseWind (not quadratic windBase) so gusts scale gently at storm —
      // mean wind pulls flag taut, gusts add rolling body waves without overpowering.
      const gustScale = turbResponse * (baseWind * 32.0 + 2.2);

      // Per-point wind direction jitter — breaks laminar-flow look at high wind.
      // Low-frequency noise warps the wind vector slightly across u,v so different
      // parts of the flag get pushed at different angles → turbulent eddies form.
      // Weighted strongly toward the fly end: the hoist stays mostly aligned with
      // the mean wind, but downstream the flow becomes chaotic with multi-scale eddies.
      const flySwirl = 0.35 + u * u * (stormBlend ? 1.25 : 1.8);
      const swirlAmp = (0.3 + baseWind * (stormBlend ? 0.34 : 0.55)) * flySwirl;
      // Two scales of swirl — large eddies + fine vector noise.
      const swirlU = fbm2(u * 1.8 + t * 0.6,        v * 1.5 - t * 0.4 + 101.0) * swirlAmp
                   + _noise2(u * 5.5 + t * 1.3,     v * 4.8 - t * 0.9 + 41.0)  * swirlAmp * 0.45;
      const swirlV = fbm2(u * 1.7 - t * 0.5 + 73.0, v * 1.6 + t * 0.7 + 19.0)  * swirlAmp
                   + _noise2(u * 5.1 - t * 1.1 + 8.0, v * 5.3 + t * 1.0 + 55.0) * swirlAmp * 0.45;
      // Vertical wind component — real turbulent flow has up/down gusts too.
      const swirlY = _noise2(u * 2.4 + t * 0.7, v * 2.2 - t * 0.5 + 133.0) * swirlAmp * 0.55;
      const localWdx = wdx + swirlU;
      const localWdz = wdz + swirlV;

      // Vortex shedding — aeroelastic flag-flap mode. The wake behind the flag forms
      // alternating low-pressure vortices (Kármán street); this pushes the trailing edge
      // side-to-side perpendicular to wind. It's what makes real flags SNAP rather than
      // drift. Concentrated on the fly half; amplitude grows with wind.
      const vortexFreq = 0.85 + baseWind * 1.3;
      const vortexPhase = simTime * vortexFreq * 6.2831853;
      // sin(vortexPhase - u*k) → pattern travels hoist→fly. sin(v*π*1.2) → lazy S along height.
      const vortexSpatial = Math.sin(v * Math.PI * 1.2 + 0.4) * Math.sin(vortexPhase - u * 3.2);
      const vortexAmp = (
        stormBlend
          ? baseWind * baseWind * 0.38 + baseWind * 0.55
          : baseWind * baseWind * 0.9 + baseWind * 0.35
      ) * (u * u) * (0.55 + turbResponse * 0.9);
      const vortexX = -wdz * vortexSpatial * vortexAmp;
      const vortexZ =  wdx * vortexSpatial * vortexAmp;

      let fx = localWdx * windBase * wm + gustX * gustScale + flutterX * turbField + vortexX;
      let fy = gravity * (1.18 + v * 0.92 + u * u * 0.34) + gustLift * gustScale * 0.045
             + swirlY * windBase * wm;
      let fz = localWdz * windBase * wm + gustZ * gustScale + flutterZ * turbField + vortexZ;

      // Aerodynamic pressure
      if (nLen2 > 1e-4) {
        const ndw = npx * wdx + npz * wdz + npy * 0.05;
        const aeroK = (windBase * (0.75 + turbAmt * 0.55)) * (0.2 + u * 0.8);
        let aero;
        if (REALISM.oneSidedAero) {
          // Only windward face catches wind — no counter-push on leeward side.
          // Lets folds billow freely instead of getting flattened from both sides.
          const front = Math.max(ndw, 0.0);
          aero = front * front * aeroK;
        } else {
          aero = ndw * Math.abs(ndw) * aeroK;
        }
        fx += npx * aero;
        fy += Math.min(npy * aero * 0.24, 0.0);
        fz += npz * aero;
      }

      // Relative airflow drag
      const velX = vx / subDt, velY = vy / subDt, velZ = vz / subDt;
      const flowScale = (0.12 + attackAngle * 0.88) * (0.35 + u * 0.65);
      const flowX = wdx * windBase * flowScale;
      const flowZ = wdz * windBase * flowScale;
      const relX = velX - flowX, relZ = velZ - flowZ;
      if (u > 0.35 && velY > 0.0) fy -= velY * (0.016 + u * 0.028);
      const drag = dragK * (0.25 + u * 0.75);
      fx -= relX * drag;
      fy -= velY * drag * 0.8;
      fz -= relZ * drag;

      // Normal-based air resistance (cloth catches air like a sheet).
      // Both quadratic and linear terms — linear dominates at low speeds and
      // stops the fabric from drifting endlessly; quadratic bites hardest on
      // sudden snaps and keeps the vortex/whip forces from over-stretching.
      if (nLen2 > 1e-4) {
        const velDotN = velX * npx + velY * npy + velZ * npz;
        const airR = velDotN * Math.abs(velDotN) * (1.6 + stormBlend * 0.65) + velDotN * (0.9 + stormBlend * 0.35);
        fx -= npx * airR;
        fy -= npy * airR;
        fz -= npz * airR;
      }

      // Centrifugal force from camera orbit (spinning the pole)
      if (Math.abs(orbitAngularVel) > 0.05) {
        // Radial direction from pole axis (Y) outward in XZ plane
        const rx = px, rz = pz;
        const rLen = Math.sqrt(rx * rx + rz * rz) + 0.001;
        // F = m * omega^2 * r (outward), scaled by distance from pole (u)
        const centrifugal = orbitAngularVel * orbitAngularVel * rLen * u * 0.95;
        fx += (rx / rLen) * centrifugal;
        fz += (rz / rLen) * centrifugal;
        // Tangential impulse from angular acceleration — this is the main
        // "swing" the user perceives when spinning the pole
        const tangential = orbitAngularVel * u * 0.55;
        fx += (-rz / rLen) * tangential;
        fz += (rx / rLen) * tangential;
      }

      let nx = px + vx + fx * dt2;
      let ny = py + vy + fy * dt2;
      let nz = pz + vz + fz * dt2;

      const sx = nx - px, sy = ny - py, sz = nz - pz;
      const stepLen = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (stepLen > maxStep) {
        const sInv = maxStep / stepLen;
        nx = px + sx * sInv; ny = py + sy * sInv; nz = pz + sz * sInv;
      }
      pos[i3] = nx; pos[i3 + 1] = ny; pos[i3 + 2] = nz;
    }

    // Constraint solving
    for (let iter = 0; iter < iterations; iter++) {
      for (let c = 0; c < numC; c++) {
        const a = conA[c], b = conB[c];
        const a3 = a * 3, b3 = b * 3;
        const dx = pos[b3] - pos[a3], dy = pos[b3 + 1] - pos[a3 + 1], dz = pos[b3 + 2] - pos[a3 + 2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < 1e-7) continue;
        const diff = (dist - conR[c]) / dist * 0.5 * solveStrength;
        const cx = dx * diff, cy = dy * diff, cz = dz * diff;
        const af = fixed[a], bf = fixed[b];
        if (!af && !bf) {
          pos[a3] += cx; pos[a3 + 1] += cy; pos[a3 + 2] += cz;
          pos[b3] -= cx; pos[b3 + 1] -= cy; pos[b3 + 2] -= cz;
        } else if (!af) {
          pos[a3] += cx * 2; pos[a3 + 1] += cy * 2; pos[a3 + 2] += cz * 2;
        } else if (!bf) {
          pos[b3] -= cx * 2; pos[b3 + 1] -= cy * 2; pos[b3 + 2] -= cz * 2;
        }
      }
    }

    // Hard stretch clamp. Storm gets a tighter limit and one extra pass so it
    // reads as soaked, heavy fabric instead of rubber.
    const maxStretch = stormBlend ? 1.045 : 1.06;
    const clampPasses = 2;
    for (let pass = 0; pass < clampPasses; pass++) {
      for (let c = 0; c < numC; c++) {
        const a = conA[c], b = conB[c];
        const a3 = a * 3, b3 = b * 3;
        const dx = pos[b3] - pos[a3], dy = pos[b3 + 1] - pos[a3 + 1], dz = pos[b3 + 2] - pos[a3 + 2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const rMax = conR[c] * maxStretch;
        if (dist > rMax && dist > 1e-7) {
          const diff = (dist - rMax) / dist * 0.5;
          const cx = dx * diff, cy = dy * diff, cz = dz * diff;
          const af = fixed[a], bf = fixed[b];
          if (!af && !bf) {
            pos[a3] += cx; pos[a3 + 1] += cy; pos[a3 + 2] += cz;
            pos[b3] -= cx; pos[b3 + 1] -= cy; pos[b3 + 2] -= cz;
          } else if (!af) {
            pos[a3] += cx * 2; pos[a3 + 1] += cy * 2; pos[a3 + 2] += cz * 2;
          } else if (!bf) {
            pos[b3] -= cx * 2; pos[b3 + 1] -= cy * 2; pos[b3 + 2] -= cz * 2;
          }
        }
      }
    }

    // Anti-self-intersection
    for (let j = 1; j < rows - 1; j++) {
      for (let i = 1; i < cols - 1; i++) {
        const idx = j * cols + i;
        if (fixed[idx]) continue;
        // Inactive (out-of-shape) neighbors hold stale parked positions —
        // averaging them in would yank the cloth boundary every substep.
        if (clothActive && !(clothActive[idx - 1] && clothActive[idx + 1] &&
            clothActive[idx - cols] && clothActive[idx + cols])) continue;
        const i3 = idx * 3;
        const avgZ = (
          pos[(idx - 1) * 3 + 2] + pos[(idx + 1) * 3 + 2] +
          pos[(idx - cols) * 3 + 2] + pos[(idx + cols) * 3 + 2]
        ) * 0.25;
        const devZ = pos[i3 + 2] - avgZ;
        const limit = restDx * 1.65;
        if (Math.abs(devZ) > limit) {
          const correction = devZ > 0 ? devZ - limit : devZ + limit;
          pos[i3 + 2] -= correction * 0.5;
          prev[i3 + 2] -= correction * 0.5;
        }
      }
    }
    const minSep = restDx * 0.18;
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < rows; j++) {
        for (let i = 1; i < cols; i++) {
          const left = j * cols + i - 1, curr = left + 1;
          if (clothActive && !(clothActive[left] && clothActive[curr])) continue;
          const l3 = left * 3, c3 = curr * 3;
          const overlap = (pos[l3] + minSep) - pos[c3];
          if (overlap > 0) {
            if (!fixed[curr]) { pos[c3] += overlap; prev[c3] += overlap; }
            else if (!fixed[left]) { pos[l3] -= overlap; prev[l3] -= overlap; }
          }
        }
      }
    }
  }

  computeMeshNormals();
}

function computeMeshNormals() {
  nrm.fill(0);
  for (let t = 0; t < triIdx.length; t += 3) {
    const a = triIdx[t], b = triIdx[t + 1], c = triIdx[t + 2];
    const a3 = a * 3, b3 = b * 3, c3 = c * 3;
    const abx = pos[b3] - pos[a3], aby = pos[b3 + 1] - pos[a3 + 1], abz = pos[b3 + 2] - pos[a3 + 2];
    const acx = pos[c3] - pos[a3], acy = pos[c3 + 1] - pos[a3 + 1], acz = pos[c3 + 2] - pos[a3 + 2];
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    nrm[a3] += nx; nrm[a3 + 1] += ny; nrm[a3 + 2] += nz;
    nrm[b3] += nx; nrm[b3 + 1] += ny; nrm[b3 + 2] += nz;
    nrm[c3] += nx; nrm[c3 + 1] += ny; nrm[c3 + 2] += nz;
  }
  for (let i = 0; i < totalPts; i++) {
    const i3 = i * 3;
    const len = Math.sqrt(nrm[i3] ** 2 + nrm[i3 + 1] ** 2 + nrm[i3 + 2] ** 2);
    if (len > 0) { nrm[i3] /= len; nrm[i3 + 1] /= len; nrm[i3 + 2] /= len; }
  }
  for (let pass = 0; pass < 2; pass++) {
    const src = pass === 0 ? nrm : smoothNrm;
    const dst = pass === 0 ? smoothNrm : nrm;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const idx = j * cols + i;
        const i3 = idx * 3;
        let sx = src[i3], sy = src[i3 + 1], sz = src[i3 + 2];
        if (i > 0) { const n = (idx - 1) * 3; sx += src[n]; sy += src[n + 1]; sz += src[n + 2]; }
        if (i < cols - 1) { const n = (idx + 1) * 3; sx += src[n]; sy += src[n + 1]; sz += src[n + 2]; }
        if (j > 0) { const n = (idx - cols) * 3; sx += src[n]; sy += src[n + 1]; sz += src[n + 2]; }
        if (j < rows - 1) { const n = (idx + cols) * 3; sx += src[n]; sy += src[n + 1]; sz += src[n + 2]; }
        const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
        if (len > 1e-6) { dst[i3] = sx / len; dst[i3 + 1] = sy / len; dst[i3 + 2] = sz / len; }
        else { dst[i3] = 0; dst[i3 + 1] = 1; dst[i3 + 2] = 0; }
      }
    }
  }
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
attribute vec3 aPos, aNrm;
attribute vec2 aUV;
uniform mat4 uProj, uView, uModel;
varying vec3 vNrm, vPos, vLocalPos;
varying vec2 vUV;
void main() {
  vec4 wp = uModel * vec4(aPos, 1.0);
  vNrm = normalize(mat3(uModel) * aNrm);
  vPos = wp.xyz;
  vLocalPos = aPos;
  vUV = aUV;
  gl_Position = uProj * uView * wp;
}`;

const fsrc = `
precision highp float;
varying vec3 vNrm, vPos, vLocalPos;
varying vec2 vUV;
uniform vec3 uLight, uColor, uEye;
uniform sampler2D uTex, uMask;
uniform float uFace, uAlpha, uAmbient, uPartyTime, uMatte, uUnlit, uLightning, uMoonSurface;
uniform bool uHasTex, uIsGlass, uHasMask;
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

  // Normal lighting
  float ndl = dot(n, ld);
  float diff = max(ndl, 0.0) * 0.50;
  float fill = max(dot(n, normalize(vec3(-0.45, 0.35, -0.65))), 0.0) * 0.14;
  float back = max(-ndl, 0.0) * 0.20;
  // uMatte (0→1) fades out every reflective term for a flat, glare-free
  // print surface — keeps diffuse/fill/back so the cloth folds still read.
  float em = 1.0 - uMatte;
  float rim = pow(1.0 - max(dot(n, vd), 0.0), 2.8) * 0.18 * em;
  float spec = pow(max(dot(n, hd), 0.0), 72.0) * 0.14 * em;
  float spec2 = pow(max(dot(n, hd), 0.0), 16.0) * 0.16 * em;
  float spec3 = pow(max(dot(n, hd), 0.0), 160.0) * 0.10 * em;
  float light = uAmbient + diff + fill + back + rim + spec + spec2 + spec3;
  float sheen = pow(1.0 - max(dot(n, vd), 0.0), 4.0) * 0.07 * em;
  vec3 sheenTint = mix(vec3(0.84, 0.90, 0.98), vec3(0.98, 0.90, 0.84), vUV.y);
  vec3 lit = base * light + sheenTint * sheen;
  lit = mix(lit, base * 2.45 + vec3(0.18, 0.22, 0.32), flash * 0.68);
  gl_FragColor = vec4(lit, alpha * m);
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
['aPos', 'aNrm', 'aUV'].forEach(n => loc[n] = gl.getAttribLocation(prog, n));
['uProj', 'uView', 'uModel', 'uLight', 'uColor', 'uEye', 'uTex', 'uFace', 'uAlpha', 'uAmbient', 'uHasTex', 'uIsGlass', 'uPartyTime', 'uMatte', 'uUnlit', 'uMask', 'uHasMask', 'uLightning', 'uMoonSurface']
  .forEach(n => loc[n] = gl.getUniformLocation(prog, n));

// ─── Buffers ─────────────────────────────────────────────────
const posBuf = gl.createBuffer(), nrmBuf = gl.createBuffer();
const uvBuf = gl.createBuffer(), idxBuf = gl.createBuffer();
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

function uploadStaticBuffers() {
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, pos.byteLength, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
  gl.bufferData(gl.ARRAY_BUFFER, nrm.byteLength, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexData, gl.STATIC_DRAW);
}
uploadStaticBuffers();

// ─── Pole mesh ───────────────────────────────────────────────
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

  // Cylinder body — multiple rings for smooth shading along length
  const cylRings = 8;
  for (let ring = 0; ring <= cylRings; ring++) {
    const t = ring / cylRings;
    const y = yBot + (yTop - yBot) * t;
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

  // Ball finial — higher resolution
  const ballSegs = 16, ballRings = 12;
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
  gl.bindBuffer(gl.ARRAY_BUFFER, polePosBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
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
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexData, gl.STATIC_DRAW);
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
  cam.tgtDist = clamp((fitHalf / halfTan) * 1.15, 1.5, 20.0);
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
// (name-tag prints) · 'flat' = plain panel, no cloth effect at all.
let clothMode = 'full';
let gentleTime = 0; // drives the slow drift of the slight-wave live preview

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

  const ld = MOON.active ? [-0.32, 1.0, 0.58] : [0.5, 0.8, 0.35];
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

  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
  gl.enableVertexAttribArray(loc.aPos);
  gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, nrm);
  gl.enableVertexAttribArray(loc.aNrm);
  gl.vertexAttribPointer(loc.aNrm, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.enableVertexAttribArray(loc.aUV);
  gl.vertexAttribPointer(loc.aUV, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.enable(gl.CULL_FACE);

  gl.uniform1f(loc.uFace, -1.0);
  gl.cullFace(gl.FRONT);
  gl.drawElements(gl.TRIANGLES, indexData.length, gl.UNSIGNED_INT, 0);
  gl.uniform1f(loc.uFace, 1.0);
  gl.cullFace(gl.BACK);
  gl.drawElements(gl.TRIANGLES, indexData.length, gl.UNSIGNED_INT, 0);

  gl.disable(gl.CULL_FACE);
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

  const sx = flagW / oldW, sy = flagH / oldH, sz = Math.min(sx, sy);
  for (let k = 0; k < totalPts; k++) {
    const i3 = k * 3;
    pos[i3] *= sx; pos[i3 + 1] *= sy; pos[i3 + 2] *= sz;
    prev[i3] *= sx; prev[i3 + 1] *= sy; prev[i3 + 2] *= sz;
  }

  const dx2 = restDx * 2 * 0.98, dy2 = restDy * 2 * 0.98;
  for (let k = 0; k < numC; k++) {
    const d = conB[k] - conA[k];
    if (d === 1) conR[k] = restDx;
    else if (d === cols) conR[k] = restDy;
    else if (d === cols + 1 || d === cols - 1) conR[k] = restDiag;
    else if (d === 2) conR[k] = dx2;
    else if (d === 2 * cols) conR[k] = dy2;
  }

  buildPole();
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
    el.title = 'Drag to move · double-click to remove';
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
  const rectUV = e => {
    const r = miniFlagRect.getBoundingClientRect();
    return [
      clamp(Math.round((e.clientX - r.left) / r.width * 100) / 100, 0, 1),
      clamp(Math.round((e.clientY - r.top) / r.height * 100) / 100, 0, 1),
    ];
  };
  const onMove = e => {
    if (!sdrag) return;
    materializeShape();
    const [u, v] = rectUV(e);
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
    sdrag.el.releasePointerCapture?.(e.pointerId);
    const moved = sdrag.moved;
    sdrag = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
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
    if (e.target.closest('.mini-edge, [data-handle], .mini-dim')) return;
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

// Fabric model stays realistic by default; the old Classic/Realistic UI was removed.
const fabricModeRow = document.getElementById('fabricModeRow');
if (fabricModeRow) {
  fabricModeRow.addEventListener('click', e => {
    const btn = e.target.closest('[data-mode]');
    if (!btn || btn.classList.contains('active')) return;
    setActiveButton(fabricModeRow, '[data-mode]', btn);
    setFabricMode(btn.dataset.mode);
  });
}

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

// Attachment — Full edge / Two corners
const attachRow = document.getElementById('attachRow');
attachRow.addEventListener('click', e => {
  const btn = e.target.closest('[data-attach]');
  if (!btn || btn.classList.contains('active')) return;
  setActiveButton(attachRow, '[data-attach]', btn);
  ATTACH.mode = btn.dataset.attach;
  applyPinning();
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
// Student Takeover preset — text reads best centred on a square.
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
  setFabricMode('realistic');
  WEATHER.mode = 'normal';
  WEATHER.angleDriftMax = 24;
  WEATHER.angleDriftForce = 1.0;
  _savedWeather = null;
  clearLookSceneEffects();
  setActiveByData(weatherRow, '[data-weather]', 'weather', 'normal');
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
    if (clothMode === 'flat') flattenCloth();
    else if (clothMode === 'slight') gentleClothPose(0, gentleTime);
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
  const meshScale = 3; // 3x denser mesh via bilinear interpolation
  // 2× supersample if the GPU can host the larger renderbuffer/texture.
  const maxRb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const maxDim = Math.min(maxRb, maxTex);
  const ss = (outW * 2 <= maxDim && outH * 2 <= maxDim) ? 2 : 1;
  const w = outW * ss, h = outH * ss;

  // ── Build high-res mesh by interpolating current cloth ──
  const eCols = (cols - 1) * meshScale + 1;
  const eRows = (rows - 1) * meshScale + 1;
  const ePts = eCols * eRows;
  const ePos = new Float32Array(ePts * 3);
  const eNrm = new Float32Array(ePts * 3);
  const eUV = new Float32Array(ePts * 2);

  for (let ej = 0; ej < eRows; ej++) {
    for (let ei = 0; ei < eCols; ei++) {
      const eIdx = ej * eCols + ei;
      const origI = ei / meshScale, origJ = ej / meshScale;
      const i0 = Math.floor(origI), j0 = Math.floor(origJ);
      const i1 = Math.min(i0 + 1, cols - 1), j1 = Math.min(j0 + 1, rows - 1);
      const fi = origI - i0, fj = origJ - j0;
      const p00 = j0 * cols + i0, p10 = j0 * cols + i1;
      const p01 = j1 * cols + i0, p11 = j1 * cols + i1;
      const w00 = (1 - fi) * (1 - fj), w10 = fi * (1 - fj);
      const w01 = (1 - fi) * fj, w11 = fi * fj;
      for (let k = 0; k < 3; k++) {
        ePos[eIdx * 3 + k] = w00 * pos[p00 * 3 + k] + w10 * pos[p10 * 3 + k]
                            + w01 * pos[p01 * 3 + k] + w11 * pos[p11 * 3 + k];
        eNrm[eIdx * 3 + k] = w00 * nrm[p00 * 3 + k] + w10 * nrm[p10 * 3 + k]
                            + w01 * nrm[p01 * 3 + k] + w11 * nrm[p11 * 3 + k];
      }
      const ni = eIdx * 3;
      const nl = Math.sqrt(eNrm[ni] ** 2 + eNrm[ni + 1] ** 2 + eNrm[ni + 2] ** 2);
      if (nl > 0) { eNrm[ni] /= nl; eNrm[ni + 1] /= nl; eNrm[ni + 2] /= nl; }
      eUV[eIdx * 2] = ei / (eCols - 1);
      eUV[eIdx * 2 + 1] = ej / (eRows - 1);
    }
  }

  // Build triangle indices for dense mesh. Each dense cell lies fully inside
  // one coarse cell — skip those whose parent is trimmed away by the custom
  // shape, so no triangles interpolate toward parked inactive particles.
  const eTriIdx = [];
  for (let j = 0; j < eRows - 1; j++) {
    for (let i = 0; i < eCols - 1; i++) {
      if (cellActive && !cellActive[Math.floor(j / meshScale) * (cols - 1) + Math.floor(i / meshScale)]) continue;
      const a = j * eCols + i;
      eTriIdx.push(a, a + eCols, a + 1, a + 1, a + eCols, a + eCols + 1);
    }
  }
  const eIndexData = new Uint32Array(eTriIdx);

  // Create temporary GPU buffers for high-res mesh
  const ePosBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, ePosBuf);
  gl.bufferData(gl.ARRAY_BUFFER, ePos, gl.STATIC_DRAW);
  const eNrmBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, eNrmBuf);
  gl.bufferData(gl.ARRAY_BUFFER, eNrm, gl.STATIC_DRAW);
  const eUVBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, eUVBuf);
  gl.bufferData(gl.ARRAY_BUFFER, eUV, gl.STATIC_DRAW);
  const eIdxBuf = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, eIdxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, eIndexData, gl.STATIC_DRAW);

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

  const ld = [0.5, 0.8, 0.35];
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

  gl.bindBuffer(gl.ARRAY_BUFFER, ePosBuf);
  gl.enableVertexAttribArray(loc.aPos);
  gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, eNrmBuf);
  gl.enableVertexAttribArray(loc.aNrm);
  gl.vertexAttribPointer(loc.aNrm, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, eUVBuf);
  gl.enableVertexAttribArray(loc.aUV);
  gl.vertexAttribPointer(loc.aUV, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, eIdxBuf);
  gl.enable(gl.CULL_FACE);

  gl.uniform1f(loc.uFace, -1.0);
  gl.cullFace(gl.FRONT);
  gl.drawElements(gl.TRIANGLES, eIndexData.length, gl.UNSIGNED_INT, 0);
  gl.uniform1f(loc.uFace, 1.0);
  gl.cullFace(gl.BACK);
  gl.drawElements(gl.TRIANGLES, eIndexData.length, gl.UNSIGNED_INT, 0);

  gl.disable(gl.CULL_FACE);
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
  gl.deleteBuffer(ePosBuf);
  gl.deleteBuffer(eNrmBuf);
  gl.deleteBuffer(eUVBuf);
  gl.deleteBuffer(eIdxBuf);
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
  // Print + Tags Video + Student are all title-card presets sharing the Name
  // Tag Text blocks; print gets the CSV→ZIP/PDF machinery, tagsvideo gets the
  // CSV→MP4-per-row machinery, student gets neither.
  if (someFormat === 'print' || someFormat === 'student' || someFormat === 'tagsvideo') {
    const isPrint = someFormat === 'print', isVideo = someFormat === 'tagsvideo';
    ffiSection.style.display = '';
    batchSection.style.display = (isPrint || isVideo) ? '' : 'none';
    setBatchSectionMode(isVideo);
    if (singlePdfBtn) singlePdfBtn.style.display = isPrint ? '' : 'none';
    // Video preset: 10s MP4 is the only deliverable — drop the stills buttons
    // and the cloth pills (full motion is forced by the preset).
    setDisplay('exportBtn', isVideo ? 'none' : '');
    setDisplay('someSeqBtn', isVideo ? 'none' : '');
    setDisplay('clothSection', isVideo ? 'none' : '');
    if (isPrint) applyPrintPreset();
    else if (isVideo) applyTagsVideoPreset();
    else applyStudentPreset();
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
  setDisplay('clothSection', '');
  // Leaving print/tagsvideo/student — restore the studio surface + generic text rendering.
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
function applyTitleCardPreset({ format, width, height, matte, cameraDist, cloth, updateBatch }) {
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

  if (cloth) setClothMode(cloth);

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

// Student Takeover — the name-tag flag as a 9:16 social video: same title-card
// text blocks and print palette, 1080×1920, 10s MP4 export. None of the
// print/batch machinery (no CSV, no PDF, no A5).
function applyStudentPreset() {
  applyTitleCardPreset({
    format: 'student',
    width: 1080,
    height: 1920,
    matte: false,
    cameraDist: 6.9,
  });
}

// Name Tags Video — the name-tag flag as a 16:9 video, batched: the CSV that
// feeds the print run feeds this too, but every row becomes its own 10s MP4
// (1920×1080). Full cloth only — the preset forces it and the UI hides the
// cloth pills; no PNG/PDF outputs here.
function applyTagsVideoPreset() {
  applyTitleCardPreset({
    format: 'tagsvideo',
    width: 1920,
    height: 1080,
    matte: false,
    cameraDist: 4.8,
    cloth: 'full',
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

const unlitToggle = document.getElementById('unlitToggle');
function setUnlitMode(on) {
  unlitMode = on;
  if (unlitToggle) unlitToggle.checked = on;
}
if (unlitToggle) unlitToggle.addEventListener('change', () => { unlitMode = unlitToggle.checked; });

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

    // Flat = identical clean panel per row; slight = unique-but-bounded ripple
    // seeded by the row index (deterministic — re-exporting the same CSV gives
    // identical files); full = advance wind for a unique untamed pose.
    if (clothMode === 'flat') flattenCloth();
    else if (clothMode === 'slight') gentleClothPose(i + 1);
    else for (let s = 0; s < STEP_FRAMES; s++) simulate(SIM_DT);

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
const clothModeRow = document.getElementById('clothModeRow');
const gentleStrengthRow = document.getElementById('gentleStrengthRow');
function setClothMode(mode) {
  clothMode = mode;
  setActiveByData(clothModeRow, '[data-cloth]', 'cloth', mode);
  if (gentleStrengthRow) gentleStrengthRow.style.display = mode === 'slight' ? '' : 'none';
  if (mode === 'flat') flattenCloth();
  else if (mode === 'slight') gentleClothPose(0, gentleTime);
}
if (clothModeRow) clothModeRow.addEventListener('click', e => {
  const btn = e.target.closest('[data-cloth]');
  if (!btn || btn.classList.contains('active')) return;
  setClothMode(btn.dataset.cloth);
});
// Strength slider — 50 = the baked default amplitude, 100 = double.
const gentleStrengthIn = document.getElementById('gentleStrength');
if (gentleStrengthIn) gentleStrengthIn.addEventListener('input', () => {
  const v = parseInt(gentleStrengthIn.value, 10) || 50;
  GENTLE.strength = v / 50;
  const lbl = document.getElementById('gentleStrengthVal');
  if (lbl) lbl.textContent = v;
  if (clothMode === 'slight') gentleClothPose(0, gentleTime);
});

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
  const ld = [0.5, 0.8, 0.35];
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

  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
  gl.enableVertexAttribArray(loc.aPos);
  gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, nrm);
  gl.enableVertexAttribArray(loc.aNrm);
  gl.vertexAttribPointer(loc.aNrm, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.enableVertexAttribArray(loc.aUV);
  gl.vertexAttribPointer(loc.aUV, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.enable(gl.CULL_FACE);

  gl.uniform1f(loc.uFace, -1.0);
  gl.cullFace(gl.FRONT);
  gl.drawElements(gl.TRIANGLES, indexData.length, gl.UNSIGNED_INT, 0);
  gl.uniform1f(loc.uFace, 1.0);
  gl.cullFace(gl.BACK);
  gl.drawElements(gl.TRIANGLES, indexData.length, gl.UNSIGNED_INT, 0);

  gl.disable(gl.CULL_FACE);
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
  return gusts.map(g => ({
    x: g.x, y: g.y, vx: g.vx, vy: g.vy, r: g.r,
    sx: g.sx, sz: g.sz, phase: g.phase, phaseVel: g.phaseVel,
    pulse: g.pulse, spin: g.spin,
  }));
}

function restoreGustState(state) {
  gusts.length = 0;
  for (const g of state) gusts.push({ ...g });
}

function snapshotMotionState() {
  return {
    pos: new Float32Array(pos),
    prev: new Float32Array(prev),
    nrm: new Float32Array(nrm),
    smoothNrm: new Float32Array(smoothNrm),
    gusts: cloneGustState(),
    simTime,
    windAngleDrift,
    windAngleVel,
    windStrengthDrift,
    orbitAngularVel,
    gentleTime,
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
  smoothNrm.set(state.smoothNrm);
  restoreGustState(state.gusts);
  simTime = state.simTime;
  windAngleDrift = state.windAngleDrift;
  windAngleVel = state.windAngleVel;
  windStrengthDrift = state.windStrengthDrift;
  orbitAngularVel = state.orbitAngularVel;
  gentleTime = state.gentleTime;
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
    if (clothMode === 'full') {
      if (_loopGustBase) {
        _loopSimPhase = (_loopSimStep % _loopSimTotalSteps) / _loopSimTotalSteps;
        _loopSimStep++;
      }
      simulate(SIM_DT);
      if (_loopGustBase) _loopSimPhase = -1;
    }
    else if (clothMode === 'slight') gentleTime += SIM_DT;
    updateCamera(SIM_DT);
    updateMoonScene(SIM_DT);
    if (textScrollSpeed > 0 && currentText.trim() && textLayout === 'repeat') {
      textScrollTime += SIM_DT * textScrollSpeed * 2.5;
      scrollDirty = true;
    }
  }
  if (updateTexture && scrollDirty) generateTextTexture(textScrollTime);
  if (clothMode === 'flat') flattenCloth();
  else if (clothMode === 'slight') gentleClothPose(0, gentleTime);
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
  try {
    for (let f = 0; f <= REC_TOTAL_FRAMES; f++) {
      advanceRecordingMotionFrame(false);
        frames.push({
          pos: new Float32Array(pos),
          cam: cloneCameraState(),
          moon: cloneMoonState(),
          gentleTime,
          textScrollTime,
        });
      if (f % 20 === 0) {
        if (onProgress) onProgress(f, REC_TOTAL_FRAMES);
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
  gentleTime = frame.gentleTime;
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
pauseIndicator.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.78);color:#fff;padding:8px 16px;border-radius:999px;font:700 13px "ABC Diatype",sans-serif;display:none;pointer-events:none;z-index:9999;letter-spacing:0.02em;';
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
    if (clothMode === 'full') simulate(SIM_DT);
    else if (clothMode === 'slight') gentleTime += SIM_DT;
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
  if (clothMode === 'flat') flattenCloth();
  else if (clothMode === 'slight') gentleClothPose(0, gentleTime);
  updateOrbitBall();
  render(SIM_DT);
}

// ─── Init ────────────────────────────────────────────────────
loadDefaultTexture();
requestAnimationFrame(loop);
