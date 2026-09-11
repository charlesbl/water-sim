import { config } from '../src/config.ts';
import { AtmosphereSimulation, ATMOSPHERE_DIMENSIONS } from '../src/atmosphere.ts';

const results = [];
const report = document.querySelector('#results');
function check(name, passed, detail = '') {
  results.push({ name, passed: !!passed, detail });
  report.textContent = JSON.stringify(results, null, 2);
  if (!passed) throw new Error(name + ': ' + detail);
}
async function run() {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  check('WebGPU available', adapter);
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const defaults = { ...config };
  const n = Number(document.body.dataset.gridSize || 96),
    count = n * n;
  const storage = (bytes) =>
    device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
  const terrain = storage(count * 24),
    fluids = storage(count * 16);
  const atmo = new AtmosphereSimulation(device, n);
  await atmo.init();
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
  const step = (dt) => {
    const encoder = device.createCommandEncoder();
    atmo.step(encoder, terrain, fluids, dt);
    device.queue.submit([encoder.finish()]);
  };
  const tick = async (seconds, dt = 0.1) => {
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      step(dt);
      if (i % 100 === 99) await device.queue.onSubmittedWorkDone();
    }
    await device.queue.onSubmittedWorkDone();
  };
  const reset = (overrides = {}, lake = false, mountain = false) => {
    Object.assign(config, defaults, overrides);
    const t = new Float32Array(count * 6),
      f = new Float32Array(count * 4);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        t[i * 6] = mountain ? 0.6 * Math.exp(-(((x / n - 0.55) / 0.09) ** 2)) : 0.05;
        t[i * 6 + 4] = 0.12;
        if (lake && x < n * 0.3) f[i * 4] = 0.08;
      }
    device.queue.writeBuffer(terrain, 0, t);
    device.queue.writeBuffer(fluids, 0, f);
    atmo.reset();
    step(0);
  };
  const snapshot = async () => {
    const [air, ground, water, map] = await Promise.all([
      read(atmo.volumeBuffer),
      read(atmo.surfaceBuffer),
      read(fluids),
      read(atmo.weatherMap),
    ]);
    let total = 0,
      vapor = 0,
      cloud = 0,
      rain = 0,
      snow = 0,
      liquid = 0,
      ice = 0,
      pending = 0;
    for (let i = 0; i < count; i++) {
      liquid += water[i * 4];
      snow += ground[i * 4];
      ice += ground[i * 4 + 1];
      pending += ground[i * 4 + 3] + water[i * 4 + 3];
    }
    for (let i = 0; i < count * 2; i++) {
      vapor += air[i * 8 + 4];
      cloud += air[i * 8 + 5];
      rain += air[i * 8 + 6] + air[i * 8 + 7];
    }
    const surfaceUnit = (200 / n) ** 2 * config.heightScale,
      airUnit = ((200 / n) ** 2 * atmo.domainHeight) / 2;
    total = (liquid + snow + ice + pending) * surfaceUnit + (vapor + cloud + rain) * airUnit;
    return { air, ground, water, map, total, vapor, cloud, rain, snow, liquid, ice, pending };
  };
  const rainStats = (map) => {
    let max = 0,
      sum = 0,
      active = 0;
    for (let i = 1; i < map.length; i += 4) {
      max = Math.max(max, map[i]);
      sum += map[i];
    }
    for (let i = 1; i < map.length; i += 4) if (map[i] > Math.max(1e-7, max * 0.1)) active++;
    return { max, mean: sum / count, active: active / count };
  };
  reset();
  check(
    'Production atmosphere is 256² × 2; small test surfaces retain two layers',
    ATMOSPHERE_DIMENSIONS.join(',') === '256,256,2' && atmo.dimensions[2] === 2
  );
  const initial = await snapshot();
  await tick(20);
  const early = await snapshot();
  const earlyStats = rainStats(early.map);
  check(
    'Default air produces localized rain and dry regions',
    earlyStats.active > 0.02 && earlyStats.active < 0.9,
    earlyStats
  );
  await tick(100);
  const later = await snapshot();
  let change = 0,
    scale = 0;
  for (let i = 1; i < early.map.length; i += 4) {
    change += Math.abs(later.map[i] - early.map[i]);
    scale += early.map[i];
  }
  check(
    'Rain distribution evolves within two weather minutes',
    change / Math.max(scale, 1e-8) > 0.3,
    { relativeChange: change / scale, later: rainStats(later.map) }
  );
  check(
    'Closed water budget survives rain, evaporation and layer exchange',
    Math.abs(later.total / initial.total - 1) < 0.0005,
    { drift: later.total / initial.total - 1 }
  );
  check(
    'Rain creates surface water and leaves wetness memory',
    later.liquid > 0 && later.map.some((v, i) => i % 4 === 0 && v > 0.05),
    {
      liquid: later.liquid,
      snow: later.snow,
      ice: later.ice,
      maxWetness: Math.max(...later.map.filter((_, i) => i % 4 === 0)),
    }
  );
  check(
    'All fields stay finite and every water reservoir stays non-negative',
    later.air.every(Number.isFinite) &&
      later.ground.every(Number.isFinite) &&
      later.air.every((v, i) => i % 8 < 4 || v >= -1e-7) &&
      later.water.every((v, i) => i % 4 !== 0 || v >= 0)
  );
  await tick(240);
  const mature = await snapshot();
  let minTemperature = Infinity,
    maxTemperature = -Infinity;
  for (let i = 3; i < mature.air.length; i += 8) {
    minTemperature = Math.min(minTemperature, mature.air[i]);
    maxTemperature = Math.max(maxTemperature, mature.air[i]);
  }
  check(
    'Six-minute weather retains bounded temperatures and its water inventory',
    minTemperature > -60 &&
      maxTemperature < 60 &&
      Math.abs(mature.total / initial.total - 1) < 0.0005,
    {
      minTemperature,
      maxTemperature,
      drift: mature.total / initial.total - 1,
      rain: rainStats(mature.map),
    }
  );
  const held = await read(atmo.volumeBuffer);
  step(0);
  const held2 = await read(atmo.volumeBuffer);
  check(
    'Zero timestep holds atmospheric state',
    held.every((v, i) => v === held2[i])
  );
  const originalGround = await read(atmo.surfaceBuffer);
  atmo.reset(false);
  step(0);
  const restartedGround = await read(atmo.surfaceBuffer);
  check(
    'Restart air preserves all surface reservoirs and pending transfers',
    originalGround.every((v, i) => v === restartedGround[i])
  );

  reset(
    {
      relativeHumidity: 0,
      weatherVariability: 0,
      airTemperature: 22,
      solarHeating: 1.5,
      atmosphereBoundary: 1,
    },
    true,
    true
  );
  const dryStart = await snapshot();
  await tick(90);
  const moist = await snapshot();
  check(
    'A real lake feeds initially dry air over evolving terrain',
    moist.vapor > 0 && moist.liquid < dryStart.liquid,
    { vapor: moist.vapor, liquidChange: moist.liquid - dryStart.liquid }
  );
  check(
    'Closed-wall water budget survives evaporation and orography',
    Math.abs(moist.total / dryStart.total - 1) < 0.0005,
    { drift: moist.total / dryStart.total - 1 }
  );
  check(
    'Both wall-normal boundary winds are closed',
    moist.air.every((v, i) => {
      const cell = Math.floor(i / 8),
        x = cell % n,
        y = Math.floor(cell / n) % n;
      return (
        !((i % 8 === 0 && (x === 0 || x === n - 1)) || (i % 8 === 1 && (y === 0 || y === n - 1))) ||
        v === 0
      );
    })
  );

  // Regression for weather settling into rain immediately above its water source.
  // A western sea is the ONLY initial water. Inspect well after startup clouds
  // would have rained out, on dry land at least 2 km from the original shore.
  reset({ relativeHumidity: 0, windDirection: 0 }, true);
  const seaStart = await snapshot();
  await tick(600);
  const matureSea = await snapshot();
  await tick(60);
  const movingSea = await snapshot();
  let offshoreRain = 0,
    allRain = 0,
    matureWind = 0,
    windChange = 0,
    rainChange = 0;
  for (let i = 0; i < count; i++) {
    const x = i % n;
    allRain += movingSea.map[i * 4 + 1];
    if (x >= n * 0.5 && x < n * 0.9) offshoreRain += movingSea.map[i * 4 + 1];
    matureWind += Math.hypot(matureSea.air[i * 8], matureSea.air[i * 8 + 1]);
    windChange += Math.hypot(
      movingSea.air[i * 8] - matureSea.air[i * 8],
      movingSea.air[i * 8 + 1] - matureSea.air[i * 8 + 1]
    );
    rainChange += Math.abs(movingSea.map[i * 4 + 1] - matureSea.map[i * 4 + 1]);
  }
  const persistentStats = {
    landRainFraction: offshoreRain / Math.max(allRain, 1e-12),
    meanWindKmPerMin: (((matureWind / count) * config.weatherMapSizeKm) / 200) * 60,
    relativeWindChange: windChange / Math.max(matureWind, 1e-12),
    relativeRainChange: rainChange / Math.max(allRain, 1e-12),
    rain: rainStats(movingSea.map),
    drift: movingSea.total / seaStart.total - 1,
  };
  check(
    'Sea water still rains well inland after eleven weather minutes',
    allRain / count > 1e-8 && offshoreRain / allRain > 0.1,
    persistentStats
  );
  check(
    'Mature winds and rain keep changing without restarting air',
    persistentStats.meanWindKmPerMin > 0.6 &&
      persistentStats.relativeWindChange > 0.15 &&
      persistentStats.relativeRainChange > 0.2,
    persistentStats
  );
  check(
    'Sustained regional energy adds no water',
    Math.abs(persistentStats.drift) < 0.0005,
    persistentStats.drift
  );

  reset(
    {
      airTemperature: -12,
      relativeHumidity: 1.2,
      solarHeating: 0.1,
      windSpeed: 1,
      rainLifetime: 20,
    },
    true
  );
  const coldStart = await snapshot();
  await tick(40);
  const frozen = await snapshot();
  check(
    'Cold weather stores precipitation in snow and freezes lake water',
    frozen.snow > 0 && frozen.ice > 0,
    { snow: frozen.snow, ice: frozen.ice }
  );
  Object.assign(config, { airTemperature: 28, relativeHumidity: 0.4, solarHeating: 2 });
  atmo.reset(false);
  step(0);
  const thawStart = await snapshot();
  await tick(50);
  const thaw = await snapshot();
  check('Warm air thaws existing snow and ice', thaw.snow + thaw.ice < frozen.snow + frozen.ice, {
    before: frozen.snow + frozen.ice,
    after: thaw.snow + thaw.ice,
  });
  check(
    'Freeze and thaw preserve water within each inventory baseline',
    Math.abs(frozen.total / coldStart.total - 1) < 0.0005 &&
      Math.abs(thaw.total / thawStart.total - 1) < 0.0005
  );

  // Compare identical supersaturated air; changing rain lifetime must change delivery timing.
  const delivery = async (lifetime) => {
    reset({
      relativeHumidity: 1.3,
      weatherVariability: 0,
      solarHeating: 0,
      radiativeCooling: 0,
      evaporationRate: 0,
      rainLifetime: lifetime,
      airTemperature: 18,
    });
    await tick(15);
    return (await snapshot()).liquid;
  };
  const fast = await delivery(15),
    slow = await delivery(150);
  check('Cloud lifetime controls actual rain delivery', fast > slow * 1.5, { fast, slow });
  await device.queue.onSubmittedWorkDone();
  check('No WebGPU validation errors', errors.length === 0, errors);
  atmo.destroy();
  terrain.destroy();
  fluids.destroy();
  device.destroy();
  Object.assign(config, defaults);
  window.testResults = { passed: true, results };
}
run().catch((error) => {
  report.textContent += '\n' + error.stack;
  window.testResults = { passed: false, error: String(error), results };
});
