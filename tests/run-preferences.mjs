// Run with Vite serving the app: node tests/run-preferences.mjs
// Uses an isolated Chrome profile; never attaches to the user's browser.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const testBase = (process.env.TEST_BASE_URL || 'http://localhost:5173/water-sim').replace(
  /\/$/,
  ''
);
const server = await fetch(testBase + '/', { signal: AbortSignal.timeout(5000) }).catch(() => null);
if (!server?.ok) throw new Error('Start Vite first with npm run dev. Expected server: ' + testBase);

const profile = await mkdtemp(join(tmpdir(), 'terragpu-ui-browser-'));
const output =
  process.env.UI_ARTIFACT_DIR || (await mkdtemp(join(tmpdir(), 'terragpu-ui-review-')));
await mkdir(output, { recursive: true });
const browser = spawn(
  process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  [
    '--headless=new',
    '--enable-unsafe-webgpu',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    '--window-size=1920,1080',
    'about:blank',
  ],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
);
let socket;
const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed: Boolean(passed), detail });
  if (!passed) throw new Error(name + ': ' + detail);
}
try {
  const browserUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Chrome startup timeout')), 30000);
    let log = '';
    browser.on('error', reject);
    browser.stderr.on('data', (chunk) => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
  });
  const origin = new URL(browserUrl).origin.replace('ws:', 'http:');
  const target = await (await fetch(origin + '/json/new?about:blank', { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.id) {
      const callback = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) callback.reject(message.error);
      else callback.resolve(message.result);
    }
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const response = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const settle = () =>
    evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const base = process.env.TEST_BASE_URL || 'http://localhost:5173/water-sim';
  const waitReady = async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const ready = await evaluate(`document.getElementById('runtime-state')?.textContent`);
      if (ready === 'Running' || ready === 'Paused') {
        await settle();
        return;
      }
      if (ready === 'Unavailable') throw new Error('WebGPU unavailable');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('App initialization timeout');
  };
  const { identifier } = await call('Page.addScriptToEvaluateOnNewDocument', {
    source: "localStorage.clear(); localStorage.setItem('unrelated', 'keep');",
  });
  await call('Page.navigate', { url: base + '/' });
  await waitReady();
  await call('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  await evaluate("localStorage.setItem('unrelated', 'keep')");
  const migrationSeed = await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('terragpu.preferences.v1',JSON.stringify({weatherModel:'previous-model',config:{waterGravity:13,brushType:10,cloudAltitude:7,solarHeating:50,weatherView:9,weatherTimeScale:7,windSpeed:2}}))`,
  });
  await call('Page.reload');
  await waitReady();
  await call('Page.removeScriptToEvaluateOnNewDocument', { identifier: migrationSeed.identifier });
  const migrated = await evaluate(
    `(async()=>{const {config}=await import(performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname.endsWith('/src/config.ts')).name);const {savePreferences}=await import(performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname.endsWith('/src/preferences.ts')).name);savePreferences();return {...config,stored:JSON.parse(localStorage.getItem('terragpu.preferences.v1'))};})()`
  );
  check(
    'Previous weather settings migrate while terrain and fluid preferences remain',
    migrated.waterGravity === 13 &&
      migrated.brushType === 0 &&
      migrated.cloudAltitude === 40 &&
      migrated.solarHeating === 1 &&
      migrated.weatherView === 0,
    JSON.stringify(migrated)
  );
  check(
    'Removed parameters are discarded on save',
    migrated.stored.weatherModel === 'painted-weather-v1' &&
      !('weatherTimeScale' in migrated.stored.config) &&
      !('windSpeed' in migrated.stored.config)
  );
  const observeCamera = async (move = false) => {
    await evaluate(`(async () => {
      const {GPGPUSimulation} = await import(performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname.endsWith('/src/webgpuRenderer.ts')).name);
      const render = GPGPUSimulation.prototype.render;
      let move = ${move};
      GPGPUSimulation.prototype.render = function(camera) {
        if (move) { camera.position.set(180, 160, 210); move = false; }
        window.testCamera = {position: camera.position.toArray(), quaternion: camera.quaternion.toArray()};
        return render.call(this, camera);
      };
    })()`);
    await settle();
  };
  await observeCamera(true);
  const expected = await evaluate(`(async () => {
    const {config} = await import(performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname.endsWith('/src/config.ts')).name);
    document.querySelector('[data-brush="9"]').click();
    for(const [id,value] of [['cooling-middle-altitude','9.7'],['cooling-middle','1.23'],['cooling-high','2.18'],['albedo-strength','1.7']]) {const e=document.getElementById(id);e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));}
    const border=document.getElementById('border-mode');border.value='1';border.dispatchEvent(new Event('change',{bubbles:true}));
    const radius = document.getElementById('brush-radius');
    radius.value = '27'; radius.dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('btn-pause').click();
    document.querySelector('[data-domain="climate"]').click();
    const search = document.getElementById('command-search');
    search.value = 'cooling'; search.dispatchEvent(new Event('input', {bubbles:true}));
    return {...config};
  })()`);
  await evaluate(`new Promise(resolve => setTimeout(resolve, 350))`);
  const before = await evaluate(`JSON.parse(localStorage.getItem('terragpu.preferences.v1'))`);
  check(
    'Every configuration option is stored',
    JSON.stringify(before.config) === JSON.stringify(expected),
    JSON.stringify({ before: before.config, expected })
  );
  await call('Page.reload');
  await waitReady();
  await observeCamera();
  check(
    'Camera position and orientation survive reload',
    JSON.stringify(await evaluate('window.testCamera')) === JSON.stringify(before.camera)
  );
  const restored = await evaluate(`(async () => {
    const {config} = await import(performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname.endsWith('/src/config.ts')).name);
    return {config: {...config}, domain: !document.getElementById('domain-climate').hidden,
      search: document.getElementById('command-search').value,
      brush: document.querySelector('[data-brush="9"]').getAttribute('aria-pressed'),
      radius: document.getElementById('brush-radius').value,
      pause: document.getElementById('btn-pause').textContent.trim()};
  })()`);
  check(
    'All configuration values survive a real reload',
    JSON.stringify(restored.config) === JSON.stringify(expected)
  );
  check(
    'Brush, sliders, pause, open tab and search are restored',
    restored.domain &&
      restored.search === 'cooling' &&
      restored.brush === 'true' &&
      restored.radius === '27' &&
      restored.pause === 'Resume',
    JSON.stringify(restored)
  );
  await evaluate(`document.getElementById('btn-reset-defaults').click()`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await waitReady();
  await observeCamera();
  check(
    'Reset restores the initial camera',
    JSON.stringify(await evaluate('window.testCamera.position')) === '[185,155,215]'
  );
  const reset = await evaluate(`(async () => {
    const {config} = await import(performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname.endsWith('/src/config.ts')).name);
    const {defaultConfig} = await import(performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname.endsWith('/src/preferences.ts')).name);
    return {defaults: JSON.stringify(config) === JSON.stringify(defaultConfig),
      closed: document.getElementById('inspector').hidden,
      search: document.getElementById('command-search').value,
      brush: document.querySelector('[data-brush="0"]').getAttribute('aria-pressed'),
      unrelated: localStorage.getItem('unrelated')};
  })()`);
  check(
    'Reset restores every default and the initial interface',
    reset.defaults && reset.closed && reset.search === '' && reset.brush === 'true',
    JSON.stringify(reset)
  );
  check('Reset preserves unrelated localStorage', reset.unrelated === 'keep');
  check('No uncaught browser exceptions', errors.length === 0, JSON.stringify(errors));
  console.log(JSON.stringify({ passed: true, checks: checks.length, output }));
} catch (error) {
  process.exitCode = 1;
  console.error(JSON.stringify({ passed: false, checks, error: String(error), output }));
} finally {
  await writeFile(join(output, 'checks.json'), JSON.stringify(checks, null, 2));
  socket?.close();
  browser.kill();
  await new Promise((resolve) =>
    browser.exitCode !== null ? resolve() : browser.once('exit', resolve)
  );
  if (dirname(resolve(profile)) !== resolve(tmpdir()))
    throw new Error('Unexpected browser profile directory');
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
