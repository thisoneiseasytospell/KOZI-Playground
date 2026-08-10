/* Enode — Audio engine
 *
 * Exposes a singleton `enodeAudio` with:
 *   .ready          — true once an AudioContext has been created
 *   .loaded         — true once a track has decoded enough to play
 *   .playing        — transport state
 *   .micActive      — true while a live microphone is feeding analysis
 *   .currentTime    — audio element current time (getter)
 *   .duration       — audio element duration (getter)
 *   .freq[]         — Uint8Array of latest frequency magnitudes (0..255)
 *   .bands          — { bass, mid, treble, rms } each 0..1, EMA-smoothed
 *   .beat           — momentarily true on detected kick (single-frame pulse)
 *   .onsets         — { bass, mid, treble } momentarily true on per-band hits
 *   .load(url)      — load a track by URL (also accepts a File via objectURL upstream)
 *   .play()/.pause()/.toggle()/.seek(t)
 *   .useMicrophone(stream)/.stopMicrophone() — silent live-input analysis
 *   .update(dt)     — call once per frame from the render loop (dt = ms elapsed)
 *   .onLoaded(fn)   — register a callback fired when a new track is ready
 *   .onTransport(fn)— register a callback fired when play/pause/seek changes
 */
'use strict';

(function () {
  const FFT_SIZE = 1024;          // 512 frequency bins
  const SMOOTHING = 0.35;         // Snappy enough for visual hits without noisy band meters
  // Frequency band ranges (Hz). Tuned for typical music.
  const BAND_BASS   = [20,   180];
  const BAND_MID    = [180,  2000];
  const BAND_TREBLE = [2000, 9000];
  // Smoothing time-constants (ms). Converted to a per-frame factor via dt so
  // response is identical at 30 / 60 / 120fps. Bass is near-instant so kicks
  // read through; the musical "feel" envelope lives in the app's modulators.
  const BAND_TAU = { bass: 18, mid: 30, treble: 30, rms: 50 };
  const PEAK_RISE_TAU = 60;       // latch new peaks fast
  const PEAK_FALL_TAU = 4000;     // re-adapt sensitivity over a few seconds (was ~16s)
  const BASS_AVG_TAU  = 350;      // adaptive baseline for beat detection
  // Beat detector: bass must exceed the adaptive baseline by this factor.
  const BEAT_THRESHOLD = 1.35;    // was 1.20 (too loose → false beats)
  const BEAT_REFRACTORY_MS = 250; // was 80 (≈750 BPM); 250 ≈ 240 BPM ceiling
  // ── Auto-gain floor (companion to the rolling peak/ceiling). Snaps down to
  // new lows fast, re-adapts upward slowly, so each band's level is compressed
  // between an adaptive floor and ceiling — quiet passages still read, loud
  // songs don't clip.
  const FLOOR_DROP_TAU = 90;      // track new lows quickly
  const FLOOR_RISE_TAU = 3000;    // re-adapt the floor upward over seconds
  const LEVEL_MIN_GAP  = 0.04;    // never compress against a near-zero span
  // Per-band onset (discrete hit) detection on the normalized level. Fires once
  // when a band crosses its threshold, re-arms after falling below 0.8× it, and
  // honours a per-band refractory so one hit fires once.
  const ONSET_THRESHOLD  = { bass: 0.55, mid: 0.5, treble: 0.5 };
  const ONSET_REFRACTORY = { bass: 200, mid: 120, treble: 120 };

  const api = {
    ready: false,
    loaded: false,
    playing: false,
    micActive: false,
    freq: new Uint8Array(FFT_SIZE / 2),
    // Raw smoothed bands (0..1) — useful for the FFT viz / sanity checks.
    bands: { bass: 0, mid: 0, treble: 0, rms: 0 },
    // Per-band rolling-max normalized levels (0..1). Use these for modulators
    // so quiet songs and loud songs both drive visuals to full swing.
    levels: { bass: 0, mid: 0, treble: 0, rms: 0 },
    beat: false,
    // Per-band discrete hits (kick / snare / hat) — single-frame pulses.
    onsets: { bass: false, mid: false, treble: false },
    // Frequency-band Hz ranges (so the analyzer viz can mark each region).
    bandRanges: { bass: BAND_BASS, mid: BAND_MID, treble: BAND_TREBLE },
    get currentTime() { return audioEl ? audioEl.currentTime : 0; },
    get duration() { return audioEl && isFinite(audioEl.duration) ? audioEl.duration : 0; },
    load,
    play,
    pause,
    toggle,
    seek,
    useMicrophone,
    stopMicrophone,
    update,
    getSpectrumLog,
    onLoaded(fn) { loadedCbs.push(fn); },
    onTransport(fn) { transportCbs.push(fn); },
  };

  let ctx = null;
  let analyser = null;
  let sourceNode = null;
  let audioEl = null;
  let micAnalyser = null;
  let micSourceNode = null;
  let micSilentGain = null;
  const micFreq = new Uint8Array(FFT_SIZE / 2);
  // Bass running average (for beat detector)
  let bassAvg = 0;
  let lastBeatTime = 0;
  // Smoothing for displayed bands (on top of analyser smoothing)
  const smooth = { bass: 0, mid: 0, treble: 0, rms: 0 };
  // Per-band running maxima for normalization. Rises fast (track new peaks),
  // decays slowly (so a chorus doesn't get rescaled away during a verse).
  const peak = { bass: 0.05, mid: 0.05, treble: 0.05, rms: 0.05 };
  const PEAK_FLOOR = 0.05;       // never normalize against noise-floor
  // Adaptive floor per band (lower rail of the auto-gain compressor).
  const floor = { bass: 0, mid: 0, treble: 0, rms: 0 };
  // Per-band onset detector state: armed flag + last-fire time.
  const onsetArmed = { bass: true, mid: true, treble: true };
  const lastOnset  = { bass: 0, mid: 0, treble: 0 };
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

  function resetAnalysis() {
    api.freq.fill(0);
    micFreq.fill(0);
    bassAvg = 0;
    lastBeatTime = 0;
    api.beat = false;
    api.onsets.bass = api.onsets.mid = api.onsets.treble = false;
    for (const key in smooth) {
      smooth[key] = 0;
      peak[key] = PEAK_FLOOR;
      floor[key] = 0;
      api.bands[key] = 0;
      api.levels[key] = 0;
    }
    onsetArmed.bass = onsetArmed.mid = onsetArmed.treble = true;
    lastOnset.bass = lastOnset.mid = lastOnset.treble = 0;
  }

  function load(url) {
    ensureCtx();
    ensureAudioEl();
    resetAnalysis();
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

  // Feed a MediaStream into a separate analyser. Its output is connected through
  // a zero-gain node so the graph remains live without echoing the mic to speakers.
  function useMicrophone(stream) {
    ensureCtx();
    stopMicrophone();
    if (!stream || !stream.getAudioTracks || !stream.getAudioTracks().some(t => t.readyState === 'live')) return false;
    micAnalyser = ctx.createAnalyser();
    micAnalyser.fftSize = FFT_SIZE;
    micAnalyser.smoothingTimeConstant = SMOOTHING;
    micSourceNode = ctx.createMediaStreamSource(stream);
    micSilentGain = ctx.createGain();
    micSilentGain.gain.value = 0;
    micSourceNode.connect(micAnalyser);
    micAnalyser.connect(micSilentGain);
    micSilentGain.connect(ctx.destination);
    api.micActive = true;
    resetAnalysis();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    notify(transportCbs);
    return true;
  }

  function stopMicrophone() {
    if (micSourceNode) { try { micSourceNode.disconnect(); } catch (e) {} }
    if (micAnalyser) { try { micAnalyser.disconnect(); } catch (e) {} }
    if (micSilentGain) { try { micSilentGain.disconnect(); } catch (e) {} }
    micSourceNode = null;
    micAnalyser = null;
    micSilentGain = null;
    micFreq.fill(0);
    if (api.micActive) {
      api.micActive = false;
      notify(transportCbs);
    }
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

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  // Adaptive floor: snap down to new lows fast, re-adapt upward slowly so the
  // level reads against the current quiet-baseline, not a stale one.
  function trackFloor(key, v, dt) {
    const tau = v < floor[key] ? FLOOR_DROP_TAU : FLOOR_RISE_TAU;
    floor[key] += (v - floor[key]) * alpha(tau, dt);
    if (floor[key] < 0) floor[key] = 0;
  }

  // Compressed 0..1 level between the adaptive floor and peak for a band.
  function normLevel(key) {
    const span = Math.max(LEVEL_MIN_GAP, peak[key] - floor[key]);
    return clamp01((smooth[key] - floor[key]) / span);
  }

  // Per-band onset: fire on threshold cross, re-arm under 0.8× it, refractory-gated.
  function detectOnset(band, now) {
    const lv = api.levels[band];
    const thr = ONSET_THRESHOLD[band];
    if (onsetArmed[band] && lv >= thr && (now - lastOnset[band]) > ONSET_REFRACTORY[band]) {
      lastOnset[band] = now;
      onsetArmed[band] = false;
      return true;
    }
    if (!onsetArmed[band] && lv < thr * 0.8) onsetArmed[band] = true;
    return false;
  }

  // Called once per render-loop frame. dt = ms since last frame.
  function update(dt) {
    dt = dt || 16;
    const trackActive = !!(analyser && audioEl && !audioEl.paused);
    const microphoneActive = !!(api.micActive && micAnalyser);
    if (!trackActive && !microphoneActive && smooth.rms < 0.001) {
      // Decay smoothed bands toward 0 when nothing's playing so visuals settle.
      const a = alpha(120, dt);
      for (const k in smooth) {
        smooth[k] += (0 - smooth[k]) * a;
        trackFloor(k, smooth[k], dt);
        api.bands[k] = smooth[k];
        api.levels[k] = normLevel(k);
      }
      api.beat = false;
      api.onsets.bass = api.onsets.mid = api.onsets.treble = false;
      return;
    }
    if (trackActive) analyser.getByteFrequencyData(api.freq);
    else api.freq.fill(0);
    if (microphoneActive) {
      micAnalyser.getByteFrequencyData(micFreq);
      // Track + microphone can coexist; use the stronger bin so either source
      // can drive the artwork without routing the microphone to the speakers.
      for (let i = 0; i < api.freq.length; i++) {
        if (micFreq[i] > api.freq[i]) api.freq[i] = micFreq[i];
      }
    }
    if (!bandIndex) recomputeBandIndex();

    const bass   = avgRange(bandIndex.bass[0],   bandIndex.bass[1]);
    const mid    = avgRange(bandIndex.mid[0],    bandIndex.mid[1]);
    const treble = avgRange(bandIndex.treble[0], bandIndex.treble[1]);
    // Root-mean-square over the musically useful spectrum. Ignoring the mostly
    // empty ultrasonic bins gives tracks and microphones a reliable master level.
    const rmsBins = Math.min(api.freq.length, Math.max(1, Math.ceil(12000 / binHz)));
    let totalSquares = 0;
    for (let i = 0; i < rmsBins; i++) totalSquares += api.freq[i] * api.freq[i];
    const rms = Math.sqrt(totalSquares / rmsBins) / 255;

    // Light, framerate-independent EMA on top of the analyser. Bass tracks
    // almost instantly so kicks read through; the musical envelope is applied
    // downstream by the app's modulators.
    smooth.bass   += (bass   - smooth.bass)   * alpha(BAND_TAU.bass,   dt);
    smooth.mid    += (mid    - smooth.mid)    * alpha(BAND_TAU.mid,    dt);
    smooth.treble += (treble - smooth.treble) * alpha(BAND_TAU.treble, dt);
    smooth.rms    += (rms    - smooth.rms)    * alpha(BAND_TAU.rms,    dt);

    // Track per-band peak + floor, then emit compressed normalized levels (0..1).
    for (const k in smooth) {
      trackPeak(k, smooth[k], dt);
      trackFloor(k, smooth[k], dt);
      api.bands[k] = smooth[k];
      api.levels[k] = normLevel(k);
    }

    const now = performance.now();

    // Discrete per-band onsets (kick / snare / hat) on the normalized levels.
    api.onsets.bass   = detectOnset('bass',   now);
    api.onsets.mid    = detectOnset('mid',    now);
    api.onsets.treble = detectOnset('treble', now);

    // Beat detection on raw bass against an adaptive baseline, with a
    // refractory window so a single kick fires once (not a burst).
    bassAvg += (bass - bassAvg) * alpha(BASS_AVG_TAU, dt);
    const isBeat = bass > bassAvg * BEAT_THRESHOLD
                && bass > 0.12
                && (now - lastBeatTime) > BEAT_REFRACTORY_MS;
    if (isBeat) lastBeatTime = now;
    api.beat = isBeat;
  }

  // Log-frequency spectrum (numBars values 0..1) for the analyzer viz. Reads the
  // latest FFT magnitudes captured by update(); octave-ish spacing matches musical
  // perception so bass isn't crammed into a few pixels.
  function getSpectrumLog(numBars, fMin, fMax) {
    numBars = numBars || 96; fMin = fMin || 20; fMax = fMax || 20000;
    const out = new Float32Array(numBars);
    if (!ctx) return out;
    const bins = api.freq.length;
    const res = (ctx.sampleRate / 2) / bins;
    const lMin = Math.log(fMin), lStep = (Math.log(fMax) - lMin) / numBars;
    for (let i = 0; i < numBars; i++) {
      let i0 = Math.floor(Math.exp(lMin + i * lStep) / res);
      let i1 = Math.min(bins - 1, Math.floor(Math.exp(lMin + (i + 1) * lStep) / res));
      if (i1 < i0) i1 = i0;
      let sum = 0;
      for (let j = i0; j <= i1; j++) sum += api.freq[j];
      out[i] = (sum / (i1 - i0 + 1)) / 255;
    }
    return out;
  }

  window.enodeAudio = api;
})();
