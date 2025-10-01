let cam;
const isMobileDevice = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
let cellSize = isMobileDevice ? 10 : 12; // Smaller cells on mobile for higher res
let cols, rows;
let grid;
let pg; // Graphics buffer for better performance

const asciiChars = " .:AkerBP";
let fadeAmount = 15;
let inverted = false;

// Camera switching for mobile
let currentCamera = 'user'; // 'user' = front, 'environment' = back

// Mobile controls menu
let menuOpen = false;

let lastGlitchTime = 0;
let glitchInterval = 5000;
let isGlitching = false;
let glitchDuration = 0;
let glitchType = 0;

// Performance optimization
let framesSinceStart = 0;
let performanceCheckDone = false;
const TARGET_FPS = 25;
const PERFORMANCE_CHECK_INTERVAL = 30; // Check every 30 frames
const MAX_ADJUSTMENTS = 5; // Stop after 5 adjustments
let adjustmentCount = 0;

function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1); // Reduce pixel density for better performance

  initCamera();

  updateGrid();

  textAlign(CENTER, CENTER);
  textFont('monospace'); // Use monospace for consistent ASCII rendering
  background(0);
  frameRate(30);
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
}

function draw() {
  if (cam.loadedmetadata) {
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
    if (millis() - lastGlitchTime > glitchInterval && !isGlitching) {
      if (random(1) < 0.3) {
        isGlitching = true;
        glitchDuration = int(random(10, 30));
        glitchType = int(random(3));
        lastGlitchTime = millis();
      }
    }

    if (isGlitching) {
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

    cam.loadPixels();

    // Calculate aspect ratios (cache these values)
    const camAspect = cam.width / cam.height;
    const canvasAspect = width / height;

    // Calculate scale to fill canvas while maintaining aspect ratio
    let scale, offsetX, offsetY;
    if (canvasAspect > camAspect) {
      scale = width / cam.width;
      offsetX = 0;
      offsetY = (height - cam.height * scale) / 2;
    } else {
      scale = height / cam.height;
      offsetX = (width - cam.width * scale) / 2;
      offsetY = 0;
    }

    // Cache frequently used values
    const camWidth = cam.width;
    const camPixels = cam.pixels;

    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        // Only mirror front camera, not back camera
        const displayI = currentCamera === 'user' ? (cols - 1 - i) : i;
        const x = displayI * cellSize + cellSize / 2;
        const y = j * cellSize + cellSize / 2;

        let glitchOffsetX = 0;
        let glitchOffsetY = 0;
        if (isGlitching && glitchType === 0) {
          glitchOffsetX = random(-20, 20);
        } else if (isGlitching && glitchType === 1) {
          glitchOffsetY = sin(j * 0.5 + frameCount * 0.5) * 10;
        }

        // Map canvas coordinates to camera coordinates
        const camX = (x - offsetX) / scale;
        const camY = (y - offsetY) / scale;

        const px = constrain(floor(camX), 0, cam.width - 1);
        const py = constrain(floor(camY), 0, cam.height - 1);
        const pixelIndex = (px + py * camWidth) * 4;

        if (pixelIndex < camPixels.length) {
          const r = camPixels[pixelIndex];
          const g = camPixels[pixelIndex + 1];
          const b = camPixels[pixelIndex + 2];
          let brightness = (r + g + b) * 0.333; // Slightly faster than division

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
            isGlitching,
            glitchType
          );
        }
      }
    }

    // Home link and stats at bottom - desktop only
    if (!isMobileDevice) {
      const homeText = "← home";
      const trailMode = fadeAmount === 15 ? "short" : "long";
      const randomMode = grid[0][0].randomAmount < 0.15 ? "low" : (grid[0][0].randomAmount < 0.35 ? "med" : "high");
      const invertMode = inverted ? "on" : "off";
      const uiText = `${homeText} | FPS: ${int(frameRate())} | B = bigger | S = smaller | T = trails (${trailMode}) | R = random (${randomMode}) | I = invert (${invertMode})`;

      const uiX = 10;
      const uiY = height - 30;
      const uiPadding = 8;

      textAlign(LEFT, TOP);
      textSize(12);
      const textW = textWidth(uiText);
      const textH = 12;
      const homeTextW = textWidth(homeText);

      // Check if hovering over home link
      if (mouseX >= uiX - uiPadding && mouseX <= uiX + homeTextW + uiPadding &&
          mouseY >= uiY - uiPadding && mouseY <= uiY + textH + uiPadding) {
        cursor(HAND);
      } else {
        cursor(ARROW);
      }

      // Semi-transparent background box
      fill(0, 150);
      noStroke();
      rect(uiX - uiPadding, uiY - uiPadding, textW + uiPadding * 2, textH + uiPadding * 2, 4);

      // Draw UI text
      fill(255, 255);
      text(uiText, uiX, uiY);

      // Draw underline for home link on hover
      if (mouseX >= uiX - uiPadding && mouseX <= uiX + homeTextW + uiPadding &&
          mouseY >= uiY - uiPadding && mouseY <= uiY + textH + uiPadding) {
        stroke(255);
        strokeWeight(1);
        line(uiX, uiY + textH + 2, uiX + homeTextW, uiY + textH + 2);
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
  } else if (key === 's' || key === 'S') {
    cellSize = constrain(cellSize - 2, 6, 40);
    updateGrid();
  } else if (key === 't' || key === 'T') {
    fadeAmount = (fadeAmount === 15) ? 40 : 15;
  } else if (key === 'r' || key === 'R') {
    let newRandom = grid[0][0].randomAmount;
    if (newRandom < 0.15) newRandom = 0.3;
    else if (newRandom < 0.35) newRandom = 0.6;
    else newRandom = 0.12;

    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        grid[i][j].setRandomAmount(newRandom);
      }
    }
  } else if (key === 'i' || key === 'I') {
    inverted = !inverted;
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

function mousePressed() {
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
        window.location.href = '../index.html';
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

  // Check if home link was clicked (bottom left) - desktop only
  if (!isMobileDevice) {
    const uiX = 10;
    const uiY = height - 30;
    const uiPadding = 8;
    textSize(12);
    const homeTextW = textWidth("← home");
    const textH = 12;

    if (mouseX >= uiX - uiPadding && mouseX <= uiX + homeTextW + uiPadding &&
        mouseY >= uiY - uiPadding && mouseY <= uiY + textH + uiPadding) {
      window.location.href = '../index.html';
    }
  }
}
