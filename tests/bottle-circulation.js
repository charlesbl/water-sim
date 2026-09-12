import { config } from '../src/config.ts';
import { AtmosphereSimulation } from '../src/atmosphere.ts';

// Production GPU coverage. This suite was authored without executing it.
const results = [];
const report = document.querySelector('#results');
function check(name, passed, detail = '') {
  results.push({ name, passed: Boolean(passed), detail });
  report.textContent = JSON.stringify(results, null, 2);
  if (!passed) throw new Error(`${name}: ${JSON.stringify(detail)}`);
}

async function run() {
  const adapter = await navigator.gpu?.requestAdapter();
  check('WebGPU available', adapter);
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const n = 64, count = n * n, dx = 200 / n;
  const storage = (size) => device.createBuffer({
    size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  const terrain = storage(count * 24), fluids = storage(count * 16);
  const atmo = new AtmosphereSimulation(device, n);
  const saved = { ...config };
  const read = async (buffer) => {
    const staging = device.createBuffer({
      size: buffer.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, buffer.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap(); staging.destroy();
    return data;
  };
  const step = (dt) => {
    const encoder = device.createCommandEncoder();
    atmo.step(encoder, terrain, fluids, dt);
    device.queue.submit([encoder.finish()]);
  };
  const ticks = async (seconds) => {
    for (let i = 0; i < Math.round(seconds / 0.05); i++) {
      step(0.05);
      if (i % 80 === 79) await device.queue.onSubmittedWorkDone();
    }
    await device.queue.onSubmittedWorkDone();
  };
  const reset = (overrides = {}, coast = false) => {
    Object.assign(config, saved, {
      atmosphereEnabled: true, airTemperature: 12, airStability: 0.25,
      relativeHumidity: 0, weatherVariability: 0, windSpeed: 0,
      solarHeating: 0, radiativeCooling: 0, evaporationRate: 0,
      airMixing: 0, convectionStrength: 0, orographicLift: 0,
      airBuoyancy: 1, airDrag: 0.025, surfaceAirHeatExchange: 0,
    }, overrides);
    const ground = new Float32Array(count * 6);
    const liquid = new Float32Array(count * 4);
    const surface = new Float32Array(count * 4);
    const air = new Float32Array(count * 2 * 8);
    for (let i = 0; i < count; i++) {
      // A flat exposed surface even across the coast: water replaces bed height.
      const water = coast && i % n < n / 2;
      ground[i * 6] = water ? 0 : 0.4;
      ground[i * 6 + 4] = water ? 0 : 0.1;
      liquid[i * 4] = water ? 0.5 : 0;
      surface[i * 4 + 2] = 12;
      air[i * 8 + 3] = 12;
      air[(i + count) * 8 + 3] = 12 - (0.3 * atmo.domainHeight / 2 - 2);
    }
    device.queue.writeBuffer(terrain, 0, ground);
    device.queue.writeBuffer(fluids, 0, liquid);
    atmo.reset(); step(0);
    // Same initial surface and air temperatures across land and water. This
    // removes an initialization pulse as a possible explanation of the breeze.
    device.queue.writeBuffer(atmo.surfaceBuffer, 0, surface);
    device.queue.writeBuffer(atmo.volumeBuffer, 0, air);
  };
  const snapshot = async () => {
    const [air, faces, surface, radiation] = await Promise.all([
      read(atmo.volumeBuffer), read(atmo.circulationFaces),
      read(atmo.surfaceBuffer), read(atmo.energyFlux),
    ]);
    let sensible = 0, kinetic = 0, moisture = 0, upperVapor = 0, peak = 0;
    for (let i = 0; i < 2 * count; i++) {
      sensible += air[i * 8 + 3];
      for (let channel = 4; channel < 8; channel++) moisture += air[i * 8 + channel];
      if (i >= count) upperVapor += air[i * 8 + 4];
      peak = Math.max(peak, Math.hypot(air[i * 8], air[i * 8 + 1]));
    }
    // Each independent MAC face has 1/2 v², including the vertical interface.
    for (let i = 0; i < 2 * count; i++) {
      kinetic += 0.5 * (faces[i * 4] ** 2 + faces[i * 4 + 1] ** 2 + faces[i * 4 + 2] ** 2);
    }
    return { air, faces, surface, radiation, sensible, kinetic,
      energy: sensible + kinetic, moisture, upperVapor, peak };
  };
  try {
    await atmo.init();
    reset();
    await ticks(10);
    const rest = await snapshot();
    check('Uniform stratified air stays at rest with all boundary heat fluxes off', rest.peak < 1e-6, rest.peak);

    const seed = rest.air.slice();
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const warm = Math.exp(-(((x / n - 0.5) / 0.15) ** 2 + ((y / n - 0.5) / 0.15) ** 2));
      seed[i * 8 + 3] += 6 * warm;
      seed[(i + count) * 8 + 3] += 3 * warm;
      seed[i * 8 + 4] = 0.0001 * warm;
    }
    device.queue.writeBuffer(atmo.volumeBuffer, 0, seed);
    const before = await snapshot();
    await ticks(20);
    const after = await snapshot();
    check('A finite internal thermal contrast starts circulation without sunlight or imposed wind', after.peak > 1e-4, after.peak);
    check('Resolved ascent carries lower-air vapor upward with background mixing disabled', after.upperVapor > 1e-6, after.upperVapor);
    check('Closed circulation conserves the water tracer', Math.abs(after.moisture / before.moisture - 1) < 2e-5, after.moisture / before.moisture - 1);
    check('Thermal plus MAC kinetic energy stays constant without boundary heat exchange',
      Math.abs(after.energy / before.energy - 1) < 3e-5,
      { before: before.energy, after: after.energy, kinetic: after.kinetic });
    check('Radiative readout reports zero IN and OUT during internal motion', after.radiation[0] === 0 && after.radiation[1] === 0, Array.from(after.radiation));

    let upward = 0, downward = 0, sumVertical = 0, continuity = 0, wallLeak = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const east = after.faces[i * 4], north = after.faces[i * 4 + 1];
      const west = x > 0 ? after.faces[(i - 1) * 4] : 0;
      const south = y > 0 ? after.faces[(i - n) * 4 + 1] : 0;
      const w = after.air[i * 8 + 2] * 2;
      upward = Math.max(upward, w); downward = Math.min(downward, w); sumVertical += w;
      continuity = Math.max(continuity, Math.abs((east - west + north - south) / dx + w / (atmo.domainHeight / 2)));
      const upper = (i + count) * 4;
      const upperWest = x > 0 ? after.faces[upper - 4] : 0;
      const upperSouth = y > 0 ? after.faces[upper - n * 4 + 1] : 0;
      continuity = Math.max(continuity, Math.abs((after.faces[upper] - upperWest
        + after.faces[upper + 1] - upperSouth) / dx - w / (atmo.domainHeight / 2)));
      if (x === n - 1) wallLeak = Math.max(wallLeak, Math.abs(east));
      if (y === n - 1) wallLeak = Math.max(wallLeak, Math.abs(north));
      if (x === n - 1) wallLeak = Math.max(wallLeak, Math.abs(after.faces[upper]));
      if (y === n - 1) wallLeak = Math.max(wallLeak, Math.abs(after.faces[upper + 1]));
    }
    check('Rising and sinking branches coexist and close the vertical budget', upward > 0 && downward < 0 && Math.abs(sumVertical) < 0.001, { upward, downward, sumVertical });
    check('The coupled pressure closes both layer volumes within solver tolerance', continuity < 2e-4 && wallLeak === 0, { continuity, wallLeak });
    check('Circulation keeps all values finite and moisture nonnegative', after.air.every(Number.isFinite) && after.air.every((v, i) => i % 8 < 4 || v >= -1e-8));

    config.airBuoyancy = 0;
    const decayBefore = await snapshot();
    await ticks(20);
    const decayAfter = await snapshot();
    check('Friction removes motion and restores its energy as heat',
      decayAfter.kinetic < decayBefore.kinetic && decayAfter.sensible > decayBefore.sensible &&
      Math.abs(decayAfter.energy / decayBefore.energy - 1) < 3e-5,
      { kineticBefore: decayBefore.kinetic, kineticAfter: decayAfter.kinetic, heatGain: decayAfter.sensible - decayBefore.sensible });

    reset({ solarHeating: 1, surfaceAirHeatExchange: 0.45 }, true);
    await ticks(45);
    const coast = await snapshot();
    let landTemperature = 0, waterTemperature = 0, inlandFlow = 0;
    for (let i = 0; i < count; i++) {
      if (i % n < n / 2) waterTemperature += coast.surface[i * 4 + 2];
      else landTemperature += coast.surface[i * 4 + 2];
      if (i % n === n / 2 - 1) inlandFlow += coast.faces[i * 4];
    }
    check('Local sunlight heats dry land faster than deep water from the same initial temperature', landTemperature > waterTemperature, { land: landTemperature / (count / 2), water: waterTemperature / (count / 2) });
    check('Land-water heating differences generate a lower breeze toward the land', inlandFlow > 0.001, inlandFlow / n);
    reset({ solarHeating: 1, surfaceAirHeatExchange: 0.45, airBuoyancy: 0 }, true);
    await ticks(20);
    const noExpansion = await snapshot();
    check('Switching off thermal expansion prevents wind despite land-water heating differences', noExpansion.peak < 1e-6, noExpansion.peak);
    reset({ solarHeating: 1, surfaceAirHeatExchange: 0 }, true);
    await ticks(20);
    const noExchange = await snapshot();
    check('Surface heat cannot drive air without a surface-air exchange', noExchange.peak < 1e-6, noExchange.peak);
    check('No GPU validation errors', errors.length === 0, errors);
    window.testResults = { passed: true, results };
  } finally {
    Object.assign(config, saved);
    atmo.destroy(); terrain.destroy(); fluids.destroy(); device.destroy();
  }
}

run().catch((error) => {
  results.push({ name: 'Runtime error', passed: false, detail: String(error.stack ?? error) });
  report.textContent = JSON.stringify(results, null, 2);
  window.testResults = { passed: false, results };
});
