import { config } from '../src/config.ts';
import { AtmosphereSimulation } from '../src/atmosphere.ts';

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed: Boolean(passed), detail });
  if (!passed) throw new Error(`${name}: ${JSON.stringify(detail)}`);
}
async function run() {
  const adapter = await navigator.gpu?.requestAdapter();
  check('WebGPU available', adapter);
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  const n = 64, count = n * n, dx = 200 / n;
  const buffer = (size) => device.createBuffer({ size,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const terrain = buffer(count * 24), fluids = buffer(count * 16);
  const atmo = new AtmosphereSimulation(device, n), saved = { ...config };
  const read = async (source) => {
    const staging = device.createBuffer({ size: source.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(source, 0, staging, 0, source.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap(); staging.destroy();
    return result;
  };
  const step = dt => {
    const encoder = device.createCommandEncoder();
    atmo.step(encoder, terrain, fluids, dt);
    device.queue.submit([encoder.finish()]);
  };
  const metrics = async () => {
    const [faces, air, radiation] = await Promise.all([read(atmo.circulationFaces), read(atmo.volumeBuffer), read(atmo.energyFlux)]);
    let kinetic = 0, sensible = 0, weight = 0, xCenter = 0, divergence = 0;
    for (let i = 0; i < count * 2; i++) {
      kinetic += 0.5 * (faces[i * 4] ** 2 + faces[i * 4 + 1] ** 2 + faces[i * 4 + 2] ** 2);
      sensible += air[i * 8 + 3];
    }
    for (let y = 1; y < n; y++) for (let x = 1; x < n; x++) {
      const below = ((y - 1) * n + x) * 4, leftBelow = below - 4, left = (y * n + x - 1) * 4;
      const curl = (faces[below + 1] - faces[leftBelow + 1] - faces[left] + faces[leftBelow]) / dx;
      const w = Math.abs(curl) ** 3;
      weight += w; xCenter += w * (x * dx - 100);
    }
    for (let z = 0; z < 2; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const j = (x + y * n + z * count) * 4;
      const west = x > 0 ? faces[j - 4] : 0, south = y > 0 ? faces[j - 4 * n + 1] : 0;
      const w = faces[(x + y * n) * 4 + 2];
      divergence = Math.max(divergence, Math.abs((faces[j] - west + faces[j + 1] - south) / dx + (z ? -w : w) / 16));
    }
    return { kinetic, energy: kinetic + sensible, center: xCenter / weight, divergence, radiation,
      finite: faces.every(Number.isFinite) && air.every(Number.isFinite) };
  };
  try {
    Object.assign(config, saved, { atmosphereEnabled: true, windSpeed: 0, relativeHumidity: 0,
      airTemperature: 12, airStability: 0.25, weatherVariability: 0,
      solarHeating: 0, radiativeCooling: 0, evaporationRate: 0, surfaceAirHeatExchange: 0,
      condensationRate: 0, rainEvaporationRate: 0, airMixing: 0, convectionStrength: 0, orographicLift: 0,
      airBuoyancy: 0, airDrag: 0, airViscosity: 0, pressureCycles: 4 });
    await atmo.init(); step(0);
    // Counter-rotating vortex pair in both layers, constructed as a discrete
    // streamfunction curl. There is no brush, heat source, drag or viscosity.
    // A diffusion-only wind update would leave this pair centered in place.
    const psi = (i, j) => {
      if (i === 0 || j === 0 || i === n || j === n) return 0;
      const x = i * dx - 100, y = j * dx - 100;
      const dipole = (120 / (4 * Math.PI)) * Math.log((x * x + (y - 12) ** 2 + 16) / (x * x + (y + 12) ** 2 + 16));
      return dipole * Math.sin(Math.PI * i / n) ** 2 * Math.sin(Math.PI * j / n) ** 2;
    };
    const seed = new Float32Array(count * 8);
    for (let z = 0; z < 2; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const j = (x + y * n + z * count) * 4;
      if (x + 1 < n) seed[j] = (psi(x + 1, y + 1) - psi(x + 1, y)) / dx;
      if (y + 1 < n) seed[j + 1] = -(psi(x + 1, y + 1) - psi(x, y + 1)) / dx;
    }
    device.queue.writeBuffer(atmo.circulationFaces, 0, seed);
    const before = await metrics();
    for (let i = 0; i < 160; i++) { step(0.05); if (i % 40 === 39) await device.queue.onSubmittedWorkDone(); }
    const after = await metrics();
    check('Momentum advection moves a vortex pair without thermal forcing or viscosity',
      Math.abs(after.center - before.center) > dx * 0.2, { before: before.center, after: after.center });
    check('Resolved current retains substantial kinetic energy', after.kinetic > before.kinetic * 0.4,
      { before: before.kinetic, after: after.kinetic });
    check('Numerical mechanical loss has a thermal counterpart', Math.abs(after.energy / before.energy - 1) < 4e-5,
      { before: before.energy, after: after.energy });
    check('Projection maintains continuity while momentum is transported', after.divergence < 2e-4, after.divergence);
    check('No automatic external energy input', after.radiation[0] === 0 && after.radiation[1] === 0);
    check('Finite values and no GPU validation errors', after.finite && errors.length === 0, errors);
  } finally {
    Object.assign(config, saved); atmo.destroy(); terrain.destroy(); fluids.destroy(); device.destroy();
  }
}
run().then(() => { window.testResults = { passed: true, results }; }).catch(error => {
  window.testResults = { passed: false, results, error: String(error.stack ?? error) };
}).finally(() => { document.querySelector('#results').textContent = JSON.stringify(window.testResults, null, 2); });
