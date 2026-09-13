import { config } from '../src/config.ts';
import { WeatherSimulation, WEATHER_TIMESTEP } from '../src/weather.ts';
import { WaterBudget } from '../src/waterBudget.ts';

const results = [];
const check = (name, passed, detail = '') => {
  results.push({ name, passed: !!passed, detail });
  if (!passed) throw Error(`${name}: ${detail}`);
};
async function read(device, buffer) {
  const copy = device.createBuffer({
    size: buffer.size,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, copy, 0, buffer.size);
  device.queue.submit([encoder.finish()]);
  await copy.mapAsync(GPUMapMode.READ);
  const data = new Float32Array(copy.getMappedRange().slice(0));
  copy.unmap();
  copy.destroy();
  return data;
}
const sum = (data, channel, stride = 4) => {
  let total = 0;
  for (let i = channel; i < data.length; i += stride) total += data[i];
  return total;
};
async function run() {
  const adapter = await navigator.gpu.requestAdapter();
  check('WebGPU adapter', adapter);
  const device = await adapter.requestDevice(),
    errors = [];
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const n = 49,
    count = n * n;
  const make = (bytes) =>
    device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
  const terrain = make(count * 24),
    fluid = make(count * 16),
    sim = new WeatherSimulation(device, n);
  await sim.init();
  const neutral = () =>
    Object.assign(config, {
      weatherEnabled: true,
      solarHeating: 0,
      coolingLow: 0,
      coolingMiddle: 0,
      coolingHigh: 0,
      coolingMiddleAltitude: 16,
      rainRate: 0.002,
      evaporationRate: 0,
      heightScale: 18,
      cloudShadows: 0.65,
    });
  neutral();
  const tick = (dt = WEATHER_TIMESTEP) => {
    const encoder = device.createCommandEncoder();
    sim.step(encoder, terrain, fluid, dt);
    device.queue.submit([encoder.finish()]);
  };
  tick(0);
  const t = new Float32Array(count * 6),
    f = new Float32Array(count * 4),
    s = new Float32Array(count * 4);
  const seed = (temperature = 12, water = 0, ice = 0, snow = 0) => {
    neutral();
    t.fill(0);
    f.fill(0);
    s.fill(0);
    for (let i = 0; i < count; i++) {
      t[i * 6] = 0.1;
      f[i * 4] = water;
      s.set([snow, ice, temperature, 0], i * 4);
    }
    upload();
  };
  const upload = () => {
    device.queue.writeBuffer(terrain, 0, t);
    device.queue.writeBuffer(fluid, 0, f);
    device.queue.writeBuffer(sim.surfaceBuffer, 0, s);
  };
  const ticks = async (number) => {
    for (let i = 0; i < number; i++) {
      tick();
      if (i % 100 === 99) await device.queue.onSubmittedWorkDone();
    }
    await device.queue.onSubmittedWorkDone();
  };
  const snap = async () => ({
    s: await read(device, sim.surfaceBuffer),
    f: await read(device, fluid),
  });
  const mass = (state) => sum(state.f, 0) + sum(state.s, 0) + sum(state.s, 1);
  seed();
  await ticks(10);
  check('Clear sky creates no water', mass(await snap()) === 0);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) s[(y * n + x) * 4 + 3] = x < 16 ? 0 : x < 32 ? 0.25 : 1;
  upload();
  await ticks(100);
  let state = await snap();
  const drizzle = state.f[20 * 4],
    rain = state.f[40 * 4];
  check('Rain falls only under painted clouds', state.f[4] === 0 && drizzle > 0);
  check('Intensity controls precipitation proportionally', Math.abs(rain / drizzle - 4) < 0.0001);
  check(
    'Cloud drawing is unchanged by rain and time',
    state.s.every((v, i) => i % 4 !== 3 || v === s[i])
  );
  check(
    'Stationary painting stays spatially stable',
    state.s[3] === 0 && state.s[20 * 4 + 3] === 0.25
  );
  const before = mass(state);
  config.weatherEnabled = false;
  await ticks(4);
  check('Holding weather stops precipitation and thermal evolution', mass(await snap()) === before);
  const heldState = await snap();
  sim.clearClouds();
  tick(0);
  state = await snap();
  check(
    'Clear sky preserves liquid, frozen mass and temperature',
    sum(state.s, 3) === 0 &&
      mass(state) === before &&
      state.s.every((v, i) => i % 4 === 3 || v === heldState.s[i])
  );

  seed(-5);
  for (let i = 3; i < s.length; i += 4) s[i] = 1;
  upload();
  await ticks(10);
  state = await snap();
  check('Cold precipitation accumulates as snow', sum(state.s, 0) > 0 && sum(state.f, 0) === 0);
  seed(0);
  for (let i = 3; i < s.length; i += 4) s[i] = 1;
  upload();
  tick();
  state = await snap();
  check(
    'Freezing transition mixes liquid and snow continuously',
    sum(state.s, 0) > 0 && sum(state.f, 0) > 0
  );

  seed(-10, 0.15);
  const initial = mass(await snap());
  await ticks(10);
  state = await snap();
  check('Freezing grows anchored ice progressively', state.s[1] > 0 && state.f[0] > 0);
  check('Freezing conserves liquid-equivalent water', Math.abs(mass(state) - initial) < 0.00005);
  seed(10, 0, 0.2);
  const frozenBefore = await snap();
  tick();
  state = await snap();
  check(
    'A warm cell melts only part of its ice per tick',
    state.s[1] > 0.19 && state.s[1] < 0.2 && state.f[0] > 0
  );
  check(
    'Melting returns the same mass to liquid',
    Math.abs(mass(state) - mass(frozenBefore)) < 0.00005
  );
  const actualBefore = new Float32Array(state.s);
  config.solarHeating = 4;
  config.coolingHigh = 3;
  config.coolingMiddleAltitude = 4;
  tick(0);
  state = await snap();
  check(
    'Changing climate parameters never replaces temperature or ice',
    state.s.every((v, i) => v === actualBefore[i])
  );

  seed(10);
  for (let i = 0; i < count; i++) t[i * 6] = (((i % n) / 48) * 32) / 18;
  upload();
  Object.assign(config, {
    coolingLow: 0.4,
    coolingMiddle: 0.9,
    coolingHigh: 1.8,
    coolingMiddleAltitude: 8,
  });
  tick();
  state = await snap();
  check(
    'High-altitude cooling is stronger than low-altitude cooling',
    state.s[48 * 4 + 2] < state.s[2]
  );
  const tempAt16 = state.s[24 * 4 + 2];
  seed(10);
  for (let i = 0; i < count; i++) t[i * 6] = (((i % n) / 48) * 32) / 18;
  upload();
  Object.assign(config, {
    coolingLow: 0.4,
    coolingMiddle: 0.9,
    coolingHigh: 1.8,
    coolingMiddleAltitude: 24,
  });
  tick();
  state = await snap();
  check('Moving the middle altitude changes the climate profile', state.s[24 * 4 + 2] > tempAt16);
  const lowTemp = state.s[2];
  seed(10);
  for (let i = 0; i < count; i++) t[i * 6] = (((i % n) / 48) * 32) / 18;
  t[(count - 1) * 6] = 100;
  upload();
  Object.assign(config, {
    coolingLow: 0.4,
    coolingMiddle: 0.9,
    coolingHigh: 1.8,
    coolingMiddleAltitude: 24,
  });
  tick();
  state = await snap();
  check(
    'A new tallest mountain does not rescale distant cooling',
    Math.abs(state.s[2] - lowTemp) < 1e-6
  );

  seed(12);
  config.rainRate = 0;
  config.solarHeating = 1;
  config.sunElevation = 90;
  for (let i = 0; i < count; i++) if (i % n > 24) s[i * 4 + 3] = 1;
  upload();
  tick();
  state = await snap();
  check('Cloud shade reduces local solar heating', state.s[2] > state.s[40 * 4 + 2]);
  const exposed = state.s[2];
  seed(12);
  config.rainRate = 0;
  config.solarHeating = 1;
  config.sunElevation = 90;
  config.cloudOpacity = 0;
  tick();
  state = await snap();
  check(
    'Visual cloud opacity does not alter surface heating',
    Math.abs(state.s[2] - exposed) < 1e-6
  );
  const flux = await read(device, sim.energyFlux);
  check(
    'Energy panel reads applied sunlight and cooling',
    flux[0] > 0 && flux[1] === 0 && flux[2] === flux[0]
  );
  seed(-5, 0, 0, 0.05);
  config.solarHeating = 1;
  config.sunElevation = 90;
  tick();
  state = await snap();
  const snowEnergy = (state.s[2] + 5) * (1.5 + 0.05 * 2);
  seed(-5);
  config.solarHeating = 1;
  config.sunElevation = 90;
  tick();
  state = await snap();
  check('Snow albedo reduces absorbed solar energy', snowEnergy < (state.s[2] + 5) * 1.5);

  seed(10);
  const center = (24 * n + 24) * 4;
  s[center + 2] = 40;
  t[(24 * n + 25) * 6 + 1] = 0.1;
  upload();
  const beforeEnergy = sum(s, 2) * 1.5 - 9;
  tick();
  state = await snap();
  let afterEnergy = 0;
  for (let i = 0; i < count; i++)
    afterEnergy += state.s[i * 4 + 2] * (i === 24 * n + 25 ? 0.6 : 1.5);
  check(
    'Local heat spreads into neighboring cells',
    state.s[center + 6] > 10 && state.s[center + 2] < 40
  );
  check(
    'Diffusion conserves energy across different capacities',
    Math.abs(afterEnergy - beforeEnergy) < 0.005,
    `${beforeEnergy} → ${afterEnergy}`
  );

  seed(-5, 0, 0.2);
  const encoder = device.createCommandEncoder();
  sim.addSurfaceHeat(encoder, terrain, fluid, 0.5, 0.5, 0.15, 1000);
  device.queue.submit([encoder.finish()]);
  state = await snap();
  check(
    'A heat pulse changes temperature without deleting ice',
    state.s[center + 2] > 0 && state.s[center + 1] === s[center + 1]
  );
  await ticks(10);
  state = await snap();
  check(
    'Residual pulse heat melts real ice into flowing water',
    state.s[center + 1] < s[center + 1] && state.f[center] > 0
  );
  check('Pulse footprint leaves distant ice frozen', state.s[1] === s[1]);
  seed(0, 0.01);
  config.solarHeating = 0;
  config.coolingLow = config.coolingMiddle = config.coolingHigh = 3;
  await ticks(250);
  state = await snap();
  check(
    'Sunless climate freezes water at every altitude',
    state.s.every((v, i) => i % 4 !== 1 || v > 0)
  );

  seed(12);
  config.solarHeating = 1;
  config.albedoStrength = 0;
  config.sunElevation = 90;
  for (let i = 0; i < count; i++) if (i % n > 24) t[i * 6 + 1] = 0.1;
  upload();
  tick();
  state = await snap();
  const rockGain = (state.s[2] - 12) * 1.5,
    sandGain = (state.s[40 * 4 + 2] - 12) * 0.6;
  check(
    'Albedo zero gives different materials the same absorbed solar energy',
    Math.abs(rockGain - sandGain) < 0.00001
  );
  const absorption = [];
  for (const strength of [0, 1, 2]) {
    seed(12);
    config.solarHeating = 1;
    config.albedoStrength = strength;
    config.sunElevation = 90;
    tick();
    absorption.push((await read(device, sim.energyFlux))[0]);
  }
  check(
    'Albedo strength scales reflection from zero to twice normal',
    absorption[0] > absorption[1] && absorption[1] > absorption[2] && absorption[2] >= 0
  );
  config.albedoStrength = 1;
  seed(0, 0, 0, 0.04);
  tick(0);
  const summary = await read(device, sim.weatherMap);
  check(
    'Snow geometric depth is 2.5 times liquid-equivalent depth',
    Math.abs(summary[0] - (0.1 + 0.04 * 2.5) * 18) < 0.00001
  );
  seed(12);
  config.cloudAltitude = 40;
  t[(24 * n + 24) * 6] = 8;
  upload();
  tick(0);
  const canopy = await read(device, sim.cloudCanopy),
    middle = 15 * 32 + 15;
  check(
    'Clouds clear very high peaks by at least fourteen scene units',
    canopy[middle] >= 8 * 18 + 14
  );
  check(
    'Cloud base bridges valleys adjacent to the peak',
    canopy[middle + 32] >= 8 * 18 + 14 &&
      canopy[middle + 1] >= 8 * 18 + 14 &&
      canopy[middle + 33] >= 8 * 18 + 14
  );
  let clearance = Infinity;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const gx = ((x + 0.5) / n) * 32 - 0.5,
        gy = ((y + 0.5) / n) * 32 - 0.5,
        bx = Math.floor(gx),
        by = Math.floor(gy),
        fx = gx - bx,
        fy = gy - by;
      let base = 0;
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++)
          base +=
            canopy[Math.max(0, Math.min(31, by + dy)) * 32 + Math.max(0, Math.min(31, bx + dx))] *
            (dx ? fx : 1 - fx) *
            (dy ? fy : 1 - fy);
      clearance = Math.min(clearance, base - t[(y * n + x) * 6] * 18);
    }
  check(
    'Interpolated cloud base clears every terrain cell',
    clearance >= 14 - 0.00001,
    String(clearance)
  );
  check(
    'Volume bounds include clouds above exceptionally tall mountains',
    canopy[1024] >= 8 * 18 + 14
  );

  // Inventory includes external rain/evaporation, never cloud density or cosmetic steam.
  seed(25, 0.1);
  for (let i = 3; i < s.length; i += 4) s[i] = 1;
  upload();
  config.evaporationRate = 0.5;
  const oldExchange = await read(device, sim.waterExchange);
  const oldMass = mass(await snap());
  await ticks(20);
  state = await snap();
  const exchange = await read(device, sim.waterExchange);
  const unit = (40000 / n / n) * config.heightScale;
  check(
    'Rain and evaporation account for the change in water inventory',
    Math.abs(
      (mass(state) - oldMass) * unit - (exchange[0] - oldExchange[0] - exchange[1] + oldExchange[1])
    ) < 0.1
  );
  const budget = new WaterBudget(device, n);
  await budget.init();
  budget.sample(fluid, sim.surfaceBuffer, sim.waterExchange);
  for (let i = 0; i < 100 && !budget.latest; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  check(
    'GPU water inventory excludes painted clouds',
    Math.abs(budget.latest.total - mass(state) * unit) < 0.02
  );
  budget.destroy();
  await device.queue.onSubmittedWorkDone();
  check('No GPU validation errors', errors.length === 0, errors.join('\n'));
  sim.destroy();
  terrain.destroy();
  fluid.destroy();
  device.destroy();
  window.testResults = { passed: true, results };
}
run()
  .catch((error) => {
    window.testResults = { passed: false, error: String(error), results };
  })
  .finally(() => {
    document.getElementById('results').textContent = JSON.stringify(window.testResults, null, 2);
  });
