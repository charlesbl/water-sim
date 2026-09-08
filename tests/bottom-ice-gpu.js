import { config } from '../src/config.ts';
import { AtmosphereSimulation, ATMOSPHERE_DIMENSIONS } from '../src/atmosphere.ts';
import { GPGPUSimulation } from '../src/webgpuRenderer.ts';
import * as THREE from 'three';

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
  const result = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return result;
}
function sum(data, offset, stride = 4) {
  let total = 0;
  for (let i = offset; i < data.length; i += stride) total += data[i];
  return total;
}
function maximumDifference(a, b) {
  let maximum = 0;
  for (let i = 0; i < a.length; i++) maximum = Math.max(maximum, Math.abs(a[i] - b[i]));
  return maximum;
}
function totalWater(air, surface, fluid, n) {
  const surfaceVolume = (40000 * config.heightScale) / (n * n);
  const airVolume = (40000 * 100) / (atmoX * atmoY * atmoZ);
  return (
    (sum(fluid, 0) + sum(fluid, 3) + sum(surface, 0) + sum(surface, 1) + sum(surface, 3)) *
      surfaceVolume +
    (sum(air, 4, 8) + sum(air, 5, 8) + sum(air, 6, 8) + sum(air, 7, 8)) * airVolume
  );
}

async function run() {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  check('WebGPU adapter available', adapter);
  const device = await adapter.requestDevice();
  const validationErrors = [];
  device.addEventListener('uncapturederror', (event) => validationErrors.push(event.error.message));
  const n = 49;
  const terrainData = new Float32Array(n * n * 4);
  const fluidData = new Float32Array(terrainData.length);
  const surfaceData = new Float32Array(terrainData.length);
  const make = (label) =>
    device.createBuffer({
      label,
      size: terrainData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
  const terrain = make('Bottom ice regression terrain');
  const fluids = make('Bottom ice regression liquid');
  Object.assign(config, {
    atmosphereEnabled: true,
    closedWaterCycle: true,
    emergentWeather: true,
    airTemperature: -30,
    relativeHumidity: 0,
    windSpeed: 0,
    solarHeating: 0,
    radiativeCooling: 0,
    evaporationRate: 0,
    atmosphereBoundary: 1,
    heightScale: 18,
  });
  for (let i = 0; i < terrainData.length; i += 4) terrainData[i] = 0.05;
  device.queue.writeBuffer(terrain, 0, terrainData);
  const sim = new AtmosphereSimulation(device, n);
  await sim.init();
  const step = (dt = 0.1) => {
    const encoder = device.createCommandEncoder();
    sim.step(encoder, terrain, fluids, dt);
    device.queue.submit([encoder.finish()]);
  };
  const tick = async (count) => {
    for (let i = 0; i < count; i++) {
      step();
      if (i % 50 === 49) await device.queue.onSubmittedWorkDone();
    }
    await device.queue.onSubmittedWorkDone();
  };
  const seed = async ({ water = 0, ice = 0, snow = 0, temperature = 0, airTemperature = -30 }) => {
    config.airTemperature = airTemperature;
    sim.reset();
    step(0);
    fluidData.fill(0);
    surfaceData.fill(0);
    for (let i = 0; i < fluidData.length; i += 4) {
      fluidData[i] = water;
      surfaceData[i] = snow;
      surfaceData[i + 1] = ice;
      surfaceData[i + 2] = temperature;
    }
    device.queue.writeBuffer(fluids, 0, fluidData);
    device.queue.writeBuffer(sim.surfaceBuffer, 0, surfaceData);
    await device.queue.onSubmittedWorkDone();
  };
  const snapshot = async () => {
    const [air, surface, fluid] = await Promise.all([
      read(device, sim.volumeBuffer),
      read(device, sim.surfaceBuffer),
      read(device, fluids),
    ]);
    return { air, surface, fluid, total: totalWater(air, surface, fluid, n) };
  };

  await seed({ water: 0.002 });
  const beforeFreeze = await snapshot();
  await tick(1);
  const firstFreeze = await snapshot();
  check(
    'A cold lake freezes gradually instead of replacing its whole column at once',
    sum(firstFreeze.surface, 1) > 0 &&
      sum(firstFreeze.fluid, 0) > sum(beforeFreeze.fluid, 0) * 0.5 &&
      sum(firstFreeze.fluid, 0) < sum(beforeFreeze.fluid, 0),
    `liquid before=${sum(beforeFreeze.fluid, 0)}, after=${sum(firstFreeze.fluid, 0)}, ice=${sum(firstFreeze.surface, 1)}`
  );
  await tick(400);
  const frozen = await snapshot();
  check(
    'Sustained cooling freezes the complete small water column into anchored ice',
    sum(frozen.fluid, 0) < sum(beforeFreeze.fluid, 0) * 0.0001 &&
      Math.abs(sum(frozen.surface, 1) - sum(beforeFreeze.fluid, 0)) / sum(beforeFreeze.fluid, 0) <
        0.0001,
    `liquid=${sum(frozen.fluid, 0)}, ice=${sum(frozen.surface, 1)}`
  );
  check(
    'Freezing conserves total water across liquid, ice and the atmosphere',
    Math.abs(frozen.total - beforeFreeze.total) / beforeFreeze.total < 0.00002,
    `relative drift=${(frozen.total - beforeFreeze.total) / beforeFreeze.total}`
  );

  // A tiny initial thermal deficit must not release enough latent heat to jump
  // over the melting point in a single step, even with ample liquid available.
  await seed({ water: 0.5, temperature: -0.00001, airTemperature: 0 });
  await tick(1);
  const energyLimited = await snapshot();
  check(
    'Freezing does not heat a nearly isothermal column past the melting point',
    sum(energyLimited.surface, 1) > 0 &&
      energyLimited.surface.every((value, index) => index % 4 !== 2 || value <= 0.000001),
    `surface temperature=${energyLimited.surface[2]}, frozen=${energyLimited.surface[1]}`
  );

  await seed({ water: 0.1, temperature: -2, airTemperature: -2 });
  const isothermalAir = await read(device, sim.volumeBuffer);
  for (let i = 0; i < isothermalAir.length; i += 8) isothermalAir[i + 3] = -2;
  device.queue.writeBuffer(sim.volumeBuffer, 0, isothermalAir);
  const beforeLatent = await snapshot();
  await tick(1);
  const afterLatent = await snapshot();
  const enthalpy = (state, i) =>
    (1.5 + 8 * state.fluid[i] + 5 * state.surface[i + 1] + 2 * state.surface[i]) *
      state.surface[i + 2] -
    80 * (state.surface[i] + state.surface[i + 1]);
  let maxEnergyDrift = 0;
  for (let i = 0; i < fluidData.length; i += 4)
    maxEnergyDrift = Math.max(
      maxEnergyDrift,
      Math.abs(enthalpy(afterLatent, i) - enthalpy(beforeLatent, i))
    );
  check(
    'Freezing converts the thermal deficit into latent heat without creating energy',
    sum(afterLatent.surface, 1) > 0 &&
      maxEnergyDrift < 0.00003 &&
      afterLatent.surface[2] > beforeLatent.surface[2] &&
      afterLatent.surface[2] < 0,
    `maximum enthalpy drift=${maxEnergyDrift}, temperature=${afterLatent.surface[2]}`
  );

  await seed({ ice: 0.002, temperature: 30, airTemperature: 30 });
  const beforeMelt = await snapshot();
  await tick(200);
  const melted = await snapshot();
  check(
    'Warming returns all bottom ice to liquid without a residual solid layer',
    sum(melted.surface, 1) < 0.000001 && sum(melted.fluid, 0) > sum(beforeMelt.surface, 1) * 0.9999,
    `water=${sum(melted.fluid, 0)}, ice=${sum(melted.surface, 1)}`
  );
  check(
    'Complete melting conserves total water',
    Math.abs(melted.total - beforeMelt.total) / beforeMelt.total < 0.00002,
    `relative drift=${(melted.total - beforeMelt.total) / beforeMelt.total}`
  );

  // Start the next cold period from the actual meltwater, preserving every
  // reservoir. Only the thermal boundary and initial surface energy change.
  config.airTemperature = -30;
  sim.reset(false);
  step(0);
  const recooledSurface = new Float32Array(melted.surface);
  for (let i = 2; i < recooledSurface.length; i += 4) recooledSurface[i] = -30;
  device.queue.writeBuffer(sim.surfaceBuffer, 0, recooledSurface);
  await tick(400);
  const refrozen = await snapshot();
  check(
    'The same meltwater can refreeze completely without losing water between cycles',
    sum(refrozen.fluid, 0) === 0 &&
      sum(refrozen.surface, 0) === 0 &&
      Math.abs(refrozen.total - beforeMelt.total) / beforeMelt.total < 0.00002 &&
      Math.abs(sum(refrozen.surface, 1) - sum(beforeMelt.surface, 1)) < 0.00001,
    `water=${sum(refrozen.fluid, 0)}, ice=${sum(refrozen.surface, 1)}, relative drift=${(refrozen.total - beforeMelt.total) / beforeMelt.total}`
  );

  // This can occur when spreading water floods a formerly snowy ground cell.
  await seed({ water: 0.02, snow: 0.003, temperature: 5, airTemperature: 5 });
  const beforeFlood = await snapshot();
  await tick(1);
  const flooded = await snapshot();
  check(
    'Flooding snowy terrain removes the snow layer and returns its water to the wet column',
    sum(flooded.surface, 0) === 0 && sum(flooded.fluid, 0) > sum(beforeFlood.fluid, 0),
    `snow=${sum(flooded.surface, 0)}, water gained=${sum(flooded.fluid, 0) - sum(beforeFlood.fluid, 0)}`
  );
  check(
    'Snow entering water absorbs heat from the column',
    flooded.surface[2] < beforeFlood.surface[2],
    `temperature before=${beforeFlood.surface[2]}, after=${flooded.surface[2]}`
  );
  check(
    'Removing submerged snow conserves the complete water inventory',
    Math.abs(flooded.total - beforeFlood.total) / beforeFlood.total < 0.00001
  );

  // Airborne snow must still fall through the 3D atmosphere; only its ground
  // destination changes when it lands on water. The odd surface width also
  // exercises the conservative precipitation mapping at the final edge.
  await seed({ water: 0.02, temperature: -1, airTemperature: -1 });
  const snowfallAir = await read(device, sim.volumeBuffer);
  for (let z = 0; z < atmoZ; z++)
    for (let y = 0; y < atmoY; y++)
      for (let x = 0; x < atmoX; x++) {
        const i = ((z * atmoY + y) * atmoX + x) * 8;
        snowfallAir[i + 3] = -1;
        snowfallAir[i + 7] = z === 0 ? 0.001 : 0;
      }
  device.queue.writeBuffer(sim.volumeBuffer, 0, snowfallAir);
  const beforeSnow = await snapshot();
  await tick(5);
  const afterSnow = await snapshot();
  check(
    'Snowfall reaches a wet surface without accumulating snow above the lake',
    sum(afterSnow.surface, 0) === 0 &&
      sum(afterSnow.fluid, 0) + sum(afterSnow.surface, 1) >
        sum(beforeSnow.fluid, 0) + sum(beforeSnow.surface, 1),
    `snow cover=${sum(afterSnow.surface, 0)}, airborne snow=${sum(afterSnow.air, 7, 8)}`
  );
  check(
    'Snow falling into water conserves mass on a non-divisible surface grid',
    Math.abs(afterSnow.total - beforeSnow.total) / beforeSnow.total < 0.00002,
    `relative drift=${(afterSnow.total - beforeSnow.total) / beforeSnow.total}`
  );
  check(
    'Thermal phase changes remain finite and nonnegative',
    afterSnow.surface.every(
      (value, index) => Number.isFinite(value) && (index % 4 === 2 || value >= 0)
    ) && afterSnow.fluid.every((value) => Number.isFinite(value) && value >= 0)
  );
  check(
    'No atmosphere GPU validation errors',
    validationErrors.length === 0,
    validationErrors.join('\n')
  );
  sim.destroy();
  terrain.destroy();
  fluids.destroy();
  device.destroy();

  Object.assign(config, {
    atmosphereEnabled: false,
    closedWaterCycle: true,
    terrainType: 1,
    flatRockHeight: 0.1,
    terrainSandHeight: 0,
    renderResolution: 0.5,
    evaporation: 0,
    rainActive: false,
    erosionRate: 0,
    paused: false,
    smoothRendering: false,
    showClouds: false,
    showWind: false,
  });
  const engine = new GPGPUSimulation(document.querySelector('canvas'), 96);
  const engineErrors = [];
  window.addEventListener('simulation-error', (event) => engineErrors.push(event.detail));
  check('Full engine initializes with anchored bottom ice', await engine.initWebGPU());
  engine.device.addEventListener('uncapturederror', (event) =>
    engineErrors.push(event.error.message)
  );
  engine.step();
  engine.stepAtmosphere(0);
  const engineFluid = new Float32Array(96 * 96 * 4);
  const engineSurface = new Float32Array(engineFluid.length);
  const engineTerrain = new Float32Array(engineFluid.length);
  const upload = () => {
    engine.device.queue.writeBuffer(engine.terrainBufferA, 0, engineTerrain);
    engine.device.queue.writeBuffer(engine.terrainBufferB, 0, engineTerrain);
    engine.device.queue.writeBuffer(engine.fluidsBufferA, 0, engineFluid);
    engine.device.queue.writeBuffer(engine.fluidsBufferB, 0, engineFluid);
    engine.device.queue.writeBuffer(engine.atmosphere.surfaceBuffer, 0, engineSurface);
  };
  const currentFluid = () => (engine.pingPongToggle ? engine.fluidsBufferB : engine.fluidsBufferA);
  for (let y = 0; y < 96; y++)
    for (let x = 0; x < 96; x++) {
      const i = (y * 96 + x) * 4;
      const ice = 0.04 + 0.02 * Math.sin((x * 2 * Math.PI) / 96);
      engineTerrain[i] = 0.1;
      engineSurface[i + 1] = ice;
      engineSurface[i + 2] = -2;
      engineFluid[i] = 0.5 - ice / 0.917;
    }
  upload();
  for (let i = 0; i < 100; i++) engine.step();
  const stillLake = await read(engine.device, currentFluid());
  check(
    'A level lake above a nonuniform frozen bed stays at hydraulic rest',
    maximumDifference(stillLake, engineFluid) < 0.000002,
    `max liquid change=${maximumDifference(stillLake, engineFluid)}`
  );

  for (let y = 0; y < 96; y++)
    for (let x = 0; x < 96; x++) {
      const i = (y * 96 + x) * 4;
      engineSurface[i + 1] = 0.06;
      engineFluid[i] = 0.4 + (x < 48 ? 0.08 : 0);
    }
  upload();
  const beforeTransport = sum(engineFluid, 0);
  for (let i = 0; i < 100; i++) engine.step();
  const circulating = await read(engine.device, currentFluid());
  let enteredRight = 0;
  for (let y = 0; y < 96; y++)
    for (let x = 48; x < 96; x++) {
      const i = (y * 96 + x) * 4;
      enteredRight += circulating[i] - engineFluid[i];
    }
  check(
    'Liquid flows across a fixed frozen bed',
    enteredRight > 0.1,
    `water transferred across lake midpoint=${enteredRight}`
  );
  check(
    'Flow conserves water and does not advect the ice or rock',
    Math.abs(sum(circulating, 0) - beforeTransport) / beforeTransport < 0.00001 &&
      maximumDifference(
        await read(engine.device, engine.atmosphere.surfaceBuffer),
        engineSurface
      ) === 0 &&
      maximumDifference(
        await read(
          engine.device,
          engine.pingPongToggle ? engine.terrainBufferB : engine.terrainBufferA
        ),
        engineTerrain
      ) === 0
  );

  for (let i = 0; i < engineFluid.length; i += 4) {
    engineFluid[i] = 0.1;
    engineSurface[i] = 0.003;
    engineSurface[i + 1] = 0.06;
    engineSurface[i + 2] = 5;
  }
  upload();
  engine.step();
  const floodedWithoutWeather = await read(engine.device, engine.atmosphere.surfaceBuffer);
  const waterWithoutWeather = await read(engine.device, currentFluid());
  check(
    'Flooded snow becomes water even while atmospheric simulation is disabled',
    sum(floodedWithoutWeather, 0) === 0 &&
      Math.abs(sum(waterWithoutWeather, 0) - sum(engineFluid, 0) - sum(engineSurface, 0)) < 0.001 &&
      floodedWithoutWeather[2] < engineSurface[2],
    `snow=${sum(floodedWithoutWeather, 0)}, liquid=${sum(waterWithoutWeather, 0)}, temperature=${floodedWithoutWeather[2]}`
  );
  for (let i = 0; i < engineSurface.length; i += 4) engineSurface[i] = 0;

  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 1000);
  camera.position.set(0, 45, 70);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  for (let i = 0; i < engineFluid.length; i += 4) engineFluid[i] = 0.2;
  upload();
  engine.render(camera);
  await engine.performPicking(camera, innerWidth / 2, innerHeight / 2);
  const firstPick = engine.pointerUV?.clone();
  for (let i = 0; i < engineFluid.length; i += 4) engineFluid[i] = 0.6;
  upload();
  engine.render(camera);
  await engine.performPicking(camera, innerWidth / 2, innerHeight / 2);
  const deeperPick = engine.pointerUV?.clone();
  check(
    'The rendered and picked frozen bed stays fixed when lake depth changes',
    firstPick && deeperPick && firstPick.distanceTo(deeperPick) < 0.000001,
    `first=${JSON.stringify(firstPick)}, deeper=${JSON.stringify(deeperPick)}`
  );
  for (let i = 0; i < engineSurface.length; i += 4) engineSurface[i + 1] = 0.12;
  upload();
  engine.render(camera);
  await engine.performPicking(camera, innerWidth / 2, innerHeight / 2);
  check(
    'Additional frozen mass raises the solid bed used by picking',
    firstPick && engine.pointerUV && firstPick.distanceTo(engine.pointerUV) > 0.001,
    `initial=${JSON.stringify(firstPick)}, grown=${JSON.stringify(engine.pointerUV)}`
  );
  await engine.device.queue.onSubmittedWorkDone();
  check(
    'Rendering, picking and fluid flow produce no GPU validation errors',
    engine.resourcesReady && engineErrors.length === 0,
    engineErrors.join('\n')
  );
  window.testResults = { passed: true, results };
}

run().catch((error) => {
  console.error(error);
  window.testResults = { passed: false, error: String(error), results };
  document.querySelector('#results').textContent = JSON.stringify(window.testResults, null, 2);
});
