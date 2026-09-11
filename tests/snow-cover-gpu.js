import { config } from '../src/config.ts';
import { GPGPUSimulation } from '../src/webgpuRenderer.ts';
import { ATMOSPHERE_DIMENSIONS } from '../src/atmosphere.ts';
import { terrainFixture } from './terrain-fixture.js';
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
  const data = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return data;
}
const capacity = (water, snow, ice) => 1.5 + water * 8 + snow * 2 + ice * 5;
// Total enthalpy relative to liquid at 0 C, including the latent solid inventory.
const enthalpy = (water, snow, ice, temperature) =>
  capacity(water, snow, ice) * temperature - 80 * (snow + ice);

async function run() {
  Object.assign(config, {
    atmosphereEnabled: false,
    closedWaterCycle: true,
    atmosphereBoundary: 1,
    borderBehavior: 0,
    airTemperature: -5,
    relativeHumidity: 0,
    windSpeed: 0,
    solarHeating: 0,
    radiativeCooling: 0,
    evaporationRate: 0,
    evaporation: 0,
    rainActive: false,
    erosionRate: 0,
    terrainType: 1,
    flatRockHeight: 0.1,
    terrainSandHeight: 0,
    terrainSoilHeight: 0,
    heightScale: 18,
    paused: false,
    smoothRendering: true,
    renderResolution: 1,
    cloudOpacity: 0,
    showWind: false,
  });
  const n = 257;
  const engine = new GPGPUSimulation(document.querySelector('canvas'), n);
  check('WebGPU engine initializes', await engine.initWebGPU());
  const { device, atmosphere: sim } = engine;
  const errors = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  window.addEventListener('simulation-error', (event) => errors.push(event.detail));
  engine.step();
  engine.stepAtmosphere(0);
  const terrain = new Float32Array(n * n * 4);
  const liquid = new Float32Array(terrain.length);
  const surface = new Float32Array(terrain.length);
  const [nx, ny] = ATMOSPHERE_DIMENSIONS;
  const currentFluid = () => (engine.pingPongToggle ? engine.fluidsBufferB : engine.fluidsBufferA);
  const currentTerrain = () =>
    engine.pingPongToggle ? engine.terrainBufferB : engine.terrainBufferA;
  const seed = (water, snow, temperature) => {
    liquid.fill(0);
    surface.fill(0);
    for (let i = 0; i < surface.length; i += 4) {
      terrain[i] = 0.1;
      liquid[i] = water;
      surface[i] = snow;
      surface[i + 2] = temperature;
    }
    for (const buffer of [engine.terrainBufferA, engine.terrainBufferB])
      device.queue.writeBuffer(buffer, 0, terrainFixture(terrain));
    for (const buffer of [engine.fluidsBufferA, engine.fluidsBufferB])
      device.queue.writeBuffer(buffer, 0, liquid);
    device.queue.writeBuffer(sim.surfaceBuffer, 0, surface);
    device.queue.writeBuffer(sim.precipitation, 0, new Float32Array(nx * ny * 2));
  };
  // Isolate production surface exchange from weather transport and external heat.
  const exchange = () => {
    device.queue.writeBuffer(sim.uniforms, 28, new Float32Array([1 / 30]));
    const groups = sim.bindings(currentTerrain(), currentFluid());
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(sim.pipelines.surfaceExchange);
    pass.setBindGroup(0, groups.surfaceExchange[0]);
    pass.dispatchWorkgroups(Math.ceil(n / 16), Math.ceil(n / 16));
    pass.end();
    device.queue.submit([encoder.finish()]);
  };
  const snapshot = async () => ({
    snow: await read(device, sim.surfaceBuffer),
    water: await read(device, currentFluid()),
  });

  // A tiny rain/condensate footprint used to erase the entire snow layer in
  // rectangular patches aligned with the coarse atmospheric columns.
  seed(0, 0.025, -5);
  const rain = new Float32Array(nx * ny * 2);
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) if ((x + y) % 4 === 0) rain[(y * nx + x) * 2] = 1e-7;
  device.queue.writeBuffer(sim.precipitation, 0, rain);
  exchange();
  const dusted = await snapshot();
  let minSnow = Infinity;
  for (let i = 0; i < dusted.snow.length; i += 4) minSnow = Math.min(minSnow, dusted.snow[i]);
  check(
    'Trace rain leaves a continuous snow cover across atmosphere tiles',
    minSnow > 0.02499,
    `minimum snow=${minSnow}, initial=0.025`
  );

  for (const pass of ['fluid', 'weather']) {
    for (const [water, temperature] of [
      [1e-8, -5],
      [1e-6, -5],
      [1e-6, 0.0001],
      [0.02, -5],
      [0.02, 5],
      [0.2, -5],
      [0.2, 5],
    ]) {
      const snow = 0.025;
      seed(water, snow, temperature);
      if (pass === 'fluid') engine.step();
      else exchange();
      const after = await snapshot();
      const w = after.water[0],
        s = after.snow[0],
        ice = after.snow[1],
        t = after.snow[2];
      check(
        `${pass}: wet snow conserves water (${water}, ${temperature} C)`,
        Math.abs(w + s + ice - water - snow) < 1e-7
      );
      check(
        `${pass}: wet snow conserves sensible and latent energy (${water}, ${temperature} C)`,
        Math.abs(enthalpy(w, s, ice, t) - enthalpy(water, snow, 0, temperature)) < 0.00002
      );
      if (water < 1e-5) {
        check(
          `${pass}: traces of water do not collapse the snowpack (${water}, ${temperature} C)`,
          s > snow * 0.999,
          `remaining snow=${s}`
        );
      } else if (water < snow * 5) {
        check(
          `${pass}: partial flooding retains the unsubmerged snow (${temperature} C)`,
          s > 0.02
        );
      } else {
        check(`${pass}: flooded snow joins the water or anchored ice (${temperature} C)`, s === 0);
        if (temperature < 0) check(`${pass}: cold flooded snow stays frozen`, ice >= snow);
      }
    }
  }

  // Tiny meltwater produced on the first weather tick must not erase the
  // remaining snow on the next fluid or weather tick.
  seed(0, 0.025, 0.001);
  for (let i = 0; i < 10; i++) {
    exchange();
    engine.step();
  }
  const thaw = await snapshot();
  check(
    'Incipient thaw stays gradual over coupled fluid/weather ticks',
    thaw.snow[0] > 0.0249,
    `remaining snow=${thaw.snow[0]}`
  );

  // Keep a deterministic oblique snow scene for visual inspection.
  seed(0, 0.025, -5);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const px = (x / n - 0.5) * 5,
        py = (y / n - 0.5) * 5;
      terrain[(y * n + x) * 4] =
        0.1 + 1.5 * Math.exp(-px * px - py * py) + 0.1 * Math.sin(px * 5) * Math.cos(py * 4);
    }
  for (const buffer of [engine.terrainBufferA, engine.terrainBufferB])
    device.queue.writeBuffer(buffer, 0, terrainFixture(terrain));
  device.queue.writeBuffer(sim.precipitation, 0, rain);
  exchange();
  const camera = new THREE.PerspectiveCamera(45, 960 / 640, 0.1, 1000);
  camera.position.set(80, 100, 135);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  engine.render(camera);
  await device.queue.onSubmittedWorkDone();
  check(
    'Snow rendering and simulation have no GPU validation errors',
    errors.length === 0,
    errors.join('\n')
  );
  window.testResults = { passed: true, results };
}
run().catch((error) => {
  window.testResults = { passed: false, error: String(error), results };
  document.querySelector('#results').textContent = JSON.stringify(window.testResults, null, 2);
});
