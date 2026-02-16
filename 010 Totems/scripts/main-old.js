import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { models } from './models.js';

const container = document.querySelector('#scene-container');

// Display configuration - single large view with thumbnail nav
let currentModelIndex = 0; // Currently displayed model
const mainModel = { object: null }; // The large display model
const thumbnailModels = []; // Small preview models

// Scene setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf5f5f0);

// Camera - Orthographic to avoid lens distortion
const aspect = window.innerWidth / window.innerHeight;
const frustumSize = 12;
const camera = new THREE.OrthographicCamera(
  frustumSize * aspect / -2,
  frustumSize * aspect / 2,
  frustumSize / 2,
  frustumSize / -2,
  0.1,
  100
);
camera.position.set(0, 0, 10);
camera.zoom = 1;

// Renderer
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

// Lighting - studio setup with enhanced reflections
const ambient = new THREE.AmbientLight(0xffffff, 1.4);
scene.add(ambient);

const hemiLight = new THREE.HemisphereLight(0xffffff, 0xcccccc, 0.8);
scene.add(hemiLight);

const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
keyLight.position.set(8, 10, 6);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xffffff, 1.3);
fillLight.position.set(-6, 5, 5);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xffffff, 0.9);
rimLight.position.set(0, 3, -8);
scene.add(rimLight);

// Mouse tracking for rotation
const mouse = new THREE.Vector2();
let mouseIsMoving = false;
let mouseIdleTimer = null;
const raycaster = new THREE.Raycaster();

function updateMousePosition(event) {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  // Mark mouse as moving
  mouseIsMoving = true;
  clearTimeout(mouseIdleTimer);
  mouseIdleTimer = setTimeout(() => {
    mouseIsMoving = false;
  }, 3000);
}

// Click handler for thumbnails
function onThumbnailClick(event) {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);

  // Check if clicked on a thumbnail
  const thumbnailObjects = thumbnailModels.map(t => t.object).filter(o => o);
  const intersects = raycaster.intersectObjects(thumbnailObjects, true);

  if (intersects.length > 0) {
    let clickedObject = intersects[0].object;

    // Find the parent group
    while (clickedObject.parent && !thumbnailModels.some(t => t.object === clickedObject)) {
      clickedObject = clickedObject.parent;
    }

    // Find which thumbnail was clicked
    const clickedIndex = thumbnailModels.findIndex(t => t.object === clickedObject);
    if (clickedIndex !== -1 && clickedIndex !== currentModelIndex) {
      switchToModel(clickedIndex);
    }
  }
}

// Switch to a different model
function switchToModel(index) {
  currentModelIndex = index;

  // Hide current main model
  if (mainModel.object) {
    mainModel.object.visible = false;
  }

  // Show new main model
  const newMainObject = scene.getObjectByProperty('userData', { isMainModel: true, modelIndex: index });
  if (newMainObject) {
    mainModel.object = newMainObject;
    newMainObject.visible = true;
  }

  // Update thumbnail highlights
  updateThumbnailHighlights();
}

// Update which thumbnail is highlighted
function updateThumbnailHighlights() {
  thumbnailModels.forEach((thumb, index) => {
    if (thumb.object) {
      const opacity = index === currentModelIndex ? 1.0 : 0.5;
      thumb.object.traverse((child) => {
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(mat => mat.opacity = opacity);
          } else {
            child.material.opacity = opacity;
          }
        }
      });
    }
  });
}

window.addEventListener('mousemove', updateMousePosition);
window.addEventListener('click', onThumbnailClick);

// Keyboard controls for navigation
window.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft') {
    const newIndex = (currentModelIndex - 1 + models.length) % models.length;
    switchToModel(newIndex);
  } else if (event.key === 'ArrowRight') {
    const newIndex = (currentModelIndex + 1) % models.length;
    switchToModel(newIndex);
  }
});

// Loading tracking
let modelsLoaded = 0;
let filesLoaded = 0;
let totalFilesToLoad = models.length * 2; // Each model has OBJ + MTL
const loadingScreen = document.getElementById('loading-screen');
const loadingBar = document.getElementById('loading-bar');

function updateLoadingProgress() {
  const fileProgress = totalFilesToLoad > 0 ? (filesLoaded / totalFilesToLoad) * 100 : 0;
  if (loadingBar) {
    loadingBar.style.width = `${Math.min(fileProgress, 100)}%`;
  }
}

updateLoadingProgress();

// Check if all models are loaded
function checkLoadingComplete() {
  modelsLoaded++;

  if (modelsLoaded >= models.length) {
    console.log('All models loaded!');
    setTimeout(() => {
      loadingScreen.classList.add('hidden');
      updateThumbnailHighlights();
    }, 500);
  }
}

// Physics system
const GRAVITY = -3.5; // Even lighter gravity for slow-mo float
const DAMPING = 0.994; // Very low damping for smooth, sustained movement
const BOUNCE = 0.35;
const ANGULAR_DAMPING = 0.88; // Strong damping for soft, slow rotation
const MAX_ANGULAR_VELOCITY = 4; // Much slower maximum spin speed
const Z_CONSTRAINT = 1.5; // Narrow Z-axis container

// Wind turbulence settings - layered for organic movement
const TURBULENCE_ENABLED = true;
const TURBULENCE_BASE = 10.0; // Gentler wind strength for slow-mo
const TURBULENCE_FREQ_1 = 0.4; // Slower large wind patterns
const TURBULENCE_FREQ_2 = 0.9; // Slower medium gusts
const TURBULENCE_FREQ_3 = 1.8; // Slower small eddies
const VORTEX_STRENGTH = 5.0; // Gentler swirling
const UPWARD_LIFT = 6.0; // Gentler upward force

function initializePhysics() {
  // Initialize physics data for each object
  gridCells.forEach((cell) => {
    if (!cell.object) return;

    const bboxSize = cell.object.userData.boundingBoxSize;
    const collisionRadius = Math.max(bboxSize.x, bboxSize.y, bboxSize.z) * 0.5;

    cell.object.userData.physics = {
      velocity: new THREE.Vector3(
        (Math.random() - 0.5) * 4, // Gentle initial horizontal velocity
        Math.random() * 6 + 3, // Gentle upward velocity
        (Math.random() - 0.5) * 2
      ),
      angularVelocity: new THREE.Vector3(
        (Math.random() - 0.5) * 0.5, // Very slow initial spin
        (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 0.5
      ),
      radius: collisionRadius, // Use actual geometry size
      halfExtents: bboxSize.clone().multiplyScalar(0.5), // Box collision half-extents
      mass: 1.0 // Lighter for more floating
    };
  });
}

function resetToGrid() {
  // Smoothly return all objects to their grid positions (same as R key)
  gridCells.forEach((cell) => {
    if (!cell.object) return;

    const obj = cell.object;

    // Set up smooth return animation
    obj.userData.smoothReturning = true;
    obj.userData.gridTarget = new THREE.Vector3(cell.centerX, cell.centerY, 0);

    // If physics exists, slow down velocities for smooth transition
    if (obj.userData.physics) {
      obj.userData.physics.velocity.multiplyScalar(0.2);
      obj.userData.physics.angularVelocity.multiplyScalar(0.2);
    }

    // Clear other return flags
    obj.userData.returningToGrid = false;
  });

  console.log('Resetting objects to grid...');
}

function updatePhysics(delta) {
  // Calculate viewport bounds from orthographic camera
  const bounds = {
    minX: camera.left * 0.95,   // 95% of viewport to keep objects visible at edges
    maxX: camera.right * 0.95,
    minY: camera.bottom * 0.95,
    maxY: camera.top * 0.95,
    minZ: -Z_CONSTRAINT,
    maxZ: Z_CONSTRAINT
  };

  const time = performance.now() * 0.001; // Time in seconds

  gridCells.forEach((cell, index) => {
    if (!cell.object || !cell.object.userData.physics) return;

    const obj = cell.object;
    const physics = obj.userData.physics;

    // Skip physics if object is smoothly returning from R key or click reset
    if (obj.userData.smoothReturning) return;

    // Apply gravity
    physics.velocity.y += GRAVITY * delta;

    // Apply constant upward lift to keep objects floating
    physics.velocity.y += UPWARD_LIFT * delta;

    // Apply organic wind turbulence - layered noise at multiple frequencies
    if (TURBULENCE_ENABLED) {
      const pos = obj.position;

      // Layer 1: Large slow wind patterns (like prevailing wind)
      const noise1X = Math.sin(time * TURBULENCE_FREQ_1 + pos.x * 0.2 + index * 0.7) *
                      Math.cos(time * TURBULENCE_FREQ_1 * 0.7 + pos.y * 0.15 + index * 0.3);
      const noise1Y = Math.sin(time * TURBULENCE_FREQ_1 * 0.6 + pos.y * 0.2 + index * 0.5) *
                      Math.cos(time * TURBULENCE_FREQ_1 * 0.9 + pos.x * 0.15 + index * 0.9);
      const noise1Z = Math.sin(time * TURBULENCE_FREQ_1 * 0.8 + pos.z * 0.3 + index * 1.1) *
                      Math.cos(time * TURBULENCE_FREQ_1 * 0.5 + pos.x * 0.1 + index * 0.4);

      // Layer 2: Medium gusts (chaotic mid-frequency)
      const noise2X = Math.sin(time * TURBULENCE_FREQ_2 + pos.x * 0.5 + index * 1.3) *
                      Math.cos(time * TURBULENCE_FREQ_2 * 1.5 + pos.y * 0.4 + index * 0.8) *
                      Math.sin(time * TURBULENCE_FREQ_2 * 0.4 + pos.z * 0.3);
      const noise2Y = Math.sin(time * TURBULENCE_FREQ_2 * 1.3 + pos.y * 0.5 + index * 0.6) *
                      Math.cos(time * TURBULENCE_FREQ_2 * 0.7 + pos.x * 0.4 + index * 1.7) *
                      Math.sin(time * TURBULENCE_FREQ_2 * 0.9 + pos.z * 0.2);
      const noise2Z = Math.sin(time * TURBULENCE_FREQ_2 * 0.9 + pos.z * 0.6 + index * 2.1) *
                      Math.cos(time * TURBULENCE_FREQ_2 * 1.2 + pos.y * 0.3 + index * 1.4);

      // Layer 3: Small turbulent eddies (high frequency chaos)
      const noise3X = Math.sin(time * TURBULENCE_FREQ_3 + pos.x * 1.2 + index * 2.7) *
                      Math.cos(time * TURBULENCE_FREQ_3 * 2.1 + pos.y * 0.8 + index * 1.9);
      const noise3Y = Math.sin(time * TURBULENCE_FREQ_3 * 1.7 + pos.y * 1.2 + index * 3.3) *
                      Math.cos(time * TURBULENCE_FREQ_3 * 1.4 + pos.x * 0.8 + index * 2.5);
      const noise3Z = Math.sin(time * TURBULENCE_FREQ_3 * 2.3 + pos.z * 1.5 + index * 4.1) *
                      Math.cos(time * TURBULENCE_FREQ_3 * 0.8 + pos.x * 0.9 + index * 3.7);

      // Combine layers with different weights
      const turbX = noise1X * 1.0 + noise2X * 0.6 + noise3X * 0.3;
      const turbY = noise1Y * 1.0 + noise2Y * 0.6 + noise3Y * 0.3;
      const turbZ = noise1Z * 1.0 + noise2Z * 0.6 + noise3Z * 0.3;

      // Add vortex/curl forces for swirling wind patterns
      const vortexX = -pos.y * 0.3 + Math.sin(time * 0.5 + index) * 0.8;
      const vortexY = pos.x * 0.3 + Math.cos(time * 0.6 + index) * 0.8;
      const vortexZ = (Math.sin(pos.x * 0.5 + time) + Math.cos(pos.y * 0.5 + time)) * 0.5;

      // Varying wind intensity over time (breathing wind)
      const windIntensity = 0.7 + Math.sin(time * 0.2) * 0.3 +
                           Math.sin(time * 0.47) * 0.2 +
                           Math.sin(time * 0.83) * 0.15;

      // Strong gusts - more dramatic and random
      const gustPhase = Math.sin(time * 0.3 + index * 0.5) * Math.cos(time * 0.17 + index * 0.3);
      const gustIntensity = Math.max(0, gustPhase) * 2.0;
      const totalIntensity = windIntensity * (1 + gustIntensity);

      // Apply layered turbulence forces
      const turbForceX = (turbX + vortexX * VORTEX_STRENGTH * 0.1) * TURBULENCE_BASE * totalIntensity * delta;
      const turbForceY = (turbY + vortexY * VORTEX_STRENGTH * 0.1) * TURBULENCE_BASE * totalIntensity * delta * 1.2;
      const turbForceZ = (turbZ + vortexZ * VORTEX_STRENGTH * 0.15) * TURBULENCE_BASE * totalIntensity * delta * 0.7;

      physics.velocity.x += turbForceX;
      physics.velocity.y += turbForceY;
      physics.velocity.z += turbForceZ;

      // Add gentle rotational forces from wind - soft, slow tumbling
      const rotTurbX = (noise2Y + noise3Y * 0.5) * 0.4 * totalIntensity * delta;
      const rotTurbY = (noise2X + noise3X * 0.5) * 0.3 * totalIntensity * delta;
      const rotTurbZ = (noise2Z + noise3Z * 0.5 + vortexZ * 0.3) * 0.35 * totalIntensity * delta;

      physics.angularVelocity.x += rotTurbX;
      physics.angularVelocity.y += rotTurbY;
      physics.angularVelocity.z += rotTurbZ;
    }

    // Apply damping
    physics.velocity.multiplyScalar(DAMPING);

    // Update position
    obj.position.x += physics.velocity.x * delta;
    obj.position.y += physics.velocity.y * delta;
    obj.position.z += physics.velocity.z * delta;

    // Apply angular damping
    physics.angularVelocity.multiplyScalar(ANGULAR_DAMPING);

    // Limit angular velocity to prevent wild spinning
    const angularSpeed = physics.angularVelocity.length();
    if (angularSpeed > MAX_ANGULAR_VELOCITY) {
      physics.angularVelocity.multiplyScalar(MAX_ANGULAR_VELOCITY / angularSpeed);
    }

    // Apply angular velocity
    const innerObj = obj.userData.innerObject;
    if (innerObj) {
      innerObj.rotation.x += physics.angularVelocity.x * delta;
      innerObj.rotation.y += physics.angularVelocity.y * delta;
      innerObj.rotation.z += physics.angularVelocity.z * delta;
    }

    // Boundary collisions using actual bounding box dimensions
    const halfExt = physics.halfExtents;

    if (obj.position.x - halfExt.x < bounds.minX) {
      obj.position.x = bounds.minX + halfExt.x;
      physics.velocity.x *= -BOUNCE;
      physics.angularVelocity.z += physics.velocity.y * 0.15;
    }
    if (obj.position.x + halfExt.x > bounds.maxX) {
      obj.position.x = bounds.maxX - halfExt.x;
      physics.velocity.x *= -BOUNCE;
      physics.angularVelocity.z += physics.velocity.y * 0.15;
    }

    if (obj.position.y - halfExt.y < bounds.minY) {
      obj.position.y = bounds.minY + halfExt.y;
      physics.velocity.y *= -BOUNCE;
      physics.angularVelocity.x += physics.velocity.x * 0.1;

      // Add strong friction on ground
      physics.velocity.x *= 0.85;
      physics.velocity.z *= 0.85;
      physics.angularVelocity.multiplyScalar(0.8);
    }
    if (obj.position.y + halfExt.y > bounds.maxY) {
      obj.position.y = bounds.maxY - halfExt.y;
      physics.velocity.y *= -BOUNCE;
    }

    // Z-axis constraints (narrow container)
    if (obj.position.z - halfExt.z < bounds.minZ) {
      obj.position.z = bounds.minZ + halfExt.z;
      physics.velocity.z *= -BOUNCE;
      physics.angularVelocity.x += -physics.velocity.z * 0.15;
    }
    if (obj.position.z + halfExt.z > bounds.maxZ) {
      obj.position.z = bounds.maxZ - halfExt.z;
      physics.velocity.z *= -BOUNCE;
      physics.angularVelocity.x += -physics.velocity.z * 0.15;
    }
  });

  // Object-to-object interactions: repulsion + collision
  for (let i = 0; i < gridCells.length; i++) {
    for (let j = i + 1; j < gridCells.length; j++) {
      const obj1 = gridCells[i].object;
      const obj2 = gridCells[j].object;

      if (!obj1 || !obj2 || !obj1.userData.physics || !obj2.userData.physics) continue;

      // Skip collision if either object is smoothly returning from R key
      if (obj1.userData.smoothReturning || obj2.userData.smoothReturning) continue;

      const physics1 = obj1.userData.physics;
      const physics2 = obj2.userData.physics;
      const halfExt1 = physics1.halfExtents;
      const halfExt2 = physics2.halfExtents;

      // Calculate distance between centers
      const dx = obj2.position.x - obj1.position.x;
      const dy = obj2.position.y - obj1.position.y;
      const dz = obj2.position.z - obj1.position.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

      // AABB collision detection - check overlap on each axis
      const overlapX = (halfExt1.x + halfExt2.x) - Math.abs(dx);
      const overlapY = (halfExt1.y + halfExt2.y) - Math.abs(dy);
      const overlapZ = (halfExt1.z + halfExt2.z) - Math.abs(dz);

      // Soft repulsion field to prevent clumping (activates before actual collision)
      const repulsionDistance = (halfExt1.length() + halfExt2.length()) * 0.9; // Increased from 0.8
      if (distance > 0 && distance < repulsionDistance) {
        const repulsionStrength = 4.5; // Stronger repulsion (was 3.0)
        const repulsionForce = repulsionStrength * (1 - distance / repulsionDistance);

        const nx_soft = dx / distance;
        const ny_soft = dy / distance;
        const nz_soft = dz / distance;

        // Apply stronger soft repulsion to velocities
        physics1.velocity.x -= nx_soft * repulsionForce * delta * 65; // Increased from 50
        physics1.velocity.y -= ny_soft * repulsionForce * delta * 65;
        physics1.velocity.z -= nz_soft * repulsionForce * delta * 65;

        physics2.velocity.x += nx_soft * repulsionForce * delta * 65;
        physics2.velocity.y += ny_soft * repulsionForce * delta * 65;
        physics2.velocity.z += nz_soft * repulsionForce * delta * 65;
      }

      // Hard collision - if actually overlapping
      if (overlapX > 0 && overlapY > 0 && overlapZ > 0) {
        // Find the axis with minimum overlap (that's the collision normal)
        let nx = 0, ny = 0, nz = 0;
        let minOverlap = overlapX;

        if (overlapX < overlapY && overlapX < overlapZ) {
          nx = dx > 0 ? 1 : -1;
          minOverlap = overlapX;
        } else if (overlapY < overlapZ) {
          ny = dy > 0 ? 1 : -1;
          minOverlap = overlapY;
        } else {
          nz = dz > 0 ? 1 : -1;
          minOverlap = overlapZ;
        }

        // MUCH stronger separation to prevent geometry overlap
        // Add extra padding to prevent visual intersection
        const separationPadding = 0.1; // Extra space to prevent overlap
        const separation = (minOverlap + separationPadding) * 0.6; // Increased from 0.55

        obj1.position.x -= nx * separation;
        obj1.position.y -= ny * separation;
        obj1.position.z -= nz * separation;

        obj2.position.x += nx * separation;
        obj2.position.y += ny * separation;
        obj2.position.z += nz * separation;

        // Calculate relative velocity
        const relVelX = physics1.velocity.x - physics2.velocity.x;
        const relVelY = physics1.velocity.y - physics2.velocity.y;
        const relVelZ = physics1.velocity.z - physics2.velocity.z;

        const velAlongNormal = relVelX * nx + relVelY * ny + relVelZ * nz;

        // Always apply strong separation impulse
        const restitution = BOUNCE * 1.4; // More bouncy to prevent overlap (was 1.2)
        const impulse = -(1 + restitution) * velAlongNormal / (physics1.mass + physics2.mass);

        physics1.velocity.x += impulse * physics2.mass * nx;
        physics1.velocity.y += impulse * physics2.mass * ny;
        physics1.velocity.z += impulse * physics2.mass * nz;

        physics2.velocity.x -= impulse * physics1.mass * nx;
        physics2.velocity.y -= impulse * physics1.mass * ny;
        physics2.velocity.z -= impulse * physics1.mass * nz;

        // Add extra push away force to actively separate overlapping objects
        const pushForce = minOverlap * 15.0; // Strong push proportional to overlap
        physics1.velocity.x -= nx * pushForce;
        physics1.velocity.y -= ny * pushForce;
        physics1.velocity.z -= nz * pushForce;

        physics2.velocity.x += nx * pushForce;
        physics2.velocity.y += ny * pushForce;
        physics2.velocity.z += nz * pushForce;

        // Add gentle rotational effects for soft collisions
        physics1.angularVelocity.x += ny * 0.15 + (Math.random() - 0.5) * 0.1;
        physics1.angularVelocity.y += nz * 0.15 + (Math.random() - 0.5) * 0.1;
        physics1.angularVelocity.z += nx * 0.15 + (Math.random() - 0.5) * 0.1;
        physics2.angularVelocity.x -= ny * 0.15 + (Math.random() - 0.5) * 0.1;
        physics2.angularVelocity.y -= nz * 0.15 + (Math.random() - 0.5) * 0.1;
        physics2.angularVelocity.z -= nx * 0.15 + (Math.random() - 0.5) * 0.1;

        // Add a larger random push to break symmetry and prevent locked states
        const breakSymmetry = 0.8; // Increased from 0.5
        physics1.velocity.x += (Math.random() - 0.5) * breakSymmetry;
        physics1.velocity.y += (Math.random() - 0.5) * breakSymmetry;
        physics1.velocity.z += (Math.random() - 0.5) * breakSymmetry;
        physics2.velocity.x += (Math.random() - 0.5) * breakSymmetry;
        physics2.velocity.y += (Math.random() - 0.5) * breakSymmetry;
        physics2.velocity.z += (Math.random() - 0.5) * breakSymmetry;
      }
    }
  }
}

// Load models into grid cells
let loadedModelIndex = 0;
const modelCache = [];

function loadModel(modelConfig, cellIndex) {
  const objLoader = new OBJLoader();
  const manager = new THREE.LoadingManager();

  // Track loading progress
  manager.onProgress = (url, itemsLoaded, itemsTotal) => {
    totalTextures = Math.max(totalTextures, itemsTotal);
    texturesLoaded = itemsLoaded;
    updateLoadingProgress();
    console.log(`Loading: ${url} (${itemsLoaded}/${itemsTotal})`);
  };

  const { basePath: objBasePath, fileName: objFileName } = splitPath(modelConfig.obj);
  if (objBasePath) {
    objLoader.setPath(objBasePath);
    objLoader.setResourcePath(objBasePath);
  }

  const applyObject = (object3d) => {
    // Setup materials
    object3d.traverse((child) => {
      if (child.isMesh) {
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => {
          if (!material) return;
          material.flatShading = false;

          // Make materials shiny
          if (material.roughness !== undefined) {
            material.roughness *= 0.3;
          }
          if (material.metalness !== undefined) {
            material.metalness = Math.max(material.metalness, 0.6);
          }

          // Check if textures loaded
          if (material.map) {
            console.log('Texture loaded:', material.map.image?.src || 'loading...');
          } else {
            console.warn('No diffuse texture on material');
          }

          material.needsUpdate = true;
        });
      }
    });

    // First pass: calculate initial bounding box for scaling
    const initialBBox = new THREE.Box3().setFromObject(object3d);
    const initialSize = new THREE.Vector3();
    initialBBox.getSize(initialSize);
    const initialCenter = new THREE.Vector3();
    initialBBox.getCenter(initialCenter);

    // Center the object at origin based on initial bounding box
    object3d.position.sub(initialCenter);

    // Scale the object - much bigger for horizontal layout
    const maxDimension = Math.max(initialSize.x, initialSize.y, initialSize.z) || 1;
    const desiredSize = 8.0; // Increased from 3.2 for bigger models
    const computedScale = desiredSize / maxDimension;
    const manualScale = typeof modelConfig.scale === 'number' ? modelConfig.scale : 1;
    object3d.scale.multiplyScalar(computedScale * manualScale);

    // Second pass: recalculate bounding box after scaling to ensure perfect centering
    object3d.updateMatrixWorld(true);
    const scaledBBox = new THREE.Box3().setFromObject(object3d);
    const scaledCenter = new THREE.Vector3();
    scaledBBox.getCenter(scaledCenter);

    // Fine-tune centering after scaling
    object3d.position.sub(scaledCenter);

    // Create a group for positioning
    const group = new THREE.Group();
    group.add(object3d);

    const cell = gridCells[cellIndex];
    group.position.set(cell.centerX, cell.centerY, 0);

    // Store final bounding box info for collision detection
    group.updateMatrixWorld(true);
    const finalBBox = new THREE.Box3().setFromObject(object3d);
    const bboxSize = new THREE.Vector3();
    finalBBox.getSize(bboxSize);

    group.userData.cellIndex = cellIndex;
    group.userData.baseX = cell.centerX;
    group.userData.baseY = cell.centerY;
    group.userData.modelConfig = modelConfig;
    group.userData.innerObject = object3d;
    group.userData.boundingBox = finalBBox;
    group.userData.boundingBoxSize = bboxSize;

    scene.add(group);
    cell.object = group;

    // Store for cloning
    if (!modelCache.some(m => m.config === modelConfig)) {
      modelCache.push({ config: modelConfig, template: object3d.clone() });
    }

    // Track loading progress
    checkLoadingComplete();
  };

  const loadObj = () => {
    objLoader.load(
      objBasePath ? objFileName : modelConfig.obj,
      (object) => {
        filesLoaded++; // Count OBJ as loaded
        updateLoadingProgress();
        applyObject(object);
      },
      (xhr) => {
        // Track OBJ loading progress
        if (xhr.lengthComputable) {
          const percentComplete = xhr.loaded / xhr.total;
          console.log(`OBJ ${Math.round(percentComplete * 100)}% loaded`);
        }
      },
      (error) => {
        console.error('Error loading model', error);
        filesLoaded++; // Count as loaded even on error to prevent stuck loading bar
        updateLoadingProgress();
      }
    );
  };

  if (modelConfig.mtl) {
    const { basePath: mtlBasePath, fileName: mtlFileName } = splitPath(modelConfig.mtl);
    const mtlLoader = new MTLLoader(manager);
    if (mtlBasePath) {
      mtlLoader.setPath(mtlBasePath);
      mtlLoader.setResourcePath(mtlBasePath);
    }

    console.log(`Loading MTL: ${modelConfig.mtl} | Path: ${mtlBasePath} | File: ${mtlFileName}`);

    mtlLoader.load(
      mtlBasePath ? mtlFileName : modelConfig.mtl,
      (materials) => {
        console.log(`MTL loaded for ${modelConfig.title}`);
        filesLoaded++; // Count MTL as loaded
        updateLoadingProgress();
        materials.preload();
        objLoader.setMaterials(materials);
        loadObj();
      },
      (xhr) => {
        // Track MTL loading progress
        if (xhr.lengthComputable) {
          const percentComplete = xhr.loaded / xhr.total;
          console.log(`MTL ${Math.round(percentComplete * 100)}% loaded`);
        }
      },
      (error) => {
        console.error(`Failed to load MTL for ${modelConfig.title}:`, error);
        filesLoaded++; // Count as loaded even on error
        updateLoadingProgress();
        loadObj();
      }
    );
  } else {
    loadObj();
  }
}

// Fill grid with models (repeat models to fill all cells)
gridCells.forEach((cell, index) => {
  const modelIndex = index % models.length;
  loadModel(models[modelIndex], index);
});

// Animation loop
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();
  const time = clock.getElapsedTime();

  // Handle smooth return from R key press (runs in all modes)
  gridCells.forEach((cell) => {
    if (!cell.object || !cell.object.userData.smoothReturning) return;

    const obj = cell.object;
    const innerObj = obj.userData.innerObject;
    const target = obj.userData.gridTarget;

    const dist = obj.position.distanceTo(target);
    const rotationMagnitude = innerObj ?
      Math.abs(innerObj.rotation.x) + Math.abs(innerObj.rotation.y) + Math.abs(innerObj.rotation.z) : 0;

    if (dist < 0.01 && rotationMagnitude < 0.01) {
      // Finished returning - snap to final position
      obj.position.copy(target);
      if (innerObj) {
        innerObj.rotation.set(0, 0, 0);
      }
      obj.userData.smoothReturning = false;

      // Clear physics if it exists
      if (obj.userData.physics) {
        obj.userData.physics.velocity.set(0, 0, 0);
        obj.userData.physics.angularVelocity.set(0, 0, 0);
      }
    } else {
      // Slowly drift to target position - very gentle lerp
      const driftSpeed = 0.03; // Reduced from 0.08 for slower, more organic drift
      obj.position.x = THREE.MathUtils.lerp(obj.position.x, target.x, driftSpeed);
      obj.position.y = THREE.MathUtils.lerp(obj.position.y, target.y, driftSpeed);
      obj.position.z = THREE.MathUtils.lerp(obj.position.z, target.z, driftSpeed);

      // Slowly reset rotation - very gentle
      const rotationDamping = 0.94; // Slower rotation reset (was 0.9)
      if (innerObj) {
        innerObj.rotation.x *= rotationDamping;
        innerObj.rotation.y *= rotationDamping;
        innerObj.rotation.z *= rotationDamping;
      }
    }
  });

  // Update based on mode
  if (interactionMode === 'physics') {
    // Physics mode - objects fall and collide
    updatePhysics(delta);
  } else {
    // Look mode - objects rotate to follow mouse with distance-based intensity
    // Convert mouse coordinates to world space for distance calculation
    const mouseWorldX = mouse.x * (camera.right - camera.left) / 2;
    const mouseWorldY = mouse.y * (camera.top - camera.bottom) / 2;

    gridCells.forEach((cell) => {
      if (!cell.object) return;

      const obj = cell.object;
      const innerObj = obj.userData.innerObject;

      // Skip look interaction if object is smoothly returning (let it finish drifting)
      if (obj.userData.smoothReturning) return;

      // Keep objects in fixed positions
      obj.position.x = obj.userData.baseX;
      obj.position.y = obj.userData.baseY;
      obj.position.z = 0;

      if (mouseIsMoving) {
        // Calculate distance from mouse to object
        const dx = obj.position.x - mouseWorldX;
        const dy = obj.position.y - mouseWorldY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        // Distance-based intensity: closer = stronger rotation
        const maxDistance = 15.0; // Objects beyond this distance have minimal rotation
        const minIntensity = 0.2; // Minimum rotation intensity (20%)
        const maxIntensity = 1.0; // Maximum rotation intensity (100%)

        // Calculate intensity based on distance (inverse relationship)
        const distanceFactor = Math.max(0, 1 - distance / maxDistance);
        const rotationIntensity = minIntensity + (maxIntensity - minIntensity) * distanceFactor;

        // Base sensitivities modulated by distance
        const sensitivityX = 0.3 * rotationIntensity;
        const sensitivityY = 1.5 * rotationIntensity;
        const sensitivityZ = 0.3 * rotationIntensity;

        // Map mouse position to rotation
        const targetRotationX = -mouse.y * Math.PI * sensitivityX;
        const targetRotationY = mouse.x * Math.PI * sensitivityY;
        const targetRotationZ = mouse.x * Math.PI * sensitivityZ;

        // Store current rotation
        const currentRotation = innerObj.rotation;

        // Smooth interpolation - also affected by distance for more responsive close objects
        const lerpFactor = 0.15 + 0.1 * rotationIntensity; // 0.15-0.25 range

        innerObj.rotation.x = THREE.MathUtils.lerp(currentRotation.x, targetRotationX, lerpFactor);
        innerObj.rotation.y = THREE.MathUtils.lerp(currentRotation.y, targetRotationY, lerpFactor);
        innerObj.rotation.z = THREE.MathUtils.lerp(currentRotation.z, targetRotationZ, lerpFactor);
      } else {
        // When mouse stops, gradually return to neutral rotation
        innerObj.rotation.x *= 0.95;
        innerObj.rotation.y *= 0.95;
        innerObj.rotation.z *= 0.95;
      }
    });
  }

  renderer.render(scene, camera);
}

animate();

// Handle window resize
window.addEventListener('resize', () => {
  const aspect = window.innerWidth / window.innerHeight;
  camera.left = frustumSize * aspect / -2;
  camera.right = frustumSize * aspect / 2;
  camera.top = frustumSize / 2;
  camera.bottom = frustumSize / -2;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Helper function
function splitPath(path) {
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash === -1) {
    return { basePath: '', fileName: path };
  }
  return {
    basePath: path.slice(0, lastSlash + 1),
    fileName: path.slice(lastSlash + 1),
  };
}
