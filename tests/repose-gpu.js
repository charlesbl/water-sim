import { config } from '../src/config.ts';
import {
  angleToReposeSlope,
  reposeSlopeToAngle,
  setupReposeControls,
} from '../src/reposeControls.ts';
import { GPGPUSimulation } from '../src/webgpuRenderer.ts';

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
async function run() {
  // Exercise the actual application markup and event handlers, including range
  // sanitization by the browser. Do not duplicate the sliders in this fixture.
  const html = await (await fetch(import.meta.env.BASE_URL)).text();
  const app = new DOMParser().parseFromString(html, 'text/html');
  const ids = [
    'soil-static-repose-slope',
    'sand-static-repose-slope',
    'sand-dynamic-repose-slope',
    'soil-dynamic-repose-slope',
  ];
  for (const id of ids) {
    document
      .querySelector('#controls')
      .append(app.querySelector(`#${id}`).closest('.control-group').cloneNode(true));
  }
  const defaults = [
    config.soilStaticReposeSlope,
    config.sandStaticReposeSlope,
    config.sandDynamicReposeSlope,
    config.soilDynamicReposeSlope,
  ];
  setupReposeControls();
  check(
    'Soil and sand controls use the same name, degree units and 0–89 range',
    ids.every((id) => {
      const slider = document.querySelector(`#${id}`);
      return (
        slider.min === '0' &&
        slider.max === '89' &&
        slider.step === '0.1' &&
        document.querySelector(`label[for="${id}"]`).textContent.includes('Angle of Repose') &&
        document.querySelector(`#${id}-val`).textContent.endsWith('°') &&
        slider.getAttribute('aria-valuetext').endsWith(' degrees')
      );
    })
  );
  check(
    'Existing defaults display approximately 70°, 43°, 20° and 55° without changing the terrain settings',
    ids.every(
      (id, i) =>
        Math.abs(document.querySelector(`#${id}`).valueAsNumber - [70, 43, 20, 55][i]) < 0.5
    ) &&
      defaults.every(
        (v, i) =>
          v ===
          [
            config.soilStaticReposeSlope,
            config.sandStaticReposeSlope,
            config.sandDynamicReposeSlope,
            config.soilDynamicReposeSlope,
          ][i]
      )
  );
  check(
    'A 45° face rises one world unit per world unit',
    Math.abs(angleToReposeSlope(45, 200, 10) - 0.1) < 1e-12 &&
      Math.abs(reposeSlopeToAngle(0.1, 200, 10) - 45) < 1e-12
  );
  check(
    'Angle conversion accounts for grid spacing and height exaggeration',
    Math.abs(angleToReposeSlope(45, 400, 10) - 0.05) < 1e-12 &&
      Math.abs(angleToReposeSlope(45, 200, 20) - 0.05) < 1e-12
  );
  const setAngle = (id, angle) => {
    const slider = document.querySelector(`#${id}`);
    slider.value = String(angle);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  };
  setAngle(ids[0], 45);
  setAngle(ids[1], 45);
  check(
    'The same displayed angle sets the same physical threshold for sand and soil',
    config.soilStaticReposeSlope === config.sandStaticReposeSlope
  );
  setAngle(ids[0], 0);
  check(
    'Soil can now be set below the former 62° minimum, all the way to flat',
    config.soilStaticReposeSlope === 0 &&
      document.querySelector(`#${ids[0]}-val`).textContent === '0.0°'
  );
  setAngle(ids[0], 89);
  check(
    'Near-vertical angles stay finite',
    Number.isFinite(config.soilStaticReposeSlope) &&
      Math.abs(
        reposeSlopeToAngle(config.soilStaticReposeSlope, config.gridSize, config.heightScale) - 89
      ) < 1e-9
  );
  setAngle(ids[1], 10);
  check(
    'Lowering sand static angle keeps the dynamic angle consistent',
    config.sandStaticReposeSlope === config.sandDynamicReposeSlope &&
      document.querySelector(`#${ids[2]}-val`).textContent === '10.0°'
  );
  setAngle(ids[2], 30);
  check(
    'Raising sand dynamic angle updates the static angle and its display',
    config.sandStaticReposeSlope === config.sandDynamicReposeSlope &&
      document.querySelector(`#${ids[1]}-val`).textContent === '30.0°'
  );
  setAngle(ids[3], 70);
  setAngle(ids[0], 50);
  check(
    'Soil static and dynamic controls stay ordered independently of sand',
    config.soilStaticReposeSlope === config.soilDynamicReposeSlope &&
      document.querySelector(`#${ids[3]}-val`).textContent === '50.0°' &&
      document.querySelector(`#${ids[1]}-val`).textContent === '30.0°'
  );
  setAngle(ids[3], 80);
  check(
    'Raising soil dynamic angle updates only its own static threshold',
    document.querySelector(`#${ids[0]}-val`).textContent === '80.0°' &&
      document.querySelector(`#${ids[1]}-val`).textContent === '30.0°'
  );

  const n = 128;
  Object.assign(config, {
    gridSize: n,
    terrainType: 1,
    flatRockHeight: 0.1,
    terrainSandHeight: 0,
    terrainSoilHeight: 0,
    paused: false,
    atmosphereEnabled: false,
    erosionRate: 0,
    sedimentSlideRate: 0.1,
    closedWaterCycle: true,
  });
  const engine = new GPGPUSimulation(document.querySelector('canvas'), n);
  check('Production engine initializes for the live angle test', await engine.initWebGPU());
  const errors = [];
  engine.device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  engine.step();
  const current = () => (engine.pingPongToggle ? engine.terrainBufferB : engine.terrainBufferA);
  const ground = new Float32Array(n * n * 6);
  for (let i = 0; i < n * n; i++) ground[i * 6] = 0.1;
  const center = (64 * n + 64) * 6;
  ground[center + 4] = 0.3;
  engine.device.queue.writeBuffer(current(), 0, ground);
  setAngle(ids[0], 86);
  for (let i = 0; i < 20; i++) engine.step();
  const steep = await read(engine.device, current());
  check(
    'An 86° soil setting retains an existing steep pile',
    steep[center + 4] === ground[center + 4]
  );
  setAngle(ids[3], 10);
  setAngle(ids[0], 10);
  for (let i = 0; i < 300; i++) engine.step();
  const flat = await read(engine.device, current());
  let mass = 0,
    maxAngle = 0;
  for (let y = 1; y < n - 1; y++)
    for (let x = 1; x < n - 1; x++) {
      const i = (y * n + x) * 6;
      mass += flat[i + 4];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const heightDifference = flat[i + 4] - flat[((y + dy) * n + x + dx) * 6 + 4];
          const angle =
            (Math.atan2(heightDifference * config.heightScale, (Math.hypot(dx, dy) * 200) / n) *
              180) /
            Math.PI;
          maxAngle = Math.max(maxAngle, angle);
        }
    }
  check(
    'Lowering the live soil angle spreads the same pile to the requested slope',
    flat[center + 4] < steep[center + 4] * 0.5 && maxAngle <= 10.1,
    `maximum face angle=${maxAngle}°`
  );
  check(
    'Changing the angle conserves soil and leaves rock fixed',
    Math.abs(mass - 0.3) < 1e-6 && flat.every((v, i) => i % 6 !== 0 || v === ground[i])
  );
  setAngle(ids[3], 86);
  for (let i = 0; i < 20; i++) engine.step();
  const raised = await read(engine.device, current());
  check(
    'Increasing the repose limits does not rebuild a settled pile',
    raised.every((v, i) => i % 6 !== 4 || v === flat[i])
  );
  check('No WebGPU validation errors', errors.length === 0, errors.join('\n'));
  window.testResults = { passed: true, results };
}
run().catch((error) => {
  console.error(error);
  window.testResults = { passed: false, error: String(error), results };
});
