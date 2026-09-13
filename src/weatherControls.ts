import { config, Config } from './config';
import { defaultConfig } from './preferences';
import { addParameterReset } from './parameterReset';
import { setupCoolingCurve } from './coolingCurve';

type NumberKey = { [K in keyof Config]: Config[K] extends number ? K : never }[keyof Config];

/** Bind live settings without resetting any material or temperature. */
export function setupWeatherControls(clearClouds: () => void): void {
  const syncs: Array<() => void> = [];
  const status = () => {
    document.getElementById('weather-status')!.textContent = !config.weatherEnabled
      ? 'Weather held · cloud painting remains available'
      : config.paused
        ? 'Simulation paused · cloud painting remains available'
        : 'Painted rain · sunlight and gradual cooling';
  };
  const bind = (id: string, key: NumberKey, scale = 1) => {
    const input = document.getElementById(id) as HTMLInputElement;
    const sync = () => {
      input.value = String(config[key] * scale);
      document.getElementById(`${id}-val`)!.textContent = Number(input.value).toFixed(2);
    };
    syncs.push(sync);
    input.addEventListener('input', () => {
      config[key] = Math.max(+input.min, Math.min(+input.max, +input.value)) / scale;
      sync();
      status();
    });
    addParameterReset(
      input,
      () => {
        config[key] = defaultConfig[key];
        sync();
        status();
      },
      () => config[key] === defaultConfig[key],
      () => config[key] * scale
    );
  };
  const bindings: Array<[string, NumberKey, number?]> = [
    ['rain-rate', 'rainRate', 500],
    ['cooling-low', 'coolingLow'],
    ['cooling-middle', 'coolingMiddle'],
    ['cooling-high', 'coolingHigh'],
    ['cooling-middle-altitude', 'coolingMiddleAltitude'],
    ['solar-heating', 'solarHeating'],
    ['albedo-strength', 'albedoStrength'],
    ['sun-elevation', 'sunElevation'],
    ['sun-azimuth', 'sunAzimuth'],
    ['evaporation-rate', 'evaporationRate'],
    ['cloud-shadows', 'cloudShadows'],
    ['cloud-altitude', 'cloudAltitude'],
    ['cloud-thickness', 'cloudThickness'],
    ['cloud-detail', 'cloudDetail'],
    ['rain-visibility', 'rainVisibility'],
    ['view-opacity', 'viewOpacity', 100],
    ['cloud-opacity', 'cloudOpacity', 100],
  ];
  bindings.forEach(([id, key, scale]) => bind(id, key, scale));
  const enabled = document.getElementById('weather-enabled') as HTMLInputElement;
  enabled.checked = config.weatherEnabled;
  enabled.addEventListener('change', () => {
    config.weatherEnabled = enabled.checked;
    status();
  });
  addParameterReset(
    enabled,
    () => {
      config.weatherEnabled = defaultConfig.weatherEnabled;
      enabled.checked = config.weatherEnabled;
      status();
    },
    () => config.weatherEnabled === defaultConfig.weatherEnabled
  );
  const view = document.getElementById('weather-view') as HTMLSelectElement;
  const syncView = () => {
    view.value = config.thermalOverlay ? 'surface' : String(config.weatherView);
    document.getElementById('thermal-legend')!.hidden = !config.thermalOverlay;
    document.getElementById('weather-legend')!.textContent =
      config.weatherView === 1
        ? 'Clear → drizzle → downpour · painted intensity 0–2'
        : 'Dark: dry · teal: light precipitation · gold: heavy precipitation';
  };
  view.addEventListener('change', () => {
    config.thermalOverlay = view.value === 'surface';
    config.weatherView = config.thermalOverlay ? 0 : Number(view.value);
    syncView();
  });
  addParameterReset(
    view,
    () => {
      config.thermalOverlay = false;
      config.weatherView = 0;
      syncView();
    },
    () => !config.thermalOverlay && config.weatherView === 0
  );
  document.getElementById('btn-clear-clouds')!.addEventListener('click', clearClouds);
  document.getElementById('btn-pause')!.addEventListener('click', status);
  syncs.forEach((sync) => sync());
  syncView();
  status();
  setupCoolingCurve();
}
