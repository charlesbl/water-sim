import * as THREE from 'three';
import { config } from '../src/config.ts';
import { AtmosphereRenderer } from '../src/atmosphereRenderer.ts';

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed: !!passed, detail });
  if (!passed) throw new Error(`${name}: ${detail}`);
}
async function run() {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const buffer = (values) => {
    const result = device.createBuffer({
      size: values.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(result, 0, values);
    return result;
  };
  const air = new Float32Array(16 * 16 * 2 * 8);
  for (let i = 0; i < air.length; i += 8) {
    air[i + 3] = 12;
    air[i + 5] = 0.03;
  }
  const atmosphere = {
    dimensions: [16, 16, 2],
    simulationTime: 1,
    domainHeight: 100,
    volumeBuffer: buffer(air),
    columns: buffer(new Float32Array(16 * 16 * 4)),
    weatherMap: buffer(new Float32Array(16 * 16 * 4)),
  };
  const renderer = new AtmosphereRenderer(device, 'rgba8unorm', atmosphere);
  await renderer.init();
  Object.assign(config, {
    atmosphereEnabled: true,
    atmosphereSlice: 0,
    showWind: false,
    cloudOpacity: 1,
    cloudAltitude: 0.75,
    cloudThickness: 1.5,
    cloudDetail: 0,
    weatherMapSizeKm: 10,
    rainVisibility: 0,
    cloudShadows: 0,
  });
  const color = device.createTexture({
    size: [16, 16],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const depth = device.createTexture({
    size: [16, 16],
    format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const readback = device.createBuffer({
    size: 16 * 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  camera.up.set(0, 0, 1);
  camera.position.set(0, -150, 30);
  camera.lookAt(0, 0, 30);
  camera.updateMatrixWorld();
  const mvp = new THREE.Matrix4()
    .set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
    .multiply(camera.projectionMatrix)
    .multiply(camera.matrixWorldInverse);
  const render = async (ground = false) => {
    const encoder = device.createCommandEncoder();
    const clear = encoder.beginRenderPass({
      colorAttachments: [
        { view: color.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
      ],
      depthStencilAttachment: {
        view: depth.createView(),
        depthClearValue: ground ? 0.5 : 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    clear.end();
    renderer.render(
      encoder,
      color.createView(),
      depth.createView(),
      ground ? new THREE.Matrix4() : mvp,
      ground ? new THREE.Vector3(0, 0, 50) : camera.position
    );
    encoder.copyTextureToBuffer(
      { texture: color },
      { buffer: readback, bytesPerRow: 256 },
      [16, 16]
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(readback.getMappedRange()).slice();
    readback.unmap();
    return pixels;
  };
  config.atmosphereView = 0;
  config.viewOpacity = 0;
  const clouds = await render();
  check('None and zero overlay opacity still render clouds', clouds[8 * 256 + 8 * 4 + 3] > 100);
  for (let view = 0; view <= 5; view++) {
    config.atmosphereView = view;
    for (const opacity of [0, 0.5, 1]) {
      config.viewOpacity = opacity;
      const pixels = await render();
      check(
        `Cloud pixels unchanged in view ${view} at opacity ${opacity}`,
        pixels.every((value, index) => value === clouds[index])
      );
    }
  }
  config.cloudOpacity = 0;
  config.atmosphereView = 0;
  const empty = await render(true);
  check(
    'Cloud opacity can independently hide clouds',
    empty.every((value) => value === 0)
  );
  for (let view = 1; view <= 5; view++) {
    config.atmosphereView = view;
    for (const opacity of [0, 0.5, 1]) {
      config.viewOpacity = opacity;
      const pixels = await render(true);
      check(
        `Overlay ${view} follows its own opacity ${opacity}`,
        Math.abs(pixels[8 * 256 + 8 * 4 + 3] - Math.round(255 * opacity)) <= 1
      );
    }
  }
  check('No GPU validation errors', errors.length === 0, errors.join('\n'));
  renderer.destroy();
  device.destroy();
  window.testResults = { passed: true, results };
}
run().catch((error) => {
  window.testResults = { passed: false, results, error: String(error) };
});
