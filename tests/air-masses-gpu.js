import { config } from '../src/config.ts';
import { AtmosphereSimulation } from '../src/atmosphere.ts';

const results = [];
const check = (name, condition, detail = '') => {
  results.push({ name, passed: !!condition, detail });
  document.querySelector('#results').textContent = JSON.stringify(results, null, 2);
  if (!condition) throw new Error(`${name}: ${detail}`);
};
async function read(device, source) {
  const staging = device.createBuffer({
    size: source.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(source, 0, staging, 0, source.size);
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
  const n = 96;
  const make = (size) =>
    device.createBuffer({
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
  const terrain = make(n * n * 16),
    fluids = make(n * n * 16);
  const ground = new Float32Array(n * n * 4),
    liquid = new Float32Array(ground.length);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      ground[i] = 0.05;
      if (x >= 16 && x < 48) liquid[i] = 0.5;
    }
  Object.assign(config, {
    atmosphereEnabled: true,
    closedWaterCycle: true,
    emergentWeather: true,
    atmosphereBoundary: 0,
    airTemperature: 8,
    relativeHumidity: 0.7,
    windSpeed: 0,
    solarHeating: 1,
    sunElevation: 40,
    radiativeCooling: 1,
    evaporationRate: 0.25,
    heightScale: 18,
  });
  device.queue.writeBuffer(terrain, 0, ground);
  device.queue.writeBuffer(fluids, 0, liquid);
  const sim = new AtmosphereSimulation(device, n);
  await sim.init();
  const step = (dt) => {
    const encoder = device.createCommandEncoder();
    sim.step(encoder, terrain, fluids, dt);
    device.queue.submit([encoder.finish()]);
  };
  const tick = async (count) => {
    for (let i = 0; i < count; i++) {
      step(0.1);
      if (i % 50 === 49) await device.queue.onSubmittedWorkDone();
    }
    await device.queue.onSubmittedWorkDone();
  };
  const snapshot = async () => {
    const air = await read(device, sim.volumeBuffer),
      surface = await read(device, sim.surfaceBuffer),
      fluid = await read(device, fluids);
    const unprojected = await read(device, sim.divergenceBuffer);
    let preProjectionDivergence = 0;
    for (const value of unprojected)
      preProjectionDivergence += (value * value) / unprojected.length;
    let total = 0,
      cloud = 0,
      cloudOverLand = 0,
      elevatedVapor = 0,
      vaporOverLand = 0,
      upward = 0,
      horizontal = 0,
      rain = 0,
      temperature = 0,
      meanVertical = 0,
      divergence = 0,
      cloudX = 0;
    const airFactor = 4000000 / (48 * 48 * 32),
      fineFactor = (40000 * 18) / (n * n);
    for (let i = 0; i < surface.length; i += 4)
      total +=
        (surface[i] + surface[i + 1] + surface[i + 3] + fluid[i] + fluid[i + 3]) * fineFactor;
    for (let z = 0; z < 32; z++)
      for (let y = 0; y < 48; y++)
        for (let x = 0; x < 48; x++) {
          const i = ((z * 48 + y) * 48 + x) * 8;
          total += (air[i + 4] + air[i + 5] + air[i + 6] + air[i + 7]) * airFactor;
          temperature += air[i + 3] / (48 * 48 * 32);
          meanVertical += air[i + 2] / (48 * 48 * 32);
          const left = ((z * 48 + y) * 48 + ((x + 47) % 48)) * 8;
          const bottom = ((z * 48 + ((y + 47) % 48)) * 48 + x) * 8;
          const below = z > 0 ? air[i - 48 * 48 * 8 + 2] : 0;
          const div =
            (air[i] - air[left]) / (200 / 48) +
            (air[i + 1] - air[bottom + 1]) / (200 / 48) +
            (air[i + 2] - below) / (100 / 32);
          divergence += (div * div) / (48 * 48 * 32);
          cloud += air[i + 5] * airFactor;
          cloudX += (x + 0.5) * (200 / 48) * air[i + 5] * airFactor;
          rain += (air[i + 6] + air[i + 7]) * airFactor;
          // At least four atmospheric cells beyond the lake shoreline.
          if (x < 4 || x >= 28) {
            vaporOverLand += air[i + 4] * airFactor;
            cloudOverLand += air[i + 5] * airFactor;
          }
          if (z >= 10) elevatedVapor += air[i + 4] * airFactor;
          upward = Math.max(upward, air[i + 2]);
          horizontal = Math.max(horizontal, Math.hypot(air[i], air[i + 1]));
        }
    return {
      total,
      cloud,
      cloudOverLand,
      elevatedVapor,
      vaporOverLand,
      upward,
      horizontal,
      rain,
      temperature,
      meanVertical,
      divergence: Math.sqrt(divergence),
      preProjectionDivergence: Math.sqrt(preProjectionDivergence),
      cloudX: cloudX / Math.max(cloud, 1e-30),
      finite: air.every((value, i) => Number.isFinite(value) && (i % 8 < 4 || value >= 0)),
    };
  };
  step(0);
  const initial = await snapshot();
  const history = [];
  for (let batch = 0; batch < 35; batch++) {
    await tick(100);
    history.push({ time: sim.simulationTime, ...(await snapshot()) });
    document.querySelector('#results').textContent = JSON.stringify(history, null, 2);
    window.airMassProgress = history;
  }
  const peak = (key) => Math.max(...history.map((s) => s[key]));
  check(
    'Solar heating creates vigorous rising air from rest',
    peak('upward') > 0.3,
    JSON.stringify(history)
  );
  check(
    'Pressure creates horizontal lake-land circulation without imposed wind',
    peak('horizontal') > 0.3
  );
  check(
    'Evaporation and convection moisten the upper atmosphere',
    peak('elevatedVapor') > initial.elevatedVapor + 100
  );
  check(
    'Lake moisture travels beyond its shoreline',
    peak('vaporOverLand') > initial.vaporOverLand + 100
  );
  check('Evaporated water forms clouds over land', peak('cloudOverLand') > 5);
  check(
    'Clouds still occupy distant land after several minutes of free evolution',
    history.slice(-5).every((s) => s.cloudOverLand > 5)
  );
  check(
    'Default solar energy does not overheat the atmosphere',
    history.every((s) => s.temperature < initial.temperature + 10),
    `initial ${initial.temperature}, final ${history.at(-1).temperature}`
  );
  check(
    'Pressure removes most velocity divergence',
    history.every((s) => s.divergence < Math.max(s.preProjectionDivergence * 0.3, 1e-7)),
    JSON.stringify(history.map((s) => ({ before: s.preProjectionDivergence, after: s.divergence })))
  );
  check(
    'Convection conserves the complete water inventory',
    history.every((s) => Math.abs(s.total - initial.total) / initial.total < 0.0002),
    JSON.stringify(history)
  );
  check(
    'All air mass states remain finite',
    history.every((s) => s.finite)
  );

  // Isolate a saturated travelling cloud: microphysics must not drain it into
  // rain in the previous 2.5-second autoconversion timescale.
  Object.assign(config, { solarHeating: 0, radiativeCooling: 0, evaporationRate: 0 });
  liquid.fill(0);
  ground.fill(0);
  device.queue.writeBuffer(fluids, 0, liquid);
  device.queue.writeBuffer(terrain, 0, ground);
  const air = new Float32Array(48 * 48 * 32 * 8);
  for (let z = 0; z < 32; z++)
    for (let y = 0; y < 48; y++)
      for (let x = 0; x < 48; x++) {
        const i = ((z * 48 + y) * 48 + x) * 8;
        air[i] = 6;
        air[i + 3] = 8;
        air[i + 4] = 0.008 * Math.exp(0.065 * 8);
        if (x >= 8 && x < 20 && y >= 12 && y < 36 && z >= 8 && z < 20) air[i + 5] = 0.006;
      }
  device.queue.writeBuffer(sim.volumeBuffer, 0, air);
  const surface = new Float32Array(n * n * 4);
  for (let i = 2; i < surface.length; i += 4) surface[i] = 8;
  device.queue.writeBuffer(sim.surfaceBuffer, 0, surface);
  const cloudInitial = await snapshot();
  await tick(150);
  const cloudLater = await snapshot();
  check(
    'Transported cloud retains most condensate for fifteen seconds',
    cloudLater.cloud > cloudInitial.cloud * 0.5,
    JSON.stringify({ before: cloudInitial, after: cloudLater })
  );
  check(
    'A coherent cloud travels far from its starting footprint',
    cloudLater.cloudX - cloudInitial.cloudX > 20,
    `cloud displacement ${cloudLater.cloudX - cloudInitial.cloudX}`
  );
  check(
    'Cloud life cycle conserves water',
    Math.abs(cloudLater.total - cloudInitial.total) / cloudInitial.total < 0.0002
  );

  // Uniform dry air, transported horizontally without solar, radiative,
  // latent or initial surface heat, must not heat itself numerically.
  for (let i = 0; i < air.length; i += 8) {
    air[i] = 6;
    air[i + 1] = 0;
    air[i + 2] = 0;
    air[i + 3] = 8;
    air.fill(0, i + 4, i + 8);
  }
  device.queue.writeBuffer(sim.volumeBuffer, 0, air);
  device.queue.writeBuffer(sim.surfaceBuffer, 0, surface);
  device.queue.writeBuffer(fluids, 0, liquid);
  await tick(500);
  const dryTransport = await snapshot();
  check(
    'Advection without an energy source does not heat dry air',
    Math.abs(dryTransport.temperature - 8) < 0.05,
    `mean temperature ${dryTransport.temperature}`
  );
  check('No air mass GPU validation errors', errors.length === 0, errors.join('\n'));
  sim.destroy();
  terrain.destroy();
  fluids.destroy();
  device.destroy();
  window.testResults = { passed: true, results, history };
}
run().catch((error) => {
  console.error(error);
  window.testResults = {
    passed: false,
    results,
    error: String(error),
    history: window.airMassProgress,
  };
  document.querySelector('#results').textContent = JSON.stringify(window.testResults, null, 2);
});
