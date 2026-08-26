import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const PIECES = ['queen', 'king'];
const canvas = document.getElementById('chessCanvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 4000);
camera.position.set(0, 0, 1200);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();
scene.add(new THREE.HemisphereLight(0xffffff, 0x686868, 1.15));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
keyLight.position.set(-450, 650, 900);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0xbec8ff, 1.25);
rimLight.position.set(650, 100, -500);
scene.add(rimLight);

const material = new THREE.MeshPhysicalMaterial({
  color: 0x5e00ff,
  roughness: 0.32,
  metalness: 0,
  clearcoat: 0.7,
  clearcoatRoughness: 0.2,
  envMapIntensity: 1.15,
});

const models = {};
let activeShape = null;
let lastWidth = 0;
let lastHeight = 0;

function resize() {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(2, Math.round(rect.width));
  const height = Math.max(2, Math.round(rect.height));
  if (width === lastWidth && height === lastHeight) return;
  lastWidth = width;
  lastHeight = height;
  renderer.setSize(width, height, false);
  camera.left = -width / 2;
  camera.right = width / 2;
  camera.top = height / 2;
  camera.bottom = -height / 2;
  camera.updateProjectionMatrix();
}

function preparePiece(source, name) {
  const piece = source.clone(true);
  piece.position.set(0, 0, 0); // remove the six-piece lineup offset stored in the GLB
  piece.rotation.set(0, 0, 0);
  piece.scale.set(1, 1, 1);
  piece.updateMatrixWorld(true);

  const initialBox = new THREE.Box3().setFromObject(piece);
  const center = initialBox.getCenter(new THREE.Vector3());
  piece.position.sub(center);

  const root = new THREE.Group();
  root.name = `${name}-avatar-model`;
  root.add(piece);
  root.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());

  root.traverse(child => {
    if (!child.isMesh) return;
    child.material = material;
    child.frustumCulled = false;
  });
  root.visible = false;
  scene.add(root);
  models[name] = { root, size };
}

function updateMaterial(colors, surface) {
  const primary = colors?.[0] || '#5e00ff';
  const secondary = colors?.[1] || primary;
  material.color.set(primary);
  material.emissive.set(secondary);
  material.emissiveIntensity = surface === 'orb' ? 0.075 : 0.015;
  material.roughness = surface === 'orb' ? 0.3 : 0.7;
  material.clearcoat = surface === 'orb' ? 0.75 : 0.08;
  material.needsUpdate = true;
}

const api = {
  ready: false,
  error: null,
  hide() {
    canvas.style.display = 'none';
    if (activeShape && models[activeShape]) models[activeShape].root.visible = false;
    activeShape = null;
  },
  render({ shape, width, height, depth, rotation, colors, surface }) {
    const model = models[shape];
    if (!api.ready || !model) return false;
    resize();
    if (activeShape !== shape) {
      if (activeShape && models[activeShape]) models[activeShape].root.visible = false;
      activeShape = shape;
      model.root.visible = true;
    }
    canvas.style.display = 'block';
    model.root.scale.set(
      width / Math.max(model.size.x, 0.001),
      height / Math.max(model.size.y, 0.001),
      depth / Math.max(model.size.z, 0.001),
    );
    model.root.rotation.order = 'XYZ';
    model.root.rotation.set(
      THREE.MathUtils.degToRad(rotation.x),
      THREE.MathUtils.degToRad(rotation.y),
      THREE.MathUtils.degToRad(rotation.z),
    );
    updateMaterial(colors, surface);
    renderer.render(scene, camera);
    return true;
  },
};

window.CHESS3D = api;

new GLTFLoader().load(
  'chess-pieces (1).glb',
  gltf => {
    for (const name of PIECES) {
      const source = gltf.scene.getObjectByName(name);
      if (source) preparePiece(source, name);
    }
    api.ready = PIECES.every(name => models[name]);
    if (!api.ready) api.error = 'The GLB did not contain the named queen and king pieces.';
  },
  undefined,
  error => {
    api.error = error?.message || String(error);
    console.error('Unable to load chess-pieces (1).glb', error);
  },
);
