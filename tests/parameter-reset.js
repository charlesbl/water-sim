import '../src/style.css';
import { config } from '../src/config.ts';
import { defaultConfig } from '../src/preferences.ts';
import { setupSimulationControls } from '../src/simulationControls.ts';
import { setupWeatherControls } from '../src/weatherControls.ts';
import { setupCommandUI } from '../src/commandUI.ts';
const results = [];
const check = (name, passed) => {
  results.push({ name, passed });
  if (!passed) throw new Error(name);
};
try {
  const doc = new DOMParser().parseFromString(await (await fetch(import.meta.env.BASE_URL)).text(), 'text/html');
  doc.querySelectorAll('script').forEach(s => s.remove());
  document.body.replaceChildren(...Array.from(doc.body.childNodes, n => document.importNode(n, true)));
  let terrainResets = 0;
  setupSimulationControls({ resetTerrain() { terrainResets++; }, rebuildMesh() {}, clearFluids() {} });
  setupWeatherControls(() => { throw new Error('Individual reset must not reset weather'); });
  setupCommandUI();
  const reset = id => {
    document.getElementById('command-ui').dispatchEvent(new Event('click'));
    document.querySelector(`[data-reset-for="${id}"]`).click();
  };
  check('Defaults hide every reset including shortcuts',
    [...document.querySelectorAll('[data-reset-for]')].every(b => b.style.visibility === 'hidden' && b.disabled));
  const gravity = document.getElementById('water-gravity');
  const button = document.querySelector('[data-reset-for="water-gravity"]');
  document.querySelector('[data-domain="water"]').click();
  const group = gravity.closest('.control-group');
  const beforeLayout = group.getBoundingClientRect().toJSON();
  gravity.value = '15';
  gravity.dispatchEvent(new Event('input', { bubbles: true }));
  check('Editing reveals reset', button.style.visibility === 'visible' && !button.disabled);
  const afterLayout = group.getBoundingClientRect().toJSON();
  check('Reset visibility preserves layout', JSON.stringify(beforeLayout) === JSON.stringify(afterLayout));
  reset('water-gravity');
  check('Reset hides button again', button.style.visibility === 'hidden' && button.disabled);
  gravity.value = '15';
  gravity.dispatchEvent(new Event('input', { bubbles: true }));
  gravity.value = '9.8';
  gravity.dispatchEvent(new Event('input', { bubbles: true }));
  check('Rounded gravity is not mistaken for exact default', button.style.visibility === 'visible');
  reset('water-gravity');
  check('Every range, checkbox and select has an individual reset',
    [...document.querySelectorAll('input[type="range"], input[type="checkbox"], select')]
      .every(e => document.querySelector(`[data-reset-for="${e.id}"]`)));
  for (const [id, key, value] of [
    ['water-gravity', 'waterGravity', 20],
    ['relative-humidity', 'relativeHumidity', 0.2],
    ['soil-static-repose-slope', 'soilStaticReposeSlope', 0.001],
    ['soil-dynamic-repose-slope', 'soilDynamicReposeSlope', 0.03],
    ['terrain-scale', 'terrainScale', 8],
    ['chk-show-rock', 'showRock', false],
    ['smooth-rendering', 'smoothRendering', false],
    ['atmosphere-enabled', 'atmosphereEnabled', false],
    ['quick-sim-speed', 'simSpeed', 4],
    ['quick-atmosphere-time-scale', 'atmosphereTimeScale', 4],
  ]) {
    config[key] = value;
    const before = { ...config };
    reset(id);
    check(`${id} restores the exact default and only that parameter`,
      config[key] === defaultConfig[key] && Object.keys(config).every(k => k === key || config[k] === before[k]));
  }
  check('Terrain default applies regeneration once', terrainResets === 1);
  check('Exact numeric field preserves gravity precision', document.getElementById('water-gravity-number').value === '9.81');
  config.atmosphereSlice = 0;
  config.atmosphereView = 2;
  reset('atmosphere-view');
  check('Overlay reset preserves layer choice', config.atmosphereView === 0 && config.atmosphereSlice === 0);
  config.viewOpacity = 0.35;
  reset('view-opacity');
  check('Opacity restores exact default and syncs renderer alias', config.viewOpacity === 0.72 && config.thermalOpacity === 0.72 && document.getElementById('view-opacity-number').value === '72');
  window.testResults = { passed: true, results };
} catch (error) {
  window.testResults = { passed: false, results, error: String(error) };
}
