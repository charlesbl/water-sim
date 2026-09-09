import { terrainFixture } from './terrain-fixture.js';
import { config } from '../src/config.ts';
import { AtmosphereSimulation, ATMOSPHERE_DIMENSIONS } from '../src/atmosphere.ts';
import { GPGPUSimulation } from '../src/webgpuRenderer.ts';
import * as THREE from 'three';

const results = [];
const [atmoX, atmoY, atmoZ] = ATMOSPHERE_DIMENSIONS;
const highTestLayer = Math.floor((20 * atmoZ) / 32);
const seededLayer = Math.floor((8 * atmoZ) / 32);
const report = document.getElementById('results');
const check = (name, condition, detail = '') => {
  results.push({ name, passed: !!condition, detail });
  report.textContent = JSON.stringify(results, null, 2);
  if (!condition) throw new Error(`${name}: ${detail}`);
};

async function run() {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  check('WebGPU adapter available', adapter);
  const device = await adapter.requestDevice();
  const validationErrors = [];
  device.addEventListener('uncapturederror', (event) => validationErrors.push(event.error.message));
  const size = 96;
  const data = new Float32Array(size * size * 4);
  const createBuffer = (label, bytes = data.byteLength) =>
    device.createBuffer({
      label,
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
  const terrain = createBuffer('test terrain', size * size * 24);
  const fluids = createBuffer('test fluids');
  const read = async (buffer) => {
    const staging = device.createBuffer({
      size: buffer.size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, buffer.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const copy = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return copy;
  };
  const sum = (values, stride, offset) => {
    let total = 0;
    for (let i = offset; i < values.length; i += stride) total += values[i];
    return total;
  };
  Object.assign(config, {
    atmosphereEnabled: true,
    airTemperature: -12,
    relativeHumidity: 1.2,
    windSpeed: 8,
    solarHeating: 0.2,
    heightScale: 18,
    evaporationRate: 0, // Isolate phase transfers; the closed-cycle suite tests evaporation.
  });
  for (let i = 0; i < data.length; i += 4) data[i] = 0.05;
  device.queue.writeBuffer(terrain, 0, terrainFixture(data));
  device.queue.writeBuffer(fluids, 0, data);
  const atmosphere = new AtmosphereSimulation(device, size);
  await atmosphere.init();
  const step = (dt) => {
    const encoder = device.createCommandEncoder();
    atmosphere.step(encoder, terrain, fluids, dt);
    device.queue.submit([encoder.finish()]);
  };
  const tick = async (count) => {
    for (let i = 0; i < count; i++) step(1 / 30);
    await device.queue.onSubmittedWorkDone();
  };
  step(0);
  const coldInitial = await read(atmosphere.volumeBuffer);
  check(
    'Cold air starts without a seeded temperature pattern',
    coldInitial.every(
      (v, i) =>
        i % 8 !== 3 ||
        v === coldInitial[Math.floor(i / (atmoX * atmoY * 8)) * atmoX * atmoY * 8 + 3]
    )
  );
  await tick(60);
  const coldVolume = await read(atmosphere.volumeBuffer);
  const coldSurface = await read(atmosphere.surfaceBuffer);
  const coldFluids = await read(fluids);
  check('Three-dimensional volume allocated', coldVolume.length === atmoX * atmoY * atmoZ * 8);
  check('All atmosphere values finite', coldVolume.every(Number.isFinite));
  check(
    'Air temperature varies vertically',
    Math.abs(coldVolume[3] - coldVolume[atmoX * atmoY * highTestLayer * 8 + 3]) > 0.1
  );
  check(
    'Water freezes below zero',
    sum(coldSurface, 4, 1) > 0 && sum(coldFluids, 4, 0) < size * size * 0.05
  );
  check('Clouds condense in humid air', sum(coldVolume, 8, 5) > 0);
  const frozenTime = atmosphere.simulationTime;
  step(0);
  check('Zero timestep preserves simulation time', atmosphere.simulationTime === frozenTime);
  const pausedVolume = await read(atmosphere.volumeBuffer);
  const pausedSurface = await read(atmosphere.surfaceBuffer);
  check(
    'Zero timestep preserves all weather state',
    coldVolume.every((v, i) => v === pausedVolume[i]) &&
      coldSurface.every((v, i) => v === pausedSurface[i])
  );
  config.atmosphereEnabled = false;
  step(1 / 30);
  check('Disabled atmosphere preserves time', atmosphere.simulationTime === frozenTime);
  config.atmosphereEnabled = true;

  // A hot starting surface isolates phase transfer from the deliberately slow air response.
  const thawSeed = new Float32Array(coldSurface);
  for (let i = 0; i < thawSeed.length; i += 4) {
    thawSeed[i] = 0.02;
    thawSeed[i + 1] = 0.02;
    thawSeed[i + 2] = 22;
  }
  device.queue.writeBuffer(atmosphere.surfaceBuffer, 0, thawSeed);
  const waterBeforeThaw = sum(await read(fluids), 4, 0);
  Object.assign(config, { airTemperature: 22, relativeHumidity: 0.45, solarHeating: 2 });
  await tick(60);
  const warmSurface = await read(atmosphere.surfaceBuffer);
  const warmFluids = await read(fluids);
  check('Snow melts above zero', sum(warmSurface, 4, 0) < sum(thawSeed, 4, 0));
  check('Ice melts above zero', sum(warmSurface, 4, 1) < sum(thawSeed, 4, 1));
  check('Melt returns liquid water', sum(warmFluids, 4, 0) > waterBeforeThaw);
  check(
    'Surface quantities stay finite and nonnegative',
    warmSurface.every((v, i) => Number.isFinite(v) && (i % 4 === 2 || v >= 0)) &&
      warmFluids.every(Number.isFinite)
  );

  // Seed condensate in an elevated slab. Advection/sedimentation must move it in z.
  const volumeSeed = await read(atmosphere.volumeBuffer);
  for (let i = 0; i < volumeSeed.length; i += 8) {
    const z = Math.floor(i / 8 / (atmoX * atmoY));
    volumeSeed[i] = 0;
    volumeSeed[i + 1] = 0;
    volumeSeed[i + 2] = 0;
    volumeSeed[i + 3] = -12;
    volumeSeed[i + 4] = 0;
    volumeSeed[i + 5] = 0;
    volumeSeed[i + 6] = 0;
    volumeSeed[i + 7] = z === seededLayer ? 0.01 : 0;
  }
  Object.assign(config, {
    airTemperature: -12,
    relativeHumidity: 0,
    windSpeed: 0,
    solarHeating: 0,
  });
  device.queue.writeBuffer(atmosphere.volumeBuffer, 0, volumeSeed);
  await tick(15);
  const transported = await read(atmosphere.volumeBuffer);
  let belowSlab = 0;
  for (let i = 7; i < atmoX * atmoY * seededLayer * 8; i += 8) belowSlab += transported[i];
  check('Snow transports between vertical layers', belowSlab > 0);
  check(
    'Moisture stays finite and nonnegative',
    transported.every((v, i) => Number.isFinite(v) && (i % 8 < 4 || v >= 0))
  );
  config.atmosphereEnabled = false;
  atmosphere.reset();
  step(0);
  const resetSurface = await read(atmosphere.surfaceBuffer);
  check(
    'Reset clears solid water while disabled',
    sum(resetSurface, 4, 0) === 0 && sum(resetSurface, 4, 1) === 0
  );

  // Emergent mode must not secretly follow the initial-condition sliders.
  Object.assign(config, {
    atmosphereEnabled: true,
    emergentWeather: true,
    airTemperature: 8,
    relativeHumidity: 0.75,
    windSpeed: 0,
    solarHeating: 1,
    radiativeCooling: 1,
  });
  atmosphere.reset();
  step(0);
  const initialAir = await read(atmosphere.volumeBuffer);
  const initialSurface = await read(atmosphere.surfaceBuffer);
  // Break symmetry through a real local surface heat source, not seeded air noise.
  for (let y = 32; y < 64; y++)
    for (let x = 32; x < 64; x++) initialSurface[(y * size + x) * 4 + 2] += 6;
  device.queue.writeBuffer(atmosphere.surfaceBuffer, 0, initialSurface);
  const initialWater = await read(fluids);
  check(
    'Emergent air starts at rest',
    initialAir.every((v, i) => i % 8 >= 3 || v === 0)
  );
  await tick(1);
  const baselineAir = await read(atmosphere.volumeBuffer);
  device.queue.writeBuffer(atmosphere.volumeBuffer, 0, initialAir);
  device.queue.writeBuffer(atmosphere.surfaceBuffer, 0, initialSurface);
  device.queue.writeBuffer(fluids, 0, initialWater);
  Object.assign(config, {
    airTemperature: 35,
    relativeHumidity: 1.4,
    windSpeed: 30,
    windDirection: 270,
    airStability: 1,
  });
  await tick(1);
  const changedSlidersAir = await read(atmosphere.volumeBuffer);
  let maxDifference = 0;
  for (let i = 0; i < baselineAir.length; i++)
    maxDifference = Math.max(maxDifference, Math.abs(baselineAir[i] - changedSlidersAir[i]));
  check(
    'Emergent evolution ignores initial temperature, humidity, stability and wind sliders',
    maxDifference < 0.000001,
    String(maxDifference)
  );
  await tick(90);
  const emergentAir = await read(atmosphere.volumeBuffer);
  check(
    'Convection creates vertical wind from rest',
    emergentAir.some((v, i) => i % 8 === 2 && Math.abs(v) > 0.001)
  );
  check(
    'Pressure creates horizontal circulation from rest',
    emergentAir.some((v, i) => i % 8 < 2 && Math.abs(v) > 0.001)
  );
  const preservedSurface = await read(atmosphere.surfaceBuffer);
  atmosphere.reset(false);
  step(0);
  const restartedSurface = await read(atmosphere.surfaceBuffer);
  check(
    'Restarting air preserves every surface cell',
    preservedSurface.every((v, i) => v === restartedSurface[i])
  );

  // Zero water budget: even a 140% initialization setting cannot supply ongoing vapor.
  const dryAir = await read(atmosphere.volumeBuffer);
  for (let i = 0; i < dryAir.length; i += 8) {
    dryAir.fill(0, i, i + 8);
    dryAir[i + 3] = 8;
  }
  data.fill(0);
  device.queue.writeBuffer(fluids, 0, data);
  device.queue.writeBuffer(atmosphere.volumeBuffer, 0, dryAir);
  for (let i = 2; i < data.length; i += 4) data[i] = 8;
  device.queue.writeBuffer(atmosphere.surfaceBuffer, 0, data);
  await tick(5);
  const stillDry = await read(atmosphere.volumeBuffer);
  check(
    'Dry emergent world creates no water from humidity setting',
    stillDry.every((v, i) => i % 8 < 4 || v === 0)
  );
  await device.queue.onSubmittedWorkDone();
  check(
    'No WebGPU solver validation errors',
    !validationErrors.length,
    validationErrors.join('\n')
  );
  atmosphere.destroy();
  terrain.destroy();
  fluids.destroy();
  device.destroy();

  // Non-divisible grids + alternating precipitation expose blocky coupling.
  const depositionAdapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
  });
  const depositionDevice = await depositionAdapter.requestDevice();
  const depositionErrors = [];
  depositionDevice.addEventListener('uncapturederror', (event) =>
    depositionErrors.push(event.error.message)
  );
  const fine = 257;
  const depositionTerrain = depositionDevice.createBuffer({
    size: fine * fine * 24,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const depositionFluid = depositionDevice.createBuffer({
    size: fine * fine * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const depositionSim = new AtmosphereSimulation(depositionDevice, fine);
  Object.assign(config, {
    airTemperature: -12,
    relativeHumidity: 0,
    windSpeed: 0,
    solarHeating: 0,
    radiativeCooling: 0,
  });
  await depositionSim.init();
  let depositionEncoder = depositionDevice.createCommandEncoder();
  depositionSim.step(depositionEncoder, depositionTerrain, depositionFluid, 0);
  depositionDevice.queue.submit([depositionEncoder.finish()]);
  const snowSeed = new Float32Array(atmoX * atmoY * atmoZ * 8);
  for (let i = 0; i < snowSeed.length; i += 8) {
    snowSeed[i + 3] = -12;
    if (i < atmoX * atmoY * 8) snowSeed[i + 7] = (i / 8) % 2 === 0 ? 0.016 : 0.004;
  }
  depositionDevice.queue.writeBuffer(depositionSim.volumeBuffer, 0, snowSeed);
  depositionEncoder = depositionDevice.createCommandEncoder();
  depositionSim.step(depositionEncoder, depositionTerrain, depositionFluid, 1 / 30);
  const depositedReadback = depositionDevice.createBuffer({
    size: fine * fine * 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  depositionEncoder.copyBufferToBuffer(
    depositionSim.surfaceBuffer,
    0,
    depositedReadback,
    0,
    fine * fine * 16
  );
  depositionDevice.queue.submit([depositionEncoder.finish()]);
  await depositedReadback.mapAsync(GPUMapMode.READ);
  const deposited = new Float32Array(depositedReadback.getMappedRange().slice(0));
  depositedReadback.unmap();
  const expectedSnow =
    (((sum(snowSeed, 8, 7) * (2.5 / 30)) / config.heightScale) * fine * fine) / (atmoX * atmoY);
  const actualSnow = sum(deposited, 4, 0);
  check(
    'Smooth deposition conserves snow on a non-divisible grid',
    Math.abs(actualSnow - expectedSnow) / expectedSnow < 0.00001,
    `deposited=${actualSnow}, expected=${expectedSnow}`
  );
  const profile = new Float64Array(fine);
  for (let y = 0; y < fine; y++)
    for (let x = 0; x < fine; x++) profile[x] += deposited[(y * fine + x) * 4] / fine;
  let allJumps = 0,
    seamJumps = 0,
    seamCount = 0;
  for (let x = 1; x < fine; x++) {
    const jump = Math.abs(profile[x] - profile[x - 1]);
    allJumps += jump;
    if (Math.floor((x * atmoX) / fine) !== Math.floor(((x - 1) * atmoX) / fine)) {
      seamJumps += jump;
      seamCount++;
    }
  }
  const seamRatio = seamJumps / seamCount / (allJumps / (fine - 1));
  check(
    'Snow has no amplified jumps at atmosphere tile boundaries',
    seamRatio < 1.8,
    `seam/average gradient=${seamRatio}`
  );
  check('No deposition validation errors', !depositionErrors.length, depositionErrors.join('\n'));
  depositionSim.destroy();
  depositionTerrain.destroy();
  depositionFluid.destroy();
  depositedReadback.destroy();
  depositionDevice.destroy();

  // Compile and execute the complete integration, including every visualization and picking.
  Object.assign(config, {
    atmosphereEnabled: true,
    renderResolution: 0.5,
    airTemperature: -12,
    relativeHumidity: 1.2,
    windSpeed: 8,
    solarHeating: 0.2,
    terrainType: 0,
  });
  const engine = new GPGPUSimulation(document.getElementById('preview'), 96);
  const engineErrors = [];
  window.addEventListener('simulation-error', (event) => engineErrors.push(event.detail));
  check('Full engine initializes', await engine.initWebGPU());
  const camera = new THREE.PerspectiveCamera(50, 640 / 400, 0.1, 1000);
  camera.position.set(130, 100, 160);
  camera.lookAt(0, 20, 0);
  camera.updateMatrixWorld();
  engine.step();
  engine.stepAtmosphere(1 / 30);
  for (const view of [0, 1, 2, 3]) {
    config.atmosphereView = view;
    config.showWind = true;
    engine.render(camera);
  }
  camera.position.set(0, 40, 0);
  camera.lookAt(0, 40, -50);
  camera.updateMatrixWorld();
  engine.render(camera);
  await engine.performPicking(camera, 320, 200);
  config.renderResolution = 0.25;
  engine.rebuildMesh();
  engine.render(camera);
  config.paused = true;
  engine.resetTerrain(false);
  engine.step();
  engine.stepAtmosphere(0);
  engine.render(camera);
  Object.assign(config, {
    paused: false,
    airTemperature: 2,
    relativeHumidity: 0.2,
    windSpeed: 0,
    solarHeating: 1,
    evaporation: 0,
    rainActive: false,
    borderWaterHeight: 0,
  });
  engine.clearFluids();
  engine.stepAtmosphere(0);
  engine.resetWeather(false);
  engine.stepAtmosphere(0);
  const meltSeed = new Float32Array(96 * 96 * 4);
  for (let i = 0; i < meltSeed.length; i += 4) {
    meltSeed[i] = 0.02;
    meltSeed[i + 2] = 2;
  }
  engine.device.queue.writeBuffer(engine.atmosphere.surfaceBuffer, 0, meltSeed);
  engine.stepAtmosphere(1 / 30);
  // Four faster surface ticks used to erase each tiny increment of meltwater.
  for (let i = 0; i < 4; i++) engine.step();
  const meltReadback = engine.device.createBuffer({
    size: meltSeed.byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const meltEncoder = engine.device.createCommandEncoder();
  meltEncoder.copyBufferToBuffer(
    engine.pingPongToggle ? engine.fluidsBufferB : engine.fluidsBufferA,
    0,
    meltReadback,
    0,
    meltSeed.byteLength
  );
  engine.device.queue.submit([meltEncoder.finish()]);
  await meltReadback.mapAsync(GPUMapMode.READ);
  const survivingMelt = sum(new Float32Array(meltReadback.getMappedRange()), 4, 0);
  check(
    'Small meltwater amounts survive subsequent fluid flow ticks',
    survivingMelt > 0.01,
    String(survivingMelt)
  );
  meltReadback.unmap();
  meltReadback.destroy();
  await new Promise((resolve) => setTimeout(resolve, 250));
  check(
    'All rendering modes, picking, mesh change and paused reset validate',
    !engineErrors.length,
    engineErrors.join('\n')
  );
}

run()
  .then(() => {
    window.testResults = { passed: true, results };
  })
  .catch((error) => {
    console.error(error);
    window.testResults = { passed: false, error: String(error), results };
    report.textContent = JSON.stringify(window.testResults, null, 2);
  });
