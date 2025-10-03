import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// Scene setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.z = 30;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Cap at 2x for performance
document.body.appendChild(renderer.domElement);

// Post-processing for bloom glow
const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.8,  // Bloom strength - reduced for less intense glow
    0.6,  // Radius - tighter glow
    0.4   // Threshold - only brightest things glow
);
composer.addPass(bloomPass);

// Thickness control
let boltThickness = 0.5; // Default thickness multiplier (50%)

// Lightning system
class Lightning {
    constructor(startPoint, scene, endPoint = null, isExplosion = false) {
        this.startPoint = startPoint;
        this.endPoint = endPoint;
        this.scene = scene;
        this.isExplosion = isExplosion;
        this.segments = [];
        this.progress = 0;
        this.maxProgress = 1;
        this.speed = isExplosion ? 0.012 : 0.008; // Explosions grow faster
        this.branches = [];
        this.lights = [];
        this.fadeProgress = 0; // Track fade from start
        this.fadeSpeed = isExplosion ? 0.015 : 0.01; // Much faster fadeout
        this.peakTime = 0; // Track time at peak
        this.flowOffset = Math.random() * 1000; // Random flow animation offset

        this.generatePath();
        this.createGeometry();
    }

    generatePath() {
        // Generate 3D Lichtenberg figure using recursive fractal branching
        this.generateLichtenbergBranches(this.startPoint, null, 0, 1.0);
    }

    // Recursive Lichtenberg fractal branching in 3D
    generateLichtenbergBranches(start, parentDirection, depth, scale) {
        const maxDepth = 4; // Same depth for both
        if (depth > maxDepth) return;

        const branch = [];

        // Determine main direction
        let mainDirection;
        if (depth === 0) {
            if (this.isExplosion) {
                // Explosions spread radially in all directions
                const angle = Math.random() * Math.PI * 2;
                const verticalAngle = (Math.random() - 0.3) * Math.PI; // More vertical spread
                mainDirection = new THREE.Vector3(
                    Math.cos(angle) * Math.cos(verticalAngle),
                    Math.sin(verticalAngle),
                    Math.sin(angle) * Math.cos(verticalAngle)
                ).normalize();
            } else {
                // First branch goes downward with random horizontal component
                const angle = Math.random() * Math.PI * 2;
                mainDirection = new THREE.Vector3(
                    Math.cos(angle) * 0.6,
                    -1.0,
                    Math.sin(angle) * 0.6
                ).normalize();
            }
        } else {
            // Continue in parent direction with variation
            mainDirection = parentDirection.clone();
            const deviationScale = this.isExplosion ? 2.5 : 2.0;
            const deviation = new THREE.Vector3(
                (Math.random() - 0.5) * deviationScale,
                (Math.random() - 0.5) * deviationScale - (this.isExplosion ? 0.2 : 0.4),
                (Math.random() - 0.5) * deviationScale
            );
            mainDirection.add(deviation).normalize();
        }

        // Create main segment - moderate length for explosions
        const lengthMultiplier = this.isExplosion ? 1.4 : 1.0;
        const segmentLength = (20 + Math.random() * 15) * scale * lengthMultiplier;
        const numSteps = this.isExplosion ? 8 + Math.floor(Math.random() * 5) : 10 + Math.floor(Math.random() * 8);

        let current = start.clone();
        const pathPoints = [current.clone()];

        for (let i = 0; i < numSteps; i++) {
            const stepSize = segmentLength / numSteps;

            // Add fractal variation at each step
            const variation = new THREE.Vector3(
                (Math.random() - 0.5) * 1.5,
                (Math.random() - 0.5) * 1.5,
                (Math.random() - 0.5) * 1.5
            );

            const stepDirection = mainDirection.clone().add(variation.multiplyScalar(0.4)).normalize();
            current = current.clone().add(stepDirection.multiplyScalar(stepSize));
            pathPoints.push(current.clone());
        }

        // Convert to segments with tapering
        const baseWidth = 0.1 * Math.pow(0.75, depth);
        for (let i = 0; i < pathPoints.length - 1; i++) {
            const taper = 1 - (i / pathPoints.length) * 0.4;
            branch.push({
                start: pathPoints[i],
                end: pathPoints[i + 1],
                width: baseWidth * taper,
                depth: depth
            });
        }

        this.branches.push(branch);

        // Generate child branches - spread evenly along the path, not clumped
        if (depth < maxDepth) {
            // Optimized branching for explosions
            let numChildren;
            if (this.isExplosion) {
                numChildren = depth === 0 ? 6 + Math.floor(Math.random() * 3) :
                             depth === 1 ? 3 + Math.floor(Math.random() * 2) :
                             2 + Math.floor(Math.random() * 2);
            } else {
                numChildren = depth === 0 ? 4 + Math.floor(Math.random() * 3) : 3 + Math.floor(Math.random() * 2);
            }

            for (let c = 0; c < numChildren; c++) {
                // Space branches evenly along the path (not random)
                const branchPointIndex = Math.floor(((c + 1) / (numChildren + 1)) * (pathPoints.length - 2)) + 1;
                const branchPoint = pathPoints[branchPointIndex];

                // Calculate branch angle - wider angle range for more dramatic splits
                const branchAngle = (40 + Math.random() * 50) * Math.PI / 180;

                // Create perpendicular direction in 3D space
                const perpendicular = new THREE.Vector3(
                    (Math.random() - 0.5) * 2,
                    (Math.random() - 0.5) * 1.5,
                    (Math.random() - 0.5) * 2
                ).normalize();

                // Mix parent direction with perpendicular for wide branching
                const branchDir = mainDirection.clone()
                    .multiplyScalar(Math.cos(branchAngle))
                    .add(perpendicular.multiplyScalar(Math.sin(branchAngle)))
                    .normalize();

                // Recursively generate child branch
                this.generateLichtenbergBranches(
                    branchPoint,
                    branchDir,
                    depth + 1,
                    scale * 0.75 // Each level gets slightly smaller
                );
            }
        }

        // Add fine fractal details throughout, not just at ends
        // Skip tips for explosions at deep levels for performance
        if (depth >= 1 && !(this.isExplosion && depth >= 3)) {
            // Spread tips evenly along the entire path
            const numTipPoints = this.isExplosion ? Math.floor(pathPoints.length / 5) : Math.floor(pathPoints.length / 3);
            for (let tp = 0; tp < numTipPoints; tp++) {
                const tipPointIndex = Math.floor(((tp + 1) / (numTipPoints + 1)) * (pathPoints.length - 1));
                const tipPoint = pathPoints[tipPointIndex];
                const numTips = this.isExplosion ? 1 + Math.floor(Math.random() * 2) : 2 + Math.floor(Math.random() * 3);

                for (let t = 0; t < numTips; t++) {
                    const tipDir = new THREE.Vector3(
                        (Math.random() - 0.5) * 2,
                        (Math.random() - 0.5) * 2,
                        (Math.random() - 0.5) * 2
                    ).normalize();

                    const tipLength = (0.8 + Math.random() * 1.5) * scale;
                    const tipEnd = tipPoint.clone().add(tipDir.multiplyScalar(tipLength));

                    branch.push({
                        start: tipPoint,
                        end: tipEnd,
                        width: baseWidth * 0.25,
                        depth: depth,
                        isTip: true
                    });
                }
            }
        }
    }

    // Midpoint displacement algorithm for realistic lightning
    generateLightningPath(start, end, depth, displacement = 1.5) {
        if (depth === 0) {
            return [start, end];
        }

        const mid = new THREE.Vector3(
            (start.x + end.x) / 2,
            (start.y + end.y) / 2,
            (start.z + end.z) / 2
        );

        // Add random displacement perpendicular to the line
        const direction = new THREE.Vector3().subVectors(end, start);
        const perpendicular = new THREE.Vector3(
            (Math.random() - 0.5) * displacement,
            (Math.random() - 0.5) * displacement,
            (Math.random() - 0.5) * displacement
        );

        mid.add(perpendicular);

        const leftPath = this.generateLightningPath(start, mid, depth - 1, displacement * 0.6);
        const rightPath = this.generateLightningPath(mid, end, depth - 1, displacement * 0.6);

        return [...leftPath.slice(0, -1), ...rightPath];
    }

    createGeometry() {
        this.lineMeshes = [];
        this.currentSegments = [];
        this.tubeMeshes = [];
        this.glowMeshes = [];

        this.branches.forEach((branch, branchIndex) => {
            // Core line geometry - will be updated progressively
            const geometry = new THREE.BufferGeometry();
            const positions = new Float32Array(branch.length * 6);
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geometry.setDrawRange(0, 0);

            const material = new THREE.LineBasicMaterial({
                color: new THREE.Color(10, 10, 15), // Bright white-blue for bloom
                linewidth: 3,
                transparent: true,
                opacity: 1.0,
                toneMapped: false, // Prevent tone mapping for bloom effect
                depthWrite: false // Better for electricity effect
            });

            const line = new THREE.LineSegments(geometry, material);
            this.scene.add(line);
            this.lineMeshes.push({ line, material, branch, geometry, branchIndex });
            this.currentSegments.push(0);

            // Store tube and glow meshes to add later
            this.tubeMeshes.push({ branch, branchIndex });
            this.glowMeshes.push({ branch, branchIndex });

            // Add point light that follows the growth
            const light = new THREE.PointLight(0xaaddff, 0, 30);
            light.position.copy(this.startPoint);
            this.scene.add(light);
            this.lights.push(light);
        });
    }

    // Create tube geometry for a completed segment
    addTubeForSegments(branch, startIdx, endIdx, branchIndex) {
        if (endIdx <= startIdx) return;

        const points = [];
        for (let i = startIdx; i <= Math.min(endIdx, branch.length - 1); i++) {
            points.push(branch[i].start);
        }
        if (endIdx < branch.length) {
            points.push(branch[endIdx].end);
        }

        if (points.length < 2) return;

        try {
            // Main tube with thickness control
            const tubeGeometry = new THREE.TubeGeometry(
                new THREE.CatmullRomCurve3(points),
                Math.max(points.length * 5, 20), // More segments for smoother glow
                0.08 * boltThickness,
                8,
                false
            );

            const tubeMaterial = new THREE.MeshBasicMaterial({
                color: new THREE.Color(10, 10, 15), // Brighter core
                transparent: true,
                opacity: 0.9,
                toneMapped: false
            });

            const tube = new THREE.Mesh(tubeGeometry, tubeMaterial);
            this.scene.add(tube);
            this.tubeMeshes[branchIndex].tube = tube;
            this.tubeMeshes[branchIndex].material = tubeMaterial;

            // Glow layer - smoother with more segments
            const glowGeometry = new THREE.TubeGeometry(
                new THREE.CatmullRomCurve3(points),
                Math.max(points.length * 5, 20), // More segments to prevent clumping
                0.25 * boltThickness, // Smaller glow radius
                8,
                false
            );

            const glowMaterial = new THREE.MeshBasicMaterial({
                color: new THREE.Color(3, 3.5, 5), // Reduced brightness
                transparent: true,
                opacity: 0.3, // Less opaque
                blending: THREE.AdditiveBlending,
                toneMapped: false
            });

            const glow = new THREE.Mesh(glowGeometry, glowMaterial);
            this.scene.add(glow);
            this.glowMeshes[branchIndex].glow = glow;
            this.glowMeshes[branchIndex].material = glowMaterial;
        } catch (e) {
            // Skip if curve creation fails
        }
    }

    // Easing function for smooth animation
    easeOutCubic(t) {
        return 1 - Math.pow(1 - t, 3);
    }

    easeInOutQuad(t) {
        return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    }

    update() {
        const now = Date.now();
        const atPeak = this.progress >= this.maxProgress && this.fadeProgress < 0.2;

        if (this.progress < this.maxProgress) {
            this.progress += this.speed;

            // Start shrinking from start after reaching 50%
            if (this.progress > 0.5) {
                this.fadeProgress += this.fadeSpeed;
            }

            this.lineMeshes.forEach(({ line, material, branch, geometry, branchIndex }, meshIndex) => {
                // Apply easing to progress for smooth growth
                const rawBranchProgress = Math.min(this.progress * 1.5 - branchIndex * 0.1, 1);
                const branchProgress = this.easeOutCubic(Math.max(0, rawBranchProgress));

                // Shrink follows the path from start to end
                const rawShrinkProgress = Math.min(this.fadeProgress * 1.5 - branchIndex * 0.1, 1);
                const shrinkBranchProgress = this.easeInOutQuad(Math.max(0, rawShrinkProgress));

                if (rawBranchProgress > 0) {
                    // Calculate how many segments to show
                    const targetSegments = Math.floor(branchProgress * branch.length);
                    const shrunkSegments = Math.floor(shrinkBranchProgress * branch.length);
                    const currentSegs = this.currentSegments[meshIndex];

                    // Add new segments progressively
                    if (targetSegments > currentSegs) {
                        const positions = geometry.attributes.position.array;

                        for (let i = currentSegs; i < targetSegments && i < branch.length; i++) {
                            const segment = branch[i];
                            const idx = i * 6;
                            positions[idx] = segment.start.x;
                            positions[idx + 1] = segment.start.y;
                            positions[idx + 2] = segment.start.z;
                            positions[idx + 3] = segment.end.x;
                            positions[idx + 4] = segment.end.y;
                            positions[idx + 5] = segment.end.z;
                        }

                        geometry.attributes.position.needsUpdate = true;
                        this.currentSegments[meshIndex] = targetSegments;

                        // Add tube/glow when we have enough segments
                        // Skip expensive geometry for explosions at deep levels
                        const shouldAddTubes = targetSegments > 5 && !this.tubeMeshes[branchIndex].tube;
                        const depthLevel = branch[0]?.depth || 0;
                        if (shouldAddTubes && !(this.isExplosion && depthLevel >= 3)) {
                            this.addTubeForSegments(branch, 0, targetSegments, branchIndex);
                        }
                    }

                    // Show range - shrink follows the path from start to end
                    const visibleStart = shrunkSegments;
                    const visibleEnd = targetSegments;
                    const visibleLength = Math.max(0, visibleEnd - visibleStart);
                    geometry.setDrawRange(visibleStart * 2, visibleLength * 2);

                    // Consistent electricity flow effect at peak
                    let flowIntensity = 1.0;
                    if (atPeak) {
                        // Unified flowing electricity across entire bolt
                        flowIntensity = 0.85 + Math.sin(now * 0.01 + this.flowOffset) * 0.15;
                    }

                    // Consistent pulse across entire bolt
                    const corePulse = 0.95 + Math.sin(now * 0.005 + this.flowOffset) * 0.05;
                    const glowPulse = 0.85 + Math.sin(now * 0.003 + this.flowOffset) * 0.15;

                    // Smooth fade for glow during shrink
                    const shrinkFade = shrinkBranchProgress > 0 ? (1 - shrinkBranchProgress * 0.6) : 1.0;

                    // Update tube/glow opacity - with smooth fade
                    const fadeAmount = visibleLength > 0 ? 1 : 0;
                    if (this.tubeMeshes[branchIndex].material) {
                        this.tubeMeshes[branchIndex].material.opacity = 0.9 * corePulse * fadeAmount * flowIntensity * shrinkFade;
                    }
                    if (this.glowMeshes[branchIndex].material) {
                        // Glow fades smoothly during shrink
                        this.glowMeshes[branchIndex].material.opacity = 0.35 * glowPulse * fadeAmount * flowIntensity * shrinkFade;
                    }

                    // Update light intensity and position - follows the leading edge
                    if (this.lights[branchIndex] && visibleEnd > 0 && visibleEnd <= branch.length) {
                        const tipSegment = branch[Math.min(visibleEnd - 1, branch.length - 1)];
                        this.lights[branchIndex].position.copy(tipSegment.end);
                        this.lights[branchIndex].intensity = 10 * glowPulse * flowIntensity * shrinkFade;
                    } else if (this.lights[branchIndex]) {
                        this.lights[branchIndex].intensity = 0;
                    }
                }
            });
        } else {
            // Continue shrinking after growth completes
            this.fadeProgress += this.fadeSpeed;

            // Shrink continues from start to end
            this.lineMeshes.forEach(({ material, geometry, branch }, index) => {
                const rawShrinkProgress = Math.min(this.fadeProgress * 1.5, 1);
                const shrinkBranchProgress = this.easeInOutQuad(rawShrinkProgress);
                const shrunkSegments = Math.floor(shrinkBranchProgress * branch.length);

                // Show from shrunk position to end
                const visibleStart = shrunkSegments;
                const visibleLength = Math.max(0, branch.length - shrunkSegments);

                // Continuous exponential fade throughout - no jumps
                const shrinkFade = Math.pow(1 - shrinkBranchProgress, 2.0);

                // Always update geometry range
                geometry.setDrawRange(visibleStart * 2, Math.max(visibleLength * 2, 0));

                // Update tube/glow with continuous smooth fade
                if (this.tubeMeshes[index] && this.tubeMeshes[index].material) {
                    this.tubeMeshes[index].material.opacity = Math.max(0, 0.9 * shrinkFade);
                }
                if (this.glowMeshes[index] && this.glowMeshes[index].material) {
                    this.glowMeshes[index].material.opacity = Math.max(0, 0.35 * shrinkFade);
                }

                // Light follows the leading edge with continuous fade
                if (this.lights[index]) {
                    if (visibleLength > 0 && shrunkSegments < branch.length) {
                        const tipSegment = branch[shrunkSegments];
                        this.lights[index].position.copy(tipSegment.start);
                        this.lights[index].intensity = Math.max(0, 8 * shrinkFade);
                    } else {
                        this.lights[index].intensity = 0;
                    }
                }

                // Line material opacity
                material.opacity = Math.max(0, shrinkFade);
            });
        }

        return this.fadeProgress < 1.5 && (this.progress < 1 || this.fadeProgress < 1);
    }

    destroy() {
        this.lineMeshes.forEach(({ line }) => {
            this.scene.remove(line);
            if (line.geometry) line.geometry.dispose();
            if (line.material) line.material.dispose();
        });
        this.tubeMeshes.forEach(({ tube }) => {
            if (tube) {
                this.scene.remove(tube);
                if (tube.geometry) tube.geometry.dispose();
                if (tube.material) tube.material.dispose();
            }
        });
        this.glowMeshes.forEach(({ glow }) => {
            if (glow) {
                this.scene.remove(glow);
                if (glow.geometry) glow.geometry.dispose();
                if (glow.material) glow.material.dispose();
            }
        });
        this.lights.forEach(light => {
            this.scene.remove(light);
            if (light.dispose) light.dispose();
        });
    }
}

// Lightning manager with performance optimization
const lightnings = [];
const maxLightnings = 50; // Limit active lightnings for performance
let lastLightningPoint = null; // Track last spawn point for connections

// Mouse interaction
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let isMouseDown = false;
let lastSpawnTime = 0;
const spawnInterval = 50; // Milliseconds between spawns when dragging

// Create invisible plane for click detection
const planeGeometry = new THREE.PlaneGeometry(100, 100);
const planeMaterial = new THREE.MeshBasicMaterial({ visible: false });
const plane = new THREE.Mesh(planeGeometry, planeMaterial);
scene.add(plane);

function spawnLightning(clientX, clientY, forceExplosion = false) {
    mouse.x = (clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(plane);

    if (intersects.length > 0) {
        const point = intersects[0].point;

        // 10% chance of random explosion, or forced
        const isExplosion = forceExplosion || Math.random() < 0.1;

        // Connect to previous point if dragging (no connection for explosions)
        const endPoint = !isExplosion && lastLightningPoint && isMouseDown ? lastLightningPoint : null;
        lightnings.push(new Lightning(point, scene, endPoint, isExplosion));

        // Remove oldest lightning if too many
        if (lightnings.length > maxLightnings) {
            const oldest = lightnings.shift();
            oldest.destroy();
        }

        lastLightningPoint = isExplosion ? null : point; // Don't chain after explosions
    }
}

window.addEventListener('mousedown', (event) => {
    isMouseDown = true;
    spawnLightning(event.clientX, event.clientY);
});

window.addEventListener('mouseup', () => {
    isMouseDown = false;
    lastLightningPoint = null; // Reset connection on mouse up
});

window.addEventListener('mousemove', (event) => {
    if (isMouseDown) {
        const now = Date.now();
        if (now - lastSpawnTime > spawnInterval) {
            spawnLightning(event.clientX, event.clientY);
            lastSpawnTime = now;
        }
    }
});

// Touch support for mobile
window.addEventListener('touchstart', (event) => {
    event.preventDefault();
    isMouseDown = true;
    const touch = event.touches[0];
    spawnLightning(touch.clientX, touch.clientY);
});

window.addEventListener('touchend', () => {
    isMouseDown = false;
    lastLightningPoint = null;
});

window.addEventListener('touchmove', (event) => {
    event.preventDefault();
    if (isMouseDown) {
        const now = Date.now();
        if (now - lastSpawnTime > spawnInterval) {
            const touch = event.touches[0];
            spawnLightning(touch.clientX, touch.clientY);
            lastSpawnTime = now;
        }
    }
}, { passive: false });

// Keyboard controls for thickness and explosions
window.addEventListener('keydown', (event) => {
    if (event.key === '=' || event.key === '+') {
        boltThickness = Math.min(boltThickness + 0.2, 3.0);
        updateInfoText();
    } else if (event.key === '-' || event.key === '_') {
        boltThickness = Math.max(boltThickness - 0.2, 0.2);
        updateInfoText();
    } else if (event.key === 'e' || event.key === 'E' || event.key === ' ') {
        // Trigger explosion at center of viewport
        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;
        spawnLightning(centerX, centerY, true);
    }
});

function updateInfoText() {
    const info = document.querySelector('.info');
    const thicknessPercent = Math.round(boltThickness * 100);
    info.textContent = `Click and drag to spawn thunderbolts | Thickness: ${thicknessPercent}% (+/- keys) | Press SPACE for explosion`;
}

// Camera rotation
let cameraAngle = 0;
const cameraRadius = 30;

// Animation loop
function animate() {
    requestAnimationFrame(animate);

    // Slow camera rotation
    cameraAngle += 0.002;
    camera.position.x = Math.sin(cameraAngle) * cameraRadius;
    camera.position.z = Math.cos(cameraAngle) * cameraRadius;
    camera.lookAt(0, 0, 0);

    // Update plane to always face camera
    plane.lookAt(camera.position);

    // Update lightnings
    for (let i = lightnings.length - 1; i >= 0; i--) {
        const alive = lightnings[i].update();
        if (!alive) {
            lightnings[i].destroy();
            lightnings.splice(i, 1);
        }
    }

    composer.render();
}

// Handle window resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
});

animate();
