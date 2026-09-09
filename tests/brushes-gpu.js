import { config } from '../src/config.ts';
import { ATMOSPHERE_DIMENSIONS } from '../src/atmosphere.ts';
import { GPGPUSimulation } from '../src/webgpuRenderer.ts';
import * as THREE from 'three';

const results = [];
const [atmoX, atmoY, atmoZ] = ATMOSPHERE_DIMENSIONS;
function check(name, condition) {
  results.push({ name, passed: !!condition });
  document.querySelector('#results').textContent = JSON.stringify(results, null, 2);
  if (!condition) throw new Error(name);
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
  const values = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return values;
}
async function run() {
  Object.assign(config, {
    paused: false,
    atmosphereEnabled: true,
    closedWaterCycle: true,
    emergentWeather: true,
    airTemperature: 0,
    relativeHumidity: 0,
    windSpeed: 0,
    solarHeating: 0,
    radiativeCooling: 0,
    evaporationRate: 0,
    evaporation: 0,
    terrainType: 1,
    flatRockHeight: 0,
    terrainSandHeight: 0,
    terrainSoilHeight: 0,
    erosionRate: 0,
  });
  const n = 96,
    center = (48 * n + 48) * 4,
    edge = (48 * n + 60) * 4;
  const e = new GPGPUSimulation(document.querySelector('canvas'), n);
  check('Full engine initializes', await e.initWebGPU());
  const errors = [];
  e.device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  e.step();
  e.stepAtmosphere(0);
  config.paused = true;
  const fluid = new Float32Array(n * n * 4),
    surface = new Float32Array(fluid.length);
  const current = () => (e.pingPongToggle ? e.fluidsBufferB : e.fluidsBufferA);
  const seed = (water = 0.2, ice = 0.05, temperature = 0, snow = 0) => {
    fluid.fill(0);
    surface.fill(0);
    for (let i = 0; i < fluid.length; i += 4) {
      fluid[i] = water;
      surface[i] = snow;
      surface[i + 1] = ice;
      surface[i + 2] = temperature;
    }
    for (const b of [e.fluidsBufferA, e.fluidsBufferB]) e.device.queue.writeBuffer(b, 0, fluid);
    e.device.queue.writeBuffer(e.atmosphere.surfaceBuffer, 0, surface);
  };
  const paint = (type, count = 1, strength = 1) => {
    e.setBrush(true, new THREE.Vector2(0.5, 0.5), type, 16, strength);
    for (let i = 0; i < count; i++) e.step();
    e.setBrush(false, null, type, 16, strength);
  };
  let resets = 0;
  const reset = e.waterBudget.resetBaseline.bind(e.waterBudget);
  e.waterBudget.resetBaseline = () => {
    resets++;
    reset();
  };
  seed();
  paint(6);
  let s = await read(e.device, e.atmosphere.surfaceBuffer),
    f = await read(e.device, current());
  check(
    'Ice brush adds solid mass without consuming the liquid',
    s[center + 1] > 0.05 && f[center] === fluid[center]
  );
  check(
    'Ice addition uses a smooth local footprint',
    s[center + 1] > s[edge + 1] && s[edge + 1] > surface[edge + 1] && s[1] === surface[1]
  );
  check('Adding ice restarts the water inventory baseline', resets === 1);
  seed(0.1, 0.05, 0, 0.02);
  paint(5);
  s = await read(e.device, e.atmosphere.surfaceBuffer);
  f = await read(e.device, current());
  check(
    'Erase removes ice, snow and liquid without negative amounts',
    s[center] === 0 &&
      s[center + 1] === 0 &&
      f[center] === 0 &&
      s.every((v, i) => i % 4 === 2 || v >= 0)
  );
  check('Erase leaves ice outside the brush untouched', s[1] === surface[1]);
  seed();
  const baselineResets = resets;
  paint(7, 20);
  const hot = await read(e.device, e.atmosphere.surfaceBuffer);
  f = await read(e.device, current());
  check(
    'Heat changes local temperature without directly changing water or ice',
    hot[center + 2] > 0 &&
      hot[2] === 0 &&
      hot.every((v, i) => i % 4 === 2 || v === surface[i]) &&
      f.every((v, i) => v === fluid[i])
  );
  check('Thermal painting preserves the existing inventory baseline', resets === baselineResets);
  seed();
  paint(8, 20);
  const cold = await read(e.device, e.atmosphere.surfaceBuffer);
  check(
    'Cool removes heat using the same strength and footprint',
    cold[center + 2] < 0 && Math.abs(cold[center + 2] + hot[center + 2]) < 1e-5 && cold[2] === 0
  );
  seed(0, 0);
  paint(7, 20);
  const dry = await read(e.device, e.atmosphere.surfaceBuffer);
  check('Deep water heats more slowly than dry ground', dry[center + 2] > hot[center + 2] * 2);
  const air = new Float32Array(atmoX * atmoY * atmoZ * 8);
  const phase = async (type) => {
    seed();
    paint(type, 20);
    e.device.queue.writeBuffer(e.atmosphere.volumeBuffer, 0, air);
    for (let i = 0; i < 10; i++) e.stepAtmosphere(1 / 30);
    return {
      s: await read(e.device, e.atmosphere.surfaceBuffer),
      f: await read(e.device, current()),
    };
  };
  const melted = await phase(7),
    frozen = await phase(8);
  check(
    'Heat causes progressive ice melting into actual liquid',
    melted.s[center + 1] < surface[center + 1] && melted.f[center] > fluid[center]
  );
  check(
    'Cool causes progressive freezing of available liquid',
    frozen.s[center + 1] > surface[center + 1] && frozen.f[center] < fluid[center]
  );
  check(
    'Thermal phase changes conserve water in every painted column',
    [melted, frozen].every((state) =>
      state.s.every(
        (v, i) => i % 4 !== 1 || Math.abs(v + state.f[i - 1] - surface[i] - fluid[i - 1]) < 1e-6
      )
    )
  );
  check('No WebGPU validation errors', errors.length === 0);
  window.testResults = { passed: true, results };
}
run().catch((error) => {
  console.error(error);
  window.testResults = { passed: false, error: String(error), results };
});
