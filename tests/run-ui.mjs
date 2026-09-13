// Run with Vite serving the app: node tests/run-ui.mjs
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
  const click = async (selector) => {
    const point = await evaluate(
      '(() => { const e = document.querySelector(' +
        JSON.stringify(selector) +
        '); e.scrollIntoView({block:"nearest"}); const r = e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()'
    );
    await call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      clickCount: 1,
      ...point,
    });
    await call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      clickCount: 1,
      ...point,
    });
    await settle();
  };
  const waitFor = async (expression) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    await screenshot('failure');
    const state = await evaluate(
      '(()=>{const e=window.testEngine;return {hit:document.elementFromPoint(620,355)?.outerHTML.slice(0,300),brush:e?.brushType,active:e?.brushActive,uv:e?.pointerUV,preview:Array.from(e?.brushPreview??[]),state:document.getElementById("runtime-state")?.textContent,alert:document.getElementById("simulation-alert")?.textContent,scroll:[scrollX,scrollY],canvas:document.querySelector("canvas").getBoundingClientRect().toJSON()};})()'
    );
    throw new Error('UI condition timed out: ' + expression + ' ' + JSON.stringify(state));
  };
  const screenshot = async (name) => {
    const { data } = await call('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    await writeFile(join(output, name + '.png'), Buffer.from(data, 'base64'));
  };
  await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const base = process.env.TEST_BASE_URL || 'http://localhost:5173/water-sim';
  await call('Page.navigate', { url: base + '/' });
  const deadline = Date.now() + 120000;
  let state;
  do {
    await new Promise((resolve) => setTimeout(resolve, 500));
    state = await evaluate('document.getElementById("runtime-state")?.textContent');
    if (state === 'Unavailable')
      throw new Error(await evaluate('document.getElementById("simulation-alert").textContent'));
  } while (state !== 'Running' && Date.now() < deadline);
  check('Production app initializes WebGPU and the command UI', state === 'Running');
  await evaluate('document.fonts.ready.then(() => true)');

  await click('#btn-pause');
  await evaluate(
    '(async()=>{const {GPGPUSimulation}=await import(performance.getEntriesByType("resource").find(e=>new URL(e.name).pathname.endsWith("/src/webgpuRenderer.ts")).name);const proto=GPGPUSimulation.prototype;const brush=proto.setBrush;const render=proto.render;window.uiAnyPaint=false;proto.setBrush=function(active,...args){window.uiAnyPaint ||= active;return brush.call(this,active,...args)};proto.render=function(camera){window.testEngine=this;window.testCamera=camera;return render.call(this,camera)};})()'
  );
  await click('[data-domain="climate"]');
  check(
    'Three cooling points are present',
    await evaluate('document.querySelectorAll("#cooling-curve [data-point]").length===3')
  );
  await evaluate('document.getElementById("cooling-curve").scrollIntoView({block:"center"})');
  await settle();
  const middle = await evaluate(
    '(()=>{const r=document.querySelectorAll("#cooling-curve g circle:first-child")[1].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()'
  );
  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    clickCount: 1,
    ...middle,
  });
  await call('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    buttons: 1,
    button: 'left',
    x: middle.x + 35,
    y: middle.y - 20,
  });
  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 1,
    x: middle.x + 35,
    y: middle.y - 20,
  });
  const edited = await evaluate(
    '(async()=>{const {config}=await import(performance.getEntriesByType("resource").find(e=>new URL(e.name).pathname.endsWith("/src/config.ts")).name);return {altitude:config.coolingMiddleAltitude,power:config.coolingMiddle};})()'
  );
  await screenshot('curve-after-drag');
  check(
    'Dragging the middle point changes altitude and cooling',
    edited.altitude > 16 && edited.power > 1,
    JSON.stringify(edited)
  );
  check(
    'Dragging climate controls does not paint through the inspector',
    !(await evaluate('window.uiAnyPaint'))
  );
  await screenshot('climate-three-points');
  for (const [width, height] of [
    [1920, 1080],
    [1366, 768],
    [1000, 800],
    [390, 844],
  ]) {
    await call('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await settle();
    const layout = await evaluate(
      '(()=>{const i=document.getElementById("inspector").getBoundingClientRect(),d=document.getElementById("power-dock").getBoundingClientRect();return {x:i.x,right:i.right,bottom:i.bottom,dockTop:d.y,dockBottom:d.bottom,overflow:document.documentElement.scrollWidth>innerWidth};})()'
    );
    check(
      width + ': inspector and dock stay within the viewport',
      layout.x >= 0 &&
        layout.right <= width + 1 &&
        layout.bottom <= layout.dockTop + 1 &&
        layout.dockBottom <= height + 1 &&
        !layout.overflow,
      JSON.stringify(layout)
    );
    await screenshot('layout-' + width);
  }
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1366,
    height: 768,
    deviceScaleFactor: 1,
    mobile: false,
  });
  for (const domain of ['world', 'climate', 'sun', 'water', 'sediments', 'observe', 'settings']) {
    await evaluate(
      '(()=>{const b=document.querySelector("[data-domain=' +
        domain +
        ']");if(document.getElementById("domain-' +
        domain +
        '").hidden)b.click();})()'
    );
    await settle();
    const overflow = await evaluate(
      'Array.from(document.querySelectorAll("#inspector .setting-block, #inspector .range-row")).filter(e=>e.getClientRects().length&&e.scrollWidth>e.clientWidth+1).map(e=>e.className)'
    );
    check(
      domain + ': controls have no horizontal clipping',
      overflow.length === 0,
      JSON.stringify(overflow)
    );
  }
  await evaluate(
    '(()=>{const e=document.getElementById("weather-view");e.value="surface";e.dispatchEvent(new Event("change",{bubbles:true}));})()'
  );
  check(
    'Surface temperature overlay is available',
    await evaluate(
      '!document.getElementById("thermal-legend").hidden && !document.getElementById("view-legend").hidden'
    )
  );
  await evaluate(
    '(()=>{const e=document.getElementById("weather-view");e.value="0";e.dispatchEvent(new Event("change",{bubbles:true}));document.getElementById("close-inspector").click();})()'
  );
  await click('[data-brush="10"]');
  await evaluate(
    '(()=>{const e=document.getElementById("brush-radius");e.value="130";e.dispatchEvent(new Event("input",{bubbles:true}));})()'
  );
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 620, y: 355 });
  await settle();
  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    clickCount: 1,
    x: 620,
    y: 355,
  });
  await waitFor('window.testEngine?.brushActive===1');
  await new Promise((r) => setTimeout(r, 1200));
  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 1,
    x: 620,
    y: 355,
  });
  check(
    'Cloud brush paints through the normal canvas input path',
    await evaluate('window.uiAnyPaint')
  );
  await screenshot('painted-clouds-paused');
  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'right',
    clickCount: 1,
    x: 620,
    y: 355,
  });
  await waitFor('window.testEngine?.brushType===12');
  check(
    'Right-drag selects cloud erasing rather than terrain erasing',
    await evaluate('window.testEngine.brushType===12')
  );
  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'right',
    clickCount: 1,
    x: 620,
    y: 355,
  });
  await click('[data-brush="0"]');
  await click('#btn-pause');
  await new Promise((r) => setTimeout(r, 2000));
  await screenshot('painted-weather-running');
  check(
    'Production renderer stays healthy',
    await evaluate('document.getElementById("simulation-alert").hidden')
  );
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
