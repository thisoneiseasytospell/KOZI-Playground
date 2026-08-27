// DOGA — drop videos, stack them AE-style, add NYT typewriter captions, export MP4. All local.
//
// Preview decodes through WebCodecs into a RAM frame cache (media.js) and takes its clock from
// the audio context. Nothing here depends on how the source file was encoded, so a sparse-
// keyframe 4K file behaves like a light one: it just fills its cache more slowly.

import { drawFrame, stillMotion, FONT_STACK, KIND_INFO } from './render.js';
import { exportMovie } from './export.js';
import { ClipMedia, ImageMedia, setQuality, cacheBytes, cacheBudget } from './media.js';

const $ = id => document.getElementById(id);
const canvas = $('preview');
const ctx = canvas.getContext('2d');

const RATIOS = { '9:16': [1080, 1920], '4:5': [1080, 1350] };
// Preview normally renders at half output res, which keeps a 1080x1920 frame cheap to repaint
// every tick. HQ trades that back for a 1:1 preview — what you see is what the MP4 holds.
const PREVIEW_SCALE = { lq: 0.5, hq: 1 };
const SAFE = {
  '9:16': { l: 0.055, r: 0.055, t: 0.090, b: 0.170 },
  '4:5':  { l: 0.055, r: 0.055, t: 0.060, b: 0.100 },
};
const MIN_CLIP = 0.2;
const STILL_DUR = 10;        // seconds a dropped image gets on the timeline before you trim it
const STORY_DUR = 10;        // length the DOGA story template lays in at
const DEFAULT_MEDIA = 'assets/kunstsilo.jpg';
const LANE_H = 40;
const SNAP_PX = 18;
const SPAN_MIN = 1;
const SPAN_MAX = 300;

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

const state = {
  ratio: '9:16',
  span: 10,
  guides: true,
  hq: false,
  loop: true,
  clips: [],   // {id, file, name, still, media, srcDur, start, in, out, panX, panY, move, muted, el, assetEl}
  texts: [],
  t: 0,
  playing: false,
  sel: new Set(),   // 'clip:3' / 'text:12' — one selection set across both tracks
};
let uid = 1;
let pickReplaces = false;   // does the phone picker replace its current picture, or add media?
let textBoxes = new Map();
let snapEdges = null;

// ---------- undo history ----------
// Snapshots keep File and decoded Media objects by reference, while copying every editable
// field. That makes undo instant even after deleting or replacing a large video: no re-read and
// no re-decode is needed. DOM handles are deliberately left behind and rebuilt on restore.

const undoStack = [];
const HISTORY_LIMIT = 40;

const copyClip = c => ({ ...c, el: null, assetEl: null, thumbEl: null });
const captureSnapshot = () => ({
  clips: state.clips.map(copyClip),
  texts: state.texts.map(t => ({ ...t })),
  selection: [...state.sel],
  ratio: state.ratio,
  t: state.t,
});

function mediaInUse(media) {
  if (!media) return true;
  if (state.clips.some(c => c.media === media)) return true;
  return undoStack.some(s => s.clips.some(c => c.media === media));
}

function releaseForgotten(snapshot) {
  for (const c of snapshot.clips) if (c.media && !mediaInUse(c.media)) c.media.destroy();
}

function updateUndoButton() {
  const button = $('undoBtn');
  if (!button) return;
  const latest = undoStack[undoStack.length - 1];
  button.disabled = !latest;
  button.title = latest ? `Undo ${latest.label}` : 'Nothing to undo';
}

function commitSnapshot(snapshot, label) {
  snapshot.label = label;
  undoStack.push(snapshot);
  if (undoStack.length > HISTORY_LIMIT) releaseForgotten(undoStack.shift());
  updateUndoButton();
}

function checkpoint(label) {
  commitSnapshot(captureSnapshot(), label);
}

function undo() {
  const snapshot = undoStack.pop();
  if (!snapshot) return;
  const displaced = state.clips;
  setPlaying(false);
  state.clips = snapshot.clips.map(copyClip);
  state.texts = snapshot.texts.map(t => ({ ...t }));
  state.sel = new Set(snapshot.selection);
  state.t = snapshot.t;
  assetSig = ''; // force fresh media rows and poster canvases
  setRatio(snapshot.ratio);
  state.t = Math.min(state.t, totalDur());
  syncInspector();
  rebuildTimeline();
  draw();
  for (const c of displaced) if (c.media && !mediaInUse(c.media)) c.media.destroy();
  updateUndoButton();
}

// ---------- sidebar tabs ----------
// Two panels behind one strip: what you lay in, and what media is loaded. Controls for the
// current selection are not here — they float over the stage in the layer window below.

function setTab(name) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.tabPanel').forEach(p => { p.hidden = p.dataset.panel !== name; });
}
document.querySelectorAll('#tabs button').forEach(b =>
  b.addEventListener('click', () => setTab(b.dataset.tab)));

// ---------- layer window ----------
// The controls for whatever is selected live in a small panel floating over the stage: drag it
// by its bar, park it wherever it suits the frame you are working on. It follows the selection
// and gets out of the way during playback, which has to stay a clean look at the export.

const layerWin = $('layerWin');
let winPos = null;        // viewport px; null until first shown
let winClosed = false;    // dismissed by hand, until the next selection

function placeLayerWin() {
  const w = layerWin.offsetWidth || 248;
  const h = layerWin.offsetHeight || 240;
  if (!winPos) {
    // Opens against the sidebar, on the right of the stage, clear of a centred preview.
    const s = $('stage').getBoundingClientRect();
    winPos = { x: s.right - w - 18, y: s.top + 18 };
  }
  winPos.x = Math.max(8, Math.min(winPos.x, window.innerWidth - w - 8));
  winPos.y = Math.max(8, Math.min(winPos.y, window.innerHeight - h - 8));
  layerWin.style.left = winPos.x + 'px';
  layerWin.style.top = winPos.y + 'px';
}

function updateLayerWin() {
  const show = state.sel.size > 0 && !state.playing && !winClosed;
  layerWin.hidden = !show;
  if (show) placeLayerWin();   // measured only once it is laid out
}

$('layerBar').addEventListener('pointerdown', e => {
  if (e.target.id === 'layerClose') return;
  e.preventDefault();
  const x0 = e.clientX, y0 = e.clientY;
  const from = { ...winPos };
  const onMove = ev => {
    winPos = { x: from.x + ev.clientX - x0, y: from.y + ev.clientY - y0 };
    placeLayerWin();
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
});

$('layerClose').addEventListener('click', () => { winClosed = true; updateLayerWin(); });

// ---------- selection ----------
// Everything selectable lives in one Set of typed keys, so a marquee across both tracks and a
// plain click are the same operation at different sizes. The inspector shows a single item's
// controls when exactly one thing is selected, and a count when several are.

const selKey = (type, id) => `${type}:${id}`;
const isSel = (type, id) => state.sel.has(selKey(type, id));

// The id of the only selected item of this type, or null if the selection is empty or mixed.
function soleSel(type) {
  if (state.sel.size !== 1) return null;
  const [key] = state.sel;
  const [t, id] = key.split(':');
  return t === type ? +id : null;
}
const selectedTextId = () => soleSel('text');
const selectedClipId = () => soleSel('clip');

// Live objects behind the current selection, each with the start it had when this was called.
function selectionItems() {
  const out = [];
  for (const key of state.sel) {
    const [type, raw] = key.split(':');
    const id = +raw;
    const item = type === 'clip'
      ? state.clips.find(c => c.id === id)
      : state.texts.find(t => t.id === id);
    if (item) out.push({ type, item, start: item.start });
  }
  return out;
}

// ---------- timeline math ----------

const clipDur = c => c.out - c.in;
const clipEnd = c => c.start + clipDur(c);
const totalDur = () => state.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
const clipActive = (c, t) => t >= c.start && t < clipEnd(c);
const topClipAt = t => state.clips.find(c => clipActive(c, t)) || null;
const srcTime = (c, t) => c.in + (t - c.start);
// How far through its own span a clip is, 0..1 — the phase a still's slow move runs on.
const clipPhase = (c, t) => (t - c.start) / Math.max(1e-6, clipDur(c));

function safeRect() {
  const s = SAFE[state.ratio];
  const W = canvas.width, H = canvas.height;
  return { x: s.l * W, y: s.t * H, w: W * (1 - s.l - s.r), h: H * (1 - s.t - s.b) };
}

// ---------- rendering ----------

function setRatio(r) {
  state.ratio = r;
  const [w, h] = RATIOS[r];
  const scale = PREVIEW_SCALE[state.hq ? 'hq' : 'lq'];
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.style.aspectRatio = `${w} / ${h}`;
  document.querySelectorAll('#ratioSeg button').forEach(b =>
    b.classList.toggle('on', b.dataset.ratio === r));
  draw();
}

function drawGuides() {
  const r = safeRect();
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.26)';
  ctx.setLineDash([9, 7]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  if (snapEdges) {
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(120,220,255,0.9)';
    if (snapEdges.v !== null) {
      ctx.beginPath(); ctx.moveTo(snapEdges.v, 0); ctx.lineTo(snapEdges.v, canvas.height); ctx.stroke();
    }
    if (snapEdges.h !== null) {
      ctx.beginPath(); ctx.moveTo(0, snapEdges.h); ctx.lineTo(canvas.width, snapEdges.h); ctx.stroke();
    }
  }
  ctx.restore();
}

let paintedFrame = null;   // the top-layer frame currently on screen

// What the top layer should be showing right now, or null if it has nothing decoded yet.
function topFrameNow() {
  const top = topClipAt(state.t);
  if (!top?.media?.ready) return null;
  return top.media.frameAt(srcTime(top, state.t));
}

function draw() {
  // If the top layer has no decoded frame yet, hold the last painted frame rather than
  // repainting the background — that is what produced the black flashing before.
  const top = topClipAt(state.t);
  if (top?.media?.ready && !top.media.frameAt(srcTime(top, state.t))) {
    updatePlayheadUI();
    return;
  }
  paintedFrame = topFrameNow();

  const sources = [];
  for (let i = state.clips.length - 1; i >= 0; i--) {
    const c = state.clips[i];
    if (!clipActive(c, state.t) || !c.media?.ready) continue;
    const f = c.media.frameAt(srcTime(c, state.t));
    if (!f) continue;
    sources.push({
      vw: f.canvas.width, vh: f.canvas.height, panX: c.panX, panY: c.panY,
      move: c.still ? c.move : null, u: clipPhase(c, state.t),
      draw: (cx, dx, dy, dw, dh) => cx.drawImage(f.canvas, dx, dy, dw, dh),
    });
  }
  textBoxes = drawFrame(ctx, canvas.width, canvas.height, sources, state.texts, state.t);

  // Nothing but the frame itself while playing: safe zones and selection boxes are editing
  // furniture, and the export never paints them. Playback is the proof of what you get.
  if (!state.playing) {
    if (state.guides) drawGuides();

    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 5]);
    for (const key of state.sel) {
      const box = key.startsWith('text:') && textBoxes.get(+key.slice(5));
      if (box) ctx.strokeRect(box.x - 5, box.y - 5, box.w + 10, box.h + 10);
    }
    ctx.setLineDash([]);
  }
  updatePlayheadUI();
}

// ---------- playback ----------
// The audio context is the master clock: it advances in real time whether or not any clip
// has sound, and never stalls behind a decoder.

let audioNodes = [];
let clockBase = { ctxTime: 0, t: 0 };

function stopAudio() {
  for (const n of audioNodes) { try { n.stop(); } catch {} n.disconnect(); }
  audioNodes = [];
}

function startAudio() {
  stopAudio();
  const t = state.t;
  const now = audioCtx.currentTime + 0.05;
  for (const c of state.clips) {
    if (c.muted || !c.media?.audio) continue;
    if (clipEnd(c) <= t) continue;
    const buf = c.media.audio;
    const offset = c.in + Math.max(0, t - c.start);
    if (offset >= buf.duration) continue;
    const dur = Math.min(clipEnd(c) - Math.max(t, c.start), buf.duration - offset);
    if (dur <= 0) continue;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start(now + Math.max(0, c.start - t), offset, dur);
    audioNodes.push(src);
  }
  clockBase = { ctxTime: now, t };
}

function setPlaying(p) {
  if (!state.clips.length) p = false;
  if (p === state.playing) return;
  state.playing = p;
  $('playBtn').textContent = p ? 'Pause' : 'Play';
  if (p) {
    if (state.t >= totalDur() - 0.03) state.t = 0;
    audioCtx.resume();
    startAudio();
  } else {
    stopAudio();
  }
  updateLayerWin();
  draw();   // guides and selection boxes go away on play and come back on pause
}

function applySeek(t, autoScroll = true) {
  state.t = Math.max(0, Math.min(t, Math.max(0, totalDur() - 0.001)));
  if (state.playing) startAudio();
  draw();
  if (autoScroll) scrollPlayheadIntoView();
}

let pendingScrub = null;
let scrubbing = false;

function tick(ts) {
  if (pendingScrub !== null) {
    const t = pendingScrub;
    pendingScrub = null;
    applySeek(t, false);
  }

  if (state.playing) {
    state.t = Math.max(clockBase.t, clockBase.t + (audioCtx.currentTime - clockBase.ctxTime));
    if (state.t >= totalDur()) {
      // Looping runs the clock back rather than parking on the black past the last frame.
      if (state.loop && totalDur() > 0.05) { state.t = 0; startAudio(); }
      else { state.t = totalDur(); setPlaying(false); }
    }
    draw();
  } else if (topFrameNow() !== paintedFrame) {
    // A decode finished while paused (a scrub landing, or a clip just loaded) — show it.
    draw();
  }

  // Steer each clip's decoder at the playhead, and pre-roll clips about to come in.
  for (const c of state.clips) {
    if (!c.media?.ready) continue;
    if (clipActive(c, state.t)) c.media.ensure(srcTime(c, state.t));
    else if (c.start > state.t && c.start - state.t < 2) c.media.ensure(c.in);
  }

  refreshCacheIfDue(ts);
  requestAnimationFrame(tick);
}

// ---------- media loading ----------

// Videos and stills land on the same track and behave the same once they are there: a still is
// just a clip whose source happens to hold one frame and no sound, given a default length you
// then trim like any other block.
async function addFiles(files, { at = null, history = true } = {}) {
  const accepted = [...files].filter(file =>
    file.type.startsWith('image/') || file.type.startsWith('video/'));
  if (!accepted.length) return;
  if (history) checkpoint('add media');
  let dropAt = Number.isFinite(at) ? Math.max(0, at) : null;

  for (const file of accepted) {
    const still = file.type.startsWith('image/');
    const clip = {
      id: uid++, file, still,
      name: file.name.replace(/\.[^.]+$/, ''),
      media: null, srcDur: 0, start: 0, in: 0, out: 0,
      panX: 0, panY: 0, move: 'auto', muted: false,
      el: null, assetEl: null, thumbEl: null, loading: true,
    };
    state.clips.push(clip);
    rebuildTimeline();

    const media = still ? await new ImageMedia(file).load()
                        : await new ClipMedia(file).load(audioCtx);
    // The user may have undone the import while a decoder was opening the file.
    const current = state.clips.find(c => c.id === clip.id);
    if (!current) { media.destroy(); continue; }
    current.media = media;
    current.loading = false;
    if (media.error) { rebuildTimeline(); continue; }

    current.srcDur = media.duration;
    current.out = still ? STILL_DUR : media.duration;
    current.start = dropAt ?? state.clips.filter(c => c !== current && !c.media?.error)
      .reduce((m, c) => Math.max(m, clipEnd(c)), 0);
    if (dropAt !== null) dropAt += clipDur(current);
    $('dropHint').classList.add('hidden');
    media.ensure(current.in);
    rebuildTimeline();
    draw();
    // audio decodes in the background; fold it in when it lands
    media.audioPromise?.then(() => {
      const live = state.clips.find(c => c.id === clip.id);
      if (live && selectedClipId() === live.id) updateMuteBtn(live);
      if (state.playing) startAudio();
    });
  }
}

// Swap the source beneath a clip while preserving where it starts, how long it lasts, and its
// crop/motion settings. A shorter video is the one exception: it cannot extend past its source.
async function replaceClipMedia(clip, file, { history = true } = {}) {
  if (!clip || !file || !(file.type.startsWith('image/') || file.type.startsWith('video/'))) return;
  if (history) checkpoint('replace media');

  const id = clip.id;
  const token = Symbol('replace');
  const keepDur = clipDur(clip);
  clip.loadToken = token;
  clip.loading = true;
  rebuildTimeline();

  const still = file.type.startsWith('image/');
  const media = still ? await new ImageMedia(file).load()
                      : await new ClipMedia(file).load(audioCtx);
  const current = state.clips.find(c => c.id === id);
  if (!current || current.loadToken !== token) { media.destroy(); return; }
  current.loading = false;
  delete current.loadToken;
  if (media.error) {
    media.destroy();
    rebuildTimeline();
    return;
  }

  current.file = file;
  current.name = file.name.replace(/\.[^.]+$/, '');
  current.still = still;
  current.media = media;
  current.srcDur = media.duration;
  current.in = still ? 0 : Math.min(current.in, Math.max(0, media.duration - MIN_CLIP));
  current.out = still ? current.in + keepDur : Math.min(media.duration, current.in + keepDur);
  current.muted = still ? false : current.muted;
  assetSig = '';
  media.ensure(current.in);
  $('dropHint').classList.add('hidden');
  syncInspector();
  rebuildTimeline();
  draw();
  media.audioPromise?.then(() => {
    const live = state.clips.find(c => c.id === id);
    if (live && selectedClipId() === id) updateMuteBtn(live);
    if (state.playing) startAudio();
  });
}

// The opening frame, so the story template has something to sit on before you drop anything.
async function loadDefaultMedia() {
  try {
    const res = await fetch(DEFAULT_MEDIA);
    if (!res.ok) return;
    const blob = await res.blob();
    if (state.clips.length) return;   // user dropped their own while this was in flight
    await addFiles([new File([blob], 'Kunstsilo.jpg', { type: blob.type || 'image/jpeg' })], { history: false });
    if (!state.texts.length) {
      addStory(false);
      selectText(null);   // open on the finished frame, not on a selection box
    }
  } catch {
    // no default asset available — the drop hint stands
  }
}

// ---------- text items ----------

// Defaults taken straight from the DOGA story template, normalised against its 1080×1920
// artboard so they land in the same relative place at either aspect ratio.
const N = (px, axis) => px / (axis === 'x' ? 1080 : 1920);
const PRESETS = {
  caption:  { text: 'Frå industrimoment til regional kraft: Kva kan vi lære av Kunstsilo?',
              x: N(60, 'x'), y: N(620, 'y'), size: 100, maxW: N(960, 'x'), dur: 5 },
  body:     { text: 'DOGA\nNedre Vollgate 4', x: N(60, 'x'), y: N(381, 'y'), size: 50, maxW: N(450, 'x'), dur: 5 },
  wordmark: { text: 'DOGA', x: N(60, 'x'), y: N(1602, 'y'), size: 50, maxW: N(400, 'x'), dur: 5 },
  pill:     { text: 'Arrangement', x: N(60, 'x'), y: N(270, 'y'), size: 40, maxW: 0.6, dur: 5 },
  arrow:    { text: '', x: N(970, 'x'), y: N(1602, 'y'), size: 48, maxW: 0.2, dur: 5 },
  scrim:    { text: '', x: 0, y: 0, size: 40, maxW: 1, dur: 5, opacity: 0.2 },
  label:    { text: 'Mount Etna, Sicily\nAug. 8', x: N(60, 'x'), y: N(90, 'y'), size: 34, maxW: 0.6, dur: 5 },
};

function makeItem(kind, at, overrides = {}) {
  return {
    id: uid++, kind,
    start: at,
    ...PRESETS[kind],
    ...overrides,
  };
}

// state.texts is ordered top layer first, so a new element lands on top of what is already
// there — except the overlay wash, which belongs under the type it exists to make legible.
function addText(kind, history = true) {
  if (history) checkpoint(`add ${KIND_INFO[kind]?.name?.toLowerCase() || 'element'}`);
  const at = Math.min(state.t, Math.max(0, totalDur() - 1));
  const item = makeItem(kind, at);
  if (kind === 'scrim') state.texts.push(item);
  else state.texts.unshift(item);
  selectText(item.id);
}

// Lays in the whole template at once. The headline is a three-card sequence across the story:
// 30% for the opening, 30% for the speaker card, and 40% for the short call to action. They are
// separate timeline layers, so each can still be retimed, rewritten and repositioned by hand.
function addStory(history = true) {
  if (history) checkpoint('add DOGA story');
  const at = Math.min(state.t, Math.max(0, totalDur() - 1));
  const dur = Math.max(2, Math.min(STORY_DUR, totalDur() - at || STORY_DUR));
  const firstDur = dur * 0.3;
  const secondDur = dur * 0.3;
  const thirdAt = at + firstDur + secondDur;
  const added = [
    makeItem('arrow', at, { dur, swap: true }),
    makeItem('wordmark', at, { dur, swap: true }),
    makeItem('caption', at, { dur: firstDur }),
    makeItem('caption', at + firstDur, {
      dur: secondDur,
      text: 'Foredrag med Nicolai Tangen og Anne Elisabeth Bull',
    }),
    makeItem('caption', thirdAt, {
      dur: at + dur - thirdAt,
      text: 'Link in Bio!',
    }),
    makeItem('body', at, { dur, text: '27. august, 2026\nkl. 09.00—10.30', x: N(550, 'x') }),
    makeItem('body', at, { dur }),
    makeItem('pill', at, { dur }),
    makeItem('scrim', at, { dur }),
  ];
  state.texts.unshift(...added);
  selectText(added[2].id);   // opening headline — the piece you almost always edit first
}

// Repaints the inspector from whatever is selected. Never touches the selection itself.
function syncInspector() {
  const n = state.sel.size;
  updateLayerWin();
  if (!n) return;

  if (n > 1) {
    $('textControls').style.display = 'none';
    $('clipControls').style.display = 'none';
    $('inspTitle').textContent = `${n} layers`;
    return;
  }

  const item = state.texts.find(t => t.id === selectedTextId());
  if (item) {
    const info = KIND_INFO[item.kind] || KIND_INFO.caption;
    $('textControls').style.display = '';
    $('clipControls').style.display = 'none';
    $('inspTitle').textContent = info.name;
    $('textInput').style.display = info.text ? '' : 'none';
    $('textInput').value = item.text || '';
    $('sizeInput').parentElement.style.display = info.size ? '' : 'none';
    $('sizeInput').min = item.kind === 'caption' ? 30 : 12;
    $('sizeInput').max = item.kind === 'caption' ? 160 : 120;
    $('sizeInput').value = item.size;
    $('sizeVal').textContent = item.size;
    $('widthInput').value = Math.round(item.maxW * 100);
    $('widthVal').textContent = Math.round(item.maxW * 100) + '%';
    $('widthCtl').style.display = info.width ? '' : 'none';
    $('opacityCtl').style.display = info.opacity ? '' : 'none';
    $('opacityInput').value = Math.round((item.opacity ?? 0.2) * 100);
    $('opacityVal').textContent = Math.round((item.opacity ?? 0.2) * 100) + '%';
    $('swapBtn').style.display = info.swap ? '' : 'none';
    $('swapBtn').classList.toggle('on', !!item.swap);
    return;
  }

  const clip = state.clips.find(c => c.id === selectedClipId());
  if (clip) {
    $('textControls').style.display = 'none';
    $('clipControls').style.display = '';
    $('inspTitle').textContent = clip.name.length > 18 ? clip.name.slice(0, 18) + '…' : clip.name;
    $('durInput').value = clipDur(clip).toFixed(1);
    $('durInput').max = (clip.srcDur - clip.in).toFixed(1);
    $('moveCtl').style.display = clip.still ? '' : 'none';
    $('moveInput').value = clip.move;
    $('replaceBtn').textContent = clip.still ? 'Replace picture…' : 'Replace media…';
    updateMuteBtn(clip);
  }
}

// Replace the whole selection with these keys.
function setSelection(keys) {
  state.sel = new Set(keys);
  if (state.sel.size) winClosed = false;   // a fresh selection brings the panel back
  syncInspector();
  rebuildTimeline();
  draw();
}

function selectText(id) {
  setSelection(id == null ? [] : [selKey('text', id)]);
  const item = state.texts.find(t => t.id === id);
  if (item && (state.t < item.start || state.t > item.start + item.dur)) {
    applySeek(item.start + Math.min(1.2, item.dur * 0.5));
  }
}

function selectClip(id) {
  setSelection(id == null ? [] : [selKey('clip', id)]);
}

function updateMuteBtn(clip) {
  const b = $('muteBtn');
  const pending = clip.media?.audioPending;
  const silent = !pending && !clip.media?.audio;
  b.textContent = pending ? 'Reading audio…'
    : clip.still ? 'Still image'
    : silent ? 'No audio track'
    : clip.muted ? 'Audio muted' : 'Mute audio';
  b.disabled = silent || pending;
  b.classList.toggle('on', clip.muted && !silent);
}

function deleteSelected() {
  if (!state.sel.size) return;
  checkpoint(state.sel.size > 1 ? 'delete layers' : 'delete layer');
  const clipIds = [];
  const textIds = new Set();
  for (const key of state.sel) {
    const [type, id] = key.split(':');
    if (type === 'clip') clipIds.push(+id); else textIds.add(+id);
  }
  state.texts = state.texts.filter(t => !textIds.has(t.id));
  state.sel = new Set();
  if (clipIds.length) removeClips(clipIds, { history: false });
  else { syncInspector(); rebuildTimeline(); draw(); }
}

// ---------- timeline UI ----------

const tl = $('tlScroll');
const rulerEl = $('ruler');
const clipTrack = $('clipTrack');
const textTrack = $('textTrack');
const PAD = 46;

function pps() {
  return Math.max(6, (tl.clientWidth - PAD - 20) / state.span);
}

function fmt(t) {
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

const sliderToSpan = v => SPAN_MIN * Math.pow(SPAN_MAX / SPAN_MIN, v / 1000);
const spanToSlider = s => 1000 * Math.log(s / SPAN_MIN) / Math.log(SPAN_MAX / SPAN_MIN);
const spanLabel = s => s >= 60
  ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
  : `${s.toFixed(s < 10 ? 1 : 0)}s`;

function viewAnchorTime() {
  const scale = pps();
  const phX = PAD + state.t * scale;
  if (phX >= tl.scrollLeft && phX <= tl.scrollLeft + tl.clientWidth) return state.t;
  return Math.max(0, (tl.scrollLeft + tl.clientWidth / 2 - PAD) / scale);
}

function setSpan(next, anchor = viewAnchorTime()) {
  const anchorX = PAD + anchor * pps() - tl.scrollLeft;
  state.span = Math.max(SPAN_MIN, Math.min(SPAN_MAX, next));
  $('zoomInput').value = Math.round(spanToSlider(state.span));
  $('spanLabel').textContent = spanLabel(state.span);
  rebuildTimeline();
  tl.scrollLeft = Math.max(0, PAD + anchor * pps() - anchorX);
}

// Moves the one selected layer up or down its own track. Rows are array order, so this is the
// same edit the vertical drag makes — index 0 is the top layer on both tracks.
function moveLayer(dir) {
  const picked = selectionItems();
  if (picked.length !== 1) return;
  const { type, item } = picked[0];
  const list = type === 'clip' ? state.clips : state.texts;
  const i = list.indexOf(item);
  const j = Math.max(0, Math.min(list.length - 1, i + dir));
  if (i < 0 || i === j) return;
  checkpoint('reorder layer');
  list.splice(i, 1);
  list.splice(j, 0, item);
  rebuildTimeline();
  draw();
}

function rebuildTimeline() {
  const scale = pps();
  const contentDur = Math.max(totalDur(), state.span);
  const width = PAD + contentDur * scale + 40;

  rulerEl.innerHTML = '';
  rulerEl.style.width = width + 'px';
  const step = scale > 60 ? 1 : scale > 25 ? 2 : scale > 12 ? 5 : 10;
  for (let s = 0; s <= contentDur + 0.01; s += step) {
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.style.left = (PAD + s * scale) + 'px';
    tick.textContent = s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : s + 's';
    rulerEl.appendChild(tick);
  }

  clipTrack.querySelectorAll('.block').forEach(b => b.remove());
  clipTrack.style.width = width + 'px';
  clipTrack.style.height = (Math.max(1, state.clips.length) * LANE_H + 4) + 'px';
  state.clips.forEach((clip, i) => {
    const b = document.createElement('div');
    const bad = !!clip.media?.error;
    b.className = 'block clip' + (clip.still ? ' still' : '')
      + (isSel('clip', clip.id) ? ' selected' : '') + (bad ? ' bad' : '');
    b.dataset.key = selKey('clip', clip.id);
    b.style.left = (PAD + clip.start * scale) + 'px';
    b.style.top = (4 + i * LANE_H) + 'px';
    b.style.width = Math.max(24, (clipDur(clip) || 2) * scale) + 'px';
    b.innerHTML = `<span class="name"></span><span class="dur"></span>
      <span class="x" title="Remove">×</span>
      <span class="cache"></span>
      <span class="grip l"></span><span class="grip r"></span>`;
    b.querySelector('.name').textContent = clip.name;
    b.querySelector('.dur').textContent = clip.loading ? 'reading…'
      : bad ? clip.media.error
      : clipDur(clip).toFixed(1) + 's' + (clip.still ? ' · still' : clip.muted ? ' · muted' : '');
    b.querySelector('.x').addEventListener('pointerdown', e => {
      e.stopPropagation();
      removeClips([clip.id]);
    });
    b.addEventListener('pointerdown', e => blockDrag(e, b, { type: 'clip', clip, index: i }));
    clipTrack.appendChild(b);
    clip.el = b;
    paintCache(clip);
  });

  // One row per element, in array order — the row an element sits on is its layer, so trimming
  // or retiming it never moves it off the row you put it on.
  textTrack.querySelectorAll('.block').forEach(b => b.remove());
  textTrack.style.width = width + 'px';
  textTrack.style.height = (Math.max(1, state.texts.length) * LANE_H + 4) + 'px';
  state.texts.forEach((item, i) => {
    const b = document.createElement('div');
    b.className = `block text k-${item.kind}` + (isSel('text', item.id) ? ' selected' : '');
    b.dataset.key = selKey('text', item.id);
    b.style.left = (PAD + item.start * scale) + 'px';
    b.style.top = (4 + i * LANE_H) + 'px';
    b.style.width = Math.max(24, item.dur * scale) + 'px';
    b.innerHTML = `<span class="name"></span><span class="x" title="Remove">×</span><span class="grip l"></span><span class="grip r"></span>`;
    const info = KIND_INFO[item.kind] || KIND_INFO.caption;
    b.querySelector('.name').textContent = item.text
      ? `${info.name}: ${item.text.split('\n')[0]}`
      : info.name;
    b.querySelector('.x').addEventListener('pointerdown', e => {
      e.stopPropagation();
      state.sel = new Set([selKey('text', item.id)]);
      deleteSelected();
    });
    b.addEventListener('pointerdown', e => blockDrag(e, b, { type: 'text', item, index: i }));
    textTrack.appendChild(b);
  });

  rebuildAssets();
  updatePlayheadUI();
  $('exportBtn').disabled = !state.clips.some(c => c.media?.ready);
}

// ---------- asset overview ----------
// The Media tab's list of what is loaded. Every asset is a clip on the timeline, so dragging a
// row back to the clip track retimes that clip exactly where it is dropped. Click still selects
// it, and × removes it.

const assetList = $('assetList');
let assetSig = '';
const MEDIA_DRAG_TYPE = 'application/x-doga-media-id';

const assetMeta = clip => clip.loading ? 'reading…'
  : clip.media?.error ? clip.media.error
  : `${clipDur(clip).toFixed(1)}s · ${clip.still ? 'still' : 'video'}${clip.muted ? ' · muted' : ''}`;

// Paints the poster once and keeps it: the frame it came from may be evicted from the cache later.
function paintThumb(clip) {
  const el = clip.thumbEl;
  if (!el || el.dataset.painted || !clip.media?.ready) return;
  const f = clip.media.frameAt(clip.in);
  if (!f) return;
  const c = el.getContext('2d');
  const s = Math.max(el.width / f.canvas.width, el.height / f.canvas.height);
  const dw = f.canvas.width * s, dh = f.canvas.height * s;
  c.drawImage(f.canvas, (el.width - dw) / 2, (el.height - dh) / 2, dw, dh);
  el.dataset.painted = '1';
}

function buildAssetRows() {
  assetList.innerHTML = '';
  if (!state.clips.length) {
    assetList.innerHTML = '<p class="hint">Nothing loaded yet.</p>';
    return;
  }
  for (const clip of state.clips) {
    const row = document.createElement('div');
    row.className = 'asset';
    row.draggable = !clip.loading && !clip.media?.error;
    row.title = row.draggable ? 'Drag to place on the timeline' : '';
    row.innerHTML = `<canvas class="thumb" width="80" height="80"></canvas>
      <span class="meta"><b></b><i></i></span>
      <span class="x" title="Remove">×</span>`;
    row.querySelector('b').textContent = clip.name;
    row.querySelector('.x').addEventListener('click', e => {
      e.stopPropagation();
      removeClips([clip.id]);
    });
    row.addEventListener('click', () => selectClip(clip.id));
    row.addEventListener('dragstart', e => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(MEDIA_DRAG_TYPE, String(clip.id));
      e.dataTransfer.setData('text/plain', `doga-media:${clip.id}`);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      clipTrack.classList.remove('media-dragover');
    });
    assetList.appendChild(row);
    clip.assetEl = row;
    clip.thumbEl = row.querySelector('.thumb');
    paintThumb(clip);
  }
}

// Rebuilds the rows only when the set of clips actually changes; the mutable bits — duration,
// selection — are cheap enough to refresh in place on every timeline rebuild.
function rebuildAssets() {
  const sig = state.clips.map(c => `${c.id}:${c.loading}:${!!c.media?.error}`).join('|');
  if (sig !== assetSig) { assetSig = sig; buildAssetRows(); }
  for (const clip of state.clips) {
    if (!clip.assetEl) continue;
    clip.assetEl.classList.toggle('selected', isSel('clip', clip.id));
    clip.assetEl.querySelector('i').textContent = assetMeta(clip);
  }
}

function isMediaDrag(dataTransfer) {
  return !!dataTransfer && [...dataTransfer.types].includes(MEDIA_DRAG_TYPE);
}

function timelineTimeAt(clientX) {
  const r = tl.getBoundingClientRect();
  return Math.max(0, (clientX - r.left + tl.scrollLeft - PAD) / pps());
}

// Native drag-and-drop is used here rather than a second pointer-drag implementation so file
// drags from Finder and media-row drags share the same target and feedback.
tl.addEventListener('dragover', e => {
  if (!isMediaDrag(e.dataTransfer)) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'move';
  const r = clipTrack.getBoundingClientRect();
  clipTrack.style.setProperty('--drop-x', `${Math.max(PAD, e.clientX - r.left)}px`);
  clipTrack.classList.add('media-dragover');
});

tl.addEventListener('dragleave', e => {
  if (!tl.contains(e.relatedTarget)) clipTrack.classList.remove('media-dragover');
});

tl.addEventListener('drop', e => {
  if (!isMediaDrag(e.dataTransfer)) return;
  e.preventDefault();
  e.stopPropagation();
  clipTrack.classList.remove('media-dragover');
  const clip = state.clips.find(c => c.id === +e.dataTransfer.getData(MEDIA_DRAG_TYPE));
  if (!clip) return;

  const beforeDrop = captureSnapshot();
  clip.start = timelineTimeAt(e.clientX);
  const r = clipTrack.getBoundingClientRect();
  const lane = Math.max(0, Math.min(state.clips.length - 1,
    Math.floor((e.clientY - r.top) / LANE_H)));
  const oldLane = state.clips.indexOf(clip);
  if (oldLane !== lane) {
    state.clips.splice(oldLane, 1);
    state.clips.splice(lane, 0, clip);
  }
  commitSnapshot(beforeDrop, 'place media');
  selectClip(clip.id);
  if (state.playing) startAudio();
});

// Green = frames decoded and sitting in RAM, ready to paint this instant. Not bytes read.
function paintCache(clip) {
  const el = clip.el?.querySelector('.cache');
  if (!el || !clip.media?.ready) return;
  const dur = clipDur(clip);
  if (dur <= 0) { el.innerHTML = ''; return; }
  let html = '';
  for (const [a, b] of clip.media.coverage()) {
    const s = Math.max(a, clip.in);
    const e = Math.min(b, clip.out);
    if (e <= s) continue;
    html += `<i style="left:${((s - clip.in) / dur) * 100}%;width:${Math.max(0.4, ((e - s) / dur) * 100)}%"></i>`;
  }
  el.innerHTML = html;
}

let lastCacheAt = 0;
function refreshCacheIfDue(ts) {
  if (ts - lastCacheAt < 200) return;
  lastCacheAt = ts;
  state.clips.forEach(c => { paintCache(c); paintThumb(c); });
  const pct = Math.round((cacheBytes() / cacheBudget()) * 100);
  $('cacheLabel').textContent = `${(cacheBytes() / 1e6).toFixed(0)} MB${pct >= 95 ? ' (full)' : ''}`;
}

function updatePlayheadUI() {
  $('playhead').style.left = (PAD + state.t * pps()) + 'px';
  $('timecode').textContent = `${fmt(state.t)} / ${fmt(totalDur())}`;
  if (state.playing && !scrubbing) scrollPlayheadIntoView();
}

function scrollPlayheadIntoView() {
  const x = PAD + state.t * pps();
  const margin = 60;
  if (x < tl.scrollLeft + margin) tl.scrollLeft = Math.max(0, x - margin);
  else if (x > tl.scrollLeft + tl.clientWidth - margin) tl.scrollLeft = x - tl.clientWidth + margin;
}

function removeClips(ids, { history = true } = {}) {
  const gone = new Set(ids);
  if (history && state.clips.some(c => gone.has(c.id))) {
    checkpoint(ids.length > 1 ? 'remove media' : 'remove media');
  }
  // Decoded media stays alive while an undo snapshot refers to it. It is released when that
  // snapshot falls off the bounded history, or when undo displaces it for good.
  state.clips = state.clips.filter(c => !gone.has(c.id));
  for (const id of ids) state.sel.delete(selKey('clip', id));
  if (!state.clips.length) { $('dropHint').classList.remove('hidden'); setPlaying(false); }
  state.t = Math.min(state.t, totalDur());
  if (state.playing) startAudio();
  syncInspector();
  rebuildTimeline();
  draw();
}

// Dragging a block body retimes everything selected together; dragging a grip always trims the
// one block you grabbed. Shift or ⌘ on a block toggles it in the selection instead of dragging.
function blockDrag(e, el, info) {
  e.preventDefault();
  const grip = e.target.classList.contains('grip') ? (e.target.classList.contains('l') ? 'l' : 'r') : null;
  const key = info.type === 'clip' ? selKey('clip', info.clip.id) : selKey('text', info.item.id);
  const additive = e.shiftKey || e.metaKey || e.ctrlKey;

  if (additive && !grip) {
    const next = new Set(state.sel);
    if (next.has(key)) next.delete(key); else next.add(key);
    setSelection(next);
    return;
  }
  // Grabbing something outside the selection makes it the selection before the drag starts.
  if (!state.sel.has(key)) setSelection([key]);

  const scale = pps();
  const x0 = e.clientX;
  const y0 = e.clientY;
  let moved = false;
  const orig = info.type === 'clip'
    ? { start: info.clip.start, in: info.clip.in, out: info.clip.out, index: info.index }
    : { start: info.item.start, dur: info.item.dur, index: info.index };
  const group = grip ? [] : selectionItems();
  const groupMin = group.length ? Math.min(...group.map(g => g.start)) : 0;
  const beforeDrag = captureSnapshot();

  const onMove = ev => {
    const dx = (ev.clientX - x0) / scale;
    if (Math.abs(ev.clientX - x0) > 3 || Math.abs(ev.clientY - y0) > 6) moved = true;
    if (!moved) return;

    if (!grip) {
      // One shift for the whole group, clamped so the earliest block stops at zero.
      const shift = Math.max(dx, -groupMin);
      for (const g of group) g.item.start = g.start + shift;
      // Layer order only changes when a single block is being dragged on its own. Both tracks
      // reorder the same way: rows are array order, and a block stays on its own track.
      if (group.length === 1) {
        const list = info.type === 'clip' ? state.clips : state.texts;
        const obj = info.type === 'clip' ? info.clip : info.item;
        const laneShift = Math.round((ev.clientY - y0) / LANE_H);
        const newIndex = Math.max(0, Math.min(list.length - 1, orig.index + laneShift));
        const curIndex = list.indexOf(obj);
        if (curIndex >= 0 && newIndex !== curIndex) {
          list.splice(curIndex, 1);
          list.splice(newIndex, 0, obj);
        }
      }
    } else if (info.type === 'text') {
      if (grip === 'r') info.item.dur = Math.max(0.4, orig.dur + dx);
      else {
        const shift = Math.min(Math.max(dx, -orig.start), orig.dur - 0.4);
        info.item.start = orig.start + shift;
        info.item.dur = orig.dur - shift;
      }
    } else {
      const c = info.clip;
      if (grip === 'l' && c.still) {
        // A still holds the same frame everywhere, so its head trims against the timeline only.
        const shift = Math.max(-orig.start, Math.min(dx, orig.out - orig.in - MIN_CLIP));
        c.start = orig.start + shift;
        c.out = orig.out - shift;
      } else if (grip === 'l') {
        const shift = Math.max(-orig.in, -orig.start, Math.min(dx, orig.out - MIN_CLIP - orig.in));
        c.in = orig.in + shift;
        c.start = orig.start + shift;
      } else {
        c.out = Math.max(Math.min(c.srcDur, orig.out + dx), c.in + MIN_CLIP);
      }
    }

    if (info.type === 'clip' && selectedClipId() === info.clip.id) {
      $('durInput').value = clipDur(info.clip).toFixed(1);
    }
    rebuildTimeline();
    draw();
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    const touchedClip = info.type === 'clip' || group.some(g => g.type === 'clip');
    if (moved) commitSnapshot(beforeDrag, grip ? 'trim layer' : 'move layer');
    if (moved && touchedClip && state.playing) startAudio();
    if (!moved) {
      if (info.type === 'text') selectText(info.item.id);
      else selectClip(info.clip.id);
    }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

// ---------- marquee ----------
// Drag anywhere in the empty timeline to rubber-band a selection across both tracks. The band
// lives inside the scrolling content, so its coordinates are content-space and stay put if the
// tracks scroll under it; the hit test runs in viewport space against the block rects.

const marqueeEl = $('marquee');

function marqueeDrag(e) {
  if (e.target.closest('.block') || e.target.closest('#ruler')) return;
  e.preventDefault();
  const r0 = tl.getBoundingClientRect();
  const ax = e.clientX - r0.left + tl.scrollLeft;
  const ay = e.clientY - r0.top + tl.scrollTop;
  const additive = e.shiftKey || e.metaKey || e.ctrlKey;
  const base = additive ? new Set(state.sel) : new Set();
  let pending = base;
  let moved = false;

  const onMove = ev => {
    const r = tl.getBoundingClientRect();
    const bx = ev.clientX - r.left + tl.scrollLeft;
    const by = ev.clientY - r.top + tl.scrollTop;
    const x = Math.min(ax, bx), y = Math.min(ay, by);
    const w = Math.abs(bx - ax), h = Math.abs(by - ay);
    if (w > 3 || h > 3) moved = true;
    if (!moved) return;

    marqueeEl.hidden = false;
    marqueeEl.style.left = x + 'px';
    marqueeEl.style.top = y + 'px';
    marqueeEl.style.width = w + 'px';
    marqueeEl.style.height = h + 'px';

    const band = {
      l: r.left - tl.scrollLeft + x, t: r.top - tl.scrollTop + y,
      r: r.left - tl.scrollLeft + x + w, b: r.top - tl.scrollTop + y + h,
    };
    pending = new Set(base);
    for (const block of tl.querySelectorAll('.block')) {
      const q = block.getBoundingClientRect();
      if (q.right >= band.l && q.left <= band.r && q.bottom >= band.t && q.top <= band.b) {
        pending.add(block.dataset.key);
      }
      // Repaint the highlight in place — rebuilding the tracks here would drop the drag.
      block.classList.toggle('selected', pending.has(block.dataset.key));
    }
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    marqueeEl.hidden = true;
    if (moved) setSelection(pending);
    else if (!additive) setSelection([]);   // a bare click on empty track deselects
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

tl.addEventListener('pointerdown', marqueeDrag);

rulerEl.addEventListener('pointerdown', e => {
  const scrub = ev => {
    const x = ev.clientX - rulerEl.getBoundingClientRect().left - PAD;
    pendingScrub = x / pps();
  };
  scrubbing = true;
  scrub(e);
  const onMove = ev => scrub(ev);
  const onUp = () => {
    scrubbing = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
});

// ---------- canvas interactions ----------

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (canvas.width / r.width),
    y: (e.clientY - r.top) * (canvas.height / r.height),
  };
}

canvas.addEventListener('pointerdown', e => {
  const p = canvasPos(e);
  let hit = null;
  for (const [id, b] of textBoxes) {
    if (p.x >= b.x - 8 && p.x <= b.x + b.w + 8 && p.y >= b.y - 8 && p.y <= b.y + b.h + 8) hit = id;
  }

  if (hit) {
    if (selectedTextId() !== hit) selectText(hit);
    const item = state.texts.find(t => t.id === hit);
    // A looping element is drawn away from its own x; drag against where it actually sits and
    // take that displacement back off before storing, so it doesn't jump under the pointer.
    const lift = textBoxes.get(item.id) || {};
    const ox = lift.ox || 0;
    const oy = lift.oy || 0;
    const off = { x: p.x - (item.x * canvas.width + ox), y: p.y - (item.y * canvas.height + oy) };
    const beforeMove = captureSnapshot();
    let moved = false;
    dragCanvas(e, ev => {
      moved = true;
      const q = canvasPos(ev);
      const box = textBoxes.get(item.id);
      const bw = box ? box.w : 0;
      const bh = box ? box.h : 0;
      const r = safeRect();
      let nx = q.x - off.x;
      let ny = q.y - off.y;
      let sv = null, sh = null;

      if (Math.abs(nx - r.x) < SNAP_PX) { nx = r.x; sv = r.x; }
      else if (Math.abs(nx + bw - (r.x + r.w)) < SNAP_PX) { nx = r.x + r.w - bw; sv = r.x + r.w; }
      if (Math.abs(ny - r.y) < SNAP_PX) { ny = r.y; sh = r.y; }
      else if (Math.abs(ny + bh - (r.y + r.h)) < SNAP_PX) { ny = r.y + r.h - bh; sh = r.y + r.h; }
      snapEdges = (sv !== null || sh !== null) ? { v: sv, h: sh } : null;

      item.x = Math.min(1 - bw / canvas.width, Math.max(0, (nx - ox) / canvas.width));
      item.y = Math.min(1 - bh / canvas.height, Math.max(0, (ny - oy) / canvas.height));
      draw();
    }, () => {
      snapEdges = null;
      if (moved) commitSnapshot(beforeMove, 'move element');
      draw();
    });
    return;
  }

  const clip = topClipAt(state.t);
  if (clip?.media?.ready) {
    const start = { x: p.x, y: p.y, panX: clip.panX, panY: clip.panY };
    const beforePan = captureSnapshot();
    let moved = false;
    // A still is drawn at its move's zoom, so the drag has to work against that same scale.
    const m = clip.still
      ? stillMotion(clip.move, clipPhase(clip, state.t), clip.media.width, clip.media.height,
                    canvas.width, canvas.height)
      : null;
    const s = Math.max(canvas.width / clip.media.width, canvas.height / clip.media.height)
      * (m?.zoom || 1);
    const ox = clip.media.width * s - canvas.width;
    const oy = clip.media.height * s - canvas.height;
    dragCanvas(e, ev => {
      moved = true;
      const q = canvasPos(ev);
      if (ox > 1) clip.panX = Math.max(-1, Math.min(1, start.panX - ((q.x - start.x) / ox) * 2));
      if (oy > 1) clip.panY = Math.max(-1, Math.min(1, start.panY - ((q.y - start.y) / oy) * 2));
      draw();
    }, () => { if (moved) commitSnapshot(beforePan, 'reposition media'); });
  }
});

function dragCanvas(e, onMove, onEnd) {
  e.preventDefault();
  const up = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', up);
    onEnd?.();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', up);
}

// ---------- inspector ----------

$('textInput').addEventListener('input', () => {
  const item = state.texts.find(t => t.id === selectedTextId());
  if (!item) return;
  item.text = $('textInput').value;
  rebuildTimeline();
  draw();
});
$('sizeInput').addEventListener('input', () => {
  const item = state.texts.find(t => t.id === selectedTextId());
  if (!item) return;
  item.size = +$('sizeInput').value;
  $('sizeVal').textContent = item.size;
  draw();
});
$('widthInput').addEventListener('input', () => {
  const item = state.texts.find(t => t.id === selectedTextId());
  if (!item) return;
  item.maxW = +$('widthInput').value / 100;
  $('widthVal').textContent = $('widthInput').value + '%';
  draw();
});
$('durInput').addEventListener('change', () => {
  const clip = state.clips.find(c => c.id === selectedClipId());
  if (!clip) return;
  const want = Math.max(MIN_CLIP, +$('durInput').value || MIN_CLIP);
  clip.out = Math.min(clip.srcDur, clip.in + want);
  $('durInput').value = clipDur(clip).toFixed(1);
  if (state.playing) startAudio();
  rebuildTimeline();
  draw();
});
$('moveInput').addEventListener('change', () => {
  const clip = state.clips.find(c => c.id === selectedClipId());
  if (!clip) return;
  clip.move = $('moveInput').value;
  draw();
});
$('swapBtn').addEventListener('click', () => {
  const item = state.texts.find(t => t.id === selectedTextId());
  if (!item) return;
  checkpoint('swap loop');
  item.swap = !item.swap;
  $('swapBtn').classList.toggle('on', item.swap);
  draw();
});
$('deleteBtn').addEventListener('click', deleteSelected);
$('replaceBtn').addEventListener('click', () => {
  if (selectedClipId() == null) return;
  $('replaceInput').click();
});
$('replaceInput').addEventListener('change', e => {
  const clip = state.clips.find(c => c.id === selectedClipId());
  const [file] = e.target.files;
  if (clip && file) replaceClipMedia(clip, file);
  e.target.value = '';
});
$('muteBtn').addEventListener('click', () => {
  const clip = state.clips.find(c => c.id === selectedClipId());
  if (!clip) return;
  checkpoint(clip.muted ? 'unmute media' : 'mute media');
  clip.muted = !clip.muted;
  updateMuteBtn(clip);
  if (state.playing) startAudio();
  rebuildTimeline();
});

// ---------- sidebar ----------

document.querySelectorAll('#ratioSeg button').forEach(b =>
  b.addEventListener('click', () => {
    if (state.ratio === b.dataset.ratio) return;
    checkpoint('change aspect ratio');
    setRatio(b.dataset.ratio);
  }));
$('zoomInput').addEventListener('input', e => setSpan(sliderToSpan(+e.target.value)));
$('zoomInput').addEventListener('dblclick', () => {
  setSpan(Math.max(2, totalDur() * 1.05), 0);
  tl.scrollLeft = 0;
});
$('hqBtn').addEventListener('click', () => {
  state.hq = !state.hq;
  $('hqBtn').classList.toggle('on', state.hq);
  setQuality(state.hq);      // re-decodes the frame cache at the new size
  setRatio(state.ratio);     // resizes the preview canvas and repaints
});
$('guidesBtn').addEventListener('click', () => {
  state.guides = !state.guides;
  $('guidesBtn').classList.toggle('on', state.guides);
  draw();
});
$('dropZone').addEventListener('click', () => { pickReplaces = false; $('fileInput').click(); });
$('fileInput').addEventListener('change', e => {
  const files = [...e.target.files];
  // The phone picker swaps its current picture in place, keeping story timing intact.
  if (pickReplaces && files[0] && state.clips.length === 1) {
    replaceClipMedia(state.clips[0], files[0]);
  } else if (pickReplaces && files.length) {
    checkpoint('replace media');
    removeClips(state.clips.map(c => c.id), { history: false });
    addFiles(files, { history: false });
  } else {
    addFiles(files);
  }
  pickReplaces = false;
  e.target.value = '';
});
$('addStoryBtn').addEventListener('click', addStory);
document.querySelectorAll('.btnGrid button').forEach(b =>
  b.addEventListener('click', () => addText(b.dataset.add)));
$('opacityInput').addEventListener('input', () => {
  const item = state.texts.find(t => t.id === selectedTextId());
  if (!item) return;
  item.opacity = +$('opacityInput').value / 100;
  $('opacityVal').textContent = $('opacityInput').value + '%';
  draw();
});

// Continuous fields create one undo step per editing gesture, rather than one per keystroke or
// slider pixel. Clicking Undo naturally blurs the field first, which commits that gesture.
let finishActiveControl = null;

function trackUndoableControl(id, label) {
  const el = $(id);
  let before = null;
  let dirty = false;
  const finish = () => {
    if (before && dirty) commitSnapshot(before, label);
    before = null;
    dirty = false;
    if (finishActiveControl === finish) finishActiveControl = null;
  };
  const begin = () => {
    if (before) return;
    finishActiveControl?.();
    before = captureSnapshot();
    finishActiveControl = finish;
  };
  el.addEventListener('pointerdown', begin);
  el.addEventListener('focus', begin);
  el.addEventListener('input', () => { dirty = true; });
  el.addEventListener('change', () => { dirty = true; finish(); });
  el.addEventListener('blur', finish);
}

trackUndoableControl('textInput', 'edit text');
trackUndoableControl('sizeInput', 'resize text');
trackUndoableControl('widthInput', 'resize text box');
trackUndoableControl('opacityInput', 'change opacity');
trackUndoableControl('durInput', 'change duration');
trackUndoableControl('moveInput', 'change motion');

$('playBtn').addEventListener('click', () => setPlaying(!state.playing));
$('loopBtn').addEventListener('click', () => {
  state.loop = !state.loop;
  $('loopBtn').classList.toggle('on', state.loop);
});

// ---------- drag & drop ----------

window.addEventListener('dragover', e => {
  e.preventDefault();
  if (!isMediaDrag(e.dataTransfer)) document.body.classList.add('dragover');
});
window.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragover'); });
window.addEventListener('drop', e => {
  e.preventDefault();
  document.body.classList.remove('dragover');
  if (isMediaDrag(e.dataTransfer)) return;
  const at = e.target.closest?.('#tlScroll') ? timelineTimeAt(e.clientX) : null;
  addFiles(e.dataTransfer.files, { at });
});

// ---------- keyboard ----------

window.addEventListener('keydown', e => {
  const typing = e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT';
  const inspectorField = !!e.target.closest?.('#layerWin');
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey
      && (!typing || inspectorField)) {
    e.preventDefault();
    finishActiveControl?.();
    undo();
    return;
  }
  if (e.code === 'Space' && !typing) { e.preventDefault(); setPlaying(!state.playing); }
  if ((e.code === 'Backspace' || e.code === 'Delete') && !typing) deleteSelected();
  if (e.code === 'ArrowLeft' && !typing) applySeek(state.t - (e.shiftKey ? 1 : 1 / 30));
  if (e.code === 'ArrowRight' && !typing) applySeek(state.t + (e.shiftKey ? 1 : 1 / 30));
  if ((e.code === 'ArrowUp' || e.code === 'ArrowDown') && e.altKey && !typing) {
    e.preventDefault();
    moveLayer(e.code === 'ArrowUp' ? -1 : 1);
  }
  if (e.code === 'Escape' && !layerWin.hidden) { winClosed = true; updateLayerWin(); }
  if ((e.key === '=' || e.key === '+') && !typing) setSpan(state.span / 1.3);
  if (e.key === '-' && !typing) setSpan(state.span * 1.3);
});
$('undoBtn').addEventListener('click', undo);

// ---------- export ----------

$('exportBtn').addEventListener('click', async () => {
  const usable = state.clips.filter(c => c.media?.ready);
  if (!usable.length) return;
  setPlaying(false);
  $('exportModal').hidden = false;
  $('exportTitle').textContent = 'Exporting…';
  $('exportBar').style.width = '0%';
  $('exportInfo').textContent = 'Preparing audio';
  $('exportSave').hidden = true;
  $('exportClose').hidden = true;

  const [W, H] = RATIOS[state.ratio];
  const spec = {
    W, H,
    totalDur: totalDur(),
    clips: usable.map(c => ({
      file: c.file, still: c.still, start: c.start, in: c.in, out: c.out,
      panX: c.panX, panY: c.panY, move: c.move, muted: c.muted,
    })),
    texts: state.texts.map(t => ({ ...t })),
  };

  const t0 = performance.now();
  try {
    const blob = await exportMovie(spec, (phase, f) => {
      const pct = phase === 'audio' ? f * 8 : 8 + f * 92;
      $('exportBar').style.width = pct.toFixed(1) + '%';
      $('exportInfo').textContent = phase === 'audio'
        ? 'Rendering audio'
        : `Rendering video · ${Math.round(f * 100)}%`;
    });
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    $('exportTitle').textContent = 'Done';
    $('exportInfo').textContent = `${W}×${H} · ${(blob.size / 1e6).toFixed(1)} MB · ${secs}s`;
    // Desktop should behave like a normal download and put the MP4 in the browser's Downloads
    // folder. Only the phone interface uses the share sheet: iOS Safari does not reliably honour
    // <a download> for blob URLs, and Save to Photos lives in that sheet.
    const file = new File([blob], 'doga-export.mp4', { type: 'video/mp4' });
    const a = $('exportSave');
    if (a.href) URL.revokeObjectURL(a.href);
    const shareOnPhone = document.body.classList.contains('phone')
      && navigator.canShare?.({ files: [file] });
    if (shareOnPhone) {
      a.textContent = 'Save video';
      a.removeAttribute('href');
      a.removeAttribute('download');
      a.onclick = () => { navigator.share({ files: [file] }).catch(() => {}); };
    } else {
      a.textContent = 'Download MP4';
      a.href = URL.createObjectURL(blob);
      a.download = 'doga-export.mp4';
      a.onclick = null;
    }
    a.hidden = false;
  } catch (err) {
    console.error(err);
    $('exportTitle').textContent = 'Export failed';
    $('exportInfo').textContent = err.message || String(err);
  }
  $('exportClose').hidden = false;
});
$('exportClose').addEventListener('click', () => { $('exportModal').hidden = true; });

// ---------- api ----------
// phone.js drives the same engine from a different set of controls. This is the whole surface
// it gets: no new state, no second render path, just the handles it needs to steer this one.

export const api = {
  state, canvas,
  draw, setRatio, setPlaying, applySeek, addFiles, removeClips, rebuildTimeline, addStory,
  totalDur, clipDur,
  boxes: () => textBoxes,
  exportNow: () => $('exportBtn').click(),
  pickFile: (accept, replace = false) => {
    $('fileInput').accept = accept;
    pickReplaces = replace;
    $('fileInput').click();
  },
};

// ---------- boot ----------

// Graphik ships with the project in fonts/. Canvas can only use a face once it is actually
// loaded, so the first paint waits on this; if a file is missing the stack in render.js falls
// back to whatever Graphik is installed on the machine.
const FONT_FACES = [
  ['fonts/Graphik-Regular.otf',       { weight: '400', style: 'normal' }],
  ['fonts/Graphik-RegularItalic.otf', { weight: '400', style: 'italic' }],
  ['fonts/Graphik-Medium.otf',        { weight: '500', style: 'normal' }],
  ['fonts/Graphik-MediumItalic.otf',  { weight: '500', style: 'italic' }],
];

async function loadFonts() {
  await Promise.all(FONT_FACES.map(async ([file, desc]) => {
    try {
      const face = new FontFace('DOGA Graphik', `url("${file}") format("opentype")`, desc);
      document.fonts.add(await face.load());
    } catch (err) {
      console.warn(`Graphik face not loaded: ${file}`, err);
    }
  }));
  try {
    await Promise.all([
      document.fonts.load(`400 44px ${FONT_STACK}`),
      document.fonts.load(`500 34px ${FONT_STACK}`),
    ]);
  } catch { /* fallback face is already usable */ }
  draw();
}

window.addEventListener('resize', () => {
  rebuildTimeline();
  if (!layerWin.hidden) placeLayerWin();   // keep the panel on screen
});
setRatio('9:16');
setSpan(state.span, 0);
loadFonts();
loadDefaultMedia();
requestAnimationFrame(tick);
