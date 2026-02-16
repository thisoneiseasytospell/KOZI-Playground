import {
  state,
  models,
  modelInfoById,
  container,
  soloInfoPanel,
  soloInfoTitle,
  soloInfoBody,
  currentModelNameEl,
  mobileGoTop,
  modelSelectorBtn,
  uiOverlay,
  soloGoTop,
  modelList,
  modelListItems,
  modelListGoTop,
  textContent,
  getGridConfig,
  MODEL_LIST_ACTIVE_SIZE,
  MODEL_LIST_ACTIVE_OPACITY,
  MODEL_LIST_MIN_SIZE,
  MODEL_LIST_MIN_OPACITY,
  GOLDEN_RATIO
} from './state.js';
import { switchToModel } from './models.js';
import { updateDropdownActiveState } from './input.js';

// Model info display
export function updateModelInfoDisplay() {
  if (!soloInfoPanel || !soloInfoTitle) return;

  const config = getGridConfig();

  // On mobile solo mode, use mobileCurrentModelIndex
  const displayIndex = config.isMobileSolo
    ? state.mobileCurrentModelIndex
    : state.currentModelIndex;

  const currentModel = models[displayIndex];
  const info = currentModel ? modelInfoById.get(currentModel.id) : null;

  // Remove description body
  if (soloInfoBody) soloInfoBody.innerHTML = '';

  if (!currentModel) {
    soloInfoTitle.textContent = '';
    soloInfoPanel.classList.remove('visible');
    return;
  }

  // Just show the name
  const heading = (info && typeof info.heading === 'string' && info.heading.trim().length > 0)
    ? info.heading
    : (currentModel.title || '');
  soloInfoTitle.textContent = heading;

  // Update mobile header model name
  if (currentModelNameEl) {
    currentModelNameEl.textContent = heading || 'Model';
  }

  const hasContent = Boolean(heading);
  // Show in solo mode (desktop or mobile)
  const shouldShow = !state.introActive && hasContent && (!state.isGridMode || config.isMobileSolo);
  if (shouldShow) {
    soloInfoPanel.classList.add('visible');
  } else {
    soloInfoPanel.classList.remove('visible');
  }

  // Update dropdown active state
  updateDropdownActiveState(displayIndex);
}

export function updateSoloInfoTransform() {
  // Label is now static - no mouse following or special effects
  // Color is handled by CSS dark mode classes
}

// Model list color helper
function getModelListColor(opacity) {
  // Return appropriate color based on dark mode
  return state.isDarkMode
    ? `rgba(245, 247, 255, ${opacity})`
    : `rgba(8, 9, 13, ${opacity})`;
}

// Update model list active state
export function updateModelListActiveState() {
  if (!modelListItems) return;
  const items = modelListItems.querySelectorAll('.model-list-item');
  const activeIndex = state.currentModelIndex;
  // Use full golden ratio when not hovering
  const ratio = GOLDEN_RATIO;

  items.forEach((item, index) => {
    const distance = Math.abs(index - activeIndex);
    const isActive = index === activeIndex;

    item.classList.toggle('active', isActive);

    // Progressive sizing: each step away divides by ratio
    const size = Math.max(MODEL_LIST_MIN_SIZE, MODEL_LIST_ACTIVE_SIZE / Math.pow(ratio, distance * 0.5));
    const opacity = Math.max(MODEL_LIST_MIN_OPACITY, MODEL_LIST_ACTIVE_OPACITY / Math.pow(ratio, distance * 0.6));

    item.style.fontSize = `${size}px`;
    item.style.color = getModelListColor(opacity);
  });
}

export function updateModelListHover(mouseY) {
  if (!modelListItems) return;
  const items = modelListItems.querySelectorAll('.model-list-item');

  // Find which item is closest to mouse
  let closestIndex = 0;
  let closestDistance = Infinity;

  items.forEach((item, index) => {
    const rect = item.getBoundingClientRect();
    const itemCenterY = rect.top + rect.height / 2;
    const dist = Math.abs(mouseY - itemCenterY);
    if (dist < closestDistance) {
      closestDistance = dist;
      closestIndex = index;
    }
  });

  // Scale based on distance from hovered item (half golden ratio effect)
  items.forEach((item, index) => {
    const distance = Math.abs(index - closestIndex);

    const size = Math.max(MODEL_LIST_MIN_SIZE, MODEL_LIST_ACTIVE_SIZE / Math.pow(GOLDEN_RATIO, distance * 0.25));
    const opacity = Math.max(MODEL_LIST_MIN_OPACITY, MODEL_LIST_ACTIVE_OPACITY / Math.pow(GOLDEN_RATIO, distance * 0.3));

    item.style.fontSize = `${size}px`;
    item.style.color = getModelListColor(opacity);
  });
}

// Populate model list (desktop sidebar)
export function populateModelList() {
  if (!modelListItems) return;
  modelListItems.innerHTML = '';

  models.forEach((model, index) => {
    const info = modelInfoById.get(model.id);
    const name = (info && info.heading) ? info.heading : (model.title || `Model ${index + 1}`);

    const item = document.createElement('div');
    item.className = 'model-list-item';
    item.textContent = name;
    item.dataset.index = index;

    item.addEventListener('click', (e) => {
      e.stopPropagation();
      switchToModel(index);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    modelListItems.appendChild(item);
  });

  updateModelListActiveState();
}

// Setup model list hover listeners
export function setupModelListListeners() {
  if (modelList) {
    modelList.addEventListener('mouseenter', () => {
      state.modelListHovering = true;
    });

    modelList.addEventListener('mousemove', (e) => {
      if (!state.modelListHovering) return;
      updateModelListHover(e.clientY);
    });

    modelList.addEventListener('mouseleave', () => {
      state.modelListHovering = false;
      updateModelListActiveState();
    });
  }
}

// Clear all pending animation timeouts
function clearModelListAnimations() {
  state.modelListAnimationTimeouts.forEach(id => clearTimeout(id));
  state.modelListAnimationTimeouts = [];
}

function blurOutModelListItems() {
  // Cancel any pending animations
  clearModelListAnimations();
  state.modelListShowingGoTop = true;

  const items = modelListItems.querySelectorAll('.model-list-item');
  const activeIndex = state.currentModelIndex;

  // Sort items by distance from active (furthest first)
  const sortedItems = Array.from(items).map((item, index) => ({
    item,
    distance: Math.abs(index - activeIndex),
    index
  })).sort((a, b) => b.distance - a.distance);

  // Blur out items sequentially (furthest from active first)
  sortedItems.forEach((entry, i) => {
    const id = setTimeout(() => {
      entry.item.classList.add('blurring-out');
    }, i * 40);
    state.modelListAnimationTimeouts.push(id);
  });
}

function showModelListItems() {
  // Cancel any pending animations
  clearModelListAnimations();
  state.modelListShowingGoTop = false;

  const items = modelListItems.querySelectorAll('.model-list-item');
  const activeIndex = state.currentModelIndex;

  // Sort items by distance from active (closest first)
  const sortedItems = Array.from(items).map((item, index) => ({
    item,
    distance: Math.abs(index - activeIndex),
    index
  })).sort((a, b) => a.distance - b.distance);

  // Remove blur from all items immediately then animate in
  const startId = setTimeout(() => {
    sortedItems.forEach((entry, i) => {
      const id = setTimeout(() => {
        entry.item.classList.remove('blurring-out');
      }, i * 40);
      state.modelListAnimationTimeouts.push(id);
    });
  }, 100);
  state.modelListAnimationTimeouts.push(startId);
}

export function updateModelListVisibility() {
  if (!modelList) return;
  const isDesktop = window.innerWidth > 900;
  const isScrolledDown = window.scrollY > 300;

  // Hide model list when intro active or on mobile
  if (state.introActive || !isDesktop) {
    modelList.classList.remove('visible');
    return;
  }

  // In grid mode: only show when scrolled (for go-to-top only, no menu items)
  if (state.isGridMode) {
    if (isScrolledDown) {
      // Hide items FIRST before showing the list
      if (modelListItems) {
        const items = modelListItems.querySelectorAll('.model-list-item');
        items.forEach(item => item.classList.add('blurring-out'));
      }
      modelList.classList.add('visible');
    } else {
      modelList.classList.remove('visible');
    }
  } else {
    // Solo mode - always show model list with items visible
    modelList.classList.add('visible');
    // Reset blur state when entering solo mode (if not scrolled)
    if (!isScrolledDown && modelListItems) {
      const items = modelListItems.querySelectorAll('.model-list-item');
      items.forEach(item => item.classList.remove('blurring-out'));
      state.modelListShowingGoTop = false;
    }
  }
}

// Toggle model list between model picker and go-to-top based on scroll
export function updateModelListState() {
  if (!modelList || !modelListItems || state.isGridMode || state.introActive) {
    // Reset state when not in solo mode
    if (state.modelListShowingGoTop) {
      showModelListItems();
    }
    return;
  }

  const sceneRect = container?.getBoundingClientRect();
  const isModelVisible = sceneRect && sceneRect.bottom > 100;

  if (isModelVisible && state.modelListShowingGoTop) {
    // Scroll back up - show model items
    showModelListItems();
  } else if (!isModelVisible && !state.modelListShowingGoTop) {
    // Scroll down - blur out items sequentially
    blurOutModelListItems();
  }
}

// Show go-to-top when scrolled down (both grid and solo mode)
export function updateGoTopVisibility() {
  if (!modelListGoTop || state.introActive) {
    modelListGoTop?.classList.remove('visible');
    return;
  }

  const isScrolledDown = window.scrollY > 300;

  if (isScrolledDown) {
    // In solo mode, hide menu items IMMEDIATELY before showing go-to-top
    if (!state.isGridMode && modelListItems) {
      const items = modelListItems.querySelectorAll('.model-list-item');
      items.forEach(item => item.classList.add('blurring-out'));
      state.modelListShowingGoTop = true;
    }
    modelListGoTop.classList.add('visible');
  } else {
    modelListGoTop.classList.remove('visible');
    // In solo mode, show menu items after hiding go-to-top
    if (!state.isGridMode && state.modelListShowingGoTop && modelListItems) {
      showModelListItems();
    }
  }
}

// Show header when in solo mode or when scrolled to text section
export function updateHeaderVisibility() {
  const sceneBottom = container?.getBoundingClientRect().bottom || 0;
  const isScrolledPastScene = sceneBottom < window.innerHeight * 0.5;

  if ((!state.isGridMode && !state.introActive) || (isScrolledPastScene && !state.introActive)) {
    uiOverlay?.classList.add('visible');
  } else {
    uiOverlay?.classList.remove('visible');
  }
}

// Toggle model name / go to top based on model visibility
export function updateSoloInfoState() {
  if (state.isGridMode || state.introActive) {
    soloInfoPanel?.classList.remove('show-go-top');
    return;
  }

  const sceneRect = container?.getBoundingClientRect();
  const isModelVisible = sceneRect && sceneRect.bottom > 100;

  if (isModelVisible) {
    soloInfoPanel?.classList.remove('show-go-top');
  } else {
    soloInfoPanel?.classList.add('show-go-top');
  }
}

// Update mobile go-to-top visibility based on scroll
export function updateMobileGoTopVisibility() {
  if (!mobileGoTop || !modelSelectorBtn) return;

  const textSection = document.getElementById('text-section');
  if (!textSection) return;

  const textRect = textSection.getBoundingClientRect();
  const isInTextSection = textRect.top < window.innerHeight * 0.5;

  if (isInTextSection) {
    mobileGoTop.classList.add('visible');
  } else {
    mobileGoTop.classList.remove('visible');
  }
}

// Setup go-to-top button listeners
export function setupGoTopListeners() {
  // Solo mode go to top
  if (soloGoTop) {
    soloGoTop.addEventListener('click', (e) => {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // Model list go to top (desktop sidebar)
  if (modelListGoTop) {
    modelListGoTop.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // Mobile go to top
  if (mobileGoTop) {
    mobileGoTop.addEventListener('click', (e) => {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }
}

// Text content loading and word reveal
function processWordQueue() {
  if (state.isProcessingWords || state.wordRevealQueue.length === 0) return;

  state.isProcessingWords = true;
  const isMobile = window.innerWidth <= 900;

  // On mobile: reveal ALL words immediately to avoid RAF competition with scroll
  // On desktop: staggered reveal for effect
  if (isMobile) {
    // Reveal everything at once - no loop, no RAF
    while (state.wordRevealQueue.length > 0) {
      const word = state.wordRevealQueue.shift();
      if (word && word.classList.contains('word-pending')) {
        word.classList.remove('word-pending');
        word.classList.add('word-revealed');
      }
    }
    state.isProcessingWords = false;
    return;
  }

  // Desktop: staggered reveal
  const batchSize = 12;
  for (let i = 0; i < batchSize && state.wordRevealQueue.length > 0; i++) {
    const word = state.wordRevealQueue.shift();
    if (word && word.classList.contains('word-pending')) {
      word.classList.remove('word-pending');
      word.classList.add('word-revealed');
    }
  }

  setTimeout(() => {
    state.isProcessingWords = false;
    processWordQueue();
  }, 60);
}

export function setupWordReveal() {
  const textLines = document.querySelectorAll('.text-line');

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const line = entry.target;

      if (entry.isIntersecting && !line.classList.contains('line-revealed')) {
        line.classList.add('line-revealed');

        const words = Array.from(line.querySelectorAll('.text-word'));

        // Add words to reveal queue - reverse order if scrolling up
        const wordsToAdd = state.scrollDirection === 'up' ? [...words].reverse() : words;
        wordsToAdd.forEach((word) => {
          if (!word.classList.contains('word-revealed') && !word.classList.contains('word-pending')) {
            word.classList.add('word-pending');
            state.wordRevealQueue.push(word);
          }
        });
        processWordQueue();

      } else if (!entry.isIntersecting && line.classList.contains('line-revealed')) {
        // Line left viewport - instantly hide all words (no queue/animation)
        line.classList.remove('line-revealed');
        const words = Array.from(line.querySelectorAll('.text-word'));

        // Remove from reveal queue and instantly hide
        words.forEach((word) => {
          word.classList.remove('word-pending', 'word-revealed');
          const idx = state.wordRevealQueue.indexOf(word);
          if (idx > -1) state.wordRevealQueue.splice(idx, 1);
        });
      }
    });
  }, {
    threshold: 0.2,
    rootMargin: '0px 0px -30px 0px'
  });

  textLines.forEach(line => observer.observe(line));
}

export function loadTextContent() {
  // Text is now static HTML - just setup the word reveal observer
  setupWordReveal();
}

// Setup scroll listener for UI updates
export function setupScrollListener() {
  // Track scroll direction - merged into single listener below
  // Scroll listener for header and solo info state
  let scrollThrottleTimer = null;
  let lastMobileUpdate = 0;

  // Cache text section reference for mobile
  const textSection = document.getElementById('text-section');

  window.addEventListener('scroll', () => {
    // Always track scroll direction (cheap operation)
    state.scrollDirection = window.scrollY > state.lastScrollY ? 'down' : 'up';
    state.lastScrollY = window.scrollY;

    const isMobile = window.innerWidth <= 900;

    if (isMobile) {
      // Mobile: much slower throttle (150ms) - only update go-to-top visibility
      const now = Date.now();
      if (now - lastMobileUpdate < 150) return;
      lastMobileUpdate = now;

      // Inline the check to avoid function call overhead
      if (mobileGoTop && textSection) {
        const isInTextSection = textSection.getBoundingClientRect().top < window.innerHeight * 0.5;
        mobileGoTop.classList.toggle('visible', isInTextSection);
      }
    } else {
      // Desktop: normal throttle
      if (scrollThrottleTimer) return;
      scrollThrottleTimer = setTimeout(() => {
        scrollThrottleTimer = null;
      }, 16);

      updateModelListVisibility();
      updateGoTopVisibility();
      updateHeaderVisibility();
      updateSoloInfoState();
      updateModelListState();
    }
  }, { passive: true });
}

// FPS counter
function createFpsElement() {
  state.fpsElement = document.createElement('div');
  state.fpsElement.id = 'fps-display';
  state.fpsElement.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    background: rgba(0, 0, 0, 0.7);
    color: #0f0;
    font-family: monospace;
    font-size: 14px;
    padding: 8px 12px;
    border-radius: 4px;
    z-index: 9999;
    display: none;
  `;
  document.body.appendChild(state.fpsElement);
}

export function toggleFpsDisplay() {
  if (!state.fpsElement) createFpsElement();
  state.fpsDisplayVisible = !state.fpsDisplayVisible;
  state.fpsElement.style.display = state.fpsDisplayVisible ? 'block' : 'none';
  console.log('FPS display:', state.fpsDisplayVisible ? 'ON' : 'OFF');
}

export function updateFpsDisplay(renderer, isSceneVisible) {
  if (!state.fpsDisplayVisible || !state.fpsElement) return;

  state.fpsFrameCount++;
  const now = performance.now();
  const elapsed = now - state.fpsLastTime;

  if (elapsed >= 500) { // Update every 500ms
    state.currentFps = Math.round((state.fpsFrameCount * 1000) / elapsed);
    state.fpsFrameCount = 0;
    state.fpsLastTime = now;

    const resolution = `${renderer.domElement.width}x${renderer.domElement.height}`;
    const stateLabel = state.isIdle ? 'IDLE' : (isSceneVisible ? 'ACTIVE' : 'HIDDEN');
    state.fpsElement.innerHTML = `FPS: ${state.currentFps}<br>Res: ${resolution}<br>State: ${stateLabel}`;
  }
}
