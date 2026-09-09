import terrainShader from '../src/shaders/simTerrain.wgsl?raw';
import { config } from '../src/config.ts';
import { GPGPUSimulation } from '../src/webgpuRenderer.ts';
import * as THREE from 'three';

const results = [];
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
  const values = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return values;
}
const sum = (values, ...offsets) => {
  let total = 0;
  for (let i = 0; i < values.length; i += 6) {
    for (const offset of offsets) total += values[i + offset];
  }
  return total;
};
const close = (a, b) => Math.abs(a - b) < 2e-6 * Math.max(1, Math.abs(b));

async function run() {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const n = 32,
    center = 16 * n + 16,
    c = center * 6;
  const make = (size) =>
    device.createBuffer({
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
  const input = make(n * n * 24),
    output = make(n * n * 24);
  const fluids = make(n * n * 16),
    flux = make(n * n * 16);
  const uniforms = device.createBuffer({
    size: 160,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const module = device.createShaderModule({ code: terrainShader });
  const info = await module.getCompilationInfo();
  check(
    'Terrain shader compiles',
    !info.messages.some((m) => m.type === 'error'),
    info.messages.map((m) => m.message).join('\n')
  );
  const pipeline = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [uniforms, input, output, fluids, flux].map((buffer, binding) => ({
      binding,
      resource: { buffer },
    })),
  });
  const u = new Float32Array(40),
    ground = new Float32Array(n * n * 6);
  const liquid = new Float32Array(n * n * 4),
    flow = new Float32Array(liquid.length);
  function seed() {
    u.fill(0);
    ground.fill(0);
    liquid.fill(0);
    flow.fill(0);
    u[0] = n;
    u[6] = config.sandStaticReposeSlope;
    u[7] = config.sandDynamicReposeSlope;
    u[8] = config.erosionRate;
    u[9] = config.capacityFactor;
    u[10] = config.depositionRate;
    u[12] = 1;
    u[36] = config.soilStaticReposeSlope;
    u[37] = config.soilDynamicReposeSlope;
    for (let i = 0; i < n * n; i++) {
      ground[i * 6] = 0.1;
      liquid[i * 4] = 1;
    }
  }
  async function step(values = ground) {
    device.queue.writeBuffer(uniforms, 0, u);
    device.queue.writeBuffer(input, 0, values);
    device.queue.writeBuffer(fluids, 0, liquid);
    device.queue.writeBuffer(flux, 0, flow);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(n / 16, n / 16);
    pass.end();
    device.queue.submit([encoder.finish()]);
    return read(device, output);
  }
  seed();
  ground[c + 1] = 0.3;
  flow[center * 4 + 1] = 0.5;
  const sand = await step(),
    sandErosion = sum(sand, 2);
  seed();
  ground[c + 4] = 0.3;
  flow[center * 4 + 1] = 0.5;
  const soil = await step(),
    soilErosion = sum(soil, 5);
  check(
    'Moving water erodes sand and soil at exactly the same rate',
    soilErosion > 0 && sandErosion === soilErosion,
    `sand=${sandErosion}, soil=${soilErosion}`
  );
  check(
    'Erosion preserves each material and never erodes rock',
    close(sum(sand, 1, 2), 0.3) &&
      close(sum(soil, 4, 5), 0.3) &&
      close(sum(soil, 0), sum(ground, 0))
  );
  seed();
  ground[c + 1] = 0.1;
  ground[c + 4] = 0.3;
  flow[center * 4 + 1] = 0.5;
  let state = await step();
  check(
    'Overlying sand shields soil from erosion',
    sum(state, 2) > 0 && sum(state, 5) === 0 && state[c + 4] === ground[c + 4]
  );
  ground[c + 1] = 0.00001;
  state = await step();
  check(
    'Water reaches soil after stripping the last thin sand layer',
    state[c + 1] === 0 && sum(state, 5) > 0
  );

  for (const water of [0, 1]) {
    seed();
    ground[c + 2] = 0.02;
    ground[c + 5] = 0.03;
    liquid[center * 4] = water;
    state = await step();
    check(
      `${water ? 'Still water' : 'Drying'} deposits sand and soil into separate ground layers`,
      close(state[c + 1], 0.02) && close(state[c + 4], 0.03) && sum(state, 2, 5) === 0
    );
  }
  seed();
  u[8] = 0;
  u[10] = 0;
  ground[c + 2] = 0.001;
  ground[c + 5] = 0.002;
  flow[center * 4 + 1] = 0.5;
  state = await step();
  check(
    'The current carries both sediment identities to the downstream cell',
    close(state[c + 6 + 2], 0.0005) &&
      close(state[c + 6 + 5], 0.001) &&
      close(sum(state, 1, 2), 0.001) &&
      close(sum(state, 4, 5), 0.002)
  );
  seed();
  u[10] = 1;
  ground[c + 2] = 0.01;
  ground[c + 5] = 0.02;
  flow[center * 4 + 1] = 0.5;
  state = await step();
  check(
    'Sand and soil share one carrying capacity',
    close(sum(state, 2, 5), 0.025) && close(sum(state, 1, 2), 0.01) && close(sum(state, 4, 5), 0.02)
  );

  seed();
  liquid.fill(0);
  u[5] = config.sedimentSlideRate;
  const comparisonSlope = (u[6] + u[36]) / 2;
  ground[c + 4] = comparisonSlope;
  state = await step();
  check('Soil retains a steep face below its repose threshold', state[c + 4] === ground[c + 4]);
  ground[c + 4] = 0;
  ground[c + 1] = comparisonSlope;
  state = await step();
  check(
    'Sand avalanches at the same slope',
    state[c + 1] < ground[c + 1] && close(sum(state, 1), comparisonSlope)
  );
  ground[c + 1] = 0;
  ground[c + 4] = 0.25;
  state = await step();
  check(
    'An oversteep soil face collapses without losing soil',
    state[c + 4] < 0.25 && close(sum(state, 4), 0.25)
  );

  // A soil pile between its two thresholds stays still until an avalanche has
  // started. Once active, it keeps moving toward the lower dynamic threshold.
  seed();
  liquid.fill(0);
  u[5] = config.sedimentSlideRate;
  u[6] = u[36] = 0.08;
  u[7] = u[37] = 0.02;
  ground[c + 4] = 0.05;
  state = await step();
  check(
    'Resting soil between static and dynamic angles remains stable',
    state[c + 4] === ground[c + 4] && state[c + 3] === 0
  );
  ground[c + 3] = 2;
  state = await step();
  check(
    'An active soil avalanche continues below its static angle',
    state[c + 4] < ground[c + 4] && state[c + 3] === 2
  );
  ground[c + 4] = 0.01;
  state = await step();
  check(
    'A soil avalanche stops below its dynamic angle',
    state[c + 4] === ground[c + 4] && state[c + 3] === 0
  );
  ground[c + 1] = 0.01;
  ground[c + 4] = 0.04;
  state = await step();
  check(
    'Soil sliding does not trigger a sand avalanche',
    state[c + 4] < ground[c + 4] && state[c + 1] === ground[c + 1] && (state[c + 3] & 1) === 0
  );
  ground[c + 3] = 1;
  state = await step();
  check(
    'Sand sliding does not trigger a soil avalanche',
    state[c + 1] < ground[c + 1] && state[c + 4] === ground[c + 4] && (state[c + 3] & 2) === 0
  );

  // Swap the material identity on the same landscape, keeping every other
  // condition fixed. Matching angles must produce matching evolution.
  for (const wet of [false, true]) {
    seed();
    if (!wet) liquid.fill(0);
    u[5] = config.sedimentSlideRate;
    u[36] = u[6];
    u[37] = u[7];
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        ground[i * 6] = 0.1 + ((x + 3 * y) % 5) * 0.002;
        ground[i * 6 + 1] = ((7 * x + y) % 9) * 0.013;
        ground[i * 6 + 2] = wet ? ((x + y) % 3) * 0.001 : 0;
        if (wet) {
          flow[i * 4] = x > 0 ? 0.2 : 0;
          flow[i * 4 + 1] = x + 1 < n ? 0.25 : 0;
          flow[i * 4 + 2] = y > 0 ? 0.1 : 0;
          flow[i * 4 + 3] = y + 1 < n ? 0.15 : 0;
        }
      }
    let sandState = new Float32Array(ground),
      soilState = new Float32Array(ground);
    for (let i = 0; i < soilState.length; i += 6) {
      soilState[i + 4] = soilState[i + 1];
      soilState[i + 1] = 0;
      soilState[i + 5] = soilState[i + 2];
      soilState[i + 2] = 0;
    }
    for (let tick = 0; tick < 30; tick++) {
      u[20] = tick / 60;
      sandState = await step(sandState);
      soilState = await step(soilState);
    }
    let difference = 0;
    for (let i = 0; i < soilState.length; i += 6) {
      difference = Math.max(
        difference,
        Math.abs(sandState[i + 1] - soilState[i + 4]),
        Math.abs(sandState[i + 2] - soilState[i + 5]),
        Math.abs((sandState[i + 3] & 1) - ((soilState[i + 3] >> 1) & 1))
      );
    }
    check(
      `Matching angles give identical sand and soil physics ${wet ? 'with water' : 'on dry ground'}`,
      difference === 0,
      `largest difference=${difference}`
    );
  }

  for (const boundary of [0, 2]) {
    seed();
    u[24] = boundary;
    u[5] = config.sedimentSlideRate;
    u[8] = 1;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        ground[i * 6 + 1] = ((x * 7 + y) % 11) * 0.001;
        ground[i * 6 + 4] = ((x + y * 3) % 7) * 0.04;
        ground[i * 6 + 2] = x % 5 === 0 ? 0.002 : 0;
        ground[i * 6 + 5] = y % 5 === 0 ? 0.003 : 0;
        flow[i * 4] = x > 0 ? 0.2 : 0;
        flow[i * 4 + 1] = x + 1 < n ? 0.25 : 0;
        flow[i * 4 + 2] = y > 0 ? 0.1 : 0;
        flow[i * 4 + 3] = y + 1 < n ? 0.15 : 0;
      }
    state = ground;
    for (let i = 0; i < 30; i++) state = await step(state);
    check(
      `${boundary === 0 ? 'Closed' : 'Water-only'} borders conserve sand and soil through concurrent erosion, slides and transport`,
      close(sum(state, 1, 2), sum(ground, 1, 2)) &&
        close(sum(state, 4, 5), sum(ground, 4, 5)) &&
        state.every((v) => Number.isFinite(v) && v >= 0)
    );
  }
  seed();
  u[24] = 1;
  ground[2] = 0.01;
  ground[5] = 0.02;
  flow[1] = 0.5;
  state = await step();
  check(
    'Open borders drain both suspended materials',
    sum(state, 1, 2) < 0.01 && sum(state, 4, 5) < 0.02
  );
  check('No terrain GPU validation errors', errors.length === 0, errors.join('\n'));
  device.destroy();

  Object.assign(config, {
    terrainType: 1,
    flatRockHeight: 0.1,
    terrainSoilHeight: 0.15,
    terrainSandHeight: 0.05,
    atmosphereEnabled: false,
    paused: false,
    showClouds: false,
  });
  const engine = new GPGPUSimulation(document.querySelector('canvas'), 96);
  check('Full engine compiles all six-channel terrain consumers', await engine.initWebGPU());
  const engineErrors = [];
  engine.device.addEventListener('uncapturederror', (event) =>
    engineErrors.push(event.error.message)
  );
  engine.step();
  const current = () => (engine.pingPongToggle ? engine.terrainBufferB : engine.terrainBufferA);
  const generated = await read(engine.device, current());
  check(
    'Generated cells contain rock, soil and sand with empty suspended reservoirs',
    generated.every((v, i) => close(v, [0.1, 0.05, 0, 0, 0.15, 0][i % 6]))
  );
  config.paused = true;
  engine.setBrush(true, new THREE.Vector2(0.5, 0.5), 9, 12, 1);
  engine.step();
  let painted = await read(engine.device, current());
  const middle = (48 * 96 + 48) * 6;
  check(
    'Soil brush adds beneath existing sand while paused',
    painted[middle + 4] > generated[middle + 4] &&
      painted[middle + 1] === generated[middle + 1] &&
      painted[middle] === generated[middle] &&
      painted[4] === generated[4]
  );
  engine.setBrush(true, new THREE.Vector2(0.5, 0.5), 5, 12, 0.5);
  engine.step();
  const erased = await read(engine.device, current());
  check(
    'Erase removes upper sand before soil',
    erased[middle + 1] < painted[middle + 1] && erased[middle + 4] === painted[middle + 4]
  );
  engine.step();
  painted = await read(engine.device, current());
  check(
    'Erase reaches soil once the sand is gone',
    painted[middle + 1] === 0 &&
      painted[middle + 4] < erased[middle + 4] &&
      painted[middle] === generated[middle]
  );
  engine.setBrush(false, null, 9, 12, 1);
  // A changing soil thickness must raise the hydraulic bed, just like rock/sand.
  const lake = new Float32Array(96 * 96 * 4);
  const bed = new Float32Array(generated);
  for (let y = 0; y < 96; y++) {
    for (let x = 0; x < 96; x++) {
      const i = y * 96 + x;
      bed[i * 6 + 4] = 0.15 + 0.05 * Math.sin((x * 2 * Math.PI) / 96);
      lake[i * 4] = 0.7 - bed[i * 6] - bed[i * 6 + 1] - bed[i * 6 + 4];
    }
  }
  for (const buffer of [engine.terrainBufferA, engine.terrainBufferB]) {
    engine.device.queue.writeBuffer(buffer, 0, bed);
  }
  for (const buffer of [engine.fluidsBufferA, engine.fluidsBufferB]) {
    engine.device.queue.writeBuffer(buffer, 0, lake);
  }
  Object.assign(config, {
    paused: false,
    erosionRate: 0,
    sedimentSlideRate: 0,
  });
  for (let i = 0; i < 50; i++) engine.step();
  const restingLake = await read(
    engine.device,
    engine.pingPongToggle ? engine.fluidsBufferB : engine.fluidsBufferA
  );
  check(
    'A level lake remains at rest above a nonuniform soil bed',
    restingLake.every((v, i) => Math.abs(v - lake[i]) < 2e-6)
  );
  engine.stepAtmosphere(0);
  const columns = await read(engine.device, engine.atmosphere.columns);
  check(
    'Atmospheric columns include soil in their surface elevation',
    columns.every((v, i) => i % 4 !== 0 || close(v, 0.7 * config.heightScale))
  );
  const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 1000);
  camera.position.set(185, 155, 215);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  engine.render(camera);
  config.thermalOverlay = true;
  engine.render(camera);
  config.thermalOverlay = false;
  // Leave exposed rock, brown soil and sandy soil visible for visual inspection.
  engine.clearFluids();
  for (let y = 0; y < 96; y++) {
    for (let x = 0; x < 96; x++) {
      const i = (y * 96 + x) * 6;
      bed[i + 1] = x >= 64 ? 0.05 : 0;
      bed[i + 4] = x >= 32 ? 0.15 : 0;
    }
  }
  engine.device.queue.writeBuffer(current(), 0, bed);
  engine.render(camera);
  await engine.device.queue.onSubmittedWorkDone();
  check(
    'Full engine renders soil without WebGPU validation errors',
    engineErrors.length === 0,
    engineErrors.join('\n')
  );
  window.testResults = { passed: true, results };
}
run().catch((error) => {
  console.error(error);
  window.testResults = { passed: false, error: String(error), results };
});
