import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { initSnow, setPrecipitation, prewarmSnow, prewarmSnowAccumulation } from './snow.js';
import {
  container,
  state,
  sceneModels,
  baseFrustumSize,
  lightModeBackground,
  darkModeBackground,
  isLowEndDevice,
  getPerformanceTier
} from './state.js';

// Scene setup
export const scene = new THREE.Scene();
scene.background = new THREE.Color(lightModeBackground);

// Camera
const aspect = window.innerWidth / window.innerHeight;
const frustumSize = 12;
export const camera = new THREE.OrthographicCamera(
  frustumSize * aspect / -2,
  frustumSize * aspect / 2,
  frustumSize / 2,
  frustumSize / -2,
  0.1,
  100
);
camera.position.set(0, 0, 10);

// Renderer - pixel ratio varies by device capability
// Low-end: 1.0, Medium: 1.5, High: up to 2.0
function getOptimalPixelRatio() {
  const tier = getPerformanceTier();
  const deviceRatio = window.devicePixelRatio || 1;

  if (tier === 'low') return Math.min(deviceRatio, 1.0);
  if (tier === 'medium') return Math.min(deviceRatio, 1.5);
  return Math.min(deviceRatio, 2.0);
}

export const renderer = new THREE.WebGLRenderer({
  antialias: !isLowEndDevice, // Disable antialiasing on low-end devices
  powerPreference: 'low-power',
  failIfMajorPerformanceCaveat: false // Don't fail on software rendering
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(getOptimalPixelRatio());
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

// Loaders
export const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.166.0/examples/jsm/libs/draco/');

// Reusable loaders (created once for performance)
export const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);
export const objLoader = new OBJLoader();
export const mtlLoader = new MTLLoader();

// Cleanup function for memory management
function cleanupScene() {
  // Dispose renderer
  if (renderer) renderer.dispose();

  // Dispose all geometries and materials in scene
  scene.traverse((object) => {
    if (object.geometry) {
      object.geometry.dispose();
    }
    if (object.material) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => {
        if (material.map) material.map.dispose();
        if (material.normalMap) material.normalMap.dispose();
        if (material.roughnessMap) material.roughnessMap.dispose();
        if (material.metalnessMap) material.metalnessMap.dispose();
        material.dispose();
      });
    }
  });

  // Dispose DRACO decoder
  if (dracoLoader) dracoLoader.dispose();
}

// Cleanup on page unload to prevent memory leaks
// Use both events for cross-browser compatibility (iOS Safari uses pagehide)
window.addEventListener('beforeunload', cleanupScene);
window.addEventListener('pagehide', cleanupScene);

// Lighting - Bright studio setup for ceramic look
export const ambient = new THREE.AmbientLight(0xffffff, 0.8);
scene.add(ambient);

export const hemiLight = new THREE.HemisphereLight(0xffffff, 0xf5f5f5, 0.5);
scene.add(hemiLight);

export const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
keyLight.position.set(5, 8, 6);
scene.add(keyLight);

export const fillLight = new THREE.DirectionalLight(0xf8f8ff, 0.9);
fillLight.position.set(-6, 4, 4);
scene.add(fillLight);

export const rimLight = new THREE.DirectionalLight(0xffffff, 0.6);
rimLight.position.set(0, 2, -6);
scene.add(rimLight);

// Studio light values (bright, ceramic look)
export const studioLightValues = {
  ambient: { color: 0xffffff, intensity: 0.8 },
  hemi: { sky: 0xffffff, ground: 0xf5f5f5, intensity: 0.5 },
  key: { color: 0xffffff, intensity: 1.4 },
  fill: { color: 0xf8f8ff, intensity: 0.9 },
  rim: { color: 0xffffff, intensity: 0.6 }
};

// Disco mode values
export const discoModeValues = {
  ambient: { color: 0xffffff, intensity: 2.0 },
  hemi: { sky: 0xffffff, ground: 0xffffff, intensity: 0.4 },
  key: { color: 0x9c9c9c, intensity: 1.5 },
  fill: { color: 0xf0f4ff, intensity: 1.6 },
  rim: { color: 0xffffff, intensity: 0.3 }
};

// Restore studio lighting (after disco mode)
export function applyStudioLighting() {
  ambient.color.setHex(studioLightValues.ambient.color);
  ambient.intensity = studioLightValues.ambient.intensity;
  hemiLight.color.setHex(studioLightValues.hemi.sky);
  hemiLight.groundColor.setHex(studioLightValues.hemi.ground);
  hemiLight.intensity = studioLightValues.hemi.intensity;
  keyLight.color.setHex(studioLightValues.key.color);
  keyLight.intensity = studioLightValues.key.intensity;
  fillLight.color.setHex(studioLightValues.fill.color);
  fillLight.intensity = studioLightValues.fill.intensity;
  rimLight.color.setHex(studioLightValues.rim.color);
  rimLight.intensity = studioLightValues.rim.intensity;
}

export function applyLightingMode(values) {
  ambient.color.setHex(values.ambient.color);
  ambient.intensity = values.ambient.intensity;
  hemiLight.color.setHex(values.hemi.sky);
  hemiLight.groundColor.setHex(values.hemi.ground);
  hemiLight.intensity = values.hemi.intensity;
  keyLight.color.setHex(values.key.color);
  keyLight.intensity = values.key.intensity;
  fillLight.color.setHex(values.fill.color);
  fillLight.intensity = values.fill.intensity;
  rimLight.color.setHex(values.rim.color);
  rimLight.intensity = values.rim.intensity;
}

export function flickerLights(callback) {
  const flickerCount = 4;
  const flickerDuration = 80;
  let flickerIndex = 0;

  const originalIntensities = {
    ambient: ambient.intensity,
    key: keyLight.intensity,
    fill: fillLight.intensity,
    rim: rimLight.intensity,
    hemi: hemiLight.intensity
  };

  function flicker() {
    if (flickerIndex >= flickerCount) {
      if (callback) callback();
      return;
    }

    const dimFactor = 0.1 + Math.random() * 0.3;
    ambient.intensity = originalIntensities.ambient * dimFactor;
    keyLight.intensity = originalIntensities.key * dimFactor;
    fillLight.intensity = originalIntensities.fill * dimFactor;
    rimLight.intensity = originalIntensities.rim * dimFactor;
    hemiLight.intensity = originalIntensities.hemi * dimFactor;

    setTimeout(() => {
      ambient.intensity = originalIntensities.ambient * 0.7;
      keyLight.intensity = originalIntensities.key * 0.7;
      fillLight.intensity = originalIntensities.fill * 0.7;
      rimLight.intensity = originalIntensities.rim * 0.7;
      hemiLight.intensity = originalIntensities.hemi * 0.7;

      flickerIndex++;
      setTimeout(flicker, flickerDuration / 2);
    }, flickerDuration);
  }

  flicker();
}

// PARTY MODE
let partyAnimationId = null;
let partyStartTime = 0;
let partyToggleCooldown = false;
const partyColors = [
  0xff0066, 0x00ff66, 0x6600ff, 0xff6600, 0x00ffff, 0xff00ff, 0xffff00
];
const policeRed = 0xff0022;
const policeBlue = 0x0044ff;

export function startPartyMode() {
  if (state.isPartyMode) return;
  state.isPartyMode = true;
  state.isDarkMode = true;
  partyStartTime = Date.now();

  document.body.classList.add('dark-mode', 'party-mode');
  document.documentElement.classList.add('dark-mode');
  scene.background.setHex(darkModeBackground);

  animateParty();
}

export function stopPartyMode() {
  state.isPartyMode = false;
  document.body.classList.remove('party-mode');

  if (partyAnimationId) {
    cancelAnimationFrame(partyAnimationId);
    partyAnimationId = null;
  }
}

function animateParty() {
  if (!state.isPartyMode) return;

  const time = (Date.now() - partyStartTime) / 1000;
  const beat = Math.sin(time * 8) * 0.5 + 0.5;
  const fastBeat = Math.sin(time * 16) * 0.5 + 0.5;

  const policePhase = Math.floor(time * 6) % 2;
  const policeFlash = Math.sin(time * 20) > 0;

  const isExplosion = Math.random() > 0.97;
  const explosionIntensity = isExplosion ? 8 + Math.random() * 5 : 0;

  const colorIndex = Math.floor(time * 2) % partyColors.length;
  const nextColorIndex = (colorIndex + 1) % partyColors.length;
  const colorLerp = (time * 2) % 1;

  const discoColor1 = new THREE.Color(partyColors[colorIndex]);
  const discoColor2 = new THREE.Color(partyColors[nextColorIndex]);
  discoColor1.lerp(discoColor2, colorLerp);

  if (isExplosion) {
    keyLight.color.setHex(0xffffff);
    keyLight.intensity = explosionIntensity;
  } else {
    keyLight.color.copy(discoColor1);
    keyLight.intensity = 1.5 + beat * 2;
  }

  if (policePhase === 0 && policeFlash) {
    fillLight.color.setHex(policeRed);
    fillLight.intensity = 3 + fastBeat * 2;
  } else {
    fillLight.color.setHex(partyColors[(colorIndex + 2) % partyColors.length]);
    fillLight.intensity = 1 + fastBeat;
  }

  if (policePhase === 1 && policeFlash) {
    rimLight.color.setHex(policeBlue);
    rimLight.intensity = 3 + fastBeat * 2;
  } else {
    rimLight.color.setHex(partyColors[(colorIndex + 4) % partyColors.length]);
    rimLight.intensity = 0.8 + beat * 1.5;
  }

  ambient.color.setHex(isExplosion ? 0xffffff : 0x222233);
  ambient.intensity = isExplosion ? 2 : (0.15 + beat * 0.15);

  if (policeFlash) {
    hemiLight.color.setHex(policePhase === 0 ? policeRed : policeBlue);
    hemiLight.groundColor.setHex(policePhase === 0 ? policeBlue : policeRed);
    hemiLight.intensity = 0.5 + fastBeat * 0.5;
  } else {
    hemiLight.color.setHex(0x111122);
    hemiLight.groundColor.setHex(0x000000);
    hemiLight.intensity = 0.2;
  }

  partyAnimationId = requestAnimationFrame(animateParty);
}

// Import updateModelListActiveState dynamically to avoid circular dependency
let updateModelListActiveStateFunc = null;
export function setUpdateModelListActiveState(fn) {
  updateModelListActiveStateFunc = fn;
}

export function togglePartyMode() {
  if (partyToggleCooldown) return;
  partyToggleCooldown = true;
  setTimeout(() => { partyToggleCooldown = false; }, 1500);

  flickerLights(() => {
    const themeColorMeta = document.getElementById('theme-color-meta');
    if (state.isPartyMode) {
      stopPartyMode();
      state.isDarkMode = false;
      document.body.classList.remove('dark-mode', 'party-mode');
      document.documentElement.classList.remove('dark-mode');
      scene.background.setHex(lightModeBackground);
      // Update Safari bar color
      if (themeColorMeta) themeColorMeta.content = '#f7f6f3';
      // Restore studio lighting
      applyStudioLighting();
      // Turn off precipitation when exiting disco mode
      setPrecipitation('none');
    } else {
      state.isDarkMode = true;
      document.body.classList.add('dark-mode');
      document.documentElement.classList.add('dark-mode');
      scene.background.setHex(darkModeBackground);
      // Update Safari bar color to black
      if (themeColorMeta) themeColorMeta.content = '#0a0a0a';
      // Enable snow in disco mode
      setPrecipitation('snow');
      startPartyMode();
    }
    // Update model list colors for dark/light mode
    if (updateModelListActiveStateFunc) {
      updateModelListActiveStateFunc();
    }
  });
}

// Snow system initialization and prewarming
let snowPrewarmScheduled = false;

export function scheduleSnowPrewarm() {
  if (snowPrewarmScheduled) return;
  snowPrewarmScheduled = true;

  const isMobile = window.innerWidth <= 900;

  // Always prewarm the basic snow shader (lightweight) to avoid disco mode delay
  const run = () => prewarmSnow(renderer);
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 1200 });
  } else {
    setTimeout(run, 300);
  }

  // Skip accumulation prewarming on mobile to reduce memory pressure
  if (isMobile) return;

  const accumulationRun = () => prewarmSnowAccumulation();
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(accumulationRun, { timeout: 1500 });
  } else {
    setTimeout(accumulationRun, 600);
  }
}

// Initialize snow system
initSnow(scene, camera, sceneModels);

// Handle resize
export function handleResize() {
  const aspect = window.innerWidth / window.innerHeight;
  camera.left = baseFrustumSize * aspect / -2;
  camera.right = baseFrustumSize * aspect / 2;
  camera.top = baseFrustumSize / 2;
  camera.bottom = baseFrustumSize / -2;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
