import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { config } from './config';
import { GPGPUSimulation } from './gpgpu';
import { renderVS, renderFS } from './shaders';

// Core Three.js variables
let renderer: THREE.WebGLRenderer;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let controls: OrbitControls;
let terrainMesh: THREE.Mesh;
let terrainMaterial: THREE.ShaderMaterial;
let gpgpu: GPGPUSimulation;

// Lighting representation
let sunLight: THREE.DirectionalLight;
let ambientLight: THREE.AmbientLight;

// Raycasting and painting interaction state
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let isPointerDown = false;
let pointerUV: THREE.Vector2 | null = null;

// Performance timing variables
let frameCount = 0;
let lastFpsUpdate = 0;

// Free camera keyboard state
const keys = { w: false, a: false, s: false, d: false, space: false, shift: false };

/**
 * Initialize application lifecycle
 */
function init() {
  const container = document.getElementById('canvas-container');
  if (!container) return;

  // 1. WebGL Renderer configuration
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  // 2. Main Scene setup
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0.5, 0.7, 0.9); // Noon sky background

  // 3. Perspective Camera
  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 50, 75);

  // 4. OrbitControls navigation
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.maxPolarAngle = Math.PI / 2 - 0.05; // Lock camera from going below terrain
  controls.minDistance = 15;
  controls.maxDistance = 250;

  // 5. Ambient & Sun directional light sources (fallback/standard rendering helpers)
  ambientLight = new THREE.AmbientLight(0xffffff, 0.1);
  scene.add(ambientLight);

  sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
  scene.add(sunLight);

  // 6. GPGPU Simulation Engine
  gpgpu = new GPGPUSimulation(renderer, config.gridSize);

  // 7. Terrain Mesh Construction
  // Create flat plane which we will displace on the GPU
  const geometry = new THREE.PlaneGeometry(100, 100, config.gridSize - 1, config.gridSize - 1);

  // Custom Material for Height displacement and realistic visual rendering
  terrainMaterial = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: renderVS,
    fragmentShader: renderFS,
    uniforms: {
      u_texA: { value: null },
      u_texB: { value: null },
      u_height_scale: { value: config.heightScale },
      u_grid_size: { value: config.gridSize },
      u_view_mode: { value: 0.0 },
      u_time: { value: 0.0 },
      u_sun_dir: { value: new THREE.Vector3() },
      u_sun_color: { value: new THREE.Color() },
      u_local_camera_pos: { value: new THREE.Vector3() },
    },
    depthWrite: true,
    depthTest: true,
  });

  terrainMesh = new THREE.Mesh(geometry, terrainMaterial);
  // Rotate horizontal plane in world space (XZ plane)
  terrainMesh.rotation.x = -Math.PI / 2;
  scene.add(terrainMesh);

  // 8. Event Listeners
  window.addEventListener('resize', onWindowResize);

  window.addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'KeyW': keys.w = true; break;
      case 'KeyA': keys.a = true; break;
      case 'KeyS': keys.s = true; break;
      case 'KeyD': keys.d = true; break;
      case 'Space':
        keys.space = true;
        if (e.target === document.body) e.preventDefault();
        break;
      case 'ShiftLeft':
      case 'ShiftRight': keys.shift = true; break;
    }
  });

  window.addEventListener('keyup', (e) => {
    switch (e.code) {
      case 'KeyW': keys.w = false; break;
      case 'KeyA': keys.a = false; break;
      case 'KeyS': keys.s = false; break;
      case 'KeyD': keys.d = false; break;
      case 'Space': keys.space = false; break;
      case 'ShiftLeft':
      case 'ShiftRight': keys.shift = false; break;
    }
  });

  // Interactive painting event listeners
  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointerleave', onPointerUp);

  // Bind HUD UI controls to script logic
  setupUI();

  // Run initial terrain generation
  gpgpu.resetTerrain();

  // Begin frame loops
  animate();
}

/**
 * Handle browser window resize events
 */
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

/**
 * Pointer raycast calculation on flat terrain
 */
function updatePointerUV(e: PointerEvent) {
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(terrainMesh);

  if (intersects.length > 0 && intersects[0].uv) {
    if (!pointerUV) pointerUV = new THREE.Vector2();
    pointerUV.copy(intersects[0].uv);
  } else {
    pointerUV = null;
  }
}

function onPointerDown(e: PointerEvent) {
  // If clicking on HUD overlay panel, bypass painting
  if ((e.target as HTMLElement).closest('#hud')) return;

  isPointerDown = true;
  updatePointerUV(e);

  // Disable OrbitControls to allow smooth brushing
  controls.enabled = false;
}

function onPointerMove(e: PointerEvent) {
  if (!isPointerDown) return;
  updatePointerUV(e);
}

function onPointerUp(_e: PointerEvent) {
  isPointerDown = false;
  pointerUV = null;

  // Enable OrbitControls navigation back
  controls.enabled = true;
}

/**
 * Setup and bind interactive HUD buttons & sliders
 */
function setupUI() {
  // 1. Brush Tool Buttons Selection
  const brushBtns = document.querySelectorAll('.btn-brush');
  brushBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      brushBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      const brushVal = (btn as HTMLElement).dataset.brush;
      if (brushVal !== undefined) {
        config.brushType = parseInt(brushVal);
      }
    });
  });

  // 2. Helper Binder for Sliders
  const bindSlider = (
    id: string,
    configKey:
      | 'brushRadius'
      | 'brushStrength'
      | 'waterGravity'
      | 'waterDamping'
      | 'lavaViscosity'
      | 'sandSlideRate'
      | 'evaporation'
      | 'timeOfDay',
    displayId?: string
  ) => {
    const slider = document.getElementById(id) as HTMLInputElement;
    const valDisplay = displayId ? document.getElementById(displayId) : null;
    if (!slider) return;

    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      config[configKey] = val;

      if (valDisplay) {
        // Humanized text representation
        if (configKey === 'timeOfDay') {
          const hours = Math.floor(val);
          const mins = Math.floor((val % 1) * 60)
            .toString()
            .padStart(2, '0');
          valDisplay.textContent = `${hours}:${mins}`;
        } else {
          valDisplay.textContent = val.toFixed(
            slider.step.includes('.') ? slider.step.split('.')[1].length : 0
          );
        }
      }
    });
  };

  bindSlider('brush-radius', 'brushRadius', 'brush-radius-val');
  bindSlider('brush-strength', 'brushStrength', 'brush-strength-val');
  bindSlider('water-gravity', 'waterGravity', 'water-gravity-val');
  bindSlider('water-damping', 'waterDamping', 'water-damping-val');
  bindSlider('lava-viscosity', 'lavaViscosity', 'lava-viscosity-val');
  bindSlider('sand-slide', 'sandSlideRate', 'sand-slide-val');
  bindSlider('evaporation', 'evaporation', 'evaporation-val');
  bindSlider('time-of-day', 'timeOfDay', 'time-of-day-val');

  // 3. Pause / Play button
  const pauseBtn = document.getElementById('btn-pause') as HTMLButtonElement;
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      config.paused = !config.paused;
      pauseBtn.textContent = config.paused ? '▶️ Relancer' : '⏸️ Pause';
      if (config.paused) {
        pauseBtn.classList.add('active');
      } else {
        brushBtns.forEach((b) => {
          if ((b as HTMLElement).dataset.brush === config.brushType.toString()) {
            b.classList.add('active');
          }
        });
        pauseBtn.classList.remove('active');
      }
    });
  }

  // 4. Clear Fluids
  const clearBtn = document.getElementById('btn-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      gpgpu.clearFluids();
    });
  }

  // 5. Reset Terrain
  const resetBtn = document.getElementById('btn-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      gpgpu.resetTerrain();
    });
  }

  // 6. View Mode Dropdown Select
  const viewSelect = document.getElementById('view-mode') as HTMLSelectElement;
  if (viewSelect) {
    viewSelect.addEventListener('change', () => {
      config.viewMode = viewSelect.value as typeof config.viewMode;
    });
  }

  // 7. Auto Rotate Camera checkbox
  const rotateCheck = document.getElementById('auto-rotate') as HTMLInputElement;
  if (rotateCheck) {
    rotateCheck.addEventListener('change', () => {
      config.autoRotate = rotateCheck.checked;
    });
  }
}

/**
 * Main animation & execution frame loop
 */
function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();

  // Free camera movement
  const moveSpeed = 1.0;
  const moveVec = new THREE.Vector3();
  const localMove = new THREE.Vector3();
  
  if (keys.w) localMove.z -= 1;
  if (keys.s) localMove.z += 1;
  if (keys.a) localMove.x -= 1;
  if (keys.d) localMove.x += 1;
  
  if (localMove.lengthSq() > 0) {
    localMove.normalize();
    localMove.applyQuaternion(camera.quaternion);
    moveVec.add(localMove);
  }
  
  if (keys.space) moveVec.y += 1;
  if (keys.shift) moveVec.y -= 1;
  
  if (moveVec.lengthSq() > 0) {
    moveVec.normalize().multiplyScalar(moveSpeed);
    camera.position.add(moveVec);
    controls.target.add(moveVec);
  }

  // OrbitControls damping update
  controls.autoRotate = config.autoRotate;
  controls.autoRotateSpeed = 1.2;
  controls.update();

  // Run GPGPU physical simulation ticks
  if (!config.paused) {
    // Sync current pointer coordinates onto the simulation pass
    gpgpu.setBrush(
      isPointerDown,
      pointerUV,
      config.brushType,
      config.brushRadius,
      config.brushStrength
    );
    gpgpu.step();
  } else {
    // If paused, we still allow drawing terrain & painting, just not fluid flows
    gpgpu.setBrush(
      isPointerDown,
      pointerUV,
      config.brushType,
      config.brushRadius,
      config.brushStrength
    );
    // When paused we do a dry simulation step (physics params = 0) so the brush stroke shows up immediately
    const tempWaterGravity = config.waterGravity;
    const tempWaterDamping = config.waterDamping;
    const tempLava = config.lavaViscosity;
    const tempSand = config.sandSlideRate;

    config.waterGravity = 0.0;
    config.waterDamping = 1.0;
    config.lavaViscosity = 0.0;
    config.sandSlideRate = 0.0;
    gpgpu.step();

    config.waterGravity = tempWaterGravity;
    config.waterDamping = tempWaterDamping;
    config.lavaViscosity = tempLava;
    config.sandSlideRate = tempSand;
  }

  // Calculate day / night cycle sky color and sun light parameters
  const alpha = (config.timeOfDay / 24.0) * Math.PI * 2.0 - Math.PI / 2.0;
  const sinAlpha = Math.sin(alpha);

  // Dynamic Sun Direction
  const sunPos = new THREE.Vector3(
    Math.cos(alpha),
    Math.max(0.02, sinAlpha),
    Math.sin(alpha) * 0.5
  ).normalize();
  sunLight.position.copy(sunPos);

  // Dynamic Sun Color & Sky Clear Color
  const sunColor = new THREE.Color();
  const skyColor = new THREE.Color();

  if (sinAlpha > 0.0) {
    // Daytime light
    const dayStrength = Math.min(1.0, sinAlpha / 0.3);

    // Noon light is white-yellow, sunrise/sunset is orange
    const noonColor = new THREE.Color(1.0, 0.95, 0.85);
    const goldenColor = new THREE.Color(1.0, 0.35, 0.05);
    sunColor.lerpColors(goldenColor, noonColor, dayStrength);
    sunLight.color.copy(sunColor).multiplyScalar(dayStrength);

    // Sky gradient transition
    const noonSky = new THREE.Color(0.2, 0.45, 0.75);
    const goldenSky = new THREE.Color(0.12, 0.04, 0.16);
    skyColor.lerpColors(goldenSky, noonSky, dayStrength);
  } else {
    // Nighttime light (moon representation)
    const nightStrength = Math.min(1.0, -sinAlpha / 0.3);
    const moonColor = new THREE.Color(0.04, 0.08, 0.18);
    sunColor.copy(moonColor);
    sunLight.color.copy(moonColor).multiplyScalar(nightStrength);

    // Set sun direction to moon (opposite side)
    const moonPos = new THREE.Vector3(
      -Math.cos(alpha),
      -sinAlpha,
      -Math.sin(alpha) * 0.5
    ).normalize();
    sunLight.position.copy(moonPos);

    const nightSky = new THREE.Color(0.02, 0.02, 0.05);
    const sunsetSky = new THREE.Color(0.12, 0.04, 0.16);
    // Smooth transition from sunset to midnight
    const t = Math.min(1.0, -sinAlpha / 0.15);
    skyColor.lerpColors(sunsetSky, nightSky, t);
  }

  renderer.setClearColor(skyColor);
  scene.background = skyColor;

  // Pass current simulation textures as uniform attachments for rendering
  terrainMaterial.uniforms.u_texA.value = gpgpu.targetA_read.texture;
  terrainMaterial.uniforms.u_texB.value = gpgpu.targetB_read.texture;
  terrainMaterial.uniforms.u_height_scale.value = config.heightScale;
  terrainMaterial.uniforms.u_time.value = now * 0.001;

  // Pass local light directions and camera position vectors to ShaderMaterial
  const localSun = terrainMesh.worldToLocal(sunLight.position.clone()).normalize();
  terrainMaterial.uniforms.u_sun_dir.value.copy(localSun);
  terrainMaterial.uniforms.u_sun_color.value.copy(sunColor);

  const localCam = terrainMesh.worldToLocal(camera.position.clone());
  terrainMaterial.uniforms.u_local_camera_pos.value.copy(localCam);

  // Set visual debug view modes
  let modeVal = 0.0;
  if (config.viewMode === 'heightmap') modeVal = 1.0;
  else if (config.viewMode === 'water-only') modeVal = 2.0;
  else if (config.viewMode === 'lava-only') modeVal = 3.0;
  else if (config.viewMode === 'sand-only') modeVal = 4.0;
  terrainMaterial.uniforms.u_view_mode.value = modeVal;

  // Render Scene
  renderer.render(scene, camera);

  // FPS Stats Monitoring
  frameCount++;
  if (now > lastFpsUpdate + 500) {
    const fps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
    const fpsVal = document.getElementById('fps-val');
    if (fpsVal) {
      fpsVal.textContent = fps.toString();
    }
    frameCount = 0;
    lastFpsUpdate = now;
  }
}

// Start Three.js initialization
window.addEventListener('DOMContentLoaded', () => {
  init();
});
