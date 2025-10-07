let cam;
let uploadedImage = null;
let originalImage = null; // Store original before grey scale processing
let inputMode = 'camera'; // 'camera' or 'image'
let imageOffsetX = 0; // Smooth horizontal movement for images
const isMobileDevice = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
let cellSize = isMobileDevice ? 10 : 12; // Smaller cells on mobile for higher res
let cols, rows;
let grid;
let pg; // Graphics buffer for better performance

const asciiChars = " .:AkerBP";
let fadeAmount = 15;
let inverted = false;
let glitchEnabled = true;

// Camera switching for mobile
let currentCamera = 'user'; // 'user' = front, 'environment' = back

// Mobile controls menu
let menuOpen = false;

const ui = {};
let statsUpdateFrame = 0;

// Image controls
let imageScale = 1.0;
let imagePositionX = 0; // Manual position offset
let imagePositionY = 0;
let greyScaleLevels = 6; // Number of grey levels (2-10)
let isDraggingImage = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartPosX = 0;
let dragStartPosY = 0;

// Export controls
let isExportingVideo = false;
let videoFrameCount = 0;
let videoTotalFrames = 250; // 10 seconds at 25fps
let mp4Encoder = null;

// SVG trail history - store last N frames for vector export
let trailHistory = [];
const maxTrailFrames = 20; // Keep last 20 frames for trail effect

let lastGlitchTime = 0;
let glitchInterval = 5000;
let isGlitching = false;
let glitchDuration = 0;
let glitchType = 0;
let exportGlitchTriggered = false; // Track if glitch happened during export

// Performance optimization
let framesSinceStart = 0;
let performanceCheckDone = false;
const TARGET_FPS = 25;
const PERFORMANCE_CHECK_INTERVAL = 30; // Check every 30 frames
const MAX_ADJUSTMENTS = 5; // Stop after 5 adjustments
let adjustmentCount = 0;

async function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1); // Reduce pixel density for better performance

  initCamera();
  setupUI();
  setupDragAndDrop();

  updateGrid();

  textAlign(CENTER, CENTER);
  textFont('ABCDiatype'); // Use ABCDiatype for consistent ASCII rendering
  background(0);
  frameRate(30);

  // Load H264 encoder module (it's already loaded via script tag as window.HME)
  console.log('Waiting for H264 encoder to initialize...');

  // The library is exposed as window.HME
  const checkEncoder = setInterval(() => {
    if (window.HME && typeof window.HME.createH264MP4Encoder === 'function') {
      clearInterval(checkEncoder);
      console.log('H264 encoder loaded successfully!');

      // Update UI to show encoder is ready
      if (ui.exportMP4Btn) {
        ui.exportMP4Btn.textContent = 'Export MP4';
        ui.exportMP4Btn.disabled = inputMode !== 'image' || isExportingVideo;
        ui.exportMP4Btn.dataset.state = 'ready';
      }
    }
  }, 100);

  // Timeout after 15 seconds
  setTimeout(() => {
    if (!window.HME) {
      clearInterval(checkEncoder);
      console.error('Failed to load H264 encoder: timeout');
      console.log('Available globals:', Object.keys(window).filter(k => k.includes('264') || k.includes('encoder') || k.includes('HME')));
      if (ui.exportMP4Btn) {
        ui.exportMP4Btn.textContent = 'Export MP4 (encoder failed)';
        ui.exportMP4Btn.disabled = true;
        ui.exportMP4Btn.dataset.state = 'failed';
      }
    }
  }, 15000);
}

function setupDragAndDrop() {
  // Prevent default drag behavior
  document.body.addEventListener('dragover', function(e) {
    e.preventDefault();
    e.stopPropagation();
  });

  document.body.addEventListener('drop', function(e) {
    e.preventDefault();
    e.stopPropagation();

    const files = e.dataTransfer.files;
    if (files.length > 0 && files[0].type.startsWith('image/')) {
      processImageFile(files[0]);
    }
  });
}

function processImageFile(file) {
  console.log('Processing dropped/uploaded image...');
  const reader = new FileReader();
  reader.onload = function(event) {
    const img = new Image();
    img.onload = function() {
      originalImage = img;
      console.log(`Image loaded, processing to ${greyScaleLevels} greys...`);

      const processed = processImageToGreys(img, greyScaleLevels);
      processed.onload = function() {
        console.log('Converting to p5.Image...');
        uploadedImage = createImage(processed.width, processed.height);
        uploadedImage.drawingContext.drawImage(processed, 0, 0);
        uploadedImage.loadPixels();

        inputMode = 'image';
        imagePositionX = 0;
        imagePositionY = 0;
        console.log('Image ready!');

        // Stop camera to save resources
        if (cam) {
          cam.stop();
        }

        refreshToolbarIndicators();
      };
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
}

function setupUI() {
  ui.fileInput = document.getElementById('imageUpload');
  ui.uploadButton = document.getElementById('uploadButton');
  ui.cameraModeButton = document.getElementById('cameraModeButton');
  ui.swapCameraButton = document.getElementById('swapCameraButton');
  ui.cellSmallerButton = document.getElementById('cellSmallerButton');
  ui.cellBiggerButton = document.getElementById('cellBiggerButton');
  ui.trailButton = document.getElementById('trailButton');
  ui.randomButton = document.getElementById('randomButton');
  ui.invertButton = document.getElementById('invertButton');
  ui.glitchButton = document.getElementById('glitchButton');
  ui.scaleSlider = document.getElementById('scaleSlider');
  ui.scaleValue = document.getElementById('scaleValue');
  ui.greySlider = document.getElementById('greySlider');
  ui.greyValue = document.getElementById('greyValue');
  ui.exportSVGBtn = document.getElementById('exportSVG');
  ui.exportPDFBtn = document.getElementById('exportPDF');
  ui.exportMP4Btn = document.getElementById('exportMP4');
  ui.exportStatus = document.getElementById('exportStatus');
  ui.imageControls = document.getElementById('imageControls');
  ui.toolbarStats = document.getElementById('toolbarStats');

  if (ui.uploadButton && ui.fileInput) {
    ui.uploadButton.addEventListener('click', () => ui.fileInput.click());
  }

  if (ui.fileInput) {
    ui.fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file && file.type.startsWith('image/')) {
        processImageFile(file);
      }
    });
  }

  if (ui.cameraModeButton) {
    ui.cameraModeButton.addEventListener('click', () => {
      if (inputMode === 'image') {
        switchToCameraMode();
      }
    });
  }

  if (ui.swapCameraButton) {
    if (isMobileDevice) {
      ui.swapCameraButton.style.display = 'inline-flex';
      ui.swapCameraButton.addEventListener('click', () => {
        if (inputMode === 'camera') {
          swapCamera();
        }
      });
    } else {
      ui.swapCameraButton.style.display = 'none';
    }
  }

  const adjustCellSize = (delta) => {
    cellSize = constrain(cellSize + delta, 6, 40);
    updateGrid();
    refreshToolbarIndicators();
  };

  if (ui.cellBiggerButton) {
    ui.cellBiggerButton.addEventListener('click', () => adjustCellSize(2));
  }

  if (ui.cellSmallerButton) {
    ui.cellSmallerButton.addEventListener('click', () => adjustCellSize(-2));
  }

  if (ui.trailButton) {
    ui.trailButton.addEventListener('click', () => {
      fadeAmount = (fadeAmount === 15) ? 40 : 15;
      refreshToolbarIndicators();
    });
  }

  if (ui.randomButton) {
    ui.randomButton.addEventListener('click', () => {
      cycleRandomAmount();
      refreshToolbarIndicators();
    });
  }

  if (ui.invertButton) {
    ui.invertButton.addEventListener('click', () => {
      inverted = !inverted;
      refreshToolbarIndicators();
    });
  }

  if (ui.glitchButton) {
    ui.glitchButton.addEventListener('click', () => {
      glitchEnabled = !glitchEnabled;
      if (!glitchEnabled) {
        isGlitching = false;
        exportGlitchTriggered = false;
        lastGlitchTime = millis();
      } else {
        lastGlitchTime = millis();
      }
      refreshToolbarIndicators();
    });
  }

  if (ui.scaleSlider) {
    ui.scaleSlider.addEventListener('input', (event) => {
      imageScale = parseFloat(event.target.value);
      if (ui.scaleValue) {
        ui.scaleValue.textContent = `${imageScale.toFixed(1)}x`;
      }
    });
  }

  if (ui.greySlider) {
    ui.greySlider.addEventListener('input', (event) => {
      greyScaleLevels = parseInt(event.target.value, 10);
      if (ui.greyValue) {
        ui.greyValue.textContent = greyScaleLevels;
      }

      if (originalImage && inputMode === 'image') {
        console.log(`Reprocessing image with ${greyScaleLevels} grey levels...`);
        const processed = processImageToGreys(originalImage, greyScaleLevels);
        processed.onload = function() {
          uploadedImage = createImage(processed.width, processed.height);
          uploadedImage.drawingContext.drawImage(processed, 0, 0);
          uploadedImage.loadPixels();
          console.log('Image reprocessed!');
        };
      }
    });
  }

  if (ui.exportSVGBtn) {
    ui.exportSVGBtn.addEventListener('click', () => {
      if (inputMode === 'image') {
        exportSVG();
      }
    });
  }

  if (ui.exportPDFBtn) {
    ui.exportPDFBtn.addEventListener('click', () => {
      if (inputMode === 'image') {
        exportPDF();
      }
    });
  }

  if (ui.exportMP4Btn) {
    ui.exportMP4Btn.addEventListener('click', () => {
      if (inputMode === 'image' && !isExportingVideo) {
        startVideoExport();
      }
    });
    ui.exportMP4Btn.dataset.state = window.HME ? 'ready' : 'loading';
  }

  refreshToolbarIndicators();
}

function refreshToolbarIndicators() {
  if (ui.cameraModeButton) {
    ui.cameraModeButton.textContent = inputMode === 'image' ? 'Back to Camera' : 'Camera Mode';
    ui.cameraModeButton.disabled = inputMode !== 'image';
  }

  if (ui.swapCameraButton && isMobileDevice) {
    ui.swapCameraButton.disabled = inputMode !== 'camera';
  }

  if (ui.imageControls) {
    const imageControlsActive = inputMode === 'image';
    ui.imageControls.classList.toggle('active', imageControlsActive);
    ui.imageControls.setAttribute('aria-hidden', imageControlsActive ? 'false' : 'true');
  }

  if (ui.scaleSlider) {
    ui.scaleSlider.value = imageScale.toFixed(1);
  }
  if (ui.scaleValue) {
    ui.scaleValue.textContent = `${imageScale.toFixed(1)}x`;
  }

  if (ui.greySlider) {
    ui.greySlider.value = String(greyScaleLevels);
  }
  if (ui.greyValue) {
    ui.greyValue.textContent = greyScaleLevels;
  }

  if (ui.trailButton) {
    const trailLabel = fadeAmount === 15 ? 'short' : 'long';
    ui.trailButton.textContent = `Trails: ${trailLabel}`;
  }

  if (ui.randomButton) {
    let randomLabel = 'med';
    const sampleCell = (grid && grid[0] && grid[0][0]) ? grid[0][0] : null;
    if (sampleCell) {
      if (sampleCell.randomAmount < 0.15) randomLabel = 'low';
      else if (sampleCell.randomAmount > 0.35) randomLabel = 'high';
    }
    ui.randomButton.textContent = `Random: ${randomLabel}`;
  }

  if (ui.invertButton) {
    ui.invertButton.textContent = `Invert: ${inverted ? 'on' : 'off'}`;
  }

  if (ui.glitchButton) {
    ui.glitchButton.textContent = `Glitch: ${glitchEnabled ? 'on' : 'off'}`;
    ui.glitchButton.classList.toggle('active', glitchEnabled);
  }

  const exportsDisabled = inputMode !== 'image' || isExportingVideo;
  if (ui.exportSVGBtn) {
    ui.exportSVGBtn.disabled = exportsDisabled;
  }
  if (ui.exportPDFBtn) {
    ui.exportPDFBtn.disabled = exportsDisabled;
  }
  if (ui.exportMP4Btn) {
    ui.exportMP4Btn.disabled = exportsDisabled || !window.HME;
    if (!window.HME) {
      if (ui.exportMP4Btn.dataset.state !== 'failed') {
        ui.exportMP4Btn.dataset.state = 'loading';
        ui.exportMP4Btn.textContent = 'Preparing MP4…';
      }
    } else if (ui.exportMP4Btn.dataset.state !== 'failed') {
      ui.exportMP4Btn.dataset.state = 'ready';
      ui.exportMP4Btn.textContent = 'Export MP4';
    }
  }
}

function switchToCameraMode() {
  if (inputMode !== 'camera') {
    inputMode = 'camera';
    uploadedImage = null;
    originalImage = null;
    imageOffsetX = 0;
    imagePositionX = 0;
    imagePositionY = 0;
    imageScale = 1.0;
    greyScaleLevels = 6;
    isDraggingImage = false;

    if (ui.exportStatus) {
      ui.exportStatus.textContent = '';
    }

    initCamera();
    refreshToolbarIndicators();
  }
}

function cycleRandomAmount() {
  const sampleCell = (grid && grid[0] && grid[0][0]) ? grid[0][0] : null;
  if (!sampleCell) return;

  let newRandom = sampleCell.randomAmount;
  if (newRandom < 0.15) newRandom = 0.3;
  else if (newRandom < 0.35) newRandom = 0.6;
  else newRandom = 0.12;

  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      grid[i][j].setRandomAmount(newRandom);
    }
  }
}

function initCamera() {
  // Stop existing camera if it exists
  if (cam) {
    cam.remove();
  }

  // Create capture with camera constraint
  const constraints = {
    video: {
      facingMode: currentCamera,
      width: { ideal: 640, max: 640 },
      height: { ideal: 480, max: 480 }
    }
  };

  cam = createCapture(constraints);
  cam.hide();
}

function swapCamera() {
  currentCamera = currentCamera === 'user' ? 'environment' : 'user';

  // Smaller cell size (higher res) for front camera
  if (currentCamera === 'user') {
    cellSize = 10;
  } else {
    cellSize = 12;
  }

  initCamera();
  updateGrid();
  refreshToolbarIndicators();
}

function draw() {
  const inputSource = inputMode === 'image' ? uploadedImage : cam;

  if ((inputMode === 'camera' && cam.loadedmetadata) || (inputMode === 'image' && uploadedImage)) {
    if (!glitchEnabled) {
      isGlitching = false;
      exportGlitchTriggered = false;
    }

    // Handle video export - capture frames directly
    if (isExportingVideo && videoFrameCount < videoTotalFrames && mp4Encoder) {
      // Add frame directly to encoder
      loadPixels();
      const imageData = drawingContext.getImageData(0, 0, mp4Encoder.width, mp4Encoder.height);
      mp4Encoder.addFrameRgba(imageData.data);

      videoFrameCount++;
      if (ui.exportStatus) {
        ui.exportStatus.textContent = `Recording frame ${videoFrameCount}/${videoTotalFrames}...`;
      }

      if (videoFrameCount >= videoTotalFrames) {
        stopVideoExport();
      }
    }
    // Performance check and auto-adjust
    if (!performanceCheckDone) {
      framesSinceStart++;
      if (framesSinceStart % PERFORMANCE_CHECK_INTERVAL === 0) {
        const currentFPS = frameRate();
        if (currentFPS < TARGET_FPS && adjustmentCount < MAX_ADJUSTMENTS) {
          // Increase cell size to reduce number of cells
          const adjustment = map(currentFPS, 5, TARGET_FPS, 6, 2);
          cellSize = constrain(cellSize + adjustment, 8, 40);
          updateGrid();
          adjustmentCount++;
          console.log(`Auto-adjusted cell size to ${cellSize} (FPS: ${currentFPS.toFixed(1)})`);
        } else if (currentFPS >= TARGET_FPS || adjustmentCount >= MAX_ADJUSTMENTS) {
          performanceCheckDone = true;
          console.log(`Performance check complete. Final cell size: ${cellSize}, FPS: ${currentFPS.toFixed(1)}`);
        }
      }
    }

    // Check for random glitch event
    if (glitchEnabled && millis() - lastGlitchTime > glitchInterval && !isGlitching) {
      // During export: only glitch once at around 5 seconds (frame 125 of 250)
      if (isExportingVideo) {
        if (!exportGlitchTriggered && videoFrameCount >= 125 && videoFrameCount <= 130) {
          isGlitching = true;
          glitchDuration = int(random(10, 30));
          glitchType = int(random(3));
          lastGlitchTime = millis();
          exportGlitchTriggered = true;
        }
      } else {
        // Normal mode: random glitches
        if (random(1) < 0.3) {
          isGlitching = true;
          glitchDuration = int(random(10, 30));
          glitchType = int(random(3));
          lastGlitchTime = millis();
        }
      }
    }

    if (glitchEnabled && isGlitching) {
      glitchDuration--;
      if (glitchDuration <= 0) {
        isGlitching = false;
      }
    }

    // Optimized trail effect
    noStroke();
    fill(0, fadeAmount);
    rect(0, 0, width, height);

    const magenta = color(219, 10, 91);
    const cyan = color(23, 190, 157);
    const orange = color(255, 152, 48);

    inputSource.loadPixels();

    // Calculate aspect ratios (cache these values)
    const sourceAspect = inputSource.width / inputSource.height;
    const canvasAspect = width / height;

    // Calculate scale to contain entire image within canvas (never crop)
    let scale, baseOffsetX, baseOffsetY;
    if (sourceAspect > canvasAspect) {
      // Image is wider than canvas - fit to width
      scale = (width / inputSource.width) * imageScale;
      baseOffsetX = 0;
      baseOffsetY = (height - inputSource.height * scale) / 2;
    } else {
      // Image is taller than canvas - fit to height
      scale = (height / inputSource.height) * imageScale;
      baseOffsetX = (width - inputSource.width * scale) / 2;
      baseOffsetY = 0;
    }

    // Apply manual position offsets from dragging
    let offsetX = baseOffsetX + imagePositionX;
    let offsetY = baseOffsetY + imagePositionY;

    // Horizontal movement disabled for images
    // if (inputMode === 'image' && !isDraggingImage) {
    //   imageOffsetX += 0.15; // Very slow drift
    //   offsetX += sin(imageOffsetX) * 8; // Smooth oscillation with 8px amplitude
    // }

    // Cache frequently used values
    const sourceWidth = inputSource.width;
    const sourcePixels = inputSource.pixels;

    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        // Only mirror front camera, not back camera or images
        const displayI = (inputMode === 'camera' && currentCamera === 'user') ? (cols - 1 - i) : i;
        const x = displayI * cellSize + cellSize / 2;
        const y = j * cellSize + cellSize / 2;

        let glitchOffsetX = 0;
        let glitchOffsetY = 0;
        if (isGlitching && glitchType === 0) {
          glitchOffsetX = random(-20, 20);
        } else if (isGlitching && glitchType === 1) {
          glitchOffsetY = sin(j * 0.5 + frameCount * 0.5) * 10;
        }

        // Map canvas coordinates to source coordinates
        const sourceX = (x - offsetX) / scale;
        const sourceY = (y - offsetY) / scale;

        const px = constrain(floor(sourceX), 0, inputSource.width - 1);
        const py = constrain(floor(sourceY), 0, inputSource.height - 1);
        const pixelIndex = (px + py * sourceWidth) * 4;

        if (pixelIndex < sourcePixels.length) {
          const r = sourcePixels[pixelIndex];
          const g = sourcePixels[pixelIndex + 1];
          const b = sourcePixels[pixelIndex + 2];
          let brightness = (r + g + b) * 0.333; // Slightly faster than division

          if (inputMode === 'image') {
            const levels = Math.max(2, greyScaleLevels);
            const step = 255 / (levels - 1);
            brightness = Math.round(brightness / step) * step;
          }

          // Invert brightness if inverted mode is on
          if (inverted) brightness = 255 - brightness;

          grid[i][j].update(brightness);
          grid[i][j].display(
            i * cellSize + cellSize / 2 + glitchOffsetX,
            y + glitchOffsetY,
            cellSize,
            magenta,
            cyan,
            orange,
            glitchEnabled && isGlitching,
            glitchType
          );
        }
      }
    }

    // Mobile controls menu (bottom right)
    if (isMobileDevice) {
      const buttonSize = 50;
      const buttonSpacing = 10;
      const menuX = width - buttonSize - 20;
      const menuY = height - buttonSize - 20;

      // Draw control buttons if menu is open
      if (menuOpen) {
        // Home button
        const homeX = menuX;
        const homeY = menuY - (buttonSize + buttonSpacing) * 5;
        const homeHover = mouseX >= homeX && mouseX <= homeX + buttonSize &&
                          mouseY >= homeY && mouseY <= homeY + buttonSize;
        fill(0, homeHover ? 200 : 150);
        noStroke();
        rect(homeX, homeY, buttonSize, buttonSize, 8);
        fill(255);
        textAlign(CENTER, CENTER);
        textSize(20);
        text("🏠", homeX + buttonSize / 2, homeY + buttonSize / 2);

        // Invert colors button
        const invertX = menuX;
        const invertY = menuY - (buttonSize + buttonSpacing) * 4;
        const invertHover = mouseX >= invertX && mouseX <= invertX + buttonSize &&
                            mouseY >= invertY && mouseY <= invertY + buttonSize;
        fill(0, invertHover ? 200 : 150);
        noStroke();
        rect(invertX, invertY, buttonSize, buttonSize, 8);
        fill(inverted ? 255 : 200);
        textAlign(CENTER, CENTER);
        textSize(20);
        text("⚫⚪", invertX + buttonSize / 2, invertY + buttonSize / 2);

        // Plus button (increase cell size - lower res)
        const plusX = menuX;
        const plusY = menuY - (buttonSize + buttonSpacing) * 3;
        const plusHover = mouseX >= plusX && mouseX <= plusX + buttonSize &&
                          mouseY >= plusY && mouseY <= plusY + buttonSize;
        fill(0, plusHover ? 200 : 150);
        noStroke();
        rect(plusX, plusY, buttonSize, buttonSize, 8);
        fill(255);
        textAlign(CENTER, CENTER);
        textSize(32);
        text("+", plusX + buttonSize / 2, plusY + buttonSize / 2);

        // Minus button (decrease cell size - higher res)
        const minusX = menuX;
        const minusY = menuY - (buttonSize + buttonSpacing) * 2;
        const minusHover = mouseX >= minusX && mouseX <= minusX + buttonSize &&
                           mouseY >= minusY && mouseY <= minusY + buttonSize;
        fill(0, minusHover ? 200 : 150);
        noStroke();
        rect(minusX, minusY, buttonSize, buttonSize, 8);
        fill(255);
        textAlign(CENTER, CENTER);
        textSize(32);
        text("−", minusX + buttonSize / 2, minusY + buttonSize / 2);

        // Camera swap button
        const swapX = menuX;
        const swapY = menuY - (buttonSize + buttonSpacing);
        const swapHover = mouseX >= swapX && mouseX <= swapX + buttonSize &&
                          mouseY >= swapY && mouseY <= swapY + buttonSize;
        fill(0, swapHover ? 200 : 150);
        noStroke();
        rect(swapX, swapY, buttonSize, buttonSize, 8);
        fill(255);
        textAlign(CENTER, CENTER);
        textSize(20);
        text("🔄", swapX + buttonSize / 2, swapY + buttonSize / 2);
      }

      // Menu toggle button (always visible)
      const toggleHover = mouseX >= menuX && mouseX <= menuX + buttonSize &&
                          mouseY >= menuY && mouseY <= menuY + buttonSize;
      fill(0, toggleHover ? 200 : 150);
      noStroke();
      rect(menuX, menuY, buttonSize, buttonSize, 8);
      fill(255);
      textAlign(CENTER, CENTER);
      textSize(28);
      text(menuOpen ? "✕" : "☰", menuX + buttonSize / 2, menuY + buttonSize / 2);
    }
  }


  // Store current frame state for vector trail export
  if (inputMode === 'image') {
    const frameSnapshot = [];
    for (let i = 0; i < cols; i++) {
      frameSnapshot[i] = [];
      for (let j = 0; j < rows; j++) {
        const cell = grid[i][j];
        frameSnapshot[i][j] = {
          brightness: cell.displayBrightness,
          x: i * cellSize + cellSize / 2,
          y: j * cellSize + cellSize / 2,
          isBlock: cell.isBlock,
          blockOffsetX: cell.blockOffsetX,
          blockOffsetY: cell.blockOffsetY
        };
      }
    }
    trailHistory.push(frameSnapshot);

    // Keep only last N frames
    if (trailHistory.length > maxTrailFrames) {
      trailHistory.shift();
    }
  }

  if (ui.toolbarStats && frameCount - statsUpdateFrame >= 15) {
    const fpsValue = int(frameRate());
    ui.toolbarStats.textContent = `FPS: ${fpsValue}`;
    statsUpdateFrame = frameCount;
  }
}

class TrailCell {
  constructor() {
    this.smoothedBrightness = 0;
    this.displayBrightness = 0;
    this.randomAmount = 0.12;
    this.isBlock = false;
    this.blockTimer = 0;
    this.blockOffsetX = 0;
    this.blockOffsetY = 0;
    this.blockVelX = 0;
    this.blockVelY = 0;
  }

  update(newBrightness) {
    this.smoothedBrightness = lerp(this.smoothedBrightness, newBrightness, 0.4);
    this.displayBrightness = this.smoothedBrightness;

    if (random(1) < 0.00008) {
      this.isBlock = true;
      this.blockTimer = int(random(30, 60));
      this.blockOffsetX = 0;
      this.blockOffsetY = 0;
      this.blockVelX = random(-0.3, 0.3);
      this.blockVelY = random(-0.3, 0.3);
    }

    if (this.isBlock) {
      this.blockOffsetX += this.blockVelX;
      this.blockOffsetY += this.blockVelY;
      this.blockTimer--;
      if (this.blockTimer <= 0) {
        this.isBlock = false;
      }
    }
  }

  display(x, y, size, magenta, cyan, orange, glitching, gType) {
    // Optimized color calculation
    const b = this.displayBrightness;
    let displayColor;
    if (b < 85) {
      displayColor = magenta;
    } else if (b < 170) {
      const amt = (b - 85) / 85; // Faster than map()
      displayColor = lerpColor(magenta, cyan, amt);
    } else {
      const amt = (b - 170) / 85; // Faster than map()
      displayColor = lerpColor(cyan, orange, amt);
    }

    if (glitching && gType === 2 && random(1) < 0.3) {
      const r = red(displayColor);
      const g = green(displayColor);
      const bl = blue(displayColor);
      displayColor = color(bl, r, g);
    }

    let alpha = 120 + (b * 0.529); // Optimized map(b, 0, 255, 120, 255)
    if (glitching) alpha = min(alpha + 50, 255);

    if (this.isBlock) {
      fill(red(displayColor), green(displayColor), blue(displayColor), alpha);
      noStroke();
      rectMode(CENTER);
      rect(x + this.blockOffsetX, y + this.blockOffsetY, size * 0.9, size * 0.9);
      rectMode(CORNER);
    } else {
      // Optimized character selection
      let charIndex = floor(b / 255 * (asciiChars.length - 1));
      charIndex = constrain(charIndex, 0, asciiChars.length - 1);
      let displayChar = asciiChars.charAt(charIndex);

      if (b < 80 && random(1) < this.randomAmount) {
        const randomRange = 2;
        let randomIdx = charIndex + int(random(-randomRange, randomRange + 1));
        randomIdx = constrain(randomIdx, 0, asciiChars.length - 1);
        displayChar = asciiChars.charAt(randomIdx);
      }

      if (glitching && random(1) < 0.4) {
        displayChar = asciiChars.charAt(int(random(asciiChars.length)));
      }

      fill(red(displayColor), green(displayColor), blue(displayColor), alpha);
      textSize(size);
      text(displayChar, x, y);
    }
  }

  setRandomAmount(amt) {
    this.randomAmount = amt;
  }
}

function keyPressed() {
  if (key === 'b' || key === 'B') {
    cellSize = constrain(cellSize + 2, 6, 40);
    updateGrid();
    refreshToolbarIndicators();
  } else if (key === 's' || key === 'S') {
    cellSize = constrain(cellSize - 2, 6, 40);
    updateGrid();
    refreshToolbarIndicators();
  } else if (key === 't' || key === 'T') {
    fadeAmount = (fadeAmount === 15) ? 40 : 15;
    refreshToolbarIndicators();
  } else if (key === 'r' || key === 'R') {
    cycleRandomAmount();
    refreshToolbarIndicators();
  } else if (key === 'i' || key === 'I') {
    inverted = !inverted;
    refreshToolbarIndicators();
  } else if (key === 'c' || key === 'C') {
    switchToCameraMode();
  }
}

function updateGrid() {
  cols = floor(width / cellSize);
  rows = floor(height / cellSize);
  const newGrid = [];

  for (let i = 0; i < cols; i++) {
    newGrid[i] = [];
    for (let j = 0; j < rows; j++) {
      newGrid[i][j] = new TrailCell();

      if (grid) {
        const oldI = floor(map(i, 0, cols, 0, grid.length));
        const oldJ = floor(map(j, 0, rows, 0, grid[0].length));
        if (oldI < grid.length && oldJ < grid[0].length) {
          newGrid[i][j].smoothedBrightness = grid[oldI][oldJ].smoothedBrightness;
          newGrid[i][j].displayBrightness = grid[oldI][oldJ].displayBrightness;
          newGrid[i][j].randomAmount = grid[oldI][oldJ].randomAmount;
        }
      }
    }
  }

  grid = newGrid;
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  updateGrid();
}

function mouseDragged() {
  if (isDraggingImage && inputMode === 'image') {
    imagePositionX = dragStartPosX + (mouseX - dragStartX);
    imagePositionY = dragStartPosY + (mouseY - dragStartY);
  }
}

function mouseReleased() {
  if (isDraggingImage) {
    isDraggingImage = false;
    cursor(ARROW);
  }
}

function mousePressed(event) {
  const toolbar = document.getElementById('toolbar');
  const pointerTarget = (event && event.target) ? event.target : document.elementFromPoint(mouseX, mouseY);
  const interactingWithToolbar = toolbar && pointerTarget ? toolbar.contains(pointerTarget) : false;

  // Start dragging image if in image mode
  if (inputMode === 'image' && !isMobileDevice && !interactingWithToolbar) {
    isDraggingImage = true;
    dragStartX = mouseX;
    dragStartY = mouseY;
    dragStartPosX = imagePositionX;
    dragStartPosY = imagePositionY;
    cursor('grabbing');
    return;
  }

  // Prevent interactions behind toolbar
  if (interactingWithToolbar) {
    return;
  }

  // Mobile menu controls
  if (isMobileDevice) {
    const buttonSize = 50;
    const buttonSpacing = 10;
    const menuX = width - buttonSize - 20;
    const menuY = height - buttonSize - 20;

    // Check menu toggle button
    if (mouseX >= menuX && mouseX <= menuX + buttonSize &&
        mouseY >= menuY && mouseY <= menuY + buttonSize) {
      menuOpen = !menuOpen;
      return;
    }

    // If menu is open, check for button clicks
    if (menuOpen) {
      // Home button
      const homeX = menuX;
      const homeY = menuY - (buttonSize + buttonSpacing) * 5;
      if (mouseX >= homeX && mouseX <= homeX + buttonSize &&
          mouseY >= homeY && mouseY <= homeY + buttonSize) {
        window.location.href = '../';
        return;
      }

      // Invert button
      const invertX = menuX;
      const invertY = menuY - (buttonSize + buttonSpacing) * 4;
      if (mouseX >= invertX && mouseX <= invertX + buttonSize &&
          mouseY >= invertY && mouseY <= invertY + buttonSize) {
        inverted = !inverted;
        return;
      }

      // Plus button (bigger cells, lower res)
      const plusX = menuX;
      const plusY = menuY - (buttonSize + buttonSpacing) * 3;
      if (mouseX >= plusX && mouseX <= plusX + buttonSize &&
          mouseY >= plusY && mouseY <= plusY + buttonSize) {
        cellSize = constrain(cellSize + 2, 6, 40);
        updateGrid();
        return;
      }

      // Minus button (smaller cells, higher res)
      const minusX = menuX;
      const minusY = menuY - (buttonSize + buttonSpacing) * 2;
      if (mouseX >= minusX && mouseX <= minusX + buttonSize &&
          mouseY >= minusY && mouseY <= minusY + buttonSize) {
        cellSize = constrain(cellSize - 2, 6, 40);
        updateGrid();
        return;
      }

      // Camera swap button
      const swapX = menuX;
      const swapY = menuY - (buttonSize + buttonSpacing);
      if (mouseX >= swapX && mouseX <= swapX + buttonSize &&
          mouseY >= swapY && mouseY <= swapY + buttonSize) {
        swapCamera();
        return;
      }
    }
  }
}

// SVG Export Function - TRUE VECTOR with multi-layer trails!
function exportSVG() {
  console.log('Exporting TRUE VECTOR SVG with multi-layer trails...');

  if (trailHistory.length === 0) {
    console.log('No trail history yet, wait a moment...');
    return;
  }

  const magenta = color(219, 10, 91);
  const cyan = color(23, 190, 157);
  const orange = color(255, 152, 48);

  // Create SVG header
  let svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs>
  <style type="text/css">
    text {
      font-family: 'Courier New', 'Courier', monospace;
      text-anchor: middle;
      dominant-baseline: central;
    }
  </style>
</defs>
`;

  // Export ALL frames from history (oldest to newest for proper layering)
  for (let frameIdx = 0; frameIdx < trailHistory.length; frameIdx++) {
    const frame = trailHistory[frameIdx];

    // Calculate opacity fade for trail effect
    // Older frames = more transparent
    const frameAge = trailHistory.length - frameIdx - 1;
    const baseFade = Math.pow(0.85, frameAge); // Exponential fade

    // Add a group for this frame layer
    svgContent += `  <g opacity="${baseFade.toFixed(3)}">\n`;

    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        if (!frame[i] || !frame[i][j]) continue;

        const cellData = frame[i][j];
        const b_val = cellData.brightness;
        const x = cellData.x;
        const y = cellData.y;

        // Skip invisible cells
        if (b_val < 1) continue;

        // Calculate color
        let displayColor;
        if (b_val < 85) {
          displayColor = magenta;
        } else if (b_val < 170) {
          const amt = (b_val - 85) / 85;
          displayColor = lerpColor(magenta, cyan, amt);
        } else {
          const amt = (b_val - 170) / 85;
          displayColor = lerpColor(cyan, orange, amt);
        }

        // Get character
        let charIndex = floor(b_val / 255 * (asciiChars.length - 1));
        charIndex = constrain(charIndex, 0, asciiChars.length - 1);
        let displayChar = asciiChars.charAt(charIndex);

        // Escape XML
        if (displayChar === '<') displayChar = '&lt;';
        else if (displayChar === '>') displayChar = '&gt;';
        else if (displayChar === '&') displayChar = '&amp;';
        else if (displayChar === ' ') displayChar = '&#160;';

        const fill_r = Math.round(red(displayColor));
        const fill_g = Math.round(green(displayColor));
        const fill_b = Math.round(blue(displayColor));

        // Check if this cell is a block
        if (cellData.isBlock) {
          // Export as rectangle
          const blockX = x + (cellData.blockOffsetX || 0);
          const blockY = y + (cellData.blockOffsetY || 0);
          const blockSize = cellSize * 0.9;
          svgContent += `    <rect x="${(blockX - blockSize/2).toFixed(2)}" y="${(blockY - blockSize/2).toFixed(2)}" width="${blockSize.toFixed(2)}" height="${blockSize.toFixed(2)}" fill="rgb(${fill_r},${fill_g},${fill_b})"/>\n`;
        } else {
          // Export as text character
          svgContent += `    <text x="${x.toFixed(2)}" y="${y.toFixed(2)}" font-size="${cellSize}" fill="rgb(${fill_r},${fill_g},${fill_b})">${displayChar}</text>\n`;
        }
      }
    }

    svgContent += `  </g>\n`;
  }

  svgContent += '</svg>';

  // Download SVG
  const blob = new Blob([svgContent], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ascii_frame.svg';
  a.click();
  URL.revokeObjectURL(url);

  console.log('TRUE VECTOR SVG with multi-layer trails exported!');
}

// PNG Export Function (transparent background with trail layers)
function exportPDF() {
  console.log('Exporting PNG with transparent background and trail layers...');

  if (trailHistory.length < 10) {
    console.log('Need at least 10 frames of trail history. Please wait a moment...');
    return;
  }

  // Create a new canvas with transparent background
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = width;
  exportCanvas.height = height;
  const ctx = exportCanvas.getContext('2d');

  const magenta = color(219, 10, 91);
  const cyan = color(23, 190, 157);
  const orange = color(255, 152, 48);

  // Set up text rendering
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${cellSize}px "Courier New", Courier, monospace`;

  // Export ALL frames from trail history (oldest to newest for proper layering)
  for (let frameIdx = 0; frameIdx < trailHistory.length; frameIdx++) {
    const frame = trailHistory[frameIdx];

    // Calculate opacity fade for trail effect
    const frameAge = trailHistory.length - frameIdx - 1;
    const baseFade = Math.pow(0.85, frameAge);

    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        if (!frame[i] || !frame[i][j]) continue;

        const cellData = frame[i][j];
        const b_val = cellData.brightness;
        const x = cellData.x;
        const y = cellData.y;

        // Skip very dark pixels
        if (b_val < 1) continue;

        // Calculate color
        let displayColor;
        if (b_val < 85) {
          displayColor = magenta;
        } else if (b_val < 170) {
          const amt = (b_val - 85) / 85;
          displayColor = lerpColor(magenta, cyan, amt);
        } else {
          const amt = (b_val - 170) / 85;
          displayColor = lerpColor(cyan, orange, amt);
        }

        let alpha = (120 + (b_val * 0.529)) * baseFade;

        if (cellData.isBlock) {
          // Draw block
          ctx.fillStyle = `rgba(${red(displayColor)}, ${green(displayColor)}, ${blue(displayColor)}, ${alpha / 255})`;
          const blockX = x + (cellData.blockOffsetX || 0);
          const blockY = y + (cellData.blockOffsetY || 0);
          const blockSize = cellSize * 0.9;
          ctx.fillRect(blockX - blockSize/2, blockY - blockSize/2, blockSize, blockSize);
        } else {
          // Draw character
          let charIndex = floor(b_val / 255 * (asciiChars.length - 1));
          charIndex = constrain(charIndex, 0, asciiChars.length - 1);
          let displayChar = asciiChars.charAt(charIndex);

          ctx.fillStyle = `rgba(${red(displayColor)}, ${green(displayColor)}, ${blue(displayColor)}, ${alpha / 255})`;
          ctx.fillText(displayChar, x, y);
        }
      }
    }
  }

  // Download as PNG
  exportCanvas.toBlob(function(blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ascii_frame.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log('PNG with trail layers exported!');
  }, 'image/png');
}

// Video Export Functions using H264 MP4 Encoder (maximum quality, minimal compression)
async function startVideoExport() {
  console.log('Starting MP4 export at 25fps (maximum quality)...');

  const exportStatus = ui.exportStatus;
  const exportMP4Btn = ui.exportMP4Btn;

  if (!exportStatus || !exportMP4Btn) {
    console.warn('Export controls missing from DOM.');
    return;
  }

  if (!window.HME) {
    exportStatus.textContent = 'Encoder still loading, please wait ~10 seconds and try again';
    setTimeout(() => {
      if (ui.exportStatus) {
        ui.exportStatus.textContent = '';
      }
    }, 4000);
    return;
  }

  exportStatus.textContent = 'Initializing encoder...';
  exportMP4Btn.disabled = true;
  refreshToolbarIndicators();

  try {
    // Initialize encoder with maximum quality, minimal compression
    mp4Encoder = await window.HME.createH264MP4Encoder();
    mp4Encoder.outputFilename = 'ascii_animation';
    mp4Encoder.width = width;
    mp4Encoder.height = height;
    mp4Encoder.frameRate = 25;
    mp4Encoder.kbps = 20000; // Very high bitrate: 20 Mbps for sharp quality
    mp4Encoder.groupOfPictures = 25; // GOP size = framerate
    mp4Encoder.speed = 0; // Slowest encoding for best quality (0-10, 0 = best)
    mp4Encoder.quantizationParameter = 10; // Minimum QP for sharpest quality (10-51)
    mp4Encoder.initialize();

    isExportingVideo = true;
    videoFrameCount = 0;
    exportGlitchTriggered = false; // Reset glitch flag for export

    exportStatus.textContent = 'Recording (this will take 10 seconds)...';
    console.log('MP4 encoder initialized, starting 25fps capture with maximum quality');
    refreshToolbarIndicators();

  } catch (error) {
    console.error('Failed to initialize encoder:', error);
    exportStatus.textContent = 'Failed to initialize encoder';
    exportMP4Btn.disabled = false;
    refreshToolbarIndicators();
  }
}

async function stopVideoExport() {
  console.log('Finalizing MP4...');

  isExportingVideo = false;

  const exportStatus = ui.exportStatus;
  const exportMP4Btn = ui.exportMP4Btn;

  if (!exportStatus || !exportMP4Btn) {
    console.warn('Export controls missing from DOM.');
    return;
  }

  try {
    exportStatus.textContent = 'Finalizing MP4...';

    // Finalize and get encoded data
    await mp4Encoder.finalize();

    // Get the output buffer directly
    const uint8Array = mp4Encoder.FS.readFile(mp4Encoder.outputFilename);

    // Download
    const blob = new Blob([uint8Array.buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ascii_animation.mp4';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // Cleanup
    mp4Encoder.delete();
    mp4Encoder = null;

    exportStatus.textContent = 'MP4 exported successfully!';
    exportMP4Btn.disabled = false;

    setTimeout(() => {
      if (ui.exportStatus) {
        ui.exportStatus.textContent = '';
      }
    }, 3000);

    console.log('MP4 export complete!');

  } catch (error) {
    console.error('MP4 finalization failed:', error);
    console.error('Error details:', error.message, error.stack);
    exportStatus.textContent = 'MP4 export failed. Check console.';
    exportMP4Btn.disabled = false;
    if (mp4Encoder) {
      try {
        mp4Encoder.delete();
      } catch (e) {
        console.error('Failed to delete encoder:', e);
      }
      mp4Encoder = null;
    }
  }

  refreshToolbarIndicators();
}
