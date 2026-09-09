// Start Vite first. Usage: node tests/run-gpu.mjs sediments brushes bottom-ice
// Set CHROME_PATH and TEST_BASE_URL when the defaults do not match your setup.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const profile = await mkdtemp(join(tmpdir(), 'water-sim-gpu-'));
const executable =
  process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = spawn(
  executable,
  [
    '--headless=new',
    '--enable-unsafe-webgpu',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
);
let socket;
try {
  const browserUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Browser startup timeout')), 30000);
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
  const target = await (await fetch(`${origin}/json/new?about:blank`, { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
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
  const suites = process.argv.slice(2);
  if (!suites.length) suites.push('sediments');
  for (const suite of suites) {
    await call('Page.navigate', {
      url: `${process.env.TEST_BASE_URL || 'http://localhost:5173/water-sim'}/tests/${suite}.html`,
    });
    const deadline = Date.now() + 300000;
    let outcome;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const { result } = await call('Runtime.evaluate', {
        expression: 'window.testResults',
        returnByValue: true,
      });
      outcome = result.value;
      if (outcome) break;
    }
    if (!outcome) {
      const state = await call('Runtime.evaluate', {
        expression: 'document.body.innerText',
        returnByValue: true,
      });
      throw new Error(`${suite}: timed out\n${state.result.value}`);
    }
    console.log(
      JSON.stringify(
        process.env.TEST_VERBOSE
          ? { suite, ...outcome }
          : {
              suite,
              passed: outcome.passed,
              checks: outcome.results.length,
              ...(outcome.error ? { error: outcome.error } : {}),
            }
      )
    );
    if (!outcome.passed) {
      process.exitCode = 1;
      continue;
    }
    if (process.env.TEST_SCREENSHOT) {
      const { result } = await call('Runtime.evaluate', {
        expression: `(() => { const r = document.querySelector('canvas').getBoundingClientRect();
          return {x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height, scale: 1}; })()`,
        returnByValue: true,
      });
      const { data } = await call('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: result.value,
      });
      await writeFile(process.env.TEST_SCREENSHOT, Buffer.from(data, 'base64'));
    }
    // Release this suite's GPU devices before loading the next one.
    await call('Page.navigate', { url: 'about:blank' });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
} finally {
  socket?.close();
  browser.kill();
  await new Promise((resolve) =>
    browser.exitCode !== null ? resolve() : browser.once('exit', resolve)
  );
  if (dirname(resolve(profile)) !== resolve(tmpdir()))
    throw new Error('Unexpected browser profile directory');
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
