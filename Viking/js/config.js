// Shared constants for the render thread (app.js) and the sim worker (sim.js).

export const FLAG_W = 3.0, FLAG_H = 2.0;     // scene units (think metres)
export const COLS = 97, ROWS = 65;           // cloth particles (square cells)
export const SUBDIV = 2;                     // render surface = sim grid × SUBDIV (bicubic)
export const NOTCH = 0.21;                   // swallowtail depth, fraction of width
export const BORDER = 0.045;                 // gold border, fraction of height

export const TIME_SCALE = 0.85;              // < 1 reads heavier / bigger
export const SUBSTEPS = 2;
export const FIXED_DT = (1 / 60) * TIME_SCALE / SUBSTEPS;
export const WIND_MAX = 10.0;                // wind slider 100 → units/s

export const POLE_LEN = 4.4;
export const POLE_BASE_Y = -POLE_LEN * 0.62;
export const HOIST_TOP = POLE_LEN - 0.12;    // hoist starts this far up the pole
export const HOIST_OFF = 0.075;              // hoist rides the pole surface, not the axis —
                                             // this is what lets a pole twist roll the flag over

// Hand-held waving (figure-8): lateral at ω, forward/back at 2ω, plus a wrist twist
// on the pole that rolls the flag over and shows its back.
export const WAVE = { hz: 0.62, ampX: 0.66, ampZ: 0.4, twist: 1.9, windScale: 0.4 };

export const MODES = {
  mast: { label: 'Mast', wind: 1.0 },
  wall: { label: 'Wall', wind: 0.8 },
  wave: { label: 'Wave', wind: WAVE.windScale },
};

// Layout of the rig state array the worker sends every frame.
export const RIG = { DIR: 0, XAXIS: 3, ZAXIS: 6, SWAY: 9, BASE: 11, TWIST: 14, SIZE: 15 };
