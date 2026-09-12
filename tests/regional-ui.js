import '../src/style.css';
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
  check(
    'View selector and common opacity are in the top bar',
    $('atmosphere-view').closest('.topbar') && $('view-opacity').closest('.topbar')
  );
  check(
    'All parameters are available without an advanced mode',
    !$('toggle-advanced') && !document.querySelector('[data-advanced]')
  );
  check(
    'Sun controls share a dedicated panel',
    [
      'sun-elevation',
      'sun-azimuth',
      'solar-heating',
      'heating-contrast',
      'radiative-cooling',
      'evaporation-rate',
      'cloud-shadows',
    ].every((id) => $(id).closest('.domain-content').id === 'domain-sun')
  );
  check(
    'Exactly three temperature layers and no height control',
    $('atmosphere-view').querySelectorAll('optgroup[label="Temperature"] option').length === 3 &&
      !$('thermal-height') &&
      !$('thermal-controls')
  );
  for (const [choice, layer] of [
    ['1', 0],
    ['temperature-cloud', 1],
  ]) {
    change('atmosphere-view', choice);
    check(
      `Temperature ${choice} selects its fixed layer`,
      config.atmosphereView === 1 &&
        config.atmosphereSlice === layer &&
        !config.thermalOverlay &&
        $('atmosphere-slice').disabled &&
        $('atmosphere-slice-group').hidden &&
        $('atmosphere-view').value === choice
    );
  }
  change('view-opacity', 35);
  for (const view of ['0', '1', '2', '3', '4', '5', 'temperature-cloud', 'surface']) {
    change('atmosphere-view', view);
    check(
      `View ${view} retains common opacity`,
      config.viewOpacity === 0.35 &&
        config.thermalOpacity === 0.35 &&
        $('view-opacity').value === '35' &&
        config.thermalOverlay === (view === 'surface')
    );
  }
  change('view-opacity', 0);
  check(
    'Zero opacity keeps the selected view',
    $('atmosphere-view').value === 'surface' && config.thermalOverlay && config.thermalOpacity === 0
  );
  change('view-opacity', 100);
  check('Full opacity restores the selected overlay', config.thermalOpacity === 1);
  change('atmosphere-view', 0);
  check(
    'Humidity is grouped with initial air in the closed cycle',
    $('relative-humidity').closest('section').id === 'climate-initial-air'
  );
  change('regional-drive', 0);
  check(
    'Isolated temperature and wind move to initial conditions',
    $('air-temperature').closest('section').id === 'climate-initial-air' &&
      $('wind-speed').closest('section').id === 'climate-initial-wind'
  );
  change('regional-drive', 1);
  check(
    'Regional temperature and wind return to live climate',
    $('air-temperature').closest('section').id === 'climate-live-air' &&
      $('wind-speed').closest('section').id === 'climate-live-wind'
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
  check('Weather presets are removed', !document.querySelector('[data-weather-preset]'));
  for (const drive of [0, 1]) {
    change('regional-drive', drive);
    for (const category of ['air', 'wind']) {
      const initial = $(`climate-initial-${category}`);
      check(
        `Initial ${category} remains populated with regional drive ${drive}`,
        [...initial.querySelectorAll('.control-group')].some((group) => !group.hidden)
      );
    }
    const temperature = drive ? 'initial-air-temperature' : 'air-temperature';
    check(
      `Initial temperature is visible with regional drive ${drive}`,
      !$(temperature).closest('.control-group').hidden &&
        $(temperature).closest('section').id === 'climate-initial-air'
    );
  }
  change('initial-air-temperature-number', 18);
  check(
    'Initial temperature edits synchronize live range and numeric value',
    config.airTemperature === 18 &&
      $('air-temperature').value === '18' &&
      $('air-temperature-number').value === '18'
  );
  change('air-temperature-number', 9);
  check(
    'Live temperature edits synchronize initial range and numeric value',
    $('initial-air-temperature').value === '9' && $('initial-air-temperature-number').value === '9'
  );
  change('initial-wind-speed-number', 2.8);
  check(
    'Initial wind updates the shared wind value',
    config.windSpeed === 2.8 && $('wind-speed').value === '2.8'
  );
  $('btn-weather-restart-air').click();
  check('Restart air remains available and preserves surface water', resets.at(-1) === false);
  change('regional-drive', 1.5);
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
  change('atmosphere-view', 'surface');
  change('view-opacity', 0);
  const zeroOpacityPreferences = JSON.parse(localStorage.getItem('terragpu.preferences.v1'));
  Object.assign(preferences, zeroOpacityPreferences);
  config.thermalOverlay = false;
  restoreConfig();
  check(
    'Reload preserves the thermal view even at zero opacity',
    config.thermalOverlay && !config.thermalAir && config.viewOpacity === 0
  );
  change('atmosphere-view', 3);
  change('view-opacity', 65);
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
