import { inverseBrush } from '../src/brushes.ts';
import { config } from '../src/config.ts';
import { GPGPUSimulation } from '../src/webgpuRenderer.ts';
import * as THREE from 'three';

const results = [];
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
    weatherEnabled: true,
    solarHeating: 0,
    coolingLow: 0,
    coolingMiddle: 0,
    coolingHigh: 0,
    evaporationRate: 0,
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
  e.stepWeather(0);
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
    e.device.queue.writeBuffer(e.weather.surfaceBuffer, 0, surface);
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
  let s = await read(e.device, e.weather.surfaceBuffer),
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
  s = await read(e.device, e.weather.surfaceBuffer);
  f = await read(e.device, current());
  check(
    'Erase removes ice, snow and liquid without negative amounts',
    s[center] === 0 &&
      s[center + 1] === 0 &&
      f[center] === 0 &&
      s.every((v, i) => i % 4 === 2 || v >= 0)
  );
  check(
    'Erase preserves frozen mass outside the brush',
    Math.abs(s[0] + s[1] - surface[0] - surface[1]) < 1e-7
  );
  seed();
  const baselineResets = resets;
  paint(7, 20);
  const hot = await read(e.device, e.weather.surfaceBuffer);
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
  const cold = await read(e.device, e.weather.surfaceBuffer);
  check(
    'Cool removes heat using the same strength and footprint',
    cold[center + 2] < 0 && Math.abs(cold[center + 2] + hot[center + 2]) < 1e-5 && cold[2] === 0
  );
  seed(0, 0);
  paint(7, 20);
  const dry = await read(e.device, e.weather.surfaceBuffer);
  check('Deep water heats more slowly than dry ground', dry[center + 2] > hot[center + 2] * 2);
  const phase = async (type) => {
    seed();
    paint(type, 20);
    for (let i = 0; i < 10; i++) e.stepWeather(1 / 30);
    return {
      s: await read(e.device, e.weather.surfaceBuffer),
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

  seed(0.2, 0.05, 0);
  paint(10, 20);
  let clouds = await read(e.device, e.weather.surfaceBuffer);
  check(
    'Cloud painting has a soft footprint',
    clouds[center + 3] > clouds[edge + 3] && clouds[edge + 3] > 0 && clouds[3] === 0
  );
  const cloudy = clouds[center + 3];
  paint(inverseBrush(10), 5);
  clouds = await read(e.device, e.weather.surfaceBuffer);
  check(
    'Right cloud brush removes only clouds',
    clouds[center + 3] < cloudy &&
      clouds[center + 1] === surface[center + 1] &&
      (await read(e.device, current()))[center] === fluid[center]
  );
  const ground = new Float32Array(n * n * 6);
  const currentGround = () => (e.pingPongToggle ? e.terrainBufferB : e.terrainBufferA);
  for (const selected of [0, 1, 2, 9, 6, 3, 4]) {
    seed(0.2, 0.2, 0);
    for (let i = 0; i < n * n; i++) {
      ground.set([0.3, 0.2, 0.02, 0, 0.2, 0.02], i * 6);
      fluid[i * 4 + 1] = 0.2;
    }
    for (const b of [e.terrainBufferA, e.terrainBufferB]) e.device.queue.writeBuffer(b, 0, ground);
    for (const b of [e.fluidsBufferA, e.fluidsBufferB]) e.device.queue.writeBuffer(b, 0, fluid);
    const inverse = inverseBrush(selected);
    paint(inverse);
    const terrainAfter = await read(e.device, currentGround()),
      liquidAfter = await read(e.device, current()),
      frozenAfter = await read(e.device, e.weather.surfaceBuffer);
    const cell = center / 4,
      changed = [
        liquidAfter[center] < fluid[center],
        liquidAfter[center + 1] < fluid[center + 1],
        terrainAfter[cell * 6 + 1] < ground[cell * 6 + 1],
        terrainAfter[cell * 6 + 4] < ground[cell * 6 + 4],
        frozenAfter[center + 1] < surface[center + 1],
      ];
    const expected = [0, 1, 2, 9, 6].indexOf(selected);
    check(
      'Right click isolates selected material ' + selected,
      changed.every((value, i) => value === (i === expected))
    );
    if (selected === 3 || selected === 4)
      check(
        'Right click reverses terrain power ' + selected,
        selected === 3
          ? terrainAfter[cell * 6] < ground[cell * 6]
          : terrainAfter[cell * 6] > ground[cell * 6]
      );
  }
  check(
    'Thermal and destructive powers have explicit inverse actions',
    inverseBrush(7) === 8 &&
      inverseBrush(8) === 7 &&
      inverseBrush(11) === 18 &&
      inverseBrush(5) === 5
  );
  seed(0.01, 0.01, 0, 0.01);
  for (let i = 0; i < n * n; i++) {
    ground.set([0.01, 0.01, 0.01, 0, 0.01, 0.01], i * 6);
    surface[i * 4 + 3] = 0.1;
    fluid[i * 4 + 1] = 0.01;
  }
  for (const b of [e.terrainBufferA, e.terrainBufferB]) e.device.queue.writeBuffer(b, 0, ground);
  for (const b of [e.fluidsBufferA, e.fluidsBufferB]) e.device.queue.writeBuffer(b, 0, fluid);
  e.device.queue.writeBuffer(e.weather.surfaceBuffer, 0, surface);
  paint(5);
  const erasedGround = await read(e.device, currentGround()),
    erasedFluid = await read(e.device, current()),
    erasedSurface = await read(e.device, e.weather.surfaceBuffer);
  check(
    'Erase removes all material layers and clouds',
    [0, 1, 2, 4, 5].every((k) => erasedGround[(center / 4) * 6 + k] === 0) &&
      erasedFluid[center] === 0 &&
      erasedFluid[center + 1] === 0 &&
      [0, 1, 3].every((k) => erasedSurface[center + k] === 0)
  );

  seed(0, 0.05, -5, 0.05);
  paint(17);
  const snowErased = await read(e.device, e.weather.surfaceBuffer);
  check(
    'Ice eraser removes snow and ice together',
    snowErased[center] < surface[center] &&
      snowErased[center + 1] < surface[center + 1] &&
      snowErased[0] === surface[0]
  );

  // Outflow uses the actual hydraulic flux, including its accounting in the inventory.
  const totalWater = (values) => values.reduce((total, v, i) => total + (i % 4 === 0 ? v : 0), 0);
  const openRun = async (mode, lava = false) => {
    seed(lava ? 0 : 0.1, 0, 0);
    ground.fill(0);
    for (let i = 0; i < n * n; i++) {
      ground[i * 6] = 0.1;
      if (lava) fluid[i * 4 + 1] = 0.1;
      else {
        ground[i * 6 + 2] = 0.01;
        ground[i * 6 + 5] = 0.02;
      }
    }
    for (const b of [e.fluidsBufferA, e.fluidsBufferB]) e.device.queue.writeBuffer(b, 0, fluid);
    for (const b of [e.terrainBufferA, e.terrainBufferB]) e.device.queue.writeBuffer(b, 0, ground);
    const clear = e.device.createCommandEncoder();
    for (const b of [
      e.waterFluxBufferA,
      e.waterFluxBufferB,
      e.lavaFluxBufferA,
      e.lavaFluxBufferB,
      e.weather.waterExchange,
    ])
      clear.clearBuffer(b);
    e.device.queue.submit([clear.finish()]);
    config.paused = false;
    config.borderMode = mode;
    for (let i = 0; i < 50; i++) e.step();
    const endFluid = await read(e.device, current()),
      endGround = await read(e.device, currentGround());
    const sand = endGround.reduce((total, v, i) => total + ([1, 2].includes(i % 6) ? v : 0), 0),
      soil = endGround.reduce((total, v, i) => total + ([4, 5].includes(i % 6) ? v : 0), 0);
    return {
      water: totalWater(endFluid),
      lava: endFluid.reduce((total, v, i) => total + (i % 4 === 1 ? v : 0), 0),
      sand,
      soil,
      loss: (await read(e.device, e.weather.waterExchange))[2],
    };
  };
  const walls = await openRun(0),
    open = await openRun(1),
    initial = totalWater(fluid);
  check('Walls retain water', Math.abs(walls.water - initial) < 0.001 && walls.loss === 0);
  check('Passthrough drains water from the edge', open.water < walls.water && open.loss > 0);
  check(
    'Open boundary drainage matches the measured mass loss',
    Math.abs(open.loss - (((initial - open.water) * 40000) / n / n) * config.heightScale) < 0.2
  );
  check(
    'Walls conserve both suspended sediment inventories',
    Math.abs(walls.sand - n * n * 0.01) < 0.001 && Math.abs(walls.soil - n * n * 0.02) < 0.001
  );
  check(
    'Passthrough carries sand and soil out with the river',
    open.sand < walls.sand && open.soil < walls.soil
  );
  const lavaWalls = await openRun(0, true),
    lavaOpen = await openRun(1, true);
  check(
    'Passthrough drains lava while walls retain it',
    Math.abs(lavaWalls.lava - n * n * 0.1) < 0.001 && lavaOpen.lava < lavaWalls.lava
  );
  const beforeClose = lavaOpen.lava;
  config.borderMode = 0;
  for (let i = 0; i < 20; i++) e.step();
  const afterClose = (await read(e.device, current())).reduce(
    (total, v, i) => total + (i % 4 === 1 ? v : 0),
    0
  );
  check(
    'Switching back to walls immediately stops edge drainage',
    Math.abs(afterClose - beforeClose) < 0.001
  );
  check('No WebGPU validation errors', errors.length === 0);
  window.testResults = { passed: true, results };
}
run().catch((error) => {
  console.error(error);
  window.testResults = { passed: false, error: String(error), results };
});
