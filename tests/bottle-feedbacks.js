import { config } from '../src/config.ts';
import { AtmosphereSimulation } from '../src/atmosphere.ts';

// Production passes, finite initial water/heat, and no externally driven wind.
// Prepared without execution: these assertions are pending GPU validation.
const results = [];
const output = document.querySelector('#results');
function check(name, passed, detail = '') {
  results.push({ name, passed: Boolean(passed), detail });
  output.textContent = JSON.stringify(results, null, 2);
  if (!passed) throw new Error(`${name}: ${JSON.stringify(detail)}`);
}

async function run() {
  const adapter = await navigator.gpu?.requestAdapter();
  check('WebGPU available', adapter);
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const n = 32, count = n * n, dt = 0.05;
  const storage = (size) => device.createBuffer({
    size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  const terrain = storage(count * 24), fluids = storage(count * 16);
  const atmo = new AtmosphereSimulation(device, n);
  const saved = { ...config };
  const step = (time = dt) => {
    const encoder = device.createCommandEncoder();
    atmo.step(encoder, terrain, fluids, time);
    device.queue.submit([encoder.finish()]);
  };
  const ticks = async (seconds) => {
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      step();
      if (i % 80 === 79) await device.queue.onSubmittedWorkDone();
    }
    await device.queue.onSubmittedWorkDone();
  };
  const read = async (buffer) => {
    const staging = device.createBuffer({ size: buffer.size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, buffer.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap(); staging.destroy();
    return data;
  };
  const reset = (overrides = {}, seed = () => {}, water = 0, temperature = 12) => {
    Object.assign(config, saved, {
      atmosphereEnabled: true, heightScale: 18, airTemperature: temperature,
      relativeHumidity: 0, weatherVariability: 0, windSpeed: 0,
      solarHeating: 0, radiativeCooling: 0, evaporationRate: 0,
      surfaceAirHeatExchange: 0, airMixing: 0, convectionStrength: 0, orographicLift: 0,
      condensationRate: 0, rainEvaporationRate: 0, rainLifetime: 180,
      airBuoyancy: 0, airDrag: 0.025,
    }, overrides);
    const ground = new Float32Array(count * 6);
    const liquid = new Float32Array(count * 4);
    const surface = new Float32Array(count * 4);
    const air = new Float32Array(count * 16);
    for (let i = 0; i < count; i++) {
      liquid[i * 4] = water;
      surface[i * 4 + 2] = temperature;
      air[i * 8 + 3] = temperature;
      air[(i + count) * 8 + 3] = temperature - 2.8;
      seed(air, i, i % n, Math.floor(i / n));
    }
    device.queue.writeBuffer(terrain, 0, ground);
    device.queue.writeBuffer(fluids, 0, liquid);
    atmo.reset(); step(0);
    device.queue.writeBuffer(atmo.surfaceBuffer, 0, surface);
    device.queue.writeBuffer(atmo.volumeBuffer, 0, air);
  };
  const snapshot = async () => {
    // JS can read TS-private scratch here. After surfaceExchange only .w is
    // live, storing the sensible heat carried by pending surface evaporation.
    const [air, surface, liquid, faces, pending, flux] = await Promise.all([
      read(atmo.volumeBuffer), read(atmo.surfaceBuffer), read(fluids),
      read(atmo.circulationFaces), read(atmo.heatTransfers), read(atmo.energyFlux),
    ]);
    const airCapacity = atmo.domainHeight / 2 / config.heightScale;
    let energy = 0, water = 0, lowerVapor = 0, cloud = 0, outward = 0;
    for (let i = 0; i < count * 2; i++) {
      const j = i * 8;
      energy += airCapacity * (air[j + 3] + 480 * air[j + 4] - 80 * air[j + 7]);
      energy += airCapacity * 0.5 * (faces[i * 4] ** 2 + faces[i * 4 + 1] ** 2 + faces[i * 4 + 2] ** 2);
      water += airCapacity * (air[j + 4] + air[j + 5] + air[j + 6] + air[j + 7]);
      cloud += air[j + 5];
      if (i < count) {
        lowerVapor += air[j + 4];
        outward += air[j] * (i % n + 0.5 - n / 2) + air[j + 1] * (Math.floor(i / n) + 0.5 - n / 2);
      }
    }
    for (let i = 0; i < count; i++) {
      const j = i * 4, snow = surface[j], ice = surface[j + 1];
      const capacity = 1.5 + 8 * liquid[j] + 5 * ice + 2 * snow;
      energy += capacity * surface[j + 2] - 80 * (snow + ice)
        + 480 * surface[j + 3] + pending[j + 3];
      water += liquid[j] + liquid[j + 3] + snow + ice + surface[j + 3];
    }
    return { air, surface, liquid, flux, energy, water, lowerVapor, cloud, outward };
  };
  const balances = (name, before, after, addedEnergy = 0) => {
    check(`${name}: water conserved`, Math.abs(after.water - before.water) < Math.max(1, before.water) * 3e-5,
      { before: before.water, after: after.water });
    check(`${name}: sensible + latent + kinetic + pending energy balanced`,
      Math.abs(after.energy - before.energy - addedEnergy) < Math.max(1, Math.abs(before.energy)) * 3e-5,
      { before: before.energy, after: after.energy, addedEnergy });
    check(`${name}: finite, nonnegative water reservoirs`, after.air.every(Number.isFinite)
      && after.air.every((v, i) => i % 8 < 4 || v >= -1e-8)
      && after.surface.every(Number.isFinite)
      && after.surface.every((v, i) => i % 4 === 2 || v >= -1e-8));
  };
  const center = Math.floor(n / 2) * n + Math.floor(n / 2);
  const patch = (x, y) => Math.exp(-(((x + 0.5 - n / 2) / 5) ** 2 + ((y + 0.5 - n / 2) / 5) ** 2));
  try {
    await atmo.init();
    const humid = (air, i, x, y) => { air[(i + count) * 8 + 4] = 0.1 * patch(x, y); };
    reset({ condensationRate: 2, airBuoyancy: 1 }, humid);
    const humidBefore = await snapshot(); step();
    const condensing = await snapshot();
    check('Condensation warms the cloud layer and starts ascent within the same step',
      condensing.cloud > 0 && condensing.air[(center + count) * 8 + 3] > humidBefore.air[(center + count) * 8 + 3]
      && condensing.air[center * 8 + 2] > 0);
    balances('Condensation', humidBefore, condensing);
    reset({ airBuoyancy: 1 }, humid); step();
    const noCondensation = await snapshot();
    check('Zero cloud adjustment preserves initial vapor without creating a thermal gust',
      noCondensation.cloud === 0 && Math.abs(noCondensation.outward) < 1e-7);

    const rainAbove = (air, i, x, y) => {
      // Saturated upper layer isolates evaporation of newly fallen lower rain.
      air[(i + count) * 8 + 4] = 0.1;
      air[(i + count) * 8 + 6] = 0.02 * patch(x, y);
    };
    reset({ rainEvaporationRate: 0.4 }, rainAbove);
    const rainBefore = await snapshot(); step();
    const wet = await snapshot();
    check('Fresh upper rain evaporates into the lower layer before ground deposition', wet.lowerVapor > 0);
    balances('Falling rain and cold-pool cooling', rainBefore, wet);
    reset({}, rainAbove); step();
    const rainControl = await snapshot();
    check('Rain evaporation cools lower air and reduces ground rainfall against the same disabled control',
      wet.air[center * 8 + 3] < rainControl.air[center * 8 + 3]
      && wet.liquid[center * 4] < rainControl.liquid[center * 4]);
    const lowerRain = (air, i, x, y) => { air[i * 8 + 6] = 0.01 * patch(x, y); };
    reset({ rainEvaporationRate: 0.4, airBuoyancy: 1 }, lowerRain);
    const coldBefore = await snapshot(); await ticks(5);
    const cold = await snapshot();
    balances('Closed cold-pool circulation', coldBefore, cold);
    reset({ airBuoyancy: 1 }, lowerRain); await ticks(5);
    const noCooling = await snapshot();
    check('Evaporation strengthens spreading lower flow and central descent without boundary forcing',
      cold.outward > noCooling.outward && cold.outward > 0 && cold.air[center * 8 + 2] < 0,
      { withEvaporation: cold.outward, without: noCooling.outward });
    check('Internal moist feedbacks report zero radiative IN and OUT', cold.flux[0] === 0 && cold.flux[1] === 0);

    reset({ evaporationRate: 1 }, () => {}, 0.3);
    const seaBefore = await snapshot(); step();
    const evaporating = await snapshot();
    check('Surface evaporation cools available water and stores pending vapor',
      evaporating.surface[3] > 0 && evaporating.surface[2] < seaBefore.surface[2]);
    balances('Surface evaporation debit including pending sensible heat', seaBefore, evaporating);
    config.evaporationRate = 0; step();
    const injected = await snapshot();
    balances('Pending vapor injection into air', seaBefore, injected);
    check('Pending vapor is consumed once', injected.surface[3] === 0 && injected.lowerVapor > 0);
    reset({ evaporationRate: 1 }, () => {}, 0.3, -70); step();
    const floor = await snapshot();
    check('Temperature floor cannot fund further surface evaporation', floor.surface[3] === 0);

    const snowCloud = (air, i) => { air[(i + count) * 8 + 5] = 0.01; };
    reset({}, snowCloud, 0, -5);
    const snowBefore = await snapshot(); await ticks(1);
    balances('Cloud freezing and snow deposition', snowBefore, await snapshot());

    const cloudPatch = (air, i, x, y) => { air[(i + count) * 8 + 5] = 0.005 * patch(x, y); };
    reset({ solarHeating: 1, cloudShadows: 0.65 }, cloudPatch);
    const shadeBefore = await snapshot(); step();
    const shaded = await snapshot();
    const incoming = shaded.flux[0] * dt / ((200 / n) ** 2 * config.heightScale);
    balances('Cloud-shaded absorbed solar input', shadeBefore, shaded, incoming);
    reset({ solarHeating: 1, cloudShadows: 0 }, cloudPatch); step();
    const clear = await snapshot();
    check('Real clouds reduce absorbed IN and central ground warming', shaded.flux[0] < clear.flux[0]
      && shaded.surface[center * 4 + 2] < clear.surface[center * 4 + 2]);
    reset({ solarHeating: 1, cloudShadows: 0.65, cloudOpacity: 0 }, cloudPatch); step();
    const hidden = await snapshot();
    check('Hiding rendered clouds preserves physical solar shielding', hidden.flux[0] === shaded.flux[0]);
    check('No GPU validation errors', errors.length === 0, errors);
    window.testResults = { passed: true, results };
  } finally {
    Object.assign(config, saved);
    atmo.destroy(); terrain.destroy(); fluids.destroy(); device.destroy();
  }
}

run().catch((error) => {
  results.push({ name: 'Runtime error', passed: false, detail: String(error.stack ?? error) });
  output.textContent = JSON.stringify(results, null, 2);
  window.testResults = { passed: false, results };
});
