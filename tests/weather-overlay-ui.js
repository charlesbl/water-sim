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
  check(
    'None replaces clouds in the overlay menu',
    $('atmosphere-view').querySelector('option[value="0"]').textContent === 'None'
  );
  check('Cloud opacity is available in the header', $('cloud-opacity').closest('.topbar'));
  change('cloud-opacity', 40);
  for (const choice of ['0', '1', 'temperature-cloud', 'surface', '2', '3', '4', '5']) {
    change('atmosphere-view', choice);
    change('view-opacity', 0);
    check(`Overlay ${choice} at zero preserves cloud opacity`, config.cloudOpacity === 0.4);
    change('view-opacity', 100);
    check(`Overlay ${choice} at full opacity preserves cloud opacity`, config.cloudOpacity === 0.4);
  }
  change('cloud-opacity-number', 0);
  check(
    'Cloud opacity leaves selected overlay and its opacity intact',
    config.atmosphereView === 5 && config.viewOpacity === 1
  );
  change('atmosphere-view', 0);
  change('cloud-opacity-number', 80);
  check(
    'None disables diagnostics without hiding clouds or their control',
    !config.thermalOverlay &&
      config.atmosphereView === 0 &&
      config.cloudOpacity === 0.8 &&
      !$('cloud-opacity').disabled &&
      $('view-legend').hidden
  );
  window.testResults = { passed: true, results };
}
run().catch((error) => {
  window.testResults = { passed: false, error: String(error), results };
});
