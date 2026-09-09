import { config } from '../src/config.ts';
import { AtmosphereSimulation, ATMOSPHERE_DIMENSIONS } from '../src/atmosphere.ts';

const results = [];
const [atmoX, atmoY, atmoZ] = ATMOSPHERE_DIMENSIONS;
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
async function run() {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  // Unequal fine/coarse areas exercise the paired heat budget.
  const n = 97;
  const make = (bytes = n * n * 16) =>
    device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
  const terrain = make(n * n * 24),
    fluids = make();
  const ground = new Float32Array(n * n * 4),
    liquid = new Float32Array(ground.length);
  Object.assign(config, {
    atmosphereEnabled: true,
    closedWaterCycle: true,
    emergentWeather: true,
    atmosphereBoundary: 0,
    airTemperature: 8,
    relativeHumidity: 0.7,
    airStability: 0.125,
    convectionStrength: 4,
    windSpeed: 0,
    solarHeating: 0,
    radiativeCooling: 0,
    evaporationRate: 0,
    heightScale: 18,
  });
  const sim = new AtmosphereSimulation(device, n);
  await sim.init();
  const step = (dt) => {
    const encoder = device.createCommandEncoder();
    sim.step(encoder, terrain, fluids, dt);
    device.queue.submit([encoder.finish()]);
  };
  const tick = async (count) => {
    for (let i = 0; i < count; i++) step(1 / 30);
    await device.queue.onSubmittedWorkDone();
  };
  step(0);
  const initial = await read(device, sim.volumeBuffer);
  let uniform = true;
  for (let z = 0; z < atmoZ; z++) {
    const base = z * atmoX * atmoY * 8;
    for (let i = base; i < base + atmoX * atmoY * 8; i += 8)
      uniform &&=
        initial[i] === 0 &&
        initial[i + 1] === 0 &&
        initial[i + 2] === 0 &&
        initial[i + 3] === initial[base + 3] &&
        initial[i + 4] === initial[base + 4];
  }
  check('Initial air is horizontally uniform and exactly at rest', uniform);
  const theta = (z) => initial[z * atmoX * atmoY * 8 + 3] + (0.16 * (z + 0.5) * 100) / atmoZ;
  const lowerGradient = (theta(16) - theta(4)) / ((12 * 100) / atmoZ);
  const upperGradient = (theta(60) - theta(48)) / ((12 * 100) / atmoZ);
  check(
    'Lower air is nearly neutral with a stable upper cap',
    lowerGradient >= 0 && lowerGradient < 0.01 && upperGradient > 0.1,
    JSON.stringify({ lowerGradient, upperGradient })
  );
  await tick(60);
  const quiet = await read(device, sim.volumeBuffer);
  const maxSpeed = (values) => {
    let maximum = 0;
    for (let i = 0; i < values.length; i += 8)
      maximum = Math.max(maximum, Math.hypot(values[i], values[i + 1], values[i + 2]));
    return maximum;
  };
  check(
    'An unheated symmetric world does not invent wind',
    maxSpeed(quiet) < 0.0001,
    String(maxSpeed(quiet))
  );

  const air = new Float32Array(initial.length),
    surface = new Float32Array(ground.length);
  for (let i = 0; i < air.length; i += 8) air[i + 3] = 8;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      liquid[i] = 0.1 + (x % 7) * 0.03;
      surface[i + 2] = x < n / 2 ? 16 : 4;
    }
  config.convectionStrength = 0;
  device.queue.writeBuffer(fluids, 0, liquid);
  device.queue.writeBuffer(sim.volumeBuffer, 0, air);
  device.queue.writeBuffer(sim.surfaceBuffer, 0, surface);
  const surfaceEnergy = (data) => {
    let energy = 0;
    for (let i = 0; i < data.length; i += 4)
      energy += (1.5 + liquid[i] * 8 + data[i] * 2 + data[i + 1] * 5) * data[i + 2];
    return energy;
  };
  const airEnergy = (data) => {
    let energy = 0;
    for (let i = 3; i < data.length; i += 8)
      energy += (data[i] * (100 / atmoZ / config.heightScale) * n * n) / (atmoX * atmoY);
    return energy;
  };
  // No velocity, radiation or phase change: the only energy transfer is sensible heat.
  step(0.1);
  const heatedAir = await read(device, sim.volumeBuffer),
    cooledSurface = await read(device, sim.surfaceBuffer);
  const airGain = airEnergy(heatedAir) - airEnergy(air),
    surfaceLoss = surfaceEnergy(surface) - surfaceEnergy(cooledSurface);
  check(
    'Sensible heat removed from the surface is credited to air on unequal grids',
    airGain > 1 && Math.abs(airGain - surfaceLoss) < 0.03,
    JSON.stringify({ airGain, surfaceLoss, error: airGain - surfaceLoss })
  );
  check(
    'A fast heat exchange keeps temperatures between donor and receiver',
    heatedAir.every((v, i) => i % 8 !== 3 || (v >= 4 && v <= 16)) &&
      cooledSurface.every((v, i) => i % 4 !== 2 || (v >= 4 && v <= 16))
  );

  // Identical localized surface heating, with no initial atmospheric disturbance.
  liquid.fill(0);
  device.queue.writeBuffer(fluids, 0, liquid);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      surface[(y * n + x) * 4 + 2] = x >= 32 && x < 64 && y >= 32 && y < 64 ? 14 : 8;
  const response = async (strength) => {
    config.convectionStrength = strength;
    device.queue.writeBuffer(sim.volumeBuffer, 0, air);
    device.queue.writeBuffer(sim.surfaceBuffer, 0, surface);
    await tick(90);
    const evolved = await read(device, sim.volumeBuffer);
    let upward = 0,
      horizontal = 0;
    for (let i = 0; i < evolved.length; i += 8) {
      upward = Math.max(upward, evolved[i + 2]);
      horizontal = Math.max(horizontal, Math.hypot(evolved[i], evolved[i + 1]));
    }
    check(
      `Response ${strength} remains finite and creates no water`,
      evolved.every((v, i) => Number.isFinite(v) && (i % 8 < 4 || v === 0))
    );
    return { upward, horizontal };
  };
  const gentle = await response(1),
    reactive = await response(4);
  check(
    'Stronger convection reacts faster to the same surface heat',
    reactive.upward > gentle.upward * 1.5 && reactive.upward > 0.2,
    JSON.stringify({ gentle, reactive })
  );
  check(
    'Surface heating produces horizontal circulation without imposed wind',
    reactive.horizontal > 0.1,
    JSON.stringify(reactive)
  );
  const strong = await response(8);
  check(
    'Maximum response stays bounded',
    strong.upward < 40 && strong.horizontal < 40,
    JSON.stringify(strong)
  );
  check('No convection GPU validation errors', errors.length === 0, errors.join('\n'));
  sim.destroy();
  terrain.destroy();
  fluids.destroy();
  device.destroy();
  window.testResults = { passed: true, results };
}
run().catch((error) => {
  console.error(error);
  window.testResults = { passed: false, error: String(error), results };
  document.querySelector('#results').textContent = JSON.stringify(window.testResults, null, 2);
});
