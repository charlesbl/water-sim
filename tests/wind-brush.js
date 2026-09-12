import { config } from '../src/config.ts';
import { AtmosphereSimulation } from '../src/atmosphere.ts';
const results = [];
function check(name, passed) {
  results.push({ name, passed: Boolean(passed) });
  if (!passed) throw new Error(name);
}
try {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  Object.assign(config, {
    atmosphereEnabled: true,
    windSpeed: 0,
    weatherVariability: 0,
    solarHeating: 0,
    radiativeCooling: 0,
    airBuoyancy: 0,
    evaporationRate: 0,
    surfaceAirHeatExchange: 0,
    relativeHumidity: 0,
    airViscosity: 0.005,
    pressureCycles: 3,
  });
  const n = 32;
  const storage = (size) =>
    device.createBuffer({
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
  const terrain = storage(n * n * 24),
    fluids = storage(n * n * 16);
  const atmo = new AtmosphereSimulation(device, n);
  await atmo.init();
  const step = (dt) => {
    const encoder = device.createCommandEncoder();
    atmo.step(encoder, terrain, fluids, dt);
    device.queue.submit([encoder.finish()]);
  };
  const read = async (buffer = atmo.circulationFaces) => {
    const staging = device.createBuffer({
      size: buffer.size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, staging.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return values;
  };
  step(0);
  atmo.setWindBrush(0.5, 0.5, 0.2, 8, -4);
  step(0.05);
  let faces = await read();
  const center = (16 * n + 16) * 4;
  check('Drag direction drives both horizontal axes', faces[center] > 0 && faces[center + 1] < 0);
  let outsideEnergy = 0, independentLayers = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = (y * n + x) * 4, upper = i + n * n * 4;
    if (Math.hypot((x + 0.5) / n - 0.5, (y + 0.5) / n - 0.5) > 0.25)
      outsideEnergy += faces[i] ** 2 + faces[i + 1] ** 2;
    independentLayers += (faces[i] + faces[upper]) ** 2 + (faces[i + 1] + faces[upper + 1]) ** 2;
  }
  check('Pressure communicates the local stroke outside the brush circle', outsideEnergy > 1e-8);
  check('Upper wind is not forced to be the exact opposite of lower wind', independentLayers > 1e-6);
  const first = faces[center];
  step(0.05);
  faces = await read();
  check('Holding continues to accelerate', faces[center] > first);
  atmo.setWindBrush(0, 0, 0, 0, 0);
  const held = faces[center];
  step(0.05);
  faces = await read();
  check('Releasing preserves a finite evolving current', faces[center] > 0 && Math.abs(faces[center] - held) > 1e-9);
  atmo.setWindBrush(0.5, 0.5, 2, 10000, -10000);
  for (let i = 0; i < 20; i++) step(0.05);
  faces = await read();
  const flow = await read(atmo.flowControl);
  check('Strong wind respects the shared Courant limit', faces.every(Number.isFinite)
    && flow[0] * flow[2] * 0.05 <= 0.40001);
  check(
    'Walls remain sealed',
    [0, 1].every(layer => Array.from({ length: n }, (_, i) => {
      const start = layer * n * n * 4;
      return faces[start + (i * n + n - 1) * 4] === 0
        && faces[start + ((n - 1) * n + i) * 4 + 1] === 0;
    }).every(Boolean))
  );
  check('No GPU validation errors', errors.length === 0);
  atmo.destroy();
  device.destroy();
  window.testResults = { passed: true, results };
} catch (error) {
  window.testResults = { passed: false, results, error: String(error) };
}
document.querySelector('#results').textContent = JSON.stringify(window.testResults, null, 2);
