import { config } from '../src/config.ts';
import { setupSimulationControls } from '../src/simulationControls.ts';
import { setupWeatherControls } from '../src/weatherControls.ts';
import { setupCommandUI, isUIEventTarget } from '../src/commandUI.ts';
import baseline from './ui-baseline.json';

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, passed: Boolean(condition), detail });
  if (!condition) throw new Error(name + ': ' + detail);
}
const $ = (id) => document.getElementById(id);
const change = (id, value) => {
  const input = $(id);
  if (input.type === 'checkbox') input.checked = value;
  else input.value = String(value);
  input.dispatchEvent(new Event(input.type === 'range' ? 'input' : 'change', { bubbles: true }));
};
const click = (selector) => document.querySelector(selector).click();
const searchFor = (query) => {
  $('command-search').value = query;
  $('command-search').dispatchEvent(new Event('input', { bubbles: true }));
};

async function run() {
  const html = await (await fetch(import.meta.env.BASE_URL)).text();
  const app = new DOMParser().parseFromString(html, 'text/html');
  app.querySelectorAll('script').forEach((script) => script.remove());
  const css = app.querySelector('link[rel="stylesheet"]');
  document.head.append(document.importNode(css, true));
  document.body.replaceChildren(
    ...Array.from(app.body.childNodes).map((node) => document.importNode(node, true))
  );
  const initial = { ...config };
  const actions = [];
  setupSimulationControls({
    resetTerrain: (seed) => actions.push(['terrain', seed]),
    clearFluids: () => actions.push(['clear']),
    rebuildMesh: () => actions.push(['mesh']),
  });
  setupWeatherControls((clearSurface) => actions.push(['weather', clearSurface]));
  setupCommandUI();
  // Useful to the browser runner, confined to this fixture.
  window.uiTest = { config, actions, searchFor, change };
  check(
    'Binding controls preserves every initial physics value',
    Object.entries(initial).every(([key, value]) => config[key] === value)
  );
  check(
    'Every original ID is unique',
    baseline.controls.every(({ id }) => document.querySelectorAll('#' + id).length === 1)
  );
  check(
    'All 64 original controls retain their range, step and select values',
    baseline.controls.length === 64 &&
      baseline.controls.every((old) => {
        const element = $(old.id);
        return (
          ['type', 'min', 'max', 'step'].every(
            (key) => !old[key] || element.getAttribute(key) === old[key]
          ) &&
          (!old.options ||
            JSON.stringify(Array.from(element.options, (option) => option.value)) ===
              JSON.stringify(old.options))
        );
      })
  );
  check(
    'All ten brushes, four presets and six actions are present',
    baseline.brushes.every(
      (id) => document.querySelectorAll('[data-brush="' + id + '"]').length === 1
    ) &&
      baseline.presets.every(
        (id) => document.querySelectorAll('[data-weather-preset="' + id + '"]').length === 1
      ) &&
      baseline.actions.every((id) => $(id))
  );
  for (const old of baseline.controls) {
    searchFor(old.label);
    const match = document.querySelector('.search-result[data-target="' + old.id + '"]');
    check('Original setting remains searchable: ' + old.id, Boolean(match));
  }
  $('command-search').value = '';
  searchFor('');
  check(
    'Every slider has an exact-value companion with the same limits',
    baseline.controls
      .filter((c) => c.type === 'range')
      .every((old) =>
        ['min', 'max', 'step'].every((key) => $(old.id + '-number')[key] === $(old.id)[key])
      )
  );
  check(
    'No inspector is open at startup; configured brush is selected',
    $('inspector').hidden &&
      document.querySelector('[data-brush="0"]').getAttribute('aria-pressed') === 'true'
  );
  click('[data-domain="climate"]');
  check(
    'Domain opens the compact inspector',
    !$('inspector').hidden &&
      !$('domain-climate').hidden &&
      !$('inspector').classList.contains('advanced')
  );
  click('#toggle-advanced');
  change('convection-strength-number', 5.5);
  click('#toggle-advanced');
  check(
    'Advanced numeric changes survive returning to compact mode',
    config.convectionStrength === 5.5 && $('convection-strength').value === '5.5'
  );
  click('[data-domain="world"]');
  check(
    'Only the chosen domain is open',
    Array.from(document.querySelectorAll('.domain-content')).filter((d) => !d.hidden).length === 1
  );
  click('[data-domain="world"]');
  check('Clicking the active domain closes it', $('inspector').hidden);
  searchFor('Carrying Capacity');
  click('.search-result');
  check(
    'Search reveals an advanced control and its domain',
    !$('domain-sediments').hidden &&
      $('inspector').classList.contains('advanced') &&
      $('capacity-factor').closest('[data-control]').classList.contains('search-highlight')
  );
  searchFor('Raindrop Quantity');
  click('.search-result');
  check(
    'A disabled search result explains its prerequisite and focuses its link',
    $('rain-quantity').disabled &&
      !$('rain-quantity').closest('.control-group').querySelector('[data-availability]').hidden &&
      document.activeElement.dataset.reveal === 'closed-water-cycle'
  );
  document.activeElement.click();
  check(
    'Prerequisite link navigates without toggling the mode',
    document.activeElement === $('closed-water-cycle') && config.closedWaterCycle
  );
  change('closed-water-cycle', false);
  change('rain-active', true);
  change('rain-quantity-number', 0.0008);
  change('border-behavior', 2);
  change('border-water-height-number', 1.15);
  change('closed-water-cycle', true);
  check(
    'Closed cycle shows effective values while retaining open-mode choices',
    $('border-behavior').value === '0' &&
      !$('rain-active').checked &&
      config.borderBehavior === 2 &&
      config.rainActive &&
      Math.abs(config.borderWaterHeight - 1.15) < 1e-8 &&
      $('rain-quantity-number').disabled
  );
  change('closed-water-cycle', false);
  check(
    'Reopening the cycle restores all stored values',
    $('rain-active').checked &&
      $('border-behavior').value === '2' &&
      $('rain-quantity-number').value === '0.0008' &&
      !$('border-water-height-number').disabled
  );
  change('border-behavior', 0);
  check(
    'A blocked surface boundary disables only the boundary water height',
    $('border-water-height').disabled && !$('rain-quantity').disabled
  );
  change('terrain-generation', 'flat');
  check(
    'Flat mode keeps noise settings discoverable but inactive',
    $('terrain-scale').disabled &&
      $('terrain-scale-number').disabled &&
      !$('flat-rock-height').disabled
  );
  const before = actions.length;
  change('flat-rock-height-number', 0.23);
  check(
    'A terrain numeric edit performs the existing regeneration once',
    config.flatRockHeight === 0.23 &&
      actions.length === before + 1 &&
      actions.at(-1)[0] === 'terrain'
  );
  const beforeEnter = actions.length;
  $('flat-rock-height-number').value = '0.24';
  $('flat-rock-height-number').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
  );
  $('flat-rock-height-number').dispatchEvent(new Event('change', { bubbles: true }));
  check(
    'Enter followed by blur/change never regenerates twice',
    actions.length === beforeEnter + 1
  );
  change('terrain-generation', 'realistic');
  check(
    'Realistic mode restores noise controls and disables flat-only height',
    !$('terrain-scale').disabled && $('flat-rock-height-number').disabled
  );
  change('soil-static-repose-slope-number', 30);
  check(
    'Static repose changes synchronize both degree fields',
    $('soil-static-repose-slope-number').value === '30' &&
      $('soil-dynamic-repose-slope-number').value === '30'
  );
  change('soil-dynamic-repose-slope-number', 65);
  check(
    'Dynamic repose changes preserve the coupled slope constraint',
    $('soil-static-repose-slope-number').value === '65' &&
      config.soilDynamicReposeSlope <= config.soilStaticReposeSlope
  );
  change('brush-radius-number', 999);
  check('Numeric inputs clamp using the existing slider range', config.brushRadius === 200);
  change('brush-radius-number', '');
  check(
    'Empty numeric input restores the current value',
    $('brush-radius-number').value === '200' && config.brushRadius === 200
  );
  change('brush-strength-number', 0.72);
  check('Numeric input follows the original step precision', config.brushStrength === 0.7);
  change('weather-dynamics', 'forced');
  check(
    'Restart air stays discoverable with an explanation in continuously forced mode',
    $('btn-weather-restart-air').disabled &&
      !$('restart-air-group').hidden &&
      !$('restart-air-availability').hidden
  );
  change('closed-water-cycle', true);
  check(
    'Initial and imposed labels match the weather mode',
    document.querySelector('label[for="air-temperature"]').textContent.startsWith('Imposed') &&
      document.querySelector('label[for="relative-humidity"]').textContent.startsWith('Initial') &&
      document.querySelector('label[for="air-stability"]').textContent.startsWith('Initial')
  );
  click('[data-weather-preset="snow"]');
  check(
    'Presets synchronize ranges, numeric fields and selection without clearing surface reservoirs',
    config.airTemperature === -12 &&
      $('air-temperature-number').value === '-12' &&
      $('relative-humidity-number').value === '120' &&
      document.querySelector('[data-weather-preset="snow"]').getAttribute('aria-pressed') ===
        'true' &&
      actions.at(-1)[0] === 'weather' &&
      actions.at(-1)[1] === false
  );
  change('thermal-overlay', true);
  check(
    'Thermal overlay exposes its contextual controls and legend',
    $('thermal-controls').classList.contains('context-active') &&
      !$('view-legend').hidden &&
      !$('thermal-legend').hidden
  );
  change('thermal-mode', 'air');
  change('thermal-height-number', 9.375);
  check(
    'Air measurement enables exact height and updates the legend',
    config.thermalHeight === 9.375 &&
      $('thermal-legend-title').textContent.includes('9.38') &&
      !$('thermal-height-number').disabled
  );
  change('atmosphere-view', 2);
  check(
    'Atmospheric slice disables thermal overlay and exposes altitude',
    !config.thermalOverlay &&
      $('thermal-legend').hidden &&
      !$('slice-legend').hidden &&
      $('atmosphere-slice-group').classList.contains('context-active') &&
      !$('atmosphere-slice-number').disabled
  );
  change('atmosphere-slice-number', 75);
  check(
    'Slice altitude uses the normalized model value',
    config.atmosphereSlice === 0.75 && $('slice-legend-title').textContent.includes('75%')
  );
  change('thermal-overlay', true);
  check(
    'Returning to the overlay exits slice mode',
    config.atmosphereView === 0 && $('atmosphere-slice').disabled && $('slice-legend').hidden
  );
  for (const id of baseline.brushes) click('[data-brush="' + id + '"]');
  check(
    'Every brush still selects its original model identifier',
    config.brushType === Number(baseline.brushes.at(-1)) &&
      document.querySelectorAll('[data-brush][aria-pressed="true"]').length === 1
  );
  const actionCount = actions.length;
  [
    'btn-clear',
    'btn-reset',
    'btn-new-terrain',
    'btn-weather-restart-air',
    'btn-weather-reset',
  ].forEach((id) => $(id).click());
  check(
    'Reset and clear actions keep their distinct arguments',
    JSON.stringify(actions.slice(actionCount)) ===
      JSON.stringify([
        ['clear'],
        ['terrain', false],
        ['terrain', true],
        ['weather', false],
        ['weather', undefined],
      ])
  );
  click('#btn-pause');
  check(
    'Pause is shared with the weather status and top bar',
    config.paused &&
      $('runtime-state').textContent === 'Paused' &&
      $('weather-status').textContent.includes('paused')
  );
  check(
    'UI input exclusion includes SVG, controls, search and legends',
    isUIEventTarget(document.querySelector('.domain-button use')) &&
      isUIEventTarget($('brush-radius-number')) &&
      isUIEventTarget($('view-legend')) &&
      !isUIEventTarget($('canvas-container'))
  );
  searchFor('no setting has this name');
  check('Empty search has a clear result', document.querySelector('.empty-search') !== null);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check(
    'Escape closes search before the inspector',
    $('search-results').hidden && !$('inspector').hidden
  );
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check(
    'Escape closes inspector and returns focus to domain navigation',
    $('inspector').hidden && document.activeElement.hasAttribute('data-domain')
  );
}

try {
  await run();
  window.testResults = { passed: true, results };
} catch (error) {
  window.testResults = { passed: false, results, error: String(error) };
  console.error(error);
}
