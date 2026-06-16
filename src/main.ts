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
let fluidMesh: THREE.Mesh;
let fluidMaterial: THREE.ShaderMaterial;
let gpgpu: GPGPUSimulation;

let pickingScene: THREE.Scene;
let pickingMaterial: THREE.ShaderMaterial;
let pickingMesh: THREE.Mesh;
let pickingRenderTarget: THREE.WebGLRenderTarget;

// Lighting representation
let sunLight: THREE.DirectionalLight;
let ambientLight: THREE.AmbientLight;

// Raycasting and painting interaction state
let isPointerDown = false;
let pointerUV: THREE.Vector2 | null = null;
let activeBrushType: number = 0;

// Performance timing variables
let frameCount = 0;
let lastFpsUpdate = 0;
let simTicksAccumulator = 0.0;

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
  camera.position.set(0, 100, 150);

  // 4. OrbitControls navigation
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.maxPolarAngle = Math.PI / 2 - 0.05; // Lock camera from going below terrain
  controls.minDistance = 15;
  controls.maxDistance = 500;

  // 5. Ambient & Sun directional light sources (fallback/standard rendering helpers)
  ambientLight = new THREE.AmbientLight(0xffffff, 0.1);
  scene.add(ambientLight);

  sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
  scene.add(sunLight);

  // 6. GPGPU Simulation Engine
  gpgpu = new GPGPUSimulation(renderer, config.gridSize);

  // 7. Terrain Mesh Construction
  // Create flat plane which we will displace on the GPU
  // Optimization: use a lower resolution for the rendering mesh to save vertex shader load.
  // The fragment shader will still compute lighting at full simulation resolution!
  const renderSegments = Math.max(1, Math.floor(config.gridSize * config.renderResolution) - 1);
  const geometry = new THREE.PlaneGeometry(200, 200, renderSegments, renderSegments);

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
      u_show_rock: { value: config.showRock ? 1.0 : 0.0 },
      u_show_sand: { value: config.showSand ? 1.0 : 0.0 },
      u_show_water: { value: config.showWater ? 1.0 : 0.0 },
      u_show_lava: { value: config.showLava ? 1.0 : 0.0 },
      u_show_suspended: { value: config.showSuspendedSand ? 1.0 : 0.0 },
      u_time: { value: 0.0 },
      u_sun_dir: { value: new THREE.Vector3() },
      u_sun_color: { value: new THREE.Color() },
      u_local_camera_pos: { value: new THREE.Vector3() },
      u_layer: { value: 0.0 },
      u_smooth: { value: config.smoothRendering ? 1.0 : 0.0 },
      u_border_behavior: { value: config.borderBehavior },
      u_border_water_height: { value: config.borderWaterHeight },
    },
    depthWrite: true,
    depthTest: true,
  });

  terrainMesh = new THREE.Mesh(geometry, terrainMaterial);
  // Rotate horizontal plane in world space (XZ plane)
  terrainMesh.rotation.x = -Math.PI / 2;
  scene.add(terrainMesh);

  fluidMaterial = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: renderVS,
    fragmentShader: renderFS,
    uniforms: {
      u_texA: { value: null },
      u_texB: { value: null },
      u_texFlux: { value: null },
      u_texLavaFlux: { value: null },
      u_height_scale: { value: config.heightScale },
      u_grid_size: { value: config.gridSize },
      u_show_rock: { value: config.showRock ? 1.0 : 0.0 },
      u_show_sand: { value: config.showSand ? 1.0 : 0.0 },
      u_show_water: { value: config.showWater ? 1.0 : 0.0 },
      u_show_lava: { value: config.showLava ? 1.0 : 0.0 },
      u_show_suspended: { value: config.showSuspendedSand ? 1.0 : 0.0 },
      u_time: { value: 0.0 },
      u_sun_dir: { value: new THREE.Vector3() },
      u_sun_color: { value: new THREE.Color() },
      u_local_camera_pos: { value: new THREE.Vector3() },
      u_layer: { value: 1.0 },
      u_smooth: { value: config.smoothRendering ? 1.0 : 0.0 },
      u_border_behavior: { value: config.borderBehavior },
      u_border_water_height: { value: config.borderWaterHeight },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });

  fluidMesh = new THREE.Mesh(geometry, fluidMaterial);
  fluidMesh.rotation.x = -Math.PI / 2;
  scene.add(fluidMesh);

  // 7.5. GPU Picking for precise raycasting against displaced terrain mesh
  pickingScene = new THREE.Scene();
  pickingRenderTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
  });

  pickingMaterial = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: `
      out vec2 v_uv;
      uniform sampler2D u_texA;
      uniform sampler2D u_texB;
      uniform float u_height_scale;

      void main() {
        v_uv = uv;
        vec4 cellA = texture(u_texA, uv);
        
        // Only use rock and sand height for cursor collision, ignoring water and lava
        float h = cellA.r + cellA.g;

        vec3 displaced = position;
        displaced.z = h * u_height_scale;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      in vec2 v_uv;
      out vec4 fragColor;
      void main() {
        fragColor = vec4(v_uv, 0.0, 1.0);
      }
    `,
    uniforms: {
      u_texA: { value: null },
      u_texB: { value: null },
      u_height_scale: { value: config.heightScale },
    },
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
  });

  pickingMesh = new THREE.Mesh(geometry, pickingMaterial);
  pickingMesh.rotation.x = -Math.PI / 2;
  pickingScene.add(pickingMesh);

  // 8. Event Listeners
  window.addEventListener('resize', onWindowResize);

  window.addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'KeyW':
        keys.w = true;
        break;
      case 'KeyA':
        keys.a = true;
        break;
      case 'KeyS':
        keys.s = true;
        break;
      case 'KeyD':
        keys.d = true;
        break;
      case 'Space':
        keys.space = true;
        if (e.target === document.body) e.preventDefault();
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        keys.shift = true;
        break;
    }
  });

  window.addEventListener('keyup', (e) => {
    switch (e.code) {
      case 'KeyW':
        keys.w = false;
        break;
      case 'KeyA':
        keys.a = false;
        break;
      case 'KeyS':
        keys.s = false;
        break;
      case 'KeyD':
        keys.d = false;
        break;
      case 'Space':
        keys.space = false;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        keys.shift = false;
        break;
    }
  });

  // Prevent context menu to allow right-click interaction
  window.addEventListener('contextmenu', (e) => e.preventDefault());

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
 * Pointer raycast calculation using GPU picking against displaced terrain
 */
function updatePointerUV(e: PointerEvent) {
  const x = Math.floor(e.clientX);
  const y = Math.floor(e.clientY);

  camera.setViewOffset(window.innerWidth, window.innerHeight, x, y, 1, 1);

  const currentRenderTarget = renderer.getRenderTarget();
  const currentClearColor = renderer.getClearColor(new THREE.Color());
  const currentClearAlpha = renderer.getClearAlpha();

  renderer.setRenderTarget(pickingRenderTarget);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();

  if (gpgpu) {
    pickingMaterial.uniforms.u_texA.value = gpgpu.targetA_read.texture;
    pickingMaterial.uniforms.u_texB.value = gpgpu.targetB_read.texture;
    pickingMaterial.uniforms.u_height_scale.value = config.heightScale;
  }

  renderer.render(pickingScene, camera);

  const pixelBuffer = new Float32Array(4);
  renderer.readRenderTargetPixels(pickingRenderTarget, 0, 0, 1, 1, pixelBuffer);

  renderer.setRenderTarget(currentRenderTarget);
  renderer.setClearColor(currentClearColor, currentClearAlpha);
  camera.clearViewOffset();

  if (pixelBuffer[3] > 0.0) {
    if (!pointerUV) pointerUV = new THREE.Vector2();
    pointerUV.set(pixelBuffer[0], pixelBuffer[1]);
  } else {
    pointerUV = null;
  }
}

let isFPSLooking = false;
let previousMousePosition = { x: 0, y: 0 };

function onPointerDown(e: PointerEvent) {
  // If clicking on HUD overlay panel, bypass painting
  if ((e.target as HTMLElement).closest('#hud')) return;

  if (e.button === 1) {
    isFPSLooking = true;
    previousMousePosition = { x: e.clientX, y: e.clientY };
    controls.enabled = false;
    e.preventDefault();
    return;
  }

  if (e.button === 0) {
    activeBrushType = config.brushType; // Left click uses selected brush
  } else if (e.button === 2) {
    activeBrushType = 5; // Right click = Erase/Clear
  } else {
    return;
  }

  isPointerDown = true;
  updatePointerUV(e);

  // Disable OrbitControls to allow smooth brushing
  controls.enabled = false;
}

function onPointerMove(e: PointerEvent) {
  if (isFPSLooking) {
    const deltaX = e.clientX - previousMousePosition.x;
    const deltaY = e.clientY - previousMousePosition.y;
    previousMousePosition = { x: e.clientX, y: e.clientY };

    const sensitivity = 0.003;
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    euler.setFromQuaternion(camera.quaternion);

    euler.y -= deltaX * sensitivity;
    euler.x -= deltaY * sensitivity;

    const PI_2 = Math.PI / 2 - 0.01;
    euler.x = Math.max(-PI_2, Math.min(PI_2, euler.x));

    camera.quaternion.setFromEuler(euler);
    return;
  }

  if (!isPointerDown) return;
  updatePointerUV(e);
}

function onPointerUp(_e: PointerEvent) {
  if (isFPSLooking) {
    isFPSLooking = false;

    const dist = Math.max(15, camera.position.distanceTo(controls.target));
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    controls.target.copy(camera.position).add(forward.multiplyScalar(dist));

    controls.enabled = true;
  }

  if (isPointerDown) {
    isPointerDown = false;
    pointerUV = null;
    controls.enabled = true;
  }
}

/**
 * Setup and bind interactive HUD buttons & sliders
 */
function setupUI() {
  // 0. Collapsible HUD Sections Toggle
  const headers = document.querySelectorAll('.hud-section-header');
  headers.forEach((header) => {
    header.addEventListener('click', () => {
      const section = header.closest('.hud-section');
      if (section) {
        section.classList.toggle('collapsed');
      }
    });
  });

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
      | 'lavaGravity'
      | 'lavaDamping'
      | 'sandSlideRate'
      | 'sandStaticReposeSlope'
      | 'sandDynamicReposeSlope'
      | 'erosionRate'
      | 'capacityFactor'
      | 'depositionRate'
      | 'evaporation'
      | 'terrainScale'
      | 'terrainSharpness'
      | 'terrainTilt'
      | 'terrainSandHeight'
      | 'flatRockHeight'
      | 'fbmOctaves'
      | 'fbmPersistence'
      | 'rainQuantity'
      | 'rainSize'
      | 'borderWaterHeight'
      | 'minWaterDepth'
      | 'renderResolution'
      | 'simSpeed',
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
        valDisplay.textContent = val.toFixed(
          slider.step.includes('.') ? slider.step.split('.')[1].length : 0
        );
      }

      // Automatically regenerate terrain when changing noise or parameters, keeping seed
      if (
        [
          'terrainScale',
          'terrainSharpness',
          'terrainTilt',
          'terrainSandHeight',
          'flatRockHeight',
          'fbmOctaves',
          'fbmPersistence',
        ].includes(configKey)
      ) {
        gpgpu.resetTerrain(false);
      }

      if (configKey === 'renderResolution') {
        const newSegments = Math.max(1, Math.floor(config.gridSize * config.renderResolution) - 1);
        const newGeo = new THREE.PlaneGeometry(200, 200, newSegments, newSegments);
        terrainMesh.geometry.dispose();
        terrainMesh.geometry = newGeo;
        fluidMesh.geometry = newGeo;
        pickingMesh.geometry = newGeo;
      }
    });
  };

  bindSlider('brush-radius', 'brushRadius', 'brush-radius-val');
  bindSlider('brush-strength', 'brushStrength', 'brush-strength-val');
  bindSlider('water-gravity', 'waterGravity', 'water-gravity-val');
  bindSlider('water-damping', 'waterDamping', 'water-damping-val');
  bindSlider('lava-gravity', 'lavaGravity', 'lava-gravity-val');
  bindSlider('lava-damping', 'lavaDamping', 'lava-damping-val');
  bindSlider('sand-slide', 'sandSlideRate', 'sand-slide-val');
  bindSlider('sand-static-repose-slope', 'sandStaticReposeSlope', 'sand-static-repose-slope-val');
  bindSlider('sand-dynamic-repose-slope', 'sandDynamicReposeSlope', 'sand-dynamic-repose-slope-val');
  bindSlider('erosion-rate', 'erosionRate', 'erosion-rate-val');
  bindSlider('capacity-factor', 'capacityFactor', 'capacity-factor-val');
  bindSlider('deposition-rate', 'depositionRate', 'deposition-rate-val');
  bindSlider('evaporation', 'evaporation', 'evaporation-val');
  bindSlider('terrain-scale', 'terrainScale', 'terrain-scale-val');
  bindSlider('terrain-sand-height', 'terrainSandHeight', 'terrain-sand-height-val');
  bindSlider('flat-rock-height', 'flatRockHeight', 'flat-rock-height-val');
  bindSlider('terrain-sharpness', 'terrainSharpness', 'terrain-sharpness-val');
  bindSlider('terrain-tilt', 'terrainTilt', 'terrain-tilt-val');
  bindSlider('fbm-octaves', 'fbmOctaves', 'fbm-octaves-val');
  bindSlider('fbm-persistence', 'fbmPersistence', 'fbm-persistence-val');
  bindSlider('rain-quantity', 'rainQuantity', 'rain-quantity-val');
  bindSlider('rain-size', 'rainSize', 'rain-size-val');
  bindSlider('border-water-height', 'borderWaterHeight', 'border-water-height-val');
  bindSlider('min-water-depth', 'minWaterDepth', 'min-water-depth-val');
  bindSlider('render-resolution', 'renderResolution', 'render-resolution-val');
  bindSlider('sim-speed', 'simSpeed', 'sim-speed-val');

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
      gpgpu.resetTerrain(false);
    });
  }

  // 5.5 Nouveau Terrain
  const newTerrainBtn = document.getElementById('btn-new-terrain');
  if (newTerrainBtn) {
    newTerrainBtn.addEventListener('click', () => {
      gpgpu.resetTerrain(true);
    });
  }

  // 6. Render Layer Checkboxes
  const bindCheckbox = (id: string, configKey: 'showRock' | 'showSand' | 'showWater' | 'showLava' | 'showSuspendedSand') => {
    const chk = document.getElementById(id) as HTMLInputElement;
    if (!chk) return;
    chk.checked = config[configKey];
    chk.addEventListener('change', () => {
      config[configKey] = chk.checked;
    });
  };

  bindCheckbox('chk-show-rock', 'showRock');
  bindCheckbox('chk-show-sand', 'showSand');
  bindCheckbox('chk-show-water', 'showWater');
  bindCheckbox('chk-show-lava', 'showLava');
  bindCheckbox('chk-show-suspended', 'showSuspendedSand');

  // 6.5. Border Behavior Dropdown Select
  const borderSelect = document.getElementById('border-behavior') as HTMLSelectElement;
  const borderHeightGroup = document.getElementById('border-water-height-group');
  const updateBorderHeightVisibility = () => {
    if (borderHeightGroup) {
      if (config.borderBehavior > 0.5) {
        borderHeightGroup.style.display = 'block';
      } else {
        borderHeightGroup.style.display = 'none';
      }
    }
  };

  if (borderSelect) {
    borderSelect.value = config.borderBehavior.toString();
    updateBorderHeightVisibility();
    borderSelect.addEventListener('change', () => {
      config.borderBehavior = parseInt(borderSelect.value);
      updateBorderHeightVisibility();
    });
  }

  // 6.6. Terrain Generation Dropdown Select
  const terrainGenSelect = document.getElementById('terrain-generation') as HTMLSelectElement;
  const terrainNoiseSettings = document.getElementById('terrain-noise-settings');
  const flatRockHeightGroup = document.getElementById('flat-rock-height-group');
  const updateTerrainSettingsVisibility = () => {
    if (config.terrainType === 0) {
      if (terrainNoiseSettings) terrainNoiseSettings.style.display = 'block';
      if (flatRockHeightGroup) flatRockHeightGroup.style.display = 'none';
    } else {
      if (terrainNoiseSettings) terrainNoiseSettings.style.display = 'none';
      if (flatRockHeightGroup) flatRockHeightGroup.style.display = 'block';
    }
  };

  if (terrainGenSelect) {
    terrainGenSelect.value = config.terrainType === 0 ? 'realiste' : 'plat';
    updateTerrainSettingsVisibility();
    terrainGenSelect.addEventListener('change', () => {
      config.terrainType = terrainGenSelect.value === 'realiste' ? 0 : 1;
      updateTerrainSettingsVisibility();
      gpgpu.resetTerrain(config.terrainType === 0);
    });
  }

  // 7. Auto Rotate Camera checkbox
  const rotateCheck = document.getElementById('auto-rotate') as HTMLInputElement;
  if (rotateCheck) {
    rotateCheck.addEventListener('change', () => {
      config.autoRotate = rotateCheck.checked;
    });
  }

  // 8. Rain Active checkbox
  const rainCheck = document.getElementById('rain-active') as HTMLInputElement;
  if (rainCheck) {
    rainCheck.checked = config.rainActive;
    rainCheck.addEventListener('change', () => {
      config.rainActive = rainCheck.checked;
    });
  }

  // 8.5. Smooth Rendering checkbox
  const smoothCheck = document.getElementById('smooth-rendering') as HTMLInputElement;
  if (smoothCheck) {
    smoothCheck.checked = config.smoothRendering;
    smoothCheck.addEventListener('change', () => {
      config.smoothRendering = smoothCheck.checked;
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
  const moveSpeed = 1.0 / 3.0;
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
  if (!isFPSLooking) {
    controls.update();
  }

  // Run GPGPU physical simulation ticks
  if (!config.paused) {
    simTicksAccumulator += config.simSpeed;

    while (simTicksAccumulator >= 1.0) {
      // Sync current pointer coordinates onto the simulation pass
      gpgpu.setBrush(
        isPointerDown,
        pointerUV,
        activeBrushType,
        config.brushRadius,
        config.brushStrength
      );
      gpgpu.step();
      simTicksAccumulator -= 1.0;
    }
  } else {
    // If paused, we still allow drawing terrain & painting, just not fluid flows
    gpgpu.setBrush(
      isPointerDown,
      pointerUV,
      activeBrushType,
      config.brushRadius,
      config.brushStrength
    );
    // When paused we do a dry simulation step so the brush stroke shows up immediately
    const tempWaterGravity = config.waterGravity;
    const tempWaterDamping = config.waterDamping;
    const tempLavaGravity = config.lavaGravity;
    const tempLavaDamping = config.lavaDamping;
    const tempSand = config.sandSlideRate;
    const tempErosion = config.erosionRate;
    const tempDeposition = config.depositionRate;
    const tempEvap = config.evaporation;
    const tempRain = config.rainActive;

    config.waterGravity = 0.0;
    config.waterDamping = 0.0;
    config.lavaGravity = 0.0;
    config.lavaDamping = 0.0;
    config.sandSlideRate = 0.0;
    config.erosionRate = 0.0;
    config.depositionRate = 0.0;
    config.evaporation = 0.0;
    config.rainActive = false;
    gpgpu.step();

    config.waterGravity = tempWaterGravity;
    config.waterDamping = tempWaterDamping;
    config.lavaGravity = tempLavaGravity;
    config.lavaDamping = tempLavaDamping;
    config.sandSlideRate = tempSand;
    config.erosionRate = tempErosion;
    config.depositionRate = tempDeposition;
    config.evaporation = tempEvap;
    config.rainActive = tempRain;
  }

  // Fixed Noon Sun Direction & Lighting
  const sunPos = new THREE.Vector3(0.0, 1.0, 0.5).normalize();
  sunLight.position.copy(sunPos);

  const sunColor = new THREE.Color(1.0, 0.95, 0.85);
  sunLight.color.copy(sunColor);

  const skyColor = new THREE.Color(0.2, 0.45, 0.75);
  renderer.setClearColor(skyColor);
  scene.background = skyColor;

  terrainMaterial.uniforms.u_texA.value = gpgpu.targetA_read.texture;
  terrainMaterial.uniforms.u_texB.value = gpgpu.targetB_read.texture;
  terrainMaterial.uniforms.u_height_scale.value = config.heightScale;
  terrainMaterial.uniforms.u_time.value = now * 0.001;
  terrainMaterial.uniforms.u_smooth.value = config.smoothRendering ? 1.0 : 0.0;
  terrainMaterial.uniforms.u_border_behavior.value = config.borderBehavior;
  terrainMaterial.uniforms.u_border_water_height.value = config.borderWaterHeight;

  fluidMaterial.uniforms.u_texA.value = gpgpu.targetA_read.texture;
  fluidMaterial.uniforms.u_texB.value = gpgpu.targetB_read.texture;
  fluidMaterial.uniforms.u_texFlux.value = gpgpu.targetFlux_read.texture;
  fluidMaterial.uniforms.u_texLavaFlux.value = gpgpu.targetLavaFlux_read.texture;
  fluidMaterial.uniforms.u_height_scale.value = config.heightScale;
  fluidMaterial.uniforms.u_time.value = now * 0.001;
  fluidMaterial.uniforms.u_smooth.value = config.smoothRendering ? 1.0 : 0.0;
  fluidMaterial.uniforms.u_border_behavior.value = config.borderBehavior;
  fluidMaterial.uniforms.u_border_water_height.value = config.borderWaterHeight;

  // Pass local light directions and camera position vectors to ShaderMaterial
  const localSun = terrainMesh.worldToLocal(sunLight.position.clone()).normalize();
  terrainMaterial.uniforms.u_sun_dir.value.copy(localSun);
  terrainMaterial.uniforms.u_sun_color.value.copy(sunColor);

  fluidMaterial.uniforms.u_sun_dir.value.copy(localSun);
  fluidMaterial.uniforms.u_sun_color.value.copy(sunColor);

  const localCam = terrainMesh.worldToLocal(camera.position.clone());
  terrainMaterial.uniforms.u_local_camera_pos.value.copy(localCam);
  fluidMaterial.uniforms.u_local_camera_pos.value.copy(localCam);

  // Update rendering layer visibility uniforms
  terrainMaterial.uniforms.u_show_rock.value = config.showRock ? 1.0 : 0.0;
  terrainMaterial.uniforms.u_show_sand.value = config.showSand ? 1.0 : 0.0;
  terrainMaterial.uniforms.u_show_water.value = config.showWater ? 1.0 : 0.0;
  terrainMaterial.uniforms.u_show_lava.value = config.showLava ? 1.0 : 0.0;
  terrainMaterial.uniforms.u_show_suspended.value = config.showSuspendedSand ? 1.0 : 0.0;

  fluidMaterial.uniforms.u_show_rock.value = config.showRock ? 1.0 : 0.0;
  fluidMaterial.uniforms.u_show_sand.value = config.showSand ? 1.0 : 0.0;
  fluidMaterial.uniforms.u_show_water.value = config.showWater ? 1.0 : 0.0;
  fluidMaterial.uniforms.u_show_lava.value = config.showLava ? 1.0 : 0.0;
  fluidMaterial.uniforms.u_show_suspended.value = config.showSuspendedSand ? 1.0 : 0.0;

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
