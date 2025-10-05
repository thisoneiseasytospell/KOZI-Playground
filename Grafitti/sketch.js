import { HandLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest';

const canvas = document.getElementById('asciiCanvas');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');
const statusBadge = hud.querySelector('.status');
const spacingSlider = document.getElementById('spacingSlider');
const cameraToggle = document.getElementById('cameraToggle');

const COLS = 140;
const ROWS = 60;
const SHUFFLE_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*+-=;:!?';
const SHUFFLE_ARRAY = SHUFFLE_CHARSET.split('');

const rebellionQuotes = [
  'SPRAY THE SILENCE',
  'NO GODS NO GATES',
  'CODE IS PROTEST',
  'MAKE WALLS TALK',
  'WE PAINT THE NIGHT',
  'QUESTION EVERY WALL',
  'DECIBELS OVER DOGMA',
  'SYSTEMS BLEED SONGS',
  'ASCII NEVER SLEEPS',
  'RIFF UNTIL THE GRID LISTENS',
];

const state = {
  baseHue: Math.floor(Math.random() * 360),
  palette: ['@', '#', '%', '&', '*', '+', '=', ':', ';', '.'],
  brushSize: 3,
  quoteSpacing: 5,
};

const messageLayer = {
  chars: Array.from({ length: ROWS }, () => Array(COLS).fill(' ')),
  revealed: Array.from({ length: ROWS }, () => Array(COLS).fill(false)),
};

const noiseGrid = Array.from({ length: ROWS }, () => Array(COLS).fill(null));

let isDrawing = false;
let lastCell = null;
let handLandmarker = null;
let video = null;
let handActive = false;
let lastHandPoint = null;
let cameraEnabled = false;
let loadingHands = false;
let handFrameRequest = null;
let handStream = null;
let visionResolver = null;
let statusTimeoutId = null;
let spaceHeld = false;
let savedBrushSize = 3;
let eraseMode = false;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function randomChoice(array) {
  return array[Math.floor(Math.random() * array.length)];
}

let spacingUpdateId = null;
function handleSpacingInput(event) {
  const value = Number(event?.target?.value ?? event);
  if (!Number.isFinite(value)) return;
  state.quoteSpacing = value;
  if (spacingUpdateId) cancelAnimationFrame(spacingUpdateId);
  spacingUpdateId = requestAnimationFrame(() => {
    buildMessageField(true); // Preserve revealed state
    seedNoiseField();
    lastHandPoint = null;
    flashStatus(`spacing ${state.quoteSpacing}`);
    drawSurface();
    spacingUpdateId = null;
  });
}

function buildMessageField(preserveRevealed = false) {
  // Save current revealed state if requested
  const oldRevealed = preserveRevealed
    ? messageLayer.revealed.map(row => [...row])
    : null;

  messageLayer.chars = Array.from({ length: ROWS }, () => Array(COLS).fill(' '));
  messageLayer.revealed = Array.from({ length: ROWS }, () => Array(COLS).fill(false));

  for (let r = 0; r < ROWS; r += 1) {
    const quote = randomChoice(rebellionQuotes).toUpperCase();
    const words = quote.split(/\s+/).filter(Boolean);
    const sentenceSpacing = Math.max(0, Math.floor(state.quoteSpacing));
    const wordGap = 1; // Always 1 space between words
    let c = 0;

    while (c < COLS) {
      const word = words.length ? randomChoice(words) : quote;
      for (let i = 0; i < word.length && c < COLS; i += 1) {
        messageLayer.chars[r][c] = word[i];
        c += 1;
      }
      if (c >= COLS) break;

      // Add 1 space between words
      for (let gap = 0; gap < wordGap && c < COLS; gap += 1) {
        messageLayer.chars[r][c] = ' ';
        c += 1;
      }
      if (c >= COLS) break;

      // Add spacing between sentences (controlled by slider)
      for (let s = 0; s < sentenceSpacing && c < COLS; s += 1) {
        messageLayer.chars[r][c] = ' ';
        c += 1;
      }
    }
  }

  // Restore revealed state if requested
  if (oldRevealed) {
    messageLayer.revealed = oldRevealed;
  }
}

function createChaosCell(row, col, faint = false) {
  const hue = (state.baseHue + (Math.random() - 0.5) * 60 + 360) % 360;
  const lightness = faint ? 58 + Math.random() * 4 : 60 + Math.random() * 14;
  const alpha = faint ? 0.18 + Math.random() * 0.1 : 0.3 + Math.random() * 0.4;
  const glyph = randomChoice(state.palette.length ? state.palette : SHUFFLE_ARRAY);

  noiseGrid[row][col] = {
    glyph,
    hue,
    lightness,
    alpha,
    animateUntil: performance.now() + 200 + Math.random() * 200,
  };
}

function seedNoiseField() {
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const char = messageLayer.chars[r][c];
      const faint = char !== ' ';
      createChaosCell(r, c, faint);
    }
  }
}

function syncCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(width / rect.width, height / rect.height);
  return { width: rect.width, height: rect.height };
}

function drawSurface(now = performance.now()) {
  const { width, height } = syncCanvas();

  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, width, height);

  const colSize = width / COLS;
  const rowSize = height / ROWS;
  const fontSize = Math.min(colSize, rowSize) * 0.9;

  ctx.font = `${fontSize}px 'ABCDiatype', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowBlur = 14;

  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const revealed = messageLayer.revealed[r][c];
      const cell = noiseGrid[r][c];
      let glyph;
      let hue;
      let lightness;
      let alpha;

      if (revealed && messageLayer.chars[r][c] !== ' ') {
        glyph = messageLayer.chars[r][c];
        hue = (state.baseHue + 120 + Math.sin((r + c + now * 0.004)) * 30 + 360) % 360;
        lightness = 78 + Math.random() * 6;
        alpha = 0.95;
      } else {
        if (!cell || now > cell.animateUntil) {
          createChaosCell(r, c, messageLayer.chars[r][c] !== ' ');
        }
        const current = noiseGrid[r][c];
        glyph = current.glyph;
        hue = current.hue;
        lightness = current.lightness;
        alpha = current.alpha;
      }

      ctx.fillStyle = `hsl(${hue}, 85%, ${lightness}%)`;
      ctx.shadowColor = `hsla(${hue}, 100%, 62%, ${revealed ? 0.7 : 0.2})`;
      ctx.globalAlpha = alpha;
      const x = (c + 0.5) * colSize;
      const y = (r + 0.5) * rowSize;
      ctx.fillText(glyph, x, y);
    }
  }

  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
}

function revealAt(row, col, radius = state.brushSize) {
  const rMin = clamp(row - radius, 0, ROWS - 1);
  const rMax = clamp(row + radius, 0, ROWS - 1);
  const cMin = clamp(col - radius, 0, COLS - 1);
  const cMax = clamp(col + radius, 0, COLS - 1);

  for (let r = rMin; r <= rMax; r += 1) {
    for (let c = cMin; c <= cMax; c += 1) {
      const distance = Math.hypot(r - row, c - col);
      if (distance <= radius + 0.3) {
        if (eraseMode) {
          messageLayer.revealed[r][c] = false;
          createChaosCell(r, c, messageLayer.chars[r][c] !== ' ');
        } else {
          messageLayer.revealed[r][c] = true;
        }
      }
    }
  }
}

function pointerToCell(event) {
  const rect = canvas.getBoundingClientRect();
  const x = clamp(event.clientX - rect.left, 0, rect.width - 0.001);
  const y = clamp(event.clientY - rect.top, 0, rect.height - 0.001);
  const col = Math.floor((x / rect.width) * COLS);
  const row = Math.floor((y / rect.height) * ROWS);
  return { row, col };
}

function cellsBetween(start, end) {
  const points = [];
  const dx = end.col - start.col;
  const dy = end.row - start.row;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  for (let i = 1; i <= steps; i += 1) {
    points.push({
      row: Math.round(start.row + (dy * i) / steps),
      col: Math.round(start.col + (dx * i) / steps),
    });
  }
  return points;
}

function paintFromPointer(event) {
  const cell = pointerToCell(event);
  revealAt(cell.row, cell.col);
  if (lastCell && (lastCell.row !== cell.row || lastCell.col !== cell.col)) {
    const pathCells = cellsBetween(lastCell, cell);
    pathCells.forEach((point) => revealAt(point.row, point.col));
  }
  lastCell = cell;
}

canvas.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  isDrawing = true;
  lastCell = null;
  paintFromPointer(event);
});

canvas.addEventListener('pointermove', (event) => {
  if (!isDrawing) return;
  paintFromPointer(event);
});

canvas.addEventListener('pointerup', () => {
  isDrawing = false;
  lastCell = null;
});

canvas.addEventListener('pointercancel', () => {
  isDrawing = false;
  lastCell = null;
});

window.addEventListener('keydown', (event) => {
  if (event.key === '[' || event.key === '{') {
    state.brushSize = Math.max(1, state.brushSize - 1);
    flashStatus(`radius x${state.brushSize}`);
    event.preventDefault();
  }

  if (event.key === ']' || event.key === '}') {
    state.brushSize = Math.min(8, state.brushSize + 1);
    flashStatus(`radius x${state.brushSize}`);
    event.preventDefault();
  }

  if (event.code === 'Space' && !spaceHeld) {
    spaceHeld = true;
    savedBrushSize = state.brushSize;
    state.brushSize = Math.max(1, Math.floor(savedBrushSize / 2) || 1);
    flashStatus('detail mode');
    event.preventDefault();
    return;
  }

  if (event.key === 'Shift') {
    eraseMode = true;
    flashStatus('erase mode');
    event.preventDefault();
    return;
  }

  if (event.key && event.key.toLowerCase() === 'r') {
    state.baseHue = Math.floor(Math.random() * 360);
    state.palette = shuffledPalette();
    buildMessageField();
    seedNoiseField();
    messageLayer.revealed = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
    lastHandPoint = null;
    flashStatus('reshuffled');
    drawSurface();
  }

  if (event.key && event.key.toLowerCase() === 'c') {
    for (let r = 0; r < ROWS; r += 1) {
      for (let c = 0; c < COLS; c += 1) {
        if (messageLayer.chars[r][c] !== ' ') {
          messageLayer.revealed[r][c] = true;
        }
      }
    }
    flashStatus('full reveal');
    drawSurface();
  }
});

window.addEventListener('keyup', (event) => {
  if (event.code === 'Space' && spaceHeld) {
    spaceHeld = false;
    state.brushSize = savedBrushSize;
    flashStatus(`radius x${state.brushSize}`);
    event.preventDefault();
  }

  if (event.key === 'Shift' && eraseMode) {
    eraseMode = false;
    flashStatus('paint mode');
    event.preventDefault();
  }
});

function shuffledPalette() {
  const copy = SHUFFLE_ARRAY.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, 12);
}

function flashStatus(message) {
  if (!statusBadge) return;
  if (statusTimeoutId) {
    clearTimeout(statusTimeoutId);
  }
  statusBadge.textContent = message;
  statusBadge.classList.add('show');
  statusTimeoutId = setTimeout(() => {
    statusBadge.classList.remove('show');
    statusTimeoutId = null;
  }, 1600);
}

async function startHandTracking() {
  if (cameraEnabled || loadingHands) return;
  loadingHands = true;
  if (cameraToggle) {
    cameraToggle.disabled = true;
    cameraToggle.textContent = 'Loading...';
  }

  try {
    if (!visionResolver) {
      visionResolver = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
      );
    }

    if (!handLandmarker) {
      handLandmarker = await HandLandmarker.createFromOptions(visionResolver, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
        },
        runningMode: 'VIDEO',
        numHands: 1,
      });
    }

    if (!video) {
      video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      handStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 640, height: 480 },
      });
      video.srcObject = handStream;
      await new Promise((resolve) => {
        video.onloadedmetadata = () => resolve();
      });
    }

    cameraEnabled = true;
    if (cameraToggle) {
      cameraToggle.disabled = false;
      cameraToggle.textContent = 'Disable Camera';
    }
    flashStatus('camera on');
    processVideoFrame();
  } catch (error) {
    console.warn('Hand tracking unavailable:', error);
    flashStatus('hand tracking unavailable');
    if (cameraToggle) {
      cameraToggle.disabled = false;
      cameraToggle.textContent = 'Enable Camera';
    }
  } finally {
    loadingHands = false;
  }
}

function stopHandTracking() {
  if (!cameraEnabled && !loadingHands) return;
  cameraEnabled = false;
  if (handFrameRequest) {
    cancelAnimationFrame(handFrameRequest);
    handFrameRequest = null;
  }
  if (video && video.srcObject) {
    const tracks = video.srcObject.getTracks();
    tracks.forEach((track) => track.stop());
  }
  video = null;
  handStream = null;
  lastHandPoint = null;
  handActive = false;
  if (cameraToggle) {
    cameraToggle.disabled = false;
    cameraToggle.textContent = 'Enable Camera';
  }
  flashStatus('camera off');
}

function processVideoFrame() {
  if (!cameraEnabled || !handLandmarker || !video) return;
  const now = performance.now();
  const results = handLandmarker.detectForVideo(video, now);

  if (results && results.handedness.length > 0 && results.landmarks.length > 0) {
    const landmarks = results.landmarks[0];
    const tip = landmarks[8];
    const pointerX = clamp(1 - tip.x, 0, 1);
    const pointerY = clamp(tip.y, 0, 1);
    handActive = true;
    applyHandReveal(pointerX, pointerY);
  } else {
    handActive = false;
    lastHandPoint = null;
  }

  handFrameRequest = requestAnimationFrame(processVideoFrame);
}

function applyHandReveal(normX, normY) {
  const row = Math.floor(normY * ROWS);
  const col = Math.floor(normX * COLS);
  revealAt(row, col, state.brushSize + 1);

  if (lastHandPoint) {
    const start = { row: lastHandPoint.row, col: lastHandPoint.col };
    const end = { row, col };
    cellsBetween(start, end).forEach((point) => revealAt(point.row, point.col, state.brushSize + 1));
  }

  lastHandPoint = { row, col };
}

function animate() {
  drawSurface();
  requestAnimationFrame(animate);
}

function init() {
  if (spacingSlider) {
    spacingSlider.value = state.quoteSpacing;
    spacingSlider.addEventListener('input', handleSpacingInput, { passive: true });
    spacingSlider.addEventListener('change', handleSpacingInput);
    spacingSlider.addEventListener('input', handleSpacingInput);
  }

  if (cameraToggle) {
    cameraToggle.textContent = 'Enable Camera';
    cameraToggle.addEventListener('click', () => {
      if (cameraEnabled) {
        stopHandTracking();
      } else if (!loadingHands) {
        startHandTracking();
      }
    });
  }

  state.palette = shuffledPalette();
  state.baseHue = Math.floor(Math.random() * 360);
  buildMessageField();
  seedNoiseField();
  animate();
}

init();
