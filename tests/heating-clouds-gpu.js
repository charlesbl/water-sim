import * as THREE from 'three';
import { config } from '../src/config.ts';
import { AtmosphereSimulation, ATMOSPHERE_DIMENSIONS } from '../src/atmosphere.ts';
import { AtmosphereRenderer } from '../src/atmosphereRenderer.ts';

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
  const data = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return data;
}
async function run() {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  // Both the 16-cell solar groups and the 96-cell atmospheric grid have partial edges.
  const n = 97;
  const make = () =>
    device.createBuffer({
      size: n * n * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
  const terrain = make(),
    fluids = make();
  const ground = new Float32Array(n * n * 4),
    liquid = new Float32Array(ground.length),
    surface = new Float32Array(ground.length);
  const air = new Float32Array(atmoX * atmoY * atmoZ * 8);
  Object.assign(config, {
    atmosphereEnabled: true,
    closedWaterCycle: true,
    emergentWeather: true,
    atmosphereBoundary: 0,
    airTemperature: 8,
    relativeHumidity: 0,
    convectionStrength: 0,
    windSpeed: 0,
    solarHeating: 1,
    heatingContrast: 1,
    sunElevation: 40,
    sunAzimuth: 0,
    radiativeCooling: 0,
    evaporationRate: 0,
    heightScale: 18,
  });
  const sim = new AtmosphereSimulation(device, n);
  await sim.init();
  const step = (dt) => {
    const encoder = device.createCommandEncoder();
    sim.step(encoder, terrain, fluids, dt);
    device.queue.submit([encoder.finish()]);
  };
  const tick = async (count) => {
    for (let i = 0; i < count; i++) step(0.1);
    await device.queue.onSubmittedWorkDone();
  };
  step(0);
  const seed = () => {
    device.queue.writeBuffer(terrain, 0, ground);
    device.queue.writeBuffer(fluids, 0, liquid);
    device.queue.writeBuffer(sim.surfaceBuffer, 0, surface);
    device.queue.writeBuffer(sim.volumeBuffer, 0, air);
  };
  const isothermal = (temperature = 8, humidity = 0) => {
    ground.fill(0);
    liquid.fill(0);
    surface.fill(0);
    air.fill(0);
    for (let i = 2; i < surface.length; i += 4) surface[i] = temperature;
    for (let i = 0; i < air.length; i += 8) {
      air[i + 3] = temperature;
      air[i + 4] = humidity;
    }
  };
  isothermal();
  // A flat bed of exposed rock, dry sand and water, with known effective capacities.
  const capacity = [1.5, 0.6, 5.5];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4,
        kind = x % 3;
      ground[i] = kind === 1 ? 0.45 : 0.5;
      ground[i + 1] = kind === 1 ? 0.05 : 0;
      liquid[i] = kind === 2 ? 0.5 : 0;
    }
  const heating = [];
  for (const contrast of [1, 3, 10]) {
    config.heatingContrast = contrast;
    seed();
    step(0.1);
    const heated = await read(device, sim.surfaceBuffer);
    let energy = 0;
    const warming = [0, 0, 0],
      counts = [0, 0, 0];
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const kind = x % 3,
          delta = heated[(y * n + x) * 4 + 2] - 8;
        energy += capacity[kind] * delta;
        warming[kind] += delta;
        counts[kind]++;
      }
    heating.push({ contrast, energy, warming: warming.map((v, i) => v / counts[i]) });
  }
  check(
    'Dry sand warms faster than rock and deep water',
    heating[0].warming[1] > heating[0].warming[0] && heating[0].warming[0] > heating[0].warming[2],
    JSON.stringify(heating)
  );
  check(
    'Contrasts 1, 3 and 10 preserve total absorbed solar energy',
    heating.every((h) => Math.abs(h.energy / heating[0].energy - 1) < 0.001),
    JSON.stringify(heating)
  );
  check(
    'Contrast concentrates heating on responsive surfaces',
    heating[1].warming[1] > heating[0].warming[1] &&
      heating[2].warming[1] > heating[1].warming[1] &&
      heating[2].warming[2] < heating[0].warming[2],
    JSON.stringify(heating)
  );

  isothermal();
  const flat = [];
  for (const contrast of [1, 10]) {
    config.heatingContrast = contrast;
    seed();
    step(0.1);
    flat.push(await read(device, sim.surfaceBuffer));
  }
  check(
    'A uniform surface stays uniform even at maximum contrast',
    flat[1].every((v, i) => i % 4 !== 2 || Math.abs(v - flat[1][2]) < 0.00001)
  );
  check(
    'Contrast adds no extra energy to a uniform world',
    Math.abs(flat[0][2] - flat[1][2]) < 0.00001
  );
  config.solarHeating = 0;
  seed();
  step(0.1);
  const dark = await read(device, sim.surfaceBuffer);
  check(
    'Maximum contrast produces no heat with the solar source off',
    dark.every((v, i) => i % 4 !== 2 || Math.abs(v - 8) < 0.00001)
  );
  config.solarHeating = 1;

  // Reversing the sun must reverse the warm slope, independent of material.
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      ground[(y * n + x) * 4] = 2 + 2 * Math.cos((2 * Math.PI * (x + 0.5)) / n);
  const slopes = [];
  config.sunElevation = 15;
  for (const azimuth of [0, 180]) {
    config.sunAzimuth = azimuth;
    seed();
    step(0.1);
    const heated = await read(device, sim.surfaceBuffer);
    const left = heated[(48 * n + 24) * 4 + 2] - 8,
      right = heated[(48 * n + 72) * 4 + 2] - 8;
    slopes.push({ azimuth, left, right });
  }
  check(
    'Sun orientation selects the warm slope without heating its unlit opposite',
    slopes[0].left > 0.001 &&
      Math.abs(slopes[0].right) < 0.00001 &&
      slopes[1].right > 0.001 &&
      Math.abs(slopes[1].left) < 0.00001,
    JSON.stringify(slopes)
  );

  config.solarHeating = 0;
  const saturated = 0.008 * Math.exp(0.065 * 8);
  const snapshot = async () => {
    const values = await read(device, sim.volumeBuffer),
      cover = await read(device, sim.surfaceBuffer),
      water = await read(device, fluids);
    let vapor = 0,
      cloud = 0,
      rain = 0,
      deposited = 0,
      temperature = 0;
    const airArea = 4000000 / (atmoX * atmoY * atmoZ),
      surfaceArea = (40000 * 18) / (n * n);
    for (let i = 0; i < values.length; i += 8) {
      vapor += values[i + 4] * airArea;
      cloud += values[i + 5] * airArea;
      rain += (values[i + 6] + values[i + 7]) * airArea;
      temperature += values[i + 3] / (atmoX * atmoY * atmoZ);
    }
    for (let i = 0; i < cover.length; i += 4)
      deposited += (cover[i] + cover[i + 1] + cover[i + 3] + water[i] + water[i + 3]) * surfaceArea;
    return {
      vapor,
      cloud,
      rain,
      deposited,
      temperature,
      total: vapor + cloud + rain + deposited,
      finite: values.every((v, i) => Number.isFinite(v) && (i % 8 < 4 || v >= 0)),
    };
  };
  isothermal(8, saturated);
  for (let z = Math.floor((8 * atmoZ) / 32); z < Math.floor((24 * atmoZ) / 32); z++)
    for (let i = z * atmoX * atmoY * 8 + 5; i < (z + 1) * atmoX * atmoY * 8; i += 8) air[i] = 0.001;
  seed();
  const initial = await snapshot();
  await tick(10);
  const short = await snapshot();
  await tick(590);
  const later = await snapshot();
  check(
    'Cloud water below the former rain threshold produces gradual drizzle',
    short.rain > 0.1 && short.cloud > initial.cloud * 0.95,
    JSON.stringify({ initial, short })
  );
  check(
    'Subthreshold clouds turn over and return water to the ground',
    later.cloud < initial.cloud * 0.8 && later.cloud > initial.cloud * 0.2 && later.deposited > 1,
    JSON.stringify(later)
  );
  check(
    'Cloud conversion preserves the full water inventory',
    Math.abs(later.total / initial.total - 1) < 0.0002 && later.finite,
    JSON.stringify(later)
  );

  isothermal(8, saturated * 0.2);
  for (let i = 5; i < air.length; i += 8) air[i] = 0.001;
  seed();
  const dryInitial = await snapshot();
  await tick(20);
  const evaporated = await snapshot();
  check(
    'Clouds in dry air return their water to vapor and cool the air',
    evaporated.cloud < dryInitial.cloud * 0.001 &&
      evaporated.vapor > dryInitial.vapor + dryInitial.cloud * 0.98 &&
      evaporated.temperature < 7.6,
    JSON.stringify(evaporated)
  );
  check(
    'Re-evaporation conserves water and remains finite',
    evaporated.finite && Math.abs(evaporated.total / dryInitial.total - 1) < 0.0002,
    JSON.stringify(evaporated)
  );

  // Exercise the real ray marcher, not a CPU copy of its opacity formula.
  const renderer = new AtmosphereRenderer(device, 'rgba8unorm', sim);
  await renderer.init();
  Object.assign(config, { atmosphereView: 0, showClouds: true, showWind: false });
  const color = device.createTexture({
    size: [64, 64],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const depth = device.createTexture({
    size: [64, 64],
    format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const pixels = device.createBuffer({
    size: 64 * 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  camera.up.set(0, 0, 1);
  camera.position.set(0, -150, 50);
  camera.lookAt(0, 0, 50);
  camera.updateMatrixWorld();
  const mvp = new THREE.Matrix4()
    .set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
    .multiply(camera.projectionMatrix)
    .multiply(camera.matrixWorldInverse);
  const opacity = async (condensate) => {
    isothermal();
    for (let z = 0; z < atmoZ; z++)
      for (let y = 12; y < 36; y++)
        for (let x = 0; x < atmoX; x++) air[((z * atmoY + y) * atmoX + x) * 8 + 5] = condensate;
    seed();
    const encoder = device.createCommandEncoder();
    const clear = encoder.beginRenderPass({
      colorAttachments: [
        { view: color.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
      ],
      depthStencilAttachment: {
        view: depth.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    clear.end();
    renderer.render(encoder, color.createView(), depth.createView(), mvp, camera.position);
    encoder.copyTextureToBuffer({ texture: color }, { buffer: pixels, bytesPerRow: 256 }, [64, 64]);
    device.queue.submit([encoder.finish()]);
    await pixels.mapAsync(GPUMapMode.READ);
    const alpha = new Uint8Array(pixels.getMappedRange())[(32 * 64 + 32) * 4 + 3] / 255;
    pixels.unmap();
    return alpha;
  };
  const empty = await opacity(0),
    thin = await opacity(0.0004),
    dense = await opacity(0.006);
  check(
    'Sparse cloud renders as a translucent layer while dense cloud remains opaque',
    empty === 0 && thin > 0.35 && thin < 0.65 && dense > 0.95,
    JSON.stringify({ empty, thin, dense })
  );
  check('No heating or cloud GPU validation errors', errors.length === 0, errors.join('\n'));
  renderer.destroy();
  color.destroy();
  depth.destroy();
  pixels.destroy();
  sim.destroy();
  terrain.destroy();
  fluids.destroy();
  device.destroy();
  window.testResults = { passed: true, results };
}
run().catch((error) => {
  console.error(error);
  window.testResults = { passed: false, error: String(error), results };
  document.querySelector('#results').textContent = JSON.stringify(window.testResults, null, 2);
});
