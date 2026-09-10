import atmosphere from '../src/shaders/atmosphere.wgsl?raw';
import thermal from '../src/shaders/surfaceThermal.wgsl?raw';
import clouds from '../src/shaders/cloudPhysics.wgsl?raw';
import reference from './transport-reference.wgsl?raw';
import { readBuffers, difference } from './pressure-cache-utils.js';

const referenceCode = [thermal, clouds, atmosphere, reference].join('\n');

// Compare optimization 2 against optimization 1 alone: only advection changes.
export async function transportReferenceSwitch(device, sim, pairs, { localOnly = false } = {}) {
  const optimizedPipelines = sim.pipelines;
  // The optional baseline isolates the extra cache from local sharing (stage A).
  const cachedRead = 'let courant = outgoingCourants[index(donor)];';
  if (localOnly && atmosphere.split(cachedRead).length !== 2)
    throw new Error('Courant benchmark requires exactly one cached donor read');
  const code = localOnly
    ? [
        thermal,
        clouds,
        atmosphere.replace(cachedRead, 'let courant = outgoingCourant(donor);'),
      ].join('\n')
    : referenceCode;
  const module = device.createShaderModule({ code });
  const pipeline = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: { module, entryPoint: localOnly ? 'advect' : 'referenceAdvect' },
  });
  const groups = sim.volumes.map((volume, i) =>
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        [0, sim.uniforms],
        [1, volume],
        [2, sim.volumes[1 - i]],
        [3, sim.columns],
        [12, sim.layerMeans],
        [16, sim.surfaceHeat],
        [22, sim.longwaveHeating],
      ].map(([binding, buffer]) => ({ binding, resource: { buffer } })),
    })
  );
  const records = pairs.map(([terrain, fluids]) => {
    const optimized = sim.bindings(terrain, fluids);
    return { terrain, fluids, optimized, reference: { ...optimized, advect: groups } };
  });
  let useReference = false;
  const step = sim.step.bind(sim);
  // The baseline predates the Courant pass. Omit it entirely, including its
  // timestamps, so A/B timings count all preparation only in the optimized arm.
  sim.step = (encoder, ...args) =>
    step(
      useReference
        ? new Proxy(encoder, {
            get(target, key) {
              if (key === 'beginComputePass')
                return (descriptor) => {
                  if (descriptor?.label === 'Atmosphere prepareCourant')
                    return {
                      setPipeline() {},
                      setBindGroup() {},
                      dispatchWorkgroups() {},
                      end() {},
                    };
                  return target.beginComputePass(descriptor);
                };
              const value = target[key];
              return typeof value === 'function' ? value.bind(target) : value;
            },
          })
        : encoder,
      ...args
    );
  sim.bindings = (terrain, fluids) => {
    const record = records.find((r) => r.terrain === terrain && r.fluids === fluids);
    if (!record) throw new Error('Unregistered buffers in transport A/B test');
    return record[useReference ? 'reference' : 'optimized'];
  };
  return (enabled) => {
    useReference = enabled;
    sim.pipelines = enabled ? { ...optimizedPipelines, advect: pipeline } : optimizedPipelines;
  };
}

// Frozen original fluxes versus the new shared flux calculation, independent of
// cloud microphysics and pressure, including the CFL reconstruction boundary.
export async function checkTransportFaces(device, check) {
  const diagnostics = `
@group(0) @binding(25) var<storage, read_write> fluxResults: array<vec4<f32>>;
@compute @workgroup_size(4, 4, 4)
fn originalFaces(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!inside(id)) { return; }
    let p = vec3<i32>(id);
    let i = index(p) * 8u;
    for (var axis = 0u; axis < 3u; axis++) {
        fluxResults[i + axis * 2u] = referenceWaterFlux(p, axis);
        fluxResults[i + axis * 2u + 1u] = vec4<f32>(referenceHeatFlux(p, axis), 0.0, 0.0, 0.0);
    }
    fluxResults[i + 6u] = referenceTransportWater(p);
    fluxResults[i + 7u] = vec4<f32>(referenceTransportTemperature(p), 0.0, 0.0, 0.0);
}
@compute @workgroup_size(4, 4, 4)
fn sharedFaces(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!inside(id)) { return; }
    let p = vec3<i32>(id);
    let i = index(p) * 8u;
    for (var axis = 0u; axis < 3u; axis++) {
        let flux = scalarFlux(p, axis);
        fluxResults[i + axis * 2u] = flux.water;
        fluxResults[i + axis * 2u + 1u] = vec4<f32>(flux.potential, 0.0, 0.0, 0.0);
    }
    let transported = transportScalars(p);
    fluxResults[i + 6u] = transported.water;
    fluxResults[i + 7u] = vec4<f32>(transported.temperature, 0.0, 0.0, 0.0);
}`;
  const module = device.createShaderModule({ code: referenceCode + diagnostics });
  const pipelines = await Promise.all(
    ['originalFaces', 'sharedFaces'].map((entryPoint) =>
      device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint } })
    )
  );
  const preparation = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: { module, entryPoint: 'prepareCourant' },
  });
  const [nx, ny, nz] = [12, 10, 8],
    cells = nx * ny * nz;
  const spacing = [200 / 96, 200 / 96, 100 / 64],
    dt = 1 / 30;
  const make = (size, usage = GPUBufferUsage.STORAGE) =>
    device.createBuffer({
      size,
      usage: usage | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
  const uniforms = make(128, GPUBufferUsage.UNIFORM),
    volume = make(cells * 32),
    columns = make(nx * ny * 16);
  const output = [make(cells * 128), make(cells * 128)];
  const courantBuffer = make(cells * 4);
  const preparationGroup = device.createBindGroup({
    layout: preparation.getBindGroupLayout(0),
    entries: [
      [0, uniforms],
      [1, volume],
      [3, columns],
      [24, courantBuffer],
    ].map(([binding, buffer]) => ({ binding, resource: { buffer } })),
  });
  const groups = pipelines.map((pipeline, i) =>
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        [0, uniforms],
        [1, volume],
        [3, columns],
        [25, output[i]],
        ...(i === 1 ? [[24, courantBuffer]] : []),
      ].map(([binding, buffer]) => ({ binding, resource: { buffer } })),
    })
  );
  const parameters = new Float32Array(32);
  parameters.set([nx, ny, nz, 257, ...spacing, dt]);
  const columnValues = new Float32Array(nx * ny * 4);
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++)
      columnValues[(y * nx + x) * 4] = x === 0 && y === 0 ? 100 : 0.1 + (x % 3) * spacing[2];
  device.queue.writeBuffer(columns, 0, columnValues);
  const cases = [
    ['calm', [0, 0, 0], 0],
    ['x+ CFL below', [1, 0, 0], 0.4999],
    ['x+ CFL threshold', [1, 0, 0], 0.5],
    ['x+ CFL above', [1, 0, 0], 0.5001],
    ['x+ high CFL', [1, 0, 0], 1.6],
    ['x-', [-1, 0, 0], 0.5001],
    ['y+', [0, 1, 0], 0.4999],
    ['y-', [0, -1, 0], 1.6],
    ['z+', [0, 0, 1], 0.5],
    ['z-', [0, 0, -1], 0.5001],
    ['mixed', [1, -1, 1], 0.5001],
    ['mixed high CFL', [-1, 1, -1], 3],
  ];
  try {
    for (const boundary of [0, 1])
      for (const [name, direction, courant] of cases) {
        parameters[25] = boundary;
        device.queue.writeBuffer(uniforms, 0, parameters);
        const state = new Float32Array(cells * 8);
        const axes = direction.filter(Boolean).length || 1;
        for (let z = 0; z < nz; z++)
          for (let y = 0; y < ny; y++)
            for (let x = 0; x < nx; x++) {
              const i = ((z * ny + y) * nx + x) * 8;
              for (let axis = 0; axis < 3; axis++)
                state[i + axis] = (((direction[axis] * courant) / axes) * spacing[axis]) / dt;
              state[i + 3] = -20 + x * 2 + y * 0.3 - z * 0.6;
              if (x > 1) {
                state[i + 4] = 0.004 + x * 0.0001;
                state[i + 5] = (y % 4) * 0.0005;
                state[i + 6] = (z % 3) * 0.0002;
                state[i + 7] = ((x + y) % 5) * 0.0001;
              }
            }
        device.queue.writeBuffer(volume, 0, state);
        const encoder = device.createCommandEncoder();
        const preparePass = encoder.beginComputePass();
        preparePass.setPipeline(preparation);
        preparePass.setBindGroup(0, preparationGroup);
        preparePass.dispatchWorkgroups(Math.ceil(nx / 4), Math.ceil(ny / 4), Math.ceil(nz / 4));
        preparePass.end();
        pipelines.forEach((pipeline, i) => {
          const pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, groups[i]);
          pass.dispatchWorkgroups(Math.ceil(nx / 4), Math.ceil(ny / 4), Math.ceil(nz / 4));
          pass.end();
        });
        device.queue.submit([encoder.finish()]);
        const [before, after] = await readBuffers(device, output);
        const delta = difference(before, after);
        check(
          `Transport fluxes bit-identical: ${name}, boundary ${boundary}`,
          delta.mismatches === 0 && delta.finite,
          delta
        );
      }
  } finally {
    [uniforms, volume, columns, courantBuffer, ...output].forEach((buffer) => buffer.destroy());
  }
}
