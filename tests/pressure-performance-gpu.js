import * as THREE from 'three';
import { config } from '../src/config.ts';
import { GPGPUSimulation } from '../src/webgpuRenderer.ts';
import {
  referenceSwitch as pressureReferenceSwitch,
  PassClock,
  readBuffers,
  difference,
  summarize,
} from './pressure-cache-utils.js';

const transport = document.documentElement.dataset.optimization === 'transport';
const surfaceExchange = document.documentElement.dataset.optimization === 'surface-exchange';
const localOnly = document.documentElement.dataset.transportBaseline === 'local';
const { transportReferenceSwitch } = transport ? await import('./transport-utils.js') : {};
const { surfaceExchangeReferenceSwitch } = surfaceExchange
  ? await import('./surface-exchange-utils.js')
  : {};
const referenceSwitch = surfaceExchange
  ? surfaceExchangeReferenceSwitch
  : transport
    ? (...args) => transportReferenceSwitch(...args, { localOnly })
    : pressureReferenceSwitch;

const results = [];
const report = document.querySelector('#results');
function check(name, passed, detail) {
  results.push({ name, passed: !!passed, detail });
  report.textContent = JSON.stringify(results, null, 2);
  if (!passed) throw new Error(`${name}: ${JSON.stringify(detail)}`);
}

async function run() {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  check(
    'Hardware GPU and timestamp queries available',
    adapter && adapter.features.has('timestamp-query') && !adapter.info.isFallbackAdapter,
    {
      vendor: adapter?.info.vendor,
      architecture: adapter?.info.architecture,
      device: adapter?.info.device,
      description: adapter?.info.description,
    }
  );
  // Request timestamps only in this benchmark, without changing the application.
  const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
  const requestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = (descriptor) =>
    requestDevice({ ...descriptor, requiredFeatures: ['timestamp-query'] });
  navigator.gpu.requestAdapter = async () => adapter;
  Object.assign(config, {
    gridSize: 2048,
    renderResolution: 1,
    simSpeed: 1,
    atmosphereTimeScale: 4,
    paused: false,
    atmosphereEnabled: true,
    atmosphereBoundary: 0,
    closedWaterCycle: true,
    emergentWeather: true,
    windSpeed: 8,
    relativeHumidity: 0.9,
    airTemperature: 8,
    showClouds: true,
    showWind: false,
    thermalOverlay: false,
    atmosphereView: 0,
  });
  const sim = new GPGPUSimulation(document.querySelector('#preview'), config.gridSize);
  try {
    check('Renderer initialized', await sim.initWebGPU());
  } finally {
    navigator.gpu.requestAdapter = requestAdapter;
    adapter.requestDevice = requestDevice;
  }
  const device = sim.device;
  const errors = [];
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const camera = new THREE.PerspectiveCamera(50, 1280 / 720, 0.1, 1000);
  camera.position.set(185, 155, 215);
  camera.lookAt(0, 35, 0);
  camera.updateMatrixWorld();
  sim.seed = 123.456;
  sim.step();
  const water = new Float32Array(2048 * 2048 * 4);
  for (let y = 600; y < 1450; y++)
    for (let x = 600; x < 1450; x++) {
      if ((x - 1024) ** 2 + (y - 1024) ** 2 < 400 ** 2) water[(y * 2048 + x) * 4] = 0.4;
    }
  device.queue.writeBuffer(sim.fluidsBufferA, 0, water);
  device.queue.writeBuffer(sim.fluidsBufferB, 0, water);
  sim.stepAtmosphere(0);
  const toggle = await referenceSwitch(device, sim.atmosphere, [
    [sim.terrainBufferA, sim.fluidsBufferA],
    [sim.terrainBufferB, sim.fluidsBufferB],
  ]);
  const clock = new PassClock(device);
  const frame = () => {
    clock.phase = 'surface';
    sim.step();
    clock.phase = 'weather';
    sim.stepAtmosphere(1 / 30);
    sim.stepAtmosphere(1 / 30);
    clock.phase = 'render';
    sim.render(camera);
  };
  const buffers = [
    sim.terrainBufferA,
    sim.terrainBufferB,
    sim.fluidsBufferA,
    sim.fluidsBufferB,
    sim.waterFluxBufferA,
    sim.waterFluxBufferB,
    sim.lavaFluxBufferA,
    sim.lavaFluxBufferB,
    ...sim.atmosphere.volumes,
    sim.atmosphere.surfaceBuffer,
  ];
  const copies = [];
  try {
    // Warm both pipeline variants; snapshots are made only after initialization.
    for (let i = 0; i < 24; i++) {
      toggle(i % 2 === 0);
      frame();
      if (i % 4 === 3) await device.queue.onSubmittedWorkDone();
    }
    if (surfaceExchange) {
      // Measure the occasional rebuild separately; ordinary frames reuse it.
      toggle(false);
      sim.atmosphere.surfaceMappingBoundary = -1;
      clock.start();
      frame();
      const rebuildingFrame = await clock.end();
      const preparationMs = rebuildingFrame['Atmosphere prepareSurfaceMapping'];
      check('Mapping rebuild captured', Number.isFinite(preparationMs) && preparationMs >= 0, {
        preparationMs,
        frameMs: rebuildingFrame.totalSpanMs,
        extraBytes: config.gridSize * 32,
        rebuild: 'Once at initialization and on horizontal boundary changes',
      });
    }
    const snapshotEncoder = device.createCommandEncoder();
    buffers.forEach((buffer) => {
      const copy = device.createBuffer({
        size: buffer.size,
        usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });
      snapshotEncoder.copyBufferToBuffer(buffer, 0, copy, 0, buffer.size);
      copies.push(copy);
    });
    device.queue.submit([snapshotEncoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    const times = {
      time: sim.time,
      current: sim.atmosphere.current,
      atmosphere: sim.atmosphere.simulationTime,
      pingPong: sim.pingPongToggle,
    };
    async function restore() {
      const encoder = device.createCommandEncoder();
      buffers.forEach((buffer, i) =>
        encoder.copyBufferToBuffer(copies[i], 0, buffer, 0, buffer.size)
      );
      device.queue.submit([encoder.finish()]);
      sim.time = times.time;
      sim.atmosphere.current = times.current;
      sim.atmosphere.simulationTime = times.atmosphere;
      sim.pingPongToggle = times.pingPong;
      await device.queue.onSubmittedWorkDone();
    }
    // Check the actual coupled frame as well as the isolated atmosphere suite.
    const states = [];
    for (const reference of [true, false]) {
      await restore();
      toggle(reference);
      frame();
      states.push(
        await readBuffers(device, [
          sim.atmosphere.volumeBuffer,
          sim.atmosphere.pressureBuffer,
          sim.atmosphere.surfaceBuffer,
          sim.pingPongToggle ? sim.fluidsBufferB : sim.fluidsBufferA,
          sim.pingPongToggle ? sim.terrainBufferB : sim.terrainBufferA,
        ])
      );
    }
    const comparisons = states[0].map((data, i) => ({
      field: ['air', 'pressure', 'surface', 'fluids', 'terrain'][i],
      ...difference(data, states[1][i]),
    }));
    check(
      '2048² coupled frame is bit-identical',
      comparisons.every((d) => d.mismatches === 0 && d.finite),
      comparisons
    );
    const samples = { reference: [], optimized: [] };
    for (let round = 0; round < 40; round++) {
      // Alternate order to limit systematic warm-cache and clock drift bias.
      for (const reference of round % 2 ? [false, true] : [true, false]) {
        await restore();
        toggle(reference);
        clock.start();
        const start = performance.now();
        frame();
        const cpuEncodingMs = performance.now() - start;
        const sample = await clock.end();
        samples[reference ? 'reference' : 'optimized'].push({ ...sample, cpuEncodingMs });
      }
      if (round % 10 === 9) report.textContent = `Benchmark ${round + 1}/40 paired samples…`;
    }
    const summary = {
      reference: summarize(samples.reference),
      optimized: summarize(samples.optimized),
    };
    check('Benchmark captured', true, {
      gpu: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        description: adapter.info.description,
      },
      userAgent: navigator.userAgent,
      surface: [2048, 2048],
      atmosphere: sim.atmosphere.dimensions,
      canvas: [1280, 720],
      meshResolution: config.renderResolution,
      windSpeed: config.windSpeed,
      relativeHumidity: config.relativeHumidity,
      seed: sim.seed,
      samplesPerArm: 40,
      workload:
        'One surface tick + two 1/30 s weather ticks + terrain, fluids and clouds rendering; same GPU snapshot restored before each frame',
      summary,
      samples,
      optimization: surfaceExchange
        ? 'Surface mapping table (optimizations 1 and 2 retained in both arms)'
        : transport
          ? localOnly
            ? 'Courant cache only (shared transport and pressure cache retained in both arms)'
            : 'transport (pressure cache retained in both arms)'
          : 'pressure cache',
    });
    // Uninstrumented saturated throughput includes CPU submission and GPU work.
    const throughput = { reference: [], optimized: [] };
    for (let round = 0; round < 4; round++)
      for (const reference of round % 2 ? [false, true] : [true, false]) {
        await restore();
        toggle(reference);
        const start = performance.now();
        for (let i = 0; i < 60; i++) {
          frame();
          if (i % 4 === 3) await device.queue.onSubmittedWorkDone();
        }
        await device.queue.onSubmittedWorkDone();
        const elapsedMs = performance.now() - start;
        throughput[reference ? 'reference' : 'optimized'].push({
          frameMs: elapsedMs / 60,
          framesPerSecond: 60000 / elapsedMs,
          weatherSpeed: 4000 / elapsedMs,
        });
      }
    check('Uninstrumented throughput captured', true, {
      workload:
        '60 fixed-work frames, queue drained every four frames; throughput, not requestAnimationFrame FPS',
      reference: summarize(throughput.reference),
      optimized: summarize(throughput.optimized),
      samples: throughput,
    });
    // Also replay the real fixed-clock/catch-up schedule. Account for outstanding
    // GPU work at the end instead of mistaking queued simulation time for speed.
    const realtime = { reference: [], optimized: [] };
    for (const reference of [true, false, false, true]) {
      await restore();
      toggle(reference);
      let surfaceAccumulator = 0,
        weatherAccumulator = 0,
        last = 0,
        frames = 0;
      let surfaceTicks = 0,
        weatherTicks = 0;
      const frameIntervals = [];
      const start = performance.now();
      await new Promise((resolve, reject) => {
        const animate = (now) => {
          try {
            if (now - start >= 8000) {
              resolve();
              return;
            }
            if (last) frameIntervals.push(now - last);
            const elapsed = last ? Math.min((now - last) / 1000, 0.1) : 1 / 60;
            last = now;
            surfaceAccumulator = Math.min(surfaceAccumulator + elapsed * 60, 8);
            while (surfaceAccumulator >= 1) {
              sim.step();
              surfaceAccumulator--;
              surfaceTicks++;
            }
            weatherAccumulator = Math.min(weatherAccumulator + elapsed * 4, 4 / 30);
            let steps = 0;
            while (weatherAccumulator >= 1 / 30) {
              sim.stepAtmosphere(1 / 30);
              weatherAccumulator -= 1 / 30;
              weatherTicks++;
              steps++;
            }
            if (!steps) sim.stepAtmosphere(0);
            sim.render(camera);
            sim.sampleWaterBudget();
            frames++;
            requestAnimationFrame(animate);
          } catch (error) {
            reject(error);
          }
        };
        requestAnimationFrame(animate);
      });
      const submittedAt = performance.now();
      await device.queue.onSubmittedWorkDone();
      const finishedAt = performance.now();
      realtime[reference ? 'reference' : 'optimized'].push({
        framesPerSecond: (frames * 1000) / (submittedAt - start),
        frameIntervalP95Ms: summarize(frameIntervals.map((frameMs) => ({ frameMs }))).frameMs.p95,
        surfaceSpeedCompleted: surfaceTicks / 60 / ((finishedAt - start) / 1000),
        weatherSpeedCompleted: weatherTicks / 30 / ((finishedAt - start) / 1000),
        drainMs: finishedAt - submittedAt,
        frames,
        surfaceTicks,
        weatherTicks,
      });
    }
    check('Realtime clock replay captured', true, {
      workload:
        'Four 8-second requestAnimationFrame runs in ABBA order, production catch-up limits, water budget enabled; completed speeds include final GPU drain',
      reference: summarize(realtime.reference),
      optimized: summarize(realtime.optimized),
      samples: realtime,
    });
    check('No WebGPU validation errors', errors.length === 0 && sim.resourcesReady, errors);
  } finally {
    copies.forEach((copy) => copy.destroy());
    clock.destroy();
    device.destroy();
  }
}
run()
  .then(() => {
    window.testResults = { passed: true, results };
  })
  .catch((error) => {
    window.testResults = { passed: false, results, error: String(error) };
    report.textContent = JSON.stringify(window.testResults, null, 2);
  });
