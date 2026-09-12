import '../src/style.css';
import { config } from '../src/config.ts';
import { defaultConfig, preferences, restoreConfig, savePreferences, PREFERENCES_KEY } from '../src/preferences.ts';
import { setupWeatherControls } from '../src/weatherControls.ts';
import { setupCommandUI } from '../src/commandUI.ts';

const results = [], saved = { ...config }, savedPreferences = { ...preferences };
const originalStorage = localStorage.getItem(PREFERENCES_KEY);
function check(name, passed) {
  results.push({ name, passed: Boolean(passed) });
  if (!passed) throw new Error(name);
}
try {
  Object.assign(config, defaultConfig);
  const doc = new DOMParser().parseFromString(await (await fetch(import.meta.env.BASE_URL)).text(), 'text/html');
  doc.querySelectorAll('script').forEach(s => s.remove());
  document.body.replaceChildren(...Array.from(doc.body.childNodes, node => document.importNode(node, true)));
  let restarts = 0;
  setupWeatherControls(() => { restarts++; });
  setupCommandUI();
  for (const [id, key, value] of [
    ['air-drag', 'airDrag', 0.01], ['air-viscosity', 'airViscosity', 0.02], ['pressure-cycles', 'pressureCycles', 5],
  ]) {
    const slider = document.getElementById(id);
    check(`${id}: default matches configuration`, Number(slider.value) === defaultConfig[key]);
    slider.value = String(value); slider.dispatchEvent(new Event('input', { bubbles: true }));
    check(`${id}: live control updates configuration`, config[key] === value);
    const exact = document.getElementById(`${id}-number`);
    check(`${id}: exact value stays synchronized`, Number(exact.value) === value);
    document.getElementById('command-ui').dispatchEvent(new Event('click'));
    const reset = document.querySelector(`[data-reset-for="${id}"]`);
    check(`${id}: individual reset available`, reset && !reset.disabled);
    reset.click();
    check(`${id}: reset restores its own default`, config[key] === defaultConfig[key]);
  }
  check('Live wind controls do not restart the atmosphere', restarts === 0);
  preferences.weatherModel = 'bottle-circulation-v1';
  preferences.config = { airDrag: 0.025, windSpeed: 1.5 };
  Object.assign(config, defaultConfig); restoreConfig();
  check('Old default drag migrates to longer-lived currents', config.airDrag === 0.006);
  check('Finite initial wind preference survives migration', config.windSpeed === 1.5);
  preferences.config = { airDrag: 0.04 };
  Object.assign(config, defaultConfig); restoreConfig();
  check('An edited drag preference is retained', config.airDrag === 0.04);
  config.airViscosity = 0.012; config.pressureCycles = 4;
  savePreferences();
  const written = JSON.parse(localStorage.getItem(PREFERENCES_KEY));
  check('New model and controls persist', written.weatherModel === 'bottle-mac-v1'
    && written.config.airViscosity === 0.012 && written.config.pressureCycles === 4);
  window.testResults = { passed: true, results };
} catch (error) {
  window.testResults = { passed: false, results, error: String(error.stack ?? error) };
} finally {
  Object.assign(config, saved);
  for (const key of Object.keys(preferences)) delete preferences[key];
  Object.assign(preferences, savedPreferences);
  if (originalStorage === null) localStorage.removeItem(PREFERENCES_KEY);
  else localStorage.setItem(PREFERENCES_KEY, originalStorage);
  const report = document.createElement('pre');
  report.textContent = JSON.stringify(window.testResults, null, 2); document.body.appendChild(report);
}
