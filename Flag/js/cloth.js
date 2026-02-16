import {
  SIM, cols, rows, totalPts,
  flagW, flagH, restDx, restDy, restDiag, state,
} from './config.js';

// ─── Particle arrays ────────────────────────────────────────────
export const pos = new Float32Array(totalPts * 3);
export const prev = new Float32Array(totalPts * 3);
export const nrm = new Float32Array(totalPts * 3);
export const uv = new Float32Array(totalPts * 2);
export const fixed = new Uint8Array(totalPts);

for (let i = 0; i < totalPts; i++) {
  fixed[i] = (i % cols === 0) ? 1 : 0;
}

export function initCloth() {
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      const i3 = idx * 3;
      const x = (i / (cols - 1)) * flagW;
      const y = -(j / (rows - 1)) * flagH + flagH * 0.5;
      pos[i3] = prev[i3] = x;
      pos[i3 + 1] = prev[i3 + 1] = y;
      pos[i3 + 2] = prev[i3 + 2] = 0;
      uv[idx * 2] = i / (cols - 1);
      uv[idx * 2 + 1] = j / (rows - 1);
    }
  }
}
initCloth();

// ─── Triangle indices ───────────────────────────────────────────
const triIdx = [];
for (let j = 0; j < rows - 1; j++) {
  for (let i = 0; i < cols - 1; i++) {
    const a = j * cols + i;
    triIdx.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
  }
}
export const indexData = new Uint32Array(triIdx);

// ─── Constraints (struct-of-arrays for performance) ─────────────
const cA = [], cB = [], cR = [];
function addC(a, b, r) { cA.push(a); cB.push(b); cR.push(r); }

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

const numC = cA.length;
const conA = new Uint32Array(cA);
const conB = new Uint32Array(cB);
const conR = new Float32Array(cR);

// ─── Wind gust system ───────────────────────────────────────────
// Moving blobs of wind that drift across the flag surface.
// Each gust has a position in UV space, velocity, radius, and force.
// This creates organic, non-periodic large-scale turbulence.
const NUM_GUSTS = 9;
const GUST_SPEED_LIMIT = 0.55;
const GUST_FORCE_LIMIT = 3.4;
const GUST_PHASE_SPEED_LIMIT = 5.2;
const gusts = [];
const gustPulse = new Float32Array(NUM_GUSTS);
const gustSwirl = new Float32Array(NUM_GUSTS);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const windDebug = {
  angleOffset: 0,
  strengthOffset: 0,
};

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
    // Drift position
    g.x += g.vx * dt;
    g.y += g.vy * dt;

    // Wrap around with margin so gusts re-enter smoothly
    if (g.x < -0.5) g.x += 2.0;
    if (g.x > 1.5) g.x -= 2.0;
    if (g.y < -0.5) g.y += 2.0;
    if (g.y > 1.5) g.y -= 2.0;

    // Random walk on velocity (smooth acceleration changes)
    g.vx += (Math.random() - 0.5) * dt * 0.9;
    g.vy += (Math.random() - 0.5) * dt * 0.7;
    g.vx *= 0.993;
    g.vy *= 0.993;
    g.vx = clamp(g.vx, -GUST_SPEED_LIMIT, GUST_SPEED_LIMIT);
    g.vy = clamp(g.vy, -GUST_SPEED_LIMIT, GUST_SPEED_LIMIT);

    // Random walk on strength (slow evolving push direction)
    g.sx += (Math.random() - 0.5) * dt * 4.0;
    g.sz += (Math.random() - 0.5) * dt * 4.0;
    g.sx *= 0.987;
    g.sz *= 0.987;
    g.sx = clamp(g.sx, -GUST_FORCE_LIMIT, GUST_FORCE_LIMIT);
    g.sz = clamp(g.sz, -GUST_FORCE_LIMIT, GUST_FORCE_LIMIT);

    // Evolving gust "state" drives non-periodic flutter without global sine waves
    g.phase += g.phaseVel * dt;
    if (g.phase > Math.PI * 2.0) g.phase -= Math.PI * 2.0;
    g.phaseVel += (Math.random() - 0.5) * dt * 1.5;
    g.phaseVel = clamp(g.phaseVel, 0.7, GUST_PHASE_SPEED_LIMIT);
    g.pulse += (Math.random() - 0.5) * dt * 1.8;
    g.pulse = clamp(g.pulse, 0.15, 1.8);
  }
}

// ─── Physics simulation ─────────────────────────────────────────
const SUBSTEPS = 2;
let windAngleDrift = 0;
let windAngleVel = 0;
let windStrengthDrift = 0;
let time = 0;
const stadiumPose = {
  handX: 0, handY: 0, handZ: 0,
  tipX: 0, tipY: 0, tipZ: 0,
  axisX: 1, axisY: 0, axisZ: 0,
  sideX: 1, sideY: 0, sideZ: 0,
  binX: 0, binY: 0, binZ: 1,
  roll: 0,
  rollVel: 0,
  velX: 0, velY: 0, velZ: 0,
  prevTipX: 0, prevTipY: 0, prevTipZ: 0,
  prevTime: -1,
};

export function addRippleAtUV(u, v, strength = 1.0) {
  const uu = clamp(u, 0, 1);
  const vv = clamp(v, 0, 1);
  const s = clamp(strength, 0.05, 2.2);
  const radius = 0.18;
  const radius2 = radius * radius;
  const basePush = 0.18 * s;
  const baseLift = 0.06 * s;

  for (let p = 0; p < totalPts; p++) {
    if (fixed[p]) continue;
    const uv2 = p * 2;
    const du = uv[uv2] - uu;
    const dv = uv[uv2 + 1] - vv;
    const d2 = du * du + dv * dv;
    if (d2 > radius2) continue;

    const falloff = 1.0 - d2 / radius2;
    const w = falloff * falloff;
    const i3 = p * 3;
    const push = basePush * w;
    const lift = baseLift * w;
    pos[i3 + 2] += push;
    prev[i3 + 2] -= push * 0.68;
    pos[i3 + 1] += lift;
    prev[i3 + 1] -= lift * 0.44;
  }
}

function updateAmbientWind(dt) {
  const driftMax = SIM.windDrift;
  if (driftMax <= 0.01) {
    windAngleDrift *= Math.exp(-dt * 6.0);
    windAngleVel *= Math.exp(-dt * 7.5);
  } else {
    const driftNorm = driftMax / 90;
    windAngleVel += (Math.random() - 0.5) * dt * (90.0 + driftMax * 4.5);
    windAngleVel += (-windAngleDrift * (0.35 + driftNorm * 0.75)) * dt;
    const driftDamp = Math.max(0.35, 0.75 - driftNorm * 0.2);
    windAngleVel *= Math.exp(-dt * driftDamp);
    windAngleDrift += windAngleVel * dt;
    windAngleDrift = clamp(windAngleDrift, -driftMax, driftMax);
  }

  const turbNorm = SIM.turbulence / 100;
  windStrengthDrift += (Math.random() - 0.5) * dt * (1.8 + turbNorm * 8.0);
  windStrengthDrift *= Math.exp(-dt * 1.6);
  windStrengthDrift = clamp(windStrengthDrift, -0.75, 0.75);
  windDebug.angleOffset = windAngleDrift;
  windDebug.strengthOffset = windStrengthDrift;
}

function applyStadiumPoleMotion() {
  if (state.viewMode !== 'stadium') return;
  // Wrist-driven sideways lemniscate (infinity) with a rigid hidden stick.
  const t = time * 1.56;
  const st = Math.sin(t);
  const ct = Math.cos(t);
  const c2 = Math.cos(t * 2.0);

  // Hand center follows a compact sideways infinity path.
  const handX = -0.08 + 0.22 * st;
  const handY = -flagH * 0.52 + 0.05 * Math.sin(t * 2.0 + 0.34);
  const handZ = 0.38 * st * ct;

  // Tip target follows a larger 8; later normalized to rigid pole length.
  const tipTargetX = handX + 0.86 * st + 0.18 * Math.sin(t * 3.0 + 0.20);
  const tipTargetY = flagH * 0.49 + 0.24 * Math.sin(t * 2.0 + 0.92);
  const tipTargetZ = handZ + 1.42 * Math.sin(t * 2.0 + 0.14) + 0.24 * Math.cos(t + 0.36);

  let ax = tipTargetX - handX;
  let ay = tipTargetY - handY;
  let az = tipTargetZ - handZ;
  let al = Math.sqrt(ax * ax + ay * ay + az * az);
  if (al < 1e-6) al = 1e-6;
  const poleLen = flagH * 1.03;
  const tipX = handX + (ax / al) * poleLen;
  const tipY = handY + (ay / al) * poleLen;
  const tipZ = handZ + (az / al) * poleLen;
  ax = (tipX - handX) / poleLen;
  ay = (tipY - handY) / poleLen;
  az = (tipZ - handZ) / poleLen;

  // Build orthonormal frame around the pole axis.
  let sx = ay;
  let sy = -ax;
  let sz = 0;
  let sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
  if (sl < 1e-5) {
    sx = 0;
    sy = az;
    sz = -ay;
    sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
  }
  sx /= sl;
  sy /= sl;
  sz /= sl;
  const bx = ay * sz - az * sy;
  const by = az * sx - ax * sz;
  const bz = ax * sy - ay * sx;

  // Boost roll right at each crossover (when sin(t) ~ 0) to force side flipping.
  const crossover = Math.exp(-11.0 * st * st);
  const crossoverKick = (ct >= 0 ? 1 : -1) * crossover;
  const roll = 1.05 * Math.sin(t * 2.0 + 0.42) + crossoverKick * 1.35;

  if (stadiumPose.prevTime >= 0) {
    const dtPose = Math.max(time - stadiumPose.prevTime, 1e-4);
    const instVX = (tipX - stadiumPose.prevTipX) / dtPose;
    const instVY = (tipY - stadiumPose.prevTipY) / dtPose;
    const instVZ = (tipZ - stadiumPose.prevTipZ) / dtPose;
    const instRollVel = (roll - stadiumPose.roll) / dtPose;
    stadiumPose.velX = stadiumPose.velX * 0.42 + instVX * 0.58;
    stadiumPose.velY = stadiumPose.velY * 0.42 + instVY * 0.58;
    stadiumPose.velZ = stadiumPose.velZ * 0.42 + instVZ * 0.58;
    stadiumPose.rollVel = clamp(stadiumPose.rollVel * 0.42 + instRollVel * 0.58, -18.0, 18.0);
  } else {
    stadiumPose.velX = 0;
    stadiumPose.velY = 0;
    stadiumPose.velZ = 0;
    stadiumPose.rollVel = 0;
  }

  stadiumPose.handX = handX;
  stadiumPose.handY = handY;
  stadiumPose.handZ = handZ;
  stadiumPose.tipX = tipX;
  stadiumPose.tipY = tipY;
  stadiumPose.tipZ = tipZ;
  stadiumPose.axisX = ax;
  stadiumPose.axisY = ay;
  stadiumPose.axisZ = az;
  stadiumPose.sideX = sx;
  stadiumPose.sideY = sy;
  stadiumPose.sideZ = sz;
  stadiumPose.binX = bx;
  stadiumPose.binY = by;
  stadiumPose.binZ = bz;
  stadiumPose.roll = roll;
  stadiumPose.prevTipX = tipX;
  stadiumPose.prevTipY = tipY;
  stadiumPose.prevTipZ = tipZ;
  stadiumPose.prevTime = time;

  // Column 0: rigid pole line. Column 1: seam driver that injects axis-roll into the fabric.
  for (let j = 0; j < rows; j++) {
    const p = j * cols;
    const i3 = p * 3;
    const v = j / (rows - 1);
    const u = 1.0 - v;
    const px = handX + (tipX - handX) * u;
    const py = handY + (tipY - handY) * u;
    const pz = handZ + (tipZ - handZ) * u;

    pos[i3] = prev[i3] = px;
    pos[i3 + 1] = prev[i3 + 1] = py;
    pos[i3 + 2] = prev[i3 + 2] = pz;

    const idx1 = p + 1;
    if (idx1 < totalPts && !fixed[idx1]) {
      const i13 = idx1 * 3;
      const seamPhase = roll + u * 2.35 + 0.35 * c2;
      const rx = sx * Math.cos(seamPhase) + bx * Math.sin(seamPhase);
      const ry = sy * Math.cos(seamPhase) + by * Math.sin(seamPhase);
      const rz = sz * Math.cos(seamPhase) + bz * Math.sin(seamPhase);
      const seamDist = restDx * (0.96 + 0.18 * u);
      pos[i13] = prev[i13] = px + rx * seamDist;
      pos[i13 + 1] = prev[i13 + 1] = py + ry * seamDist;
      pos[i13 + 2] = prev[i13 + 2] = pz + rz * seamDist;
    }
  }
}

export function simulate(frameDt) {
  const dt = Math.min(Math.max(frameDt, 0.004), 0.016);
  const stadiumMode = state.viewMode === 'stadium';
  const crowdMode = state.viewMode === 'crowd';
  const pinnedMode = state.viewMode === 'pinned';
  const freeMode = state.viewMode === 'free';

  // Update gust blobs once per frame (not per substep)
  updateGusts(dt);
  if (freeMode) {
    windAngleDrift *= Math.exp(-dt * 10.0);
    windAngleVel *= Math.exp(-dt * 10.0);
    windStrengthDrift *= Math.exp(-dt * 10.0);
    windDebug.angleOffset = 0;
    windDebug.strengthOffset = 0;
  } else {
    updateAmbientWind(dt);
  }

  const subDt = dt / SUBSTEPS;

  for (let s = 0; s < SUBSTEPS; s++) {
    const dt2 = subDt * subDt;
    time += subDt;
    const damp = Math.pow(SIM.damping / 100, subDt * 85);
    const baseWind = clamp((SIM.windStrength / 100) * (1.0 + windStrengthDrift), 0, 1.6);
    const windNorm = (stadiumMode || freeMode)
      ? 0.0
      : (crowdMode ? clamp(baseWind * 0.34, 0, 1.0) : baseWind);
    const windBase = windNorm * windNorm * 24.0 + windNorm * 2.5;
    const turbAmt = (stadiumMode || freeMode)
      ? 0.0
      : (crowdMode ? (SIM.turbulence / 100) * 0.40 : SIM.turbulence / 100);
    const aRad = stadiumMode ? (Math.PI * 0.5) : (SIM.windAngle + windAngleDrift) * Math.PI / 180;
    const wdx = Math.sin(aRad), wdz = Math.cos(aRad);
    const stadiumRigidity = stadiumMode ? 0.30 : (crowdMode ? 0.18 : 0);
    const iterations = Math.floor(SIM.stiffness / 100 * 2) + 2 + (stadiumMode ? 3 : (crowdMode ? 2 : 0));
    const solveStrength = clamp(0.5 + (SIM.stiffness / 100) * 0.3 + stadiumRigidity, 0.2, 1.12);
    const dragK = stadiumMode
      ? 0.042 + (1.0 - SIM.damping / 100) * 0.50
      : (crowdMode
        ? 0.026 + (1.0 - SIM.damping / 100) * 0.40
        : (0.012 + (1.0 - SIM.damping / 100) * 0.62 + windNorm * 0.01));
    const gravity = stadiumMode ? -1.6 : (crowdMode ? (SIM.gravity * 0.65 - 2.2) : SIM.gravity);
    const maxStep = Math.max(restDx, restDy) * (stadiumMode ? 2.6 : (crowdMode ? 2.0 : (1.3 + windNorm * 0.9)));

    applyStadiumPoleMotion();

    // Evaluate per-gust phase once per substep (faster than per-particle trig).
    for (let g = 0; g < NUM_GUSTS; g++) {
      const gust = gusts[g];
      gustPulse[g] = (0.72 + Math.sin(gust.phase) * 0.28) * (0.42 + gust.pulse * 0.58);
      gustSwirl[g] = gust.spin * (0.22 + 0.34 * Math.cos(gust.phase * 0.75));
    }

    // Verlet integration with forces
    for (let p = 0; p < totalPts; p++) {
      if (fixed[p]) continue;
      const i3 = p * 3;
      const px = pos[i3], py = pos[i3 + 1], pz = pos[i3 + 2];

      const vx = (px - prev[i3]) * damp;
      const vy = (py - prev[i3 + 1]) * damp;
      const vz = (pz - prev[i3 + 2]) * damp;

      prev[i3] = px; prev[i3 + 1] = py; prev[i3 + 2] = pz;

      const uv2 = p * 2;
      const u = uv[uv2];
      const v = uv[uv2 + 1];

      // ── Gust blob turbulence (organic, non-periodic) ──
      let gustX = 0, gustZ = 0, gustLift = 0;
      for (let g = 0; g < NUM_GUSTS; g++) {
        const gust = gusts[g];
        const gdx = u - gust.x;
        const gdy = v - gust.y;
        const d2 = gdx * gdx + gdy * gdy;
        const r2 = gust.r * gust.r;
        if (d2 < r2) {
          // Pressure + swirl from localized evolving gusts
          const w = 1.0 - d2 / r2;
          const w2 = w * w;
          const w3 = w2 * w;
          const pulse = w2 * gustPulse[g];
          const swirl = w3 * gustSwirl[g];
          gustX += gust.sx * pulse - gdy * swirl;
          gustZ += gust.sz * pulse + gdx * swirl;
          // Keep vertical turbulence zero-mean so corners don't accumulate upward drift.
          gustLift += swirl * 0.30 + (pulse - 0.50) * 0.10;
        }
      }

      // ── Surface normal + attack angle (from previous frame) ──
      const npx = nrm[i3];
      const npy = nrm[i3 + 1];
      const npz = nrm[i3 + 2];
      const nLen2 = npx * npx + npy * npy + npz * npz;
      const attackAngle = nLen2 > 1e-4 ? Math.abs(npx * wdx + npz * wdz) : 1.0;
      const turbResponse = Math.pow(turbAmt, 0.82);
      const turbField = turbResponse * (0.45 + windNorm * 0.85);
      const flutterX = (
        Math.sin(u * 18.7 + v * 9.1 + time * 6.8)
        + Math.sin(u * 4.3 - v * 14.2 + time * 9.4)
      ) * 0.45;
      const flutterZ = (
        Math.cos(u * 15.3 - v * 11.7 + time * 7.9)
        + Math.sin(u * 7.9 + v * 13.1 + time * 5.6)
      ) * 0.45;

      // ── Compose forces ──
      const wm = (0.3 + u * 0.7) * attackAngle;
      const gustScale = turbResponse * (windBase * 0.85 + 2.2);

      let fx = wdx * windBase * wm
        + gustX * gustScale
        + flutterX * turbField;
      let fy = gravity * (1.18 + v * 0.92 + u * u * 0.34)
        + gustLift * gustScale * 0.045;
      let fz = wdz * windBase * wm
        + gustZ * gustScale
        + flutterZ * turbField;

      // Normal-aligned aerodynamic pressure makes folds self-excite dynamically.
      if (nLen2 > 1e-4) {
        const ndw = npx * wdx + npz * wdz + npy * 0.05;
        const aero = ndw * Math.abs(ndw) * (windBase * (0.75 + turbAmt * 0.55)) * (0.2 + u * 0.8);
        fx += npx * aero;
        const aeroY = npy * aero * 0.24;
        fy += crowdMode ? (aeroY * 0.18) : Math.min(aeroY, 0.0);
        fz += npz * aero;
      }

      // Stadium mode: preserve original pole-driven F1 motion.
      if (stadiumMode) {
        const rowU = 1.0 - v;
        const poleX = stadiumPose.handX + (stadiumPose.tipX - stadiumPose.handX) * rowU;
        const poleY = stadiumPose.handY + (stadiumPose.tipY - stadiumPose.handY) * rowU;
        const poleZ = stadiumPose.handZ + (stadiumPose.tipZ - stadiumPose.handZ) * rowU;

        let rx = px - poleX;
        let ry = py - poleY;
        let rz = pz - poleZ;
        const proj = rx * stadiumPose.axisX + ry * stadiumPose.axisY + rz * stadiumPose.axisZ;
        rx -= stadiumPose.axisX * proj;
        ry -= stadiumPose.axisY * proj;
        rz -= stadiumPose.axisZ * proj;
        let rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (rLen < 1e-6) {
          rx = stadiumPose.sideX;
          ry = stadiumPose.sideY;
          rz = stadiumPose.sideZ;
          rLen = 1.0;
        }
        rx /= rLen;
        ry /= rLen;
        rz /= rLen;

        const tx = stadiumPose.axisY * rz - stadiumPose.axisZ * ry;
        const ty = stadiumPose.axisZ * rx - stadiumPose.axisX * rz;
        const tz = stadiumPose.axisX * ry - stadiumPose.axisY * rx;

        const reach = Math.pow(u, 0.78);
        const targetR = Math.max(restDx * 0.9, u * flagW * (0.92 + 0.06 * Math.sin(time * 2.1 + v * 1.7)));
        const radialErr = targetR - rLen;
        const radialK = 1.8 + reach * 6.4;
        fx += rx * radialErr * radialK;
        fy += ry * radialErr * radialK * 0.55;
        fz += rz * radialErr * radialK;

        const drive = 0.22 + reach * 1.85;
        const stFlowX = stadiumPose.velX * 0.46 + tx * stadiumPose.rollVel * 0.34;
        const stFlowY = stadiumPose.velY * 0.18 + ty * stadiumPose.rollVel * 0.12;
        const stFlowZ = stadiumPose.velZ * 0.46 + tz * stadiumPose.rollVel * 0.34;
        fx += stFlowX * drive;
        fy += stFlowY * drive - reach * 0.20;
        fz += stFlowZ * drive;
      }

      // Crowd mode: perspective trapezium projection with subtle fan ripple.
      if (crowdMode) {
        const restX = u * flagW;
        const restY = -v * flagH + flagH * 0.5;
        const centerX = flagW * 0.5;
        const topNarrow = 0.34;
        const widthScale = 1.0 - topNarrow * (1.0 - v);
        const side = Math.abs((u * 2.0) - 1.0);

        const trapX = centerX + (restX - centerX) * widthScale;
        const trapY = restY * 0.92 - flagH * (0.05 + 0.20 * v);
        const trapZ = -0.28 - (1.0 - v) * 0.58 - side * side * 0.09;

        const hold = 0.30 + (1.0 - v) * 0.82;
        fx += (trapX - px) * hold * 0.74;
        fy += (trapY - py) * hold * 0.82;
        fz += (trapZ - pz) * hold * 1.05;

        const crowdWave = (
          Math.sin(u * 11.5 + v * 4.2 + time * 3.0)
          + Math.sin(u * 5.2 + v * 8.3 - time * 2.2)
        );
        const waveAmp = 0.12 + (1.0 - v) * 0.18;
        fz += crowdWave * waveAmp * 0.22;
        fy += crowdWave * waveAmp * 0.06;
      }

      // Relative airflow drag removes runaway oscillation over long runs.
      const velX = vx / subDt;
      const velY = vy / subDt;
      const velZ = vz / subDt;
      const flowScale = (0.12 + attackAngle * 0.88) * (0.35 + u * 0.65);
      const flowX = wdx * windBase * flowScale;
      const flowZ = wdz * windBase * flowScale;
      const relX = velX - flowX;
      const relY = velY;
      const relZ = velZ - flowZ;
      if (u > 0.35 && velY > 0.0) {
        fy -= velY * (0.016 + u * 0.028);
      }
      const drag = dragK * (0.25 + u * 0.75);
      fx -= relX * drag;
      fy -= relY * drag * 0.8;
      fz -= relZ * drag;

      // Fullscreen: edge springs pull toward rest position
      if (state.viewMode === 'fullscreen') {
        const stretchN = clamp(SIM.stretch / 140, 0, 1);
        const baseScale = 0.08 + stretchN * 0.52;
        const stretchTaut = Math.pow(stretchN, 1.28);
        const restX = u * flagW;
        const restY = -(v) * flagH + flagH * 0.5;
        const sagBase = flagH * (0.110 + 0.260 * u * u * (0.45 + 0.55 * (1.0 - v)));
        const sagLoose = flagH * (1.0 - stretchN) * (0.100 + 0.200 * u * u);
        const targetY = restY - (sagBase + sagLoose);

        // Keep stabilization very mild so gravity/wind dominate the motion.
        const poleBias = 0.22 + 0.78 * (1.0 - u);
        const holdY = ((0.22 + stretchTaut * 0.95) * poleBias) * baseScale;
        const holdXZ = ((0.20 + stretchTaut * 0.90) * poleBias) * baseScale;
        const dyToTarget = targetY - py;
        fx += (restX - px) * holdXZ;
        // One-way vertical hold: can pull down when fabric floats up, never pull up.
        fy += Math.min(dyToTarget, 0.0) * holdY;
        fz += (0 - pz) * holdXZ * 0.07;

        // Extra gravity bias toward the free edge to avoid upward hovering in fullscreen.
        const freeEdge = clamp((u - 0.18) / 0.82, 0, 1);
        fy += SIM.gravity * freeEdge * (0.55 + (1.0 - stretchN) * 0.50);
        fy += SIM.gravity * (0.08 + u * 0.20);

        // Trailing edge anti-float: when a point rises above its rest height, push it back down.
        const above = py - targetY;
        if (above > 0.0) {
          const sink = (2.2 + u * 5.0) * (1.0 + above * 1.05) * (0.70 + baseScale * 0.30);
          fy -= above * sink;
          if (velY > 0.0) fy -= velY * (0.028 + u * 0.062) * (0.72 + baseScale * 0.28);
        }

        const edgeDist = Math.min(u, 1 - u, v, 1 - v);
        const springK = (4.0 + stretchTaut * 42.0) * Math.max(0, 1.0 - edgeDist * 4.0) * baseScale;
        if (springK > 0.01) {
          fx += (restX - px) * springK;
          fy += Math.min(targetY - py, 0.0) * springK;
          fz += (0 - pz) * springK * 0.09;
        }
      } else if (pinnedMode) {
        const stretchN = clamp(SIM.stretch / 140, 0, 1);
        const restX = u * flagW;
        const restY = -v * flagH + flagH * 0.5;
        const edgeDist = Math.min(u, 1 - u, v, 1 - v);
        const edgeHold = Math.max(0, 1.0 - edgeDist * 3.8);
        const flatK = 0.08 + stretchN * 0.36;
        const zHold = 0.12 + stretchN * 0.32;
        const sag = flagH * (1.0 - stretchN) * 0.065 * (1.0 - Math.min(edgeDist * 1.9, 1.0));
        const targetY = restY - sag;

        fx += (restX - px) * flatK * (0.45 + edgeHold * 0.85);
        fy += (targetY - py) * flatK * (0.55 + edgeHold * 1.05);
        fz += (0 - pz) * zHold * (0.50 + edgeHold * 1.4);
        if (SIM.gravity !== 0) {
          fy += SIM.gravity * (0.22 + (1.0 - Math.min(edgeDist * 1.6, 1.0)) * 0.32);
        }
      }

      let nx = px + vx + fx * dt2;
      let ny = py + vy + fy * dt2;
      let nz = pz + vz + fz * dt2;

      const sx = nx - px, sy = ny - py, sz = nz - pz;
      const stepLen = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (stepLen > maxStep) {
        const sInv = maxStep / stepLen;
        nx = px + sx * sInv;
        ny = py + sy * sInv;
        nz = pz + sz * sInv;
      }

      pos[i3] = nx;
      pos[i3 + 1] = ny;
      pos[i3 + 2] = nz;
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

    // Anti-self-intersection: local depth and ordering control
    {
      const cornersMode = state.pinMode === 'corners' || pinnedMode || freeMode;
      const poleMode = state.pinMode === 'poleDense' && !stadiumMode && !pinnedMode && !crowdMode && !freeMode;
      for (let j = 1; j < rows - 1; j++) {
        for (let i = 1; i < cols - 1; i++) {
          const idx = j * cols + i;
          if (fixed[idx]) continue;
          const i3 = idx * 3;
          const avgZ = (
            pos[(idx - 1) * 3 + 2] +
            pos[(idx + 1) * 3 + 2] +
            pos[(idx - cols) * 3 + 2] +
            pos[(idx + cols) * 3 + 2]
          ) * 0.25;
          const devZ = pos[i3 + 2] - avgZ;
          const limit = cornersMode
            ? restDx * 1.10
            : (poleMode ? restDx * 1.35 : (stadiumMode ? restDx * 1.35 : (crowdMode ? restDx * 1.18 : restDx * 1.65)));
          if (Math.abs(devZ) > limit) {
            const correction = devZ > 0 ? devZ - limit : devZ + limit;
            const gain = cornersMode ? 0.72 : (poleMode ? 0.62 : (crowdMode ? 0.58 : 0.5));
            pos[i3 + 2] -= correction * gain;
            prev[i3 + 2] -= correction * gain;
          }
        }
      }

      const minSep = restDx * (cornersMode ? 0.20 : (poleMode ? 0.22 : (crowdMode ? 0.20 : 0.18)));
      const orderPasses = cornersMode ? 3 : (crowdMode ? 3 : 2);
      for (let pass = 0; pass < orderPasses; pass++) {
        for (let j = 0; j < rows; j++) {
          for (let i = 1; i < cols; i++) {
            const left = j * cols + i - 1;
            const curr = left + 1;
            const l3 = left * 3;
            const c3 = curr * 3;
            const overlap = (pos[l3] + minSep) - pos[c3];
            if (overlap > 0.0) {
              const lf = fixed[left];
              const cf = fixed[curr];
              // Enforce monotonic row order by primarily pushing current point right.
              if (!cf) {
                pos[c3] += overlap;
                prev[c3] += overlap;
              } else if (!lf) {
                pos[l3] -= overlap;
                prev[l3] -= overlap;
              }
            }
          }
        }
      }
    }
  }

  // Compute normals
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
}
