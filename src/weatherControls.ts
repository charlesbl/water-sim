import { config } from './config';
import { defaultConfig } from './preferences';
import { addParameterReset } from './parameterReset';

type WeatherNumberKey =
  | 'airTemperature'
  | 'relativeHumidity'
  | 'airStability'
  | 'convectionStrength'
  | 'windSpeed'
  | 'windDirection'
  | 'solarHeating'
  | 'airBuoyancy'
  | 'airDrag'
  | 'airViscosity'
  | 'pressureCycles'
  | 'surfaceAirHeatExchange'
  | 'evaporationRate'
  | 'sunElevation'
  | 'sunAzimuth'
  | 'radiativeCooling'
  | 'atmosphereTimeScale'
  | 'atmosphereSlice'
  | 'cloudOpacity'
  | 'viewOpacity'
  | 'weatherMapSizeKm'
  | 'weatherCellSizeKm'
  | 'weatherVariability'
  | 'weatherSeed'
  | 'rainLifetime'
  | 'condensationRate'
  | 'rainEvaporationRate'
  | 'orographicLift'
  | 'airMixing'
  | 'cloudAltitude'
  | 'cloudThickness'
  | 'cloudDetail'
  | 'cloudShadows'
  | 'rainVisibility';

/** Bind the weather HUD without coupling controls to the GPU implementation. */

export function setupWeatherControls(resetWeather: (clearSurface?: boolean) => void): void {
  const syncControls: Array<() => void> = [];

  const status = document.getElementById('weather-status');

  const updateStatus = (message?: string) => {
    const summary = document.getElementById('bottle-weather-summary');

    if (summary)
      summary.textContent = `${config.weatherMapSizeKm.toFixed(0)} km landscape · 256² × 2 layers · sealed walls`;

    if (!status) return;
    status.textContent = !config.atmosphereEnabled
      ? 'Weather disabled · atmospheric state is held'
      : config.paused
        ? 'Simulation paused · camera and diagnostic views remain available'
        : (message ?? 'Climate in a bottle · thermal circulation · sealed water cycle');
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
    addParameterReset(slider, () => {
      config[key] = defaultConfig[key];
      sync();
      if (key === 'viewOpacity') syncThermal();
      updateStatus();
    }, () => config[key] === defaultConfig[key], () => config[key] * displayScale);

    slider.addEventListener('input', () => {
      const parsedValue = Number(slider.value);

      if (!Number.isFinite(parsedValue) || slider.disabled) return;

      config[key] =
        Math.max(Number(slider.min), Math.min(Number(slider.max), parsedValue)) / displayScale;

      sync();

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

  bindSlider('wind-speed', 'windSpeed', (value) => `${value.toFixed(1)} km/min`);

  bindSlider('air-stability', 'airStability', (value) => `${(value * 100).toFixed(1)}%`, 100);

  bindSlider('convection-strength', 'convectionStrength', (value) => `${value.toFixed(1)}×`);

  bindSlider('wind-direction', 'windDirection', (value) => `${value.toFixed(0)}°`);

  bindSlider('solar-heating', 'solarHeating', (value) => `${value.toFixed(1)}×`);

  bindSlider('air-buoyancy', 'airBuoyancy', (value) => `${value.toFixed(1)}×`);
  bindSlider('air-drag', 'airDrag', (value) => `${value.toFixed(3)} /s`);
  bindSlider('air-viscosity', 'airViscosity', (value) => `${value.toFixed(3)}`);
  bindSlider('pressure-cycles', 'pressureCycles', (value) => `${value.toFixed(0)} / 6`);
  bindSlider('surface-air-heat-exchange', 'surfaceAirHeatExchange', (value) => `${value.toFixed(2)}`);

  bindSlider('evaporation-rate', 'evaporationRate', (value) => `${value.toFixed(2)}×`);

  bindSlider('sun-elevation', 'sunElevation', (value) => `${value.toFixed(0)}°`);

  bindSlider('sun-azimuth', 'sunAzimuth', (value) => `${value.toFixed(0)}°`);

  bindSlider('radiative-cooling', 'radiativeCooling', (value) => `${value.toFixed(1)}×`);

  bindSlider('atmosphere-time-scale', 'atmosphereTimeScale', (value) => `${value.toFixed(2)}×`);

  bindSlider('atmosphere-slice', 'atmosphereSlice', (value) =>
    value < 0.5 ? 'Lower air' : 'Cloud layer'
  );

  bindSlider('cloud-opacity', 'cloudOpacity', (value) => `${Math.round(value * 100)}%`, 100);

  bindSlider('view-opacity', 'viewOpacity', (value) => `${Math.round(value * 100)}%`, 100);

  bindSlider('weather-map-size', 'weatherMapSizeKm', (v) => `${v.toFixed(0)} km`);

  bindSlider('weather-cell-size', 'weatherCellSizeKm', (v) => `${v.toFixed(1)} km`);

  bindSlider('weather-variability', 'weatherVariability', (v) => `${v.toFixed(2)}×`);

  bindSlider('weather-seed', 'weatherSeed', (v) => `${v.toFixed(0)}`);

  bindSlider('rain-lifetime', 'rainLifetime', (v) => `${v.toFixed(0)} s`);

  bindSlider('condensation-rate', 'condensationRate', (v) => `${v.toFixed(1)} /s`);
  bindSlider('rain-evaporation-rate', 'rainEvaporationRate', (v) => `${v.toFixed(2)} /s`);

  bindSlider('orographic-lift', 'orographicLift', (v) => `${v.toFixed(1)}×`);

  bindSlider('air-mixing', 'airMixing', (v) => `${v.toFixed(3)} /s`);


  bindSlider('cloud-altitude', 'cloudAltitude', (v) => `${v.toFixed(2)} km`);

  bindSlider('cloud-thickness', 'cloudThickness', (v) => `${v.toFixed(2)} km`);

  bindSlider('cloud-detail', 'cloudDetail', (v) => `${Math.round(v * 100)}%`, 100);

  bindSlider('cloud-shadows', 'cloudShadows', (v) => `${Math.round(v * 100)}%`, 100);

  bindSlider('rain-visibility', 'rainVisibility', (v) => `${v.toFixed(1)}×`);

  const bindCheckbox = (id: string, key: 'atmosphereEnabled' | 'showWind') => {
    const checkbox = document.getElementById(id) as HTMLInputElement | null;

    if (!checkbox) return;

    syncControls.push(() => {
      checkbox.checked = config[key];
    });

    addParameterReset(checkbox, () => {
      config[key] = defaultConfig[key];
      checkbox.checked = config[key];
      updateStatus();
    }, () => config[key] === defaultConfig[key]);

    checkbox.addEventListener('change', () => {
      config[key] = checkbox.checked;

      updateStatus();
    });
  };

  bindCheckbox('atmosphere-enabled', 'atmosphereEnabled');

  bindCheckbox('show-wind', 'showWind');

  document.getElementById('btn-weather-restart-air')?.addEventListener('click', () => {
    resetWeather(false);
    updateStatus('Air restarted · ground water preserved · manual reset of the bottle');
  });

  const view = document.getElementById('atmosphere-view') as HTMLSelectElement | null;

  const sliceGroup = document.getElementById('atmosphere-slice-group');

  const legend = document.getElementById('atmosphere-legend');

  const syncView = () => {
    if (view) {
      view.value = config.thermalOverlay
        ? 'surface'
        : config.atmosphereView === 1 && config.atmosphereSlice >= 0.5
          ? 'temperature-cloud'
          : String(config.atmosphereView);
      view.title = config.thermalOverlay
        ? 'Surface temperature: ground, water, snow or ice.'
        : config.atmosphereView === 1
          ? `Temperature of the ${config.atmosphereSlice < 0.5 ? 'lower air' : 'cloud layer'}.`
          : config.atmosphereView === 0
            ? 'No weather overlay. Clouds and precipitation remain visible.'
            : (view.selectedOptions[0]?.textContent ?? '');
    }
    const hasLayerChoice = config.atmosphereView === 2 || config.atmosphereView === 3;
    if (sliceGroup) sliceGroup.hidden = !hasLayerChoice;
    (document.getElementById('atmosphere-slice') as HTMLInputElement).disabled = !hasLayerChoice;

    if (legend) {
      legend.textContent =
        [
          '',

          '−30 °C: blue → 0 °C: cyan/yellow → +35 °C: red',

          '0%: dry brown → 100%: saturated cyan · White: cloud water',

          '0 km/min: blue → 3: green/cyan → 6: orange',
          'Dark: no precipitation → teal: rain/snow → gold: heavy precipitation',
          'Ochre: little recent rain → blue: recently wet · rainfall memory, not groundwater',
          'Blue: descending air → dark: calm → amber: rising air · signed interface flow',
        ][config.atmosphereView] ?? '';
    }
  };

  syncControls.push(syncView);

  const syncThermal = () => {
    config.thermalOpacity = config.viewOpacity;
    document.getElementById('thermal-legend')!.hidden = !config.thermalOverlay;
    document.getElementById('thermal-legend-title')!.textContent = 'Surface temperature · °C';
  };
  syncControls.push(syncThermal);
  if (view) addParameterReset(view, () => {
    config.atmosphereView = defaultConfig.atmosphereView;
    config.thermalOverlay = defaultConfig.thermalOverlay;
    syncThermal();
    syncView();
  }, () => config.atmosphereView === defaultConfig.atmosphereView &&
    config.thermalOverlay === defaultConfig.thermalOverlay);
  document.getElementById('view-opacity')!.addEventListener('input', syncThermal);
  view?.addEventListener('change', () => {
    const thermal = view.value === 'surface';
    const cloudTemperature = view.value === 'temperature-cloud';
    const selected = cloudTemperature ? 1 : Number(view.value);
    if (!thermal && ![0, 1, 2, 3, 4, 5, 6].includes(selected)) return;
    config.thermalOverlay = thermal;
    config.thermalAir = false;
    if (selected === 1) config.atmosphereSlice = cloudTemperature ? 1 : 0;
    if (selected === 1) {
      const slice = document.getElementById('atmosphere-slice') as HTMLInputElement;
      slice.value = String(config.atmosphereSlice);
      const label = cloudTemperature ? 'Cloud layer' : 'Lower air';
      slice.setAttribute('aria-valuetext', label);
      document.getElementById('atmosphere-slice-val')!.textContent = label;
    }
    config.atmosphereView = thermal ? 0 : selected;
    syncThermal();
    syncView();
  });

  document.getElementById('btn-weather-reset')?.addEventListener('click', () => {
    resetWeather();

    updateStatus('Weather reset · snow and ice cleared · new water balance');
  });

  // setupUI binds the shared pause state before these weather-specific controls.

  document.getElementById('btn-pause')?.addEventListener('click', () => updateStatus());

  syncControls.forEach((sync) => sync());

  updateStatus();
}
