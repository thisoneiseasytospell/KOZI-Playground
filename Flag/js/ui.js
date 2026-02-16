import { SIM, cols, rows, flagW, flagH, state } from './config.js';
import { pos, prev, fixed, initCloth, windDebug, uv, addRippleAtUV } from './cloth.js';
import { loadTexture, removeTexture, canvas } from './renderer.js';
import { cam, eyePos } from './camera.js';

const DEFAULT_TEXTURE_PATH = 'demo%20flag.png';
let gravityTweenId = 0;

function cancelGravityTween() {
  gravityTweenId += 1;
}

function setGravityValue(val) {
  const g = Math.max(-30, Math.min(30, val));
  const gravitySlider = document.getElementById('gravity');
  const gravityVal = document.getElementById('gravityVal');
  if (gravitySlider) gravitySlider.value = `${g}`;
  if (gravityVal) gravityVal.textContent = g.toFixed(1);
  SIM.gravity = g;
}

function startGravityTransition(from, to, durationMs = 1000) {
  const token = ++gravityTweenId;
  const start = performance.now();
  setGravityValue(from);

  function step(now) {
    if (token !== gravityTweenId) return;
    const t = Math.min((now - start) / durationMs, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    const gv = from + (to - from) * eased;
    setGravityValue(gv);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function startPinnedGravityTransition() {
  startGravityTransition(-12.0, 0.0, 1000);
}

function startFlagGravityTransition() {
  startGravityTransition(-6.0, -0.5, 1000);
}

function perspective(fov, asp, near, far) {
  const f = 1 / Math.tan(fov / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / asp, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function lookAt(e, t, u) {
  let zx = e[0] - t[0];
  let zy = e[1] - t[1];
  let zz = e[2] - t[2];
  let l = Math.sqrt(zx * zx + zy * zy + zz * zz);
  if (l < 1e-6) l = 1e-6;
  const z = [zx / l, zy / l, zz / l];
  let xx = u[1] * z[2] - u[2] * z[1];
  let xy = u[2] * z[0] - u[0] * z[2];
  let xz = u[0] * z[1] - u[1] * z[0];
  l = Math.sqrt(xx * xx + xy * xy + xz * xz);
  if (l < 1e-6) l = 1e-6;
  const x = [xx / l, xy / l, xz / l];
  const y = [
    x[1] * z[2] - x[2] * z[1],
    x[2] * z[0] - x[0] * z[2],
    x[0] * z[1] - x[1] * z[0],
  ];
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -(x[0] * e[0] + x[1] * e[1] + x[2] * e[2]),
    -(y[0] * e[0] + y[1] * e[1] + y[2] * e[2]),
    -(z[0] * e[0] + z[1] * e[1] + z[2] * e[2]),
    1,
  ]);
}

function mulMat4(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = (
        a[0 * 4 + r] * b[c * 4 + 0]
        + a[1 * 4 + r] * b[c * 4 + 1]
        + a[2 * 4 + r] * b[c * 4 + 2]
        + a[3 * 4 + r] * b[c * 4 + 3]
      );
    }
  }
  return out;
}

function closestUvFromClient(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;

  const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ny = 1 - ((clientY - rect.top) / rect.height) * 2;

  const eye = eyePos();
  const view = lookAt(eye, cam.target, [0, 1, 0]);
  const proj = perspective(Math.PI / 4.5, canvas.width / Math.max(canvas.height, 1), 0.1, 100);
  const viewProj = mulMat4(proj, view);

  let bestIdx = -1;
  let bestD2 = 0.25;
  for (let p = 0; p < cols * rows; p++) {
    const i3 = p * 3;
    const x = pos[i3];
    const y = pos[i3 + 1];
    const z = pos[i3 + 2];
    const cx = viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12];
    const cy = viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13];
    const cw = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
    if (cw <= 1e-5) continue;
    const px = cx / cw;
    const py = cy / cw;
    if (px < -1.4 || px > 1.4 || py < -1.4 || py > 1.4) continue;
    const dx = px - nx;
    const dy = py - ny;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestIdx = p;
    }
  }

  if (bestIdx < 0) return null;
  const i2 = bestIdx * 2;
  return { u: uv[i2], v: uv[i2 + 1] };
}

// ─── View modes ─────────────────────────────────────────────────
function setActiveViewButtons() {
  document.getElementById('viewFullscreen').classList.toggle('active', state.viewMode === 'fullscreen');
  document.getElementById('viewPinned').classList.toggle('active', state.viewMode === 'pinned');
  document.getElementById('viewFree').classList.toggle('active', state.viewMode === 'free');
  document.getElementById('viewStadium').classList.toggle('active', state.viewMode === 'stadium');
  document.getElementById('viewCrowd').classList.toggle('active', state.viewMode === 'crowd');
}

export function enterFullscreen() {
  cancelGravityTween();
  state.viewMode = 'fullscreen';
  setActiveViewButtons();
  cam.tgtTheta = 0.0;
  cam.curTheta = 0.0;
  cam.tgtPhi = 0.0;
  cam.curPhi = 0.0;
  cam.tgtPan[0] = 0;
  cam.tgtPan[1] = 0;
  cam.tgtPan[2] = 0;
  startFlagGravityTransition();
}

export function enterPinned() {
  cancelGravityTween();
  state.viewMode = 'pinned';
  setActiveViewButtons();

  initCloth();

  cam.tgtTheta = 0.0;
  cam.curTheta = 0.0;
  cam.tgtPhi = 0.0;
  cam.curPhi = 0.0;
  cam.tgtPan[0] = 0;
  cam.tgtPan[1] = 0;
  cam.tgtPan[2] = 0;

  startPinnedGravityTransition();
}

export function enterFree() {
  cancelGravityTween();
  state.viewMode = 'free';
  setActiveViewButtons();

  initCloth();

  cam.tgtTheta = 0.0;
  cam.curTheta = 0.0;
  cam.tgtPhi = 0.0;
  cam.curPhi = 0.0;
  cam.tgtPan[0] = 0;
  cam.tgtPan[1] = 0;
  cam.tgtPan[2] = 0;
  SIM.zoom = 82;
}

export function enterStadium() {
  cancelGravityTween();
  state.viewMode = 'stadium';
  setActiveViewButtons();

  initCloth();

  // Original F1 pole-driven framing.
  cam.tgtTheta = -0.32;
  cam.curTheta = -0.32;
  cam.tgtPhi = 0.18;
  cam.curPhi = 0.18;
  cam.tgtDist = 7.6;
  cam.curDist = 7.6;
  cam.tgtPan[0] = 0;
  cam.tgtPan[1] = 0;
  cam.tgtPan[2] = 0;
}

export function enterCrowd() {
  cancelGravityTween();
  state.viewMode = 'crowd';
  setActiveViewButtons();

  initCloth();

  // Stand perspective for trapezium crowd projection.
  cam.tgtTheta = -0.58;
  cam.curTheta = -0.58;
  cam.tgtPhi = 0.20;
  cam.curPhi = 0.20;
  cam.tgtDist = 5.9;
  cam.curDist = 5.9;
  cam.tgtPan[0] = 0;
  cam.tgtPan[1] = 0;
  cam.tgtPan[2] = 0;
}

// ─── Wind direction helpers ─────────────────────────────────────
function dirLabel(d) {
  d = ((d % 360) + 360) % 360;
  const labels = ['Front', 'Front-Right', 'Side', 'Back-Right', 'Back', 'Back-Left', 'Side', 'Front-Left'];
  return labels[Math.round(d / 45) % 8];
}

// ─── Setup all UI bindings ──────────────────────────────────────
export function setupUI() {
  // Panel toggle
  const panel = document.getElementById('panel');
  const driftHint = document.getElementById('driftHint');
  document.getElementById('panelClose').addEventListener('click', () => panel.classList.add('collapsed'));
  document.getElementById('panelToggle').addEventListener('click', () => panel.classList.remove('collapsed'));

  // Sliders
  function slider(id, valId, fn) {
    const el = document.getElementById(id), v = document.getElementById(valId);
    el.addEventListener('input', () => { v.textContent = fn(el.value); });
  }
  slider('windStrength', 'windVal', v => { SIM.windStrength = +v; return v; });
  slider('turbulence', 'turbVal', v => { SIM.turbulence = +v; return v; });
  slider('windDrift', 'driftVal', v => {
    const vv = +v;
    SIM.windDrift = vv;
    if (driftHint) {
      driftHint.textContent = vv <= 0
        ? 'No auto-sway. Wind direction stays fixed.'
        : `Auto-sways wind direction by up to ±${vv}\u00B0.`;
    }
    return vv <= 0 ? 'Off' : `\u00B1${vv}\u00B0`;
  });
  slider('stiffness', 'stiffVal', v => { SIM.stiffness = +v; return v; });
  slider('damping', 'dampVal', v => { SIM.damping = +v; return v; });
  slider('opacity', 'opacityVal', v => { SIM.opacity = v / 100; return v + '%'; });
  slider('stretch', 'stretchVal', v => { SIM.stretch = +v; return v; });
  const gravitySlider = document.getElementById('gravity');
  const gravityVal = document.getElementById('gravityVal');
  gravitySlider.addEventListener('input', () => {
    cancelGravityTween();
    const gv = +gravitySlider.value;
    SIM.gravity = gv;
    gravityVal.textContent = gv.toFixed(1);
  });

  // Pin controls
  const pinCornersBtn = document.getElementById('pinCorners');
  const pinPoleDenseBtn = document.getElementById('pinPoleDense');
  const pinCustomBtn = document.getElementById('pinCustom');
  const pinMap = document.getElementById('pinMap');
  const pinClearBtn = document.getElementById('pinClearBtn');
  const customPins = [];
  let draggingPin = -1;
  let touchDraggingPin = -1;
  const PIN_HIT_PX = 11;
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const pinsLocked = () => (
    state.viewMode === 'stadium'
    || state.viewMode === 'pinned'
    || state.viewMode === 'crowd'
    || state.viewMode === 'free'
  );

  function snapPinnedAtRest(idx) {
    const u = (idx % cols) / (cols - 1);
    const v = ((idx / cols) | 0) / (rows - 1);
    const i3 = idx * 3;
    const rx = u * flagW;
    const ry = -v * flagH + flagH * 0.5;
    pos[i3] = prev[i3] = rx;
    pos[i3 + 1] = prev[i3 + 1] = ry;
    pos[i3 + 2] = prev[i3 + 2] = 0;
  }

  function uvFromClient(clientX, clientY) {
    const r = pinMap.getBoundingClientRect();
    return {
      u: clamp01((clientX - r.left) / Math.max(r.width, 1)),
      v: clamp01((clientY - r.top) / Math.max(r.height, 1)),
    };
  }

  function closestPinIndex(clientX, clientY) {
    const r = pinMap.getBoundingClientRect();
    const lx = clientX - r.left;
    const ly = clientY - r.top;
    let best = -1;
    let bestD2 = PIN_HIT_PX * PIN_HIT_PX;
    for (let i = 0; i < customPins.length; i++) {
      const dx = lx - customPins[i].u * r.width;
      const dy = ly - customPins[i].v * r.height;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) {
        best = i;
        bestD2 = d2;
      }
    }
    return best;
  }

  function renderPinMap() {
    pinMap.querySelectorAll('.pin-map-dot').forEach(el => el.remove());
    for (const p of customPins) {
      const dot = document.createElement('div');
      dot.className = 'pin-map-dot';
      dot.style.left = `${(p.u * 100).toFixed(3)}%`;
      dot.style.top = `${(p.v * 100).toFixed(3)}%`;
      pinMap.appendChild(dot);
    }
  }

  function applyPins() {
    fixed.fill(0);
    const pinAt = (i, j) => {
      const ii = Math.max(0, Math.min(cols - 1, i));
      const jj = Math.max(0, Math.min(rows - 1, j));
      const idx = jj * cols + ii;
      if (fixed[idx]) return;
      fixed[idx] = 1;
      snapPinnedAtRest(idx);
    };

    if (state.viewMode === 'pinned') {
      const lastCol = cols - 1;
      const lastRow = rows - 1;
      pinAt(0, 0);
      pinAt(lastCol, 0);
      pinAt(0, lastRow);
      pinAt(lastCol, lastRow);
      return;
    }

    if (state.viewMode === 'free') {
      const lastCol = cols - 1;
      const lastRow = rows - 1;
      pinAt(0, 0);
      pinAt(lastCol, 0);
      pinAt(0, lastRow);
      pinAt(lastCol, lastRow);
      return;
    }

    if (state.viewMode === 'stadium') {
      for (let j = 0; j < rows; j++) pinAt(0, j);
      return;
    }

    // Crowd mode: dense top holds and side anchors for trapezium projection.
    if (state.viewMode === 'crowd') {
      const lastCol = cols - 1;
      const lastRow = rows - 1;
      for (let i = 0; i < cols; i += 2) pinAt(i, 0);
      for (let i = 0; i < cols; i += 6) pinAt(i, 1);
      const sideA = Math.round((rows - 1) * 0.24);
      const sideB = Math.round((rows - 1) * 0.42);
      pinAt(0, sideA);
      pinAt(lastCol, sideA);
      pinAt(0, sideB);
      pinAt(lastCol, sideB);
      pinAt(0, lastRow);
      pinAt(lastCol, lastRow);
      return;
    }

    if (state.pinMode === 'custom') {
      const used = new Set();
      for (const p of customPins) {
        const i = Math.round(clamp01(p.u) * (cols - 1));
        const j = Math.round(clamp01(p.v) * (rows - 1));
        const idx = j * cols + i;
        if (used.has(idx)) continue;
        used.add(idx);
        fixed[idx] = 1;
        snapPinnedAtRest(idx);
      }
      return;
    }

    if (state.pinMode === 'corners') {
      const lastCol = cols - 1;
      const lastRow = rows - 1;
      const edgeCols = [0, 0.18, 0.5, 0.82, 1].map(f => Math.round(lastCol * f));
      const edgeRows = [0, 0.5, 1].map(f => Math.round(lastRow * f));

      // Keep a sheet-like frame: corners + sparse edge supports.
      for (const i of edgeCols) {
        pinAt(i, 0);
        pinAt(i, lastRow);
      }
      for (const j of edgeRows) {
        pinAt(0, j);
        pinAt(lastCol, j);
      }

      // Corner clusters smooth out fake diagonal-only stretching.
      const offsets = [1, 2];
      for (const ox of offsets) {
        for (const oy of offsets) {
          pinAt(ox, oy);
          pinAt(lastCol - ox, oy);
          pinAt(ox, lastRow - oy);
          pinAt(lastCol - ox, lastRow - oy);
        }
      }
      return;
    }

    if (state.pinMode === 'poleDense') {
      for (let j = 0; j < rows; j++) {
        const idx = j * cols;
        fixed[idx] = 1;
        snapPinnedAtRest(idx);
      }
      return;
    }

    for (let j = 0; j < rows; j++) {
      const idx = j * cols;
      fixed[idx] = 1;
      snapPinnedAtRest(idx);
    }
  }

  function syncPinUI() {
    const lockPins = pinsLocked();
    const uiPinMode = state.viewMode === 'pinned'
      ? 'corners'
      : (state.viewMode === 'stadium'
        ? 'poleDense'
        : ((state.viewMode === 'crowd' || state.viewMode === 'free') ? 'corners' : state.pinMode));
    pinCornersBtn.classList.toggle('active', uiPinMode === 'corners');
    pinPoleDenseBtn.classList.toggle('active', uiPinMode === 'poleDense');
    pinCustomBtn.classList.toggle('active', uiPinMode === 'custom');
    pinCornersBtn.disabled = lockPins;
    pinPoleDenseBtn.disabled = lockPins;
    pinCustomBtn.disabled = lockPins;
    pinClearBtn.disabled = lockPins;
    pinMap.style.opacity = lockPins ? '0.42' : (state.pinMode === 'custom' ? '1' : '0.72');
    pinMap.style.pointerEvents = lockPins ? 'none' : 'auto';
  }

  function setPinMode(mode) {
    if (pinsLocked()) return;
    state.pinMode = mode;
    syncPinUI();
    applyPins();
  }

  function applyTallPolePreset() {
    cancelGravityTween();
    document.getElementById('windStrength').value = 36;
    document.getElementById('turbulence').value = 30;
    document.getElementById('windDrift').value = 24;
    document.getElementById('stiffness').value = 40;
    document.getElementById('damping').value = 92;
    document.getElementById('opacity').value = 0;
    document.getElementById('stretch').value = 10;
    document.getElementById('gravity').value = 0;

    SIM.windStrength = 36;
    SIM.turbulence = 30;
    SIM.windDrift = 24;
    SIM.windAngle = 90;
    SIM.zoom = 72;
    SIM.stiffness = 40;
    SIM.damping = 92;
    SIM.opacity = 0.0;
    SIM.stretch = 10;
    SIM.gravity = 0.0;
    state.pinMode = 'poleDense';
    syncPinUI();

    document.getElementById('windVal').textContent = '36';
    document.getElementById('turbVal').textContent = '30';
    document.getElementById('driftVal').textContent = '\u00B124°';
    if (driftHint) driftHint.textContent = 'Auto-sways wind direction by up to \u00B124\u00B0.';
    document.getElementById('stiffVal').textContent = '40';
    document.getElementById('dampVal').textContent = '92';
    document.getElementById('opacityVal').textContent = '0%';
    document.getElementById('stretchVal').textContent = '10';
    document.getElementById('gravityVal').textContent = '0.0';

    updateDial();
    applyPins();
  }

  // Wind dial
  const windDial = document.getElementById('windDial');
  const windArrow = document.getElementById('windArrow');
  const windDegEl = document.getElementById('windDeg');
  const windDirLbl = document.getElementById('windDirLabel');
  let dialDrag = false;

  function updateDial() {
    const liveAngle = ((SIM.windAngle + windDebug.angleOffset) % 360 + 360) % 360;
    windArrow.style.transform = `translateX(-50%) translateY(-100%) rotate(${liveAngle}deg)`;
    windDegEl.textContent = Math.round(liveAngle) + '\u00B0';
    windDirLbl.textContent = dirLabel(liveAngle);
  }

  function dialFromEvent(e) {
    const r = windDial.getBoundingClientRect();
    const cx = e.clientX - r.left - r.width / 2;
    const cy = -(e.clientY - r.top - r.height / 2);
    SIM.windAngle = ((Math.atan2(cx, cy) * 180 / Math.PI) + 360) % 360;
    updateDial();
  }

  windDial.addEventListener('mousedown', e => { dialDrag = true; dialFromEvent(e); });
  window.addEventListener('mousemove', e => { if (dialDrag) dialFromEvent(e); });
  window.addEventListener('mouseup', () => dialDrag = false);
  windDial.addEventListener('touchstart', e => { e.preventDefault(); dialDrag = true; dialFromEvent(e.touches[0]); });
  window.addEventListener('touchmove', e => { if (dialDrag) { e.preventDefault(); dialFromEvent(e.touches[0]); } }, { passive: false });
  window.addEventListener('touchend', () => dialDrag = false);
  updateDial();
  setInterval(updateDial, 120);

  let freeRippling = false;
  let freeTouchRippling = false;
  let lastRippleMs = 0;

  function rippleAtClient(clientX, clientY, drag = false) {
    if (state.viewMode !== 'free') return;
    const now = performance.now();
    if (drag && now - lastRippleMs < 18) return;
    const hit = closestUvFromClient(clientX, clientY);
    if (!hit) return;
    lastRippleMs = now;
    addRippleAtUV(hit.u, hit.v, drag ? 0.62 : 1.05);
  }

  canvas.addEventListener('mousedown', e => {
    if (state.viewMode !== 'free') return;
    if (e.button !== 0 || e.altKey || e.shiftKey) return;
    freeRippling = true;
    rippleAtClient(e.clientX, e.clientY, false);
  });

  window.addEventListener('mousemove', e => {
    if (!freeRippling) return;
    rippleAtClient(e.clientX, e.clientY, true);
  });

  window.addEventListener('mouseup', () => {
    freeRippling = false;
  });

  canvas.addEventListener('touchstart', e => {
    if (state.viewMode !== 'free' || e.touches.length !== 1) return;
    const t = e.touches[0];
    freeTouchRippling = true;
    rippleAtClient(t.clientX, t.clientY, false);
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    if (!freeTouchRippling || state.viewMode !== 'free' || e.touches.length !== 1) return;
    const t = e.touches[0];
    rippleAtClient(t.clientX, t.clientY, true);
    e.preventDefault();
  }, { passive: false });

  window.addEventListener('touchend', () => {
    freeTouchRippling = false;
  });

  pinMap.addEventListener('contextmenu', e => e.preventDefault());
  pinMap.addEventListener('mousedown', e => {
    if (pinsLocked()) return;
    const hit = closestPinIndex(e.clientX, e.clientY);

    if (e.button === 2) {
      e.preventDefault();
      if (hit >= 0) {
        customPins.splice(hit, 1);
        state.pinMode = 'custom';
        syncPinUI();
        applyPins();
        renderPinMap();
      }
      return;
    }
    if (e.button !== 0) return;

    e.preventDefault();
    state.pinMode = 'custom';
    syncPinUI();

    if (hit >= 0) {
      draggingPin = hit;
      renderPinMap();
      applyPins();
    } else {
      const uvp = uvFromClient(e.clientX, e.clientY);
      customPins.push(uvp);
      draggingPin = customPins.length - 1;
      renderPinMap();
      applyPins();
    }
  });

  window.addEventListener('mousemove', e => {
    if (draggingPin < 0 || draggingPin >= customPins.length) return;
    customPins[draggingPin] = uvFromClient(e.clientX, e.clientY);
    renderPinMap();
    applyPins();
  });

  window.addEventListener('mouseup', () => { draggingPin = -1; });

  pinMap.addEventListener('touchstart', e => {
    if (pinsLocked()) return;
    if (!e.touches.length) return;
    const t = e.touches[0];
    const hit = closestPinIndex(t.clientX, t.clientY);
    state.pinMode = 'custom';
    syncPinUI();
    if (hit >= 0) {
      touchDraggingPin = hit;
      renderPinMap();
      applyPins();
    } else {
      customPins.push(uvFromClient(t.clientX, t.clientY));
      touchDraggingPin = customPins.length - 1;
      renderPinMap();
      applyPins();
    }
    e.preventDefault();
  }, { passive: false });

  window.addEventListener('touchmove', e => {
    if (touchDraggingPin < 0 || !e.touches.length || touchDraggingPin >= customPins.length) return;
    const t = e.touches[0];
    customPins[touchDraggingPin] = uvFromClient(t.clientX, t.clientY);
    renderPinMap();
    applyPins();
    e.preventDefault();
  }, { passive: false });

  window.addEventListener('touchend', () => { touchDraggingPin = -1; });
  pinClearBtn.addEventListener('click', () => {
    if (pinsLocked()) return;
    customPins.length = 0;
    state.pinMode = 'custom';
    syncPinUI();
    renderPinMap();
    applyPins();
  });

  pinCornersBtn.addEventListener('click', () => setPinMode('corners'));
  pinPoleDenseBtn.addEventListener('click', () => setPinMode('poleDense'));
  pinCustomBtn.addEventListener('click', () => setPinMode('custom'));
  renderPinMap();
  syncPinUI();

  // Color picker
  const colorIn = document.getElementById('flagColor');
  const bgColorIn = document.getElementById('bgColor');
  const themeBg = {
    dark: [0.039, 0.039, 0.043],
    light: [0.95, 0.94, 0.92],
  };
  function applyHexColor(hex, target) {
    target[0] = parseInt(hex.substr(1, 2), 16) / 255;
    target[1] = parseInt(hex.substr(3, 2), 16) / 255;
    target[2] = parseInt(hex.substr(5, 2), 16) / 255;
  }
  function rgbToHex(rgb) {
    const r = Math.round(Math.max(0, Math.min(1, rgb[0])) * 255).toString(16).padStart(2, '0');
    const g = Math.round(Math.max(0, Math.min(1, rgb[1])) * 255).toString(16).padStart(2, '0');
    const b = Math.round(Math.max(0, Math.min(1, rgb[2])) * 255).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }
  function applyThemeBg(theme) {
    const c = themeBg[theme];
    SIM.bgColor[0] = c[0];
    SIM.bgColor[1] = c[1];
    SIM.bgColor[2] = c[2];
    bgColorIn.value = rgbToHex(c);
  }
  colorIn.addEventListener('input', () => {
    applyHexColor(colorIn.value, SIM.flagColor);
  });
  bgColorIn.addEventListener('input', () => {
    applyHexColor(bgColorIn.value, SIM.bgColor);
    themeBg[state.theme] = [SIM.bgColor[0], SIM.bgColor[1], SIM.bgColor[2]];
  });

  // File upload
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const texPrev = document.getElementById('texturePreview');
  const prevImg = document.getElementById('previewImg');
  const prevVideo = document.getElementById('previewVideo');
  const useWebcamBtn = document.getElementById('useWebcamBtn');
  const stopWebcamBtn = document.getElementById('stopWebcamBtn');
  const globalDrop = document.getElementById('globalDrop');
  let activeObjectUrl = null;
  let activeVideo = null;
  let activeStream = null;
  let mediaBusy = false;

  function syncMediaButtons() {
    const live = !!activeStream;
    useWebcamBtn.disabled = mediaBusy || live;
    stopWebcamBtn.style.display = live ? 'inline-flex' : 'none';
    stopWebcamBtn.disabled = mediaBusy || !live;
  }

  function resetPreview() {
    prevImg.style.display = 'none';
    prevVideo.style.display = 'none';
    prevImg.removeAttribute('src');
    prevVideo.pause();
    if (prevVideo.srcObject) prevVideo.srcObject = null;
    prevVideo.removeAttribute('src');
    prevVideo.load();
  }

  function clearMediaResources() {
    if (activeVideo) {
      activeVideo.pause();
      if (activeVideo.srcObject) activeVideo.srcObject = null;
      activeVideo.removeAttribute('src');
      try { activeVideo.load(); } catch (_) {}
      activeVideo = null;
    }
    if (activeStream) {
      activeStream.getTracks().forEach(t => t.stop());
      activeStream = null;
    }
    if (activeObjectUrl) {
      URL.revokeObjectURL(activeObjectUrl);
      activeObjectUrl = null;
    }
    syncMediaButtons();
  }

  async function requestFaceTimeStream() {
    const baseConstraints = {
      audio: false,
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 60 },
      },
    };

    let stream = await navigator.mediaDevices.getUserMedia(baseConstraints);
    const t = stream.getVideoTracks()[0];
    if (t && /facetime/i.test(t.label)) return stream;

    if (!navigator.mediaDevices.enumerateDevices) return stream;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const facetimeCam = devices.find(
      d => d.kind === 'videoinput' && /facetime/i.test(d.label),
    );
    if (!facetimeCam) return stream;

    try {
      const ftStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: { exact: facetimeCam.deviceId },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30, max: 60 },
        },
      });
      stream.getTracks().forEach(track => track.stop());
      stream = ftStream;
    } catch (_) {
      // Keep the default stream if exact FaceTime selection fails.
    }

    return stream;
  }

  async function startWebcamTexture() {
    if (mediaBusy) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Camera access is not available in this browser.');
      return;
    }

    mediaBusy = true;
    syncMediaButtons();
    try {
      clearMediaResources();
      resetPreview();

      const stream = await requestFaceTimeStream();
      activeStream = stream;

      const liveVideo = document.createElement('video');
      liveVideo.muted = true;
      liveVideo.loop = true;
      liveVideo.playsInline = true;
      liveVideo.autoplay = true;
      liveVideo.srcObject = stream;
      await liveVideo.play().catch(() => {});
      activeVideo = liveVideo;
      loadTexture(liveVideo, { isVideo: true });

      prevVideo.srcObject = stream;
      prevVideo.muted = true;
      prevVideo.loop = true;
      prevVideo.playsInline = true;
      prevVideo.style.display = 'block';
      prevImg.style.display = 'none';
      prevVideo.play().catch(() => {});
      setPreviewVisible();
    } catch (err) {
      console.error(err);
      clearMediaResources();
      resetPreview();
      alert('Could not access camera. Check browser permission settings.');
    } finally {
      mediaBusy = false;
      syncMediaButtons();
    }
  }

  function isSupportedFile(file) {
    return !!file && (
      file.type.startsWith('image/')
      || file.type.startsWith('video/')
    );
  }

  function setPreviewVisible() {
    texPrev.style.display = 'block';
    dropzone.style.display = 'none';
  }

  function handleImage(file) {
    const url = URL.createObjectURL(file);
    clearMediaResources();
    resetPreview();
    activeObjectUrl = url;

    const img = new Image();
    img.onload = () => {
      loadTexture(img, { isVideo: false });
      prevImg.src = url;
      prevImg.style.display = 'block';
      prevVideo.style.display = 'none';
      setPreviewVisible();
    };
    img.onerror = () => {
      clearMediaResources();
      resetPreview();
    };
    img.src = url;
  }

  function handleVideo(file) {
    const url = URL.createObjectURL(file);
    clearMediaResources();
    resetPreview();
    activeObjectUrl = url;

    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';

    video.addEventListener('loadeddata', () => {
      activeVideo = video;
      loadTexture(video, { isVideo: true });
      video.play().catch(() => {});

      prevVideo.src = url;
      prevVideo.muted = true;
      prevVideo.loop = true;
      prevVideo.playsInline = true;
      prevVideo.style.display = 'block';
      prevImg.style.display = 'none';
      prevVideo.play().catch(() => {});

      setPreviewVisible();
    }, { once: true });

    video.addEventListener('error', () => {
      clearMediaResources();
      resetPreview();
    }, { once: true });

    video.src = url;
    video.load();
  }

  function handleFile(file) {
    if (!isSupportedFile(file)) return;
    if (file.type.startsWith('image/')) {
      handleImage(file);
      return;
    }
    handleVideo(file);
  }

  function loadDefaultDemoTexture() {
    removeTexture();
    clearMediaResources();
    resetPreview();

    const img = new Image();
    img.onload = () => {
      loadTexture(img, { isVideo: false });
      prevImg.src = img.src;
      prevImg.style.display = 'block';
      prevVideo.style.display = 'none';
      setPreviewVisible();
      fileInput.value = '';
    };
    img.onerror = () => {
      texPrev.style.display = 'none';
      dropzone.style.display = 'block';
      fileInput.value = '';
    };
    img.src = DEFAULT_TEXTURE_PATH;
  }

  fileInput.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });
  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', e => { e.preventDefault(); dropzone.classList.remove('dragover'); handleFile(e.dataTransfer.files[0]); });
  useWebcamBtn.addEventListener('click', () => { startWebcamTexture(); });
  stopWebcamBtn.addEventListener('click', () => {
    removeTexture();
    clearMediaResources();
    resetPreview();
    texPrev.style.display = 'none';
    dropzone.style.display = 'block';
    fileInput.value = '';
  });
  syncMediaButtons();

  document.getElementById('removeTexture').addEventListener('click', () => {
    removeTexture();
    clearMediaResources();
    resetPreview();
    texPrev.style.display = 'none';
    dropzone.style.display = 'block';
    fileInput.value = '';
  });

  // Global drop overlay
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
    if (isSupportedFile(e.dataTransfer.files[0])) handleFile(e.dataTransfer.files[0]);
  });

  function applyCurrentViewMode() {
    if (state.viewMode === 'fullscreen') enterFullscreen();
    else if (state.viewMode === 'pinned') enterPinned();
    else if (state.viewMode === 'free') enterFree();
    else if (state.viewMode === 'crowd') enterCrowd();
    else enterStadium();
  }

  // Reset
  document.getElementById('resetBtn').addEventListener('click', () => {
    applyTallPolePreset();
    SIM.flagColor = [0.91, 0.90, 0.89];
    colorIn.value = '#e8e6e3';
    themeBg.dark = [0.039, 0.039, 0.043];
    themeBg.light = [0.95, 0.94, 0.92];
    applyThemeBg(state.theme);
    customPins.length = 0;
    renderPinMap();

    initCloth();
    applyCurrentViewMode();
    loadDefaultDemoTexture();
    applyPins();
  });
  document.getElementById('presetTallPoleBtn').addEventListener('click', () => {
    applyTallPolePreset();
    applyCurrentViewMode();
    applyPins();
  });

  // View mode toggle
  document.getElementById('viewFullscreen').addEventListener('click', () => {
    enterFullscreen();
    syncPinUI();
    applyPins();
  });
  document.getElementById('viewPinned').addEventListener('click', () => {
    enterPinned();
    syncPinUI();
    applyPins();
  });
  document.getElementById('viewFree').addEventListener('click', () => {
    enterFree();
    syncPinUI();
    applyPins();
  });
  document.getElementById('viewStadium').addEventListener('click', () => {
    enterStadium();
    syncPinUI();
    applyPins();
  });
  document.getElementById('viewCrowd').addEventListener('click', () => {
    enterCrowd();
    syncPinUI();
    applyPins();
  });

  // Theme toggle
  document.getElementById('themeDark').addEventListener('click', () => {
    state.theme = 'dark';
    document.documentElement.classList.remove('light-mode');
    document.getElementById('themeDark').classList.add('active');
    document.getElementById('themeLight').classList.remove('active');
    applyThemeBg('dark');
  });
  document.getElementById('themeLight').addEventListener('click', () => {
    state.theme = 'light';
    document.documentElement.classList.add('light-mode');
    document.getElementById('themeLight').classList.add('active');
    document.getElementById('themeDark').classList.remove('active');
    applyThemeBg('light');
  });

  // Initialize default mode
  loadDefaultDemoTexture();
  applyThemeBg(state.theme);
  enterFullscreen();
  applyPins();
}
