import { config } from '../src/config.ts';
import { AtmosphereSimulation, ATMOSPHERE_DIMENSIONS } from '../src/atmosphere.ts';

const results = [];
const [nx, ny, nz] = ATMOSPHERE_DIMENSIONS;
const dz = 100 / nz;
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
    convectionStrength: 0,
    windSpeed: 0,
    solarHeating: 0,
    radiativeCooling: 1,
    evaporationRate: 0,
    heightScale: 18,
  });
  for (const n of [49, 97, 257]) {
    const make = () =>
      device.createBuffer({
        size: n * n * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });
    const terrain = make(),
      fluids = make();
    const ground = new Float32Array(n * n * 4);
    const surface = new Float32Array(ground.length);
    const air = new Float32Array(nx * ny * nz * 8);
    const sim = new AtmosphereSimulation(device, n);
    await sim.init();
    const step = (dt = 0.1) => {
      const encoder = device.createCommandEncoder();
      sim.step(encoder, terrain, fluids, dt);
      device.queue.submit([encoder.finish()]);
    };
    step(0);
    const seed = () => {
      device.queue.writeBuffer(terrain, 0, ground);
      device.queue.writeBuffer(sim.surfaceBuffer, 0, surface);
      sim.reset(false);
      step(0);
      device.queue.writeBuffer(sim.volumeBuffer, 0, air);
    };
    const energy = (airValues, surfaceValues) => {
      let total = 0;
      const capacity = ((dz / config.heightScale) * n * n) / (nx * ny);
      for (let i = 3; i < airValues.length; i += 8) total += airValues[i] * capacity;
      for (let i = 2; i < surfaceValues.length; i += 4) total += surfaceValues[i] * 1.5;
      return total;
    };
    for (const boundary of [0, 1]) {
      config.atmosphereBoundary = boundary;
      config.radiativeCooling = 1;
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const i = (y * n + x) * 4;
          // Include high terrain and fully obstructed columns. No phase changes.
          ground[i] = x < n / 4 ? 6 : x < n / 2 ? 2 : 0;
          surface[i + 2] = 14 + 5 * Math.sin(x * 0.2) * Math.cos(y * 0.15);
        }
      for (let z = 0; z < nz; z++)
        for (let y = 0; y < ny; y++)
          for (let x = 0; x < nx; x++)
            air[((z * ny + y) * nx + x) * 8 + 3] = 22 - z * 0.1 + 3 * Math.sin(x * 0.15);
      seed();
      const before = energy(air, surface);
      step();
      const afterAir = await read(device, sim.volumeBuffer);
      const afterSurface = await read(device, sim.surfaceBuffer);
      const budget = await read(device, sim.solarNormalization);
      const weights = await read(device, sim.depositionWeights);
      const heating = await read(device, sim.longwaveHeating);
      const columns = await read(device, sim.columns);
      let escaped = 0,
        fluxBalance = 0;
      for (let ci = 0; ci < nx * ny; ci++) {
        const i = (ci + 1) * 4;
        const area = (n * n) / (nx * ny) / weights[ci];
        escaped += budget[i + 2] * 0.1 * area;
        fluxBalance += (budget[i + 1] - budget[i] + budget[i + 2]) * 0.1 * area;
      }
      for (const delta of heating)
        fluxBalance += (((delta * dz) / config.heightScale) * n * n) / (nx * ny);
      const lost = before - energy(afterAir, afterSurface);
      check(
        `Infrared fluxes balance surface, air and space (${n}, boundary ${boundary})`,
        escaped > 0 && Math.abs(fluxBalance / escaped) < 0.00001,
        JSON.stringify({ escaped, fluxBalance })
      );
      check(
        `Integrated energy loss equals escaped infrared (${n}, boundary ${boundary})`,
        Math.abs(lost / escaped - 1) < 0.002,
        JSON.stringify({ escaped, lost, relativeError: lost / escaped - 1 })
      );
      check(
        `Buried cells do not radiate (${n}, boundary ${boundary})`,
        heating.every(
          (v, i) => (Math.floor(i / (nx * ny)) + 0.5) * dz > columns[(i % (nx * ny)) * 4] || v === 0
        )
      );
      check(
        `Radiation preserves dry water inventory and finite states (${n}, boundary ${boundary})`,
        afterAir.every((v, i) => Number.isFinite(v) && (i % 8 < 4 || v === 0)) &&
          afterSurface.every((v, i) => Number.isFinite(v) && (i % 4 === 2 || v === 0))
      );
    }
    if (n === 97) {
      config.atmosphereBoundary = 0;
      ground.fill(0);
      surface.fill(0);
      air.fill(0);
      for (let i = 2; i < surface.length; i += 4) surface[i] = 8;
      // Reproduce a stable warm reservoir aloft, already decoupled from the ground.
      for (let z = 0; z < nz; z++)
        for (let i = z * nx * ny * 8 + 3; i < (z + 1) * nx * ny * 8; i += 8)
          air[i] = z < nz / 2 ? 8 : 24;
      const upperMean = (values) => {
        let sum = 0;
        for (let z = nz - 8; z < nz; z++)
          for (let i = z * nx * ny * 8 + 3; i < (z + 1) * nx * ny * 8; i += 8)
            sum += values[i] / (8 * nx * ny);
        return sum;
      };
      const evolve = async (radiation) => {
        config.radiativeCooling = radiation;
        config.solarHeating = 1;
        seed();
        for (let i = 0; i < 400; i++) {
          if (i === 20) config.solarHeating = 0;
          step();
          if (i % 25 === 24) await device.queue.onSubmittedWorkDone();
        }
        return upperMean(await read(device, sim.volumeBuffer));
      };
      const insulated = await evolve(0);
      const radiating = await evolve(1);
      check(
        'Warm upper air cools after solar reduction without requiring convection',
        radiating < insulated - 1 && Math.abs(insulated - 24) < 0.001,
        JSON.stringify({ insulated, radiating })
      );

      // Changing live radiation to zero clears previously computed increments.
      config.radiativeCooling = 0;
      step();
      check(
        'Disabling radiation clears all atmospheric radiative tendencies',
        (await read(device, sim.longwaveHeating)).every((v) => v === 0)
      );
      check(
        'Disabling radiation clears surface and space infrared fluxes',
        (await read(device, sim.solarNormalization)).slice(4).every((v) => v === 0)
      );

      // A cloud emits and absorbs infrared even in a motionless column.
      // At equal temperatures it shields the surface and cools at its top.
      config.radiativeCooling = 1;
      const cloudResponse = async (cloud) => {
        air.fill(0);
        for (let z = 0; z < nz; z++)
          for (let i = z * nx * ny * 8; i < (z + 1) * nx * ny * 8; i += 8) {
            air[i + 3] = 8;
            air[i + 4] = 0.008 * Math.exp(0.065 * 8);
            air[i + 5] = z >= 40 && z < 48 ? cloud : 0;
          }
        seed();
        step();
        const fluxes = await read(device, sim.solarNormalization);
        const tendencies = await read(device, sim.longwaveHeating);
        return { downward: fluxes[5], cloudTop: tendencies[47 * nx * ny] };
      };
      const clear = await cloudResponse(0);
      const cloudy = await cloudResponse(0.004);
      check(
        'Cloud infrared shields the surface and increases cooling at cloud top',
        cloudy.downward > clear.downward && cloudy.cloudTop < clear.cloudTop && cloudy.cloudTop < 0,
        JSON.stringify({ clear, cloudy })
      );
    }
    sim.destroy();
    terrain.destroy();
    fluids.destroy();
  }
  check('No atmospheric infrared GPU validation errors', errors.length === 0, errors.join('\n'));
  window.testResults = { passed: true, results };
  document.querySelector('#results').textContent = JSON.stringify(window.testResults, null, 2);
  device.destroy();
}
run().catch((error) => {
  console.error(error);
  window.testResults = { passed: false, error: String(error), results };
  document.querySelector('#results').textContent = JSON.stringify(window.testResults, null, 2);
});
