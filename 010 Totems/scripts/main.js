// Main entry point - orchestrates all modules
import { clearSnowAccumulation, setPrecipitation, getCurrentPrecipType } from './snow.js';
import {
  state,
  models,
  sceneModels,
  setModels,
  setModelInfoById,
  gridModeIcon,
  isTouchDevice,
  setupMemoryMonitor
} from './state.js';
import { togglePartyMode, setUpdateModelListActiveState } from './scene.js';
import {
  loadModelManifest,
  loadModelInfo,
  loadModel,
  toggleMode,
  switchToModel,
  updateModeIcon,
  showLoadingError,
  setUpdateModelInfoDisplay as setModelsUpdateModelInfoDisplay,
  setUpdateModelListActiveState as setModelsUpdateModelListActiveState,
  setUpdateHeaderVisibility,
  setUpdateModelListVisibility,
  setTriggerGridIntroRandomization
} from './models.js';
import {
  showIntro,
  triggerGridIntroRandomization,
  setUpdateModelInfoDisplay as setIntroUpdateModelInfoDisplay,
  setStartMobileSwipeHint,
  setupIntroScrollDetection,
  setupIntroVideo
} from './intro.js';
import {
  setupEventListeners,
  initGyroPermissions,
  populateDropdown,
  startMobileSwipeHint,
  setUpdateModelInfoDisplay as setInputUpdateModelInfoDisplay
} from './input.js';
import {
  updateModelInfoDisplay,
  populateModelList,
  setupModelListListeners,
  setupGoTopListeners,
  loadTextContent,
  setupScrollListener,
  toggleFpsDisplay,
  updateModelListActiveState,
  updateHeaderVisibility,
  updateModelListVisibility
} from './ui.js';
import {
  startAnimation,
  setupActivityTracking,
  setupResizeHandler
} from './animation.js';

// Wire up cross-module function references
setModelsUpdateModelInfoDisplay(updateModelInfoDisplay);
setModelsUpdateModelListActiveState(updateModelListActiveState);
setUpdateHeaderVisibility(updateHeaderVisibility);
setUpdateModelListVisibility(updateModelListVisibility);
setTriggerGridIntroRandomization(triggerGridIntroRandomization);
setIntroUpdateModelInfoDisplay(updateModelInfoDisplay);
setStartMobileSwipeHint(startMobileSwipeHint);
setInputUpdateModelInfoDisplay(updateModelInfoDisplay);
setUpdateModelListActiveState(updateModelListActiveState);

// Grid mode icon click handler
if (gridModeIcon) {
  gridModeIcon.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    if (state.introActive || state.isGridMode) return;
    toggleMode();
  });
}

// Keyboard shortcuts
window.addEventListener('keydown', (event) => {
  if (event.key === 'r' || event.key === 'R') {
    event.preventDefault();
    showIntro();
    return;
  }
  if (event.code === 'Space') {
    event.preventDefault();
    togglePartyMode();
    return;
  }
  // Toggle snow with S key (desktop only)
  if (event.key === 's' || event.key === 'S') {
    event.preventDefault();
    if (getCurrentPrecipType() === 'snow') {
      clearSnowAccumulation();
      setPrecipitation('none');
      console.log('Snow: OFF');
    } else {
      clearSnowAccumulation(); // Clear first to force fresh calculation
      setPrecipitation('snow');
      console.log('Snow: ON');
    }
  }
  // Toggle FPS display with F key
  if (event.key === 'f' || event.key === 'F') {
    event.preventDefault();
    toggleFpsDisplay();
  }
});

// Set intro-active class initially to prevent scrolling
document.documentElement.classList.add('intro-active');
document.body.classList.add('intro-active');

// Initialize the application
async function init() {
  let loadedModels;
  try {
    loadedModels = await loadModelManifest();
    setModels(loadedModels);
  } catch (error) {
    console.error('Failed to load model manifest:', error);
    showLoadingError('Failed to load models. Check the console for details.');
    return;
  }

  try {
    const infoMap = await loadModelInfo();
    setModelInfoById(infoMap);
  } catch (error) {
    console.warn('Failed to load model info:', error);
    setModelInfoById(new Map());
  }

  // Re-import models after setting them (ES6 module semantics)
  const { models: currentModels, modelInfoById: currentModelInfoById } = await import('./state.js');

  if (currentModels.length === 0) {
    console.warn('No models found in models.json.');
    showLoadingError('No models available. Add files to the objs folder and rebuild.');
    return;
  }

  state.modelsLoaded = 0;
  state.totalAssetsToLoad = currentModels.length;
  state.hasCompletedInitialLoad = false;
  sceneModels.length = 0;

  currentModels.forEach((modelConfig, index) => {
    loadModel(modelConfig, index);
  });

  switchToModel(0);
  updateModeIcon();
  updateModelInfoDisplay();
  populateDropdown();
  populateModelList();
}

// Setup all event listeners and handlers
setupEventListeners();
setupModelListListeners();
setupGoTopListeners();
setupScrollListener();
setupActivityTracking();
setupResizeHandler();
setupIntroScrollDetection();
setupIntroVideo();

// Initialize gyro permissions
initGyroPermissions();

// Setup memory monitoring for low-end device detection
setupMemoryMonitor();

// Load text content
loadTextContent();

// Initialize and start the application
init();
startAnimation();
