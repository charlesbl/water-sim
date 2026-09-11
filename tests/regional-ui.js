import { config } from '../src/config.ts';
import { setupSimulationControls } from '../src/simulationControls.ts';
import { setupWeatherControls } from '../src/weatherControls.ts';
import { setupCommandUI } from '../src/commandUI.ts';
import { preferences, restoreConfig } from '../src/preferences.ts';
const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed: !!passed, detail });
  if (!passed) throw new Error(name + ': ' + detail);
}
async function run() {
  const html = await (await fetch(import.meta.env.BASE_URL)).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script').forEach((s) => s.remove());
  document.head.append(document.importNode(doc.querySelector('link[rel="stylesheet"]'), true));
  document.body.replaceChildren(
    ...Array.from(doc.body.childNodes).map((n) => document.importNode(n, true))
  );
  const defaults = { ...config };
  const resets = [];
  setupSimulationControls({ resetTerrain() {}, rebuildMesh() {} });
  setupWeatherControls((clear) => resets.push(clear));
  setupCommandUI();
  await new Promise(requestAnimationFrame);
  const $ = (id) => document.getElementById(id);
  const change = (id, value) => {
    const e = $(id);
    e.value = String(value);
    e.dispatchEvent(new Event(e.type === 'range' ? 'input' : 'change', { bubbles: true }));
  };
  check(
    'Binding the real panel preserves defaults',
    Object.entries(defaults).every(([k, v]) => config[k] === v)
  );
  const ids = Array.from(document.querySelectorAll('[id]'), (e) => e.id);
  check('Every panel and shortcut ID is unique', new Set(ids).size === ids.length);
  check(
    'Every range has a numeric companion with matching limits',
    Array.from(document.querySelectorAll('input[type="range"]')).every((e) => {
      const number = $(e.id + '-number');
      return number && ['min', 'max', 'step'].every((k) => e[k] === number[k]);
    })
  );
  const edits = [
    ['weather-map-size', 'weatherMapSizeKm', 15, 15],
    ['weather-cell-size', 'weatherCellSizeKm', 3, 3],
    ['weather-variability', 'weatherVariability', 1.1, 1.1],
    ['weather-seed', 'weatherSeed', 42, 42],
    ['rain-lifetime', 'rainLifetime', 90, 90],
    ['orographic-lift', 'orographicLift', 2.1, 2.1],
    ['air-mixing', 'airMixing', 0.02, 0.02],
    ['wind-shear', 'windShear', 65, 0.65],
    ['circulation-strength', 'circulationStrength', 2.2, 2.2],
    ['wind-speed', 'windSpeed', 3.1, 3.1],
    ['regional-drive', 'regionalDrive', 1.5, 1.5],
    ['weather-renewal', 'weatherRenewal', 240, 240],
    ['wind-rotation', 'windRotation', 0.6, 0.6],
    ['cloud-altitude', 'cloudAltitude', 1.25, 1.25],
    ['cloud-thickness', 'cloudThickness', 0.75, 0.75],
    ['cloud-detail', 'cloudDetail', 80, 0.8],
    ['cloud-shadows', 'cloudShadows', 40, 0.4],
    ['rain-visibility', 'rainVisibility', 1.5, 1.5],
  ];
  for (const [id, key, input, expected] of edits) {
    change(id + '-number', input);
    check('Numeric control drives ' + key, Math.abs(config[key] - expected) < 1e-9);
    const search = $('command-search');
    search.value = document.querySelector('label[for="' + id + '"]').textContent.trim();
    search.dispatchEvent(new Event('input', { bubbles: true }));
    check(
      'Search finds ' + id,
      !!document.querySelector('.search-result[data-target="' + id + '"]')
    );
  }
  check('Initial-condition edits wait for Restart air', resets.length === 0);
  $('btn-weather-restart-air').click();
  check('Restart air preserves surface state', resets.at(-1) === false);
  change('rain-lifetime-number', 999);
  check('Typed values respect physical control limits', config.rainLifetime === 180);
  change('atmosphere-view', 4);
  check(
    'Radar is selectable and has no irrelevant layer selector',
    config.atmosphereView === 4 &&
      $('atmosphere-slice').disabled &&
      $('slice-legend-title').textContent.includes('radar')
  );
  change('atmosphere-view', 5);
  check(
    'Recent wetness has its own legend',
    config.atmosphereView === 5 && $('slice-legend-title').textContent.includes('wetness')
  );
  change('atmosphere-view', 2);
  change('atmosphere-slice', 0);
  check(
    'Lower-layer humidity map is selectable',
    config.atmosphereSlice === 0 && !$('atmosphere-slice').disabled
  );
  change('atmosphere-slice', 1);
  check(
    'Upper layer selector reports its actual meaning',
    $('atmosphere-slice-val').textContent === 'Cloud layer'
  );
  document.querySelector('[data-weather-preset="dry"]').click();
  check(
    'Dry preset changes air and retains ground reservoirs',
    config.relativeHumidity === 0.25 && resets.at(-1) === false
  );
  document.querySelector('[data-weather-preset="storm"]').click();
  check(
    'Storm preset enables fast rain and moving winds',
    config.rainLifetime === 30 && config.windSpeed === 3
  );
  check(
    'Surface fluid tuning is preserved by weather controls',
    [
      'waterGravity',
      'waterDamping',
      'simSpeed',
      'erosionRate',
      'capacityFactor',
      'depositionRate',
    ].every((k) => config[k] === defaults[k])
  );
  const saved = JSON.parse(localStorage.getItem('terragpu.preferences.v1'));
  check(
    'New controls and model version are persisted',
    saved.weatherModel === 'regional-two-layer-v1' &&
      saved.config.weatherSeed === 42 &&
      saved.config.cloudAltitude === 1.25
  );
  Object.assign(config, defaults);
  Object.assign(preferences, saved);
  restoreConfig();
  check(
    'Saved regional parameters restore on the next startup',
    config.weatherSeed === 42 && config.regionalDrive === 1.5 && config.weatherRenewal === 240
  );
  Object.assign(config, defaults);
  Object.assign(preferences, {
    weatherModel: undefined,
    config: { windSpeed: 5, atmosphereSlice: 0.4, waterGravity: 8, waterDamping: 0.995 },
  });
  restoreConfig();
  check(
    'Old 3D wind and slice units migrate to regional defaults',
    config.windSpeed === defaults.windSpeed && config.atmosphereSlice === defaults.atmosphereSlice
  );
  check(
    'Migration preserves the existing surface-fluid preferences',
    config.waterGravity === 8 && config.waterDamping === 0.995
  );
  window.testResults = { passed: true, results };
}
run().catch((error) => {
  window.testResults = { passed: false, error: String(error), results };
});
