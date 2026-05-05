// ══════════════════════════════════════════════════════════════
//  FLAG STUDIO — WebGL cloth simulation
// ══════════════════════════════════════════════════════════════

const DEFAULT_TEXTURE_PATH = 'demo%20flag.png';

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

function applyPinning() {
  if (ATTACH.mode === 'corners') {
    for (let i = 0; i < totalPts; i++) fixed[i] = 0;
    fixed[0] = 1;
    fixed[(rows - 1) * cols] = 1;
    // Kickstart: nudge the now-free hoist column slightly outward in z so it
    // immediately starts billowing instead of hanging dead at z=0.
    if (pos) {
      for (let j = 1; j < rows - 1; j++) {
        const idx = j * cols;
        const i3 = idx * 3;
        const bow = Math.sin(j / (rows - 1) * Math.PI) * restDx * 0.8;
        pos[i3 + 2] = bow;
        prev[i3 + 2] = bow - 0.001;
      }
    }
  } else {
    for (let i = 0; i < totalPts; i++) fixed[i] = (i % cols === 0) ? 1 : 0;
    // Snap hoist column back to its initial straight position — otherwise
    // particles stay pinned wherever they drifted to during 'corners' mode.
    if (pos) {
      for (let j = 0; j < rows; j++) {
        const idx = j * cols;
        const i3 = idx * 3;
        const y = -(j / (rows - 1)) * flagH + flagH * 0.8;
        pos[i3] = prev[i3] = 0;
        pos[i3 + 1] = prev[i3 + 1] = y;
        pos[i3 + 2] = prev[i3 + 2] = 0;
      }
    }
  }
}

function buildMesh() {
  applyPinning();

  triIdx = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i;
      triIdx.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
    }
  }
  indexData = new Uint32Array(triIdx);

  const cA = [], cB = [], cR = [];
  const addC = (a, b, r) => { cA.push(a); cB.push(b); cR.push(r); };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      if (i < cols - 1) addC(idx, idx + 1, restDx);
      if (j < rows - 1) addC(idx, idx + cols, restDy);
      if (i < cols - 1 && j < rows - 1) {
        addC(idx, idx + cols + 1, restDiag);
        addC(idx + 1, idx + cols, restDiag);
      }
      if (i < cols - 2) addC(idx, idx + 2, restDx * 2 * 0.98);
      if (j < rows - 2) addC(idx, idx + cols * 2, restDy * 2 * 0.98);
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

// ─── Physics simulation (ported from original) ──────────────
let simTime = 0;
let windAngleDrift = 0, windAngleVel = 0, windStrengthDrift = 0;

function simulate(frameDt) {
  const dt = clamp(frameDt, 0.004, 0.016);
  const subDt = dt / SUBSTEPS;

  // Update gusts once per frame
  updateGusts(dt);
  // Decay orbit angular velocity (smooth stop after user releases mouse)
  orbitAngularVel *= Math.exp(-dt * 1.2);

  // Ambient wind drift
  const driftMax = WEATHER.angleDriftMax;
  windAngleVel += (Math.random() - 0.5) * dt * (90 * WEATHER.angleDriftForce + driftMax * 4.5);
  windAngleVel += (-windAngleDrift * 0.55) * dt;
  windAngleVel *= Math.exp(-dt * 0.55);
  windAngleDrift += windAngleVel * dt;
  windAngleDrift = clamp(windAngleDrift, -driftMax, driftMax);

  const turbNorm = SIM.turbulence / 100;
  windStrengthDrift += (Math.random() - 0.5) * dt * (1.8 + turbNorm * 8.0);
  windStrengthDrift *= Math.exp(-dt * 1.6);
  windStrengthDrift = clamp(windStrengthDrift, -0.75, 0.75);

  for (let s = 0; s < SUBSTEPS; s++) {
    const dt2 = subDt * subDt;
    simTime += subDt;

    const damp = Math.pow(SIM.damping / 100, subDt * 85);
    const baseWind = clamp((SIM.windStrength / 100) * (1.0 + windStrengthDrift), 0, 3.5);
    const windBase = baseWind * baseWind * 24.0 + baseWind * 2.5;
    const turbAmt = SIM.turbulence / 100;
    const aRad = (SIM.windAngle + windAngleDrift) * Math.PI / 180;
    const wdx = Math.sin(aRad), wdz = Math.cos(aRad);
    // More iterations + firmer solve as wind grows — keeps silk feel at low wind
    // while preventing visible stretch under high wind / storm forces.
    // Keep iteration count modest even under storm — extra iterations are O(numC)
    // and destroy perf. Rely on air resistance (tames motion) + the hard stretch
    // clamp below for anti-stretch insurance instead.
    const iterations = Math.floor(SIM.stiffness / 100 * 2) + 3 + Math.floor(baseWind * 0.8);
    const solveStrength = clamp(0.55 + (SIM.stiffness / 100) * 0.3 + baseWind * 0.1, 0.2, 1.2);
    const dragK = 0.06 + (1.0 - SIM.damping / 100) * 0.85 + baseWind * 0.02;
    const gravity = SIM.gravity * REALISM.gravityMul;
    const maxStep = Math.max(restDx, restDy) * (1.3 + baseWind * 0.9);
    const turbResponse = Math.pow(turbAmt, 0.82);
    const turbField = turbResponse * (0.45 + baseWind * 0.85);

    // Gust phase (once per substep, not per particle)
    for (let g = 0; g < NUM_GUSTS; g++) {
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
      for (let g = 0; g < NUM_GUSTS; g++) {
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
        const stormness = clamp((baseWind - 1.2) / 1.8, 0, 1);
        const waveScale = 1.0 - stormness * 0.22; // keep finer detail under storm
        const fluFocus = 1.0 + Math.min(baseWind * 0.3, 0.7);
        const fluBase = 0.22;
        // Big amplitude boost under storm — real storm flags have dramatic folds.
        const ampU = (fluBase + Math.pow(u, fluFocus) * 1.35) * (1.0 + stormness * 0.55);
        // Edge whip GROWS with wind + storm — the fly end cracking is the signature motion.
        const edgeWhip = u * u * u * (0.35 + baseWind * 0.45) * (1.0 + stormness * 0.45);
        flutterX = fbm2(u * 5.0 * waveScale - travel,        v * 4.0 * waveScale + t * 0.4)        * ampU * 1.25
                 + fbm2(u * 9.5 - travel * 1.7,              v * 7.0 + t * 0.9 + 51.3)             * edgeWhip;
        flutterZ = fbm2(u * 5.3 * waveScale - travel + 17.3, v * 4.2 * waveScale + t * 0.5 + 29.1) * ampU * 1.25
                 + fbm2(u * 10.1 - travel * 1.9,             v * 7.3 + t * 1.1 + 73.9)             * edgeWhip;
        // 4th octave — ultra-fine crinkle. Only amps up with wind, concentrated on fly half.
        const crinkleAmp = (0.06 + baseWind * 0.22) * Math.pow(u, 0.55) * (1.0 + stormness * 0.7);
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
      const flySwirl = 0.35 + u * u * 1.8;
      const swirlAmp = (0.3 + baseWind * 0.55) * flySwirl;
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
      const vortexAmp = (baseWind * baseWind * 0.9 + baseWind * 0.35) * (u * u) * (0.55 + turbResponse * 0.9);
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
        const airR = velDotN * Math.abs(velDotN) * 1.6 + velDotN * 0.9;
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

    // Hard stretch clamp — any constraint exceeding 1.06× rest is pulled back
    // to exactly 1.06×. Two passes so neighboring overshoots propagate correctly.
    const maxStretch = 1.06;
    for (let pass = 0; pass < 2; pass++) {
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
void main() {
  gl_FragColor = vec4(uBg, 1.0);
}`;

// Main scene shaders
const vsrc = `
attribute vec3 aPos, aNrm;
attribute vec2 aUV;
uniform mat4 uProj, uView;
varying vec3 vNrm, vPos;
varying vec2 vUV;
void main() {
  vNrm = aNrm; vPos = aPos; vUV = aUV;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

const fsrc = `
precision highp float;
varying vec3 vNrm, vPos;
varying vec2 vUV;
uniform vec3 uLight, uColor, uEye;
uniform sampler2D uTex;
uniform float uFace, uAlpha, uAmbient, uPartyTime;
uniform bool uHasTex, uIsGlass;
vec3 hsv(float h, float s, float v) {
  vec3 r = clamp(abs(mod(h*6.0+vec3(0,4,2),6.0)-3.0)-1.0,0.0,1.0);
  return v * mix(vec3(1), r, s);
}
void main() {
  vec3 n = normalize(vNrm) * uFace;
  vec3 vd = normalize(uEye - vPos);
  vec3 ld = normalize(uLight);
  vec3 hd = normalize(ld + vd);

  if (uIsGlass) {
    float pndl = dot(n, ld);
    float pdiff = max(pndl, 0.0) * 0.42;
    float pfill = max(dot(n, normalize(vec3(-0.45, 0.35, -0.65))), 0.0) * 0.15;
    float pback = max(-pndl, 0.0) * 0.10;
    float pspec = pow(max(dot(n, hd), 0.0), 6.0) * 0.05;
    float plight = 0.42 + pdiff + pfill + pback + pspec;
    vec3 pc = uColor;
    if (uPartyTime > 0.0) {
      float t = uPartyTime;
      float strobe = step(0.0, sin(t * 12.0));
      pc = uColor * mix(0.15, 1.8, strobe);
    }
    gl_FragColor = vec4(pc * plight, 1.0);
    return;
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

  // Party mode: black/white strobe flash
  if (uPartyTime > 0.0) {
    float t = uPartyTime;
    float strobe = step(0.0, sin(t * 12.0));
    vec3 lit = base * mix(0.02, 2.2, strobe);
    gl_FragColor = vec4(lit, alpha);
    return;
  }

  // Normal lighting
  float ndl = dot(n, ld);
  float diff = max(ndl, 0.0) * 0.50;
  float fill = max(dot(n, normalize(vec3(-0.45, 0.35, -0.65))), 0.0) * 0.14;
  float back = max(-ndl, 0.0) * 0.20;
  float rim = pow(1.0 - max(dot(n, vd), 0.0), 2.8) * 0.18;
  float spec = pow(max(dot(n, hd), 0.0), 72.0) * 0.14;
  float spec2 = pow(max(dot(n, hd), 0.0), 16.0) * 0.16;
  float spec3 = pow(max(dot(n, hd), 0.0), 160.0) * 0.10;
  float light = uAmbient + diff + fill + back + rim + spec + spec2 + spec3;
  float sheen = pow(1.0 - max(dot(n, vd), 0.0), 4.0) * 0.07;
  vec3 sheenTint = mix(vec3(0.84, 0.90, 0.98), vec3(0.98, 0.90, 0.84), vUV.y);
  vec3 lit = base * light + sheenTint * sheen;
  gl_FragColor = vec4(lit, alpha);
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
};
const quadBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, 1,1, -1,-1, 1,1, -1,1]), gl.STATIC_DRAW);

// Main scene program
const prog = gl.createProgram();
gl.attachShader(prog, compileShader(vsrc, gl.VERTEX_SHADER));
gl.attachShader(prog, compileShader(fsrc, gl.FRAGMENT_SHADER));
gl.linkProgram(prog); gl.useProgram(prog);

const loc = {};
['aPos', 'aNrm', 'aUV'].forEach(n => loc[n] = gl.getAttribLocation(prog, n));
['uProj', 'uView', 'uLight', 'uColor', 'uEye', 'uTex', 'uFace', 'uAlpha', 'uAmbient', 'uHasTex', 'uIsGlass', 'uPartyTime']
  .forEach(n => loc[n] = gl.getUniformLocation(prog, n));

// ─── Buffers ─────────────────────────────────────────────────
const posBuf = gl.createBuffer(), nrmBuf = gl.createBuffer();
const uvBuf = gl.createBuffer(), idxBuf = gl.createBuffer();
let polePosBuf = gl.createBuffer(), poleNrmBuf = gl.createBuffer();
let poleUVBuf = gl.createBuffer(), poleIdxBuf = gl.createBuffer();
let poleIdxCount = 0;

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
buildPole();

// ─── Texture ─────────────────────────────────────────────────
let flagTex = null, hasTex = false;

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
  hasTex = true;
}

function removeTexture() {
  if (flagTex) { gl.deleteTexture(flagTex); flagTex = null; }
  hasTex = false;
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

// ─── Camera (orbit + pan + zoom) ─────────────────────────────
const cam = {
  tgtTheta: 0.0, tgtPhi: 0.12, tgtDist: 5,
  curTheta: 0.0, curPhi: 0.12, curDist: 5,
  tgtTarget: [0, 0, 0],
  target: [0, 0, 0],
};

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
}

function updateCamera(dt) {
  const lf = 1 - Math.pow(0.0004, dt);
  // Apply spinning momentum — flag keeps rotating after flick.
  // Skip while actively dragging (canvas orbit or orbit ball) since those
  // paths drive tgtTheta directly; otherwise we'd double-integrate.
  const actDrag = orbiting || (typeof orbitDragging !== 'undefined' && orbitDragging);
  if (!actDrag && Math.abs(orbitAngularVel) > 0.05) {
    cam.tgtTheta += orbitAngularVel * dt;
  }
  cam.curTheta += (cam.tgtTheta - cam.curTheta) * lf;
  cam.curPhi += (cam.tgtPhi - cam.curPhi) * lf;
  cam.curDist += (cam.tgtDist - cam.curDist) * lf;
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
  if (e.button === 0) { panning = true; lastM = [e.clientX, e.clientY]; e.preventDefault(); }
  else if (e.button === 2) { orbiting = true; lastM = [e.clientX, e.clientY]; e.preventDefault(); }
});
window.addEventListener('mouseup', () => { orbiting = false; panning = false; });
window.addEventListener('mousemove', e => {
  const dx = e.clientX - lastM[0], dy = e.clientY - lastM[1];
  if (panning) {
    panCamera(dx, dy);
  } else if (orbiting) {
    cam.tgtTheta -= dx * 0.006;
    cam.tgtPhi = clamp(cam.tgtPhi + dy * 0.005, -1.45, 1.45);
    orbitAngularVel = -dx * 0.006 / 0.016;
  } else { return; }
  lastM = [e.clientX, e.clientY];
});
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const speed = (e.ctrlKey || e.metaKey) ? 0.003 : 0.0015;
  cam.tgtDist = clamp(cam.tgtDist * Math.exp(e.deltaY * speed), 1.0, 20);
}, { passive: false });

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
    cam.tgtTheta -= dx * 0.006;
    cam.tgtPhi = clamp(cam.tgtPhi + dy * 0.005, -1.45, 1.45);
    orbitAngularVel = -dx * 0.006 / 0.016;
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

// ─── Renderer ────────────────────────────────────────────────
function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  gl.viewport(0, 0, canvas.width, canvas.height);
}
window.addEventListener('resize', resize);
resize();
autoFrame();
cam.curDist = cam.tgtDist; // no zoom animation on load
cam.curTheta = cam.tgtTheta;
cam.curPhi = cam.tgtPhi;

let partyMode = false, partyTime = 0;

function render(dt) {
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // ── HDRI background ──
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(bgProg);
  gl.uniform3f(bgLoc.uBg, SIM.bgColor[0], SIM.bgColor[1], SIM.bgColor[2]);
  gl.disableVertexAttribArray(loc.aNrm); // avoid leftover state
  gl.disableVertexAttribArray(loc.aUV);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.enableVertexAttribArray(bgLoc.aP);
  gl.vertexAttribPointer(bgLoc.aP, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.disableVertexAttribArray(bgLoc.aP);
  gl.enable(gl.DEPTH_TEST);

  // ── Scene ──
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const ld = [0.5, 0.8, 0.35];
  const ll = Math.sqrt(ld[0] ** 2 + ld[1] ** 2 + ld[2] ** 2);
  const e = eyePos();

  gl.useProgram(prog);
  gl.uniform1f(loc.uPartyTime, 0.0);
  gl.uniformMatrix4fv(loc.uProj, false, perspective(Math.PI / 4.5, canvas.width / canvas.height, 0.1, 100));
  gl.uniformMatrix4fv(loc.uView, false, lookAt(e, cam.target, [0, 1, 0]));
  gl.uniform3f(loc.uLight, ld[0] / ll, ld[1] / ll, ld[2] / ll);
  gl.uniform3f(loc.uEye, e[0], e[1], e[2]);
  gl.uniform1f(loc.uAmbient, 0.38);

  // Draw pole (skipped during video recording to match PNG export)
  if (!someRecording) {
    gl.uniform1i(loc.uIsGlass, 1);
    const pd = 0.88; // darken factor (slightly darker than bg)
    gl.uniform3f(loc.uColor, SIM.bgColor[0] * pd, SIM.bgColor[1] * pd, SIM.bgColor[2] * pd);
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

  // Draw flag (double-sided)
  gl.uniform1i(loc.uIsGlass, 0);
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
let currentFont = 'jubilee'; // 'jubilee' or 'diatype'
let textLayout = 'repeat'; // 'repeat' or 'centered'
let textLayoutUserSet = false; // true once the user explicitly picks a layout
let textTexActive = false;
let textScrollSpeed = 0; // 0 = static, >0 = pixels/sec scroll
let textScrollTime = 0;

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
  if (!text) {
    if (textTexActive && !imageTexActive) { removeTexture(); textTexActive = false; }
    return;
  }
  const texW = 2048;
  const texH = Math.round(texW * (aspectH / aspectW));
  textCanvas.width = texW; textCanvas.height = texH;
  textCtx.clearRect(0, 0, texW, texH);

  const fontSize = currentFontSize * (texW / 800);
  if (currentFont === 'diatype') {
    textCtx.font = `bold ${fontSize}px "ABC Diatype", sans-serif`;
  } else {
    textCtx.font = `italic 200 ${fontSize}px "OT Jubilee Platinum", "Instrument Serif", serif`;
  }
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
function wrapParagraph(ctx, text, maxWidth) {
  const paragraphs = text.split(/\r?\n/);
  const lines = [];
  for (const para of paragraphs) {
    if (!para.trim()) { lines.push(''); continue; }
    const words = para.split(/\s+/);
    let line = '';
    for (const word of words) {
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

// ─── Image handling ──────────────────────────────────────────
let imageTexActive = false, loadedImage = null, fitMode = 'fit';
const imgCanvas = document.createElement('canvas');
const imgCtx = imgCanvas.getContext('2d');

function refreshTexture() {
  const text = currentText.trim();
  // When text is active, PNG is disabled (text-only mode).
  // When text is cleared, PNG comes back.
  if (text) {
    // Text only (even if image is loaded, we disable it while text is active)
    generateTextTexture(textScrollTime);
  } else if (loadedImage) {
    // No text — show image
    const texW = 2048, texH = Math.round(texW * (aspectH / aspectW));
    imgCanvas.width = texW; imgCanvas.height = texH;
    imgCtx.clearRect(0, 0, texW, texH);
    if (fitMode === 'stretch') {
      imgCtx.drawImage(loadedImage, 0, 0, texW, texH);
    } else {
      // Cover: fill entire flag, crop excess (no letterbox)
      const imgAsp = loadedImage.width / loadedImage.height;
      const canAsp = texW / texH;
      let dw, dh;
      if (imgAsp > canAsp) { dh = texH; dw = texH * imgAsp; }
      else { dw = texW; dh = texW / imgAsp; }
      imgCtx.drawImage(loadedImage, (texW - dw) / 2, (texH - dh) / 2, dw, dh);
    }
    loadTexture(imgCanvas);
    imageTexActive = true; textTexActive = false;
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

// ─── Full rebuild ────────────────────────────────────────────
function fullRebuild(aw, ah, smooth) {
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
document.getElementById('panelClose').addEventListener('click', () => panel.classList.add('collapsed'));
document.getElementById('panelToggle').addEventListener('click', () => panel.classList.remove('collapsed'));

// Aspect ratio
const ratioRow = document.getElementById('ratioRow');
const customRatioDiv = document.getElementById('customRatio');
let activeRatio = '2:3';
let customAW = 3, customAH = 2;

ratioRow.addEventListener('click', e => {
  const btn = e.target.closest('[data-r]');
  if (!btn) return;
  const r = btn.dataset.r;
  ratioRow.querySelectorAll('[data-r]').forEach(b => b.classList.toggle('active', b === btn));
  activeRatio = r;
  // data-r is H:W (flag convention) — height first, width second.
  const [h, w] = r.split(':').map(Number);
  customAW = w; customAH = h;
  updateMiniPreview();
  fullRebuild(w, h);
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
  ratioRow.querySelectorAll('[data-r]').forEach(b => b.classList.remove('active'));
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

// Keep mini-preview in sync when the user clicks a preset ratio.
const _origRatioClick = ratioRow.onclick;
updateMiniPreview();

// Wind sliders
function slider(id, valId, fn) {
  const el = document.getElementById(id), v = document.getElementById(valId);
  el.addEventListener('input', () => { v.textContent = fn(el.value); });
}
slider('windStrength', 'windVal', v => { SIM.windStrength = +v; return v; });
slider('turbulence', 'turbVal', v => { SIM.turbulence = +v; return v; });
slider('gravity', 'gravityVal', v => { SIM.gravity = +v / 10; return (+v / 10).toFixed(1); });

// Fabric model — Classic / Realistic segmented control
const fabricModeRow = document.getElementById('fabricModeRow');
fabricModeRow.addEventListener('click', e => {
  const btn = e.target.closest('[data-mode]');
  if (!btn || btn.classList.contains('active')) return;
  fabricModeRow.querySelectorAll('[data-mode]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  setFabricMode(btn.dataset.mode);
});

// Weather preset — Normal / Storm segmented control
const weatherRow = document.getElementById('weatherRow');
let _savedWeather = null;
function setWeather(mode) {
  const windIn = document.getElementById('windStrength');
  const turbIn = document.getElementById('turbulence');
  if (mode === 'storm' && WEATHER.mode !== 'storm') {
    _savedWeather = { wind: windIn.value, turb: turbIn.value };
    windIn.value = 280; windIn.dispatchEvent(new Event('input'));
    turbIn.value = 40;  turbIn.dispatchEvent(new Event('input'));
    WEATHER.angleDriftMax = 48;
    WEATHER.angleDriftForce = 2.2;
  } else if (mode === 'normal' && WEATHER.mode === 'storm') {
    if (_savedWeather) {
      windIn.value = _savedWeather.wind; windIn.dispatchEvent(new Event('input'));
      turbIn.value = _savedWeather.turb; turbIn.dispatchEvent(new Event('input'));
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
  weatherRow.querySelectorAll('[data-weather]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  setWeather(btn.dataset.weather);
});

// Attachment — Full edge / Two corners
const attachRow = document.getElementById('attachRow');
attachRow.addEventListener('click', e => {
  const btn = e.target.closest('[data-attach]');
  if (!btn || btn.classList.contains('active')) return;
  attachRow.querySelectorAll('[data-attach]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  ATTACH.mode = btn.dataset.attach;
  applyPinning();
});

// Font picker — preload Diatype so it's ready when user switches
document.fonts.load('bold 48px "ABC Diatype"').catch(() => {});
const fontRow = document.getElementById('fontRow');
fontRow.addEventListener('click', e => {
  const btn = e.target.closest('[data-font]');
  if (!btn || btn.classList.contains('active')) return;
  fontRow.querySelectorAll('[data-font]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentFont = btn.dataset.font;
  // Unless the user has explicitly picked a layout, flip to a sensible default:
  // Jubilee → Repeat, Diatype → Centered.
  if (!textLayoutUserSet) {
    setTextLayout(currentFont === 'diatype' ? 'centered' : 'repeat');
  }
  refreshTexture();
});

// Layout pill-row (Repeat / Centered)
const layoutRow = document.getElementById('layoutRow');
function setTextLayout(mode) {
  textLayout = mode;
  layoutRow.querySelectorAll('[data-layout]').forEach(b =>
    b.classList.toggle('active', b.dataset.layout === mode));
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

// Text input
const textInput = document.getElementById('textInput');
let textDebounce = null;
textInput.addEventListener('input', () => {
  currentText = textInput.value;
  textScrollTime = 0; // reset scroll position on new text
  clearTimeout(textDebounce);
  textDebounce = setTimeout(() => refreshTexture(), 80);
});

// Color utilities
function hexToRgb(hex) {
  return [parseInt(hex.substr(1,2),16)/255, parseInt(hex.substr(3,2),16)/255, parseInt(hex.substr(5,2),16)/255];
}
function isValidHex(s) { return /^#[0-9A-Fa-f]{6}$/.test(s); }

// Text color (swatch + hex input)
const textColorIn = document.getElementById('textColor');
const textColorHex = document.getElementById('textColorHex');
textColorIn.addEventListener('input', () => {
  currentTextColor = textColorIn.value;
  textColorHex.value = textColorIn.value.toUpperCase();
  refreshTexture();
});
textColorHex.addEventListener('input', () => {
  let v = textColorHex.value;
  if (v[0] !== '#') v = '#' + v;
  if (isValidHex(v)) { currentTextColor = v; textColorIn.value = v; refreshTexture(); }
});

// Color pickers
const bgColorIn = document.getElementById('bgColor');
const bgColorHex = document.getElementById('bgColorHex');

bgColorIn.addEventListener('input', () => {
  const c = hexToRgb(bgColorIn.value);
  SIM.bgColor[0] = c[0]; SIM.bgColor[1] = c[1]; SIM.bgColor[2] = c[2];
  bgColorHex.value = bgColorIn.value.toUpperCase();
});
bgColorHex.addEventListener('input', () => {
  let v = bgColorHex.value;
  if (v[0] !== '#') v = '#' + v;
  if (isValidHex(v)) {
    bgColorIn.value = v;
    const c = hexToRgb(v);
    SIM.bgColor[0] = c[0]; SIM.bgColor[1] = c[1]; SIM.bgColor[2] = c[2];
  }
});

// File handling
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const texPreview = document.getElementById('texPreview');
const previewImg = document.getElementById('previewImg');
const fitToggle = document.getElementById('fitToggle');
let activeObjUrl = null;

function showPreview(url) {
  previewImg.src = url;
  texPreview.style.display = 'block';
  dropzone.style.display = 'none';
  fitToggle.style.display = 'flex';
}

function clearImage() {
  loadedImage = null; imageTexActive = false;
  if (activeObjUrl) { URL.revokeObjectURL(activeObjUrl); activeObjUrl = null; }
  previewImg.removeAttribute('src');
  texPreview.style.display = 'none';
  dropzone.style.display = 'block';
  fitToggle.style.display = 'none';
  fileInput.value = '';
  refreshTexture();
}

function handleImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file);
  if (activeObjUrl) URL.revokeObjectURL(activeObjUrl);
  activeObjUrl = url;
  const img = new Image();
  img.onload = () => { loadedImage = img; showPreview(url); refreshTexture(); };
  img.src = url;
}

fileInput.addEventListener('change', e => { if (e.target.files[0]) handleImageFile(e.target.files[0]); });
dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', e => { e.preventDefault(); dropzone.classList.remove('dragover'); handleImageFile(e.dataTransfer.files[0]); });
document.getElementById('removeTexture').addEventListener('click', clearImage);

// Stretch/Fit
fitToggle.addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  fitMode = btn.dataset.mode;
  fitToggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
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
  document.getElementById('windStrength').value = 100;
  document.getElementById('turbulence').value = 30;
  document.getElementById('gravity').value = -10;
  document.getElementById('windVal').textContent = '100';
  document.getElementById('turbVal').textContent = '30';
  document.getElementById('gravityVal').textContent = '-1.0';
  bgColorIn.value = '#D4FED3'; bgColorHex.value = '#D4FED3';
  fontSizeSlider.value = 120; fontSizeVal.textContent = '120'; currentFontSize = 120;
  lineHeightSlider.value = 85; lineHeightVal.textContent = '0.85'; currentLineHeight = 0.85;
  currentFont = 'jubilee';
  fontRow.querySelectorAll('[data-font]').forEach(b => b.classList.toggle('active', b.dataset.font === 'jubilee'));
  textLayoutUserSet = false;
  setTextLayout('repeat');
  textInput.value = ''; currentText = '';
  textScrollSpeed = 0; textScrollTime = 0;
  scrollSpeedSlider.value = 0; scrollVal.textContent = '0';
  currentTextColor = '#016F17';
  textColorIn.value = '#00330A'; textColorHex.value = '#00330A';
  clearImage();
  ratioRow.querySelectorAll('[data-r]').forEach(b => b.classList.toggle('active', b.dataset.r === '3:2'));
  customRatioDiv.classList.remove('visible');
  activeRatio = '3:2';
  fullRebuild(3, 2);
  autoFrame();
  cam.tgtDist = cam.curDist = cam.tgtDist; // snap immediately
  cam.tgtTheta = 0.0; cam.tgtPhi = 0.12;
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
  const meshScale = 3; // 3x denser mesh via bilinear interpolation
  const [w, h] = getExportSize();

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

  // Build triangle indices for dense mesh
  const eTriIdx = [];
  for (let j = 0; j < eRows - 1; j++) {
    for (let i = 0; i < eCols - 1; i++) {
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
  gl.clearColor(SIM.bgColor[0], SIM.bgColor[1], SIM.bgColor[2], 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // Background quad (flat color)
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(bgProg);
  gl.uniform3f(bgLoc.uBg, SIM.bgColor[0], SIM.bgColor[1], SIM.bgColor[2]);
  gl.disableVertexAttribArray(loc.aNrm);
  gl.disableVertexAttribArray(loc.aUV);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.enableVertexAttribArray(bgLoc.aP);
  gl.vertexAttribPointer(bgLoc.aP, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.disableVertexAttribArray(bgLoc.aP);
  gl.enable(gl.DEPTH_TEST);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const ld = [0.5, 0.8, 0.35];
  const ll = Math.sqrt(ld[0] ** 2 + ld[1] ** 2 + ld[2] ** 2);

  gl.useProgram(prog);
  gl.uniform1f(loc.uPartyTime, 0.0);
  gl.uniformMatrix4fv(loc.uProj, false, perspective(fov, asp, 0.1, 100));
  gl.uniformMatrix4fv(loc.uView, false, lookAt(eye, target, [0, 1, 0]));
  gl.uniform3f(loc.uLight, ld[0] / ll, ld[1] / ll, ld[2] / ll);
  gl.uniform3f(loc.uEye, eye[0], eye[1], eye[2]);
  gl.uniform1f(loc.uAmbient, 0.38);

  gl.uniform1i(loc.uIsGlass, 0);
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

  // Flip Y → 2D canvas → download
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx2 = out.getContext('2d');
  const imgData = ctx2.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4;
    const dst = y * w * 4;
    imgData.data.set(pixels.subarray(src, src + w * 4), dst);
  }
  ctx2.putImageData(imgData, 0, 0);

  out.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `flag-${w}x${h}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}

// ─── SoMe Export ────────────────────────────────────────────
const SOME_FORMATS = { '1:1': [1080,1080], '4:5': [1080,1350], '9:16': [1080,1920], '16:9': [1920,1080] };
let someFormat = '1:1', someActive = false, someRecording = false;
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

// Tab switching — auto-show/hide crop frame
document.querySelector('.panel-tabs').addEventListener('click', e => {
  const tab = e.target.closest('.panel-tab');
  if (!tab) return;
  const which = tab.dataset.tab; // 'studio' | 'wind' | 'export'
  document.querySelectorAll('.panel-tab').forEach(t => t.classList.toggle('active', t === tab));
  document.getElementById('tabStudio').classList.toggle('active', which === 'studio');
  document.getElementById('tabWind').classList.toggle('active', which === 'wind');
  document.getElementById('tabExport').classList.toggle('active', which === 'export');
  if (which === 'export') {
    someActive = true;
    initSomeCrop();
    someFrame.style.display = 'block';
  } else {
    someActive = false;
    someFrame.style.display = 'none';
  }
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
  const maxH = window.innerHeight * 0.6;
  const maxW = window.innerWidth * 0.6;
  let cropH, cropW;
  if (a >= 1) { cropW = Math.min(maxW, maxH * a); cropH = cropW / a; }
  else { cropH = Math.min(maxH, maxW / a); cropW = cropH * a; }
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
  someLabel.textContent = w + '\u00d7' + h + ' \u00b7 @30fps';
}

document.getElementById('someRow').addEventListener('click', e => {
  const btn = e.target.closest('[data-some]');
  if (!btn) return;
  someFormat = btn.dataset.some;
  document.querySelectorAll('#someRow .pill').forEach(b => b.classList.toggle('active', b === btn));
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
  document.querySelectorAll('#audioRow .pill').forEach(b => b.classList.toggle('active', b === btn));
  playAudioPreview(someAudio);
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

document.getElementById('loopRow').addEventListener('click', e => {
  const btn = e.target.closest('[data-loop]');
  if (!btn) return;
  someLoop = btn.dataset.loop;
  document.querySelectorAll('#loopRow .pill').forEach(b => b.classList.toggle('active', b === btn));
});

window.addEventListener('resize', () => { if (someActive) initSomeCrop(); });

// Live-update crop frame when user edits W/H
[sizeWInput, sizeHInput].forEach(inp => {
  inp.addEventListener('input', () => {
    document.querySelectorAll('#someRow .pill').forEach(b => b.classList.remove('active'));
    if (someActive) initSomeCrop();
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
  gl.useProgram(bgProg);
  gl.uniform3f(bgLoc.uBg, SIM.bgColor[0], SIM.bgColor[1], SIM.bgColor[2]);
  gl.disableVertexAttribArray(loc.aNrm);
  gl.disableVertexAttribArray(loc.aUV);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.enableVertexAttribArray(bgLoc.aP);
  gl.vertexAttribPointer(bgLoc.aP, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.disableVertexAttribArray(bgLoc.aP);
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
  gl.uniformMatrix4fv(loc.uView, false, lookAt(e, cam.target, [0, 1, 0]));
  gl.uniform3f(loc.uLight, ld[0] / ll, ld[1] / ll, ld[2] / ll);
  gl.uniform3f(loc.uEye, e[0], e[1], e[2]);
  gl.uniform1f(loc.uAmbient, 0.38);

  // Flag only (no pole)
  gl.uniform1i(loc.uIsGlass, 0);
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
let _encoder = null, _muxer = null, _muxerTarget = null, _frameIdx = 0;
let _mp4Mod = null;
let _audioEncoder = null;
let someLoop = 'seamless'; // 'seamless' | 'cut'
let _useSeamless = true; // snapshot of someLoop at recording start
// Loop-morph buffer: stores mesh particle state (pos + prev) for the first
// LOOP_FADE_FRAMES sim frames so the tail of the recording can morph the
// geometry back into the start trajectory, producing a seamless loop without
// the ghosting that a pixel crossfade would cause.
let _loopHeadPos = null, _loopHeadPrev = null;

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

async function finalizeExport() {
  const btn = document.getElementById('someExportBtn');
  btn.textContent = 'Finalizing...';
  try {
    await _encoder.flush();
    if (_audioEncoder) await _audioEncoder.flush();
    _muxer.finalize();
    const blob = new Blob([_muxerTarget.buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'flag-' + _recCanvas.width + 'x' + _recCanvas.height + '-10s.mp4';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (e) {
    console.error('MP4 finalize failed:', e);
    btn.textContent = 'Export failed';
    setTimeout(() => { btn.textContent = 'Export 10s Loop'; }, 3000);
    return;
  }
  _encoder = null; _muxer = null; _muxerTarget = null;
  _recCanvas = null; _recCtx = null;
  _loopHeadPos = null; _loopHeadPrev = null;
  if (_audioEncoder) { try { _audioEncoder.close(); } catch (_) {} _audioEncoder = null; }
  someFrame.classList.remove('recording');
  btn.textContent = 'Export 10s Loop';
}

document.getElementById('someExportBtn').addEventListener('click', async () => {
  if (someRecording) return;
  if (typeof VideoEncoder === 'undefined') {
    alert('WebCodecs not supported — use Chrome or Edge.');
    return;
  }
  // H.264 requires even dimensions
  const [rawW, rawH] = getExportSize();
  const fw = rawW & ~1, fh = rawH & ~1;
  _recCanvas = document.createElement('canvas');
  _recCanvas.width = fw; _recCanvas.height = fh;
  _recCtx = _recCanvas.getContext('2d');
  _useSeamless = (someLoop === 'seamless');
  _loopHeadPos = _useSeamless ? new Array(LOOP_FADE_FRAMES) : null;
  _loopHeadPrev = _useSeamless ? new Array(LOOP_FADE_FRAMES) : null;

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
        audioDecoded = await decodeAudioTrack(someAudio, REC_TOTAL_FRAMES / REC_FPS);
      } catch (e) {
        console.error('Audio load failed:', e);
        alert('Audio load failed: ' + (e && e.message ? e.message : e));
        btn.textContent = 'Export 10s Loop';
        return;
      }
    }
  }

  btn.textContent = 'Initializing...';
  try {
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
      codec: 'avc1.640028',
      width: fw, height: fh,
      bitrate: 10_000_000,
      framerate: 30,
    });
    if (audioDecoded) {
      _audioEncoder = startAudioEncode(audioDecoded, _muxer);
    }
  } catch (e) {
    console.error('Encoder init failed:', e);
    btn.textContent = 'Export failed';
    setTimeout(() => { btn.textContent = 'Export 10s Loop'; }, 2000);
    return;
  }
  _frameIdx = 0;
  lastTime = 0; // prevent stale dt on first recording frame
  someRecording = true;
  someFrame.classList.add('recording');
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
  const t = cam.curTheta, p = cam.curPhi;
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
  cam.tgtTheta += thetaDelta;
  cam.tgtPhi = clamp(cam.tgtPhi - dy * 0.012, -1.45, 1.45);
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
pauseIndicator.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.78);color:#fff;padding:8px 16px;border-radius:999px;font:500 13px "DM Sans",system-ui,sans-serif;display:none;pointer-events:none;z-index:9999;letter-spacing:0.02em;';
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

const SIM_HZ = 60;
const SIM_DT = 1 / SIM_HZ;
const REC_FPS = 30;
const REC_STEPS = SIM_HZ / REC_FPS; // 2 physics steps per export frame
const REC_TOTAL_FRAMES = 10 * REC_FPS;      // 300 — output loop length
const LOOP_FADE_FRAMES = 30;                // 1s crossfade at the loop seam
const REC_RAW_FRAMES = REC_TOTAL_FRAMES + LOOP_FADE_FRAMES; // 270 sim frames

function loop(now) {
  requestAnimationFrame(loop);

  // During recording: 2 physics steps per frame, capture at 30fps.
  // Seamless-loop strategy — geometric morph (no pixel ghosting):
  //   sim [0, L)         → snapshot pos+prev into _loopHeadPos/_loopHeadPrev,
  //                         do not encode
  //   sim [L, N)         → render+encode directly as output[0 .. N-L-1]
  //   sim [N, N+L)       → after physics, lerp pos+prev toward the stored
  //                         head snapshot (alpha 0→1), recompute normals,
  //                         then render+encode as output[N-L .. N-1]
  // At alpha=1 the rendered geometry exactly matches sim frame L-1, so
  // output[N-1] → output[0] is a one-sim-step jump (visually continuous).
  if (someRecording && _recCtx && _encoder) {
    for (let i = 0; i < REC_STEPS; i++) {
      simulate(SIM_DT);
      updateCamera(SIM_DT);
      if (textScrollSpeed > 0 && currentText.trim() && textLayout === 'repeat') {
        textScrollTime += SIM_DT * textScrollSpeed * 2.5;
        generateTextTexture(textScrollTime);
      }
    }
    updateOrbitBall();

    const totalFramesForRun = _useSeamless ? REC_RAW_FRAMES : REC_TOTAL_FRAMES;

    if (_useSeamless && _frameIdx < LOOP_FADE_FRAMES) {
      // Head phase — snapshot mesh state, do not render/encode.
      _loopHeadPos[_frameIdx] = new Float32Array(pos);
      _loopHeadPrev[_frameIdx] = new Float32Array(prev);
    } else {
      if (_useSeamless && _frameIdx >= REC_TOTAL_FRAMES) {
        // Tail phase — morph mesh toward stored head trajectory.
        // Smootherstep easing: zero velocity at both endpoints so the
        // morph onset and termination are visually invisible.
        const tailIdx = _frameIdx - REC_TOTAL_FRAMES;
        const t = (tailIdx + 1) / LOOP_FADE_FRAMES;
        const alpha = t * t * t * (t * (t * 6 - 15) + 10);
        const headPos = _loopHeadPos[tailIdx];
        const headPrev = _loopHeadPrev[tailIdx];
        const inv = 1 - alpha;
        for (let i = 0, n = pos.length; i < n; i++) {
          pos[i] = pos[i] * inv + headPos[i] * alpha;
          prev[i] = prev[i] * inv + headPrev[i] * alpha;
        }
        computeMeshNormals();
      }
      // On-screen preview so the user sees recording in progress.
      render(SIM_DT);
      // Capture at full export resolution via the dedicated FBO — bypassing
      // the on-screen canvas avoids viewport/DPR-bound upscaling that would
      // otherwise pixelate tall formats like 9:16 (1080×1920).
      const fw = _recCanvas.width, fh = _recCanvas.height;
      const pixels = renderToFBO(fw, fh);
      pixelsToCanvas(pixels, fw, fh, _recCtx);

      const outIdx = _useSeamless ? _frameIdx - LOOP_FADE_FRAMES : _frameIdx;
      const frame = new VideoFrame(_recCanvas, {
        timestamp: outIdx * (1_000_000 / REC_FPS),
      });
      _encoder.encode(frame, { keyFrame: outIdx % REC_FPS === 0 });
      frame.close();
    }
    _frameIdx++;

    const elapsed = _frameIdx / REC_FPS;
    const totalSec = totalFramesForRun / REC_FPS;
    document.getElementById('someExportBtn').textContent =
      'Recording ' + elapsed.toFixed(1) + 's / ' + totalSec.toFixed(0) + 's';
    if (_frameIdx >= totalFramesForRun) {
      someRecording = false;
      lastTime = 0;
      finalizeExport();
    }
    return;
  }

  // Normal playback — 60hz physics via accumulator, render every frame
  if (!lastTime) { lastTime = now; return; }
  if (PAUSED) {
    // Keep camera responsive while physics is frozen.
    updateCamera(SIM_DT);
    updateOrbitBall();
    lastTime = now;
    simAccum = 0;
    render(SIM_DT);
    return;
  }
  simAccum += (now - lastTime) / 1000;
  lastTime = now;
  if (simAccum > 0.1) simAccum = 0.1;
  while (simAccum >= SIM_DT) {
    simAccum -= SIM_DT;
    simulate(SIM_DT);
    updateCamera(SIM_DT);
    if (textScrollSpeed > 0 && currentText.trim() && textLayout === 'repeat') {
      textScrollTime += SIM_DT * textScrollSpeed * 2.5;
      generateTextTexture(textScrollTime);
    }
  }
  updateOrbitBall();
  render(SIM_DT);
}

// ─── Init ────────────────────────────────────────────────────
loadDefaultTexture();
requestAnimationFrame(loop);
