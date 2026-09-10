import { config } from './config';

export const PREFERENCES_KEY = 'terragpu.preferences.v1';
export const defaultConfig = Object.freeze({ ...config });

interface Preferences {
  config?: Partial<typeof config>;
  domain?: string | null;
  advanced?: boolean;
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
  for (const key of Object.keys(defaultConfig) as Array<keyof typeof config>) {
    const value = saved[key];
    if (typeof value !== typeof defaultConfig[key]) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    Object.assign(config, { [key]: value });
  }
}

/** Store the source values, including settings temporarily disabled by another mode. */
export function savePreferences(update: Partial<Preferences> = {}): void {
  if (resetting) return;
  Object.assign(preferences, update, { config: { ...config } });
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
