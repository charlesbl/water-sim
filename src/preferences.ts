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
  // Preserve the user's terrain/water/camera preferences when trying this branch.
  // Old volumetric wind units and vertical controls are incompatible with it.
  const oldWeather = !['regional-two-layer-v1', 'bottle-two-layer-v1', 'bottle-circulation-v1', 'bottle-mac-v1'].includes(
    preferences.weatherModel ?? ''
  );
  const migrated = new Set([
    'airTemperature',
    'relativeHumidity',
    'airStability',
    'convectionStrength',
    'windSpeed',
    'windDirection',
    'solarHeating',
    'radiativeCooling',
    'atmosphereTimeScale',
    'atmosphereSlice',
    'atmosphereView',
  ]);
  for (const key of Object.keys(defaultConfig) as Array<keyof typeof config>) {
    if (oldWeather && migrated.has(key)) continue;
    if (key === 'windSpeed' && !['bottle-circulation-v1', 'bottle-mac-v1'].includes(preferences.weatherModel ?? '')) continue;
    // Migrate the previous default damping; retain deliberately changed values.
    if (key === 'airDrag' && preferences.weatherModel !== 'bottle-mac-v1' && saved.airDrag === 0.025) continue;
    const value = saved[key];
    if (typeof value !== typeof defaultConfig[key]) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    Object.assign(config, { [key]: value });
  }
  // Older preferences used opacity itself to activate the thermal view.
  if (saved.viewOpacity === undefined) {
    config.viewOpacity =
      saved.thermalOverlay && typeof saved.thermalOpacity === 'number'
        ? Math.max(0, Math.min(1, saved.thermalOpacity))
        : defaultConfig.viewOpacity;
  }
  config.viewOpacity = Math.max(0, Math.min(1, config.viewOpacity));
  config.thermalOpacity = config.viewOpacity;
  // The former height-based air view now opens the lower model layer.
  if (config.thermalOverlay && config.thermalAir) {
    config.thermalOverlay = false;
    config.atmosphereView = 1;
    config.atmosphereSlice = 0;
  }
  config.thermalAir = false;
}

/** Store current settings; removed controls are never restored or saved. */
export function savePreferences(update: Partial<Preferences> = {}): void {
  if (resetting) return;
  Object.assign(preferences, update, {
    config: { ...config },
    weatherModel: 'bottle-mac-v1',
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
