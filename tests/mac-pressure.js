import { AtmospherePressure } from '../src/atmospherePressure.ts';

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
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  // Include the production width: a tiny grid alone cannot demonstrate that
  // long-wavelength pressure errors reach the whole map through multigrid.
  for (const n of [32, 256]) {
    const count = n * n, dx = 200 / n, H = 16;
    const buffer = () => device.createBuffer({ size: count * 2 * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const input = buffer(), output = buffer();
    const solver = new AtmospherePressure(device, n, H);
    const project = async (values, cycles) => {
      device.queue.writeBuffer(input, 0, values);
      const encoder = device.createCommandEncoder();
      solver.encode(encoder, input, output, cycles);
      const readback = device.createBuffer({ size: output.size,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(readback.getMappedRange().slice(0));
      readback.unmap(); readback.destroy();
      return data;
    };
    const metrics = (values) => {
      let energy = 0, divergence = 0, maxDivergence = 0, leak = 0;
      for (let z = 0; z < 2; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const i = y * n + x, j = (i + z * count) * 4;
        const west = x > 0 ? values[j - 4] : 0, south = y > 0 ? values[j - 4 * n + 1] : 0;
        const div = (values[j] - west + values[j + 1] - south) / dx + (z ? -1 : 1) * values[i * 4 + 2] / H;
        divergence += div ** 2; maxDivergence = Math.max(maxDivergence, Math.abs(div));
        energy += 0.5 * (values[j] ** 2 + values[j + 1] ** 2 + values[j + 2] ** 2);
        if (x === n - 1) leak = Math.max(leak, Math.abs(values[j]));
        if (y === n - 1) leak = Math.max(leak, Math.abs(values[j + 1]));
        if (z === 1) leak = Math.max(leak, Math.abs(values[j + 2]));
      }
      return { energy, divergence: Math.sqrt(divergence / (2 * count)), maxDivergence, leak };
    };
    try {
      await solver.init();
      const potential = (x, y, z) => (z ? -0.4 : 1) * 20 * Math.cos(Math.PI * (x + 0.5) / n)
        * Math.cos(2 * Math.PI * (y + 0.5) / n) + 5 * Math.cos(Math.PI * (y + 0.5) / n);
      const gradient = new Float32Array(count * 8);
      for (let z = 0; z < 2; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const j = (x + y * n + z * count) * 4, center = potential(x, y, z);
        if (x + 1 < n) gradient[j] = (potential(x + 1, y, z) - center) / dx;
        if (y + 1 < n) gradient[j + 1] = (potential(x, y + 1, z) - center) / dx;
        if (z === 0) gradient[j + 2] = (potential(x, y, 1) - center) / H;
      }
      const initial = metrics(gradient), rough = metrics(await project(gradient, 1));
      const solvedValues = await project(gradient, 6), solved = metrics(solvedValues);
      check(`${n}: multigrid removes a map-wide gradient in both layers`,
        solved.divergence / initial.divergence < 2e-3 && solved.energy / initial.energy < 1e-4,
        { initial, rough, solved });
      check(`${n}: quality improves residuals`, solved.divergence < rough.divergence * 0.1);
      check(`${n}: walls and lid remain impermeable`, solved.leak === 0 && solvedValues.every(Number.isFinite));

      // An identical horizontal vortex in both layers is legal. The previous
      // forced-opposite model could not represent this depth-averaged mode.
      const psi = (x, y) => x === 0 || y === 0 || x === n || y === n ? 0
        : 20 * Math.sin(Math.PI * x / n) * Math.sin(Math.PI * y / n);
      const vortex = new Float32Array(count * 8);
      for (let z = 0; z < 2; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const j = (x + y * n + z * count) * 4;
        if (x + 1 < n) vortex[j] = (psi(x + 1, y + 1) - psi(x + 1, y)) / dx;
        if (y + 1 < n) vortex[j + 1] = -(psi(x + 1, y + 1) - psi(x, y + 1)) / dx;
      }
      const preserved = await project(vortex, 3);
      let error = 0, reference = 0;
      for (let i = 0; i < vortex.length; i++) { error += (preserved[i] - vortex[i]) ** 2; reference += vortex[i] ** 2; }
      check(`${n}: a common two-layer vortex survives pressure projection`, Math.sqrt(error / reference) < 1e-5);
      check(`${n}: projection does not add kinetic energy`, metrics(preserved).energy <= metrics(vortex).energy * (1 + 1e-6));
    } finally {
      solver.destroy(); input.destroy(); output.destroy();
    }
  }
  check('No GPU validation errors', errors.length === 0, errors);
  device.destroy();
}
run().then(() => { window.testResults = { passed: true, results }; }).catch((error) => {
  window.testResults = { passed: false, results, error: String(error.stack ?? error) };
}).finally(() => { document.querySelector('#results').textContent = JSON.stringify(window.testResults, null, 2); });
