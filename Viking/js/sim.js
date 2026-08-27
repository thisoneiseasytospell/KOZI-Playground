// Cloth + pole simulation. Runs as a module Web Worker (see bottom); createSim() is also
// importable directly for headless testing in node.

import {
  FLAG_W, FLAG_H, COLS, ROWS, NOTCH, TIME_SCALE, SUBSTEPS, FIXED_DT, WIND_MAX,
  POLE_LEN, POLE_BASE_Y, HOIST_TOP, HOIST_OFF, WAVE, MODES, RIG,
} from './config.js';

// ─── Tuning ──────────────────────────────────────────────────
const GRAVITY = 7.4;                   // lighter cloth
const DAMP = 0.996;                   // verlet velocity retention per substep
const K_NORMAL = 0.55;                // aerodynamic pressure (normal)
const K_TANGENT = 0.12;               // tangential drag
const K_STRUCT = 1.0, K_SHEAR = 0.7, K_BEND = 0.45;
const ITERS_A = 5, ITERS_B = 2;       // constraint passes before / after self-collision
const POLE_R = 0.07;                  // keep-out radius around the pole axis
const THICK_CELLS = 2.0;              // self-collision thickness, in cells
const LRA_SLACK = 1.004;              // satin barely stretches — cap at the taut geodesic
const POLE = {
  freq: 0.5,        // Hz — natural sway of the mast
  zeta: 0.07,       // damping ratio (low = keeps swaying)
  drive: 0.008,     // tip force per wind²
  couple: 9.0,      // how much the flag's lateral swing drags the tip
  maxBend: 0.5,     // safety clamp on tip deflection
};

export function createSim() {
  const N = COLS * ROWS;
  const pos = new Float32Array(N * 3);
  const prev = new Float32Array(N * 3);
  const nrm = new Float32Array(N * 3);
  const active = new Uint8Array(N);
  const restDx = FLAG_W / (COLS - 1), restDy = FLAG_H / (ROWS - 1);
  const idx = (ix, iy) => iy * COLS + ix;

  for (let iy = 0; iy < ROWS; iy++) {
    const v = iy / (ROWS - 1);
    const uEdge = 1 - NOTCH * (1 - Math.abs(2 * v - 1));
    for (let ix = 0; ix < COLS; ix++) active[idx(ix, iy)] = ix / (COLS - 1) <= uEdge + 1e-6 ? 1 : 0;
  }

  // ── constraints ──
  const cI = [], cJ = [], cR = [], cK = [], cWA = [], cWB = [];
  function addC(ix0, iy0, ix1, iy1, k) {
    if (ix1 < 0 || ix1 >= COLS || iy1 < 0 || iy1 >= ROWS) return;
    const a = idx(ix0, iy0), b = idx(ix1, iy1);
    if (!active[a] || !active[b]) return;
    const pa = ix0 === 0, pb = ix1 === 0;
    if (pa && pb) return;
    cI.push(a); cJ.push(b);
    cR.push(Math.hypot((ix1 - ix0) * restDx, (iy1 - iy0) * restDy));
    cK.push(k * 0.5);
    cWA.push(pa ? 0 : (pb ? 2 : 1));
    cWB.push(pb ? 0 : (pa ? 2 : 1));
  }
  for (let iy = 0; iy < ROWS; iy++) for (let ix = 0; ix < COLS; ix++) {
    addC(ix, iy, ix + 1, iy, K_STRUCT);
    addC(ix, iy, ix, iy + 1, K_STRUCT);
    addC(ix, iy, ix + 1, iy + 1, K_SHEAR);
    addC(ix, iy, ix + 1, iy - 1, K_SHEAR);
    addC(ix, iy, ix + 2, iy, K_BEND);
    addC(ix, iy, ix, iy + 2, K_BEND);
  }
  const NC = cI.length;
  const cIa = Int32Array.from(cI), cJa = Int32Array.from(cJ), cRa = Float32Array.from(cR), cKa = Float32Array.from(cK);
  const cWAa = Float32Array.from(cWA), cWBa = Float32Array.from(cWB);

  // ── rig (pole) ──
  const rig = new Float32Array(RIG.SIZE);
  const dir = [0, 1, 0], xAxis = [1, 0, 0], zAxis = [0, 0, 1], base = [0, POLE_BASE_Y, 0];
  const sway = { x: 0, z: 0, vx: 0, vz: 0 };
  const bendAt = (s) => { const k = s / POLE_LEN; return k * k; };
  let mode = 'mast', modeFrom = [0, 1, 0], modeBlend = 1;
  const dirTarget = [0, 1, 0];
  let twist = 0;                 // rotation of the hoist around the pole axis (radians)

  // Rotate v by the minimal rotation that takes +Y onto d (matches three's setFromUnitVectors).
  function rotateFromUp(d, v, out) {
    const kx = d[2], kz = -d[0];                 // up × d
    const s = Math.sqrt(kx * kx + kz * kz), c = d[1];
    if (s < 1e-8) { out[0] = v[0]; out[1] = c > 0 ? v[1] : -v[1]; out[2] = c > 0 ? v[2] : -v[2]; return out; }
    const ux = kx / s, uz = kz / s;              // unit axis (y = 0)
    const dot = ux * v[0] + uz * v[2];
    // u × v with u = (ux, 0, uz)
    const cx = -uz * v[1], cy = uz * v[0] - ux * v[2], cz = ux * v[1];
    out[0] = v[0] * c + cx * s + ux * dot * (1 - c);
    out[1] = v[1] * c + cy * s;
    out[2] = v[2] * c + cz * s + uz * dot * (1 - c);
    return out;
  }
  function poleDirFor(m, t, out) {
    if (m === 'wall') { out[0] = Math.SQRT1_2; out[1] = Math.SQRT1_2; out[2] = 0; return out; }
    if (m === 'wave') {
      const ph = 2 * Math.PI * WAVE.hz * t;
      const swing = 0.85 + 0.15 * Math.sin(0.23 * t);
      out[0] = WAVE.ampX * swing * Math.sin(ph); out[1] = 1; out[2] = WAVE.ampZ * Math.sin(2 * ph + 0.6);
      const l = Math.hypot(out[0], out[1], out[2]);
      out[0] /= l; out[1] /= l; out[2] /= l;
      return out;
    }
    out[0] = 0; out[1] = 1; out[2] = 0; return out;
  }
  function twistFor(m, t) {
    if (m !== 'wave') return 0;
    const ph = 2 * Math.PI * WAVE.hz * t;
    // Quarter-cycle behind the swing: the wrist rolls as the pole changes direction.
    return WAVE.twist * Math.sin(ph - Math.PI / 2);
  }
  function updateRig(t, dt) {
    poleDirFor(mode, t, dirTarget);
    const twTarget = twistFor(mode, t);
    twist = modeBlend < 1 ? twist + (twTarget - twist) * Math.min(1, dt * 3) : twTarget;
    if (modeBlend < 1) {
      modeBlend = Math.min(1, modeBlend + dt / 1.2);
      const k = modeBlend * modeBlend * (3 - 2 * modeBlend);
      for (let i = 0; i < 3; i++) dir[i] = modeFrom[i] + (dirTarget[i] - modeFrom[i]) * k;
      const l = Math.hypot(dir[0], dir[1], dir[2]);
      dir[0] /= l; dir[1] /= l; dir[2] /= l;
    } else {
      dir[0] = dirTarget[0]; dir[1] = dirTarget[1]; dir[2] = dirTarget[2];
    }
    rotateFromUp(dir, [1, 0, 0], xAxis);
    rotateFromUp(dir, [0, 0, 1], zAxis);
  }
  const _a = [0, 0, 0];
  function anchor(iy, out) {
    const s = HOIST_TOP - iy * restDy, k = bendAt(s);
    // The hoist rides the pole surface; twisting the pole swings it around the axis.
    const cx = Math.cos(twist) * HOIST_OFF, cz = Math.sin(twist) * HOIST_OFF;
    for (let i = 0; i < 3; i++) {
      out[i] = base[i] + dir[i] * s
             + xAxis[i] * (sway.x * k + cx)
             + zAxis[i] * (sway.z * k + cz);
    }
    return out;
  }

  function initCloth() {
    updateRig(0, 1);
    for (let iy = 0; iy < ROWS; iy++) {
      anchor(iy, _a);
      for (let ix = 0; ix < COLS; ix++) {
        const i = idx(ix, iy) * 3, u = ix / (COLS - 1);
        pos[i] = _a[0] + ix * restDx;
        pos[i + 1] = _a[1] - u * 0.15;
        pos[i + 2] = _a[2] + Math.sin(u * 9) * 0.06 * u;
        prev[i] = pos[i]; prev[i + 1] = pos[i + 1]; prev[i + 2] = pos[i + 2];
      }
    }
  }

  // ── wind & gusts ──
  const wind = { base: 0.7 * WIND_MAX };
  // power 1 is an ordinary gust; a held trigger sends more, and everything the gust drives
  // (push, lift, sideways shove, how long it leans on the flag) scales with it.
  const gust = { start: -1, next: 3.5, lift: 0.9, side: 0.4, fired: false, power: 1, hold: 0.8, pending: 0, last: 0 };
  let gustPeak = false;
  const RISE = 1.6, FALL = 3.0;
  const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
  function beginGust(t, power, resumeAt) {
    gust.start = t - resumeAt;
    gust.fired = false;
    gust.power = power;
    gust.hold = 0.8 * power;
    gust.lift = (0.6 + Math.random() * 0.9) * power;
    gust.side = (Math.random() - 0.5) * 1.2 * power;
    gust.next = t + 7 + Math.random() * 5;
  }
  function gustEnv(t) {
    if (gust.start < 0) {
      if (t < gust.next) return (gust.last = 0);
      beginGust(t, gust.pending || 1, 0);
      gust.pending = 0;
    }
    const e = t - gust.start, peak = RISE + gust.hold;
    let g;
    if (e < RISE) g = smooth(e / RISE);
    else if (e < peak) g = 1;
    else if (e < peak + FALL) g = 1 - smooth((e - peak) / FALL);
    else { gust.start = -1; g = 0; }
    return (gust.last = g);
  }
  function windMag(t, g) {
    const b = wind.base * MODES[mode].wind;
    return b * (0.85 + 0.15 * Math.sin(0.5 * t) + 0.10 * Math.sin(1.4 * t + 1.3)) + g * gust.power * (2.6 + b * 0.55);
  }
  const windCol = new Float32Array(COLS * 3);
  const windRow = new Float32Array(ROWS);
  function updateWindField(t, g, mag) {
    for (let ix = 0; ix < COLS; ix++) {
      const u = ix / (COLS - 1), o = ix * 3;
      windCol[o] = mag;
      windCol[o + 1] = mag * (0.22 * Math.sin(0.9 * t + 3.0 * u) + 0.12 * Math.sin(1.9 * t - 5.0 * u + 1.0)) + g * gust.lift * 2.4;
      windCol[o + 2] = mag * (0.35 * Math.sin(1.3 * t - 4.5 * u) + 0.18 * Math.sin(2.4 * t - 8.0 * u + 2.0)
                            + 0.07 * Math.sin(4.2 * t - 15.0 * u + 1.0)) + g * gust.side * 2.0;
    }
    for (let iy = 0; iy < ROWS; iy++) {
      const v = iy / (ROWS - 1);
      windRow[iy] = mag * (0.10 * Math.sin(0.8 * t + 2.2 * v) + 0.05 * Math.sin(2.4 * t + 3.1 * v));
    }
  }

  // ── pole sway ──
  function flagPullZ() {
    let sum = 0, n = 0;
    for (let iy = 0; iy < ROWS; iy += 4) {
      anchor(iy, _a);
      for (let ix = 2; ix <= 6; ix += 2) {
        const i = idx(ix, iy) * 3;
        sum += (pos[i] - _a[0]) * zAxis[0] + (pos[i + 1] - _a[1]) * zAxis[1] + (pos[i + 2] - _a[2]) * zAxis[2];
        n++;
      }
    }
    return n ? sum / n : 0;
  }
  function updateSway(dt, mag, g) {
    const omega = 2 * Math.PI * POLE.freq, k = omega * omega, c = 2 * POLE.zeta * omega;
    const fx = POLE.drive * mag * mag * (1 + 0.4 * g);
    const fz = POLE.couple * flagPullZ() + POLE.drive * 0.6 * mag * mag * g * gust.side;
    sway.vx += (fx - k * sway.x - c * sway.vx) * dt;
    sway.vz += (fz - k * sway.z - c * sway.vz) * dt;
    sway.x += sway.vx * dt;
    sway.z += sway.vz * dt;
    const m = Math.hypot(sway.x, sway.z);
    if (m > POLE.maxBend) { const s = POLE.maxBend / m; sway.x *= s; sway.z *= s; sway.vx *= 0.5; sway.vz *= 0.5; }
  }

  // ── solver pieces ──
  function computeNormals() {
    for (let iy = 0; iy < ROWS; iy++) for (let ix = 0; ix < COLS; ix++) {
      const l = idx(Math.max(ix - 1, 0), iy) * 3, r = idx(Math.min(ix + 1, COLS - 1), iy) * 3;
      const u = idx(ix, Math.max(iy - 1, 0)) * 3, d = idx(ix, Math.min(iy + 1, ROWS - 1)) * 3;
      const ax = pos[r] - pos[l], ay = pos[r + 1] - pos[l + 1], az = pos[r + 2] - pos[l + 2];
      const bx = pos[d] - pos[u], by = pos[d + 1] - pos[u + 1], bz = pos[d + 2] - pos[u + 2];
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      const i = idx(ix, iy) * 3;
      nrm[i] = nx / len; nrm[i + 1] = ny / len; nrm[i + 2] = nz / len;
    }
  }
  function solveConstraints(iters) {
    for (let it = 0; it < iters; it++) {
      for (let c = 0; c < NC; c++) {
        const a = cIa[c] * 3, b = cJa[c] * 3;
        const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        const corr = (d - cRa[c]) / d * cKa[c];
        const wa = corr * cWAa[c], wb = corr * cWBa[c];
        pos[a] += dx * wa; pos[a + 1] += dy * wa; pos[a + 2] += dz * wa;
        pos[b] -= dx * wb; pos[b + 1] -= dy * wb; pos[b + 2] -= dz * wb;
      }
    }
  }
  function extrapolateNotch() {
    for (let iy = 0; iy < ROWS; iy++) {
      let e = COLS - 1;
      while (e > 1 && !active[idx(e, iy)]) e--;
      if (e === COLS - 1) continue;
      const a = idx(e, iy) * 3, b = idx(e - 1, iy) * 3;
      const dx = pos[a] - pos[b], dy = pos[a + 1] - pos[b + 1], dz = pos[a + 2] - pos[b + 2];
      for (let ix = e + 1; ix < COLS; ix++) {
        const k = ix - e, i = idx(ix, iy) * 3;
        pos[i] = pos[a] + dx * k; pos[i + 1] = pos[a + 1] + dy * k; pos[i + 2] = pos[a + 2] + dz * k;
        prev[i] = pos[i]; prev[i + 1] = pos[i + 1]; prev[i + 2] = pos[i + 2];
      }
    }
  }

  // Self-collision: particles that are not grid neighbours stay a cloth-thickness apart.
  const THICK = restDx * THICK_CELLS, THICK2 = THICK * THICK;
  const HASH_N = 1 << 15, HASH_MASK = HASH_N - 1;
  const cellStart = new Int32Array(HASH_N + 1), fillPtr = new Int32Array(HASH_N);
  const cellOf = new Int32Array(N), sorted = new Int32Array(N);
  const hashCell = (cx, cy, cz) => (((cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791)) & HASH_MASK);
  function selfCollide() {
    const inv = 1 / THICK;
    cellStart.fill(0);
    for (let p = 0; p < N; p++) {
      if (!active[p]) { cellOf[p] = -1; continue; }
      const i = p * 3;
      const h = hashCell(Math.floor(pos[i] * inv), Math.floor(pos[i + 1] * inv), Math.floor(pos[i + 2] * inv));
      cellOf[p] = h;
      cellStart[h + 1]++;
    }
    for (let h = 0; h < HASH_N; h++) { cellStart[h + 1] += cellStart[h]; fillPtr[h] = cellStart[h]; }
    for (let p = 0; p < N; p++) { const h = cellOf[p]; if (h >= 0) sorted[fillPtr[h]++] = p; }

    for (let p = 0; p < N; p++) {
      if (!active[p]) continue;
      const i = p * 3, px = pos[i], py = pos[i + 1], pz = pos[i + 2];
      const pix = p % COLS, piy = (p / COLS) | 0;
      const cx = Math.floor(px * inv), cy = Math.floor(py * inv), cz = Math.floor(pz * inv);
      const pinnedP = pix === 0;
      // Probing all 27 cells and keeping q > p looks redundant, but it always moves the
      // later-indexed particle, so every push is followed by that particle's own pass. A
      // forward-half probe is ~10% faster and leaves ~40% more residual overlap.
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (let oz = -1; oz <= 1; oz++) {
        const h = hashCell(cx + ox, cy + oy, cz + oz);
        for (let s = cellStart[h], e = cellStart[h + 1]; s < e; s++) {
          const q = sorted[s];
          if (q <= p) continue;
          const qix = q % COLS, qiy = (q / COLS) | 0;
          if (Math.abs(qix - pix) <= 2 && Math.abs(qiy - piy) <= 2) continue;
          const j = q * 3;
          const dx = pos[j] - px, dy = pos[j + 1] - py, dz = pos[j + 2] - pz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= THICK2 || d2 < 1e-10) continue;
          const d = Math.sqrt(d2), push = (THICK - d) / d;
          const pinnedQ = qix === 0;
          const wp = pinnedP ? 0 : (pinnedQ ? 1 : 0.5), wq = pinnedQ ? 0 : (pinnedP ? 1 : 0.5);
          pos[i] -= dx * push * wp; pos[i + 1] -= dy * push * wp; pos[i + 2] -= dz * push * wp;
          pos[j] += dx * push * wq; pos[j + 1] += dy * push * wq; pos[j + 2] += dz * push * wq;
        }
      }
    }
  }
  // Long-range attachments. Gauss-Seidel only carries the hoist's motion a few cells per
  // substep, so a fast pole swing leaves the fabric rubbery near the pole. Capping every
  // particle's distance to the pin in its own row (the shortest geodesic to the hoist) takes
  // that out in one O(N) pass — no extra iterations, which the frame budget has no room for.
  function longRangeAttach() {
    for (let iy = 0; iy < ROWS; iy++) {
      anchor(iy, _a);
      const ax = _a[0], ay = _a[1], az = _a[2];
      for (let ix = 1; ix < COLS; ix++) {
        const p = idx(ix, iy);
        if (!active[p]) continue;
        const i = p * 3;
        const dx = pos[i] - ax, dy = pos[i + 1] - ay, dz = pos[i + 2] - az;
        const d2 = dx * dx + dy * dy + dz * dz;
        const max = ix * restDx * LRA_SLACK;
        if (d2 <= max * max) continue;
        const k = max / Math.sqrt(d2);
        pos[i] = ax + dx * k; pos[i + 1] = ay + dy * k; pos[i + 2] = az + dz * k;
      }
    }
  }
  function poleCollide() {
    for (let p = 0; p < N; p++) {
      if (!active[p] || p % COLS === 0) continue;
      const i = p * 3;
      const rx = pos[i] - base[0], ry = pos[i + 1] - base[1], rz = pos[i + 2] - base[2];
      const sAlong = rx * dir[0] + ry * dir[1] + rz * dir[2];
      if (sAlong < 0 || sAlong > POLE_LEN + 0.15) continue;
      const k = bendAt(Math.min(sAlong, POLE_LEN));
      const ox = xAxis[0] * sway.x * k + zAxis[0] * sway.z * k;
      const oy = xAxis[1] * sway.x * k + zAxis[1] * sway.z * k;
      const oz = xAxis[2] * sway.x * k + zAxis[2] * sway.z * k;
      const qx = rx - dir[0] * sAlong - ox, qy = ry - dir[1] * sAlong - oy, qz = rz - dir[2] * sAlong - oz;
      const len = Math.sqrt(qx * qx + qy * qy + qz * qz);
      if (len >= POLE_R) continue;
      if (len < 1e-5) { pos[i + 2] += POLE_R; continue; }
      const kk = (POLE_R - len) / len;
      pos[i] += qx * kk; pos[i + 1] += qy * kk; pos[i + 2] += qz * kk;
    }
  }

  let time = 0;
  function step(dt) {
    time += dt;
    const t = time, g = gustEnv(t);
    if (g >= 1 && !gust.fired) { gust.fired = true; gustPeak = true; }
    updateRig(t, dt);
    const mag = windMag(t, g);
    updateSway(dt, mag, g);
    updateWindField(t, g, mag);
    computeNormals();
    const maxStep = restDx * 1.5, invDt = 1 / dt;
    for (let iy = 0; iy < ROWS; iy++) {
      const wzRow = windRow[iy];
      for (let ix = 1; ix < COLS; ix++) {
        const p = idx(ix, iy);
        if (!active[p]) continue;
        const i = p * 3, o = ix * 3;
        let vx = (pos[i] - prev[i]) * DAMP, vy = (pos[i + 1] - prev[i + 1]) * DAMP, vz = (pos[i + 2] - prev[i + 2]) * DAMP;
        const rx = windCol[o] - vx * invDt, ry = windCol[o + 1] - vy * invDt, rz = windCol[o + 2] + wzRow - vz * invDt;
        const nx = nrm[i], ny = nrm[i + 1], nz = nrm[i + 2];
        const vn = rx * nx + ry * ny + rz * nz;
        const pn = vn * Math.abs(vn) * K_NORMAL;
        let ax = nx * pn + (rx - nx * vn) * K_TANGENT;
        let ay = ny * pn + (ry - ny * vn) * K_TANGENT - GRAVITY;
        let az = nz * pn + (rz - nz * vn) * K_TANGENT;
        const am = Math.sqrt(ax * ax + ay * ay + az * az);
        if (am > 90) { const s = 90 / am; ax *= s; ay *= s; az *= s; }
        vx += ax * dt * dt; vy += ay * dt * dt; vz += az * dt * dt;
        const vm = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (vm > maxStep) { const s = maxStep / vm; vx *= s; vy *= s; vz *= s; }
        prev[i] = pos[i]; prev[i + 1] = pos[i + 1]; prev[i + 2] = pos[i + 2];
        pos[i] += vx; pos[i + 1] += vy; pos[i + 2] += vz;
      }
    }
    for (let iy = 0; iy < ROWS; iy++) {
      anchor(iy, _a);
      const i = idx(0, iy) * 3;
      pos[i] = prev[i] = _a[0]; pos[i + 1] = prev[i + 1] = _a[1]; pos[i + 2] = prev[i + 2] = _a[2];
    }
    solveConstraints(ITERS_A);
    longRangeAttach();
    selfCollide();
    poleCollide();
    solveConstraints(ITERS_B);
    longRangeAttach();
    extrapolateNotch();

    rig.set(dir, RIG.DIR); rig.set(xAxis, RIG.XAXIS); rig.set(zAxis, RIG.ZAXIS);
    rig[RIG.SWAY] = sway.x; rig[RIG.SWAY + 1] = sway.z;
    rig[RIG.TWIST] = twist;
    rig.set(base, RIG.BASE);
  }

  initCloth();
  return {
    pos, rig, active, NC, cIa, cJa, cRa,
    get time() { return time; },
    step,
    setWind(frac) { wind.base = frac * WIND_MAX; },
    setMode(m) {
      if (m === mode || !MODES[m]) return;
      modeFrom = dir.slice(); modeBlend = 0; mode = m;
    },
    gust(power = 1) {
      // Mid-gust retrigger re-enters the rise where the envelope already is, so a second
      // press doesn't drop the wind out from under the flag.
      if (gust.start < 0) { gust.pending = power; gust.next = Math.min(gust.next, time); }
      else beginGust(time, power, RISE * gust.last);
    },
    consumeGustPeak() { const p = gustPeak; gustPeak = false; return p; },
    reset() { initCloth(); },
  };
}

// ─── Worker glue ─────────────────────────────────────────────
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  const sim = createSim();
  const pool = [];
  let last = performance.now(), acc = 0;
  const MAX_STEPS = SUBSTEPS * 2;

  self.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'wind') sim.setWind(m.value);
    else if (m.type === 'mode') sim.setMode(m.value);
    else if (m.type === 'gust') sim.gust(m.power);
    else if (m.type === 'buf') pool.push(m.buf);
  };

  function tick() {
    const now = performance.now();
    acc += Math.min((now - last) / 1000, 0.05) * TIME_SCALE;
    last = now;
    let steps = 0;
    while (acc >= FIXED_DT && steps < MAX_STEPS) { acc -= FIXED_DT; sim.step(FIXED_DT); steps++; }
    if (steps === MAX_STEPS) acc = 0;                 // drop backlog rather than spiral
    if (steps === 0) return;
    const buf = pool.pop() || new ArrayBuffer(sim.pos.byteLength);
    new Float32Array(buf).set(sim.pos);
    self.postMessage({ type: 'frame', buf, rig: sim.rig.slice(), gustPeak: sim.consumeGustPeak(), time: sim.time }, [buf]);
  }
  setInterval(tick, 1000 / 60);
}
