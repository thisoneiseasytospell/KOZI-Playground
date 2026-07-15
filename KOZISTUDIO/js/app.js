document.documentElement.classList.add("js");

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const hoverCapable = window.matchMedia("(hover: hover) and (pointer: fine)");
const coarsePointer = window.matchMedia("(pointer: coarse)");

function setupIntroDisclosure() {
  const intro = document.querySelector(".site-intro");
  const shell = document.querySelector("[data-intro-shell]");
  const trigger = document.querySelector(".intro-trigger");
  const headline = document.querySelector(".intro-headline");
  const details = document.querySelector(".intro-details-wrap");
  const followLabel = document.querySelector("[data-intro-follow]");
  const collapseButton = document.querySelector("[data-intro-collapse]");

  if (
    !intro ||
    !shell ||
    !trigger ||
    !headline ||
    !details ||
    !followLabel ||
    !collapseButton
  ) {
    return;
  }

  const revealItems = Array.from(details.querySelectorAll(".detail-reveal"));
  const collapseLead = reduceMotion ? 0 : 180;
  let isExpanded = false;
  let closeTimer;
  let hasFollowPosition = false;
  let followTarget = { x: 0, y: 0 };
  let followPosition = { ...followTarget };

  revealItems.forEach((item, index) => {
    item.style.setProperty("--reveal-index", String(index));
    item.style.setProperty("--reveal-reverse", String(revealItems.length - index - 1));
  });

  function updateIntro({ immediate = false } = {}) {
    window.clearTimeout(closeTimer);
    trigger.setAttribute("aria-expanded", String(isExpanded));
    details.setAttribute("aria-hidden", String(!isExpanded));
    details.inert = !isExpanded;
    followLabel.textContent = "Read more";

    if (isExpanded) {
      intro.classList.remove("is-closing");
      intro.classList.add("is-expanded");
      return;
    }

    intro.classList.remove("is-expanded");

    if (immediate || reduceMotion) {
      intro.classList.remove("is-closing");
      return;
    }

    intro.classList.add("is-closing");
    closeTimer = window.setTimeout(() => {
      intro.classList.remove("is-closing");
    }, collapseLead);
  }

  function updateFollowTarget(event) {
    if (!hoverCapable.matches) {
      return;
    }

    const bounds = trigger.getBoundingClientRect();
    const headlineBounds = headline.getBoundingClientRect();
    const labelWidth = followLabel.offsetWidth;
    const pointerOffsetX = event.clientX - (headlineBounds.left + headlineBounds.width / 2);
    const pointerOffsetY = event.clientY - (headlineBounds.top + headlineBounds.height / 2);
    const baseX = (headlineBounds.width - labelWidth) / 2;
    const maximumX = Math.max(0, bounds.width - labelWidth);
    const x = Math.max(0, Math.min(maximumX, baseX + pointerOffsetX * 0.18));
    const minimumY = headline.offsetHeight + 6;
    const y = Math.max(minimumY, headline.offsetHeight + 9 + pointerOffsetY * 0.08);

    followTarget = { x, y };

    if (!hasFollowPosition) {
      followPosition = { ...followTarget };
      hasFollowPosition = true;
    }
  }

  trigger.addEventListener("pointerenter", (event) => {
    updateFollowTarget(event);
    trigger.classList.toggle("is-following", hoverCapable.matches);
  });

  trigger.addEventListener("pointermove", updateFollowTarget);

  trigger.addEventListener("pointerleave", () => {
    trigger.classList.remove("is-following");
  });

  function animateFollowLabel() {
    const easing = reduceMotion ? 1 : 0.14;

    followPosition.x += (followTarget.x - followPosition.x) * easing;
    followPosition.y += (followTarget.y - followPosition.y) * easing;
    followLabel.style.transform = `translate3d(${followPosition.x}px, ${followPosition.y}px, 0)`;
    requestAnimationFrame(animateFollowLabel);
  }

  trigger.addEventListener("click", (event) => {
    isExpanded = !isExpanded;
    updateIntro();

    if (event.detail > 0) {
      trigger.blur();
    }
  });

  collapseButton.addEventListener("click", (event) => {
    isExpanded = false;
    updateIntro();

    if (event.detail === 0) {
      trigger.focus();
    }
  });

  shell.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }

    isExpanded = false;
    trigger.focus();
    updateIntro();
  });

  updateIntro({ immediate: true });

  if (hoverCapable.matches) {
    animateFollowLabel();
  }
}

setupIntroDisclosure();

const stage = document.querySelector(".work-stage");
const frame = document.querySelector("[data-video-frame]");
const videos = stage ? Array.from(stage.querySelectorAll(".work-video")) : [];
const projectLabel = document.querySelector("[data-project-label]");
const projectNumber = document.querySelector("[data-project-number]");
const projectTitle = document.querySelector("[data-project-title]");
const motionButton = document.querySelector(".motion-permission");
const loadingIndicator = document.querySelector("[data-video-loading]");
const stageStatus = document.querySelector("[data-stage-status]");

if (stage && frame && videos.length === 2 && projectLabel && projectNumber && projectTitle) {
  setupWorkStage().catch((error) => {
    console.error(error);
    stageStatus.textContent = "Selected work is unavailable.";
  });
}

async function setupWorkStage() {
  const response = await fetch("./assets/videos/manifest.json");

  if (!response.ok) {
    throw new Error(`Unable to load video manifest: ${response.status}`);
  }

  const manifest = await response.json();
  const projects = manifest
    .filter((project) => project.localPath && project.title)
    .map((project, index) => ({
      index,
      order: Number(project.order) || index + 1,
      title: project.title,
      src: project.localPath.startsWith(".") ? project.localPath : `./${project.localPath}`,
    }));

  if (projects.length === 0) {
    throw new Error("The video manifest does not contain any projects.");
  }

  const ascendingProjectIndices = projects
    .map((project) => project.index)
    .sort((firstIndex, secondIndex) => {
      return projects[firstIndex].order - projects[secondIndex].order;
    });
  let randomDeck = [];
  let activeSlotIndex = 0;
  let currentProjectIndex = -1;
  let queuedProjectIndex = -1;
  let queuedReady = false;
  let queuedLoading = false;
  let switchRequest = null;
  let stageVisible = false;
  let travelAccumulator = 0;
  let loadTokens = [0, 0];
  let pointerPosition = null;
  let pointerActive = false;
  let lastPointerInput = 0;
  let touchPosition = null;
  let touchStartPosition = null;
  let touchDragging = false;
  let touchTravel = 0;
  let expandedSwipeHandled = false;
  let suppressClick = false;
  let loadingTimer;
  let motionListening = false;
  let baseOrientation = null;
  let motionOrigin = null;
  let lastTiltPosition = null;
  let lastMotionInput = 0;
  let lastUserActivity = performance.now();
  let frameExpanded = false;
  let trailCursor = 0;
  let lastTrailTime = 0;
  let lastTrailPosition = null;
  let lastTrailScale = 1;
  let idlePosition = null;
  let idleLastTime = performance.now();
  const idleSpeed = coarsePointer.matches ? 39 : 53;
  const idleStartAngle = Math.random() * Math.PI * 2;
  let idleVelocity = {
    x: Math.cos(idleStartAngle) * idleSpeed,
    y: Math.sin(idleStartAngle) * idleSpeed,
  };
  let idleTurnRate = 0;
  let idleTargetTurnRate = 0;
  let idleNextSteerTime = idleLastTime;
  const trailPoolSize = coarsePointer.matches ? 128 : 312;
  const trailPoolReserve = coarsePointer.matches ? 12 : 16;
  const idleTrailMinimumDuration = 5200;
  const idleTrailMaximumDuration = 45000;
  const idleTrailRampDuration = 12000;

  const trailCanvases = reduceMotion
    ? []
    : Array.from({ length: trailPoolSize }, () => {
        const canvas = document.createElement("canvas");
        canvas.className = "video-trail";
        canvas.setAttribute("aria-hidden", "true");
        stage.insertBefore(canvas, frame);
        return canvas;
      });

  function showLoading() {
    if (loadingTimer || stage.classList.contains("is-loading")) {
      return;
    }

    loadingTimer = window.setTimeout(() => {
      loadingTimer = undefined;
      stage.classList.add("is-loading");
      stage.setAttribute("aria-busy", "true");
    }, 160);
  }

  function hideLoading() {
    window.clearTimeout(loadingTimer);
    loadingTimer = undefined;
    stage.classList.remove("is-loading");
    stage.setAttribute("aria-busy", "false");

    if (loadingIndicator) {
      loadingIndicator.textContent = "Loading…";
    }
  }

  const stageAnchor = () => {
    return {
      x: stage.clientWidth / 2,
      y: stage.clientHeight / 2,
    };
  };

  let targetPosition = stageAnchor();
  let currentPosition = { ...targetPosition };
  let previousFramePosition = { ...currentPosition };
  let previousFrameTime = performance.now();
  let frameVelocity = { ...idleVelocity };
  let frameScale = 1;
  let targetFrameScale = 1;

  function markUserActivity() {
    lastUserActivity = performance.now();
  }

  window.addEventListener("pointerdown", markUserActivity, { passive: true });
  window.addEventListener("keydown", markUserActivity);

  function getMovementBounds(frameWidth = frame.offsetWidth, frameHeight = frame.offsetHeight) {
    const minX = frameWidth / 2;
    const minY = frameHeight / 2;

    return {
      minX,
      maxX: Math.max(minX, stage.clientWidth - frameWidth / 2),
      minY,
      maxY: Math.max(minY, stage.clientHeight - frameHeight / 2),
    };
  }

  function clampPosition(position, bounds = getMovementBounds()) {
    return {
      x: Math.max(bounds.minX, Math.min(bounds.maxX, position.x)),
      y: Math.max(bounds.minY, Math.min(bounds.maxY, position.y)),
    };
  }

  function shuffle(values) {
    const shuffled = [...values];

    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }

    return shuffled;
  }

  function nextAscendingProjectIndex(fromIndex = currentProjectIndex) {
    const currentIndex = ascendingProjectIndices.indexOf(fromIndex);

    if (currentIndex < 0) {
      return ascendingProjectIndices[0];
    }

    return ascendingProjectIndices[(currentIndex + 1) % ascendingProjectIndices.length];
  }

  function previousAscendingProjectIndex(fromIndex = currentProjectIndex) {
    const currentIndex = ascendingProjectIndices.indexOf(fromIndex);

    if (currentIndex < 0) {
      return ascendingProjectIndices[ascendingProjectIndices.length - 1];
    }

    return ascendingProjectIndices[
      (currentIndex - 1 + ascendingProjectIndices.length) % ascendingProjectIndices.length
    ];
  }

  function projectIndexForMode(mode) {
    if (mode === "random") {
      if (
        queuedProjectIndex >= 0 &&
        queuedProjectIndex !== currentProjectIndex
      ) {
        return queuedProjectIndex;
      }

      return drawRandomProjectIndex();
    }

    if (mode === "descending") {
      return previousAscendingProjectIndex();
    }

    return nextAscendingProjectIndex();
  }

  function refillRandomDeck() {
    randomDeck = shuffle(projects.map((project) => project.index));
  }

  function drawRandomProjectIndex(excludedIndex = currentProjectIndex) {
    if (projects.length === 1) {
      return projects[0].index;
    }

    if (randomDeck.length === 0) {
      refillRandomDeck();
    }

    let deckIndex = randomDeck.findIndex((projectIndex) => projectIndex !== excludedIndex);

    if (deckIndex < 0) {
      refillRandomDeck();
      deckIndex = randomDeck.findIndex((projectIndex) => projectIndex !== excludedIndex);
    }

    return randomDeck.splice(deckIndex, 1)[0];
  }

  function setProjectLabel(project) {
    projectNumber.textContent = String(project.order).padStart(2, "0");
    projectTitle.textContent = project.title;
    stage.dataset.projectIndex = String(project.order);
    stage.dataset.projectTitle = project.title;
  }

  function setFrameRatio() {
    const ratio = 16 / 9;
    const preferredWidth = stage.clientWidth * (coarsePointer.matches ? 0.72 : 0.42);
    const maximumWidth = coarsePointer.matches ? Infinity : 720;
    const captionSpace = projectLabel.offsetHeight + 8;
    const availableWidth = Math.max(1, stage.clientWidth);
    const availableHeight = Math.max(1, stage.clientHeight - captionSpace);
    const width = Math.max(
      1,
      Math.min(preferredWidth, maximumWidth, availableWidth, availableHeight * ratio)
    );

    frame.style.setProperty("--video-ratio", String(ratio));
    frame.style.width = `${width}px`;
  }

  function enlargedFrameScale() {
    const frameWidth = Math.max(1, frame.offsetWidth);
    const frameHeight = Math.max(1, frame.offsetHeight);
    const preferredScale = coarsePointer.matches ? 1.5 : 1.65;
    const fittingScale = Math.min(
      stage.clientWidth / frameWidth,
      stage.clientHeight / frameHeight
    );

    return Math.max(
      1,
      Math.min(preferredScale, fittingScale * 0.96)
    );
  }

  function loadVideo(slotIndex, projectIndex) {
    const video = videos[slotIndex];
    const project = projects[projectIndex];
    const token = loadTokens[slotIndex] + 1;

    loadTokens[slotIndex] = token;
    video.pause();
    video.classList.remove("is-active");
    video.setAttribute("aria-hidden", "true");
    video.setAttribute("aria-label", project.title);
    video.dataset.projectIndex = String(projectIndex);
    video.src = project.src;
    video.load();

    return new Promise((resolve, reject) => {
      function cleanup() {
        video.removeEventListener("loadeddata", handleLoaded);
        video.removeEventListener("error", handleError);
      }

      function handleLoaded() {
        cleanup();

        if (loadTokens[slotIndex] !== token) {
          return;
        }

        resolve(video);
      }

      function handleError() {
        cleanup();

        if (loadTokens[slotIndex] !== token) {
          return;
        }

        reject(new Error(`Unable to load ${project.src}`));
      }

      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        handleLoaded();
        return;
      }

      video.addEventListener("loadeddata", handleLoaded);
      video.addEventListener("error", handleError);
    });
  }

  function playActiveVideo() {
    const activeVideo = videos[activeSlotIndex];

    videos.forEach((video, index) => {
      if (stageVisible && !document.hidden && index === activeSlotIndex) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    });

    return activeVideo;
  }

  async function queueNextVideo(projectIndex) {
    const slotIndex = activeSlotIndex === 0 ? 1 : 0;

    queuedProjectIndex = projectIndex;
    queuedReady = false;
    queuedLoading = true;

    try {
      await loadVideo(slotIndex, projectIndex);
    } catch (error) {
      console.error(error);

      if (queuedProjectIndex === projectIndex && slotIndex !== activeSlotIndex) {
        queuedLoading = false;
        queueNextVideo(projectIndex);
      }

      return;
    }

    if (
      queuedProjectIndex !== projectIndex ||
      Number(videos[slotIndex].dataset.projectIndex) !== projectIndex ||
      slotIndex === activeSlotIndex
    ) {
      return;
    }

    queuedLoading = false;
    queuedReady = true;

    if (switchRequest?.projectIndex === projectIndex) {
      switchVideo(switchRequest.mode, projectIndex);
    }
  }

  function switchVideo(mode = "ascending", requestedProjectIndex = null) {
    const desiredProjectIndex =
      requestedProjectIndex ?? projectIndexForMode(mode);

    if (!queuedReady || queuedProjectIndex !== desiredProjectIndex) {
      switchRequest = { mode, projectIndex: desiredProjectIndex };
      showLoading();

      if (queuedProjectIndex !== desiredProjectIndex || !queuedLoading) {
        queueNextVideo(desiredProjectIndex);
      }

      return;
    }

    const outgoingSlotIndex = activeSlotIndex;
    const incomingSlotIndex = activeSlotIndex === 0 ? 1 : 0;
    const outgoingVideo = videos[outgoingSlotIndex];
    const incomingVideo = videos[incomingSlotIndex];
    const nextProject = projects[queuedProjectIndex];
    switchRequest = null;
    queuedReady = false;
    activeSlotIndex = incomingSlotIndex;
    currentProjectIndex = queuedProjectIndex;

    setFrameRatio(incomingVideo);
    setProjectLabel(nextProject);
    targetFrameScale = frameExpanded ? enlargedFrameScale() : 1;

    incomingVideo.classList.add("is-active");
    incomingVideo.setAttribute("aria-hidden", "false");
    outgoingVideo.classList.remove("is-active");
    outgoingVideo.setAttribute("aria-hidden", "true");
    outgoingVideo.pause();

    hideLoading();
    playActiveVideo();
    queueNextVideo(projectIndexForMode(mode));
  }

  videos.forEach((video) => {
    video.addEventListener("ended", () => {
      if (video !== videos[activeSlotIndex]) {
        return;
      }

      travelAccumulator = 0;
      switchVideo();
    });
  });

  function movementThreshold() {
    if (coarsePointer.matches) {
      return Math.max(85, Math.min(125, stage.clientWidth * 0.24));
    }

    return Math.max(110, Math.min(160, stage.clientWidth * 0.095));
  }

  function addTravel(distance) {
    if (!stageVisible || distance < 0.5) {
      return;
    }

    travelAccumulator += distance;

    if (travelAccumulator < movementThreshold()) {
      return;
    }

    travelAccumulator = 0;
    switchVideo();
  }

  function updateTargetFromPoint(clientX, clientY) {
    const bounds = stage.getBoundingClientRect();

    targetPosition = {
      x: clientX - bounds.left,
      y: clientY - bounds.top,
    };
  }

  stage.addEventListener("pointerenter", (event) => {
    if (event.pointerType === "touch") {
      return;
    }

    pointerActive = true;
    lastPointerInput = performance.now();
    lastUserActivity = lastPointerInput;
    pointerPosition = { x: event.clientX, y: event.clientY };
    updateTargetFromPoint(event.clientX, event.clientY);
  });

  stage.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "touch" || !touchDragging) {
      return;
    }

    lastUserActivity = performance.now();
    let distance = 0;

    if (touchPosition) {
      distance = Math.hypot(
        event.clientX - touchPosition.x,
        event.clientY - touchPosition.y
      );
      touchTravel += distance;
    }

    if (frameExpanded) {
      if (touchStartPosition && !expandedSwipeHandled) {
        const deltaX = event.clientX - touchStartPosition.x;
        const deltaY = event.clientY - touchStartPosition.y;
        const swipeThreshold = Math.max(
          42,
          Math.min(64, stage.clientHeight * 0.07)
        );

        if (
          Math.abs(deltaY) >= swipeThreshold &&
          Math.abs(deltaY) > Math.abs(deltaX) * 1.15
        ) {
          expandedSwipeHandled = true;
          travelAccumulator = 0;
          switchVideo(deltaY < 0 ? "ascending" : "descending");
        }
      }

      touchPosition = { x: event.clientX, y: event.clientY };
      return;
    }

    updateTargetFromPoint(event.clientX, event.clientY);
    addTravel(distance);
    touchPosition = { x: event.clientX, y: event.clientY };
  });

  window.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") {
      return;
    }

    pointerActive = true;
    lastPointerInput = performance.now();
    lastUserActivity = lastPointerInput;
    updateTargetFromPoint(event.clientX, event.clientY);

    if (pointerPosition) {
      addTravel(Math.hypot(event.clientX - pointerPosition.x, event.clientY - pointerPosition.y));
    }

    pointerPosition = { x: event.clientX, y: event.clientY };
  }, { passive: true });

  document.documentElement.addEventListener("pointerleave", (event) => {
    if (event.pointerType !== "touch") {
      pointerActive = false;
      pointerPosition = null;
    }
  });

  window.addEventListener("blur", () => {
    pointerActive = false;
    pointerPosition = null;
  });

  stage.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch") {
      return;
    }

    touchDragging = true;
    pointerActive = true;
    touchTravel = 0;
    expandedSwipeHandled = false;
    suppressClick = false;
    lastUserActivity = performance.now();
    touchPosition = { x: event.clientX, y: event.clientY };
    touchStartPosition = { ...touchPosition };

    if (!frameExpanded) {
      updateTargetFromPoint(event.clientX, event.clientY);
    }

    stage.setPointerCapture(event.pointerId);
  });

  function endTouchDrag(event) {
    if (event.pointerType !== "touch") {
      return;
    }

    touchDragging = false;
    pointerActive = false;
    lastUserActivity = performance.now();
    touchPosition = null;
    touchStartPosition = null;
    expandedSwipeHandled = false;
    suppressClick = event.type !== "pointercancel" && touchTravel > 10;

    if (suppressClick) {
      window.setTimeout(() => {
        suppressClick = false;
      }, 500);
    }
  }

  stage.addEventListener("pointerup", endTouchDrag);
  stage.addEventListener("pointercancel", endTouchDrag);

  stage.addEventListener("click", (event) => {
    if (event.target.closest?.(".motion-permission")) {
      return;
    }

    if (suppressClick) {
      suppressClick = false;
      return;
    }

    lastUserActivity = performance.now();
    travelAccumulator = 0;

    frameExpanded = !frameExpanded;
    targetFrameScale = frameExpanded ? enlargedFrameScale() : 1;
    const targetBounds = getMovementBounds(
      frame.offsetWidth * targetFrameScale,
      frame.offsetHeight * targetFrameScale
    );

    targetPosition = clampPosition(targetPosition, targetBounds);
    idlePosition = clampPosition(idlePosition || currentPosition, targetBounds);
    idleLastTime = lastUserActivity;
    previousFramePosition = { ...currentPosition };
    previousFrameTime = lastUserActivity;
    lastTrailPosition = { ...currentPosition };
    lastTrailScale = frameScale;
  });

  stage.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " "].includes(event.key)) {
      return;
    }

    event.preventDefault();
    lastUserActivity = performance.now();
    travelAccumulator = 0;
    switchVideo();
  });

  function screenOrientationAngle() {
    return Number(window.screen.orientation?.angle ?? window.orientation ?? 0);
  }

  function mapTilt(betaDelta, gammaDelta) {
    const angle = ((screenOrientationAngle() % 360) + 360) % 360;

    if (angle === 90) {
      return { x: betaDelta, y: -gammaDelta };
    }

    if (angle === 180) {
      return { x: -gammaDelta, y: -betaDelta };
    }

    if (angle === 270) {
      return { x: -betaDelta, y: gammaDelta };
    }

    return { x: gammaDelta, y: betaDelta };
  }

  function mapTiltToAxis(amount, start, minimum, maximum) {
    return amount < 0
      ? start + (start - minimum) * amount
      : start + (maximum - start) * amount;
  }

  function resetMotionCalibration() {
    baseOrientation = null;
    motionOrigin = { ...currentPosition };
    lastTiltPosition = null;
    targetPosition = { ...currentPosition };
  }

  function handleOrientation(event) {
    if (!stageVisible || event.beta == null || event.gamma == null) {
      return;
    }

    if (!baseOrientation) {
      baseOrientation = { beta: event.beta, gamma: event.gamma };
      motionOrigin = { ...currentPosition };
      lastTiltPosition = { x: 0, y: 0 };
      targetPosition = { ...currentPosition };
      lastMotionInput = performance.now();
      lastUserActivity = lastMotionInput;
      return;
    }

    const betaDelta = event.beta - baseOrientation.beta;
    const gammaDelta = event.gamma - baseOrientation.gamma;
    const mapped = mapTilt(betaDelta, gammaDelta);
    const maximumTilt = 18;
    const clamped = {
      x: Math.max(-maximumTilt, Math.min(maximumTilt, mapped.x)),
      y: Math.max(-maximumTilt, Math.min(maximumTilt, mapped.y)),
    };
    const movementBounds = getMovementBounds(
      frame.offsetWidth * frameScale,
      frame.offsetHeight * frameScale
    );
    const origin = clampPosition(motionOrigin || currentPosition, movementBounds);
    const normalizedTilt = {
      x: clamped.x / maximumTilt,
      y: clamped.y / maximumTilt,
    };
    const previousTarget = { ...targetPosition };

    targetPosition = {
      x: mapTiltToAxis(
        normalizedTilt.x,
        origin.x,
        movementBounds.minX,
        movementBounds.maxX
      ),
      y: mapTiltToAxis(
        normalizedTilt.y,
        origin.y,
        movementBounds.minY,
        movementBounds.maxY
      ),
    };

    if (lastTiltPosition) {
      const tiltDelta = Math.hypot(
        clamped.x - lastTiltPosition.x,
        clamped.y - lastTiltPosition.y
      );
      const tiltTravel = Math.hypot(
        targetPosition.x - previousTarget.x,
        targetPosition.y - previousTarget.y
      );

      if (tiltDelta > 0.2) {
        lastMotionInput = performance.now();
        lastUserActivity = lastMotionInput;
      }

      if (tiltTravel > 2.5) {
        addTravel(tiltTravel);
      }
    }

    lastTiltPosition = clamped;
  }

  function startMotionInput() {
    if (motionListening) {
      return;
    }

    window.addEventListener("deviceorientation", handleOrientation, true);
    motionListening = true;

    if (motionButton) {
      motionButton.hidden = true;
    }
  }

  async function requestMotionPermission() {
    const OrientationEvent = window.DeviceOrientationEvent;

    if (!OrientationEvent || typeof OrientationEvent.requestPermission !== "function") {
      startMotionInput();
      return;
    }

    try {
      const permission = await OrientationEvent.requestPermission();

      if (permission === "granted") {
        startMotionInput();
      } else if (motionButton) {
        motionButton.hidden = true;
        stageStatus.textContent = "Gyro access declined. Touch drag remains available.";
      }
    } catch (error) {
      console.error(error);

      if (motionButton) {
        motionButton.hidden = true;
      }

      stageStatus.textContent = "Gyro access unavailable. Touch drag remains available.";
    }
  }

  if (motionButton) {
    motionButton.addEventListener("pointerdown", (event) => event.stopPropagation());
    motionButton.addEventListener("click", (event) => {
      event.stopPropagation();
      requestMotionPermission();
    });
  }

  const OrientationEvent = window.DeviceOrientationEvent;

  if (OrientationEvent && typeof OrientationEvent.requestPermission === "function") {
    if (motionButton && coarsePointer.matches) {
      motionButton.hidden = false;
    }
  } else if (OrientationEvent) {
    startMotionInput();
  }

  window.addEventListener("orientationchange", resetMotionCalibration);
  window.screen.orientation?.addEventListener?.("change", resetMotionCalibration);

  function resetFramePosition() {
    setFrameRatio(videos[activeSlotIndex]);
    targetFrameScale = frameExpanded ? enlargedFrameScale() : 1;
    const targetBounds = getMovementBounds(
      frame.offsetWidth * targetFrameScale,
      frame.offsetHeight * targetFrameScale
    );

    currentPosition = clampPosition(currentPosition, targetBounds);
    targetPosition = { ...currentPosition };
    idlePosition = { ...currentPosition };
    idleLastTime = performance.now();
    lastTrailPosition = { ...currentPosition };
    lastTrailScale = frameScale;
    previousFramePosition = { ...currentPosition };
    previousFrameTime = idleLastTime;
    frameVelocity = { ...idleVelocity };
    resetMotionCalibration();
  }

  window.addEventListener("resize", resetFramePosition);

  function emitTrail(
    frameWidth,
    frameHeight,
    {
      position = currentPosition,
      startOpacity = 0.14,
      middleOpacity = 0.045,
      middleScale = 0.86,
      endScale = 0.72,
      duration = 1050,
      delay = 0,
      velocity = frameVelocity,
    } = {}
  ) {
    const activeVideo = videos[activeSlotIndex];

    if (
      trailCanvases.length === 0 ||
      activeVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      !activeVideo.videoWidth ||
      !activeVideo.videoHeight
    ) {
      return;
    }

    const canvas = trailCanvases[trailCursor % trailCanvases.length];
    const ratio = 16 / 9;
    const sourceRatio = activeVideo.videoWidth / activeVideo.videoHeight;
    let sourceX = 0;
    let sourceY = 0;
    let sourceWidth = activeVideo.videoWidth;
    let sourceHeight = activeVideo.videoHeight;

    if (sourceRatio > ratio) {
      sourceWidth = sourceHeight * ratio;
      sourceX = (activeVideo.videoWidth - sourceWidth) / 2;
    } else if (sourceRatio < ratio) {
      sourceHeight = sourceWidth / ratio;
      sourceY = (activeVideo.videoHeight - sourceHeight) / 2;
    }

    const renderWidth = Math.max(1, Math.min(300, Math.round(frameWidth)));
    const renderHeight = Math.max(1, Math.round(renderWidth / ratio));
    const context = canvas.getContext("2d", { alpha: false });

    trailCursor += 1;

    if (!context) {
      return;
    }

    canvas.width = renderWidth;
    canvas.height = renderHeight;

    try {
      context.drawImage(
        activeVideo,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        renderWidth,
        renderHeight
      );
    } catch {
      return;
    }

    canvas.style.width = `${frameWidth}px`;
    canvas.style.height = `${frameHeight}px`;
    const suppliedSpeed = Math.hypot(velocity.x, velocity.y);
    const effectiveVelocity = suppliedSpeed >= 1 ? velocity : idleVelocity;
    const speed = Math.max(1, Math.hypot(effectiveVelocity.x, effectiveVelocity.y));
    const direction = {
      x: effectiveVelocity.x / speed,
      y: effectiveVelocity.y / speed,
    };
    const dynamicStrength = Math.min(1, speed / 700);
    const driftDistance = 3 + dynamicStrength * 12;
    const originReach = 34 + dynamicStrength * 12;
    const baseX = position.x - frameWidth / 2;
    const baseY = position.y - frameHeight / 2;
    const middleX = baseX - direction.x * driftDistance * 0.42;
    const middleY = baseY - direction.y * driftDistance * 0.42;
    const endX = baseX - direction.x * driftDistance;
    const endY = baseY - direction.y * driftDistance;

    canvas.style.transformOrigin = `${50 - direction.x * originReach}% ${
      50 - direction.y * originReach
    }%`;
    canvas.style.transform = `translate3d(${baseX}px, ${baseY}px, 0) scale(1)`;

    canvas.getAnimations().forEach((animation) => animation.cancel());
    canvas.animate(
      [
        {
          opacity: startOpacity,
          transform: `translate3d(${baseX}px, ${baseY}px, 0) scale(1)`,
        },
        {
          opacity: middleOpacity,
          transform: `translate3d(${middleX}px, ${middleY}px, 0) scale(${middleScale})`,
          offset: 0.58,
        },
        {
          opacity: 0,
          transform: `translate3d(${endX}px, ${endY}px, 0) scale(${endScale})`,
        },
      ],
      {
        delay,
        duration,
        easing: "linear",
        fill: "forwards",
      }
    );
  }

  function clearTrail() {
    trailCanvases.forEach((canvas) => {
      canvas.getAnimations().forEach((animation) => animation.cancel());
      canvas.style.opacity = "0";
    });
  }

  function chooseIdleCurve(now) {
    const direction = Math.random() < 0.5 ? -1 : 1;
    const nearlyStraight = Math.random() < 0.16 ? 0.2 : 1;

    idleTargetTurnRate =
      direction * (0.045 + Math.random() * 0.17) * nearlyStraight;
    idleNextSteerTime = now + 2200 + Math.random() * 3600;
  }

  function rotateIdleVelocity(angle) {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const x = idleVelocity.x * cosine - idleVelocity.y * sine;
    const y = idleVelocity.x * sine + idleVelocity.y * cosine;

    idleVelocity = { x, y };
  }

  function advanceIdlePosition(now, bounds) {
    if (!idlePosition) {
      idlePosition = clampPosition(currentPosition, bounds);
      idleLastTime = now;
    }

    const deltaTime = Math.min(0.05, Math.max(0, (now - idleLastTime) / 1000));
    let bounced = false;

    idleLastTime = now;

    if (now >= idleNextSteerTime) {
      chooseIdleCurve(now);
    }

    const steeringEasing = 1 - Math.exp(-deltaTime * 0.9);
    idleTurnRate += (idleTargetTurnRate - idleTurnRate) * steeringEasing;
    rotateIdleVelocity(idleTurnRate * deltaTime);
    idlePosition.x += idleVelocity.x * deltaTime;
    idlePosition.y += idleVelocity.y * deltaTime;

    if (idlePosition.x <= bounds.minX) {
      idlePosition.x = bounds.minX + (bounds.minX - idlePosition.x);
      idleVelocity.x = Math.abs(idleVelocity.x);
      bounced = true;
    } else if (idlePosition.x >= bounds.maxX) {
      idlePosition.x = bounds.maxX - (idlePosition.x - bounds.maxX);
      idleVelocity.x = -Math.abs(idleVelocity.x);
      bounced = true;
    }

    if (idlePosition.y <= bounds.minY) {
      idlePosition.y = bounds.minY + (bounds.minY - idlePosition.y);
      idleVelocity.y = Math.abs(idleVelocity.y);
      bounced = true;
    } else if (idlePosition.y >= bounds.maxY) {
      idlePosition.y = bounds.maxY - (idlePosition.y - bounds.maxY);
      idleVelocity.y = -Math.abs(idleVelocity.y);
      bounced = true;
    }

    if (bounced) {
      rotateIdleVelocity((Math.random() - 0.5) * 0.34);
      chooseIdleCurve(now);
      travelAccumulator = 0;
      switchVideo("random");
    }

    return clampPosition(idlePosition, bounds);
  }

  function animateFrame(now = performance.now()) {
    const frameWidth = frame.offsetWidth;
    const frameHeight = frame.offsetHeight;
    const captionGap = 8;
    const scaleEasing = reduceMotion ? 1 : 0.085;

    frameScale += (targetFrameScale - frameScale) * scaleEasing;

    if (Math.abs(targetFrameScale - frameScale) < 0.001) {
      frameScale = targetFrameScale;
    }

    const visibleFrameWidth = frameWidth * frameScale;
    const visibleFrameHeight = frameHeight * frameScale;
    const bounds = getMovementBounds(visibleFrameWidth, visibleFrameHeight);
    const center = clampPosition(stageAnchor(), bounds);
    const pointerOverride =
      touchDragging || (pointerActive && now - lastPointerInput < 3000);
    const motionOverride = lastMotionInput > 0 && now - lastMotionInput < 260;
    const inputOverride = pointerOverride || motionOverride;
    const desired = reduceMotion
      ? center
      : inputOverride
        ? targetPosition
        : advanceIdlePosition(now, bounds);
    const clampedTarget = clampPosition(desired, bounds);
    const scaleTransitioning = Math.abs(targetFrameScale - frameScale) >= 0.001;
    const easing = reduceMotion
      ? 1
      : inputOverride
        ? pointerOverride
          ? 0.22
          : 0.085
        : scaleTransitioning
          ? 0.14
          : 1;

    currentPosition.x += (clampedTarget.x - currentPosition.x) * easing;
    currentPosition.y += (clampedTarget.y - currentPosition.y) * easing;
    currentPosition = clampPosition(currentPosition, bounds);

    if (inputOverride) {
      idlePosition = { ...currentPosition };
      idleLastTime = now;
      idleNextSteerTime = now;
    }

    const frameDeltaTime = Math.min(
      0.05,
      Math.max(0.001, (now - previousFrameTime) / 1000)
    );
    const rawVelocity = {
      x: (currentPosition.x - previousFramePosition.x) / frameDeltaTime,
      y: (currentPosition.y - previousFramePosition.y) / frameDeltaTime,
    };
    const velocityEasing = inputOverride ? 0.28 : 0.42;

    frameVelocity.x += (rawVelocity.x - frameVelocity.x) * velocityEasing;
    frameVelocity.y += (rawVelocity.y - frameVelocity.y) * velocityEasing;
    previousFramePosition = { ...currentPosition };
    previousFrameTime = now;

    frame.style.transform = `translate3d(${currentPosition.x - visibleFrameWidth / 2}px, ${
      currentPosition.y - visibleFrameHeight / 2
    }px, 0) scale(${frameScale})`;
    projectLabel.style.maxWidth = `${visibleFrameWidth}px`;
    projectLabel.style.transform = `translate3d(${currentPosition.x - visibleFrameWidth / 2}px, ${
      currentPosition.y + visibleFrameHeight / 2 + captionGap
    }px, 0)`;

    if (!lastTrailPosition) {
      lastTrailPosition = { ...currentPosition };
    }

    const distanceSinceTrail = Math.hypot(
      currentPosition.x - lastTrailPosition.x,
      currentPosition.y - lastTrailPosition.y
    );
    const scaleDistanceSinceTrail = Math.abs(frameScale - lastTrailScale) * frameWidth;
    const idleTrailProgress = inputOverride
      ? 0
      : Math.min(1, Math.max(0, now - lastUserActivity) / idleTrailRampDuration);
    const idleTrailGrowth = 1 - Math.pow(1 - idleTrailProgress, 3);
    const idleTrailDuration =
      idleTrailMinimumDuration +
      idleTrailGrowth * (idleTrailMaximumDuration - idleTrailMinimumDuration);
    // As snapshots live longer, sample them farther apart so the trail can span
    // much more time without increasing the maximum number of animated canvases.
    const idleTrailInterval = Math.max(
      28,
      idleTrailDuration / Math.max(1, trailCanvases.length - trailPoolReserve)
    );
    const trailInterval = inputOverride ? 16 : idleTrailInterval;
    const trailDistance = inputOverride ? 0.55 : 1.1;

    if (
      stageVisible &&
      now - lastTrailTime >= trailInterval &&
      (distanceSinceTrail >= trailDistance || scaleDistanceSinceTrail >= trailDistance)
    ) {
      emitTrail(visibleFrameWidth, visibleFrameHeight, {
        velocity: frameVelocity,
        startOpacity: inputOverride ? 0.2 : 0.11 + idleTrailGrowth * 0.015,
        middleOpacity: inputOverride ? 0.075 : 0.035 + idleTrailGrowth * 0.01,
        middleScale: inputOverride ? 0.86 : 0.94,
        endScale: inputOverride ? 0.7 : 0.72 - idleTrailGrowth * 0.06,
        duration: inputOverride ? 1300 : idleTrailDuration,
      });
      lastTrailTime = now;
      lastTrailPosition = { ...currentPosition };
      lastTrailScale = frameScale;
    }

    requestAnimationFrame(animateFrame);
  }

  const visibilityObserver = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      stageVisible = entry.isIntersecting && entry.intersectionRatio >= 0.2;

      if (stageVisible) {
        resetMotionCalibration();
      } else {
        clearTrail();
      }

      playActiveVideo();
    },
    { threshold: [0, 0.2, 0.5] }
  );

  visibilityObserver.observe(stage);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearTrail();
    }

    playActiveVideo();
  });

  currentProjectIndex = nextAscendingProjectIndex(-1);
  const firstProject = projects[currentProjectIndex];
  setProjectLabel(firstProject);
  videos[1].setAttribute("aria-hidden", "true");

  const firstVideo = await loadVideo(activeSlotIndex, currentProjectIndex);
  setFrameRatio(firstVideo);
  firstVideo.classList.add("is-active");
  firstVideo.setAttribute("aria-hidden", "false");
  stage.classList.add("is-ready");
  hideLoading();
  playActiveVideo();
  queueNextVideo(nextAscendingProjectIndex());
  animateFrame();
}
