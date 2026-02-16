import * as THREE from 'three';
import {
  state,
  sceneModels,
  introOverlay,
  introVideo,
  introPrompt,
  getGridConfig
} from './state.js';
import { toggleMode, updateModeIcon, setupModelForMobileSolo } from './models.js';

// Forward declarations for functions that will be set by other modules
let updateModelInfoDisplayFunc = null;
let startMobileSwipeHintFunc = null;

export function setUpdateModelInfoDisplay(fn) {
  updateModelInfoDisplayFunc = fn;
}

export function setStartMobileSwipeHint(fn) {
  startMobileSwipeHintFunc = fn;
}

export function clearIntroPromptTimers() {
  if (state.introPromptHideTimer) {
    clearTimeout(state.introPromptHideTimer);
    state.introPromptHideTimer = null;
  }
  if (state.introPromptTimer) {
    clearTimeout(state.introPromptTimer);
    state.introPromptTimer = null;
  }
}

// Show intro prompt immediately (called when user tries to scroll)
export function showIntroPromptNow() {
  if (!state.introActive || !introPrompt) return;

  // Clear any existing hide timer and show immediately
  clearIntroPromptTimers();
  introPrompt.classList.add('visible');

  // Hide after 4 seconds
  scheduleIntroPromptHide();
}

// Setup listener for scroll attempts during intro
export function setupIntroScrollDetection() {
  const onScrollAttempt = () => {
    if (state.introActive) {
      showIntroPromptNow();
    }
  };

  // Detect scroll attempts via wheel, touchmove, and scroll events
  window.addEventListener('wheel', onScrollAttempt, { passive: true });
  window.addEventListener('touchmove', onScrollAttempt, { passive: true });
}

// Setup intro video with correct source based on device
export function setupIntroVideo() {
  if (!introVideo) return;

  const introLoading = document.getElementById('intro-loading');
  const isMobile = window.innerWidth <= 900;

  // Set video source based on device
  const videoSrc = isMobile ? './o f917.mp4' : './demonew.mp4';

  // Hide loading when video can play or fails
  const hideLoading = () => {
    if (introLoading) {
      introLoading.classList.add('hidden');
    }
  };

  try {
    introVideo.src = videoSrc;

    introVideo.addEventListener('canplay', hideLoading, { once: true });
    introVideo.addEventListener('canplaythrough', hideLoading, { once: true });
    introVideo.addEventListener('error', (e) => {
      // Log error but don't crash - video is not critical
      console.warn('Intro video failed to load:', e);
      hideLoading();
    }, { once: true });

    // Handle stalled video (common on older devices with slow connections)
    introVideo.addEventListener('stalled', () => {
      // If video stalls for too long, just hide loading and continue
      setTimeout(hideLoading, 2000);
    }, { once: true });

  } catch (e) {
    // Video setup failed - hide loading and continue without video
    console.warn('Video setup error:', e);
    hideLoading();
  }

  // Don't call load() - let browser handle it naturally with autoplay
  // This reduces memory pressure on Safari mobile

  // Fallback: hide loading after 5 seconds even if video hasn't loaded
  setTimeout(hideLoading, 5000);

  // Cleanup on page unload to prevent memory leaks
  window.addEventListener('beforeunload', cleanupIntroVideo);
  window.addEventListener('pagehide', cleanupIntroVideo);
}

// Cleanup video resources - wrapped in try-catch for older Safari
function cleanupIntroVideo() {
  try {
    if (introVideo) {
      introVideo.pause();
      introVideo.removeAttribute('src');
      introVideo.load(); // Reset video element
    }
  } catch (e) {
    // Ignore cleanup errors on older browsers
  }
}

export function scheduleIntroPromptHide() {
  if (!introPrompt) return;
  if (state.introPromptHideTimer) {
    clearTimeout(state.introPromptHideTimer);
  }
  state.introPromptHideTimer = setTimeout(() => {
    introPrompt.classList.remove('visible');
    state.introPromptHideTimer = null;
  }, 4000);
}

export function updateIntroPrompt() {
  // Intro prompt is now static - no mouse following needed
}

export function triggerGridIntroRandomization() {
  if (!state.gridIntroRandomizationPending || !state.isGridMode) return;

  let awaiting = false;
  sceneModels.forEach((entry) => {
    if (!entry || !entry.object) {
      awaiting = true;
      return;
    }
    applyGridIntroRandomization(entry);
  });

  if (!awaiting) {
    state.gridIntroRandomizationPending = false;
  }
}

export function applyGridIntroRandomization(entry) {
  const group = entry && entry.object;
  if (!group) return false;
  if (group.userData.gridIntroAnimationId === state.gridIntroAnimationId) {
    group.userData.gridIntroAnimating = true;
    return false;
  }

  const innerObj = group.userData.innerObject;
  if (!innerObj) return false;

  innerObj.rotation.x = (Math.random() - 0.5) * Math.PI * 1.2;
  innerObj.rotation.y = (Math.random() - 0.5) * Math.PI * 2;
  innerObj.rotation.z = (Math.random() - 0.5) * Math.PI * 0.4;

  group.userData.gridIntroAnimating = true;
  group.userData.gridIntroAnimationId = state.gridIntroAnimationId;
  return true;
}

export function exitIntro() {
  if (!state.introActive) return;
  state.introActive = false;
  state.introJustExited = true;

  // Small delay before allowing interactions
  setTimeout(() => {
    state.introJustExited = false;
  }, 300);

  // Enable scrolling
  document.documentElement.classList.remove('intro-active');
  document.body.classList.remove('intro-active');

  if (introOverlay) {
    introOverlay.classList.add('hidden');
  }

  if (introVideo) {
    introVideo.pause();
  }

  if (introPrompt) {
    introPrompt.classList.remove('visible');
  }

  clearIntroPromptTimers();

  const config = getGridConfig();
  const delay = config.isMobileSolo ? 300 : 0;

  setTimeout(() => {
    if (config.isMobileSolo) {
      // Mobile: Start in solo mode with first model
      state.isGridMode = false;
      state.mobileCurrentModelIndex = 0;
      state.currentModelIndex = 0;

      // Setup first model, ensure others are hidden
      const firstModel = sceneModels[0];
      if (firstModel && firstModel.object) {
        // Hide all models first
        sceneModels.forEach((model) => {
          if (model && model.object) {
            model.object.visible = false;
          }
        });

        // Setup and show only the first model
        setupModelForMobileSolo(firstModel);
        firstModel.object.visible = true;
      }

      updateModeIcon();
      if (updateModelInfoDisplayFunc) updateModelInfoDisplayFunc();
      if (startMobileSwipeHintFunc) startMobileSwipeHintFunc(); // Start hint timer
    } else {
      // Desktop: Enter grid mode after intro
      state.isGridMode = false;
      toggleMode(); // Toggle to grid mode

      // Trigger grid intro animation
      state.gridIntroAnimationId += 1;
      state.gridIntroRandomizationPending = true;
      triggerGridIntroRandomization();

      if (updateModelInfoDisplayFunc) updateModelInfoDisplayFunc();
    }
  }, delay);
}

export function showIntro() {
  if (!introOverlay) return;

  state.introActive = true;
  introOverlay.classList.remove('hidden');

  if (introPrompt) {
    introPrompt.classList.remove('visible');
  }

  clearIntroPromptTimers();

  if (introVideo) {
    introVideo.currentTime = 0;
    const playPromise = introVideo.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => {});
    }
  }

  if (updateModelInfoDisplayFunc) updateModelInfoDisplayFunc();
}
