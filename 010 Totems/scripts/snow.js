import * as THREE from 'three';
import { isLowEndDevice, getPerformanceTier } from './state.js';

// Snow system state
let snowParticles = null;
let snowGeometry = null;

// Particle count based on device performance
// Low-end: 500, Mobile: 1500, Desktop: 3000
function getSnowCount() {
  const tier = getPerformanceTier();
  if (tier === 'low') return 500;
  if (tier === 'medium') return 1500;
  return 3000;
}

let SNOW_COUNT = 3000; // Will be set in initSnow
const snowData = []; // velocity, drift, size, phase for each particle
let currentPrecipType = 'none';

// Wind state - varies over time for gusts
let windTime = 0;
let gustStrength = 0;
let gustTarget = 0;

// References
let scene = null;
let camera = null;
let sceneModels = null;
let snowAccumulationPrewarmed = false;
let snowAccumulationWarmupInProgress = false;

export function initSnow(sceneRef, cameraRef, modelsRef) {
  scene = sceneRef;
  camera = cameraRef;
  sceneModels = modelsRef;

  // Set particle count based on device performance
  SNOW_COUNT = getSnowCount();
  createSnowSystem();
}

function createSnowSystem() {
  snowGeometry = new THREE.BufferGeometry();
  const positions = new Float32Array(SNOW_COUNT * 3);
  const sizes = new Float32Array(SNOW_COUNT);

  for (let i = 0; i < SNOW_COUNT; i++) {
    // Spread across view
    positions[i * 3] = (Math.random() - 0.5) * 25;
    positions[i * 3 + 1] = Math.random() * 20 - 5;
    positions[i * 3 + 2] = 3 + Math.random() * 5;

    // Each snowflake has unique properties
    snowData.push({
      velocity: 0.015 + Math.random() * 0.04,  // Fall speed varies a lot
      drift: (Math.random() - 0.5) * 0.03,     // Horizontal drift
      wobble: Math.random() * Math.PI * 2,      // Phase for wobble
      wobbleSpeed: 0.5 + Math.random() * 1.5,   // Wobble frequency
      wobbleAmp: 0.002 + Math.random() * 0.008, // Wobble amount
      size: 0.8 + Math.random() * 1.5           // Size variation
    });

    sizes[i] = snowData[i].size;
  }

  snowGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  snowGeometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

  const snowMaterial = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.2,
    transparent: true,
    opacity: 0.9,
    sizeAttenuation: false
  });

  snowParticles = new THREE.Points(snowGeometry, snowMaterial);
  snowParticles.visible = false;
  snowParticles.renderOrder = 999;
  scene.add(snowParticles);
}

// Update snow accumulation on models by sampling top-facing surfaces
function buildSnowAccumulationForModel(model, options = {}) {
  if (!model || !model.object) return;

  const innerObj = model.object.userData.innerObject;
  if (!innerObj) return;

  const { visibleOverride } = options;

  // Skip if already has snow
  if (innerObj.userData.snowParticles) {
    if (visibleOverride !== undefined) {
      innerObj.userData.snowParticles.visible = visibleOverride;
    } else {
      innerObj.userData.snowParticles.visible = model.object.visible;
    }
    return;
  }

  const snowPositions = [];

  // Traverse all meshes and sample vertices on upward-facing surfaces
  innerObj.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;

    const geo = child.geometry;
    const posAttr = geo.attributes.position;
    const normalAttr = geo.attributes.normal;
    const indexAttr = geo.index;

    if (!posAttr || !normalAttr) return;

    // Get the mesh's transformation to local space of innerObj
    const meshMatrix = new THREE.Matrix4();
    child.updateWorldMatrix(true, false);
    innerObj.updateWorldMatrix(true, false);

    // Get relative transform from mesh to innerObj
    const innerObjMatrixInverse = innerObj.matrixWorld.clone().invert();
    meshMatrix.multiplyMatrices(innerObjMatrixInverse, child.matrixWorld);

    const normalMatrix = new THREE.Matrix3().getNormalMatrix(meshMatrix);

    // Sample triangles and place snow on upward-facing ones
    const vertex = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const transformedVertex = new THREE.Vector3();
    const transformedNormal = new THREE.Vector3();

    if (indexAttr) {
      // Indexed geometry - sample triangles
      for (let i = 0; i < indexAttr.count; i += 3) {
        // Get triangle center and average normal
        let cx = 0, cy = 0, cz = 0;
        let nx = 0, ny = 0, nz = 0;

        for (let j = 0; j < 3; j++) {
          const idx = indexAttr.getX(i + j);
          cx += posAttr.getX(idx);
          cy += posAttr.getY(idx);
          cz += posAttr.getZ(idx);
          nx += normalAttr.getX(idx);
          ny += normalAttr.getY(idx);
          nz += normalAttr.getZ(idx);
        }

        vertex.set(cx / 3, cy / 3, cz / 3);
        normal.set(nx / 3, ny / 3, nz / 3).normalize();

        // Transform to innerObj local space
        transformedVertex.copy(vertex).applyMatrix4(meshMatrix);
        transformedNormal.copy(normal).applyMatrix3(normalMatrix).normalize();

        // Check if surface faces upward in local space (Y is up)
        if (transformedNormal.y > 0.4) {
          // Add some randomness within the triangle
          const rand1 = Math.random() * 0.3;
          const rand2 = Math.random() * 0.3;

          snowPositions.push(
            transformedVertex.x + (Math.random() - 0.5) * 0.02,
            transformedVertex.y + 0.01,
            transformedVertex.z + (Math.random() - 0.5) * 0.02
          );
        }
      }
    } else {
      // Non-indexed geometry
      for (let i = 0; i < posAttr.count; i += 3) {
        let cx = 0, cy = 0, cz = 0;
        let nx = 0, ny = 0, nz = 0;

        for (let j = 0; j < 3; j++) {
          cx += posAttr.getX(i + j);
          cy += posAttr.getY(i + j);
          cz += posAttr.getZ(i + j);
          nx += normalAttr.getX(i + j);
          ny += normalAttr.getY(i + j);
          nz += normalAttr.getZ(i + j);
        }

        vertex.set(cx / 3, cy / 3, cz / 3);
        normal.set(nx / 3, ny / 3, nz / 3).normalize();

        transformedVertex.copy(vertex).applyMatrix4(meshMatrix);
        transformedNormal.copy(normal).applyMatrix3(normalMatrix).normalize();

        if (transformedNormal.y > 0.4) {
          snowPositions.push(
            transformedVertex.x + (Math.random() - 0.5) * 0.02,
            transformedVertex.y + 0.01,
            transformedVertex.z + (Math.random() - 0.5) * 0.02
          );
        }
      }
    }
  });

  if (snowPositions.length === 0) return;

  // Limit and add clustering - reduce on low-end devices
  const finalPositions = [];
  const tier = getPerformanceTier();
  const maxSnow = tier === 'low' ? 150 : (tier === 'medium' ? 300 : 500);
  const step = Math.max(1, Math.floor(snowPositions.length / 3 / maxSnow) * 3);

  for (let i = 0; i < snowPositions.length && finalPositions.length < maxSnow * 3; i += step) {
    const x = snowPositions[i];
    const y = snowPositions[i + 1];
    const z = snowPositions[i + 2];

    finalPositions.push(x, y, z);

    // Add 1-2 clustered particles
    const clumpCount = 1 + Math.floor(Math.random() * 2);
    for (let c = 0; c < clumpCount && finalPositions.length < maxSnow * 3; c++) {
      finalPositions.push(
        x + (Math.random() - 0.5) * 0.03,
        y + Math.random() * 0.015,
        z + (Math.random() - 0.5) * 0.03
      );
    }
  }

  if (finalPositions.length === 0) return;

  const snowGeo = new THREE.BufferGeometry();
  snowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(finalPositions), 3));

  const isMobile = window.innerWidth < window.innerHeight;
  const snowMat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: isMobile ? 2.5 : 1.8,
    transparent: true,
    opacity: 0.92,
    sizeAttenuation: false
  });

  const snowPoints = new THREE.Points(snowGeo, snowMat);
  snowPoints.renderOrder = 998;
  snowPoints.visible = visibleOverride !== undefined ? visibleOverride : model.object.visible;
  innerObj.add(snowPoints);
  innerObj.userData.snowParticles = snowPoints;
}

export function updateSnowAccumulation() {
  if (currentPrecipType !== 'snow' || !sceneModels) return;

  sceneModels.forEach((model) => {
    buildSnowAccumulationForModel(model);
  });
}

export function hideSnowAccumulation() {
  if (!sceneModels) return;
  sceneModels.forEach((model) => {
    const innerObj = model?.object?.userData?.innerObject;
    if (innerObj?.userData?.snowParticles) {
      innerObj.userData.snowParticles.visible = false;
    }
  });
}

// Sync snow visibility with model visibility (call when switching modes)
export function syncSnowVisibility() {
  if (currentPrecipType !== 'snow' || !sceneModels) return;
  sceneModels.forEach((model) => {
    if (!model?.object) return;
    const innerObj = model.object.userData?.innerObject;
    if (innerObj?.userData?.snowParticles) {
      innerObj.userData.snowParticles.visible = model.object.visible;
    }
  });
}

// Clear all snow accumulation to force recalculation
export function clearSnowAccumulation() {
  if (!sceneModels) return;
  sceneModels.forEach((model) => {
    const innerObj = model?.object?.userData?.innerObject;
    if (innerObj?.userData?.snowParticles) {
      innerObj.remove(innerObj.userData.snowParticles);
      innerObj.userData.snowParticles.geometry.dispose();
      innerObj.userData.snowParticles.material.dispose();
      innerObj.userData.snowParticles = null;
    }
  });
}

export function updatePrecipitation(windSpeed, isSnow) {
  if (!snowParticles || !snowParticles.visible) return;

  const positions = snowGeometry.attributes.position.array;
  const time = Date.now() * 0.001;

  // Update wind gusts - random changes over time
  windTime += 0.016;
  if (Math.random() < 0.01) {
    gustTarget = (Math.random() - 0.3) * 0.03; // Occasional gusts, mostly one direction
  }
  gustStrength += (gustTarget - gustStrength) * 0.02;

  const baseWind = windSpeed * 0.008 + gustStrength;

  for (let i = 0; i < SNOW_COUNT; i++) {
    const data = snowData[i];

    // Fall with individual velocity
    positions[i * 3 + 1] -= data.velocity;

    // Horizontal movement: wind + drift + wobble
    const wobble = Math.sin(time * data.wobbleSpeed + data.wobble) * data.wobbleAmp;
    positions[i * 3] += baseWind + data.drift + wobble;

    // Slight z wobble too
    positions[i * 3 + 2] += Math.cos(time * data.wobbleSpeed * 0.7 + data.wobble) * data.wobbleAmp * 0.5;

    // Reset when below view - follow camera Y
    const resetY = camera.position.y + 12;
    const bottomY = camera.position.y - 10;
    if (positions[i * 3 + 1] < bottomY) {
      positions[i * 3 + 1] = resetY + Math.random() * 3;
      positions[i * 3] = (Math.random() - 0.5) * 25;
      positions[i * 3 + 2] = 3 + Math.random() * 5;
    }

    // Wrap horizontally
    if (positions[i * 3] > 15) positions[i * 3] = -15;
    if (positions[i * 3] < -15) positions[i * 3] = 15;
  }

  snowGeometry.attributes.position.needsUpdate = true;
}

function resetSnowParticles() {
  if (!snowGeometry || !camera) return;

  const positions = snowGeometry.attributes.position.array;
  const resetY = camera.position.y + 12;
  const bottomY = camera.position.y - 10;
  const spanY = resetY - bottomY;

  for (let i = 0; i < SNOW_COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 25;
    positions[i * 3 + 1] = bottomY + Math.random() * spanY;
    positions[i * 3 + 2] = 3 + Math.random() * 5;
  }

  snowGeometry.attributes.position.needsUpdate = true;
  windTime = 0;
  gustStrength = 0;
  gustTarget = 0;
}

export function setPrecipitation(type, options = {}) {
  currentPrecipType = type;

  if (!snowParticles) return;

  const isMobile = window.innerWidth < window.innerHeight;
  const { accumulate = true } = options;

  if (type === 'none') {
    snowParticles.visible = false;
    hideSnowAccumulation();
    return;
  }

  snowParticles.visible = true;
  resetSnowParticles();

  if (type === 'snow') {
    snowParticles.material.color.setHex(0xffffff);
    snowParticles.material.size = isMobile ? 3 : 2;
    snowParticles.material.opacity = 0.9;

    // Skip snow accumulation entirely on low-end devices to save memory
    const tier = getPerformanceTier();
    if (tier === 'low') {
      // No accumulation on low-end - just falling snow
      hideSnowAccumulation();
    } else if (accumulate) {
      // Defer accumulation on mobile to avoid blocking disco mode start
      if (isMobile) {
        setTimeout(updateSnowAccumulation, 100);
      } else {
        updateSnowAccumulation();
      }
    } else {
      hideSnowAccumulation();
    }
  } else {
    // Rain
    snowParticles.material.color.setHex(0x99aacc);
    snowParticles.material.size = isMobile ? 2 : 1.5;
    snowParticles.material.opacity = 0.6;
    hideSnowAccumulation();
  }
}

export function getCurrentPrecipType() {
  return currentPrecipType;
}

export function prewarmSnowAccumulation() {
  if (!sceneModels || snowAccumulationPrewarmed || snowAccumulationWarmupInProgress) return;

  const hasLoadedModels = sceneModels.some((model) => model?.object);
  if (!hasLoadedModels) return;

  snowAccumulationWarmupInProgress = true;
  let index = 0;
  const visibleOverride = currentPrecipType === 'snow' ? undefined : false;

  const runBatch = (deadline) => {
    const hasDeadline = !!deadline && typeof deadline.timeRemaining === 'function';

    while (index < sceneModels.length) {
      buildSnowAccumulationForModel(sceneModels[index], { visibleOverride });
      index += 1;

      if (hasDeadline) {
        if (deadline.timeRemaining() < 5) break;
      } else {
        break;
      }
    }

    if (index < sceneModels.length) {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(runBatch, { timeout: 1000 });
      } else {
        setTimeout(runBatch, 16);
      }
      return;
    }

    snowAccumulationWarmupInProgress = false;
    snowAccumulationPrewarmed = true;
    if (visibleOverride === false) {
      hideSnowAccumulation();
    }
  };

  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(runBatch, { timeout: 1000 });
  } else {
    setTimeout(runBatch, 16);
  }
}

export function prewarmSnow(rendererRef) {
  if (!rendererRef || !snowParticles || !snowGeometry || !camera) return;

  if (typeof rendererRef.compile === 'function') {
    const tempScene = new THREE.Scene();
    const tempPoints = new THREE.Points(snowGeometry, snowParticles.material);
    tempPoints.frustumCulled = false;
    tempScene.add(tempPoints);
    rendererRef.compile(tempScene, camera);
  }
}
