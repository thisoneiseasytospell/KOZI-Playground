/* Enode — BPM clock
 *
 * A self-contained tempo grid ported from WARSZTATY's triggers/bpm.js, adapted
 * to vanilla JS (performance.now() instead of p5's millis()). It does NOT detect
 * tempo from audio — the user sets it via tap/number — but it provides a phase
 * clock so visuals can move *on* the grid (predictive) rather than only reacting
 * to transients.
 *
 * Exposes a singleton `enodeBpm` with:
 *   .bpm              — current tempo (read; set via setBpm)
 *   .enabled          — gate the whole clock
 *   .divisions        — [1,2,4,8,16] beat divisions exposed as matrix sources
 *   .onBeat           — { 1,2,4,8,16 } momentarily true on each grid tick
 *   .rhythm(n)        — continuous phase (fractional n-beat bars since sync) for
 *                       BPM-synced generators
 *   .setBpm(v) / .tap() / .sync()
 *   .update()         — call once per render frame; refreshes onBeat[]
 *   .onTick(fn)       — register callback(n) fired when a division lands (UI dots)
 */
'use strict';

(function () {
  const DIVISIONS = [1, 2, 4, 8, 16];
  const BEAT_TOLERANCE = 20; // ms-equivalent window counted as "on beat"

  const api = {
    bpm: 120,
    enabled: true,
    divisions: DIVISIONS.slice(),
    onBeat: {},
    setBpm,
    tap,
    sync,
    update,
    rhythm,
    isOnBeat,
    onTick(fn) { tickCbs.push(fn); },
  };

  let beatMs = 60000 / api.bpm;   // ms per quarter-beat
  let syncOffset = 0;             // phase anchor (performance.now() domain)
  const prevOnBeat = {};
  const tickCbs = [];

  for (const n of DIVISIONS) { api.onBeat[n] = false; prevOnBeat[n] = false; }

  function now() { return performance.now(); }

  function setBpm(v) {
    v = Math.max(20, Math.min(400, +v || 0));
    api.bpm = Math.round(v * 100) / 100;
    beatMs = 60000 / api.bpm;
  }

  // Anchor the grid to "now" — reset the phase so the next tick lands here.
  // Uses a 32-beat bar like the source so all divisions line up at sync.
  function sync() {
    syncOffset = now() % (beatMs * 32);
  }

  // Continuous phase: fractional count of n-beat bars elapsed since sync.
  function rhythm(n = 4) {
    return (now() - syncOffset) / (beatMs * n);
  }

  // Rising-edge detector: true once on the frame a given division lands.
  function isOnBeat(n = 4) {
    const onNow = Math.abs(rhythm(n) % 1) < BEAT_TOLERANCE / beatMs;
    const rising = onNow && !prevOnBeat[n];
    prevOnBeat[n] = onNow;
    return rising;
  }

  function update() {
    if (!api.enabled) {
      for (const n of DIVISIONS) api.onBeat[n] = false;
      return;
    }
    // Highest division first, mirroring the source ordering.
    for (let i = DIVISIONS.length - 1; i >= 0; i--) {
      const n = DIVISIONS[i];
      const fired = isOnBeat(n);
      api.onBeat[n] = fired;
      if (fired) {
        for (const fn of tickCbs) { try { fn(n); } catch (e) { console.error(e); } }
      }
    }
  }

  // ── Tap tempo: average the interval over a run of taps; a long gap restarts.
  let lastTap = 0, firstTap = 0, taps = 0;
  const TAP_GAP = 4000; // ms

  function tap() {
    const t = now();
    if (t - lastTap > TAP_GAP) { taps = 0; firstTap = t; }
    taps++;
    if (taps > 1) {
      const elapsed = t - firstTap;
      if (elapsed > 0) { setBpm((60000 * (taps - 1)) / elapsed); sync(); }
    }
    lastTap = t;
  }

  sync();
  window.enodeBpm = api;
})();
