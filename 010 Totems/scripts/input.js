import * as THREE from 'three';
import { syncSnowVisibility } from './snow.js';
import {
  state,
  models,
  sceneModels,
  modelInfoById,
  container,
  introOverlay,
  introVideo,
  mobileHeader,
  modelSelectorBtn,
  currentModelNameEl,
  modelDropdown,
  modelDropdownList,
  modelDropdownInfo,
  mouse,
  mouseState,
  gyro,
  gyroState,
  touchState,
  isTouchDevice,
  getGridConfig,
  TAP_THRESHOLD,
  DOUBLE_TAP_THRESHOLD,
  DRAG_THRESHOLD,
  GYRO_SMOOTHING,
  SHAKE_THRESHOLD,
  SHAKE_RESET_TIME,
  SHAKES_NEEDED,
  SWIPE_HINT_DELAY,
  SWIPE_HINT_OFFSET,
  GRID_MODEL_SIZE
} from './state.js';
import { camera } from './scene.js';
import { togglePartyMode } from './scene.js';
import {
  toggleMode,
  switchToModel,
  switchToMobileModel,
  setupModelForMobileSolo
} from './models.js';
import { exitIntro, updateIntroPrompt } from './intro.js';

// Forward declaration for updateModelInfoDisplay
let updateModelInfoDisplayFunc = null;

export function setUpdateModelInfoDisplay(fn) {
  updateModelInfoDisplayFunc = fn;
}

// Raycaster for click detection
const raycaster = new THREE.Raycaster();

// Mobile swipe hint functions
export function getAdjacentIndices() {
  const total = sceneModels.length;
  const prev = (state.mobileCurrentModelIndex - 1 + total) % total;
  const next = (state.mobileCurrentModelIndex + 1) % total;
  return { prev, next };
}

export function setupAdjacentModelsForHint() {
  if (sceneModels.length <= 1) return;

  const { prev, next } = getAdjacentIndices();
  const config = getGridConfig();

  // Setup and position adjacent models off-screen
  [prev, next].forEach((idx, i) => {
    const model = sceneModels[idx];
    if (!model || !model.object) return;

    const innerObj = model.object.userData.innerObject;
    if (!innerObj) return;

    // Scale for mobile
    if (model.object.userData.baseScale) {
      const mobileScale = model.object.userData.baseScale * (config.modelSize / GRID_MODEL_SIZE);
      innerObj.scale.setScalar(mobileScale);
    }

    // Reset rotation
    const baseRotationY = model.object.userData.baseRotationY || 0;
    const baseRotationX = model.object.userData.baseRotationX || 0;
    innerObj.rotation.set(baseRotationX, baseRotationY, 0);

    // Position off-screen (left for prev, right for next)
    const xOffset = i === 0 ? -4 : 4;
    model.object.position.set(xOffset, 0, 0);
    model.object.visible = true;
  });
}

export function hideAdjacentModels() {
  if (sceneModels.length <= 1) return;

  const { prev, next } = getAdjacentIndices();
  [prev, next].forEach((idx) => {
    const model = sceneModels[idx];
    if (model && model.object && idx !== state.mobileCurrentModelIndex) {
      model.object.visible = false;
      model.object.position.set(0, 0, 0);
    }
  });
}

export function resetMobileSwipeHint() {
  if (state.mobileSwipeHintTimer) {
    clearTimeout(state.mobileSwipeHintTimer);
  }
  state.mobileSwipeHintActive = false;
  state.mobileSwipeHintPhase = 0;

  // Hide adjacent models
  hideAdjacentModels();

  // Only start hint timer if not shown yet (show only once per session)
  const config = getGridConfig();
  if (config.isMobileSolo && !state.introActive && sceneModels.length > 1 && !state.mobileSwipeHintShown) {
    state.mobileSwipeHintTimer = setTimeout(() => {
      state.mobileSwipeHintActive = true;
      state.mobileSwipeHintPhase = 0;
      state.mobileSwipeHintShown = true; // Mark as shown
      setupAdjacentModelsForHint();
    }, SWIPE_HINT_DELAY);
  }
}

export function startMobileSwipeHint() {
  const config = getGridConfig();
  if (config.isMobileSolo && !state.introActive) {
    resetMobileSwipeHint();
  }
}

// Mobile header visibility
export function showMobileHeader() {
  if (!mobileHeader || state.mobileHeaderVisible) return;
  state.mobileHeaderVisible = true;
  mobileHeader.classList.remove('hidden');
}

export function hideMobileHeader() {
  if (!mobileHeader || !state.mobileHeaderVisible) return;
  state.mobileHeaderVisible = false;
  mobileHeader.classList.add('hidden');
}

// Mobile dropdown functions
export function toggleDropdown() {
  state.dropdownOpen = !state.dropdownOpen;
  if (modelDropdown) {
    modelDropdown.classList.toggle('visible', state.dropdownOpen);
    modelDropdown.classList.toggle('hidden', !state.dropdownOpen);
  }
  if (modelSelectorBtn) {
    modelSelectorBtn.classList.toggle('open', state.dropdownOpen);
  }
}

export function closeDropdown() {
  state.dropdownOpen = false;
  if (modelDropdown) {
    modelDropdown.classList.remove('visible');
    modelDropdown.classList.add('hidden');
  }
  if (modelSelectorBtn) {
    modelSelectorBtn.classList.remove('open');
  }
}

export function populateDropdown() {
  if (!modelDropdownList) return;
  modelDropdownList.innerHTML = '';

  models.forEach((model, index) => {
    const info = modelInfoById.get(model.id);
    const name = (info && info.heading) ? info.heading : (model.title || `Model ${index + 1}`);

    const item = document.createElement('div');
    item.className = 'dropdown-item';
    item.textContent = name;
    item.dataset.index = index;

    item.addEventListener('click', (e) => {
      e.stopPropagation();
      scrollToModel(index);
      closeDropdown();
    });

    modelDropdownList.appendChild(item);
  });
}

export function updateDropdownActiveState(activeIndex) {
  if (!modelDropdownList) return;
  const items = modelDropdownList.querySelectorAll('.dropdown-item');
  items.forEach((item, index) => {
    item.classList.toggle('active', index === activeIndex);
  });
}

export function scrollToModel(index) {
  const config = getGridConfig();

  if (config.isMobileSolo) {
    // Mobile solo mode - switch to model
    switchToMobileModel(index);
    return;
  }

  if (updateModelInfoDisplayFunc) updateModelInfoDisplayFunc();
}

// Mouse position tracking
export function updateMousePosition(event) {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  mouseState.isMoving = true;
  clearTimeout(mouseState.idleTimer);
  mouseState.idleTimer = setTimeout(() => {
    mouseState.isMoving = false;
  }, 3000);

  updateIntroPrompt(event);
}

// Gyroscope support
export function requestGyroPermission() {
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    // iOS 13+ requires permission
    DeviceOrientationEvent.requestPermission()
      .then((response) => {
        if (response === 'granted') {
          gyroState.permissionGranted = true;
          gyroState.enabled = true;
          window.addEventListener('deviceorientation', handleGyro);
          window.addEventListener('devicemotion', handleShake);
        }
      })
      .catch(console.error);

    // Also request motion permission for shake detection
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      DeviceMotionEvent.requestPermission().catch(() => {});
    }
  } else if ('DeviceOrientationEvent' in window) {
    // Non-iOS devices
    gyroState.permissionGranted = true;
    gyroState.enabled = true;
    window.addEventListener('deviceorientation', handleGyro);
    window.addEventListener('devicemotion', handleShake);
  }
}

export function handleShake(event) {
  const acc = event.accelerationIncludingGravity;
  if (!acc) return;

  const totalAcceleration = Math.sqrt(acc.x * acc.x + acc.y * acc.y + acc.z * acc.z);
  const now = Date.now();

  // Detect sudden acceleration change (shake)
  if (totalAcceleration > SHAKE_THRESHOLD) {
    if (now - gyroState.lastShakeTime > 100) { // Debounce
      gyroState.shakeCount++;
      gyroState.lastShakeTime = now;

      if (gyroState.shakeCount >= SHAKES_NEEDED) {
        gyroState.shakeCount = 0;
        togglePartyMode();
      }
    }
  }

  // Reset shake count if no shakes for a while
  if (now - gyroState.lastShakeTime > SHAKE_RESET_TIME) {
    gyroState.shakeCount = 0;
  }
}

export function handleGyro(event) {
  if (!gyroState.enabled) return;
  try {
    // beta: -180 to 180 (front/back tilt, phone flat = 0 when horizontal, ~90 when vertical)
    // gamma: -90 to 90 (left/right tilt)
    const beta = event.beta || 0;
    const gamma = event.gamma || 0;

    // Skip invalid readings
    if (!isFinite(beta) || !isFinite(gamma)) return;

    // Handle gimbal lock when phone is near upright (beta near 90 or -90)
    // When beta is close to ±90, gamma becomes unreliable
    const isNearUpright = Math.abs(Math.abs(beta) - 90) < 10;

    // Comfortable holding angle: phone held in palm ~30 degrees from horizontal
    const comfortableBeta = 30;
    let normalizedBeta = THREE.MathUtils.clamp((beta - comfortableBeta) / 45, -1, 1);

    // Map gamma -45 to 45 to -1 to 1 for horizontal tilt (left/right)
    // Reduce gamma influence when near upright to prevent wild swings
    let normalizedGamma = THREE.MathUtils.clamp(gamma / 45, -1, 1);
    if (isNearUpright) {
      normalizedGamma *= 0.3; // Dampen gamma when near upright
    }

    // Apply smoothing to prevent jitter
    gyroState.smoothedBeta = THREE.MathUtils.lerp(gyroState.smoothedBeta, normalizedBeta, GYRO_SMOOTHING);
    gyroState.smoothedGamma = THREE.MathUtils.lerp(gyroState.smoothedGamma, normalizedGamma, GYRO_SMOOTHING);

    gyro.beta = gyroState.smoothedBeta;
    gyro.gamma = gyroState.smoothedGamma;
  } catch (e) {
    // Silently ignore errors
  }
}

// Touch handlers
export function onTouchStart(event) {
  if (event.touches.length === 1) {
    const touch = event.touches[0];
    mouse.x = (touch.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(touch.clientY / window.innerHeight) * 2 + 1;

    touchState.startX = touch.clientX;
    touchState.startY = touch.clientY;
    touchState.startTime = Date.now();
    touchState.dragging = false;

    // Mobile solo mode - setup swipe tracking (but not during intro)
    const config = getGridConfig();
    if (config.isMobileSolo && !state.introActive) {
      const sceneRect = container?.getBoundingClientRect();
      const touchInScene = sceneRect && touch.clientY < sceneRect.bottom && touch.clientY > sceneRect.top;

      if (touchInScene) {
        state.mobileSwipeStartX = touch.clientX;
        state.mobileSwipeStartY = touch.clientY;
        state.mobileSwipeDeltaX = 0;
        state.mobileSwipeDeltaY = 0;
        state.isMobileSwiping = true;
        state.mobileSwipeDirection = null;
      } else {
        state.isMobileSwiping = false;
      }
    }
  }
}

export function onTouchMove(event) {
  if (state.introActive) return;
  if (event.touches.length !== 1) return;

  const touch = event.touches[0];
  const deltaX = touch.clientX - touchState.startX;
  const deltaY = touch.clientY - touchState.startY;

  // Check if this is a drag
  if (Math.abs(deltaX) > DRAG_THRESHOLD || Math.abs(deltaY) > DRAG_THRESHOLD) {
    touchState.dragging = true;
  }

  // Mobile solo mode - swipe to change models
  const config = getGridConfig();
  if (config.isMobileSolo && state.isMobileSwiping) {
    state.mobileSwipeDeltaX = touch.clientX - state.mobileSwipeStartX;
    state.mobileSwipeDeltaY = touch.clientY - state.mobileSwipeStartY;

    // Determine swipe direction if not yet locked
    if (!state.mobileSwipeDirection && (Math.abs(state.mobileSwipeDeltaX) > 20 || Math.abs(state.mobileSwipeDeltaY) > 20)) {
      // Lock to horizontal or vertical based on initial direction
      if (Math.abs(state.mobileSwipeDeltaX) > Math.abs(state.mobileSwipeDeltaY)) {
        state.mobileSwipeDirection = 'horizontal';
      } else {
        state.mobileSwipeDirection = 'vertical';
      }
    }

    // Only prevent default for horizontal swipes (model switching)
    // Allow vertical swipes to scroll the page naturally
    if (state.mobileSwipeDirection === 'horizontal') {
      event.preventDefault();
    }
    return;
  }

  // Desktop solo mode - touch drag to rotate model
  if (!config.isMobileSolo && !state.isGridMode && touchState.dragging) {
    event.preventDefault();
    touchState.dragTargetY = (deltaX / window.innerWidth) * Math.PI * 1.5;
    touchState.dragTargetX = (deltaY / window.innerHeight) * Math.PI * 0.8;
  }
}

export function onTouchEnd(event) {
  touchState.lastEndTime = Date.now(); // Track for click prevention

  const config = getGridConfig();

  // Handle mobile solo mode swipe end
  if (config.isMobileSolo && state.isMobileSwiping) {
    state.isMobileSwiping = false;
    const swipeThreshold = 50; // pixels needed to trigger switch

    if (state.mobileSwipeDirection === 'horizontal' && Math.abs(state.mobileSwipeDeltaX) > swipeThreshold) {
      // Horizontal swipe - change model (infinite loop)
      let newIndex;
      if (state.mobileSwipeDeltaX < 0) {
        // Swipe left - next model (loop to first if at end)
        newIndex = (state.mobileCurrentModelIndex + 1) % models.length;
      } else {
        // Swipe right - previous model (loop to last if at start)
        newIndex = (state.mobileCurrentModelIndex - 1 + models.length) % models.length;
      }
      switchToMobileModel(newIndex);
      resetMobileSwipeHint(); // Reset hint timer on swipe
    }

    // Reset swipe state
    state.mobileSwipeDeltaX = 0;
    state.mobileSwipeDeltaY = 0;
    state.mobileSwipeDirection = null;
  }

  if (state.introActive) {
    exitIntro();
    // Request gyro permission on first touch (required by iOS)
    if (isTouchDevice && !gyroState.permissionGranted) {
      requestGyroPermission();
    }
    return;
  }

  const touchDuration = Date.now() - touchState.startTime;
  const wasTap = !touchState.dragging && touchDuration < TAP_THRESHOLD;

  // Reset drag state
  touchState.dragging = false;
  // Keep the rotation where it ended (desktop only)
  if (!config.isMobileSolo) {
    touchState.dragRotationX += touchState.dragTargetX;
    touchState.dragRotationY += touchState.dragTargetY;
  }
  touchState.dragTargetX = 0;
  touchState.dragTargetY = 0;

  // On mobile solo mode, taps don't trigger model interaction
  if (config.isMobileSolo) {
    return;
  }

  // Only trigger interaction on tap, not drag
  if (wasTap && event.changedTouches.length > 0) {
    const touch = event.changedTouches[0];
    mouse.x = (touch.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(touch.clientY / window.innerHeight) * 2 + 1;

    const now = Date.now();
    const timeSinceLastTap = now - touchState.lastTapTime;
    touchState.lastTapTime = now;

    // Double tap in solo mode goes back to grid (desktop only)
    if (!state.isGridMode && timeSinceLastTap < DOUBLE_TAP_THRESHOLD) {
      toggleMode();
      return;
    }

    handleInteraction();
  }
}

export function handleInteraction() {
  if (models.length === 0) return;
  if (state.introJustExited) return; // Ignore click that dismissed intro

  if (state.isGridMode) {
    raycaster.setFromCamera(mouse, camera);

    const modelObjects = sceneModels
      .map((entry) => entry?.object)
      .filter((object) => object && object.visible);

    if (modelObjects.length > 0) {
      const intersections = raycaster.intersectObjects(modelObjects, true);
      if (intersections.length > 0) {
        let target = intersections[0].object;
        while (target && target.userData?.modelIndex === undefined && target.parent) {
          target = target.parent;
        }

        if (target && typeof target.userData?.modelIndex === 'number') {
          switchToModel(target.userData.modelIndex);
          toggleMode();
          return;
        }
      }
    }
  }

  const newIndex = (state.currentModelIndex + 1) % models.length;
  switchToModel(newIndex);
}

export function onClick(event) {
  // Prevent click from firing after touch (mobile fires both)
  if (Date.now() - touchState.lastEndTime < 300) return;

  if (state.introActive) {
    exitIntro();
    // Request gyro permission on click for iOS (needs user gesture)
    if (isTouchDevice && !gyroState.permissionGranted) {
      requestGyroPermission();
    }
    return;
  }

  if (models.length === 0) return;

  // Don't trigger interaction if user is selecting text
  const selection = window.getSelection();
  if (selection && selection.toString().length > 0) {
    return;
  }

  updateMousePosition(event);
  handleInteraction();
}

// Setup event listeners
export function setupEventListeners() {
  window.addEventListener('mousemove', updateMousePosition);
  window.addEventListener('click', onClick);
  window.addEventListener('touchstart', onTouchStart, { passive: true });
  window.addEventListener('touchmove', onTouchMove, { passive: false });
  window.addEventListener('touchend', onTouchEnd);

  // iOS Safari: also add touch listeners directly to intro overlay and video
  // because touch events on video elements can behave differently
  if (introOverlay) {
    introOverlay.addEventListener('click', onClick);
    introOverlay.addEventListener('touchend', onTouchEnd);
  }
  if (introVideo) {
    introVideo.addEventListener('click', onClick);
    introVideo.addEventListener('touchend', onTouchEnd);
  }

  // Setup dropdown event listeners
  if (modelSelectorBtn) {
    modelSelectorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDropdown();
    });
  }

  if (modelDropdownInfo) {
    modelDropdownInfo.addEventListener('click', (e) => {
      e.stopPropagation();
      closeDropdown();
      // Scroll to text section
      const textSection = document.getElementById('text-section');
      if (textSection) {
        textSection.scrollIntoView({ behavior: 'smooth' });
      }
    });
  }

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (state.dropdownOpen && modelDropdown && !modelDropdown.contains(e.target) && e.target !== modelSelectorBtn) {
      closeDropdown();
    }
  });
}

// Request gyro permissions early on touch devices
// iOS requires user gesture, but Android can request immediately
export function initGyroPermissions() {
  if (isTouchDevice) {
    // Check if this is iOS (has requestPermission method)
    const isIOS = typeof DeviceOrientationEvent !== 'undefined' &&
                  typeof DeviceOrientationEvent.requestPermission === 'function';
    if (!isIOS) {
      // Android/other: Request immediately (no user gesture needed)
      requestGyroPermission();
    }
    // iOS will request on first touch in intro exit
  }
}
