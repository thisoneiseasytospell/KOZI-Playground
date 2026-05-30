/* Enode — Audio engine
 *
 * Exposes a singleton `enodeAudio` with:
 *   .ready          — true once an AudioContext has been created
 *   .loaded         — true once a track has decoded enough to play
 *   .playing        — transport state
 *   .currentTime    — audio element current time (getter)
 *   .duration       — audio element duration (getter)
 *   .freq[]         — Uint8Array of latest frequency magnitudes (0..255)
 *   .bands          — { bass, mid, treble, rms } each 0..1, EMA-smoothed
 *   .beat           — momentarily true on detected kick (single-frame pulse)
 *   .load(url)      — load a track by URL (also accepts a File via objectURL upstream)
 *   .play()/.pause()/.toggle()/.seek(t)
 *   .update(dt)     — call once per frame from the render loop (dt = ms elapsed)
 *   .onLoaded(fn)   — register a callback fired when a new track is ready
 *   .onTransport(fn)— register a callback fired when play/pause/seek changes
 */
'use strict';

(function () {
  const FFT_SIZE = 1024;          // 512 frequency bins
  const SMOOTHING = 0.5;          // AnalyserNode internal smoothing — lower = snappier attack
  // Frequency band ranges (Hz). Tuned for typical music.
  const BAND_BASS   = [20,   180];
  const BAND_MID    = [180,  2000];
  const BAND_TREBLE = [2000, 9000];
  // Smoothing time-constants (ms). Converted to a per-frame factor via dt so
  // response is identical at 30 / 60 / 120fps. Bass is near-instant so kicks
  // read through; the musical "feel" envelope lives in the app's modulators.
  const BAND_TAU = { bass: 25, mid: 40, treble: 40, rms: 60 };
  const PEAK_RISE_TAU = 60;       // latch new peaks fast
  const PEAK_FALL_TAU = 4000;     // re-adapt sensitivity over a few seconds (was ~16s)
  const BASS_AVG_TAU  = 350;      // adaptive baseline for beat detection
  // Beat detector: bass must exceed the adaptive baseline by this factor.
  const BEAT_THRESHOLD = 1.35;    // was 1.20 (too loose → false beats)
  const BEAT_REFRACTORY_MS = 250; // was 80 (≈750 BPM); 250 ≈ 240 BPM ceiling

  const api = {
    ready: false,
    loaded: false,
    playing: false,
    freq: new Uint8Array(FFT_SIZE / 2),
    // Raw smoothed bands (0..1) — useful for the FFT viz / sanity checks.
    bands: { bass: 0, mid: 0, treble: 0, rms: 0 },
    // Per-band rolling-max normalized levels (0..1). Use these for modulators
    // so quiet songs and loud songs both drive visuals to full swing.
    levels: { bass: 0, mid: 0, treble: 0, rms: 0 },
    beat: false,
    get currentTime() { return audioEl ? audioEl.currentTime : 0; },
    get duration() { return audioEl && isFinite(audioEl.duration) ? audioEl.duration : 0; },
    load,
    play,
    pause,
    toggle,
    seek,
    update,
    onLoaded(fn) { loadedCbs.push(fn); },
    onTransport(fn) { transportCbs.push(fn); },
  };

  let ctx = null;
  let analyser = null;
  let sourceNode = null;
  let audioEl = null;
  // Bass running average (for beat detector)
  let bassAvg = 0;
  let lastBeatTime = 0;
  // Smoothing for displayed bands (on top of analyser smoothing)
  const smooth = { bass: 0, mid: 0, treble: 0, rms: 0 };
  // Per-band running maxima for normalization. Rises fast (track new peaks),
  // decays slowly (so a chorus doesn't get rescaled away during a verse).
  const peak = { bass: 0.05, mid: 0.05, treble: 0.05, rms: 0.05 };
  const PEAK_FLOOR = 0.05;       // never normalize against noise-floor
  const loadedCbs = [];
  const transportCbs = [];
  // Cache for bin → Hz mapping (recomputed lazily on ctx.sampleRate)
  let binHz = 0;
  let bandIndex = null;

  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('Web Audio not supported');
    ctx = new AC();
    analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = SMOOTHING;
    analyser.connect(ctx.destination);
    api.ready = true;
    recomputeBandIndex();
    return ctx;
  }

  function recomputeBandIndex() {
    if (!ctx) return;
    const bins = analyser.frequencyBinCount;
    binHz = ctx.sampleRate / 2 / bins;
    const toBin = hz => Math.max(0, Math.min(bins - 1, Math.round(hz / binHz)));
    bandIndex = {
      bass:   [toBin(BAND_BASS[0]),   toBin(BAND_BASS[1])],
      mid:    [toBin(BAND_MID[0]),    toBin(BAND_MID[1])],
      treble: [toBin(BAND_TREBLE[0]), toBin(BAND_TREBLE[1])],
    };
  }

  function ensureAudioEl() {
    if (audioEl) return audioEl;
    audioEl = new Audio();
    audioEl.crossOrigin = 'anonymous';
    audioEl.preload = 'auto';
    audioEl.addEventListener('play',  () => { api.playing = true;  notify(transportCbs); });
    audioEl.addEventListener('pause', () => { api.playing = false; notify(transportCbs); });
    audioEl.addEventListener('ended', () => { api.playing = false; notify(transportCbs); });
    audioEl.addEventListener('seeked', () => notify(transportCbs));
    audioEl.addEventListener('canplay', () => {
      api.loaded = true;
      notify(loadedCbs);
    });
    return audioEl;
  }

  function notify(list) {
    for (const fn of list) {
      try { fn(); } catch (e) { console.error(e); }
    }
  }

  function load(url) {
    ensureCtx();
    ensureAudioEl();
    // Hook the element into the graph on first load. MediaElementSource can
    // only be created once per element, so we reuse the node thereafter.
    if (!sourceNode) {
      sourceNode = ctx.createMediaElementSource(audioEl);
      sourceNode.connect(analyser);
    }
    api.loaded = false;
    audioEl.src = url;
    audioEl.load();
    // Some browsers leave context suspended until a user gesture; resume
    // here is a no-op if already running, otherwise it primes for the
    // imminent play() call that triggered this load.
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  function play() {
    if (!audioEl) return Promise.resolve();
    ensureCtx();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return audioEl.play().catch(() => {});
  }

  function pause() {
    if (audioEl) audioEl.pause();
  }

  function toggle() {
    if (!audioEl) return;
    if (audioEl.paused) play(); else pause();
  }

  function seek(t) {
    if (!audioEl) return;
    if (!isFinite(t)) return;
    try { audioEl.currentTime = Math.max(0, Math.min(api.duration || 0, t)); } catch (e) {}
  }

  // Range average of freq[] expressed as 0..1 (raw is 0..255).
  function avgRange(from, to) {
    let sum = 0;
    const n = to - from + 1;
    for (let i = from; i <= to; i++) sum += api.freq[i];
    return (sum / n) / 255;
  }

  // dt→alpha: how far to move toward a target this frame for a given time
  // constant (ms). Makes every EMA below framerate-independent.
  function alpha(tauMs, dt) { return 1 - Math.exp(-(dt || 16) / Math.max(1, tauMs)); }

  // Update one band's running peak — latch new highs fast, re-adapt downward
  // over a few seconds so quiet sections don't read as dead.
  function trackPeak(key, v, dt) {
    if (v > peak[key]) peak[key] += (v - peak[key]) * alpha(PEAK_RISE_TAU, dt);
    else               peak[key] += (PEAK_FLOOR - peak[key]) * alpha(PEAK_FALL_TAU, dt);
    if (peak[key] < PEAK_FLOOR) peak[key] = PEAK_FLOOR;
  }

  // Called once per render-loop frame. dt = ms since last frame.
  function update(dt) {
    dt = dt || 16;
    if (!analyser || !audioEl || (audioEl.paused && smooth.rms < 0.001)) {
      // Decay smoothed bands toward 0 when nothing's playing so visuals settle.
      const a = alpha(120, dt);
      for (const k in smooth) {
        smooth[k] += (0 - smooth[k]) * a;
        api.bands[k] = smooth[k];
        api.levels[k] = Math.min(1, smooth[k] / peak[k]);
      }
      api.beat = false;
      return;
    }
    analyser.getByteFrequencyData(api.freq);
    if (!bandIndex) recomputeBandIndex();

    const bass   = avgRange(bandIndex.bass[0],   bandIndex.bass[1]);
    const mid    = avgRange(bandIndex.mid[0],    bandIndex.mid[1]);
    const treble = avgRange(bandIndex.treble[0], bandIndex.treble[1]);
    // RMS approximated from full spectrum mean.
    let total = 0;
    for (let i = 0; i < api.freq.length; i++) total += api.freq[i];
    const rms = (total / api.freq.length) / 255;

    // Light, framerate-independent EMA on top of the analyser. Bass tracks
    // almost instantly so kicks read through; the musical envelope is applied
    // downstream by the app's modulators.
    smooth.bass   += (bass   - smooth.bass)   * alpha(BAND_TAU.bass,   dt);
    smooth.mid    += (mid    - smooth.mid)    * alpha(BAND_TAU.mid,    dt);
    smooth.treble += (treble - smooth.treble) * alpha(BAND_TAU.treble, dt);
    smooth.rms    += (rms    - smooth.rms)    * alpha(BAND_TAU.rms,    dt);

    // Track per-band peak and emit normalized levels (0..1).
    trackPeak('bass',   smooth.bass,   dt);
    trackPeak('mid',    smooth.mid,    dt);
    trackPeak('treble', smooth.treble, dt);
    trackPeak('rms',    smooth.rms,    dt);

    for (const k in smooth) {
      api.bands[k] = smooth[k];
      api.levels[k] = Math.min(1, smooth[k] / peak[k]);
    }

    // Beat detection on raw bass against an adaptive baseline, with a
    // refractory window so a single kick fires once (not a burst).
    bassAvg += (bass - bassAvg) * alpha(BASS_AVG_TAU, dt);
    const now = performance.now();
    const isBeat = bass > bassAvg * BEAT_THRESHOLD
                && bass > 0.12
                && (now - lastBeatTime) > BEAT_REFRACTORY_MS;
    if (isBeat) lastBeatTime = now;
    api.beat = isBeat;
  }

  window.enodeAudio = api;
})();
