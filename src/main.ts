import * as THREE from 'three';
import { preferences, restoreConfig, savePreferences } from './preferences';
import { config } from './config';
import { GPGPUSimulation } from './webgpuRenderer';
import { setupWeatherControls } from './weatherControls';
import { setupSimulationControls } from './simulationControls';
import { setupCommandUI, isUIEventTarget } from './commandUI';

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
let weatherAccumulator = 0;
let lastFrameTime = 0;
let simulationFailed = false;

function showSimulationError(message: string) {
  simulationFailed = true;
  const alert = document.getElementById('simulation-alert');
  if (alert) {
    alert.hidden = false;
    alert.textContent = 'WebGPU: ' + message;
  }
  const state = document.getElementById('runtime-state');
  if (state) state.textContent = 'Unavailable';
  const panel = document.getElementById('perf-display');
  if (panel) {
    panel.textContent = `WebGPU: ${message}`;
    panel.setAttribute('role', 'alert');
    panel.style.color = '#ffb4ab';
  }
}

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

  restoreConfig();

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
  camera.position.set(185, 155, 215);
  camera.lookAt(0, 35, 0);
  const savedCamera = preferences.camera;
  const validVector = (value: unknown, length: number): value is number[] =>
    Array.isArray(value) && value.length === length && value.every(Number.isFinite);
  if (
    savedCamera &&
    validVector(savedCamera.position, 3) &&
    validVector(savedCamera.quaternion, 4) &&
    savedCamera.quaternion.some((v) => v !== 0)
  ) {
    camera.position.fromArray(savedCamera.position);
    camera.quaternion.fromArray(savedCamera.quaternion).normalize();
  }
  const saveCamera = () =>
    savePreferences({
      camera: {
        position: camera.position.toArray(),
        quaternion: camera.quaternion.toArray(),
      },
    });
  window.setInterval(saveCamera, 250);
  window.addEventListener('pagehide', saveCamera);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveCamera();
  });

  // 4. WebGPU Simulation & Rendering Engine
  gpgpu = new GPGPUSimulation(canvas, config.gridSize);
  gpgpu
    .initWebGPU()
    .then((success) => {
      if (!success) {
        showSimulationError(
          'WebGPU is unavailable. Open this simulation in Chrome or Edge with graphics acceleration enabled.'
        );
        return;
      }

      // Bind the command surfaces to the existing simulation state
      setupSimulationControls(gpgpu);
      setupWeatherControls((clearSurface = true) => {
        weatherAccumulator = 0;
        gpgpu.resetWeather(clearSurface);
      });

      setupCommandUI();

      // Run initial terrain generation
      gpgpu.resetTerrain();

      // Begin frame loops
      animate();
    })
    .catch((error: unknown) => {
      console.error(error);
      showSimulationError(error instanceof Error ? error.message : String(error));
    });

  // 5. Event Listeners
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('simulation-error', ((event: CustomEvent<string>) => {
    showSimulationError(event.detail);
  }) as EventListener);

  window.addEventListener('keydown', (e) => {
    if (isUIEventTarget(e.target)) return;
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

  // Right click erases only in the world; native field menus remain usable.
  window.addEventListener('contextmenu', (e) => {
    if (e.target === canvas) e.preventDefault();
  });
  const releaseInputs = () => {
    for (const key of Object.keys(keys) as Array<keyof typeof keys>) keys[key] = false;
    isPointerDown = false;
    isFPSLooking = false;
    pointerUV = null;
  };
  window.addEventListener('blur', releaseInputs);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseInputs();
  });
  document.addEventListener('focusin', (e) => {
    if (isUIEventTarget(e.target)) releaseInputs();
  });

  // Interactive painting event listeners
  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
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
  // Every UI surface is excluded, including detached search results and legends.
  if (e.target !== canvas || isUIEventTarget(e.target)) return;

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
  if (isUIEventTarget(e.target)) {
    onPointerUp(e);
    return;
  }
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
 * Main animation & execution frame loop
 */
function animate() {
  if (simulationFailed) return;
  requestAnimationFrame(animate);

  const now = performance.now();
  const elapsed = lastFrameTime ? Math.min((now - lastFrameTime) / 1000, 0.1) : 1 / 60;
  lastFrameTime = now;

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

  // Ensure camera matrices are updated for WebGPU
  camera.updateMatrixWorld();

  // Run GPGPU physical simulation ticks
  if (!config.paused) {
    // Surface motion uses the same clock on fast and slow GPUs.
    simTicksAccumulator = Math.min(simTicksAccumulator + elapsed * 60 * config.simSpeed, 8);

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
    simTicksAccumulator = 0;
    gpgpu.setBrush(
      isPointerDown,
      pointerUV,
      activeBrushType,
      config.brushRadius,
      config.brushStrength
    );
    gpgpu.step();
  }

  // Fixed 30 Hz atmosphere; bounded catch-up avoids a backlog after inactive tabs.
  if (!config.paused && config.atmosphereEnabled) {
    const weatherDt = 1 / 30;
    weatherAccumulator = Math.min(
      weatherAccumulator + elapsed * config.simSpeed * config.atmosphereTimeScale,
      weatherDt * 4
    );
    let weatherSteps = 0;
    while (weatherAccumulator >= weatherDt) {
      gpgpu.stepAtmosphere(weatherDt);
      weatherAccumulator -= weatherDt;
      weatherSteps++;
    }
    if (!weatherSteps) gpgpu.stepAtmosphere(0);
  } else {
    weatherAccumulator = 0;
    gpgpu.stepAtmosphere(0);
  }

  // Render Scene using WebGPU
  gpgpu.render(camera);
  gpgpu.sampleWaterBudget();

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
