// Shared frame rendering — used identically by the live preview and the MP4 exporter.
//
// Element geometry follows the DOGA story template. Every measurement is expressed against a
// 1080-wide reference frame and scaled by k, so the half-res preview and the full-res export
// paint the same layout.

export const FONT_STACK = `'DOGA Graphik', Graphik, 'Graphik Wide', 'Helvetica Neue', Helvetica, Arial, sans-serif`;

export const CAPTION_CPS_ON = 85;    // average chars per second while typing on
export const CAPTION_CPS_OFF = 120;  // average chars per second while typing off
export const REF_W = 1080;
const FADE = 0.35;                   // seconds, for elements that fade rather than type

const easeInOut = x => x <= 0 ? 0 : x >= 1 ? 1 : (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

// Cover-fit rect for a source of vw×vh inside a W×H frame, with pan in [-1, 1] and an
// optional motion: extra scale plus a drift measured in frame widths. The offsets are clamped
// to what the cover leaves spare, so a drift can never pull an edge into frame.
export function coverRect(vw, vh, W, H, panX = 0, panY = 0, motion = null) {
  const s = Math.max(W / vw, H / vh) * (motion?.zoom || 1);
  const dw = vw * s;
  const dh = vh * s;
  const ox = dw - W;
  const oy = dh - H;
  const dx = -ox / 2 - (panX * ox) / 2 - (motion?.mx || 0) * W;
  const dy = -oy / 2 - (panY * oy) / 2 - (motion?.my || 0) * H;
  return { dx: Math.min(0, Math.max(-ox, dx)), dy: Math.min(0, Math.max(-oy, dy)), dw, dh };
}

// ---------------------------------------------------------------- still motion
// A still held perfectly still next to footage reads as a stall, so every image clip carries a
// slow move across its own length. TRAVEL doubles as the crop a pan needs: an image the shape
// of the frame has nowhere to travel until it is scaled up a little, so a pan always sits at
// that much extra zoom and crosses exactly the room it just bought.
const TRAVEL = 0.12;   // how far a pan crosses, as a fraction of the frame
const PUSH = 0.10;     // how much a push-in grows over the clip

// Linear on purpose — an eased move stalls at both ends, which is the moment you notice it.
const MOVES = {
  in:    u => ({ zoom: 1 + PUSH * u }),
  out:   u => ({ zoom: 1 + PUSH * (1 - u) }),
  left:  u => ({ zoom: 1 + TRAVEL, mx: TRAVEL * (0.5 - u) }),
  right: u => ({ zoom: 1 + TRAVEL, mx: TRAVEL * (u - 0.5) }),
  up:    u => ({ zoom: 1 + TRAVEL, my: TRAVEL * (0.5 - u) }),
  down:  u => ({ zoom: 1 + TRAVEL, my: TRAVEL * (u - 0.5) }),
};

// What 'auto' comes out as for this still: spare width or height is room to travel across,
// and an image close to the frame's own shape gets the push-in instead.
function resolveMove(move, vw, vh, W, H) {
  if (move !== 'auto') return move;
  const spare = (vw / vh) / (W / H);
  if (spare > 1 + TRAVEL) return 'right';
  if (spare < 1 / (1 + TRAVEL)) return 'down';
  return 'in';
}

const PAN_AXIS = { left: 'x', right: 'x', up: 'y', down: 'y' };

// Motion for a still u of the way (0..1) through its clip, or null if it holds.
export function stillMotion(move, u, vw, vh, W, H) {
  const key = resolveMove(move, vw, vh, W, H);
  const fn = MOVES[key];
  if (!fn) return null;
  const m = fn(Math.max(0, Math.min(1, u)));
  // A still the cover already crops on the panning axis has an edge of its own to travel
  // along, so it keeps its full scale — only a tight fit pays the extra crop.
  const axis = PAN_AXIS[key];
  if (axis) {
    const spare = axis === 'x' ? (vw / vh) / (W / H) : (W / H) / (vw / vh);
    if (spare >= 1 + TRAVEL) m.zoom = 1;
  }
  return m;
}

function wrapLines(ctx, text, font, maxWidth) {
  ctx.font = font;
  const out = [];
  for (const hard of text.split('\n')) {
    const words = hard.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const test = line + ' ' + words[i];
      if (ctx.measureText(test).width > maxWidth && line) { out.push(line); line = words[i]; }
      else line = test;
    }
    out.push(line);
  }
  return out;
}

// Eased fade for everything that is not the typewriter caption.
function fadeAlpha(item, t) {
  const inA = easeInOut((t - item.start) / FADE);
  const outA = easeInOut((item.start + item.dur - t) / FADE);
  return Math.max(0, Math.min(1, inA, outA));
}

// The reveal is a window over the characters rather than a count. The type-on runs the trailing
// edge forward through the text; the outro runs the leading edge after it, the same way. So the
// headline leaves in the order it arrived — first line first — instead of unwinding backwards.
function visibleRange(total, t, start, dur) {
  const to = easeInOut((t - start) / (total / CAPTION_CPS_ON)) * total;
  const offStart = start + dur - total / CAPTION_CPS_OFF;
  const from = easeInOut((t - offStart) / (total / CAPTION_CPS_OFF)) * total;
  return { from, to };
}

// ---------------------------------------------------------------- caption / H2
// Graphik 400 with a white highlight behind each line. The highlight follows the template's
// underline trick: thickness 120% at offset -100% is a bar 1.2em tall sitting 0.9em above the
// baseline. Lines advance by 133% (line-height 133/100), which leaves the small gap between
// bars that the design shows.
function drawCaption(ctx, item, t, W, H, k) {
  const size = item.size * k;
  const font = `400 ${size}px ${FONT_STACK}`;
  const padX = size * 0.18;
  const barH = size * 1.20;
  const advance = size * 1.33;
  const baselineDrop = size * 0.90;
  const maxW = item.maxW * W - padX * 2;

  const lines = wrapLines(ctx, item.text, font, maxW);
  const total = lines.reduce((n, l) => n + l.length, 0);
  if (!total) return null;

  const x = item.x * W;
  const y = item.y * H;
  const { from, to } = visibleRange(total, t, item.start, item.dur);

  ctx.font = font;
  ctx.textBaseline = 'alphabetic';

  // Width of a line's first n characters, interpolated through the character an edge is inside
  // so the edge glides rather than stepping from one letter to the next.
  const widthAt = (line, n) => {
    const whole = Math.floor(n);
    const w = ctx.measureText(line.slice(0, whole)).width;
    if (whole >= line.length) return w;
    return w + (ctx.measureText(line.slice(0, whole + 1)).width - w) * (n - whole);
  };

  // Each line takes its slice of the window; both edges keep the highlight's padding, so the
  // bar shrinks off the left exactly the way it grew on the right.
  let bboxW = 0;
  let seen = 0;
  const rows = lines.map((line, i) => {
    const a = Math.max(0, Math.min(line.length, from - seen));
    const b = Math.max(0, Math.min(line.length, to - seen));
    seen += line.length;
    bboxW = Math.max(bboxW, ctx.measureText(line).width + padX * 2);
    return {
      line,
      left: x + widthAt(line, a),
      right: x + widthAt(line, b) + padX * 2,
      on: b - a > 0.02,
      top: y + i * advance,
      baseline: y + i * advance + baselineDrop,
    };
  });

  ctx.fillStyle = item.bg || '#fff';
  for (const r of rows) if (r.on) ctx.fillRect(r.left, r.top, r.right - r.left, barH);
  ctx.fillStyle = item.fg || '#000';
  for (const r of rows) {
    if (!r.on) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.left, r.top, r.right - r.left, barH);
    ctx.clip();
    ctx.fillText(r.line, x + padX, r.baseline);
    ctx.restore();
  }
  return { x, y, w: bboxW, h: (lines.length - 1) * advance + barH };
}

// ---------------------------------------------------------------- body / H5 and wordmark
// Plain white Graphik. line-height 134% (67/50 in the template). y is the top of the line box,
// so the first baseline sits 0.95em down — half-leading plus ascent.
function drawTextBlock(ctx, item, t, W, H, k, weight) {
  const size = item.size * k;
  const font = `${weight} ${size}px ${FONT_STACK}`;
  const advance = size * 1.34;
  const maxW = (item.maxW || 0.9) * W;
  const lines = wrapLines(ctx, item.text, font, maxW);
  const x = item.x * W;
  const y = item.y * H;

  ctx.save();
  ctx.globalAlpha *= fadeAlpha(item, t);
  ctx.font = font;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = item.fg || '#fff';
  let w = 0;
  lines.forEach((line, i) => {
    ctx.fillText(line, x, y + size * 0.95 + i * advance);
    w = Math.max(w, ctx.measureText(line).width);
  });
  ctx.restore();
  return { x, y, w, h: (lines.length - 1) * advance + size * 1.34 };
}

// ---------------------------------------------------------------- category pill
// 1px white border, 4px radius, 20px padding at a 40px type size.
function drawPill(ctx, item, t, W, H, k) {
  const size = item.size * k;
  const pad = size * 0.5;
  const border = Math.max(1, size * 0.025);
  const radius = size * 0.1;
  const font = `400 ${size}px ${FONT_STACK}`;
  const x = item.x * W;
  const y = item.y * H;

  ctx.save();
  ctx.globalAlpha *= fadeAlpha(item, t);
  ctx.font = font;
  ctx.textBaseline = 'alphabetic';
  const tw = ctx.measureText(item.text).width;
  const w = tw + pad * 2;
  const h = size * 1.775;

  ctx.strokeStyle = item.fg || '#fff';
  ctx.lineWidth = border;
  ctx.beginPath();
  ctx.roundRect(x + border / 2, y + border / 2, w - border, h - border, radius);
  ctx.stroke();

  ctx.fillStyle = item.fg || '#fff';
  ctx.fillText(item.text, x + pad, y + h / 2 + size * 0.35);
  ctx.restore();
  return { x, y, w, h };
}

// ---------------------------------------------------------------- arrow
// Shaft across at 50% height plus a chevron on the right, 5px strokes on a 48.25px glyph.
function drawArrow(ctx, item, t, W, H, k) {
  const h = item.size * k;
  const w = h * 1.0259;
  const x = item.x * W;
  const y = item.y * H;
  const tipX = x + w * 0.9285;

  ctx.save();
  ctx.globalAlpha *= fadeAlpha(item, t);
  ctx.strokeStyle = item.fg || '#fff';
  ctx.lineWidth = h * 0.1036;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.beginPath();
  ctx.moveTo(x, y + h * 0.5);
  ctx.lineTo(tipX, y + h * 0.5);
  ctx.moveTo(x + w * 0.477, y + h * 0.0367);
  ctx.lineTo(tipX, y + h * 0.5);
  ctx.lineTo(x + w * 0.477, y + h * 0.9633);
  ctx.stroke();
  ctx.restore();
  return { x, y, w, h };
}

// ---------------------------------------------------------------- overlay (kind: scrim)
// The template's flat 20% black wash over the footage, so white type stays legible.
function drawScrim(ctx, item, t, W, H) {
  ctx.save();
  ctx.globalAlpha = fadeAlpha(item, t) * (item.opacity ?? 0.2);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
  return null;   // full-frame, never hit-tested — select it from the timeline
}

// ---------------------------------------------------------------- corner label (legacy)
function drawLabel(ctx, item, t, W, H, k) {
  const size = item.size * k;
  const x = item.x * W;
  const y = item.y * H;
  const lines = item.text.split('\n');
  ctx.save();
  ctx.globalAlpha *= fadeAlpha(item, t);
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = size * 0.35;
  ctx.shadowOffsetY = 1;
  let w = 0;
  let cy = y + size;
  lines.forEach((line, i) => {
    const s = i === 0 ? size : size * 0.9;
    ctx.font = `${i === 0 ? 500 : 400} ${s}px ${FONT_STACK}`;
    ctx.fillStyle = i === 0 ? '#fff' : 'rgba(255,255,255,0.92)';
    ctx.fillText(line, x, cy);
    w = Math.max(w, ctx.measureText(line).width);
    cy += s * 1.35;
  });
  ctx.restore();
  return { x, y, w, h: cy - y - size * 0.35 };
}

// ---------------------------------------------------------------- swap loop
// Elements on the loop trade places on a belt. Everything travels right along one eased curve
// and is masked out at the middle of it — the fastest part of the move — where it steps across
// to the slot it was heading for and slides into place from the left. Nothing is ever seen
// crossing anything else, so a pair reads as one continuous motion rather than two objects
// passing each other.
const SWAP_PERIOD = 2;      // seconds from one swap to the next
const SWAP_MOVE = 0.65;     // seconds the travel itself takes
const SWAP_RUN = 0.055;     // how far an element runs before the mask takes it, in frame widths
const SWAP_STAGGER = 0.11;  // seconds each element waits on the one to its left
const SWAP_TIMES = 3;       // swaps the loop runs before it settles for good

// Offset and opacity for each looping element at time t. `items` is sorted by x, `sizes` holds
// their measured boxes in the same order.
function swapPlan(items, sizes, t, W, H) {
  const last = items.length - 1;
  // The leftmost slot holds a left edge, the rightmost a right edge: an element lands flush
  // with the margin it is heading for instead of overrunning it, whatever it measures.
  const grip = i => (i === 0 ? 0 : i === last ? 1 : 0.5);
  const width = i => (sizes[i]?.w || 0) / W;
  const slots = items.map((it, i) => ({ y: it.y, grip: grip(i), edge: it.x + width(i) * grip(i) }));

  // Each element leaves a beat after the one to its left, so the pair reads as a sequence
  // rather than a single sliding object. The window is pulled back by the whole stagger, which
  // keeps the last one landing on the beat however many are riding.
  // The loop is a flourish, not a metronome: it trades places SWAP_TIMES and then holds,
  // rather than running for as long as the clip does.
  const done = Math.floor(t / SWAP_PERIOD);      // swaps behind us
  const held = done >= SWAP_TIMES;
  const n = Math.min(done, SWAP_TIMES);
  const lead = SWAP_PERIOD - SWAP_MOVE - SWAP_STAGGER * (items.length - 1);
  const run = SWAP_RUN * W;

  const plan = new Map();
  items.forEach((it, i) => {
    const u = held ? 0 : (t - done * SWAP_PERIOD - lead - SWAP_STAGGER * i) / SWAP_MOVE;
    const d = easeInOut(u) * run * 2;   // how far along the belt this one has carried
    const near = d < run;               // still on the near side of the mask
    const slot = slots[(i + n + (near ? 0 : 1)) % items.length];
    plan.set(it.id, {
      ox: (slot.edge - width(i) * slot.grip - it.x) * W + (near ? d : d - run * 2),
      oy: (slot.y - it.y) * H,
      alpha: near ? 1 - d / run : (d - run) / run,
    });
  });
  return plan;
}

const DRAW = {
  caption: drawCaption,
  body: (c, i, t, W, H, k) => drawTextBlock(c, i, t, W, H, k, 400),
  wordmark: (c, i, t, W, H, k) => drawTextBlock(c, i, t, W, H, k, 500),
  pill: drawPill,
  arrow: drawArrow,
  scrim: drawScrim,
  label: drawLabel,
};

// Which kinds take which inspector controls — app.js reads this so the two stay in step.
export const KIND_INFO = {
  caption:  { name: 'Headline',  text: true,  size: true, width: true,  swap: true },
  body:     { name: 'Text',      text: true,  size: true, width: true,  swap: true },
  wordmark: { name: 'Wordmark',  text: true,  size: true, width: false, swap: true },
  pill:     { name: 'Category',  text: true,  size: true, width: false, swap: true },
  arrow:    { name: 'Arrow',     text: false, size: true, width: false, swap: true },
  scrim:    { name: 'Overlay',   text: false, size: false, width: false, opacity: true },
  label:    { name: 'Label',     text: true,  size: true, width: false, swap: true },
};

// Draws all elements active at time t. Array order is layer order — index 0 is the top layer,
// the same convention the clip track uses — so paint from the bottom of the stack upwards.
// Returns a Map of element id -> bbox for hit-testing, in that same bottom-to-top order.
export function drawTexts(ctx, texts, t, W, H) {
  const k = W / REF_W;
  const boxes = new Map();
  // `hide` is what an editor sets while it has the element open somewhere else — the phone
  // editor lifts the type off the canvas and into a real input while you type.
  const live = it => !it.hide && t >= it.start && t < it.start + it.dur;
  const loop = texts.filter(it => it.swap && it.kind !== 'scrim' && live(it))
                    .sort((a, b) => a.x - b.x);

  // The loop is measured before it is placed — an element has to know its own width to land
  // flush against a margin. A pass at zero alpha paints nothing but still returns the boxes.
  let plan = null;
  if (loop.length > 1) {
    ctx.save();
    ctx.globalAlpha = 0;
    const sizes = loop.map(it => (DRAW[it.kind] || drawCaption)(ctx, it, t, W, H, k));
    ctx.restore();
    plan = swapPlan(loop, sizes, t, W, H);
  }

  for (let i = texts.length - 1; i >= 0; i--) {
    const item = texts[i];
    if (!live(item)) continue;
    const off = plan?.get(item.id);
    if (off && off.alpha <= 0.004) continue;   // masked out, and nothing to hit-test either
    ctx.save();
    if (off) ctx.globalAlpha = off.alpha;
    const placed = off ? { ...item, x: item.x + off.ox / W, y: item.y + off.oy / H } : item;
    const box = (DRAW[item.kind] || drawCaption)(ctx, placed, t, W, H, k);
    ctx.restore();
    if (box) boxes.set(item.id, off ? { ...box, ox: off.ox, oy: off.oy } : box);
  }
  return boxes;
}

// Full frame: black base, cover-fit video layers (bottom to top), elements on top.
export function drawFrame(ctx, W, H, sources, texts, t) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  for (const source of sources) {
    const motion = source.move
      ? stillMotion(source.move, source.u, source.vw, source.vh, W, H)
      : null;
    const { dx, dy, dw, dh } = coverRect(source.vw, source.vh, W, H, source.panX, source.panY, motion);
    source.draw(ctx, dx, dy, dw, dh);
  }
  return drawTexts(ctx, texts, t, W, H);
}
