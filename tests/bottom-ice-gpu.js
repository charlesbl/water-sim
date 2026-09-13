import { terrainFixture } from './terrain-fixture.js';
import { config } from '../src/config.ts';
import { GPGPUSimulation } from '../src/webgpuRenderer.ts';
import * as THREE from 'three';

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, passed: !!condition, detail });
  document.querySelector('#results').textContent = JSON.stringify(results, null, 2);
  if (!condition) throw new Error(`${name}: ${detail}`);
}
async function read(device, buffer) {
  const staging = device.createBuffer({
    size: buffer.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, buffer.size);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return result;
}
function sum(data, offset, stride = 4) {
  let total = 0;
  for (let i = offset; i < data.length; i += stride) total += data[i];
  return total;
}
function maximumDifference(a, b) {
  let maximum = 0;
  for (let i = 0; i < a.length; i++) maximum = Math.max(maximum, Math.abs(a[i] - b[i]));
  return maximum;
}
async function run() {
  Object.assign(config, {
    weatherEnabled: false,
    terrainType: 1,
    flatRockHeight: 0.1,
    terrainSandHeight: 0,
    terrainSoilHeight: 0,
    renderResolution: 0.5,
    erosionRate: 0,
    paused: false,
    smoothRendering: false,
    cloudOpacity: 0,
  });
  const engine = new GPGPUSimulation(document.querySelector('canvas'), 96);
  const engineErrors = [];
  window.addEventListener('simulation-error', (event) => engineErrors.push(event.detail));
  check('Full engine initializes with anchored bottom ice', await engine.initWebGPU());
  engine.device.addEventListener('uncapturederror', (event) =>
    engineErrors.push(event.error.message)
  );
  engine.step();
  engine.stepWeather(0);
  const engineFluid = new Float32Array(96 * 96 * 4);
  const engineSurface = new Float32Array(engineFluid.length);
  const engineTerrain = new Float32Array(engineFluid.length);
  const upload = () => {
    engine.device.queue.writeBuffer(engine.terrainBufferA, 0, terrainFixture(engineTerrain));
    engine.device.queue.writeBuffer(engine.terrainBufferB, 0, terrainFixture(engineTerrain));
    engine.device.queue.writeBuffer(engine.fluidsBufferA, 0, engineFluid);
    engine.device.queue.writeBuffer(engine.fluidsBufferB, 0, engineFluid);
    engine.device.queue.writeBuffer(engine.weather.surfaceBuffer, 0, engineSurface);
  };
  const currentFluid = () => (engine.pingPongToggle ? engine.fluidsBufferB : engine.fluidsBufferA);
  for (let y = 0; y < 96; y++)
    for (let x = 0; x < 96; x++) {
      const i = (y * 96 + x) * 4;
      const ice = 0.04 + 0.02 * Math.sin((x * 2 * Math.PI) / 96);
      engineTerrain[i] = 0.1;
      engineSurface[i + 1] = ice;
      engineSurface[i + 2] = -2;
      engineFluid[i] = 0.5 - ice / 0.917;
    }
  upload();
  for (let i = 0; i < 100; i++) engine.step();
  const stillLake = await read(engine.device, currentFluid());
  check(
    'A level lake above a nonuniform frozen bed stays at hydraulic rest',
    maximumDifference(stillLake, engineFluid) < 0.000002,
    `max liquid change=${maximumDifference(stillLake, engineFluid)}`
  );

  for (let y = 0; y < 96; y++)
    for (let x = 0; x < 96; x++) {
      const i = (y * 96 + x) * 4;
      engineSurface[i + 1] = 0.06;
      engineFluid[i] = 0.4 + (x < 48 ? 0.08 : 0);
    }
  upload();
  const beforeTransport = sum(engineFluid, 0);
  for (let i = 0; i < 100; i++) engine.step();
  const circulating = await read(engine.device, currentFluid());
  let enteredRight = 0;
  for (let y = 0; y < 96; y++)
    for (let x = 48; x < 96; x++) {
      const i = (y * 96 + x) * 4;
      enteredRight += circulating[i] - engineFluid[i];
    }
  check(
    'Liquid flows across a fixed frozen bed',
    enteredRight > 0.1,
    `water transferred across lake midpoint=${enteredRight}`
  );
  check(
    'Flow conserves water and does not advect the ice or rock',
    Math.abs(sum(circulating, 0) - beforeTransport) / beforeTransport < 0.00001 &&
      maximumDifference(await read(engine.device, engine.weather.surfaceBuffer), engineSurface) ===
        0 &&
      maximumDifference(
        await read(
          engine.device,
          engine.pingPongToggle ? engine.terrainBufferB : engine.terrainBufferA
        ),
        terrainFixture(engineTerrain)
      ) === 0
  );

  for (let i = 0; i < engineFluid.length; i += 4) {
    engineFluid[i] = 0.1;
    engineSurface[i] = 0.003;
    engineSurface[i + 1] = 0.06;
    engineSurface[i + 2] = 5;
  }
  upload();
  engine.step();
  const floodedWithoutWeather = await read(engine.device, engine.weather.surfaceBuffer);
  const waterWithoutWeather = await read(engine.device, currentFluid());
  check(
    'Flooded snow becomes water even while weather is disabled',
    sum(floodedWithoutWeather, 0) === 0 &&
      Math.abs(sum(waterWithoutWeather, 0) - sum(engineFluid, 0) - sum(engineSurface, 0)) < 0.001 &&
      floodedWithoutWeather[2] < engineSurface[2],
    `snow=${sum(floodedWithoutWeather, 0)}, liquid=${sum(waterWithoutWeather, 0)}, temperature=${floodedWithoutWeather[2]}`
  );
  for (let i = 0; i < engineSurface.length; i += 4) engineSurface[i] = 0;

  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 1000);
  camera.position.set(0, 45, 70);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  for (let i = 0; i < engineFluid.length; i += 4) engineFluid[i] = 0.2;
  upload();
  engine.render(camera);
  await engine.performPicking(camera, innerWidth / 2, innerHeight / 2);
  const firstPick = engine.pointerUV?.clone();
  for (let i = 0; i < engineFluid.length; i += 4) engineFluid[i] = 0.6;
  upload();
  engine.render(camera);
  await engine.performPicking(camera, innerWidth / 2, innerHeight / 2);
  const deeperPick = engine.pointerUV?.clone();
  check(
    'The rendered and picked frozen bed stays fixed when lake depth changes',
    firstPick && deeperPick && firstPick.distanceTo(deeperPick) < 0.000001,
    `first=${JSON.stringify(firstPick)}, deeper=${JSON.stringify(deeperPick)}`
  );
  for (let i = 0; i < engineSurface.length; i += 4) engineSurface[i + 1] = 0.12;
  upload();
  engine.render(camera);
  await engine.performPicking(camera, innerWidth / 2, innerHeight / 2);
  check(
    'Additional frozen mass raises the solid bed used by picking',
    firstPick && engine.pointerUV && firstPick.distanceTo(engine.pointerUV) > 0.001,
    `initial=${JSON.stringify(firstPick)}, grown=${JSON.stringify(engine.pointerUV)}`
  );
  await engine.device.queue.onSubmittedWorkDone();
  check(
    'Rendering, picking and fluid flow produce no GPU validation errors',
    engine.resourcesReady && engineErrors.length === 0,
    engineErrors.join('\n')
  );
  window.testResults = { passed: true, results };
}

run().catch((error) => {
  console.error(error);
  window.testResults = { passed: false, error: String(error), results };
  document.querySelector('#results').textContent = JSON.stringify(window.testResults, null, 2);
});
