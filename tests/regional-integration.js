import { config } from '../src/config.ts';
import { GPGPUSimulation } from '../src/webgpuRenderer.ts';
import { WEATHER_TIMESTEP } from '../src/atmosphere.ts';
import * as THREE from 'three';

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed: !!passed, detail });
  document.querySelector('#results').textContent = JSON.stringify(results, null, 2);
  if (!passed) throw new Error(name + ': ' + JSON.stringify(detail));
}
async function run() {
  const n = 2048;
  const engine = new GPGPUSimulation(document.querySelector('canvas'), n);
  check('Production 2048² terrain/water and 256² × 2 air initialize', await engine.initWebGPU());
  const { device, atmosphere: air } = engine;
  const errors = [];
  window.addEventListener('simulation-error', (e) => errors.push(e.detail));
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const read = async (buffer) => {
    const staging = device.createBuffer({
      size: buffer.size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, buffer.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return values;
  };
  const fluids = () => (engine.pingPongToggle ? engine.fluidsBufferB : engine.fluidsBufferA);
  const inventory = async () => {
    let surfaceTotal = 0,
      airTotal = 0,
      liquid = 0;
    const water = await read(fluids());
    for (let i = 0; i < water.length; i += 4) {
      liquid += water[i];
      surfaceTotal += water[i] + water[i + 3];
    }
    const ground = await read(air.surfaceBuffer);
    for (let i = 0; i < ground.length; i += 4)
      surfaceTotal += ground[i] + ground[i + 1] + ground[i + 3];
    const state = await read(air.volumeBuffer);
    for (let i = 0; i < state.length; i += 8)
      airTotal += state[i + 4] + state[i + 5] + state[i + 6] + state[i + 7];
    return {
      total:
        surfaceTotal * (200 / n) ** 2 * config.heightScale +
        (airTotal * 40000 * air.domainHeight) / (state.length / 8),
      liquid,
    };
  };
  engine.step();
  engine.stepAtmosphere(0);
  const before = await inventory();
  // Same 60 Hz surface / 20 Hz atmosphere order as the real app.
  for (let i = 0; i < 200; i++) {
    engine.step();
    engine.step();
    engine.step();
    engine.stepAtmosphere(WEATHER_TIMESTEP);
    if (i % 10 === 9) await device.queue.onSubmittedWorkDone();
  }
  const after = await inventory();
  check(
    'Coupled rain and liquid flow conserve water on the full scene',
    Math.abs(after.total / before.total - 1) < 0.0005,
    { drift: after.total / before.total - 1 }
  );
  check('Atmospheric rain reaches the production fine water grid', after.liquid > before.liquid, {
    before: before.liquid,
    after: after.liquid,
  });
  engine.sampleWaterBudget();
  await device.queue.onSubmittedWorkDone();
  for (let i = 0; i < 100 && !engine.waterBudget.latest; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const measured = engine.waterBudget.latest;
  check(
    'Displayed GPU inventory agrees with independent CPU integration',
    measured && Math.abs(measured.total / after.total - 1) < 0.00001,
    { gpu: measured?.total, cpu: after.total }
  );
  const camera = new THREE.PerspectiveCamera(50, 960 / 640, 0.1, 1000);
  camera.up.set(0, 0, 1);
  camera.position.set(175, -210, 175);
  camera.lookAt(0, 0, 5);
  camera.updateMatrixWorld();
  for (let view = 0; view <= 5; view++) {
    config.atmosphereView = view;
    for (const layer of [0, 1]) {
      config.atmosphereSlice = layer;
      engine.render(camera);
      await device.queue.onSubmittedWorkDone();
    }
    check(
      'Weather view ' + view + ' renders both layer selections without GPU errors',
      errors.length === 0,
      errors.slice()
    );
  }
  config.atmosphereView = 0;
  config.thermalOverlay = true;
  config.thermalOpacity = 0.6;
  for (const mode of [false, true]) {
    config.thermalAir = mode;
    engine.render(camera);
    await device.queue.onSubmittedWorkDone();
  }
  check(
    'Ground and two-layer air temperature overlays render without GPU errors',
    errors.length === 0,
    errors
  );
  device.destroy();
  window.testResults = { passed: true, results };
}
run().catch((error) => {
  window.testResults = { passed: false, error: String(error), results };
});
