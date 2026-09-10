// Run with Vite serving the app: node tests/run-ui.mjs
// Uses an isolated Chrome profile; never attaches to the user's browser.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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
  const shortcutState = await evaluate(`(async () => {
    const { config } = await import('/water-sim/src/config.ts');
    for (const [id, value] of [['sim-speed', '2'], ['atmosphere-time-scale', '2'], ['thermal-opacity', '60'], ['cloud-opacity', '30']]) {
      const source = document.getElementById(id);
      const shortcut = document.getElementById('quick-' + id);
      if (!source.closest('#inspector') || !shortcut.closest('.topbar')) return false;
      const original = source.value;
      shortcut.value = value;
      shortcut.dispatchEvent(new Event('input', { bubbles: true }));
      if (source.value !== value || (id === 'thermal-opacity' && !config.thermalOverlay)) return false;
      source.value = original;
      source.dispatchEvent(new Event('input', { bubbles: true }));
      if (shortcut.value !== original) return false;
    }
    return !config.thermalOverlay && config.thermalOpacity === 0 && !document.getElementById('thermal-overlay');
  })()`);
  check('Top bar shortcuts sync both ways and zero opacity disables temperature', shortcutState);
  await click('#btn-pause');
  await screenshot('desktop-1920-closed');
  await click('[data-domain="climate"]');
  await screenshot('desktop-1920-climate');
  await click('#toggle-advanced');
  await screenshot('desktop-1920-advanced');

  const sizes = [
    [1920, 1080],
    [1366, 768],
    [1000, 800],
    [390, 844],
  ];
  for (const [width, height] of sizes) {
    await call('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await settle();
    const layout = await evaluate(
      '(() => { const ids = ["inspector","power-dock"]; const rects = Object.fromEntries(ids.map(id=>{const r=document.getElementById(id).getBoundingClientRect();return [id,{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width}]})); const nav = document.querySelector(".domain-nav").getBoundingClientRect(); return {rects, overflow:document.documentElement.scrollWidth>innerWidth, columns:getComputedStyle(document.querySelector("#domain-climate")).gridTemplateColumns.split(" ").length, navBottom:nav.bottom, navTop:nav.top, navLeft:nav.left};})()'
    );
    const a = layout.rects.inspector,
      b = layout.rects['power-dock'];
    check(
      width + ': inspector and powers do not overlap or leave the viewport',
      a.x >= 0 &&
        a.right <= width &&
        a.bottom <= b.y &&
        b.bottom <= height &&
        !layout.overflow &&
        (width >= 760 || a.bottom <= layout.navTop),
      JSON.stringify(layout)
    );
    check(
      width + ': correct advanced inspector width and column count',
      layout.columns === (width >= 1100 ? 2 : 1) &&
        (width < 760 || Math.abs(a.width - (width >= 1100 ? 640 : 360)) < 1),
      JSON.stringify(layout)
    );
    await screenshot('layout-' + width + '-advanced');
    if (width >= 760) {
      check(
        width + ': inspector opens directly beside its navigation rail',
        a.right <= layout.navLeft && layout.navLeft - a.right <= 16,
        JSON.stringify(layout)
      );
      const barHeight = await evaluate(
        '({top:document.querySelector(".topbar").getBoundingClientRect().height,dock:document.getElementById("power-dock").getBoundingClientRect().height})'
      );
      check(
        width + ': command bars stay slim',
        barHeight.top <= 60 && barHeight.dock <= 80,
        JSON.stringify(barHeight)
      );
    }
  }
  for (const width of [1366, 390]) {
    await call('Emulation.setDeviceMetricsOverride', {
      width,
      height: width === 390 ? 844 : 768,
      deviceScaleFactor: 1,
      mobile: width === 390,
    });
    await call('Emulation.setTouchEmulationEnabled', { enabled: width === 390 });
    for (const domain of ['world', 'climate', 'water', 'sediments', 'observe', 'settings']) {
      await evaluate('document.querySelector("[data-domain=' + domain + ']").click()');
      if (domain !== 'settings')
        await evaluate('document.getElementById("toggle-advanced").click()');
      await settle();
      const overflowing = await evaluate(
        'Array.from(document.querySelectorAll("#inspector .setting-block, #inspector .range-row, #inspector .number-box, .time-controls, .power-tools")).filter(e => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1).map(e => e.className + ": " + e.scrollWidth + "/" + e.clientWidth)'
      );
      check(
        width + ': ' + domain + ' controls fit without internal horizontal clipping',
        overflowing.length === 0,
        JSON.stringify(overflowing)
      );
      if (domain === 'observe') {
        await evaluate(
          '(() => { const e=document.getElementById("quick-thermal-opacity"); e.value="45"; e.dispatchEvent(new Event("input", {bubbles:true})); })()'
        );
        await settle();
        const legend = await evaluate(
          '(() => { const e=document.getElementById("view-legend"); const r=e.getBoundingClientRect();return {visible:!e.hidden&&getComputedStyle(e).visibility!=="hidden",inInspector:!!e.closest("#inspector"),right:r.right,width:innerWidth};})()'
        );
        check(
          width + ': active legend remains available with the inspector open',
          legend.visible && legend.inInspector === (width === 390) && legend.right <= legend.width,
          JSON.stringify(legend)
        );
        await screenshot('observe-' + width + '-legend');
        await evaluate(
          '(() => { const e=document.getElementById("thermal-opacity"); e.value="0"; e.dispatchEvent(new Event("input", {bubbles:true})); })()'
        );
      } else if (domain === 'sediments') await screenshot('sediments-' + width);
    }
  }
  await call('Emulation.setTouchEmulationEnabled', { enabled: false });
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1366,
    height: 768,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await click('[data-domain="world"]');
  await screenshot('desktop-1366-world');

  // Observe the production input path at the GPU boundary without modifying shaders.
  await evaluate(
    '(async()=>{const {GPGPUSimulation}=await import("/water-sim/src/webgpuRenderer.ts");const proto=GPGPUSimulation.prototype;const brush=proto.setBrush;const render=proto.render;window.uiPaintActive=false;window.uiAnyPaint=false;proto.setBrush=function(active,...args){window.uiPaintActive=active;window.uiAnyPaint ||= active;return brush.call(this,active,...args)};proto.render=function(camera){window.uiCamera=camera;return render.call(this,camera)};})()'
  );
  await click('[data-brush="1"]');
  check('Clicking a power never paints through the dock', !(await evaluate('window.uiAnyPaint')));
  await click('#terrain-sand-height-number');
  const cameraBefore = await evaluate('window.uiCamera.position.toArray()');
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'w',
    code: 'KeyW',
    windowsVirtualKeyCode: 87,
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  await call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'w',
    code: 'KeyW',
    windowsVirtualKeyCode: 87,
  });
  const cameraAfter = await evaluate('window.uiCamera.position.toArray()');
  check(
    'Typing in a numeric field does not move the camera',
    JSON.stringify(cameraBefore) === JSON.stringify(cameraAfter)
  );
  check('Editing inspector controls never starts a brush', !(await evaluate('window.uiAnyPaint')));
  // Real browser key events must move the camera without reactivating focused UI.
  await click('[data-domain="observe"]');
  const checkboxSelector = await evaluate(`(() => {
    const box = [...document.querySelectorAll('#domain-observe input[type="checkbox"]')]
      .find(e => !e.disabled && e.getBoundingClientRect().height > 0);
    return '#' + box.id;
  })()`);
  await click(checkboxSelector);
  const checkboxBefore = await evaluate(
    `document.querySelector(${JSON.stringify(checkboxSelector)}).checked`
  );
  const movement = await evaluate(`(async () => {
    const start = window.uiCamera.position.clone();
    return start.toArray();
  })()`);
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: ' ',
    code: 'Space',
    windowsVirtualKeyCode: 32,
  });
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'w',
    code: 'KeyW',
    windowsVirtualKeyCode: 87,
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'w',
    code: 'KeyW',
    windowsVirtualKeyCode: 87,
  });
  await call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: ' ',
    code: 'Space',
    windowsVirtualKeyCode: 32,
  });
  check(
    'WASD still moves the camera after clicking a checkbox',
    JSON.stringify(movement) !==
      JSON.stringify(await evaluate('window.uiCamera.position.toArray()'))
  );
  check(
    'Space does not toggle the focused checkbox',
    checkboxBefore ===
      (await evaluate(`document.querySelector(${JSON.stringify(checkboxSelector)}).checked`))
  );
  await click('#close-inspector');
  await evaluate(`(async () => {
    const { GPGPUSimulation } = await import('/water-sim/src/webgpuRenderer.ts');
    const original = GPGPUSimulation.prototype.setBrushPreview;
    GPGPUSimulation.prototype.setBrushPreview = function(uv, radius, type) {
      window.uiPreview = uv ? { x: uv.x, y: uv.y, radius, type } : null;
      return original.call(this, uv, radius, type);
    };
  })()`);
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 683, y: 380 });
  const hoverDeadline = Date.now() + 10000;
  while (!(await evaluate('Boolean(window.uiPreview)')) && Date.now() < hoverDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check(
    'Hovering terrain previews the selected brush before clicking',
    await evaluate('window.uiPreview?.type === 1 && !window.uiPaintActive')
  );
  await screenshot('desktop-brush-preview');
  // Click the visible terrain, then cross into the dock while still dragging.
  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: 683,
    y: 380,
    button: 'left',
    clickCount: 1,
  });
  await settle();
  check('Painting remains available on the world canvas', await evaluate('window.uiPaintActive'));
  await call('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 683,
    y: 705,
    button: 'left',
    buttons: 1,
  });
  await settle();
  check(
    'Dragging from the world into the dock stops painting',
    !(await evaluate('window.uiPaintActive'))
  );
  check(
    'Crossing into the dock also hides the brush preview',
    await evaluate('window.uiPreview === null')
  );
  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: 683,
    y: 705,
    button: 'left',
    clickCount: 1,
  });
  await click('.camera-help');
  await screenshot('desktop-1366-settings');
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
