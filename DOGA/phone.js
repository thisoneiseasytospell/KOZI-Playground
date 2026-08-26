// DOGA on a phone: the same engine, a thumb's worth of controls.
//
// The desktop editor is a timeline with an inspector floating over it, and neither survives a
// 390px screen. This is the other shape of the same app — the frame fills the display, type is
// edited by tapping it, and everything else lives in one island above the home bar. It drives
// app.js through a small api, so there is no second copy of the state, the renderer or the
// exporter: what you make here is the same document the desktop opens.

import { api } from './app.js';
import { FONT_STACK, REF_W, KIND_INFO } from './render.js';

const $ = id => document.getElementById(id);
const q = new URLSearchParams(location.search);
const phone = q.has('phone') || (!q.has('desktop') && matchMedia('(max-width: 820px)').matches);

const MOVES = [
  ['auto', 'Auto'], ['in', 'Push in'], ['out', 'Pull out'], ['left', 'Pan left'],
  ['right', 'Pan right'], ['up', 'Pan up'], ['down', 'Pan down'], ['none', 'Hold still'],
];

if (phone) boot();

function boot() {
  document.body.classList.add('phone');
  document.head.querySelector('meta[name=viewport]')
    ?.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover');

  const island = document.createElement('div');
  island.id = 'island';
  island.innerHTML = `
    <button data-act="photo">Photo</button>
    <button data-act="ratio">9:16</button>
    <button data-act="timing">Timing</button>
    <button data-act="export" class="go">Export</button>`;

  const strip = document.createElement('div');
  strip.id = 'ptl';
  strip.innerHTML = `
    <button id="ptlPlay" aria-label="Play">▶</button>
    <div id="ptlTrack"><div id="ptlFill"></div><div id="ptlHead"></div></div>
    <span id="ptlTime">0:00</span>`;

  const sheet = document.createElement('div');
  sheet.id = 'sheet';
  sheet.hidden = true;
  sheet.innerHTML = `
    <div class="sheetBar"><b>Timing</b><button data-act="close">Done</button></div>
    <label class="ctl">Length <input type="range" id="pLen" min="3" max="20" step="0.5"><span id="pLenVal"></span></label>
    <label class="ctl">Motion <select id="pMove">${
      MOVES.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></label>
    <button id="pLoop" class="btn wide">Loop playback</button>
    <p class="hint" id="pCheck">Checking this device…</p>
    <a class="backLink" href="../index.html">← KOZI Playground</a>`;

  document.body.append(strip, island, sheet);
  wireIsland(island, sheet);
  wireSheet(sheet);
  wireCanvas();
  wireStrip();
  deviceCheck().then(text => { $('pCheck').textContent = text; });
}

// ---------- island ----------

function wireIsland(island, sheet) {
  island.addEventListener('click', e => {
    const act = e.target.dataset?.act;
    if (!act) return;
    if (act === 'photo') api.pickFile('image/*', true);
    if (act === 'ratio') {
      const next = api.state.ratio === '9:16' ? '4:5' : '9:16';
      api.setRatio(next);
      e.target.textContent = next;
    }
    if (act === 'timing') { syncSheet(); sheet.hidden = false; }
    if (act === 'export') { api.setPlaying(false); api.exportNow(); }
  });
}

// The clip and the type are one story here — length moves them together, which is the only
// reading of "how long is this" a phone has room to offer.
function setLength(sec) {
  for (const c of api.state.clips) c.out = Math.min(c.srcDur, c.in + sec);
  for (const t of api.state.texts) { t.start = 0; t.dur = sec; }
  api.rebuildTimeline();
  api.draw();
}

function syncSheet() {
  const len = api.totalDur() || 10;
  $('pLen').value = Math.min(20, Math.max(3, len));
  $('pLenVal').textContent = Math.round(len) + 's';
  const still = api.state.clips.find(c => c.still);
  $('pMove').value = still?.move || 'auto';
  $('pLoop').classList.toggle('on', api.state.loop);
}

function wireSheet(sheet) {
  sheet.addEventListener('click', e => {
    if (e.target.dataset?.act === 'close') sheet.hidden = true;
  });
  $('pLen').addEventListener('input', e => {
    $('pLenVal').textContent = Math.round(+e.target.value) + 's';
    setLength(+e.target.value);
  });
  $('pMove').addEventListener('change', e => {
    for (const c of api.state.clips) if (c.still) c.move = e.target.value;
    api.draw();
  });
  $('pLoop').addEventListener('click', () => {
    api.state.loop = !api.state.loop;
    $('pLoop').classList.toggle('on', api.state.loop);
  });
}

// What this particular phone can actually do, asked of the phone rather than assumed. Both
// WebCodecs and the share sheet are secure-context only, so over plain http on a LAN address
// they are simply absent — worth saying out loud, since that reads as "phone can't do it".
async function deviceCheck() {
  if (!window.isSecureContext) {
    return 'Editing works here, but video export needs https — open the deployed page for that.';
  }
  const enc = typeof VideoEncoder !== 'undefined';
  let codec = false;
  if (enc) {
    for (const c of ['avc1.640028', 'avc1.4d0028', 'avc1.42001f']) {
      try {
        const r = await VideoEncoder.isConfigSupported(
          { codec: c, width: 1080, height: 1920, bitrate: 12e6, framerate: 30 });
        if (r.supported) { codec = true; break; }
      } catch { /* try the next profile */ }
    }
  }
  let share = false;
  try {
    share = !!navigator.canShare?.({ files: [new File([new Uint8Array(1)], 'a.mp4', { type: 'video/mp4' })] });
  } catch { /* canShare throws on some engines rather than returning false */ }
  return `Export on this device — encoder: ${enc ? (codec ? 'yes' : 'no 1080×1920 profile') : 'not supported'}`
    + ` · save sheet: ${share ? 'yes' : 'download only'}`;
}

// ---------- timeline ----------
// A phone has no room for tracks, and with one picture under one stack of type there is
// nothing to stack anyway. What is left of a timeline is the part you actually reach for:
// where the playhead is, and dragging it somewhere else.

const clock = t => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};

function wireStrip() {
  const track = $('ptlTrack');

  $('ptlPlay').addEventListener('click', () => api.setPlaying(!api.state.playing));

  const scrub = e => {
    const r = track.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    api.applySeek(f * api.totalDur(), false);
  };
  track.addEventListener('pointerdown', e => {
    e.preventDefault();
    track.setPointerCapture(e.pointerId);
    api.setPlaying(false);
    scrub(e);
  });
  track.addEventListener('pointermove', e => {
    if (track.hasPointerCapture(e.pointerId)) scrub(e);
  });

  let shown = '';
  const paint = () => {
    const total = api.totalDur() || 1;
    const f = Math.max(0, Math.min(1, api.state.t / total));
    $('ptlFill').style.width = (f * 100) + '%';
    $('ptlHead').style.left = (f * 100) + '%';
    const label = `${clock(api.state.t)} / ${clock(total)}`;
    if (label !== shown) { shown = label; $('ptlTime').textContent = label; }
    $('ptlPlay').textContent = api.state.playing ? '❚❚' : '▶';
    requestAnimationFrame(paint);
  };
  paint();
}

// ---------- tap to edit ----------
// Tap type to edit it, tap the frame to play or pause. Everything is caught on #stage in the
// capture phase, so a tap on type never reaches the drag handlers app.js binds to the canvas —
// positions are the template's job, and a thumb should not be able to nudge them by accident.

let editing = null;
let tap = null;
let ta = null;      // the one real input, built once and parked between edits
let scrim = null;

function canvasPos(e) {
  const r = api.canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * api.canvas.width / r.width,
    y: (e.clientY - r.top) * api.canvas.height / r.height,
  };
}

// Topmost element under the point, with a thumb's worth of slack around each box.
function hitText(x, y) {
  let hit = null;
  for (const [id, b] of api.boxes()) {
    if (x >= b.x - 14 && x <= b.x + b.w + 14 && y >= b.y - 14 && y <= b.y + b.h + 14) hit = id;
  }
  return hit;
}

function wireCanvas() {
  const stage = $('stage');
  ensureInput();   // the input has to predate the tap that focuses it, so build it at boot
  stage.addEventListener('pointerdown', e => {
    if (editing) return;
    const p = canvasPos(e);
    const id = hitText(p.x, p.y);
    tap = { id, x: e.clientX, y: e.clientY, at: performance.now() };
    // Stopping the event is enough to keep app.js's drag off the type; preventing its default
    // would also cancel the touch WebKit needs in order to raise the keyboard later. The canvas
    // is touch-action: none on a phone, so nothing scrolls or zooms out from under the tap.
    if (id != null) e.stopPropagation();
  }, true);

  stage.addEventListener('pointerup', e => {
    const t = tap;
    tap = null;
    if (!t || editing) return;
    if (Math.hypot(e.clientX - t.x, e.clientY - t.y) > 10) return;   // that was a drag
    if (performance.now() - t.at > 600) return;                     // that was a hold
    if (t.id != null) { e.stopPropagation(); armEdit(t.id); }
    else api.setPlaying(!api.state.playing);
  }, true);

  window.visualViewport?.addEventListener('resize', fitKeyboard);
  window.visualViewport?.addEventListener('scroll', fitKeyboard);
}

// iOS raises the keyboard only for a focus() that happens inside the touch that asked for it,
// on an element that was already in the page when the thumb went down. So the input is built
// once, parked invisible between edits, and takes focus as the very first thing a tap does —
// seeking, hiding and measuring all happen after, with the keyboard already on its way up.
function ensureInput() {
  if (ta) return;

  scrim = document.createElement('div');
  scrim.id = 'editScrim';

  ta = document.createElement('textarea');
  ta.id = 'tapEdit';
  ta.className = 'parked';
  ta.rows = 1;
  ta.enterKeyHint = 'done';
  ta.spellcheck = false;
  ta.autocapitalize = 'sentences';
  ta.autocomplete = 'off';

  ta.addEventListener('input', () => {
    if (!editing) return;
    editing.item.text = ta.value;
    grow();
    api.draw();
  });
  ta.addEventListener('blur', endEdit);
  scrim.addEventListener('pointerdown', endEdit);

  document.body.append(scrim, ta);
}

function armEdit(id) {
  const item = api.state.texts.find(t => t.id === id);
  if (!item || !KIND_INFO[item.kind]?.text) return;

  ensureInput();
  ta.value = item.text;
  ta.focus({ preventScroll: true });
  beginEdit(item);
}

function beginEdit(item) {
  // Park where the type-on has finished, so what you edit is the whole line rather than
  // whatever the typewriter had reached when your thumb landed.
  api.setPlaying(false);
  api.applySeek(item.start + item.dur * 0.55);
  const box = api.boxes().get(item.id);
  if (!box) { ta.blur(); return; }

  // The canvas hands the type over to a real input: same face, same size, same place.
  item.hide = true;
  api.draw();

  const r = api.canvas.getBoundingClientRect();
  const s = r.width / api.canvas.width;
  const cap = item.kind === 'caption';
  const size = Math.max(16, item.size * r.width / REF_W);   // under 16px iOS zooms the page
  const weight = item.kind === 'wordmark' ? 500 : 400;

  ta.className = '';
  Object.assign(ta.style, {
    left: (r.left + box.x * s) + 'px',
    width: Math.max(box.w * s, (item.maxW || 0.4) * r.width) + 'px',
    font: `${weight} ${size}px ${FONT_STACK}`,
    lineHeight: cap ? 1.33 : 1.34,
    color: cap ? (item.fg || '#000') : (item.fg || '#fff'),
    background: cap ? (item.bg || '#fff') : 'transparent',
    padding: cap ? `0 ${size * 0.18}px` : '0',
  });

  editing = { item, ta, scrim, top: r.top + box.y * s };
  ta.style.top = editing.top + 'px';
  document.body.classList.add('editing');
  grow();

  ta.setSelectionRange(ta.value.length, ta.value.length);
  fitKeyboard();
}

function grow() {
  if (!editing) return;
  const { ta } = editing;
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

// The keyboard covers the bottom half of the screen; lift the frame and the input together by
// exactly as much as they are buried, so the line being typed stays where you can read it.
function fitKeyboard() {
  if (!editing) return;
  const avail = window.visualViewport?.height ?? window.innerHeight;
  const need = editing.top + editing.ta.offsetHeight + 24 - avail;
  applyShift(Math.max(0, need));
}

function applyShift(n) {
  $('main').style.transform = n ? `translateY(${-n}px)` : '';
  if (editing) editing.ta.style.top = (editing.top - n) + 'px';
}

function endEdit() {
  if (!editing) return;
  const { item } = editing;
  editing = null;
  item.hide = false;
  ta.blur();                 // a tap on the scrim has to put the keyboard away too
  ta.className = 'parked';
  ta.removeAttribute('style');
  document.body.classList.remove('editing');
  applyShift(0);
  api.rebuildTimeline();
  api.draw();
}
