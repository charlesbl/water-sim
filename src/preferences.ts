import { config } from './config';

export const PREFERENCES_KEY = 'terragpu.preferences.v1';
export const defaultConfig = Object.freeze({ ...config });

interface Preferences {
  weatherModel?: string;
  energyPanelOpen?: boolean;
  config?: Partial<typeof config>;
  domain?: string | null;
  search?: string;
  scrollTop?: number;
  camera?: { position: number[]; quaternion: number[] };
}

function readPreferences(): Preferences {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export const preferences = readPreferences();
let resetting = false;
let lastSaved = '';

/** Restore before constructing GPU resources; absent/new options keep their defaults. */
export function restoreConfig(): void {
  const saved = preferences.config;
  if (!saved || typeof saved !== 'object') return;
  const currentWeather = preferences.weatherModel === 'painted-weather-v1';
  const weatherKeys = new Set([
    'weatherEnabled',
    'solarHeating',
    'coolingLow',
    'coolingMiddle',
    'coolingHigh',
    'coolingMiddleAltitude',
    'rainRate',
    'evaporationRate',
    'cloudAltitude',
    'cloudThickness',
    'weatherView',
  ]);
  for (const key of Object.keys(defaultConfig) as Array<keyof typeof config>) {
    if (
      !currentWeather &&
      (weatherKeys.has(key) || (key === 'brushType' && saved.brushType === 10))
    )
      continue;
    const value = saved[key];
    if (typeof value !== typeof defaultConfig[key]) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    Object.assign(config, { [key]: value });
  }
  config.borderMode = config.borderMode === 1 ? 1 : 0;
  config.albedoStrength = Math.max(0, Math.min(2, config.albedoStrength));
  config.cloudAltitude = Math.max(15, Math.min(100, config.cloudAltitude));
  config.viewOpacity = Math.max(0, Math.min(1, config.viewOpacity));
  config.coolingMiddleAltitude = Math.max(0.5, Math.min(31.5, config.coolingMiddleAltitude));
  for (const key of ['coolingLow', 'coolingMiddle', 'coolingHigh'] as const)
    config[key] = Math.max(0.1, Math.min(3, config[key]));
  if (![0, 1, 2].includes(config.weatherView)) config.weatherView = 0;
}

/** Store current settings; removed controls are never restored or saved. */
export function savePreferences(update: Partial<Preferences> = {}): void {
  if (resetting) return;
  Object.assign(preferences, update, {
    config: { ...config },
    weatherModel: 'painted-weather-v1',
  });
  try {
    const serialized = JSON.stringify(preferences);
    if (serialized === lastSaved) return;
    localStorage.setItem(PREFERENCES_KEY, serialized);
    lastSaved = serialized;
  } catch {
    // Storage can be unavailable or full; the simulation remains usable.
  }
}

export function resetPreferences(): void {
  resetting = true;
  Object.assign(config, defaultConfig);
  try {
    localStorage.removeItem(PREFERENCES_KEY);
  } catch {
    // Browsing modes that block storage already start with defaults on reload.
  }
  // Recreate GPU resources and all controls using the same startup defaults.
  window.location.reload();
}
