import { config } from '../src/config.ts';
import { AtmosphereSimulation } from '../src/atmosphere.ts';
import {
  referenceSwitch as pressureReferenceSwitch,
  readBuffers,
  difference,
} from './pressure-cache-utils.js';

const transport = document.documentElement.dataset.optimization === 'transport';
const surfaceExchange = document.documentElement.dataset.optimization === 'surface-exchange';
const { transportReferenceSwitch, checkTransportFaces } = transport
  ? await import('./transport-utils.js')
  : {};
const { surfaceExchangeReferenceSwitch, checkSurfaceMapping } = surfaceExchange
  ? await import('./surface-exchange-utils.js')
  : {};
const referenceSwitch = surfaceExchange
  ? surfaceExchangeReferenceSwitch
  : transport
    ? transportReferenceSwitch
    : pressureReferenceSwitch;

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed: !!passed, detail });
  document.querySelector('#results').textContent = JSON.stringify(results, null, 2);
  if (!passed) throw new Error(`${name}: ${JSON.stringify(detail)}`);
}

async function run() {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  if (transport) await checkTransportFaces(device, check);
  if (surfaceExchange) await checkSurfaceMapping(device, check);
  const n = 257;
  const make = (size) =>
    device.createBuffer({
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
  const terrainValues = new Float32Array(n * n * 6);
  const fluidValues = new Float32Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      terrainValues[i * 6] = x < 24 && y < 24 ? 7 : 0.1 + 0.2 * Math.sin(x / 13) ** 2;
      terrainValues[i * 6 + 1] = 0.05;
      terrainValues[i * 6 + 4] = 0.15;
      fluidValues[i * 4] = x > 70 && x < 160 ? 0.4 : 0;
    }
  const terrains = [make(terrainValues.byteLength), make(terrainValues.byteLength)];
  const fluids = [make(fluidValues.byteLength), make(fluidValues.byteLength)];
  const sims = [new AtmosphereSimulation(device, n), new AtmosphereSimulation(device, n)];
  await Promise.all(sims.map((sim) => sim.init()));
  const toggle = await referenceSwitch(device, sims[0], [[terrains[0], fluids[0]]]);
  toggle(true);
  const step = (which, dt) => {
    const encoder = device.createCommandEncoder();
    sims[which].step(encoder, terrains[which], fluids[which], dt);
    device.queue.submit([encoder.finish()]);
  };
  const stateNames = [
    'volumeBuffer',
    'pressureBuffer',
    'divergenceBuffer',
    'conjugateState',
    'surfaceBuffer',
    'precipitation',
    'columns',
    ...(surfaceExchange
      ? [
          'solarPartials',
          'solarNormalization',
          'heatTransfers',
          'heatProfiles',
          'surfaceHeat',
          'longwaveHeating',
        ]
      : []),
  ];
  async function compare(label) {
    const budgetPrefixBytes = (1 + sims[0].dimensions[0] * sims[0].dimensions[1]) * 16;
    const states = [];
    for (let i = 0; i < 2; i++)
      states.push(
        await readBuffers(device, [...stateNames.map((name) => sims[i][name]), fluids[i]])
      );
    const comparisons = states[0].map((data, i) => ({
      field: [...stateNames, 'fluids'][i],
      ...difference(
        stateNames[i] === 'solarNormalization' ? data.slice(0, budgetPrefixBytes) : data,
        stateNames[i] === 'solarNormalization'
          ? states[1][i].slice(0, budgetPrefixBytes)
          : states[1][i]
      ),
    }));
    check(
      label,
      comparisons.every((d) => d.mismatches === 0 && d.finite),
      comparisons
    );
  }
  async function checkGeometry(boundary, label) {
    const [columnData, geometryData] = await readBuffers(device, [
      sims[1].columns,
      sims[1].pressureGeometry,
    ]);
    const columns = new Float32Array(columnData),
      words = new Uint32Array(geometryData),
      values = new Float32Array(geometryData);
    const [nx, ny, nz] = sims[1].dimensions;
    const spacing = [Math.fround(200 / nx), Math.fround(200 / ny), Math.fround(100 / nz)];
    const weights = spacing.map((d) => Math.fround(1 / Math.fround(d * d)));
    const isAir = (x, y, z) => {
      if (z < 0 || z >= nz || (boundary && (x < 0 || x >= nx || y < 0 || y >= ny))) return false;
      x = (x + nx) % nx;
      y = (y + ny) % ny;
      return Math.fround((z + 0.5) * spacing[2]) > columns[(y * nx + x) * 4];
    };
    let wrongMasks = 0,
      maxDiagonalError = 0;
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) {
          let mask = 0,
            diagonal = 0;
          if (isAir(x, y, z)) {
            mask = 1;
            for (let axis = 0; axis < 3; axis++)
              for (const sign of [1, -1]) {
                const neighbor = [x, y, z];
                neighbor[axis] += sign;
                if (isAir(...neighbor)) {
                  mask |= 1 << (1 + axis * 2 + (sign === -1 ? 1 : 0));
                  diagonal = Math.fround(diagonal + weights[axis]);
                }
              }
          }
          const i = ((z * ny + y) * nx + x) * 2;
          if (words[i] !== mask) wrongMasks++;
          maxDiagonalError = Math.max(maxDiagonalError, Math.abs(values[i + 1] - diagonal));
        }
    check(label, wrongMasks === 0 && maxDiagonalError < 1e-6, {
      wrongMasks,
      maxDiagonalError,
      cells: nx * ny * nz,
    });
  }
  try {
    for (const boundary of [0, 1]) {
      Object.assign(config, {
        atmosphereEnabled: true,
        atmosphereBoundary: boundary,
        closedWaterCycle: true,
        emergentWeather: true,
        airTemperature: 8,
        relativeHumidity: 0.9,
        windSpeed: 8,
        heightScale: 18,
        solarHeating: 1,
        radiativeCooling: 1,
      });
      for (let i = 0; i < 2; i++) {
        device.queue.writeBuffer(terrains[i], 0, terrainValues);
        device.queue.writeBuffer(fluids[i], 0, fluidValues);
        sims[i].reset();
        step(i, 0);
      }
      for (let tick = 1; tick <= 1000; tick++) {
        step(0, 1 / 30);
        step(1, 1 / 30);
        if ([1, 100, 1000].includes(tick))
          await compare(`Bit-identical state: boundary ${boundary}, ${tick} ticks`);
        if (tick === 1) await checkGeometry(boundary, `Independent geometry: boundary ${boundary}`);
        if (tick % 20 === 0) await device.queue.onSubmittedWorkDone();
      }
      // Change all causes of obstruction between ticks: terrain, liquid, snow,
      // ice, height scale and boundary mode. No persistent stale geometry allowed.
      const changedGround = terrainValues.slice(),
        changedFluid = fluidValues.slice();
      const cover = new Float32Array((await readBuffers(device, [sims[0].surfaceBuffer]))[0]);
      for (let y = 80; y < 140; y++)
        for (let x = 80; x < 140; x++) {
          const i = y * n + x;
          changedGround[i * 6] += 0.7;
          changedFluid[i * 4] += 2;
          cover[i * 4] += 0.2;
          cover[i * 4 + 1] += 0.3;
        }
      config.heightScale = 22;
      config.atmosphereBoundary = 1 - boundary;
      for (let i = 0; i < 2; i++) {
        device.queue.writeBuffer(terrains[i], 0, changedGround);
        device.queue.writeBuffer(fluids[i], 0, changedFluid);
        device.queue.writeBuffer(sims[i].surfaceBuffer, 0, cover);
        step(i, 1 / 30);
      }
      await compare(`Changed geometry remains bit-identical, starting boundary ${boundary}`);
      await checkGeometry(
        1 - boundary,
        `Cache rebuilt after geometry and boundary changes ${boundary}`
      );
      for (let i = 0; i < 2; i++) {
        sims[i].reset(false);
        step(i, 0);
        step(i, 1 / 30);
      }
      await compare(`Restart air with zero dt, starting boundary ${boundary}`);
      config.atmosphereEnabled = false;
      step(0, 1 / 30);
      step(1, 1 / 30);
      await compare(`Disabled weather, starting boundary ${boundary}`);
    }
    check('No WebGPU validation errors', errors.length === 0, errors);
  } finally {
    sims.forEach((sim) => sim.destroy());
    [...terrains, ...fluids].forEach((buffer) => buffer.destroy());
    device.destroy();
  }
}
run()
  .then(() => {
    window.testResults = { passed: true, results };
  })
  .catch((error) => {
    window.testResults = { passed: false, results, error: String(error) };
    document.querySelector('#results').textContent = JSON.stringify(window.testResults, null, 2);
  });
