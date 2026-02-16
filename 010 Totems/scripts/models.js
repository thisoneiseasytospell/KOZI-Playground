import * as THREE from 'three';
import { syncSnowVisibility } from './snow.js';
import {
  state,
  models,
  sceneModels,
  modelInfoById,
  setModels,
  setModelInfoById,
  container,
  gridModeIcon,
  modelListItems,
  getGridConfig,
  getGridPosition,
  GRID_MODEL_SIZE,
  SOLO_MODEL_SIZE,
  DEFAULT_GRID_ROTATION_DEG,
  GRID_ROTATION_OVERRIDE_DEG,
  MAX_TEXTURE_SIZE,
  touchState,
  getPerformanceTier
} from './state.js';
import { scene, camera, renderer, gltfLoader, objLoader, mtlLoader, scheduleSnowPrewarm } from './scene.js';

// Forward declarations for functions that will be set by other modules
let updateModelInfoDisplayFunc = null;
let updateModelListActiveStateFunc = null;
let updateHeaderVisibilityFunc = null;
let updateModelListVisibilityFunc = null;
let triggerGridIntroRandomizationFunc = null;

export function setUpdateModelInfoDisplay(fn) {
  updateModelInfoDisplayFunc = fn;
}

export function setUpdateModelListActiveState(fn) {
  updateModelListActiveStateFunc = fn;
}

export function setUpdateHeaderVisibility(fn) {
  updateHeaderVisibilityFunc = fn;
}

export function setUpdateModelListVisibility(fn) {
  updateModelListVisibilityFunc = fn;
}

export function setTriggerGridIntroRandomization(fn) {
  triggerGridIntroRandomizationFunc = fn;
}

// Helper to split file paths
export function splitPath(path) {
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash === -1) return { basePath: '', fileName: path };
  return {
    basePath: path.slice(0, lastSlash + 1),
    fileName: path.slice(lastSlash + 1),
  };
}

// Limit texture size to reduce GPU memory
// Uses smaller limits on low-end devices
export function limitTextureSize(texture) {
  if (!texture || !texture.image) return;

  const img = texture.image;
  const tier = getPerformanceTier();

  // More aggressive texture limits on low-end devices
  const maxSize = tier === 'low' ? 512 : (tier === 'medium' ? 768 : MAX_TEXTURE_SIZE);

  if (img.width <= maxSize && img.height <= maxSize) return;

  try {
    // Create canvas to downscale
    const canvas = document.createElement('canvas');
    const scale = maxSize / Math.max(img.width, img.height);
    canvas.width = Math.floor(img.width * scale);
    canvas.height = Math.floor(img.height * scale);

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      // Canvas 2D context failed (can happen on older Safari)
      console.warn('Canvas 2D context unavailable for texture resize');
      return;
    }

    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    texture.image = canvas;
    texture.needsUpdate = true;
  } catch (e) {
    // Texture resize failed - continue with original size
    console.warn('Texture resize failed:', e);
  }
}

// Loading state
export function checkLoadingComplete() {
  state.modelsLoaded++;

  if (!state.hasCompletedInitialLoad && state.totalAssetsToLoad > 0 && state.modelsLoaded >= state.totalAssetsToLoad) {
    state.hasCompletedInitialLoad = true;
    prewarmGridModels();
    scheduleSnowPrewarm();
    // Setup intro prompt text (will only be shown when user tries to scroll)
    const introPrompt = document.getElementById('intro-cursor-prompt');
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (introPrompt) {
      introPrompt.textContent = isTouchDevice ? 'tap to enter' : 'click to enter';
    }
  }
}

export function prewarmGridModels() {
  if (!renderer) return;

  // Compile shaders for all models
  if (typeof renderer.compile === 'function') {
    renderer.compile(scene, camera);
  }
}

export function showLoadingError(message) {
  console.error('Loading error:', message);
}

// Process and add model to scene (unified - single model per config)
export function processSceneModel(object3d, modelConfig, modelIndex) {
  // Setup materials and optimize textures
  object3d.traverse((child) => {
    if (child.isMesh) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => {
        if (!material) return;
        material.flatShading = false;

        // Limit texture sizes to reduce memory
        if (material.map) limitTextureSize(material.map);
        if (material.normalMap) limitTextureSize(material.normalMap);
        if (material.roughnessMap) limitTextureSize(material.roughnessMap);
        if (material.metalnessMap) limitTextureSize(material.metalnessMap);

        const hasPBRMaps = material.map || material.normalMap || material.roughnessMap || material.metalnessMap || material.transmissionMap || material.clearcoatMap;
        const usesTransmission = material.transmission !== undefined && material.transmission > 0;

        if (!hasPBRMaps && !usesTransmission) {
          if (material.roughness !== undefined) material.roughness *= 0.3;
          if (material.metalness !== undefined) material.metalness = Math.max(material.metalness, 0.6);
        }

        material.needsUpdate = true;
      });
    }
  });

  // Center and scale for grid
  const initialBBox = new THREE.Box3().setFromObject(object3d);
  const initialSize = new THREE.Vector3();
  const initialCenter = new THREE.Vector3();
  initialBBox.getSize(initialSize);
  initialBBox.getCenter(initialCenter);

  object3d.position.sub(initialCenter);

  const maxDimension = Math.max(initialSize.x, initialSize.y, initialSize.z) || 1;
  const gridConfig = getGridConfig();
  const desiredSize = gridConfig.modelSize; // Use responsive model size
  const computedScale = desiredSize / maxDimension;
  const manualScale = typeof modelConfig.scale === 'number' ? modelConfig.scale : 1;
  object3d.scale.multiplyScalar(computedScale * manualScale);

  // Recalculate after scaling
  object3d.updateMatrixWorld(true);
  const scaledBBox = new THREE.Box3().setFromObject(object3d);
  const scaledCenter = new THREE.Vector3();
  scaledBBox.getCenter(scaledCenter);
  // Center horizontally (X,Z) but bottom-align vertically (Y)
  // This ensures all models appear to sit at the same level in grid
  object3d.position.x -= scaledCenter.x;
  object3d.position.z -= scaledCenter.z;
  object3d.position.y -= scaledBBox.min.y;

  // Random base rotation for each model - gives variety
  const overrideDeg = GRID_ROTATION_OVERRIDE_DEG[modelConfig.id];
  const baseRotationDeg = typeof modelConfig.gridRotationDeg === 'number'
    ? modelConfig.gridRotationDeg
    : (overrideDeg !== undefined ? overrideDeg : DEFAULT_GRID_ROTATION_DEG);

  // Add random variation to base rotation
  const randomYOffset = (Math.random() - 0.5) * 40; // ±20 degrees
  const randomXOffset = (Math.random() - 0.5) * 20; // ±10 degrees tilt
  const rotationRadY = THREE.MathUtils.degToRad(baseRotationDeg + randomYOffset);
  const rotationRadX = THREE.MathUtils.degToRad(randomXOffset);

  object3d.rotation.y += rotationRadY;
  object3d.rotation.x += rotationRadX;

  // Create group
  const group = new THREE.Group();
  group.add(object3d);

  // Position in grid by default
  const config = getGridConfig();
  const gridPosition = getGridPosition(modelIndex);
  group.position.set(gridPosition.x, gridPosition.y, 0);
  // On mobile solo mode, hide all models initially (exitIntro will show first one)
  // On desktop, show in grid mode
  group.visible = config.isMobileSolo ? false : state.isGridMode;
  group.userData.modelIndex = modelIndex;
  group.userData.innerObject = object3d;
  group.userData.baseRotationY = object3d.rotation.y;
  group.userData.baseRotationX = object3d.rotation.x;
  group.userData.baseScale = object3d.scale.x;

  scene.add(group);
  sceneModels[modelIndex] = { object: group };
  if (triggerGridIntroRandomizationFunc) {
    triggerGridIntroRandomizationFunc();
  }
  checkLoadingComplete();
}

// Load a single model
export function loadModel(modelConfig, modelIndex) {
  if (modelConfig.glb) {
    const { basePath: glbBasePath, fileName: glbFileName } = splitPath(modelConfig.glb);

    if (glbBasePath) {
      gltfLoader.setPath(glbBasePath);
      gltfLoader.setResourcePath(glbBasePath);
    }

    gltfLoader.load(
      glbBasePath ? glbFileName : modelConfig.glb,
      (gltf) => {
        const source = gltf.scene || (gltf.scenes && gltf.scenes[0]);
        if (!source) {
          console.error('GLB does not contain a scene:', modelConfig.glb);
          return;
        }
        processSceneModel(source, modelConfig, modelIndex);
      },
      undefined,
      (error) => {
        console.error('Error loading GLB:', error);
        checkLoadingComplete(); // Still count as loaded to avoid stuck state
      }
    );
    return;
  }

  if (!modelConfig.obj) {
    console.error('Model configuration missing obj or glb path:', modelConfig);
    return;
  }

  const { basePath: objBasePath, fileName: objFileName } = splitPath(modelConfig.obj);

  if (objBasePath) {
    objLoader.setPath(objBasePath);
    objLoader.setResourcePath(objBasePath);
  }

  const loadObj = () => {
    objLoader.load(
      objBasePath ? objFileName : modelConfig.obj,
      (object) => {
        processSceneModel(object, modelConfig, modelIndex);
      },
      undefined,
      (error) => {
        console.error('Error loading OBJ:', error);
        checkLoadingComplete(); // Still count as loaded to avoid stuck state
      }
    );
  };

  if (modelConfig.mtl) {
    const { basePath: mtlBasePath, fileName: mtlFileName } = splitPath(modelConfig.mtl);

    if (mtlBasePath) {
      mtlLoader.setPath(mtlBasePath);
      mtlLoader.setResourcePath(mtlBasePath);
    }

    mtlLoader.load(
      mtlBasePath ? mtlFileName : modelConfig.mtl,
      (materials) => {
        materials.preload();
        objLoader.setMaterials(materials);
        loadObj();
      },
      undefined,
      (error) => {
        console.error('Error loading MTL:', error);
        loadObj();
      }
    );
  } else {
    loadObj();
  }
}

export async function loadModelManifest() {
  const response = await fetch('./models.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error('Model manifest must be an array');
  }
  return data;
}

export async function loadModelInfo() {
  const response = await fetch('./model-info.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const entries = await response.json();
  if (!Array.isArray(entries)) {
    throw new Error('Model info manifest must be an array');
  }

  const infoMap = new Map();
  entries.forEach((entry) => {
    if (!entry || typeof entry.id !== 'string') return;
    const id = entry.id.trim();
    if (!id) return;

    const heading = typeof entry.heading === 'string' ? entry.heading : '';
    const lines = Array.isArray(entry.lines)
      ? entry.lines
          .map((line) => typeof line === 'string' ? line.trim() : '')
          .filter((line) => line.length > 0)
      : [];

    infoMap.set(id, { heading, lines });
  });
  return infoMap;
}

// Helper: Set up a model for solo mode (scale, center, optional random rotation)
export function setupModelForSoloMode(model, applyRandomRotation = false) {
  if (!model || !model.object) return;

  const innerObj = model.object.userData.innerObject;

  // Scale up for solo mode
  if (innerObj && model.object.userData.baseScale) {
    const soloScale = model.object.userData.baseScale * (SOLO_MODEL_SIZE / GRID_MODEL_SIZE);
    innerObj.scale.setScalar(soloScale);
  }

  // Center dynamically using bounding box
  model.object.position.set(0, 0, 0);
  model.object.updateMatrixWorld(true);
  const bbox = new THREE.Box3().setFromObject(model.object);
  const center = new THREE.Vector3();
  bbox.getCenter(center);
  model.object.position.x = -center.x;
  model.object.position.y = -center.y;

  // Apply random rotation if requested
  if (applyRandomRotation && innerObj) {
    innerObj.rotation.x = (Math.random() - 0.5) * Math.PI * 0.8;
    innerObj.rotation.y = (Math.random() - 0.5) * Math.PI * 2;
    innerObj.rotation.z = (Math.random() - 0.5) * Math.PI * 0.3;
    model.object.userData.isTransitioning = true;
  }
}

// Setup a model for mobile solo mode display
export function setupModelForMobileSolo(model) {
  if (!model || !model.object) return;

  const config = getGridConfig();
  const innerObj = model.object.userData.innerObject;

  if (!innerObj) return;

  // Reset rotation to base immediately (no random rotation on mobile)
  const baseRotationY = model.object.userData.baseRotationY || 0;
  const baseRotationX = model.object.userData.baseRotationX || 0;
  innerObj.rotation.set(baseRotationX, baseRotationY, 0);

  // Scale for mobile solo size
  if (model.object.userData.baseScale) {
    const mobileScale = model.object.userData.baseScale * (config.modelSize / GRID_MODEL_SIZE);
    innerObj.scale.setScalar(mobileScale);
  }

  // Center the model - reset position first
  model.object.position.set(0, 0, 0);
  model.object.updateMatrixWorld(true);
  const bbox = new THREE.Box3().setFromObject(model.object);
  const center = new THREE.Vector3();
  bbox.getCenter(center);
  model.object.position.x = -center.x;
  model.object.position.y = -center.y;
}

// Switch to different model
export function switchToModel(index) {
  state.currentModelIndex = index;

  // Reset touch drag rotation when switching models
  touchState.dragRotationX = 0;
  touchState.dragRotationY = 0;
  touchState.dragTargetX = 0;
  touchState.dragTargetY = 0;

  if (!state.isGridMode) {
    sceneModels.forEach((model, i) => {
      if (model && model.object) {
        model.object.visible = (i === index);
        if (i === index) {
          // No random rotation when cycling - smooth transition only
          setupModelForSoloMode(model, false);
        }
      }
    });
    syncSnowVisibility();
  }

  if (updateModelInfoDisplayFunc) updateModelInfoDisplayFunc();
  if (updateModelListActiveStateFunc) updateModelListActiveStateFunc();
}

// Switch to a specific model in mobile solo mode
export function switchToMobileModel(index) {
  state.mobileCurrentModelIndex = index;
  state.currentModelIndex = index;

  // Hide all models first
  sceneModels.forEach((model) => {
    if (model && model.object) {
      model.object.visible = false;
    }
  });

  // Setup and show only the selected model
  const targetModel = sceneModels[index];
  if (targetModel && targetModel.object) {
    setupModelForMobileSolo(targetModel);
    targetModel.object.visible = true;
  }

  if (updateModelInfoDisplayFunc) updateModelInfoDisplayFunc();
  syncSnowVisibility();
}

// Update mode icon visibility
export function updateModeIcon() {
  if (!gridModeIcon) return;
  if (state.isGridMode) {
    gridModeIcon.classList.add('hidden');
  } else {
    gridModeIcon.classList.remove('hidden');
  }
}

// Toggle between grid and solo mode
export function toggleMode() {
  state.isGridMode = !state.isGridMode;
  const config = getGridConfig();

  if (state.isGridMode) {
    // GRID MODE - show all models in grid positions, scale down
    // Pre-blur menu items immediately to prevent flash
    if (modelListItems) {
      const items = modelListItems.querySelectorAll('.model-list-item');
      items.forEach(item => item.classList.add('blurring-out'));
    }

    sceneModels.forEach((model, index) => {
      if (model && model.object) {
        model.object.visible = true;
        const pos = getGridPosition(index);
        model.object.position.set(pos.x, pos.y, 0);

        const innerObj = model.object.userData.innerObject;
        if (innerObj && model.object.userData.baseScale) {
          const gridScale = model.object.userData.baseScale * (config.modelSize / GRID_MODEL_SIZE);
          innerObj.scale.setScalar(gridScale);
        }
      }
    });
  } else {
    // SOLO MODE - show only current model
    // Reset camera to origin (important for mobile where camera follows scroll)
    camera.position.y = 0;

    sceneModels.forEach((model, i) => {
      if (model && model.object) {
        model.object.visible = (i === state.currentModelIndex);
        if (i === state.currentModelIndex) {
          setupModelForSoloMode(model, false);
        }
      }
    });
  }

  updateModeIcon();
  if (updateModelInfoDisplayFunc) updateModelInfoDisplayFunc();
  if (updateHeaderVisibilityFunc) updateHeaderVisibilityFunc();
  if (updateModelListVisibilityFunc) updateModelListVisibilityFunc();
  syncSnowVisibility();
}

// Update grid layout
export function updateGridLayout() {
  const config = getGridConfig();

  sceneModels.forEach((entry, index) => {
    if (!entry || !entry.object) return;

    const pos = getGridPosition(index);
    entry.object.position.set(pos.x, pos.y, 0);

    // Update model scale based on current config
    const innerObj = entry.object.userData.innerObject;
    if (innerObj && entry.object.userData.baseScale) {
      const baseScale = entry.object.userData.baseScale;
      const targetScale = baseScale * (config.modelSize / GRID_MODEL_SIZE);
      innerObj.scale.setScalar(targetScale);
    }
  });
}
