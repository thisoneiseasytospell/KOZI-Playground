import { SIM, flagW, flagH, state } from './config.js';

let canvas = null;

export const cam = {
  tgtTheta: 0.0, tgtPhi: 0.0, tgtDist: 2.7,
  curTheta: 0.0, curPhi: 0.0, curDist: 2.7,
  target: [flagW * 0.5, 0, 0],
  tgtPan: [0, 0, 0],
};

let orbiting = false;
let panning = false;
let lastM = [0, 0];
let touchMode = 'none';
let touchCenter = [0, 0];
let touchDist = 0;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const cameraEnabled = () => (
  state.viewMode === 'stadium'
  || state.viewMode === 'crowd'
  || state.viewMode === 'fullscreen'
  || state.viewMode === 'pinned'
  || state.viewMode === 'free'
);

export function eyePos() {
  return [
    cam.target[0] + cam.curDist * Math.cos(cam.curPhi) * Math.sin(cam.curTheta),
    cam.target[1] + cam.curDist * Math.sin(cam.curPhi),
    cam.target[2] + cam.curDist * Math.cos(cam.curPhi) * Math.cos(cam.curTheta),
  ];
}

function clampPan() {
  if (state.viewMode === 'fullscreen' || state.viewMode === 'pinned' || state.viewMode === 'free') {
    const panMul = state.viewMode === 'pinned' ? 1.25 : (state.viewMode === 'free' ? 1.45 : 1.8);
    cam.tgtPan[0] = clamp(cam.tgtPan[0], -flagW * panMul, flagW * panMul);
    cam.tgtPan[1] = clamp(cam.tgtPan[1], -flagH * 1.2, flagH * 1.2);
    cam.tgtPan[2] = clamp(cam.tgtPan[2], -flagW * panMul, flagW * panMul);
    return;
  }
  if (state.viewMode !== 'stadium' && state.viewMode !== 'crowd') {
    cam.tgtPan[0] = 0;
    cam.tgtPan[1] = 0;
    cam.tgtPan[2] = 0;
    return;
  }
  if (state.viewMode === 'stadium') {
    cam.tgtPan[0] = clamp(cam.tgtPan[0], -flagW * 1.4, flagW * 1.4);
    cam.tgtPan[1] = clamp(cam.tgtPan[1], -flagH * 1.15, flagH * 1.15);
    cam.tgtPan[2] = clamp(cam.tgtPan[2], -flagW * 1.2, flagW * 1.2);
    return;
  }
  cam.tgtPan[0] = clamp(cam.tgtPan[0], -flagW * 1.05, flagW * 1.05);
  cam.tgtPan[1] = clamp(cam.tgtPan[1], -flagH * 0.95, flagH * 0.95);
  cam.tgtPan[2] = clamp(cam.tgtPan[2], -flagW * 0.95, flagW * 0.95);
}

function panBy(dx, dy, scale = 1.0) {
  if (!cameraEnabled()) return;

  const e = eyePos();
  let fx = cam.target[0] - e[0];
  let fy = cam.target[1] - e[1];
  let fz = cam.target[2] - e[2];
  const fLen = Math.hypot(fx, fy, fz);
  if (fLen < 1e-6) return;
  fx /= fLen;
  fy /= fLen;
  fz /= fLen;

  // Right axis from world-up x forward. Falls back if camera looks straight up/down.
  let rx = fz;
  let ry = 0;
  let rz = -fx;
  let rLen = Math.hypot(rx, ry, rz);
  if (rLen < 1e-5) {
    rx = 1;
    ry = 0;
    rz = 0;
    rLen = 1;
  }
  rx /= rLen;
  ry /= rLen;
  rz /= rLen;

  // Camera up axis.
  const ux = fy * rz - fz * ry;
  const uy = fz * rx - fx * rz;
  const uz = fx * ry - fy * rx;

  const panScale = cam.tgtDist * 0.0017 * scale;
  cam.tgtPan[0] += (dx * rx - dy * ux) * panScale;
  cam.tgtPan[1] += (dx * ry - dy * uy) * panScale;
  cam.tgtPan[2] += (dx * rz - dy * uz) * panScale;
  clampPan();
}

function zoomBy(delta, speed = 0.0032) {
  if (state.viewMode === 'fullscreen' || state.viewMode === 'pinned' || state.viewMode === 'free') {
    SIM.zoom = clamp(SIM.zoom * Math.exp(delta * speed * 0.42), 8, 320);
    return;
  }
  cam.tgtDist = clamp(cam.tgtDist * Math.exp(delta * speed), 0.55, 18);
}

function touchInfo(t0, t1) {
  const cx = (t0.clientX + t1.clientX) * 0.5;
  const cy = (t0.clientY + t1.clientY) * 0.5;
  const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
  return { cx, cy, dist };
}

export function updateCamera(dt) {
  const cf = 1 - Math.pow(0.01, dt);

  let baseX = 0;
  let baseY = 0;
  let baseZ = 0;

  if (state.viewMode === 'fullscreen' || state.viewMode === 'pinned' || state.viewMode === 'free') {
    const pinnedMode = state.viewMode === 'pinned';
    const freeMode = state.viewMode === 'free';
    const aspect = Math.max(canvas.width / Math.max(canvas.height, 1), 0.25);
    const fov = Math.PI / 4.5;
    const halfTan = Math.tan(fov / 2);
    const cornersMode = pinnedMode || state.pinMode === 'corners';
    // Centered close framing by default. Corners mode keeps near-full-frame sheet without stretching.
    const fitHalfH = pinnedMode
      ? flagH * 0.66
      : (freeMode ? flagH * 0.62 : (cornersMode ? flagH * 0.58 : flagH * 0.70));
    const fitHalfW = pinnedMode ? flagW * 0.64 : (freeMode ? flagW * 0.60 : flagW * 0.55);
    const fitHalf = Math.max(fitHalfH, fitHalfW / aspect);
    const zoomFactor = Math.max(0.10, Math.min(3.2, SIM.zoom / 100));
    cam.tgtDist = clamp((fitHalf / halfTan) * (pinnedMode ? 1.18 : (freeMode ? 1.10 : 1.03)) * zoomFactor, 0.45, 16.0);
    baseX = flagW * 0.50;
    baseY = pinnedMode ? 0 : (freeMode ? -flagH * 0.02 : (cornersMode ? -flagH * 0.03 : -flagH * 0.10));
    baseZ = 0;
  } else if (state.viewMode === 'stadium') {
    cam.tgtDist = clamp(cam.tgtDist, 2.2, 14.0);
    baseX = flagW * 0.50;
    baseY = 0;
    baseZ = 0;
  } else if (state.viewMode === 'crowd') {
    cam.tgtDist = clamp(cam.tgtDist, 2.2, 14.0);
    baseX = flagW * 0.50;
    baseY = -flagH * 0.07;
    baseZ = 0.03;
  }

  clampPan();
  const tgtX = baseX + cam.tgtPan[0];
  const tgtY = baseY + cam.tgtPan[1];
  const tgtZ = baseZ + cam.tgtPan[2];
  cam.target[0] += (tgtX - cam.target[0]) * cf;
  cam.target[1] += (tgtY - cam.target[1]) * cf;
  cam.target[2] += (tgtZ - cam.target[2]) * cf;
  cam.tgtPhi = clamp(cam.tgtPhi, -1.45, 1.45);

  const lf = 1 - Math.pow(0.0004, dt);
  cam.curTheta += (cam.tgtTheta - cam.curTheta) * lf;
  cam.curPhi += (cam.tgtPhi - cam.curPhi) * lf;
  cam.curDist += (cam.tgtDist - cam.curDist) * lf;
}

export function setupCameraControls(canvasEl) {
  canvas = canvasEl;
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  canvas.addEventListener('mousedown', e => {
    if (!cameraEnabled()) return;

    if (e.button === 0 && !(e.altKey || e.shiftKey) && state.viewMode !== 'free') {
      orbiting = true;
      lastM = [e.clientX, e.clientY];
    } else if (e.button === 1 || e.button === 2 || (e.button === 0 && (e.altKey || e.shiftKey))) {
      panning = true;
      lastM = [e.clientX, e.clientY];
    } else {
      return;
    }
    e.preventDefault();
  });

  window.addEventListener('mouseup', () => {
    orbiting = false;
    panning = false;
  });

  window.addEventListener('mousemove', e => {
    const dx = e.clientX - lastM[0], dy = e.clientY - lastM[1];
    if (!cameraEnabled() || (!orbiting && !panning)) return;

    if (orbiting) {
      cam.tgtTheta -= dx * 0.0062;
      cam.tgtPhi = clamp(cam.tgtPhi + dy * 0.0052, -1.45, 1.45);
    } else if (panning) {
      panBy(dx, dy, 1.35);
    }

    lastM = [e.clientX, e.clientY];
  });

  canvas.addEventListener('wheel', e => {
    if (!cameraEnabled()) return;
    e.preventDefault();
    const speed = (e.ctrlKey || e.altKey || e.metaKey) ? 0.0032 : 0.0017;
    zoomBy(e.deltaY, speed);
  }, { passive: false });

  // Touch controls
  canvas.addEventListener('touchstart', e => {
    if (!cameraEnabled()) return;

    if (e.touches.length === 1) {
      if (state.viewMode === 'free') {
        touchMode = 'none';
        return;
      }
      touchMode = 'orbit';
      lastM = [e.touches[0].clientX, e.touches[0].clientY];
    } else if (e.touches.length >= 2) {
      touchMode = 'panzoom';
      const info = touchInfo(e.touches[0], e.touches[1]);
      touchCenter = [info.cx, info.cy];
      touchDist = info.dist;
    }
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    if (!cameraEnabled()) return;
    if (state.viewMode === 'free' && e.touches.length === 1) return;
    if (touchMode === 'orbit' && e.touches.length === 1) {
      const dx = e.touches[0].clientX - lastM[0];
      const dy = e.touches[0].clientY - lastM[1];
      cam.tgtTheta -= dx * 0.006;
      cam.tgtPhi = clamp(cam.tgtPhi + dy * 0.005, -1.45, 1.45);
      lastM = [e.touches[0].clientX, e.touches[0].clientY];
      e.preventDefault();
      return;
    }

    if (touchMode === 'panzoom' && e.touches.length >= 2) {
      const info = touchInfo(e.touches[0], e.touches[1]);
      panBy(info.cx - touchCenter[0], info.cy - touchCenter[1], 1.35);
      zoomBy(touchDist - info.dist, 0.0048);
      touchCenter = [info.cx, info.cy];
      touchDist = info.dist;
      e.preventDefault();
    }
  });

  canvas.addEventListener('touchend', e => {
    if (e.touches.length === 0) {
      touchMode = 'none';
    } else if (e.touches.length === 1) {
      touchMode = 'orbit';
      lastM = [e.touches[0].clientX, e.touches[0].clientY];
    }
  });

  canvas.addEventListener('dblclick', () => {
    if (!cameraEnabled()) return;
    if (state.viewMode === 'fullscreen') {
      cam.tgtTheta = 0.0;
      cam.tgtPhi = 0.0;
      SIM.zoom = 76;
    } else if (state.viewMode === 'pinned') {
      cam.tgtTheta = 0.0;
      cam.curTheta = 0.0;
      cam.tgtPhi = 0.0;
      cam.curPhi = 0.0;
      SIM.zoom = 92;
    } else if (state.viewMode === 'stadium') {
      cam.tgtTheta = -0.32;
      cam.curTheta = -0.32;
      cam.tgtPhi = 0.18;
      cam.curPhi = 0.18;
      cam.tgtDist = 7.6;
      cam.curDist = 7.6;
    } else if (state.viewMode === 'crowd') {
      cam.tgtTheta = -0.58;
      cam.curTheta = -0.58;
      cam.tgtPhi = 0.20;
      cam.curPhi = 0.20;
      cam.tgtDist = 5.9;
      cam.curDist = 5.9;
    } else if (state.viewMode === 'free') {
      cam.tgtTheta = 0.0;
      cam.curTheta = 0.0;
      cam.tgtPhi = 0.0;
      cam.curPhi = 0.0;
      SIM.zoom = 82;
    }
    cam.tgtPan[0] = 0;
    cam.tgtPan[1] = 0;
    cam.tgtPan[2] = 0;
  });
}
