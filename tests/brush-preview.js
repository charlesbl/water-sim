import * as THREE from 'three';
import { config } from '../src/config.ts';
import { GPGPUSimulation } from '../src/webgpuRenderer.ts';

const results = [];
function check(name, passed) {
  results.push({ name, passed: Boolean(passed) });
  if (!passed) throw new Error(name);
}
async function run() {
  Object.assign(config, { paused: true, atmosphereEnabled: false, cloudRendering: false });
  const canvas = document.querySelector('canvas');
  const engine = new GPGPUSimulation(canvas, 96);
  check('WebGPU initializes the production preview shader', await engine.initWebGPU());
  const errors = [];
  engine.device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const terrain = new Float32Array(96 * 96 * 6);
  for (let y = 0; y < 96; y++)
    for (let x = 0; x < 96; x++) {
      const i = (y * 96 + x) * 6;
      terrain[i] = 0.6 + 2.0 * Math.exp(-((x - 46) ** 2 + (y - 52) ** 2) / 450);
      terrain[i + 1] = 0.1;
    }
  for (const buffer of [engine.terrainBufferA, engine.terrainBufferB]) {
    engine.device.queue.writeBuffer(buffer, 0, terrain);
  }
  const camera = new THREE.PerspectiveCamera(50, canvas.width / canvas.height, 0.1, 1000);
  camera.position.set(160, 135, 180);
  camera.lookAt(0, 20, 0);
  camera.updateMatrixWorld();
  await engine.performPicking(camera, canvas.width / 2, canvas.height / 2);
  const hit = engine.pointerUV?.clone();
  check('Picking resolves the relief with canvas dimensions independent of the window', hit);
  for (const smooth of [false, true])
    for (const type of [0, 2, 7, 8]) {
      config.smoothRendering = smooth;
      engine.setBrushPreview(hit, 15, type);
      engine.setBrush(false, hit, type, 15, 1);
      check(
        'Preview radius matches the simulation radius: ' + smooth + '/' + type,
        engine.brushPreview[2] === engine.brushRadius
      );
      engine.render(camera);
      await engine.device.queue.onSubmittedWorkDone();
    }
  engine.setBrushPreview(null, 15, 0);
  check('Clearing the hover hides the preview', engine.brushPreview[2] === 0);
  camera.lookAt(0, 300, 0);
  camera.updateMatrixWorld();
  await engine.performPicking(camera, canvas.width / 2, canvas.height / 2);
  check('Picking the sky clears the previous terrain hit', engine.pointerUV === null);
  camera.lookAt(0, 20, 0);
  camera.updateMatrixWorld();
  engine.setBrushPreview(hit, 15, 2);
  engine.render(camera);
  await engine.device.queue.onSubmittedWorkDone();
  check(
    'Rendering and picking produce no GPU errors',
    engine.resourcesReady && errors.length === 0
  );
  window.testResults = { passed: true, results };
}
run().catch((error) => {
  window.testResults = { passed: false, error: String(error), results };
  document.querySelector('#results').textContent = JSON.stringify(window.testResults, null, 2);
});
