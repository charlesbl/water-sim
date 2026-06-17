import * as THREE from 'three';
import { config } from './config';
import { GPGPUSimulation } from './webgpuRenderer';

// Core variables
let canvas: HTMLCanvasElement;
let camera: THREE.PerspectiveCamera;
let gpgpu: GPGPUSimulation;
let isPointerDown = false;
let pointerUV: THREE.Vector2 | null = null;
let activeBrushType: number = 0;

// Performance timing variables
let frameCount = 0;
let lastFpsUpdate = 0;
let simTicksAccumulator = 0.0;

// Free camera keyboard state
const keys = {
  w: false,
  a: false,
  s: false,
  d: false,
  q: false,
  e: false,
  shift: false,
  space: false,
};

/**
 * Initialize application lifecycle
 */
function init() {
  const container = document.getElementById('canvas-container');
  if (!container) return;

  // 1. Create native HTMLCanvasElement for WebGPU
  canvas = document.createElement('canvas');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  container.appendChild(canvas);

  // 2. Perspective Camera
  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 100, 150);

  // 4. WebGPU Simulation & Rendering Engine
  gpgpu = new GPGPUSimulation(canvas, config.gridSize);
  gpgpu.initWebGPU().then((success) => {
    if (!success) {
      alert("Ce navigateur ne supporte pas WebGPU ou WebGPU n'est pas activé.");
      return;
    }

    // Bind HUD UI controls to script logic
    setupUI();

    // Run initial terrain generation
    gpgpu.resetTerrain();

    // Begin frame loops
    animate();
  });

  // 5. Event Listeners
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
      case 'KeyQ':
        keys.q = true;
        break;
      case 'KeyE':
        keys.e = true;
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
      case 'KeyQ':
        keys.q = false;
        break;
      case 'KeyE':
        keys.e = false;
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
}

/**
 * Handle browser window resize events
 */
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

/**
 * Pointer raycast calculation using WebGPU GPU picking
 */
function updatePointerUV(e: PointerEvent) {
  const x = Math.floor(e.clientX);
  const y = Math.floor(e.clientY);

  if (gpgpu) {
    gpgpu.performPicking(camera, x, y);
    pointerUV = gpgpu.pointerUV;
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
  }

  if (isPointerDown) {
    isPointerDown = false;
    pointerUV = null;
  }
}

/**
 * Setup and bind interactive HUD buttons & sliders
 */
function setupUI() {
  // Update footer text dynamically with actual grid size
  const perfDisplay = document.getElementById('perf-display');
  if (perfDisplay) {
    perfDisplay.innerHTML = `FPS: <span id="fps-val">60</span> | Grid: ${config.gridSize}x${config.gridSize}`;
  }

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
        gpgpu.initWebGPU();
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
  bindSlider(
    'sand-dynamic-repose-slope',
    'sandDynamicReposeSlope',
    'sand-dynamic-repose-slope-val'
  );
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
      pauseBtn.textContent = config.paused ? '▶️ Resume' : '⏸️ Pause';
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

  // 5.5 New Terrain
  const newTerrainBtn = document.getElementById('btn-new-terrain');
  if (newTerrainBtn) {
    newTerrainBtn.addEventListener('click', () => {
      gpgpu.resetTerrain(true);
    });
  }

  // 6. Render Layer Checkboxes
  const bindCheckbox = (
    id: string,
    configKey: 'showRock' | 'showSand' | 'showWater' | 'showLava' | 'showSuspendedSand'
  ) => {
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
    terrainGenSelect.value = config.terrainType === 0 ? 'realistic' : 'flat';
    updateTerrainSettingsVisibility();
    terrainGenSelect.addEventListener('change', () => {
      config.terrainType = terrainGenSelect.value === 'realistic' ? 0 : 1;
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
  let speedMultiplier = 1.0;
  if (keys.space) {
    speedMultiplier = 3.0;
  } else if (keys.shift) {
    speedMultiplier = 0.3;
  }
  const moveSpeed = (1.0 / 3.0) * speedMultiplier;
  const localMove = new THREE.Vector3();

  if (keys.w) localMove.z -= 1;
  if (keys.s) localMove.z += 1;
  if (keys.a) localMove.x -= 1;
  if (keys.d) localMove.x += 1;
  if (keys.q) localMove.y -= 1;
  if (keys.e) localMove.y += 1;

  if (localMove.lengthSq() > 0) {
    localMove.normalize().multiplyScalar(moveSpeed);
    localMove.applyQuaternion(camera.quaternion);
    camera.position.add(localMove);
  }

  if (config.autoRotate && !isFPSLooking) {
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    euler.setFromQuaternion(camera.quaternion);
    euler.y -= 0.005;
    camera.quaternion.setFromEuler(euler);
  }

  // Ensure camera matrices are updated for WebGPU
  camera.updateMatrixWorld();

  // Run GPGPU physical simulation ticks
  if (!config.paused) {
    simTicksAccumulator += config.simSpeed;

    while (simTicksAccumulator >= 1.0) {
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
    gpgpu.setBrush(
      isPointerDown,
      pointerUV,
      activeBrushType,
      config.brushRadius,
      config.brushStrength
    );
    gpgpu.step();
  }

  // Render Scene using WebGPU
  gpgpu.render(camera);

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

// Start WebGPU initialization
window.addEventListener('DOMContentLoaded', () => {
  init();
});
