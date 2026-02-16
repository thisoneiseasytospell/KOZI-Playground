// Simulation parameters
export const SIM = {
  windStrength: 36,
  turbulence: 30,
  windAngle: 90,
  windDrift: 24,
  stiffness: 40,
  damping: 92,
  opacity: 0.0,
  flagColor: [0.91, 0.90, 0.89],
  bgColor: [0.039, 0.039, 0.043],
  gravity: 0.0,
  stretch: 10,
  zoom: 72,
};

// Cloth grid dimensions
export const cols = 112;
export const rows = 64;
export const totalPts = cols * rows;
export const flagW = 3.0;
export const flagH = flagW / 1.75;
export const restDx = flagW / (cols - 1);
export const restDy = flagH / (rows - 1);
export const restDiag = Math.sqrt(restDx * restDx + restDy * restDy);

// Shared mutable state
export const state = {
  viewMode: 'fullscreen',
  theme: 'dark',
  pinMode: 'poleDense',
};
