import * as THREE from 'three';
import { blocks } from './content.js';

// ============================================================
// DOM
// ============================================================
const canvasEl    = document.getElementById('flag-canvas');
const flagStage   = document.querySelector('.flag-stage');
const publication = document.getElementById('publication');
const overlayEl   = document.getElementById('text-overlay');
const overlayIn   = document.getElementById('text-overlay-inner');
const spaceHint     = document.getElementById('space-hint');
const scrollHint    = document.getElementById('scroll-hint');
const scrollBackHint = document.getElementById('scroll-back-hint');
const a11yEl      = document.getElementById('a11y-text');
const videoEl     = document.getElementById('cover-video');

// ============================================================
// Build selectable overlay + a11y fallback + TOC anchor links
// ============================================================
{
  let rHtml = '<div class="video-spacer"></div>';
  let aHtml = '';
  for (const b of blocks) {
    if (b.type === 'spacer') {
      rHtml += '<div class="sp"></div>';
      continue;
    }
    const cls = [];
    if (b.type === 'toc') cls.push('toc');
    if (b.indent) cls.push('indent');
    const classAttr = cls.length ? ` class="${cls.join(' ')}"` : '';
    const idAttr    = b.anchor ? ` id="sec-${b.anchor}"` : '';
    const esc = b.text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const content = b.link
      ? `<a href="#sec-${b.link}" data-link="${b.link}">${esc}  ↗</a>`
      : esc;
    rHtml += `<p${classAttr}${idAttr}>${content}</p>`;
    aHtml += `<p>${esc}</p>`;
  }
  overlayIn.innerHTML = rHtml;
  a11yEl.innerHTML = aHtml;
}

// Hint behaviour: scroll-hint appears after a short delay then fades on
// first scroll; space-hint surfaces briefly once; scroll-back-hint appears
// near the bottom of the page.
let scrolledOnce = false;
setTimeout(() => {
  if (!scrolledOnce) scrollHint.classList.add('visible');
}, 3500);
window.addEventListener('scroll', () => {
  if (!scrolledOnce && window.scrollY > 40) {
    scrolledOnce = true;
    scrollHint.classList.add('fade');
  }
  const scrolled = window.scrollY > 200;
  scrollBackHint.classList.toggle('visible', scrolled);
  spaceHint.classList.toggle('visible', scrolled);
}, { passive: true });

scrollHint.addEventListener('click', () => {
  window.scrollBy({ top: window.innerHeight * 0.9, behavior: 'smooth' });
});
scrollBackHint.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
spaceHint.addEventListener('click', () => {
  setPaused(!isPaused);
});

// ============================================================
// TEXT TEXTURE (canvas → THREE.CanvasTexture)
// ============================================================
const TEX_W = 2048;
const TEX_H = 1152;

const textCanvas = document.createElement('canvas');
textCanvas.width  = TEX_W;
textCanvas.height = TEX_H;
const tctx = textCanvas.getContext('2d');

const texture = new THREE.CanvasTexture(textCanvas);
texture.colorSpace = THREE.SRGBColorSpace;
texture.minFilter  = THREE.LinearMipmapLinearFilter;
texture.magFilter  = THREE.LinearFilter;
texture.anisotropy = 8;

// Layout metrics
const COL_MAX_CSS = 920;
const COL_PCT     = 0.56;
const FONT_CSS    = 24;
const LINE_RATIO  = 1.55;
const INDENT_EMS  = 2.2;

let TEXT_W, PAD_X, FONT_PX, LINE_H, INDENT_PX, START_Y;
let VIDEO_H = 0;
let VIDEO_TOP_Y = 0;
let VIDEO_GAP = 0;

function getVideoAspect() {
  if (videoEl && videoEl.videoWidth && videoEl.videoHeight) {
    return videoEl.videoWidth / videoEl.videoHeight;
  }
  return 16 / 9;
}

function recomputeMetrics() {
  const vw = window.innerWidth;
  const ratio = TEX_W / vw;
  const colCSS = Math.min(COL_MAX_CSS, vw * COL_PCT);
  TEXT_W    = colCSS * ratio;
  PAD_X     = (TEX_W - TEXT_W) / 2;
  FONT_PX   = FONT_CSS * ratio;
  LINE_H    = FONT_PX * LINE_RATIO;
  INDENT_PX = FONT_PX * INDENT_EMS;
  START_Y   = (window.innerHeight * 0.08) * ratio;

  // Video block (matches text column width, native aspect ratio)
  VIDEO_TOP_Y = START_Y;
  VIDEO_H     = TEXT_W / getVideoAspect();
  VIDEO_GAP   = FONT_PX * 1.6;   // matches CSS margin-bottom: 1.6em

  // Reflect the video height into the DOM spacer so the overlay text
  // aligns with the canvas text below the video.
  const videoCSSHeight = colCSS / getVideoAspect();
  overlayIn.querySelector('.video-spacer').style.height = videoCSSHeight + 'px';
}

function fontString() {
  return `700 ${FONT_PX.toFixed(1)}px "ABC Diatype", system-ui, sans-serif`;
}
function letterSpacing() {
  return `${(-0.03 * FONT_PX).toFixed(2)}px`;
}
function setFontOnCtx() {
  tctx.font = fontString();
  tctx.letterSpacing = letterSpacing();
}

function wrap(text, firstIndentW = 0) {
  setFontOnCtx();
  const words = text.split(' ');
  const out = [];
  let line = '';
  let avail = TEXT_W - firstIndentW;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (tctx.measureText(test).width > avail && line) {
      out.push(line);
      line = w;
      avail = TEXT_W;
    } else {
      line = test;
    }
  }
  if (line) out.push(line);
  return out;
}

const lines = [];
const anchorY = {};   // anchor name → y position in texture coords
let totalContentH = 0;

// Selection highlights — rectangles in absolute texture coordinates,
// painted into the texture so they wave with the cloth.
let highlightRects = [];

function layout() {
  lines.length = 0;
  Object.keys(anchorY).forEach(k => delete anchorY[k]);

  // Reserve room for the video at the top
  let y = VIDEO_TOP_Y + VIDEO_H + VIDEO_GAP;

  for (const b of blocks) {
    if (b.type === 'spacer') { y += FONT_PX * 2.4; continue; }  // matches .sp { height: 2.4em }
    if (b.anchor) anchorY[b.anchor] = y;
    const indentW = b.indent ? INDENT_PX : 0;
    const displayText = b.link ? `${b.text}  ↗` : b.text;
    const wrapped = wrap(displayText, indentW);
    for (let i = 0; i < wrapped.length; i++) {
      const x = (i === 0) ? PAD_X + indentW : PAD_X;
      lines.push({ text: wrapped[i], x, y });
      y += LINE_H;
    }
    if (b.type !== 'toc') y += FONT_PX * 0.7;   // matches CSS margin-bottom: 0.7em
  }
  totalContentH = y + START_Y;
}

function drawTextAt(scrollPx) {
  tctx.clearRect(0, 0, TEX_W, TEX_H);

  // 0) Selection highlights — painted first so text sits on top of them.
  if (highlightRects.length) {
    tctx.fillStyle = 'rgba(29, 56, 35, 0.32)';
    for (const h of highlightRects) {
      const yy = h.y - scrollPx;
      if (yy + h.h < 0 || yy > TEX_H) continue;
      tctx.fillRect(h.x, yy, h.w, h.h);
    }
  }

  // 1) Video frame at top of content (scrolls with the rest)
  if (videoEl && videoEl.readyState >= 2) {
    const vy = VIDEO_TOP_Y - scrollPx;
    if (vy + VIDEO_H > 0 && vy < TEX_H) {
      try {
        tctx.drawImage(videoEl, PAD_X, vy, TEXT_W, VIDEO_H);
      } catch (e) { /* video not ready / cross-origin / decode hiccup */ }
    }
  }

  // 2) Text — offset by half the leading so glyphs sit centered inside
  //   the line-box (matches DOM line-box → makes selection align).
  tctx.fillStyle = '#1d3823';
  tctx.textBaseline = 'top';
  setFontOnCtx();
  const halfLeading = (LINE_H - FONT_PX) / 2;
  for (const ln of lines) {
    const yy = ln.y - scrollPx;
    if (yy < -LINE_H * 2 || yy > TEX_H + LINE_H) continue;
    tctx.fillText(ln.text, ln.x, yy + halfLeading);
  }
  texture.needsUpdate = true;
}

// ============================================================
// THREE.js scene
// ============================================================
const scene = new THREE.Scene();

const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x000000, 0);

const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
camera.position.set(0, 0, 10);

// Unlit material below — no scene lights needed. Texture renders 1:1
// (so the video stays in its original colour, no green tint).

// ============================================================
// CLOTH (Verlet)
// ============================================================
const COLS = 64;
const ROWS = 36;
const FLAG_W = 10;
const FLAG_H = FLAG_W * (TEX_H / TEX_W);

const particles   = [];
const constraints = [];

function addConstraint(a, b) {
  constraints.push({ a, b, d: Math.hypot(a.x - b.x, a.y - b.y) });
}

function buildCloth() {
  particles.length = 0;
  constraints.length = 0;
  const midC = Math.floor(COLS / 2);
  for (let r = 0; r <= ROWS; r++) {
    for (let c = 0; c <= COLS; c++) {
      const x = (c / COLS - 0.5) * FLAG_W;
      const y = (0.5 - r / ROWS) * FLAG_H;
      const isTopRow     = r === 0;
      const isCorner     = (r === 0 || r === ROWS) && (c === 0 || c === COLS);
      const isBotCorner  = r === ROWS && (c === 0 || c === COLS);
      const isMidTop     = r === 0 && c === midC;
      particles.push({
        x, y, z: 0,
        px: x, py: y, pz: 0,
        ox: x, oy: y,
        isTopRow, isCorner, isBotCorner, isMidTop,
        pin: isTopRow ? 1 : 0,
        targetPin: isTopRow ? 1 : 0,
      });
    }
  }
  const idx = (r, c) => r * (COLS + 1) + c;
  for (let r = 0; r <= ROWS; r++) {
    for (let c = 0; c <= COLS; c++) {
      if (c < COLS) addConstraint(particles[idx(r, c)], particles[idx(r, c + 1)]);
      if (r < ROWS) addConstraint(particles[idx(r, c)], particles[idx(r + 1, c)]);
      if (c < COLS && r < ROWS) {
        addConstraint(particles[idx(r, c)],     particles[idx(r + 1, c + 1)]);
        addConstraint(particles[idx(r + 1, c)], particles[idx(r, c + 1)]);
      }
    }
  }
}

let isPaused = false;
function setPaused(p) {
  isPaused = p;
  for (const part of particles) {
    const pinnedWhenPaused = part.isTopRow || part.isBotCorner;
    part.targetPin = isPaused ? (pinnedWhenPaused ? 1 : 0) : (part.isTopRow ? 1 : 0);
  }
}

let time = 0;
let scrollGust = 1;
let lastScrollY = window.scrollY;
window.addEventListener('scroll', () => {
  const dy = Math.abs(window.scrollY - lastScrollY);
  lastScrollY = window.scrollY;
  // Each scroll tick adds a gentle gust on top of the baseline wind.
  scrollGust = Math.min(1.5, scrollGust + Math.min(0.2, dy * 0.003));
}, { passive: true });

window.addEventListener('pointerdown', () => {
  scrollGust = Math.max(scrollGust, 2.0);
});

function stepCloth(dt) {
  time += dt;
  const damp    = 0.995;
  const gravity = isPaused ? 0.00004 : 0.00040;
  // Scroll-driven gust decays exponentially toward 1.
  scrollGust += (1 - scrollGust) * Math.min(1, dt * 1.8);
  const windScale = isPaused ? 0.1 : scrollGust;

  for (const p of particles) {
    p.pin += (p.targetPin - p.pin) * 0.06;

    // Distance from the pinned top edge, normalised 0 (at pin) → 1 (at free bottom).
    // Squaring biases motion strongly toward the free edge so the cloth whips
    // there while the pinned edge stays calm — the defining look of a real flag.
    const freeness = Math.min(1, Math.max(0, (FLAG_H * 0.5 - p.y) / FLAG_H));
    const f2 = freeness * freeness;

    // Travelling wave moving down the flag from pinned edge to free edge.
    const phaseY = time * 1.6 + p.y * 1.2;
    const phaseX = time * 0.7 + p.x * 0.5;

    const windZ = (
        Math.sin(phaseY) * 0.00085
      + Math.sin(phaseY * 1.7 + phaseX) * 0.00035
    ) * f2 * windScale;
    const windX = Math.sin(phaseY * 0.6 + phaseX * 0.3) * 0.00042 * freeness * windScale;

    if (p.pin > 0.995) {
      p.x = p.ox; p.y = p.oy; p.z = 0;
      p.px = p.x; p.py = p.y; p.pz = p.z;
      continue;
    }

    const vx = (p.x - p.px) * damp;
    const vy = (p.y - p.py) * damp;
    const vz = (p.z - p.pz) * damp;
    p.px = p.x; p.py = p.y; p.pz = p.z;

    // Gentle restoring force toward z=0 — keeps the cloth from billowing
    // permanently forward toward the camera while still allowing ripples.
    const restoreZ = -p.z * 0.0005;

    p.x += vx + windX;
    p.y += vy - gravity;
    p.z += vz + windZ + restoreZ;

    if (p.pin > 0.005) {
      const k = p.pin;
      p.x = p.x * (1 - k) + p.ox * k;
      p.y = p.y * (1 - k) + p.oy * k;
      p.z = p.z * (1 - k);
    }
  }

  const ITER = 5;
  for (let i = 0; i < ITER; i++) {
    for (const c of constraints) {
      const a = c.a, b = c.b;
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const cur = Math.hypot(dx, dy, dz) || 1e-6;
      const diff = ((cur - c.d) / cur) * 0.5;
      const ox = dx * diff, oy = dy * diff, oz = dz * diff;
      const aFree = 1 - Math.min(a.pin, 1);
      const bFree = 1 - Math.min(b.pin, 1);
      a.x += ox * aFree; a.y += oy * aFree; a.z += oz * aFree;
      b.x -= ox * bFree; b.y -= oy * bFree; b.z -= oz * bFree;
    }
  }
}

// ============================================================
// MESH — transparent fabric
// ============================================================
const geometry = new THREE.PlaneGeometry(FLAG_W, FLAG_H, COLS, ROWS);
const material = new THREE.MeshBasicMaterial({
  map: texture,
  side: THREE.DoubleSide,
  transparent: true,
  depthWrite: false,
});
const flag = new THREE.Mesh(geometry, material);
scene.add(flag);

function updateMesh() {
  const pos = geometry.attributes.position.array;
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    pos[i * 3]     = p.x;
    pos[i * 3 + 1] = p.y;
    pos[i * 3 + 2] = p.z;
  }
  geometry.attributes.position.needsUpdate = true;
  geometry.computeVertexNormals();
}

// ============================================================
// RESIZE
// ============================================================
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();

  const fovY = camera.fov * Math.PI / 180;
  const viewH = 2 * camera.position.z * Math.tan(fovY / 2);
  const viewW = viewH * camera.aspect;
  flag.scale.set(viewW / FLAG_W, viewH / FLAG_H, 1);

  recomputeMetrics();
  layout();
  publication.style.height = Math.round(Math.max(totalContentH * 2.4, window.innerHeight * 16)) + 'px';
}

window.addEventListener('resize', resize);

// ============================================================
// SCROLL
// ============================================================
function computeScrollProgress() {
  const pubTop = publication.offsetTop;
  const pubH   = publication.offsetHeight;
  const viewH  = window.innerHeight;
  const sy     = window.scrollY;
  return Math.max(0, Math.min(1, (sy - pubTop) / Math.max(1, pubH - viewH)));
}

function syncOverlay() {
  const innerH = overlayIn.scrollHeight;
  const padPx = window.innerHeight * 0.16;
  const visible = window.innerHeight - padPx;
  const maxScroll = Math.max(0, innerH - visible);
  overlayIn.style.transform = `translate3d(0, ${(-smoothScroll * maxScroll).toFixed(1)}px, 0)`;
}

// ============================================================
// SELECTION → canvas highlights (cloth-waved)
// ============================================================
function updateHighlightsFromSelection() {
  const sel = window.getSelection();
  highlightRects = [];
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    lastDrawnScroll = -1;
    return;
  }
  const range = sel.getRangeAt(0);
  // Only highlight selections inside our overlay
  if (!overlayIn.contains(range.commonAncestorContainer)) return;

  const ratio = TEX_W / window.innerWidth;
  const scrollPxNow = smoothScroll * Math.max(0, totalContentH - TEX_H * 0.7);
  const rects = range.getClientRects();
  for (const r of rects) {
    if (r.width < 1 || r.height < 1) continue;
    highlightRects.push({
      x: r.left * ratio,
      y: r.top * ratio + scrollPxNow,
      w: r.width * ratio,
      h: r.height * ratio,
    });
  }
  lastDrawnScroll = -1;   // force a redraw next tick
}

document.addEventListener('selectionchange', updateHighlightsFromSelection);

// ============================================================
// TOC link → scroll to section
// ============================================================
overlayIn.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a) return;
  e.preventDefault();
  const anchor = a.dataset.link;
  const targetY = anchorY[anchor];
  if (targetY == null) return;
  const maxScrollPx = Math.max(1, totalContentH - TEX_H * 0.7);
  // Position the target line near the top of the visible area
  const wantedScrollPx = Math.max(0, targetY - START_Y - LINE_H);
  const progress = Math.min(1, wantedScrollPx / maxScrollPx);
  const pubTop = publication.offsetTop;
  const pubH   = publication.offsetHeight;
  const viewH  = window.innerHeight;
  const scrollY = pubTop + progress * (pubH - viewH);
  window.scrollTo({ top: scrollY, behavior: 'smooth' });
});

// ============================================================
// SPACE → pin 4 corners + middle of top edge
// ============================================================
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    setPaused(!isPaused);
  }
});

// ============================================================
// INIT
// ============================================================
buildCloth();
recomputeMetrics();

if (videoEl) {
  videoEl.muted = true;
  videoEl.playsInline = true;
  const tryPlay = () => videoEl.play().catch(() => {});
  videoEl.addEventListener('loadedmetadata', () => {
    recomputeMetrics();
    layout();
    tryPlay();
  });
  videoEl.addEventListener('canplay', tryPlay);
  // Some browsers block autoplay until the first user gesture — kick it on any input.
  const kick = () => {
    tryPlay();
    window.removeEventListener('pointerdown', kick);
    window.removeEventListener('keydown', kick);
    window.removeEventListener('scroll', kick);
  };
  window.addEventListener('pointerdown', kick, { once: true });
  window.addEventListener('keydown',     kick, { once: true });
  window.addEventListener('scroll',      kick, { once: true });
  tryPlay();
}

document.fonts.ready.then(start).catch(start);

function start() {
  recomputeMetrics();
  layout();
  publication.style.height = Math.round(Math.max(totalContentH * 2.4, window.innerHeight * 16)) + 'px';
  resize();
  drawTextAt(0);
  syncOverlay();
  requestAnimationFrame(tick);
}

// ============================================================
// LOOP
// ============================================================
let last = performance.now();
let smoothScroll = 0;
let lastDrawnScroll = -1;

function tick(now) {
  const dt = Math.min((now - last) / 1000, 1 / 30);
  last = now;

  const target = computeScrollProgress();
  smoothScroll += (target - smoothScroll) * 0.10;
  const maxScroll = Math.max(0, totalContentH - TEX_H * 0.7);
  const scrollPx  = smoothScroll * maxScroll;

  // Is the video currently visible on the flag? If so we need to redraw
  // every frame to keep its motion alive, not just when scroll changes.
  const vy = VIDEO_TOP_Y - scrollPx;
  const videoVisible = (vy + VIDEO_H > 0) && (vy < TEX_H);

  if (videoVisible || Math.abs(smoothScroll - lastDrawnScroll) > 0.0003) {
    drawTextAt(scrollPx);
    syncOverlay();
    lastDrawnScroll = smoothScroll;
  }

  const SUB = 2;
  for (let i = 0; i < SUB; i++) stepCloth(dt / SUB);
  updateMesh();

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
