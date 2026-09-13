import * as THREE from 'three';
import { config } from '../src/config.ts';
import { GPGPUSimulation } from '../src/webgpuRenderer.ts';
import { COLD_BLAST, NUKE_SHOCK_SECONDS, NUKE_LIFETIME } from '../src/nuke.ts';

const results = [];
function check(name, passed) {
  results.push({ name, passed: Boolean(passed) });
  document.querySelector('#results').textContent = JSON.stringify(results, null, 2);
  if (!passed) throw new Error(name);
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
    paused: true,
    weatherEnabled: false,
    cloudOpacity: 0,
    terrainType: 1,
    flatRockHeight: 0.3,
    terrainSandHeight: 0.12,
    terrainSoilHeight: 0.12,
    thermalOverlay: false,
    erosionRate: 0,
    sedimentSlideRate: 0,
    borderMode: 0,
  });
  const n = 96;
  const radius = 24;
  const shockTicks = Math.ceil(NUKE_SHOCK_SECONDS * 60);
  const canvas = document.querySelector('canvas');
  const engine = new GPGPUSimulation(canvas, n);
  check('Production nuke shaders compile', await engine.initWebGPU());
  const errors = [];
  engine.device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  engine.step();
  engine.stepWeather(0);
  const state = () => engine.nukeState();
  const snapshot = async () =>
    Promise.all(
      state()
        .slice(0, 3)
        .map((b) => read(engine.device, b))
    );
  const seed = () => {
    engine.clearFluids();
    engine.stepWeather(0);
    const ground = new Float32Array(n * n * 6),
      fluid = new Float32Array(n * n * 4),
      frozen = new Float32Array(n * n * 4);
    for (let i = 0; i < n * n; i++) {
      ground.set([0.3, 0.12, 0.008, 0, 0.12, 0.009], i * 6);
      fluid.set([0.08, 0.025, 0.7, 0.003], i * 4);
      frozen.set([0.02, 0.015, 12, 0.1], i * 4);
    }
    for (const b of [engine.terrainBufferA, engine.terrainBufferB])
      engine.device.queue.writeBuffer(b, 0, ground);
    for (const b of [engine.fluidsBufferA, engine.fluidsBufferB])
      engine.device.queue.writeBuffer(b, 0, fluid);
    engine.device.queue.writeBuffer(engine.weather.surfaceBuffer, 0, frozen);
    return [ground, fluid, frozen];
  };
  const sum = (v, stride, channel, filter = () => true) =>
    v.reduce(
      (total, value, i) =>
        total + (i % stride === channel && filter(Math.floor(i / stride)) ? value : 0),
      0
    );
  const channels = [
    [0, 6, 0, 'rock'],
    [0, 6, 1, 'sand'],
    [0, 6, 2, 'suspended sand'],
    [0, 6, 4, 'soil'],
    [0, 6, 5, 'suspended soil'],
    [1, 4, 0, 'water'],
    [1, 4, 1, 'lava'],
    [1, 4, 3, 'steam'],
    [2, 4, 0, 'snow'],
    [2, 4, 1, 'ice'],
  ];
  const waterInventory = (s) => sum(s[1], 4, 0) + sum(s[2], 4, 0) + sum(s[2], 4, 1);
  const conserved = (before, after) =>
    channels
      .filter(([b, s, c]) => !(b === 1 && c === 0) && !(b === 2 && (c === 0 || c === 1)))
      .every(([buffer, stride, channel]) => {
        const a = sum(before[buffer], stride, channel),
          b = sum(after[buffer], stride, channel);
        return Math.abs(a - b) < Math.max(0.00001, a * 0.000002);
      }) &&
    Math.abs(waterInventory(before) - waterInventory(after)) < waterInventory(before) * 0.000002;
  const energy = ([ground, fluid, frozen]) => {
    let total = 0;
    for (let i = 0; i < n * n; i++) {
      const s = Math.max(0, ground[i * 6 + 1] + ground[i * 6 + 4]);
      const x = Math.min(1, Math.max(0, (s - 0.0001) / 0.0499));
      const capacity =
        1.5 -
        0.9 * x * x * (3 - 2 * x) +
        fluid[i * 4] * 8 +
        frozen[i * 4 + 1] * 5 +
        frozen[i * 4] * 2;
      total += capacity * frozen[i * 4 + 2] - 80 * (frozen[i * 4] + frozen[i * 4 + 1]);
    }
    return total;
  };
  const advance = (ticks) => {
    for (let i = 0; i < ticks; i++) engine.advanceNukes(1 / 60);
  };
  const before = seed();
  for (const type of [0, 2, 9, 11, COLD_BLAST]) {
    engine.setBrushPreview(new THREE.Vector2(0.5, 0.5), radius, type);
    check('Tool ' + type + ' uses the selected radius', engine.brushPreview[2] === radius / n);
  }
  engine.setBrushPreview(null, radius, 11);
  check(
    'One click starts a blast while paused',
    engine.detonateNuke(new THREE.Vector2(0.5, 0.5), radius, 1)
  );
  const heated = await snapshot();
  check('Heat pulse is deposited before transport', heated[2][(48 * n + 48) * 4 + 2] > 89);
  advance(shockTicks + 1);
  const after = await snapshot();
  check('Transport dispatch succeeds: ' + errors.join('; '), errors.length === 0);
  check('Every material inventory survives the explosion', conserved(before, after));
  check(
    'Transport and ice melting conserve sensible plus latent heat',
    Math.abs(energy(heated) - energy(after)) / energy(heated) < 0.00001
  );
  for (const [buffer, stride, channel, name] of channels) {
    if ((buffer === 0 && channel === 0) || (buffer === 2 && channel === 1)) continue;
    const inner = (i) => Math.hypot((i % n) + 0.5 - 48, Math.floor(i / n) + 0.5 - 48) < 8;
    const outer = (i) => {
      const r = Math.hypot((i % n) + 0.5 - 48, Math.floor(i / n) + 0.5 - 48);
      return r > 16 && r < 26;
    };
    check(
      'Blast pushes ' + name + ' outward',
      sum(after[buffer], stride, channel, inner) <
        sum(before[buffer], stride, channel, inner) * 0.98 &&
        sum(after[buffer], stride, channel, outer) > sum(before[buffer], stride, channel, outer)
    );
  }
  check(
    'Rock never moves or changes quantity',
    after[0].every((v, i) => i % 6 !== 0 || v === before[0][i])
  );
  const swept = (i) => Math.hypot((i % n) + 0.5 - 48, Math.floor(i / n) + 0.5 - 48) < radius * 0.7;
  const remaining = (b, s, c) => sum(after[b], s, c, swept) / sum(before[b], s, c, swept);
  check('Sand moves more than soil', remaining(0, 6, 1) < remaining(0, 6, 4));
  check(
    'Almost all liquid and melted ice leave the swept interior',
    sum(after[1], 4, 0, swept) < (sum(before[1], 4, 0, swept) + sum(before[2], 4, 1, swept)) * 0.05
  );
  check('The hot front melts ice into the conserved water inventory', remaining(2, 4, 1) < 0.01);
  check(
    'Untouched corners keep their materials',
    channels.every(([b, s, c]) => after[b][c] === before[b][c])
  );
  check(
    'All output values remain finite and inventories nonnegative',
    after.every((v, b) =>
      v.every((x, i) => Number.isFinite(x) && ((b === 2 && i % 4 === 2) || x >= 0))
    )
  );
  const momentum = await read(engine.device, state()[3]);
  check(
    'Water carries outward momentum beyond the pulse',
    momentum.some((v) => v > 0)
  );
  advance(40);
  check(
    'Mechanical impulse stops after its finite duration',
    (await snapshot()).every((v, b) => v.every((x, i) => x === after[b][i]))
  );

  for (const center of [
    [0, 0],
    [1, 1],
    [0.01, 0.5],
    [0.5, 0.99],
  ]) {
    const initial = seed();
    engine.detonateNuke(new THREE.Vector2(...center), radius, 2);
    advance(shockTicks + 1);
    check(
      'Boundary blast conserves mass at ' + center.join(','),
      conserved(initial, await snapshot())
    );
  }
  const overlapping = seed();
  engine.detonateNuke(new THREE.Vector2(0.48, 0.5), radius, 2);
  engine.detonateNuke(new THREE.Vector2(0.52, 0.5), radius * 1.5, 2, COLD_BLAST);
  advance(shockTicks + 1);
  check(
    'Overlapping hot and cold blasts conserve each material',
    conserved(overlapping, await snapshot())
  );
  seed();
  check(
    'Invalid blasts are rejected',
    !engine.detonateNuke(new THREE.Vector2(NaN, 0.5), radius, 1) &&
      !engine.detonateNuke(new THREE.Vector2(0.5, 0.5), 0, 1) &&
      !engine.detonateNuke(new THREE.Vector2(0.5, 0.5), radius, 1, 7)
  );
  engine.detonateNuke(new THREE.Vector2(0.5, 0.5), radius, 1, COLD_BLAST);
  check(
    'Right-click blast still cools the surface',
    (await snapshot())[2][(48 * n + 48) * 4 + 2] < -60
  );
  engine.clearFluids();
  check('Reset clears active explosions', engine.nukeEffects.blasts.length === 0);

  const ridgeBase = seed();
  engine.detonateNuke(new THREE.Vector2(0.5, 0.5), radius, 1);
  advance(180);
  const early = await snapshot();
  const ridgeRadius = (values) => {
    let weighted = 0,
      excess = 0;
    for (let i = 0; i < n * n; i++) {
      const amount = Math.max(0, values[0][i * 6 + 4] - ridgeBase[0][i * 6 + 4]);
      weighted += amount * Math.hypot((i % n) + 0.5 - 48, Math.floor(i / n) + 0.5 - 48);
      excess += amount;
    }
    return weighted / excess;
  };
  advance(300);
  const later = await snapshot();
  check(
    'A ridge of displaced soil travels outward with the slow wave',
    ridgeRadius(later) > ridgeRadius(early) + 3
  );
  check(
    'The traveling ridge is conserved soil, never added terrain',
    conserved(ridgeBase, early) && conserved(ridgeBase, later)
  );
  check(
    'The cinematic cloud and pressure remain active after eight seconds',
    engine.nukeEffects.blasts[0].age > 7.9 && NUKE_SHOCK_SECONDS > 8 && NUKE_LIFETIME > 30
  );

  const timedRun = async (fps) => {
    seed();
    engine.detonateNuke(new THREE.Vector2(0.5, 0.5), radius, 1);
    for (let i = 0; i < fps; i++) engine.advanceNukes(1 / fps);
    return snapshot();
  };
  const slowFrames = await timedRun(30),
    fastFrames = await timedRun(120);
  check(
    'Blast transport is independent of frame rate',
    slowFrames.every((v, b) => v.every((x, i) => x === fastFrames[b][i]))
  );

  // Exercise both ping-pong states with ordinary simulation steps between impulses.
  seed();
  const bare = new Float32Array(n * n * 4);
  for (const buffer of [engine.fluidsBufferA, engine.fluidsBufferB, engine.weather.surfaceBuffer])
    engine.device.queue.writeBuffer(buffer, 0, bare);
  config.paused = false;
  const beforeResume = await snapshot();
  engine.detonateNuke(new THREE.Vector2(0.5, 0.5), radius, 1);
  for (let i = 0; i < 90; i++) {
    engine.step();
    engine.advanceNukes(1 / 60);
  }
  const afterResume = await snapshot();
  check(
    'Normal simulation preserves blast edits across ping-pong swaps',
    [[0], [1, 2], [4, 5]].every((components) => {
      const beforeTotal = components.reduce((total, c) => total + sum(beforeResume[0], 6, c), 0);
      const afterTotal = components.reduce((total, c) => total + sum(afterResume[0], 6, c), 0);
      return Math.abs(beforeTotal - afterTotal) < beforeTotal * 0.00001;
    })
  );
  config.paused = true;

  const camera = new THREE.PerspectiveCamera(50, canvas.width / canvas.height, 0.1, 1000);
  camera.position.set(150, 145, 185);
  camera.lookAt(0, 20, 0);
  camera.updateMatrixWorld();
  const visualSeed = () => {
    seed();
    const fluid = new Float32Array(n * n * 4),
      frozen = new Float32Array(n * n * 4);
    for (let i = 0; i < n * n; i++) fluid[i * 4] = 0.12;
    for (const b of [engine.fluidsBufferA, engine.fluidsBufferB])
      engine.device.queue.writeBuffer(b, 0, fluid);
    engine.device.queue.writeBuffer(engine.weather.surfaceBuffer, 0, frozen);
  };
  for (const cold of [false, true]) {
    visualSeed();
    engine.detonateNuke(new THREE.Vector2(0.5, 0.5), radius, 1, cold ? COLD_BLAST : 11);
    for (const ticks of [60, 300, 480, 900, 1000]) {
      advance(ticks);
      engine.render(camera);
      await engine.device.queue.onSubmittedWorkDone();
    }
    check('Animation expires: ' + (cold ? 'cold' : 'hot'), engine.nukeEffects.blasts.length === 0);
    check(
      'Expired effects release scratch storage: ' + cold,
      engine.nukeEffects.scratchCells === 0
    );
  }
  visualSeed();
  for (let i = 0; i < 12; i++) engine.detonateNuke(new THREE.Vector2(0.5, 0.5), radius, 1);
  check('Rapid clicks have bounded effect resources', engine.nukeEffects.blasts.length === 8);
  advance(1);
  engine.render(camera);
  await engine.device.queue.onSubmittedWorkDone();
  visualSeed();
  engine.detonateNuke(new THREE.Vector2(0.5, 0.5), radius, 1);
  advance(420);
  engine.render(camera);
  await engine.device.queue.onSubmittedWorkDone();
  check(
    'Production rendering and transport produce no GPU validation errors',
    errors.length === 0 && engine.resourcesReady
  );
  window.nukePreview = { engine, camera, advance, visualSeed, config, snapshot, waterInventory };
  window.testResults = { passed: true, results };
}
run().catch((error) => {
  console.error(error);
  window.testResults = { passed: false, error: String(error), results };
  document.querySelector('#results').textContent = JSON.stringify(window.testResults, null, 2);
});
