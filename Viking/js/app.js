// Viking FK — heavy satin flag on a flexible pole.
// Render thread: three.js shading (PBR + sheen + anisotropy + env + shadows), UI, and the
// bicubic render surface. The cloth itself runs in a Web Worker (sim.js).

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/RoomEnvironment.js';
import { ART } from './viking-art.js';
import { FLAG_W, FLAG_H, COLS, ROWS, SUBDIV, NOTCH, BORDER, POLE_LEN, POLE_BASE_Y, HOIST_TOP, HOIST_OFF, WAVE, MODES, RIG } from './config.js';

const TEX_W = 2048;
let mode = 'mast';
let flagText = '';        // typed text; empty falls back to the STAVANGER wordmark

// Viking FK set their wordmark, headlines and merch in Brothers (John Downer, via Adobe
// Fonts) — activate it and the flag picks it up. The rest of the stack is the fallback.
const TEXT_FONT = '"Brothers", "Big Shoulders Display", "Helvetica Neue", Helvetica, Arial, sans-serif';

// ─── Designs ─────────────────────────────────────────────────
const DESIGNS = [
  { name: 'Rød',    field: '#72121C', ink: '#DBC067' },
  { name: 'Marine', field: '#132436', ink: '#DBC067' },
  { name: 'Gull',   field: '#DBC067', ink: '#132436' },
  { name: 'Rosa',   field: '#E51D9B', ink: '#111111' },
];

// ─── Flag face texture ───────────────────────────────────────
function insetPolygon(pts, b) {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) { const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % n]; area += x0 * y1 - x1 * y0; }
  const sgn = area > 0 ? 1 : -1;
  const lines = pts.map((p, i) => {
    const q = pts[(i + 1) % n];
    const dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy);
    const nx = (-dy / len) * sgn, ny = (dx / len) * sgn;
    return { px: p[0] + nx * b, py: p[1] + ny * b, dx, dy };
  });
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = lines[(i - 1 + n) % n], c = lines[i];
    const den = a.dx * c.dy - a.dy * c.dx;
    if (Math.abs(den) < 1e-9) { out.push([c.px, c.py]); continue; }
    const t = ((c.px - a.px) * c.dy - (c.py - a.py) * c.dx) / den;
    out.push([a.px + a.dx * t, a.py + a.dy * t]);
  }
  return out;
}

function fillPoly(g, pts, color) {
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
  g.closePath();
  g.fillStyle = color;
  g.fill();
}

function drawGroup(g, paths, box, cx, cy, h, color) {
  const s = h / box.h;
  g.save();
  g.translate(cx, cy);
  g.scale(s, s);
  g.translate(-(box.x + box.w / 2), -(box.y + box.h / 2));
  g.fillStyle = color;
  for (const d of paths) g.fill(new Path2D(d));
  g.restore();
}

function unionBox(boxes) {
  const x0 = Math.min(...boxes.map(b => b.x)), y0 = Math.min(...boxes.map(b => b.y));
  const x1 = Math.max(...boxes.map(b => b.x + b.w)), y1 = Math.max(...boxes.map(b => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function setupTexture(tex, srgb = true) {
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

// Typed text takes the STAVANGER band: same place, same height, scaled to the width the
// wordmark would have occupied.
function drawText(g, text, cx, cy, capH, maxW, color) {
  const t = text.toUpperCase();
  let size = capH / 0.72;                        // cap height is ~0.72em across the stack
  const setFont = () => {
    g.font = `700 ${size.toFixed(1)}px ${TEXT_FONT}`;
    if ('letterSpacing' in g) g.letterSpacing = (size * 0.05).toFixed(1) + 'px';
  };
  g.save();
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  setFont();
  const w = g.measureText(t).width;
  if (w > maxW) { size *= maxW / w; setFont(); }
  g.fillText(t, cx, cy);
  g.restore();
}

const faceCanvas = [], faceText = [];
function paintFace(c, design) {
  const W = c.width, H = c.height;
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);

  const notch = NOTCH * W, b = BORDER * H;
  const outer = [[0, 0], [W, 0], [W - notch, H / 2], [W, H], [0, H]];
  const inner = insetPolygon(outer, b);
  fillPoly(g, outer, design.ink);
  fillPoly(g, inner, design.field);

  drawGroup(g, ART.crest.d, ART.crest.box, 0.45 * W, 0.55 * H, 0.46 * H, design.ink);
  drawGroup(g, ART.viking.d, ART.viking.box, 0.47 * W, 0.19 * H, 0.13 * H, design.ink);
  const sb = ART.stavanger.box, bandH = 0.068 * H;
  if (flagText) drawText(g, flagText, 0.44 * W, 0.865 * H, bandH, bandH * sb.w / sb.h, design.ink);
  else drawGroup(g, ART.stavanger.d, sb, 0.44 * W, 0.865 * H, bandH, design.ink);
  const d = ART.digits;
  drawGroup(g, d.d.slice(0, 2), unionBox(d.each.slice(0, 2)), 0.215 * W, 0.56 * H, 0.075 * H, design.ink);
  drawGroup(g, d.d.slice(2, 4), unionBox(d.each.slice(2, 4)), 0.675 * W, 0.56 * H, 0.075 * H, design.ink);
}

function buildFace(design, i) {
  const c = document.createElement('canvas');
  c.width = TEX_W; c.height = Math.round(TEX_W * FLAG_H / FLAG_W);
  faceCanvas[i] = c;
  paintFace(c, design);
  faceText[i] = flagText;
  return setupTexture(new THREE.CanvasTexture(c));
}
// Only the design on screen is repainted as you type; the others catch up when switched to.
function refreshFace(i) {
  if (faceText[i] === flagText) return;
  paintFace(faceCanvas[i], DESIGNS[i]);
  faceText[i] = flagText;
  textures[i].needsUpdate = true;
}

// Static crease normal map: a few soft packaging folds plus low-frequency cloth unevenness.
function buildCreaseMap() {
  const W = 1024, H = Math.round(W * FLAG_H / FLAG_W);
  const h = new Float32Array(W * H);
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const folds = [];
  for (let i = 0; i < 7; i++) {
    const vertical = i % 2 === 0;
    const ang = (vertical ? Math.PI / 2 : 0) + (rnd() - 0.5) * 0.25;
    folds.push({ x: rnd() * W, y: rnd() * H, nx: Math.cos(ang), ny: Math.sin(ang), w: 6 + rnd() * 14, a: (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.5) });
  }
  const P = 64, grid = new Float32Array(P * P);
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const g00 = grid[((yi % P) * P + (xi % P))], g10 = grid[((yi % P) * P + ((xi + 1) % P))];
    const g01 = grid[(((yi + 1) % P) * P + (xi % P))], g11 = grid[(((yi + 1) % P) * P + ((xi + 1) % P))];
    return (g00 * (1 - sx) + g10 * sx) * (1 - sy) + (g01 * (1 - sx) + g11 * sx) * sy;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 0;
    for (const f of folds) {
      const dd = (x - f.x) * f.nx + (y - f.y) * f.ny;
      const t = dd / f.w;
      v += f.a * Math.exp(-t * t) * 0.35;
    }
    v += (noise(x / 140, y / 140) - 0.5) * 0.6 + (noise(x / 38 + 9, y / 38 + 5) - 0.5) * 0.25;
    h[y * W + x] = v;
  }
  // Height → tangent-space normal. Tangent = +u (canvas +x), bitangent = +v (canvas −y).
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const img = g.createImageData(W, H);
  const S = 14.0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const xl = h[y * W + Math.max(x - 1, 0)], xr = h[y * W + Math.min(x + 1, W - 1)];
    const yu = h[Math.max(y - 1, 0) * W + x], yd = h[Math.min(y + 1, H - 1) * W + x];
    const dhdx = (xr - xl) * 0.5 * S, dhdy = (yd - yu) * 0.5 * S;
    let nx = -dhdx, ny = dhdy, nz = 1;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx /= len; ny /= len; nz /= len;
    const o = (y * W + x) * 4;
    img.data[o] = Math.round((nx * 0.5 + 0.5) * 255);
    img.data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
    img.data[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return setupTexture(new THREE.CanvasTexture(c), false);
}

// ─── Renderer / scene ────────────────────────────────────────
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(0x050505, 1);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050505);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;
pmrem.dispose();

const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 100);

const key = new THREE.DirectionalLight(0xfff1dc, 3.4);
key.position.set(-4.0, 5.0, 6.5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -7.5; key.shadow.camera.right = 7.5;
key.shadow.camera.top = 6;     key.shadow.camera.bottom = -6;
key.shadow.camera.near = 1;    key.shadow.camera.far = 30;
key.shadow.bias = -0.0003;
key.shadow.normalBias = 0.015;
scene.add(key);
scene.add(key.target);

const fill = new THREE.DirectionalLight(0xffe6cc, 0.28);
fill.position.set(4, -1, -3);
scene.add(fill);

const rim = new THREE.DirectionalLight(0xffffff, 0.45);
rim.position.set(2.5, 3, -6);
scene.add(rim);

// ─── Pole mesh (bent each frame from the worker's rig state) ─
const pole = new THREE.Group();
const poleMat = new THREE.MeshStandardMaterial({ color: 0x26262a, metalness: 0.9, roughness: 0.34 });
const shaftGeo = new THREE.CylinderGeometry(0.042, 0.055, POLE_LEN, 40, 48);
shaftGeo.translate(0, POLE_LEN / 2, 0);
const shaftRest = shaftGeo.attributes.position.array.slice();
const shaft = new THREE.Mesh(shaftGeo, poleMat);
shaft.castShadow = true;
shaft.frustumCulled = false;
pole.add(shaft);
const goldMat = new THREE.MeshStandardMaterial({ color: 0xdbc067, metalness: 1.0, roughness: 0.3 });
const finial = new THREE.Mesh(new THREE.SphereGeometry(0.1, 32, 24), goldMat);
finial.castShadow = true;
pole.add(finial);
const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.06, 24), goldMat);
pole.add(collar);

// Two clips hold the hoist to the pole's surface (not its axis) — when the pole twists these
// swing around it, which is what rolls the flag over and shows its back.
const clips = [HOIST_TOP, HOIST_TOP - FLAG_H].map((s) => {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.058, 0.009, 10, 28), goldMat);
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  const lug = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.07, 12), goldMat);
  lug.position.x = HOIST_OFF;
  lug.castShadow = true;
  g.add(lug);
  g.userData.s = s;
  pole.add(g);
  return g;
});
scene.add(pole);

const rigState = new Float32Array(RIG.SIZE);
rigState.set([0, 1, 0], RIG.DIR); rigState.set([1, 0, 0], RIG.XAXIS); rigState.set([0, 0, 1], RIG.ZAXIS);
rigState.set([0, POLE_BASE_Y, 0], RIG.BASE);
const _dir = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const bendAt = (s) => { const k = s / POLE_LEN; return k * k; };
function updatePoleMesh() {
  const sx = rigState[RIG.SWAY], sz = rigState[RIG.SWAY + 1];
  pole.position.set(rigState[RIG.BASE], rigState[RIG.BASE + 1], rigState[RIG.BASE + 2]);
  _dir.set(rigState[RIG.DIR], rigState[RIG.DIR + 1], rigState[RIG.DIR + 2]);
  pole.quaternion.setFromUnitVectors(_up, _dir);
  const arr = shaftGeo.attributes.position.array;
  for (let i = 0; i < arr.length; i += 3) {
    const y = shaftRest[i + 1], k = bendAt(y);
    arr[i] = shaftRest[i] + sx * k;
    arr[i + 2] = shaftRest[i + 2] + sz * k;
  }
  shaftGeo.attributes.position.needsUpdate = true;
  finial.position.set(sx, POLE_LEN + 0.09, sz);
  const kc = bendAt(POLE_LEN - 0.03);
  collar.position.set(sx * kc, POLE_LEN - 0.03, sz * kc);
  // Same frame as the sim's anchor(): local +X is the rig's xAxis, so a hoist at angle
  // `twist` sits at (cos, sin) · HOIST_OFF — a -twist spin about local Y puts the lug there.
  const tw = rigState[RIG.TWIST];
  for (const g of clips) {
    const s = g.userData.s, k = bendAt(s);
    g.position.set(sx * k, s, sz * k);
    g.rotation.y = -tw;
  }
}

// ─── Sim worker ──────────────────────────────────────────────
const N = COLS * ROWS;
const pos = new Float32Array(N * 3);
let haveFrame = false, gustPeakPending = false;
const worker = new Worker(new URL('./sim.js', import.meta.url), { type: 'module' });
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type !== 'frame') return;
  pos.set(new Float32Array(m.buf));
  rigState.set(m.rig);
  worker.postMessage({ type: 'buf', buf: m.buf }, [m.buf]);
  if (m.gustPeak) gustPeakPending = true;
  haveFrame = true;
};
worker.onerror = (e) => console.error('sim worker:', e.message || e);

// ─── Render surface: bicubic-subdivided sim grid ─────────────
const RC = (COLS - 1) * SUBDIV + 1, RR = (ROWS - 1) * SUBDIV + 1, RN = RC * RR;
const rPos = new Float32Array(RN * 3), rNrm = new Float32Array(RN * 3), rTan = new Float32Array(RN * 4);
const rowPass = new Float32Array(ROWS * RC * 3);
const CR = [];
for (let s = 0; s < SUBDIV; s++) {
  const f = s / SUBDIV;
  CR.push([-0.5 * f + f * f - 0.5 * f * f * f, 1 - 2.5 * f * f + 1.5 * f * f * f, 0.5 * f + 2 * f * f - 1.5 * f * f * f, -0.5 * f * f + 0.5 * f * f * f]);
}
function buildRenderSurface() {
  for (let iy = 0; iy < ROWS; iy++) {
    const rowBase = iy * COLS;
    for (let rx = 0; rx < RC; rx++) {
      const ix = (rx / SUBDIV) | 0, s = rx - ix * SUBDIV, o = (iy * RC + rx) * 3;
      if (s === 0) {
        const i = (rowBase + ix) * 3;
        rowPass[o] = pos[i]; rowPass[o + 1] = pos[i + 1]; rowPass[o + 2] = pos[i + 2];
      } else {
        const wgt = CR[s];
        const i0 = (rowBase + Math.max(ix - 1, 0)) * 3, i1 = (rowBase + ix) * 3;
        const i2 = (rowBase + Math.min(ix + 1, COLS - 1)) * 3, i3 = (rowBase + Math.min(ix + 2, COLS - 1)) * 3;
        for (let k = 0; k < 3; k++) rowPass[o + k] = wgt[0] * pos[i0 + k] + wgt[1] * pos[i1 + k] + wgt[2] * pos[i2 + k] + wgt[3] * pos[i3 + k];
      }
    }
  }
  for (let ry = 0; ry < RR; ry++) {
    const iy = (ry / SUBDIV) | 0, s = ry - iy * SUBDIV;
    const r0 = Math.max(iy - 1, 0) * RC, r1 = iy * RC, r2 = Math.min(iy + 1, ROWS - 1) * RC, r3 = Math.min(iy + 2, ROWS - 1) * RC;
    const wgt = CR[s];
    for (let rx = 0; rx < RC; rx++) {
      const o = (ry * RC + rx) * 3;
      if (s === 0) {
        const i = (r1 + rx) * 3;
        rPos[o] = rowPass[i]; rPos[o + 1] = rowPass[i + 1]; rPos[o + 2] = rowPass[i + 2];
      } else {
        const i0 = (r0 + rx) * 3, i1 = (r1 + rx) * 3, i2 = (r2 + rx) * 3, i3 = (r3 + rx) * 3;
        for (let k = 0; k < 3; k++) rPos[o + k] = wgt[0] * rowPass[i0 + k] + wgt[1] * rowPass[i1 + k] + wgt[2] * rowPass[i2 + k] + wgt[3] * rowPass[i3 + k];
      }
    }
  }
  for (let ry = 0; ry < RR; ry++) for (let rx = 0; rx < RC; rx++) {
    const o = (ry * RC + rx) * 3;
    const l = (ry * RC + Math.max(rx - 1, 0)) * 3, r = (ry * RC + Math.min(rx + 1, RC - 1)) * 3;
    const u = (Math.max(ry - 1, 0) * RC + rx) * 3, d = (Math.min(ry + 1, RR - 1) * RC + rx) * 3;
    const tx = rPos[r] - rPos[l], ty = rPos[r + 1] - rPos[l + 1], tz = rPos[r + 2] - rPos[l + 2];
    const bx = rPos[d] - rPos[u], by = rPos[d + 1] - rPos[u + 1], bz = rPos[d + 2] - rPos[u + 2];
    let nx = by * tz - bz * ty, ny = bz * tx - bx * tz, nz = bx * ty - by * tx;
    let len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    rNrm[o] = nx / len; rNrm[o + 1] = ny / len; rNrm[o + 2] = nz / len;
    len = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    const t4 = (ry * RC + rx) * 4;
    rTan[t4] = tx / len; rTan[t4 + 1] = ty / len; rTan[t4 + 2] = tz / len; rTan[t4 + 3] = 1;
  }
}

const geo = new THREE.BufferGeometry();
{
  const uv = new Float32Array(RN * 2);
  for (let ry = 0; ry < RR; ry++) for (let rx = 0; rx < RC; rx++) {
    const o = (ry * RC + rx) * 2;
    uv[o] = rx / (RC - 1); uv[o + 1] = 1 - ry / (RR - 1);
  }
  const index = new Uint32Array((RC - 1) * (RR - 1) * 6);
  let k = 0;
  for (let ry = 0; ry < RR - 1; ry++) for (let rx = 0; rx < RC - 1; rx++) {
    const a = ry * RC + rx, b = (ry + 1) * RC + rx, c = (ry + 1) * RC + rx + 1, d = ry * RC + rx + 1;
    index[k++] = a; index[k++] = b; index[k++] = d;
    index[k++] = b; index[k++] = c; index[k++] = d;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(rPos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('normal', new THREE.BufferAttribute(rNrm, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('tangent', new THREE.BufferAttribute(rTan, 4).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
}
function uploadMesh() {
  buildRenderSurface();
  geo.attributes.position.needsUpdate = true;
  geo.attributes.normal.needsUpdate = true;
  geo.attributes.tangent.needsUpdate = true;
}

// ─── Flag material ───────────────────────────────────────────
const textures = DESIGNS.map(buildFace);
const creaseMap = buildCreaseMap();
let current = 0;
const uniforms = {
  uMap2: { value: textures[0] },
  uMix: { value: 0 },
  uBackTint: { value: 0.74 },
  uTransl: { value: 0.32 },
  uKeyDirView: { value: new THREE.Vector3(0, 0, 1) },
};

const flagMat = new THREE.MeshPhysicalMaterial({
  map: textures[0],
  normalMap: creaseMap,
  normalScale: new THREE.Vector2(0.55, 0.55),
  side: THREE.DoubleSide,
  roughness: 0.58,
  metalness: 0,
  sheen: 0.28,
  sheenRoughness: 0.8,
  sheenColor: new THREE.Color(0xfff0d8),
  anisotropy: 0.35,
  anisotropyRotation: Math.PI / 2,
  specularIntensity: 0.6,
  alphaTest: 0.5,
  shadowSide: THREE.DoubleSide,
});
flagMat.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, uniforms);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
      uniform sampler2D uMap2;
      uniform float uMix;
      uniform float uBackTint;
      uniform float uTransl;
      uniform vec3 uKeyDirView;`)
    .replace('#include <map_fragment>', `
      #ifdef USE_MAP
        vec4 tA = texture2D( map, vMapUv );
        vec4 tB = texture2D( uMap2, vMapUv );
        vec4 sampledDiffuseColor = mix( tA, tB, uMix );
        diffuseColor *= sampledDiffuseColor;
        if ( !gl_FrontFacing ) diffuseColor.rgb *= uBackTint;
      #endif`)
    .replace('#include <lights_fragment_end>', `
      #include <lights_fragment_end>
      reflectedLight.indirectDiffuse += diffuseColor.rgb * uTransl * max( 0.0, dot( -normal, uKeyDirView ) );`);
};
const flag = new THREE.Mesh(geo, flagMat);
flag.castShadow = true;
flag.receiveShadow = true;
flag.frustumCulled = false;
flag.visible = false;   // until the first sim frame arrives
flag.customDepthMaterial = new THREE.MeshDepthMaterial({
  depthPacking: THREE.RGBADepthPacking, map: textures[0], alphaTest: 0.5, side: THREE.DoubleSide,
});
scene.add(flag);

// ─── Design crossfade ────────────────────────────────────────
const fade = { active: false, t0: 0, dur: 0.75, to: 0 };
const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
function switchDesign(i, now) {
  i = (i + DESIGNS.length) % DESIGNS.length;
  if (i === current || fade.active) return;
  refreshFace(i);
  uniforms.uMap2.value = textures[i];
  uniforms.uMix.value = 0;
  fade.active = true; fade.t0 = now; fade.to = i;
  updateSwatches(i);
}
function updateFade(now) {
  if (!fade.active) return;
  const k = Math.min(1, (now - fade.t0) / fade.dur);
  uniforms.uMix.value = smooth(k);
  if (k >= 1) {
    current = fade.to;
    refreshFace(current);            // text may have changed while the crossfade ran
    flagMat.map = textures[current];
    uniforms.uMix.value = 0;
    fade.active = false;
  }
}

// ─── Camera framing ──────────────────────────────────────────
const camTarget = new THREE.Vector3();
const camBase = new THREE.Vector3();
const camGoal = { target: new THREE.Vector3(), base: new THREE.Vector3() };
const NEAR_PAD = 1.18;   // the roll swings the fly toward the lens; leave it room to grow
function frameCamera() {
  const aspect = window.innerWidth / window.innerHeight;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const topY = POLE_BASE_Y + HOIST_TOP;
  let needW, needH, tx, ty;
  if (mode === 'wall') {
    needW = FLAG_W * 1.35 + 0.8 + FLAG_W * 0.2; needH = FLAG_H * 1.9 + 0.6 + FLAG_W * 0.45;
    tx = Math.SQRT1_2 * HOIST_TOP + FLAG_W * 0.3; ty = POLE_BASE_Y + Math.SQRT1_2 * HOIST_TOP - FLAG_H * 0.62 - 0.45;
  } else if (mode === 'wave') {
    // The pole tips to atan(ampX) either side. Measured headless, the cloth stays inside the
    // tip sweep plus about a third of the fly — it trails rather than leading the tip.
    const tilt = Math.atan(WAVE.ampX);
    const highY = topY + 0.35;
    const lowY = POLE_BASE_Y + (HOIST_TOP - FLAG_H) * Math.cos(tilt) - FLAG_H * 0.62;
    needW = 2 * (HOIST_TOP * Math.sin(tilt) + FLAG_W * 0.32) * NEAR_PAD;
    needH = (highY - lowY) * NEAR_PAD;
    tx = 0; ty = (highY + lowY) / 2;
  } else {
    needW = FLAG_W * 1.35 + 0.8; needH = FLAG_H * 2.0 + 0.7;
    tx = FLAG_W * 0.42; ty = topY - FLAG_H * 0.72;
  }
  const dist = Math.max(needW / 2 / (tanH * aspect), needH / 2 / tanH);
  camGoal.target.set(tx, ty, 0);
  camGoal.base.set(tx + 0.3, ty - 0.55, dist);
  if (camTarget.lengthSq() === 0) { camTarget.copy(camGoal.target); camBase.copy(camGoal.base); }
}
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  frameCamera();
});
renderer.setSize(window.innerWidth, window.innerHeight);
frameCamera();

// ─── UI ──────────────────────────────────────────────────────
const swatchWrap = document.getElementById('swatches');
DESIGNS.forEach((d, i) => {
  const b = document.createElement('button');
  b.className = 'swatch' + (i === 0 ? ' active' : '');
  b.style.background = d.field;
  b.title = d.name;
  b.addEventListener('click', () => switchDesign(i, clock.elapsedTime));
  swatchWrap.appendChild(b);
});
function updateSwatches(i) {
  [...swatchWrap.children].forEach((el, k) => el.classList.toggle('active', k === i));
}
const modeWrap = document.getElementById('modes');
function setMode(m) {
  if (!MODES[m] || m === mode) return;
  mode = m;
  worker.postMessage({ type: 'mode', value: m });
  frameCamera();
  [...modeWrap.children].forEach(el => el.classList.toggle('active', el.dataset.mode === m));
}
Object.entries(MODES).forEach(([m, def]) => {
  const b = document.createElement('button');
  b.className = 'pill' + (m === mode ? ' active' : '');
  b.dataset.mode = m;
  b.textContent = def.label;
  b.addEventListener('click', () => setMode(m));
  modeWrap.appendChild(b);
});
const windEl = document.getElementById('wind'), windVal = document.getElementById('windVal');
windEl.addEventListener('input', () => {
  worker.postMessage({ type: 'wind', value: windEl.value / 100 });
  windVal.textContent = windEl.value;
});
worker.postMessage({ type: 'wind', value: windEl.value / 100 });
const textEl = document.getElementById('text');
let textTimer = 0;
textEl.addEventListener('input', () => {
  flagText = textEl.value.trim();
  clearTimeout(textTimer);
  textTimer = setTimeout(() => refreshFace(current), 160);   // repainting 2048px costs a beat
});
textEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') textEl.blur(); });

const cycleEl = document.getElementById('cycle');
const ui = document.getElementById('ui');

// ─── Gust charge ─────────────────────────────────────────────
// Hold Space or the Gust button; the longer the hold, the harder the gust. The button's
// fill is the charge, so the release is never a surprise.
const CHARGE_T = 1.2;                    // seconds of hold for a full-power gust
const GUST_MIN = 0.7, GUST_MAX = 2.3;    // power sent to the sim at no charge / full charge
const gustBtn = document.getElementById('gust'), gustFill = document.getElementById('gustFill');
let chargeT0 = -1;
const chargeAmt = () => Math.min(1, (clock.elapsedTime - chargeT0) / CHARGE_T);
function startCharge() { if (chargeT0 < 0) chargeT0 = clock.elapsedTime; }
function releaseCharge() {
  if (chargeT0 < 0) return;
  const c = chargeAmt();
  chargeT0 = -1;
  gustFill.style.width = '0%';
  worker.postMessage({ type: 'gust', power: GUST_MIN + (GUST_MAX - GUST_MIN) * c });
}
gustBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  gustBtn.setPointerCapture(e.pointerId);
  startCharge();
});
gustBtn.addEventListener('pointerup', releaseCharge);
gustBtn.addEventListener('pointercancel', releaseCharge);
window.addEventListener('blur', releaseCharge);   // don't leave a charge stuck on tab-away

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && (e.target.type === 'text' || e.code !== 'Space')) return;
  const now = clock.elapsedTime;
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) startCharge(); }
  else if (e.key >= '1' && e.key <= '4') switchDesign(+e.key - 1, now);
  else if (e.key === 'h' || e.key === 'H') ui.classList.toggle('hidden');
  else if (e.key === 'm' || e.key === 'M') setMode('mast');
  else if (e.key === 'w' || e.key === 'W') setMode('wave');
});
window.addEventListener('keyup', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;
  if (e.code === 'Space') { e.preventDefault(); releaseCharge(); }
});

// ─── Loop ────────────────────────────────────────────────────
const clock = new THREE.Clock();
const _keyDir = new THREE.Vector3();
renderer.setAnimationLoop(() => {
  const real = clock.getDelta();
  const now = clock.elapsedTime;

  if (haveFrame) {
    haveFrame = false;
    flag.visible = true;
    uploadMesh();
    updatePoleMesh();
  }
  if (gustPeakPending) {
    gustPeakPending = false;
    if (cycleEl.checked) switchDesign(current + 1, now);
  }
  updateFade(now);
  if (chargeT0 >= 0) gustFill.style.width = (chargeAmt() * 100).toFixed(1) + '%';

  const ease = 1 - Math.exp(-Math.min(real, 0.1) * 2.0);
  camTarget.lerp(camGoal.target, ease);
  camBase.lerp(camGoal.base, ease);
  camera.position.set(
    camBase.x + 0.18 * Math.sin(now * 0.11),
    camBase.y + 0.10 * Math.sin(now * 0.07 + 1.0),
    camBase.z
  );
  camera.lookAt(camTarget);
  camera.updateMatrixWorld();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  key.target.position.copy(camTarget);
  uniforms.uKeyDirView.value.copy(_keyDir.copy(key.position).normalize().transformDirection(camera.matrixWorldInverse));

  renderer.render(scene, camera);
});
