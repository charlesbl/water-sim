import { terrainFixture } from './terrain-fixture.js';
import { config } from '../src/config.ts';
import { AtmosphereSimulation, ATMOSPHERE_DIMENSIONS } from '../src/atmosphere.ts';

const results = [];
const [nx, ny, nz] = ATMOSPHERE_DIMENSIONS;
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
  const data = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return data;
}
function seamRatio(profile, coarse) {
  let jumps = 0,
    seams = 0,
    count = 0;
  for (let i = 1; i < profile.length; i++) {
    const jump = Math.abs(profile[i] - profile[i - 1]);
    jumps += jump;
    if (
      Math.floor((i * coarse) / profile.length) !== Math.floor(((i - 1) * coarse) / profile.length)
    ) {
      seams += jump;
      count++;
    }
  }
  return seams / count / (jumps / (profile.length - 1));
}

async function run() {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  check('WebGPU adapter available', adapter);
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  Object.assign(config, {
    atmosphereEnabled: true,
    closedWaterCycle: true,
    emergentWeather: true,
    relativeHumidity: 0,
    windSpeed: 0,
    convectionStrength: 0,
    solarHeating: 0,
    radiativeCooling: 0,
    evaporationRate: 0,
    heightScale: 18,
  });
  // Exercise undersampling, non-divisible footprints and several fine cells per
  // column. The latter reproduces the visible blocks of the production 2048 grid.
  for (const n of [49, 257, 769, 2048]) {
    const make = (bytes = n * n * 16) =>
      device.createBuffer({
        size: bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });
    const terrain = make(n * n * 24),
      fluids = make();
    const ground = new Float32Array(n * n * 4);
    const liquid = new Float32Array(ground.length);
    const surface = new Float32Array(ground.length);
    const air = new Float32Array(nx * ny * nz * 8);
    const sim = new AtmosphereSimulation(device, n);
    await sim.init();
    const step = (dt) => {
      const encoder = device.createCommandEncoder();
      sim.step(encoder, terrain, fluids, dt);
      device.queue.submit([encoder.finish()]);
    };
    step(0);
    const seed = () => {
      device.queue.writeBuffer(terrain, 0, terrainFixture(ground));
      device.queue.writeBuffer(fluids, 0, liquid);
      device.queue.writeBuffer(sim.surfaceBuffer, 0, surface);
      sim.reset(false);
      step(0); // Refresh boundary weights, columns and bindings before replacing the air.
      device.queue.writeBuffer(sim.volumeBuffer, 0, air);
    };
    // Isolate the production heat passes so water phases, atmospheric transport
    // and radiation cannot hide an incorrect air credit or double-counted edge.
    const heatOnly = (dt = 0.1) => {
      device.queue.writeBuffer(sim.uniforms, 28, new Float32Array([dt]));
      const groups = sim.bindings(terrain, fluids);
      const encoder = device.createCommandEncoder();
      for (const [name, group, x, y] of [
        ['prepareHeat', groups.prepareHeat[sim.current], Math.ceil(nx / 8), Math.ceil(ny / 8)],
        ['exchangeHeat', groups.exchangeHeat, Math.ceil(n / 16), Math.ceil(n / 16)],
        ['gatherHeat', groups.gatherHeat, nx, ny],
      ]) {
        const pass = encoder.beginComputePass();
        pass.setPipeline(sim.pipelines[name]);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(x, y);
        pass.end();
      }
      device.queue.submit([encoder.finish()]);
    };
    for (const boundary of [0, 1]) {
      config.atmosphereBoundary = boundary;
      // Mixed materials, heat flow in both directions and unequal border
      // temperatures expose wrong capacity factors and wrong heat recipients.
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const i = (y * n + x) * 4;
          ground[i] = 0.1;
          ground[i + 1] = (x + y) % 3 === 0 ? 0.05 : 0;
          liquid[i] = x % 2 === 0 ? 0.2 : 0;
          surface[i] = y % 3 === 0 ? 0.001 : 0;
          surface[i + 1] = x % 3 === 0 ? 0.03 : 0;
          surface[i + 2] = 15 * Math.sin(x * 0.13) * Math.cos(y * 0.17);
        }
      for (let z = 0; z < nz; z++)
        for (let y = 0; y < ny; y++)
          for (let x = 0; x < nx; x++) {
            air[((z * ny + y) * nx + x) * 8 + 3] = -12 + (20 * x) / (nx - 1) + 4 * Math.cos(y);
          }
      seed();
      heatOnly();
      const heated = await read(device, sim.surfaceBuffer);
      const credits = await read(device, sim.surfaceHeat);
      let debit = 0,
        exchanged = 0;
      for (let i = 0; i < heated.length; i += 4) {
        const capacity =
          (ground[i + 1] > 0 ? 0.6 : 1.5) + 8 * liquid[i] + 5 * surface[i + 1] + 2 * surface[i];
        const energy = capacity * (surface[i + 2] - heated[i + 2]);
        debit += energy;
        exchanged += Math.abs(energy);
      }
      const airCredit =
        (((credits.reduce((sum, v) => sum + v, 0) * (100 / nz)) / config.heightScale) * n * n) /
        (nx * ny);
      const drift = Math.abs(debit - airCredit) / exchanged;
      check(
        `Heat conserves energy, size ${n}, boundary ${boundary}`,
        drift < 0.00003,
        `relative error versus exchanged energy=${drift}`
      );
      check(
        `Heat preserves water reservoirs, size ${n}, boundary ${boundary}`,
        heated.every((v, i) => i % 4 === 2 || v === surface[i]) &&
          (await read(device, fluids)).every((v, i) => v === liquid[i])
      );

      // A corner hotspot must credit every neighboring air column, with wrapping
      // only in periodic mode. All other cells start at exact thermal equilibrium.
      ground.fill(0);
      liquid.fill(0);
      surface.fill(0);
      air.fill(0);
      surface[2] = 10;
      seed();
      heatOnly();
      const cornerCredit = await read(device, sim.surfaceHeat);
      // On an undersampled surface the first fine-cell center is already inside
      // the coarse domain: its footprint reaches (1,1), not the periodic seam.
      const target = n < nx ? nx + 1 : boundary === 0 ? nx * ny - 1 : 0;
      check(
        `Corner heat reaches its expected air column, size ${n}, boundary ${boundary}`,
        cornerCredit[target] > 0 && (boundary === 0 || cornerCredit[nx * ny - 1] === 0),
        `target column=${target}, credit=${cornerCredit[target]}`
      );

      // Stress overlapping exchanges far beyond the production timestep. Neither
      // reservoir may overshoot the initial temperature range as its four
      // neighbors contribute. A uniform setup also exercises the edge capacities.
      if (n === 769) {
        surface.fill(0);
        for (let i = 2; i < surface.length; i += 4) surface[i] = 20;
        for (let i = 3; i < air.length; i += 8) air[i] = -10;
        seed();
        heatOnly(10);
        const relaxed = await read(device, sim.surfaceBuffer);
        const relaxedCredits = await read(device, sim.surfaceHeat);
        check(
          `Overlapping heat exchanges stay bounded, boundary ${boundary}`,
          relaxed.every((v, i) => i % 4 !== 2 || (v >= -10 && v <= 20)) &&
            relaxedCredits.every((v) => v >= 0 && v <= 30)
        );
      }

      // Isothermal air and ground must stay isothermal, including unavailable air.
      surface.fill(0);
      for (let i = 0; i < ground.length; i += 4) {
        ground[i] = (i / 4) % 7 === 0 ? 7 : 0.1;
        surface[i + 2] = 8;
      }
      for (let i = 3; i < air.length; i += 8) air[i] = 8;
      seed();
      heatOnly();
      check(
        `Isothermal relief creates no heat, size ${n}, boundary ${boundary}`,
        (await read(device, sim.surfaceBuffer)).every((v, i) => v === surface[i]) &&
          (await read(device, sim.surfaceHeat)).every((v) => v === 0)
      );
    }

    if (n === 769) {
      config.atmosphereBoundary = 0;
      for (const axis of [0, 1]) {
        ground.fill(0);
        liquid.fill(0);
        surface.fill(0);
        air.fill(0);
        for (let i = 0; i < liquid.length; i += 4) liquid[i] = 0.5;
        for (let z = 0; z < nz; z++)
          for (let y = 0; y < ny; y++)
            for (let x = 0; x < nx; x++) {
              air[((z * ny + y) * nx + x) * 8 + 3] = (axis === 0 ? x : y) % 2 === 0 ? -20 : -5;
            }
        seed();
        // Full integration over repeated steps: air credit, transport and freezing.
        const freezeSteps = 20;
        for (let i = 0; i < freezeSteps; i++) step(0.1);
        const frozen = await read(device, sim.surfaceBuffer);
        const water = await read(device, fluids);
        const profile = new Float64Array(n);
        let massError = 0,
          totalIce = 0;
        for (let y = 0; y < n; y++)
          for (let x = 0; x < n; x++) {
            const i = (y * n + x) * 4;
            profile[axis === 0 ? x : y] += frozen[i + 1] / n;
            massError = Math.max(massError, Math.abs(frozen[i + 1] + water[i] - liquid[i]));
            totalIce += frozen[i + 1];
          }
        const ratio = seamRatio(profile, axis === 0 ? nx : ny);
        check(
          `New ice has no amplified jumps at atmospheric boundaries, axis ${axis}`,
          totalIce > 0 && ratio < 1.5,
          `seam/average thickness gradient=${ratio}`
        );
        check(
          `Smooth freezing conserves water in every surface cell, axis ${axis}`,
          // Allow one f32 rounding unit per transfer of the initial 0.5 depth.
          massError < freezeSteps * 0.5 * 2 ** -23,
          `maximum water-equivalent error=${massError}`
        );
        if (axis === 0) {
          const canvas = document.querySelector('#ice');
          const ctx = canvas.getContext('2d');
          const min = Math.min(...profile),
            max = Math.max(...profile);
          for (let x = 0; x < n; x++) {
            const t = (profile[x] - min) / (max - min);
            ctx.fillStyle = `rgb(${30 + 210 * t}, ${95 + 150 * t}, ${155 + 95 * t})`;
            ctx.fillRect(x, 0, 1, canvas.height);
          }
        }
      }
    }
    sim.destroy();
    terrain.destroy();
    fluids.destroy();
  }
  check('No heat-exchange GPU validation errors', errors.length === 0, errors.join('\n'));
  window.testResults = { passed: true, results };
  document.querySelector('#results').textContent = JSON.stringify(window.testResults, null, 2);
  device.destroy();
}
run().catch((error) => {
  console.error(error);
  window.testResults = { passed: false, error: String(error), results };
  document.querySelector('#results').textContent = JSON.stringify(window.testResults, null, 2);
});
