import { config } from './config';

type WeatherNumberKey =
  | 'airTemperature'
  | 'relativeHumidity'
  | 'airStability'
  | 'convectionStrength'
  | 'windSpeed'
  | 'windDirection'
  | 'solarHeating'
  | 'heatingContrast'
  | 'evaporationRate'
  | 'sunElevation'
  | 'sunAzimuth'
  | 'radiativeCooling'
  | 'atmosphereTimeScale'
  | 'atmosphereSlice'
  | 'cloudOpacity'
  | 'thermalOpacity'
  | 'thermalHeight';

type WeatherForcing = Pick<
  typeof config,
  'airTemperature' | 'relativeHumidity' | 'windSpeed' | 'windDirection' | 'solarHeating'
>;

const weatherPresets: Record<string, WeatherForcing> = {
  mild: {
    airTemperature: 8,
    relativeHumidity: 0.75,
    windSpeed: 0,
    windDirection: 45,
    solarHeating: 1,
  },
  snow: {
    airTemperature: -12,
    relativeHumidity: 1.2,
    windSpeed: 10,
    windDirection: 45,
    solarHeating: 0.2,
  },
  thaw: {
    airTemperature: 22,
    relativeHumidity: 0.45,
    windSpeed: 5,
    windDirection: 45,
    solarHeating: 2,
  },
  storm: {
    airTemperature: 5,
    relativeHumidity: 1.3,
    windSpeed: 24,
    windDirection: 135,
    solarHeating: 0.3,
  },
};

/** Bind the weather HUD without coupling controls to the GPU implementation. */
export function setupWeatherControls(resetWeather: (clearSurface?: boolean) => void): void {
  const syncControls: Array<() => void> = [];
  const presetButtons = document.querySelectorAll<HTMLButtonElement>('[data-weather-preset]');
  const status = document.getElementById('weather-status');

  const updateStatus = (message?: string) => {
    if (!status) return;
    status.textContent = !config.atmosphereEnabled
      ? 'Weather disabled · atmospheric state is held'
      : config.paused
        ? 'Simulation paused · camera and diagnostic views remain available'
        : (message ??
          (config.emergentWeather
            ? 'Emergent weather · sunlight and heat exchanges drive the air'
            : config.closedWaterCycle
              ? 'Imposed heat and wind · atmospheric water stays in the closed cycle'
              : 'Imposed weather · air relaxes toward the selected conditions'));
  };

  const updatePresetSelection = () => {
    presetButtons.forEach((button) => {
      const preset = weatherPresets[button.dataset.weatherPreset ?? ''];
      const selected =
        preset !== undefined &&
        Object.entries(preset).every(
          ([key, value]) => config[key as keyof WeatherForcing] === value
        );
      button.setAttribute('aria-pressed', String(selected));
    });
  };

  const bindSlider = (
    id: string,
    key: WeatherNumberKey,
    format: (value: number) => string,
    displayScale = 1
  ) => {
    const slider = document.getElementById(id) as HTMLInputElement | null;
    const output = document.getElementById(`${id}-val`);
    if (!slider) return;
    const sync = () => {
      slider.value = String(config[key] * displayScale);
      if (output) output.textContent = format(config[key]);
      slider.setAttribute('aria-valuetext', format(config[key]));
    };
    syncControls.push(sync);
    slider.addEventListener('input', () => {
      const parsedValue = Number(slider.value);
      if (!Number.isFinite(parsedValue) || slider.disabled) return;
      config[key] =
        Math.max(Number(slider.min), Math.min(Number(slider.max), parsedValue)) / displayScale;
      sync();
      updatePresetSelection();
      updateStatus();
    });
  };

  bindSlider('air-temperature', 'airTemperature', (value) => `${value.toFixed(0)} °C`);
  bindSlider(
    'relative-humidity',
    'relativeHumidity',
    (value) => `${Math.round(value * 100)}%`,
    100
  );
  bindSlider('wind-speed', 'windSpeed', (value) => `${value.toFixed(0)} u/s`);
  bindSlider('air-stability', 'airStability', (value) => `${(value * 100).toFixed(1)}%`, 100);
  bindSlider('convection-strength', 'convectionStrength', (value) => `${value.toFixed(1)}×`);
  bindSlider('wind-direction', 'windDirection', (value) => `${value.toFixed(0)}°`);
  bindSlider('solar-heating', 'solarHeating', (value) => `${value.toFixed(1)}×`);
  bindSlider('heating-contrast', 'heatingContrast', (value) => `${value.toFixed(1)}×`);
  bindSlider('evaporation-rate', 'evaporationRate', (value) => `${value.toFixed(2)}×`);
  bindSlider('sun-elevation', 'sunElevation', (value) => `${value.toFixed(0)}°`);
  bindSlider('sun-azimuth', 'sunAzimuth', (value) => `${value.toFixed(0)}°`);
  bindSlider('radiative-cooling', 'radiativeCooling', (value) => `${value.toFixed(1)}×`);
  bindSlider('atmosphere-time-scale', 'atmosphereTimeScale', (value) => `${value.toFixed(2)}×`);
  bindSlider('atmosphere-slice', 'atmosphereSlice', (value) => `${Math.round(value * 100)}%`, 100);
  bindSlider('cloud-opacity', 'cloudOpacity', (value) => `${Math.round(value * 100)}%`, 100);
  bindSlider('thermal-opacity', 'thermalOpacity', (value) => `${Math.round(value * 100)}%`, 100);
  bindSlider('thermal-height', 'thermalHeight', (value) => `${value.toFixed(2)} u`);

  const bindCheckbox = (id: string, key: 'atmosphereEnabled' | 'showWind') => {
    const checkbox = document.getElementById(id) as HTMLInputElement | null;
    if (!checkbox) return;
    syncControls.push(() => {
      checkbox.checked = config[key];
    });
    checkbox.addEventListener('change', () => {
      config[key] = checkbox.checked;
      updateStatus();
    });
  };

  bindCheckbox('atmosphere-enabled', 'atmosphereEnabled');
  bindCheckbox('show-wind', 'showWind');

  const dynamics = document.getElementById('weather-dynamics') as HTMLSelectElement;
  const syncDynamics = () => {
    dynamics.value = config.emergentWeather ? 'emergent' : 'forced';
    for (const [id, label] of [
      ['air-temperature', 'air temperature'],
      ['relative-humidity', 'humidity'],
      ['air-stability', 'lower-air stability'],
      ['wind-speed', 'wind speed'],
      ['wind-direction', 'wind heading'],
    ]) {
      const element = document.querySelector(`label[for="${id}"]`);
      if (element) {
        const initialOnly =
          id === 'air-stability' ||
          config.emergentWeather ||
          (id === 'relative-humidity' && config.closedWaterCycle);
        element.textContent = `${initialOnly ? 'Initial' : 'Imposed'} ${label}`;
        const effect = element.closest('.control-group')?.querySelector('.effect-badge');
        if (effect) effect.textContent = initialOnly ? 'Initial conditions' : 'Live';
      }
    }
    const restartDisabled = !config.emergentWeather && !config.closedWaterCycle;
    (document.getElementById('btn-weather-restart-air') as HTMLButtonElement).disabled =
      restartDisabled;
    document.getElementById('restart-air-availability')!.hidden = !restartDisabled;
    document.getElementById('weather-dynamics-help')!.textContent = config.emergentWeather
      ? 'Air starts horizontally uniform and evolves freely. Initial values apply on Restart air or a preset; snow and water are preserved. Convection response, sunlight and cooling remain live.'
      : config.closedWaterCycle
        ? 'Temperature and wind are imposed. Humidity is an initial condition only: Restart air applies it and starts a new water balance.'
        : 'Air continuously relaxes toward the selected temperature, humidity and wind; humidity forcing exchanges water with an external reservoir.';
  };
  syncControls.push(syncDynamics);
  dynamics.addEventListener('change', () => {
    config.emergentWeather = dynamics.value === 'emergent';
    syncDynamics();
    updateStatus();
  });
  document.getElementById('btn-weather-restart-air')?.addEventListener('click', () => {
    resetWeather(false);
    updateStatus('Air restarted · ground water preserved · new water balance');
  });

  const cycle = document.getElementById('closed-water-cycle') as HTMLInputElement;
  const atmosphereBoundary = document.getElementById('atmosphere-boundary') as HTMLSelectElement;
  const syncBoundaries = () => {
    atmosphereBoundary.value = String(config.atmosphereBoundary);
    document.getElementById('atmosphere-boundary-help')!.textContent =
      config.atmosphereBoundary === 0
        ? 'Air leaving one horizontal edge returns at the opposite edge with its water. Ground and ceiling are closed.'
        : 'Air cannot cross the horizontal walls. Ground and ceiling are also closed; water stays inside.';
  };
  const syncWaterCycle = () => {
    cycle.checked = config.closedWaterCycle;
    document.getElementById('water-cycle-help')!.textContent = config.closedWaterCycle
      ? 'Water cycles through vapor, clouds, precipitation, liquid, snow and ice. Surface edges are sealed; manual rain and humidity forcing are suspended. Evaporation returns water to the air.'
      : 'Open water budget: manual rain, humidity forcing and surface edge exchanges follow their controls. Atmospheric boundaries still wrap or remain closed.';

    // Display effective settings without losing the user's chosen open-mode settings.
    const rain = document.getElementById('rain-active') as HTMLInputElement;
    rain.disabled = config.closedWaterCycle;
    rain.checked = !config.closedWaterCycle && config.rainActive;
    for (const id of ['rain-quantity', 'rain-size', 'border-water-height']) {
      const input = document.getElementById(id) as HTMLInputElement;
      input.disabled = config.closedWaterCycle;
    }
    const border = document.getElementById('border-behavior') as HTMLSelectElement;
    border.disabled = config.closedWaterCycle;
    border.value = config.closedWaterCycle ? '0' : String(config.borderBehavior);
    const borderHeight = document.getElementById('border-water-height') as HTMLInputElement;
    borderHeight.disabled = config.closedWaterCycle || config.borderBehavior === 0;
    document.getElementById('surface-boundary-help')!.textContent = config.closedWaterCycle
      ? 'Surface edges are sealed by Closed water cycle. Your open-mode border settings are retained.'
      : 'These surface settings may exchange water with the outside. Atmospheric boundaries are configured separately.';
    document.getElementById('manual-rain-help')!.textContent = config.closedWaterCycle
      ? 'Suspended by Closed water cycle. Rain forms from existing atmospheric water; your manual rain settings are retained.'
      : 'Manual rain is an external water source independent of atmospheric condensation.';
    const evaporationLabel = document.querySelector('label[for="evaporation"]');
    if (evaporationLabel)
      evaporationLabel.textContent = config.closedWaterCycle
        ? 'Extra evaporation (returned to air)'
        : 'Water Evaporation';
    syncDynamics();
  };
  syncControls.push(syncBoundaries, syncWaterCycle);
  cycle.addEventListener('change', () => {
    config.closedWaterCycle = cycle.checked;
    syncWaterCycle();
    updateStatus();
  });
  atmosphereBoundary.addEventListener('change', () => {
    const value = Number(atmosphereBoundary.value);
    if (value !== 0 && value !== 1) return;
    config.atmosphereBoundary = value;
    syncBoundaries();
  });

  const view = document.getElementById('atmosphere-view') as HTMLSelectElement | null;
  const sliceGroup = document.getElementById('atmosphere-slice-group');
  const legend = document.getElementById('atmosphere-legend');
  const syncView = () => {
    if (view) view.value = String(config.atmosphereView);
    if (sliceGroup) sliceGroup.hidden = false;
    const slice = document.getElementById('atmosphere-slice') as HTMLInputElement;
    slice.disabled = config.atmosphereView === 0;
    if (legend) {
      legend.textContent =
        [
          '',
          '−30 °C: blue → 0 °C: cyan/yellow → +35 °C: red',
          '0%: dry brown → 100%: saturated cyan · White: cloud water',
          '0 u/s: blue → 12: green/cyan → 32: orange',
        ][config.atmosphereView] ?? '';
    }
  };
  syncControls.push(syncView);
  const thermalOpacity = document.getElementById('thermal-opacity') as HTMLInputElement;
  const thermalMode = document.getElementById('thermal-mode') as HTMLSelectElement;
  const syncThermal = () => {
    config.thermalOverlay = config.thermalOpacity > 0;
    thermalOpacity.value = String(config.thermalOpacity * 100);
    thermalMode.value = config.thermalAir ? 'air' : 'surface';
    document.getElementById('thermal-controls')!.hidden = false;
    thermalMode.disabled = false;
    (document.getElementById('thermal-height') as HTMLInputElement).disabled =
      !config.thermalOverlay || !config.thermalAir;
    document.getElementById('thermal-legend')!.hidden = !config.thermalOverlay;
    document.getElementById('thermal-legend-title')!.textContent = config.thermalAir
      ? `Air +${config.thermalHeight.toFixed(2)} u above surface · °C`
      : 'Surface temperature · °C';
  };
  syncControls.push(syncThermal);
  thermalOpacity.addEventListener('input', () => {
    config.thermalOverlay = config.thermalOpacity > 0;
    if (config.thermalOverlay) {
      config.atmosphereView = 0;
      syncView();
    }
    syncThermal();
  });
  thermalMode.addEventListener('change', () => {
    config.thermalAir = thermalMode.value === 'air';
    syncThermal();
  });
  document.getElementById('thermal-height')!.addEventListener('input', syncThermal);
  view?.addEventListener('change', () => {
    const selected = Number(view.value);
    if (![0, 1, 2, 3].includes(selected)) return;
    config.atmosphereView = selected;
    if (selected !== 0) {
      config.thermalOpacity = 0;
      config.thermalOverlay = false;
      syncThermal();
    }
    syncView();
  });

  presetButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const preset = weatherPresets[button.dataset.weatherPreset ?? ''];
      if (!preset) return;
      // Preserve accumulated snow and ice so a thaw acts on the current landscape.
      Object.assign(config, preset, { atmosphereEnabled: true });
      if (config.emergentWeather || config.closedWaterCycle) resetWeather(false);
      syncControls.forEach((sync) => sync());
      updatePresetSelection();
      updateStatus(
        config.emergentWeather || config.closedWaterCycle
          ? 'Initial air applied · ground water preserved · new water balance'
          : 'Weather conditions applied · existing snow and ice are preserved'
      );
    });
  });

  document.getElementById('btn-weather-reset')?.addEventListener('click', () => {
    resetWeather();
    updateStatus('Weather reset · snow and ice cleared · new water balance');
  });

  // setupUI binds the shared pause state before these weather-specific controls.
  document.getElementById('btn-pause')?.addEventListener('click', () => updateStatus());

  syncControls.forEach((sync) => sync());
  updatePresetSelection();
  updateStatus();
}
