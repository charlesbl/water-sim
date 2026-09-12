import { config } from './config';
import { defaultConfig } from './preferences';
import { addParameterReset } from './parameterReset';
import { ATMOSPHERE_DIMENSIONS } from './atmosphere';
import { setupReposeControls } from './reposeControls';

/** The UI only requests existing simulation actions; it does not own GPU state. */
export interface SimulationActions {
  resetTerrain(newSeed?: boolean): void;
  clearFluids(): void;
  rebuildMesh(): void;
}

/**
 * Setup and bind interactive HUD buttons & sliders
 */
export function setupSimulationControls(actions: SimulationActions): void {
  // Update footer text dynamically with actual grid size
  const perfDisplay = document.getElementById('perf-display');
  if (perfDisplay) {
    perfDisplay.textContent = `Surface: ${config.gridSize}×${config.gridSize} · Atmosphere: ${ATMOSPHERE_DIMENSIONS.join('×')}`;
  }

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
      | 'terrainSoilHeight'
      | 'sedimentSlideRate'
      | 'erosionRate'
      | 'capacityFactor'
      | 'depositionRate'
      | 'terrainScale'
      | 'terrainSharpness'
      | 'terrainTilt'
      | 'terrainSandHeight'
      | 'flatRockHeight'
      | 'fbmOctaves'
      | 'fbmPersistence'
      | 'minWaterDepth'
      | 'renderResolution'
      | 'simSpeed',
    displayId?: string
  ) => {
    const slider = document.getElementById(id) as HTMLInputElement;
    const valDisplay = displayId ? document.getElementById(displayId) : null;
    if (!slider) return;

    // Sync initial state from config
    slider.value = config[configKey].toString();
    if (valDisplay) {
      valDisplay.textContent = config[configKey].toFixed(
        slider.step.includes('.') ? slider.step.split('.')[1].length : 0
      );
    }

    const apply = (val: number) => {
      if (!Number.isFinite(val)) return;
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
          'terrainSoilHeight',
          'flatRockHeight',
          'fbmOctaves',
          'fbmPersistence',
        ].includes(configKey)
      ) {
        actions.resetTerrain(false);
      }

      if (configKey === 'renderResolution') {
        actions.rebuildMesh();
      }
    };
    slider.addEventListener('input', () => {
      if (!slider.disabled) apply(parseFloat(slider.value));
    });
    addParameterReset(slider, () => {
      slider.value = String(defaultConfig[configKey]);
      apply(defaultConfig[configKey]);
    }, () => config[configKey] === defaultConfig[configKey], () => config[configKey]);
  };

  bindSlider('brush-radius', 'brushRadius', 'brush-radius-val');
  bindSlider('brush-strength', 'brushStrength', 'brush-strength-val');
  bindSlider('water-gravity', 'waterGravity', 'water-gravity-val');
  bindSlider('water-damping', 'waterDamping', 'water-damping-val');
  bindSlider('lava-gravity', 'lavaGravity', 'lava-gravity-val');
  bindSlider('lava-damping', 'lavaDamping', 'lava-damping-val');
  bindSlider('terrain-soil-height', 'terrainSoilHeight', 'terrain-soil-height-val');
  bindSlider('sediment-slide', 'sedimentSlideRate', 'sediment-slide-val');
  setupReposeControls();
  bindSlider('erosion-rate', 'erosionRate', 'erosion-rate-val');
  bindSlider('capacity-factor', 'capacityFactor', 'capacity-factor-val');
  bindSlider('deposition-rate', 'depositionRate', 'deposition-rate-val');
  bindSlider('terrain-scale', 'terrainScale', 'terrain-scale-val');
  bindSlider('terrain-sand-height', 'terrainSandHeight', 'terrain-sand-height-val');
  bindSlider('flat-rock-height', 'flatRockHeight', 'flat-rock-height-val');
  bindSlider('terrain-sharpness', 'terrainSharpness', 'terrain-sharpness-val');
  bindSlider('terrain-tilt', 'terrainTilt', 'terrain-tilt-val');
  bindSlider('fbm-octaves', 'fbmOctaves', 'fbm-octaves-val');
  bindSlider('fbm-persistence', 'fbmPersistence', 'fbm-persistence-val');
  bindSlider('min-water-depth', 'minWaterDepth', 'min-water-depth-val');
  bindSlider('render-resolution', 'renderResolution', 'render-resolution-val');
  bindSlider('sim-speed', 'simSpeed', 'sim-speed-val');

  // 3. Pause / Play button
  const pauseBtn = document.getElementById('btn-pause') as HTMLButtonElement;
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      config.paused = !config.paused;
      pauseBtn.querySelector('span')!.textContent = config.paused ? 'Resume' : 'Pause';
      pauseBtn.querySelector('use')!.setAttribute('href', config.paused ? '#i-play' : '#i-pause');
      pauseBtn.setAttribute('aria-pressed', String(config.paused));
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
      actions.clearFluids();
    });
  }

  // 5. Reset Terrain
  const resetBtn = document.getElementById('btn-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      actions.resetTerrain(false);
    });
  }

  // 5.5 New Terrain
  const newTerrainBtn = document.getElementById('btn-new-terrain');
  if (newTerrainBtn) {
    newTerrainBtn.addEventListener('click', () => {
      actions.resetTerrain(true);
    });
  }

  // 6. Render Layer Checkboxes
  const bindCheckbox = (
    id: string,
    configKey: 'showRock' | 'showSoil' | 'showSand' | 'showWater' | 'showLava' | 'showSuspendedSand'
  ) => {
    const chk = document.getElementById(id) as HTMLInputElement;
    if (!chk) return;
    addParameterReset(chk, () => {
      config[configKey] = defaultConfig[configKey];
      chk.checked = config[configKey];
    }, () => config[configKey] === defaultConfig[configKey]);
    chk.checked = config[configKey];
    chk.addEventListener('change', () => {
      config[configKey] = chk.checked;
    });
  };

  bindCheckbox('chk-show-rock', 'showRock');
  bindCheckbox('chk-show-soil', 'showSoil');
  bindCheckbox('chk-show-sand', 'showSand');
  bindCheckbox('chk-show-water', 'showWater');
  bindCheckbox('chk-show-lava', 'showLava');
  bindCheckbox('chk-show-suspended', 'showSuspendedSand');

  // 6.6. Terrain Generation Dropdown Select
  const terrainGenSelect = document.getElementById('terrain-generation') as HTMLSelectElement;
  const terrainNoiseSettings = document.getElementById('terrain-noise-settings');
  const flatRockHeightGroup = document.getElementById('flat-rock-height-group');
  const updateTerrainSettingsVisibility = () => {
    terrainNoiseSettings
      ?.querySelectorAll<HTMLInputElement>('input[type="range"]')
      .forEach((input) => {
        input.disabled = config.terrainType !== 0;
      });
    const flatInput = flatRockHeightGroup?.querySelector<HTMLInputElement>('input[type="range"]');
    if (flatInput) flatInput.disabled = config.terrainType !== 1;
  };

  if (terrainGenSelect) {
    terrainGenSelect.value = config.terrainType === 0 ? 'realistic' : 'flat';
    updateTerrainSettingsVisibility();
    addParameterReset(terrainGenSelect, () => {
      config.terrainType = defaultConfig.terrainType;
      terrainGenSelect.value = config.terrainType === 0 ? 'realistic' : 'flat';
      updateTerrainSettingsVisibility();
      actions.resetTerrain(false);
    }, () => config.terrainType === defaultConfig.terrainType);
    terrainGenSelect.addEventListener('change', () => {
      config.terrainType = terrainGenSelect.value === 'realistic' ? 0 : 1;
      updateTerrainSettingsVisibility();
      actions.resetTerrain(config.terrainType === 0);
    });
  }

  // 8.5. Smooth Rendering checkbox
  const smoothCheck = document.getElementById('smooth-rendering') as HTMLInputElement;
  if (smoothCheck) {
    addParameterReset(smoothCheck, () => {
      config.smoothRendering = defaultConfig.smoothRendering;
      smoothCheck.checked = config.smoothRendering;
    }, () => config.smoothRendering === defaultConfig.smoothRendering);
    smoothCheck.checked = config.smoothRendering;
    smoothCheck.addEventListener('change', () => {
      config.smoothRendering = smoothCheck.checked;
    });
  }
}
