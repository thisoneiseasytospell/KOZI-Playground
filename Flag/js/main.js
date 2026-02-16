import { simulate } from './cloth.js';
import { render, resize, canvas } from './renderer.js';
import { setupCameraControls, updateCamera } from './camera.js';
import { setupUI } from './ui.js';

// Initialize
setupCameraControls(canvas);
setupUI();
window.addEventListener('resize', resize);
resize();

// Animation loop
let lastTime = performance.now();
let accumulator = 0;
const FIXED_DT = 1 / 75;
const MAX_FRAME_DT = 0.05;
const MAX_STEPS = 4;

function loop(now) {
  const dt = Math.min((now - lastTime) / 1000, MAX_FRAME_DT);
  lastTime = now;
  accumulator += dt;

  updateCamera(dt);
  let steps = 0;
  while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
    simulate(FIXED_DT);
    accumulator -= FIXED_DT;
    steps++;
  }
  if (steps === MAX_STEPS) accumulator = 0;

  render();
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
