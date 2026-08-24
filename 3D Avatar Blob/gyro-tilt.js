/* Device tilt -> normalised look vector.

   A phone has no cursor, so the channel that makes the avatar lean toward the
   mouse on desktop is fed by the gyroscope instead: tilt the device and the
   head leans with it. Reports { x, y } in [-1, 1] — the same units the
   `avatar-pointer` message already speaks — so every page can hand the result
   straight to the avatar without knowing anything about sensors.

   Plain script, no module, no build step. Loaded by index.html and both mobile
   previews. */
(function () {
  var RANGE_DEG = 24;     /* tilt away from neutral that reaches full deflection */
  var SMOOTHING = 0.22;   /* light low-pass; the avatar's springs do the rest */

  function clamp1(v) { return v < -1 ? -1 : v > 1 ? 1 : v; }

  function screenAngle() {
    var angle = window.screen && window.screen.orientation ? window.screen.orientation.angle : null;
    if (angle == null) angle = window.orientation || 0;
    return ((angle % 360) + 360) % 360;
  }

  /* Start reporting tilt. Returns a stop function. */
  window.startGyroTilt = function startGyroTilt(onTilt, options) {
    options = options || {};
    var range = options.range || RANGE_DEG;
    var noop = function () {};
    if (typeof onTilt !== 'function' || typeof window.DeviceOrientationEvent === 'undefined') return noop;

    var neutral = null;               /* however the device is held becomes centre */
    var smoothed = { x: 0, y: 0 };
    var attached = false, stopped = false;

    function recalibrate() { neutral = null; }

    function onVisibility() { if (!document.hidden) recalibrate(); }

    function onOrientation(event) {
      if (typeof event.beta !== 'number' || typeof event.gamma !== 'number') return;
      /* Roll the device axes into screen space so a landscape phone tilts the
         same way a portrait one does. */
      var a = screenAngle() * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
      var raw = {
        x: event.gamma * cos + event.beta * sin,
        y: event.beta * cos - event.gamma * sin
      };
      if (!neutral) neutral = raw;
      var target = {
        x: clamp1((raw.x - neutral.x) / range),
        y: clamp1((raw.y - neutral.y) / range)
      };
      smoothed = {
        x: smoothed.x + (target.x - smoothed.x) * SMOOTHING,
        y: smoothed.y + (target.y - smoothed.y) * SMOOTHING
      };
      onTilt(smoothed);
    }

    function attach() {
      if (attached || stopped) return;
      attached = true;
      window.addEventListener('deviceorientation', onOrientation);
      window.addEventListener('orientationchange', recalibrate);
      if (window.screen && window.screen.orientation) window.screen.orientation.addEventListener('change', recalibrate);
      document.addEventListener('visibilitychange', onVisibility);
    }

    function detach() {
      stopped = true;
      if (!attached) return;
      attached = false;
      window.removeEventListener('deviceorientation', onOrientation);
      window.removeEventListener('orientationchange', recalibrate);
      if (window.screen && window.screen.orientation) window.screen.orientation.removeEventListener('change', recalibrate);
      document.removeEventListener('visibilitychange', onVisibility);
    }

    /* iOS 13+ only hands out orientation events after an explicit grant, and
       only asks from inside a user gesture — so the first tap does the asking.
       Everywhere else the sensor is free. */
    if (typeof window.DeviceOrientationEvent.requestPermission !== 'function') {
      attach();
    } else {
      var ask = function () {
        document.removeEventListener('click', ask);
        document.removeEventListener('touchend', ask);
        try {
          window.DeviceOrientationEvent.requestPermission().then(function (result) {
            if (result === 'granted') attach();
          })['catch'](noop);
        } catch (err) { /* denied or unavailable: stay on pointer input */ }
      };
      document.addEventListener('click', ask);
      document.addEventListener('touchend', ask);
    }

    return detach;
  };
})();
