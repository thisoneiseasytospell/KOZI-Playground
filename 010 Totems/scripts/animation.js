import * as THREE from 'three';
import { updatePrecipitation, getCurrentPrecipType } from './snow.js';
import {
  state,
  sceneModels,
  container,
  mouse,
  mouseState,
  gyro,
  gyroState,
  touchState,
  getGridConfig,
  BASE_FRAME_INTERVAL,
  IDLE_FRAME_INTERVAL,
  IDLE_TIMEOUT,
  MOBILE_IDLE_FRAME_INTERVAL,
  LOW_END_FRAME_INTERVAL,
  LOW_END_IDLE_FRAME_INTERVAL,
  SOLO_MODEL_TRANSITION_SPEED,
  SOLO_MODEL_TRANSITION_THRESHOLD,
  SOLO_MOUSE_ROTATION_Y_FACTOR,
  SOLO_MOUSE_ROTATION_X_FACTOR,
  SWIPE_HINT_OFFSET,
  isLowEndDevice,
  getPerformanceTier,
  shouldUseDegradedMode
} from './state.js';
import { scene, camera, renderer, handleResize } from './scene.js';
import { updateGridLayout } from './models.js';
import { getAdjacentIndices, hideAdjacentModels, resetMobileSwipeHint } from './input.js';
import { updateSoloInfoTransform, updateFpsDisplay } from './ui.js';

// Check if scene container is in viewport
function checkSceneVisibility() {
  if (!container) return true;
  const rect = container.getBoundingClientRect();
  // Scene is visible if any part is in viewport
  return rect.bottom > 0 && rect.top < window.innerHeight;
}

// Mark user as active
export function markUserActive() {
  state.lastInteractionTime = Date.now();
  state.isIdle = false;
}

// Setup user activity tracking
export function setupActivityTracking() {
  ['mousemove', 'mousedown', 'touchstart', 'touchmove', 'wheel', 'keydown'].forEach(eventType => {
    window.addEventListener(eventType, markUserActive, { passive: true });
  });

  document.addEventListener('visibilitychange', () => {
    state.isPageVisible = !document.hidden;
    if (state.isPageVisible) {
      markUserActive();
      if (!state.animationFrameId) {
        state.animationFrameId = requestAnimationFrame(animate);
      }
    }
  });
}

// Gentle wiggle effect - subtle idle animation
export function applyModelWiggle() {
  // Skip wiggle when idle to save CPU
  if (state.isIdle) return;

  state.wiggleTime += 0.016; // ~60fps

  sceneModels.forEach((model, index) => {
    if (!model || !model.object || !model.object.visible) return;
    const innerObj = model.object.userData.innerObject;
    if (!innerObj) return;

    // Skip during grid intro animation
    if (model.object.userData.gridIntroAnimating) return;

    // Each model wiggles slightly differently
    const offset = index * 0.7;
    const wiggle = Math.sin(state.wiggleTime * 1.5 + offset) * 0.003;

    // Apply subtle wiggle to Z rotation
    innerObj.rotation.z += wiggle;
  });
}

// Handle resize with debouncing on mobile to prevent scroll-triggered glitches
let resizeDebounceTimer = null;
let lastResizeWidth = window.innerWidth;

export function setupResizeHandler() {
  window.addEventListener('resize', () => {
    const isMobile = window.innerWidth <= 900;
    const widthChanged = Math.abs(window.innerWidth - lastResizeWidth) > 50;

    // Camera updates are always immediate
    handleResize();

    // On mobile, debounce grid layout updates to avoid scroll-triggered glitches
    // URL bar hide/show causes resize events during scroll - only respond to real orientation changes
    if (isMobile && !widthChanged) {
      // Skip layout update for height-only changes (URL bar)
      return;
    }

    if (isMobile) {
      // Debounce layout updates on mobile
      if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
      resizeDebounceTimer = setTimeout(() => {
        lastResizeWidth = window.innerWidth;
        updateGridLayout();
      }, 150);
    } else {
      // Desktop: immediate update
      lastResizeWidth = window.innerWidth;
      updateGridLayout();
    }
  });
}

// Main animation loop
export function animate() {
  // Stop rendering if page is not visible
  if (!state.isPageVisible) {
    state.animationFrameId = null;
    return;
  }

  state.animationFrameId = requestAnimationFrame(animate);

  try {

  const now = performance.now();

  // Check idle state
  if (!state.isIdle && Date.now() - state.lastInteractionTime > IDLE_TIMEOUT) {
    state.isIdle = true;
  }

  // Check if scene is visible and throttle if not (but keep snow running in disco mode)
  state.isSceneVisible = checkSceneVisibility();
  const keepSnowRunning = state.isPartyMode && getCurrentPrecipType() === 'snow';

  const isMobile = window.innerWidth <= 900;
  const performanceTier = getPerformanceTier();
  const isDegraded = shouldUseDegradedMode();

  // Frame interval depends on device tier, activity state, and memory pressure
  let frameInterval;

  if (isDegraded || performanceTier === 'low') {
    // Low-end or degraded devices: cap at 30fps, drop to 4fps when idle
    frameInterval = state.isIdle ? LOW_END_IDLE_FRAME_INTERVAL : LOW_END_FRAME_INTERVAL;
  } else if (isMobile) {
    // Medium-tier mobile: cap at 60fps, drop to 10fps when idle
    frameInterval = state.isIdle ? MOBILE_IDLE_FRAME_INTERVAL : BASE_FRAME_INTERVAL;
  } else {
    // Desktop: full 60fps, 5fps when idle
    frameInterval = (state.isIdle && !keepSnowRunning) ? IDLE_FRAME_INTERVAL : BASE_FRAME_INTERVAL;
  }

  // Skip frame if too soon (applies to all devices now)
  if (now - state.lastFrameTime < frameInterval) {
    return;
  }

  // On desktop, also skip entirely when scene is not visible
  if (!isMobile && !state.isSceneVisible && !keepSnowRunning) {
    return;
  }

  state.lastFrameTime = now;

  const config = getGridConfig();

  // Mobile solo mode - gyro-controlled rotation with center bias
  if (config.isMobileSolo) {
    const currentModel = sceneModels[state.mobileCurrentModelIndex];
    if (currentModel && currentModel.object) {
      const innerObj = currentModel.object.userData.innerObject;
      if (innerObj) {
        const baseRotationY = currentModel.object.userData.baseRotationY || 0;
        const baseRotationX = currentModel.object.userData.baseRotationX || 0;

        // Gyro with strong center bias - model tends to return to center
        // Reduced rotation range to avoid sideways views
        let targetRotationY = baseRotationY;
        let targetRotationX = baseRotationX;

        if (gyroState.enabled) {
          // Center-biased gyro: use a reduced range and damped response
          // gamma (left/right tilt) maps to Y rotation, range limited to ±30 degrees
          // beta (front/back tilt) maps to X rotation, range limited to ±20 degrees
          const maxTiltY = Math.PI * 0.17; // ~30 degrees max horizontal rotation
          const maxTiltX = Math.PI * 0.11; // ~20 degrees max vertical rotation

          // Apply dampening curve - more movement near center, less at extremes
          const dampedGamma = Math.sign(gyro.gamma) * Math.pow(Math.abs(gyro.gamma), 0.7);
          const dampedBeta = Math.sign(gyro.beta) * Math.pow(Math.abs(gyro.beta), 0.7);

          targetRotationY = baseRotationY + dampedGamma * maxTiltY;
          targetRotationX = baseRotationX + dampedBeta * maxTiltX;
        }

        // Swipe hint animation - slide to reveal adjacent models
        if (state.mobileSwipeHintActive) {
          state.mobileSwipeHintPhase += 0.04; // Slower animation

          // Slide left-right once then stop
          if (state.mobileSwipeHintPhase < Math.PI * 2) {
            const slideOffset = Math.sin(state.mobileSwipeHintPhase) * SWIPE_HINT_OFFSET;

            // Move current model
            currentModel.object.position.x = slideOffset;

            // Move adjacent models with more spacing
            const { prev, next } = getAdjacentIndices();
            const prevModel = sceneModels[prev];
            const nextModel = sceneModels[next];
            const adjacentSpacing = 6; // More space between models

            if (prevModel && prevModel.object) {
              prevModel.object.position.x = slideOffset - adjacentSpacing;
            }
            if (nextModel && nextModel.object) {
              nextModel.object.position.x = slideOffset + adjacentSpacing;
            }
          } else {
            // Reset positions and hide adjacent models
            currentModel.object.position.x = 0;
            state.mobileSwipeHintActive = false;
            state.mobileSwipeHintPhase = 0;
            hideAdjacentModels();
            // Don't restart - hint only shows once per session
          }
        }

        // Smooth interpolation with return-to-center tendency
        innerObj.rotation.y = THREE.MathUtils.lerp(innerObj.rotation.y, targetRotationY, 0.08);
        innerObj.rotation.x = THREE.MathUtils.lerp(innerObj.rotation.x, targetRotationX, 0.08);
        innerObj.rotation.z = THREE.MathUtils.lerp(innerObj.rotation.z, 0, 0.1);
      }
    }

    // Keep camera at origin for mobile solo
    camera.position.y = 0;
  } else if (state.isGridMode) {
    // Desktop grid mode - camera at origin
    camera.position.y = THREE.MathUtils.lerp(camera.position.y, 0, 0.1);
  }

  if (state.isGridMode) {
    // GRID MODE: Mouse-follow rotation for all models in grid
    sceneModels.forEach((model, modelIndex) => {
      if (!model) return;
      const group = model.object;
      if (!group || !group.visible) return;
      const innerObj = group.userData.innerObject;
      if (!innerObj) return;

      const baseRotationY = group.userData.baseRotationY || 0;
      const baseRotationX = group.userData.baseRotationX || 0;

      if (group.userData.gridIntroAnimating) {
        innerObj.rotation.y = THREE.MathUtils.lerp(innerObj.rotation.y, baseRotationY, 0.08);
        innerObj.rotation.x = THREE.MathUtils.lerp(innerObj.rotation.x, baseRotationX, 0.08);
        innerObj.rotation.z = THREE.MathUtils.lerp(innerObj.rotation.z, 0, 0.08);

        const delta = Math.abs(innerObj.rotation.y - baseRotationY)
          + Math.abs(innerObj.rotation.x - baseRotationX)
          + Math.abs(innerObj.rotation.z);

        if (delta < 0.02) {
          innerObj.rotation.set(baseRotationX, baseRotationY, 0);
          group.userData.gridIntroAnimating = false;
        }
        return;
      }

      // All models rotate based on gyroscope (mobile) or mouse (desktop)
      let inputX, inputY;
      if (gyroState.enabled) {
        inputX = gyro.gamma; // left/right tilt
        inputY = gyro.beta;  // front/back tilt
      } else {
        inputX = mouse.x;
        inputY = mouse.y;
      }

      // Vertical rotation limits - see more top, less bottom
      const MAX_TILT_UP = Math.PI * 0.18;   // ~32 degrees - can see top nicely
      const MAX_TILT_DOWN = Math.PI * 0.06; // ~11 degrees - very limited bottom view

      const targetRotationY = baseRotationY + inputX * Math.PI * 0.4;
      let targetRotationX = baseRotationX - inputY * Math.PI * 0.4;
      // Clamp vertical rotation relative to base
      const relativeX = targetRotationX - baseRotationX;
      const clampedRelativeX = THREE.MathUtils.clamp(relativeX, -MAX_TILT_DOWN, MAX_TILT_UP);
      targetRotationX = baseRotationX + clampedRelativeX;

      innerObj.rotation.y = THREE.MathUtils.lerp(innerObj.rotation.y, targetRotationY, 0.1);
      innerObj.rotation.x = THREE.MathUtils.lerp(innerObj.rotation.x, targetRotationX, 0.1);
      innerObj.rotation.z = THREE.MathUtils.lerp(innerObj.rotation.z, 0, 0.08);
    });
  } else {
    // SOLO MODE: Model pinned at center, full rotation inspection via drag or gyro
    const currentModel = sceneModels[state.currentModelIndex];
    if (currentModel && currentModel.object) {
      const innerObj = currentModel.object.userData.innerObject;

      // Position is set when entering solo mode, no need to update every frame

      // Get input from touch drag, gyroscope, or mouse
      let targetRotationX, targetRotationY;
      const hasGyroInput = gyroState.enabled && (Math.abs(gyro.gamma) > 0.01 || Math.abs(gyro.beta) > 0.01);
      const hasTouchDragInput = touchState.dragging || (touchState.dragRotationX !== 0 || touchState.dragRotationY !== 0);

      if (hasTouchDragInput) {
        // Touch drag - full rotation control
        targetRotationY = touchState.dragRotationY + touchState.dragTargetY;
        targetRotationX = touchState.dragRotationX + touchState.dragTargetX;
      } else if (hasGyroInput) {
        // Gyro control - amplified for full inspection
        targetRotationY = gyro.gamma * Math.PI * 0.5;
        targetRotationX = gyro.beta * Math.PI * 0.4;
      } else if (mouseState.isMoving) {
        targetRotationY = mouse.x * Math.PI * SOLO_MOUSE_ROTATION_Y_FACTOR;
        targetRotationX = -mouse.y * Math.PI * SOLO_MOUSE_ROTATION_X_FACTOR;
      } else {
        targetRotationX = 0;
        targetRotationY = 0;
      }

      const hasActiveInput = hasGyroInput || mouseState.isMoving || hasTouchDragInput;

      // Check if transitioning from initial random rotation
      if (currentModel.object.userData.isTransitioning && innerObj) {
        innerObj.rotation.x = THREE.MathUtils.lerp(innerObj.rotation.x, targetRotationX, SOLO_MODEL_TRANSITION_SPEED);
        innerObj.rotation.y = THREE.MathUtils.lerp(innerObj.rotation.y, targetRotationY, SOLO_MODEL_TRANSITION_SPEED);
        innerObj.rotation.z = THREE.MathUtils.lerp(innerObj.rotation.z, 0, SOLO_MODEL_TRANSITION_SPEED);

        const rotationDelta = Math.abs(innerObj.rotation.x - targetRotationX)
          + Math.abs(innerObj.rotation.y - targetRotationY)
          + Math.abs(innerObj.rotation.z);
        if (rotationDelta < SOLO_MODEL_TRANSITION_THRESHOLD) {
          innerObj.rotation.set(targetRotationX, targetRotationY, 0);
          currentModel.object.userData.isTransitioning = false;
        }
      } else if (innerObj && hasActiveInput) {
        // Active input control (touch drag, gyro, or mouse)
        innerObj.rotation.y = THREE.MathUtils.lerp(innerObj.rotation.y, targetRotationY, 0.12);
        innerObj.rotation.x = THREE.MathUtils.lerp(innerObj.rotation.x, targetRotationX, 0.12);
      } else if (innerObj && !currentModel.object.userData.isTransitioning) {
        // Return to neutral when input stops
        innerObj.rotation.x *= 0.94;
        innerObj.rotation.y *= 0.94;
      }
    }
  }

  updateSoloInfoTransform();

  // Snow particles (if active)
  updatePrecipitation(5, getCurrentPrecipType() === 'snow');

  // Subtle model wiggle
  applyModelWiggle();

  renderer.render(scene, camera);

  // Update FPS display if visible
  updateFpsDisplay(renderer, state.isSceneVisible);
  } catch (error) {
    console.error('Animation loop error:', error);
    // Don't let errors crash the loop - continue on next frame
  }
}

// Start the animation loop
export function startAnimation() {
  animate();
}
