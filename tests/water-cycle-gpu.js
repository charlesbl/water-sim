import { config } from '../src/config.ts';
import { AtmosphereSimulation } from '../src/atmosphere.ts';
import { GPGPUSimulation } from '../src/webgpuRenderer.ts';
import { WaterBudget } from '../src/waterBudget.ts';

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, passed: !!condition, detail });
  document.querySelector('#results').textContent = JSON.stringify(results, null, 2);
  if (!condition) throw new Error(`${name}: ${detail}`);
}
const nextFrame = () => new Promise(requestAnimationFrame);
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
function inventory(air, surface, fluid, n) {
  const factor = (40000 * config.heightScale) / (n * n),
    airFactor = (40000 * 100) / (48 * 48 * 32);
  const sums = {
    liquid: 0,
    snow: 0,
    ice: 0,
    pending: 0,
    steam: 0,
    vapor: 0,
    cloud: 0,
    rain: 0,
    airSnow: 0,
  };
  for (let i = 0; i < surface.length; i += 4) {
    sums.liquid += fluid[i] * factor;
    sums.steam += fluid[i + 3] * factor;
    sums.snow += surface[i] * factor;
    sums.ice += surface[i + 1] * factor;
    sums.pending += surface[i + 3] * factor;
  }
  for (let i = 0; i < air.length; i += 8) {
    sums.vapor += air[i + 4] * airFactor;
    sums.cloud += air[i + 5] * airFactor;
    sums.rain += air[i + 6] * airFactor;
    sums.airSnow += air[i + 7] * airFactor;
  }
  return { ...sums, total: Object.values(sums).reduce((a, b) => a + b, 0) };
}
async function run() {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const n = 97;
  const make = (size) =>
    device.createBuffer({
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
  const terrain = make(n * n * 16),
    fluid = make(n * n * 16);
  const state = new Float32Array(n * n * 4),
    ground = new Float32Array(state.length);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      ground[i] = 0.05 + 0.12 * Math.sin((x / n) * Math.PI * 2) ** 2;
      state[i] = 0.12 + 0.12 * Math.cos((y / n) * Math.PI * 2) ** 2;
    }
  device.queue.writeBuffer(terrain, 0, ground);
  device.queue.writeBuffer(fluid, 0, state);
  Object.assign(config, {
    closedWaterCycle: true,
    atmosphereEnabled: true,
    emergentWeather: true,
    airTemperature: 8,
    relativeHumidity: 0,
    windSpeed: 12,
    windDirection: 35,
    solarHeating: 3,
    radiativeCooling: 0.3,
    evaporationRate: 1,
    atmosphereBoundary: 0,
    heightScale: 18,
  });
  const sim = new AtmosphereSimulation(device, n);
  await sim.init();
  const step = (dt = 0.1) => {
    const encoder = device.createCommandEncoder();
    sim.step(encoder, terrain, fluid, dt);
    device.queue.submit([encoder.finish()]);
  };
  const tick = async (count) => {
    for (let i = 0; i < count; i++) {
      step();
      if (i % 100 === 99) await device.queue.onSubmittedWorkDone();
    }
    await device.queue.onSubmittedWorkDone();
  };
  step(0);
  const hotSurface = await read(device, sim.surfaceBuffer);
  for (let i = 0; i < hotSurface.length; i += 4) hotSurface[i + 2] = 30;
  device.queue.writeBuffer(sim.surfaceBuffer, 0, hotSurface);
  const snapshot = async () =>
    inventory(
      await read(device, sim.volumeBuffer),
      await read(device, sim.surfaceBuffer),
      await read(device, fluid),
      n
    );
  const initial = await snapshot();
  await tick(20);
  const evaporated = await snapshot();
  check(
    'Liquid evaporates into the initially dry atmosphere',
    evaporated.vapor > 1 && evaporated.liquid < initial.liquid,
    JSON.stringify(evaporated)
  );
  let peakCloud = 0,
    peakPrecip = 0,
    maxDrift = 0,
    final;
  for (let batch = 0; batch < 20; batch++) {
    await tick(100);
    final = await snapshot();
    peakCloud = Math.max(peakCloud, final.cloud);
    peakPrecip = Math.max(peakPrecip, final.rain + final.airSnow);
    maxDrift = Math.max(maxDrift, Math.abs(final.total - initial.total) / initial.total);
    document.querySelector('#results').textContent =
      `Closed cycle ${20 + (batch + 1) * 100} steps, drift ${(maxDrift * 100).toFixed(6)}%`;
  }
  check('Evaporated water condenses into clouds', peakCloud > 1, `peak cloud ${peakCloud}`);
  check(
    'Cloud water becomes precipitation without a humidity source',
    peakPrecip > 0.01,
    `peak precipitation ${peakPrecip}`
  );
  check(
    'Periodic atmosphere conserves total water over 2020 steps',
    maxDrift < 0.0002,
    `relative drift ${maxDrift}, inventory ${JSON.stringify(final)}`
  );
  config.atmosphereBoundary = 1;
  const beforeWalls = await snapshot();
  await tick(500);
  const afterWalls = await snapshot();
  check(
    'Closed walls conserve water including the boundary switch',
    Math.abs(afterWalls.total - beforeWalls.total) / beforeWalls.total < 0.0001,
    JSON.stringify(afterWalls)
  );
  const wallAir = await read(device, sim.volumeBuffer);
  let maxBoundarySpeed = 0;
  for (let z = 0; z < 32; z++)
    for (let y = 0; y < 48; y++)
      for (let x = 0; x < 48; x++) {
        const i = ((z * 48 + y) * 48 + x) * 8;
        if (x === 47) maxBoundarySpeed = Math.max(maxBoundarySpeed, Math.abs(wallAir[i]));
        if (y === 47) maxBoundarySpeed = Math.max(maxBoundarySpeed, Math.abs(wallAir[i + 1]));
        if (z === 31) maxBoundarySpeed = Math.max(maxBoundarySpeed, Math.abs(wallAir[i + 2]));
      }
  check(
    'Air cannot cross closed side walls or ceiling',
    maxBoundarySpeed < 0.000001,
    String(maxBoundarySpeed)
  );
  check(
    'All atmospheric water reservoirs stay finite and nonnegative',
    wallAir.every((v, i) => Number.isFinite(v) && (i % 8 < 4 || v >= 0))
  );

  // Continue the same inventory: only the external energy balance changes.
  // Net surface gain cannot be explained by cloud formation or airborne rain.
  const groundWater = (value) => value.liquid + value.snow + value.ice;
  Object.assign(config, { solarHeating: 0, radiativeCooling: 3 });
  const beforeCooling = await snapshot();
  let returned = beforeCooling;
  for (let batch = 0; batch < 20; batch++) {
    await tick(100);
    returned = await snapshot();
    document.querySelector('#results').textContent =
      `Cooling cycle ${(batch + 1) * 100} steps: ${JSON.stringify(returned)}`;
    if (
      groundWater(returned) > groundWater(beforeCooling) + 1 &&
      returned.liquid > beforeCooling.liquid + 1
    )
      break;
  }
  check(
    'Precipitation returns atmospheric water to liquid on the ground',
    groundWater(returned) > groundWater(beforeCooling) + 1 &&
      returned.liquid > beforeCooling.liquid + 1,
    `before=${JSON.stringify(beforeCooling)}, returned=${JSON.stringify(returned)}`
  );
  check(
    'Cooling and precipitation conserve the complete water inventory',
    Math.abs(returned.total - initial.total) / initial.total < 0.0002,
    JSON.stringify(returned)
  );
  Object.assign(config, { solarHeating: 3, radiativeCooling: 0 });
  let recycled = returned;
  for (let batch = 0; batch < 30; batch++) {
    await tick(100);
    recycled = await snapshot();
    document.querySelector('#results').textContent =
      `Warming cycle ${(batch + 1) * 100} steps: ${JSON.stringify(recycled)}`;
    if (groundWater(recycled) < groundWater(returned) - 1 && recycled.vapor > returned.vapor + 1)
      break;
  }
  check(
    'Returned surface water evaporates back into atmospheric humidity',
    groundWater(recycled) < groundWater(returned) - 1 && recycled.vapor > returned.vapor + 1,
    `returned=${JSON.stringify(returned)}, recycled=${JSON.stringify(recycled)}`
  );
  check(
    'The completed precipitation and re-evaporation loop conserves water',
    Math.abs(recycled.total - initial.total) / initial.total < 0.0002,
    JSON.stringify(recycled)
  );

  // Deliberately remove all air space without deleting its water inventory.
  const beforeObstruction = await snapshot();
  const elevated = new Float32Array(ground);
  for (let i = 0; i < elevated.length; i += 4) elevated[i] = 7;
  device.queue.writeBuffer(terrain, 0, elevated);
  await tick(2);
  const obstructed = await snapshot();
  check(
    'Raising terrain above the lid returns trapped atmospheric water',
    Math.abs(obstructed.total - beforeObstruction.total) / beforeObstruction.total < 0.00002,
    JSON.stringify(obstructed)
  );
  const trappedVapor = new Float32Array(state.length);
  for (let i = 3; i < trappedVapor.length; i += 4) trappedVapor[i] = 0.01;
  device.queue.writeBuffer(fluid, 0, trappedVapor);
  const waiting = await snapshot();
  await tick(4);
  const stillWaiting = await snapshot();
  check(
    'Steam remains accounted for when no air column is available',
    Math.abs(stillWaiting.total - waiting.total) / waiting.total < 0.00002 &&
      stillWaiting.steam > 0,
    JSON.stringify(stillWaiting)
  );
  device.queue.writeBuffer(terrain, 0, ground);
  await tick(3);
  const released = await snapshot();
  check(
    'Reopening air space releases waiting vapor without loss',
    Math.abs(released.total - stillWaiting.total) / stillWaiting.total < 0.00002 &&
      released.steam < stillWaiting.steam,
    JSON.stringify(released)
  );

  // Test the diagnostic against independent double-precision CPU sums.
  const budget = new WaterBudget(device, n, [48, 48, 32], 100);
  await budget.init();
  budget.sample(fluid, sim.surfaceBuffer, sim.volumeBuffer);
  for (let i = 0; i < 120 && !budget.latest; i++) await nextFrame();
  check(
    'GPU inventory matches all CPU-summed water reservoirs',
    budget.latest && Math.abs(budget.latest.total - released.total) / released.total < 0.000002,
    JSON.stringify(budget.latest)
  );
  budget.lastSampleAt = -Infinity;
  budget.sample(fluid, sim.surfaceBuffer, sim.volumeBuffer);
  budget.resetBaseline();
  await device.queue.onSubmittedWorkDone();
  for (let i = 0; i < 120 && budget.busy; i++) await nextFrame();
  check('A stale readback cannot overwrite a reset water baseline', budget.latest === null);
  check('No water-cycle GPU validation errors', errors.length === 0, errors.join('\n'));
  budget.destroy();
  sim.destroy();
  terrain.destroy();
  fluid.destroy();
  device.destroy();

  // End-to-end fine solver: borders, tiny drops, deep pools, evaporation and boiling.
  Object.assign(config, {
    atmosphereEnabled: false,
    closedWaterCycle: true,
    terrainType: 1,
    flatRockHeight: 0.05,
    terrainSandHeight: 0,
    renderResolution: 0.25,
    evaporation: 0.001,
    rainActive: true,
    borderBehavior: 1,
    borderWaterHeight: 3,
    paused: false,
  });
  const engine = new GPGPUSimulation(document.querySelector('canvas'), 97);
  await engine.initWebGPU();
  engine.step();
  engine.stepAtmosphere(0);
  const liquidSeed = new Float32Array(97 * 97 * 4);
  for (let i = 0; i < liquidSeed.length; i += 4) {
    liquidSeed[i] = i % 32 === 0 ? 15 : 0.02;
    liquidSeed[i + 1] = 0.005;
  }
  engine.device.queue.writeBuffer(engine.fluidsBufferA, 0, liquidSeed);
  engine.device.queue.writeBuffer(engine.fluidsBufferB, 0, liquidSeed);
  let originalLiquid = 0;
  for (let i = 0; i < liquidSeed.length; i += 4) originalLiquid += liquidSeed[i];
  for (let i = 0; i < 100; i++) engine.step();
  const liquidEnd = await read(
    engine.device,
    engine.pingPongToggle ? engine.fluidsBufferB : engine.fluidsBufferA
  );
  let liquidAndSteam = 0,
    steam = 0;
  for (let i = 0; i < liquidEnd.length; i += 4) {
    liquidAndSteam += liquidEnd[i] + liquidEnd[i + 3];
    steam += liquidEnd[i + 3];
  }
  check(
    'Fine water flow, deep pools and boiling conserve water while weather is off',
    Math.abs(liquidAndSteam - originalLiquid) / originalLiquid < 0.00002,
    `initial=${originalLiquid}, end=${liquidAndSteam}`
  );
  check('Evaporation and lava produce stored water vapor', steam > 0, `steam=${steam}`);
  window.testResults = { passed: true, results };
}
run().catch((error) => {
  console.error(error);
  window.testResults = { passed: false, error: String(error), results };
  document.querySelector('#results').textContent = JSON.stringify(window.testResults, null, 2);
});
