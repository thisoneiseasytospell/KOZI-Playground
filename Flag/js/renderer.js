import { SIM, state } from './config.js';
import { pos, nrm, uv, indexData } from './cloth.js';
import { vertexShader, fragmentShader } from './shaders.js';
import { cam, eyePos } from './camera.js';

// ─── WebGL context ──────────────────────────────────────────────
const canvas = document.getElementById('flagCanvas');
const gl = canvas.getContext('webgl', {
  antialias: true,
  alpha: false,
  premultipliedAlpha: false,
});
if (!gl) alert('WebGL not supported');
gl.getExtension('OES_element_index_uint');
gl.enable(gl.DEPTH_TEST);

// ─── Compile shaders ────────────────────────────────────────────
function compileShader(src, type) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(s));
  }
  return s;
}

const prog = gl.createProgram();
gl.attachShader(prog, compileShader(vertexShader, gl.VERTEX_SHADER));
gl.attachShader(prog, compileShader(fragmentShader, gl.FRAGMENT_SHADER));
gl.linkProgram(prog);
gl.useProgram(prog);

// ─── Locations ──────────────────────────────────────────────────
const loc = {};
['aPos', 'aNrm', 'aUV'].forEach(n => loc[n] = gl.getAttribLocation(prog, n));
['uProj', 'uView', 'uLight', 'uColor', 'uEye', 'uTex', 'uFace', 'uAlpha', 'uAmbient', 'uHasTex']
  .forEach(n => loc[n] = gl.getUniformLocation(prog, n));

// ─── Buffers ────────────────────────────────────────────────────
const posBuf = gl.createBuffer();
const nrmBuf = gl.createBuffer();
const uvBuf = gl.createBuffer();
const idxBuf = gl.createBuffer();

gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);

gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
gl.bufferData(gl.ARRAY_BUFFER, pos.byteLength, gl.DYNAMIC_DRAW);
gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
gl.bufferData(gl.ARRAY_BUFFER, nrm.byteLength, gl.DYNAMIC_DRAW);

gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexData, gl.STATIC_DRAW);

// ─── Texture ────────────────────────────────────────────────────
let flagTex = null;
let texSource = null;
let texIsVideo = false;
export let hasTex = false;

function uploadTextureFrame() {
  if (!flagTex || !texSource) return false;
  if (texIsVideo && texSource.readyState < texSource.HAVE_CURRENT_DATA) return false;

  gl.bindTexture(gl.TEXTURE_2D, flagTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, texSource);
  return true;
}

export function loadTexture(source, { isVideo = false } = {}) {
  if (flagTex) gl.deleteTexture(flagTex);
  texSource = source;
  texIsVideo = isVideo;
  flagTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, flagTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 0]),
  );
  uploadTextureFrame();
  hasTex = true;
}

export function removeTexture() {
  if (flagTex) { gl.deleteTexture(flagTex); flagTex = null; }
  texSource = null;
  texIsVideo = false;
  hasTex = false;
}

// ─── Matrix utilities ───────────────────────────────────────────
function perspective(fov, asp, near, far) {
  const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
  return new Float32Array([
    f / asp, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function lookAt(e, t, u) {
  let zx = e[0] - t[0], zy = e[1] - t[1], zz = e[2] - t[2];
  let l = Math.sqrt(zx * zx + zy * zy + zz * zz);
  const z = [zx / l, zy / l, zz / l];
  let xx = u[1] * z[2] - u[2] * z[1], xy = u[2] * z[0] - u[0] * z[2], xz = u[0] * z[1] - u[1] * z[0];
  l = Math.sqrt(xx * xx + xy * xy + xz * xz);
  const x = [xx / l, xy / l, xz / l];
  const y = [x[1] * z[2] - x[2] * z[1], x[2] * z[0] - x[0] * z[2], x[0] * z[1] - x[1] * z[0]];
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -(x[0] * e[0] + x[1] * e[1] + x[2] * e[2]),
    -(y[0] * e[0] + y[1] * e[1] + y[2] * e[2]),
    -(z[0] * e[0] + z[1] * e[1] + z[2] * e[2]), 1,
  ]);
}

// ─── Lighting ───────────────────────────────────────────────────
const ldDark = [0.55, 0.75, 0.45];
const ldLight = [0.5, 0.8, 0.35];

function normLight(l) {
  const len = Math.sqrt(l[0] ** 2 + l[1] ** 2 + l[2] ** 2);
  return [l[0] / len, l[1] / len, l[2] / len];
}

// ─── Resize ─────────────────────────────────────────────────────
export function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  gl.viewport(0, 0, canvas.width, canvas.height);
}

// ─── Render ─────────────────────────────────────────────────────
export function render() {
  gl.clearColor(SIM.bgColor[0], SIM.bgColor[1], SIM.bgColor[2], 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const trans = SIM.opacity < 1.0;
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  if (trans) gl.depthMask(false);

  const ld = state.theme === 'light' ? normLight(ldLight) : normLight(ldDark);
  const e = eyePos();

  gl.useProgram(prog);
  gl.uniformMatrix4fv(loc.uProj, false, perspective(Math.PI / 4.5, canvas.width / canvas.height, 0.1, 100));
  gl.uniformMatrix4fv(loc.uView, false, lookAt(e, cam.target, [0, 1, 0]));
  gl.uniform3f(loc.uLight, ld[0], ld[1], ld[2]);
  gl.uniform3f(loc.uColor, SIM.flagColor[0], SIM.flagColor[1], SIM.flagColor[2]);
  gl.uniform3f(loc.uEye, e[0], e[1], e[2]);
  gl.uniform1f(loc.uAlpha, SIM.opacity);
  gl.uniform1f(loc.uAmbient, state.theme === 'light' ? 0.38 : 0.22);

  if (hasTex && flagTex) {
    if (texIsVideo) uploadTextureFrame();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, flagTex);
    gl.uniform1i(loc.uTex, 0);
    gl.uniform1i(loc.uHasTex, 1);
  } else {
    gl.uniform1i(loc.uHasTex, 0);
  }

  // Upload dynamic buffers
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

  // Draw double-sided
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
  if (trans) gl.depthMask(true);
}

export { canvas };
