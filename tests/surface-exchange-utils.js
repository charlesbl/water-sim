import atmosphere from '../src/shaders/atmosphere.wgsl?raw';
import thermal from '../src/shaders/surfaceThermal.wgsl?raw';
import clouds from '../src/shaders/cloudPhysics.wgsl?raw';
import reference from './surface-exchange-reference.wgsl?raw';
import { AtmosphereSimulation } from '../src/atmosphere.ts';
import { config } from '../src/config.ts';
import { readBuffers, difference } from './pressure-cache-utils.js';

// Freeze only the three consumers that changed; optimizations 1/2 and all
// other passes remain common. Mapping preparation occurs outside timed steady
// frames and is harmless in the reference, which never reads the table.
export async function surfaceExchangeReferenceSwitch(device, sim, pairs) {
  const module = device.createShaderModule({ code: [thermal, clouds, reference].join('\n') });
  const optimizedPipelines = sim.pipelines;
  const referencePipelines = { ...optimizedPipelines };
  for (const name of ['exchangeHeat', 'gatherHeat', 'surfaceExchange']) {
    referencePipelines[name] = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: name },
    });
  }
  const group = (name, entries) =>
    device.createBindGroup({
      layout: referencePipelines[name].getBindGroupLayout(0),
      entries: [[0, sim.uniforms], ...entries].map(([binding, buffer]) => ({
        binding,
        resource: { buffer },
      })),
    });
  const records = pairs.map(([terrain, fluids]) => ({
    terrain,
    fluids,
    optimized: sim.bindings(terrain, fluids),
    reference: {
      ...sim.bindings(terrain, fluids),
      exchangeHeat: group('exchangeHeat', [
        [4, terrain],
        [5, fluids],
        [6, sim.surfaceBuffer],
        [19, sim.heatProfiles],
        [20, sim.heatTransfers],
      ]),
      gatherHeat: group('gatherHeat', [
        [6, sim.surfaceBuffer],
        [11, sim.depositionWeights],
        [16, sim.surfaceHeat],
        [20, sim.heatTransfers],
        [18, sim.solarNormalization],
      ]),
      surfaceExchange: sim.volumes.map((volume) =>
        group('surfaceExchange', [
          [1, volume],
          [3, sim.columns],
          [4, terrain],
          [5, fluids],
          [6, sim.surfaceBuffer],
          [10, sim.precipitation],
          [11, sim.depositionWeights],
          [18, sim.solarNormalization],
        ])
      ),
    },
  }));
  let useReference = false;
  sim.bindings = (terrain, fluids) => {
    const record = records.find((r) => r.terrain === terrain && r.fluids === fluids);
    if (!record) throw new Error('Unregistered buffers in surface exchange A/B test');
    return record[useReference ? 'reference' : 'optimized'];
  };
  return (enabled) => {
    useReference = enabled;
    sim.pipelines = enabled ? referencePipelines : optimizedPipelines;
  };
}

// Compare the table's actual consumers against the original per-cell floating
// coordinates and wrapped/clamped columnIndex, including repeated border changes.
export async function checkSurfaceMapping(device, check) {
  const originalDiagnostics = `
@group(0) @binding(25) var<storage, read_write> mappingResults: array<vec4<f32>>;
@compute @workgroup_size(16, 16)
fn captureOriginalMapping(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy >= vec2<u32>(u32(u.grid.w)))) { return; }
    let i = (id.y * u32(u.grid.w) + id.x) * 2u;
    let xy = (vec2<f32>(id.xy) + 0.5) * u.grid.xy / u.grid.w - 0.5;
    let base = vec2<i32>(floor(xy));
    for (var y = 0; y < 2; y++) {
        for (var x = 0; x < 2; x++) {
            mappingResults[i][y * 2 + x] = f32(columnIndex(vec3<i32>(base + vec2<i32>(x, y), 0)));
        }
    }
    mappingResults[i + 1u] = vec4<f32>(fract(xy), 0.0, 0.0);
}`;
  const cachedDiagnostics = `
@group(0) @binding(25) var<storage, read_write> mappingResults: array<vec4<f32>>;
@compute @workgroup_size(16, 16)
fn captureCachedMapping(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy >= vec2<u32>(u32(u.grid.w)))) { return; }
    let i = (id.y * u32(u.grid.w) + id.x) * 2u;
    let mapping = surfaceMapping(id.xy);
    mappingResults[i] = vec4<f32>(mapping.columns);
    mappingResults[i + 1u] = vec4<f32>(mapping.fraction, 0.0, 0.0);
}`;
  const pipelines = await Promise.all(
    [
      [reference, originalDiagnostics, 'captureOriginalMapping'],
      [atmosphere, cachedDiagnostics, 'captureCachedMapping'],
    ].map(async ([source, diagnostics, entryPoint]) =>
      device.createComputePipelineAsync({
        layout: 'auto',
        compute: {
          module: device.createShaderModule({
            code: [thermal, clouds, source, diagnostics].join('\n'),
          }),
          entryPoint,
        },
      })
    )
  );
  for (const n of [49, 257]) {
    const make = (size) =>
      device.createBuffer({
        size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });
    const terrain = make(n * n * 24),
      fluids = make(n * n * 16),
      outputs = [make(n * n * 32), make(n * n * 32)];
    const sim = new AtmosphereSimulation(device, n);
    await sim.init();
    const groups = pipelines.map((pipeline, i) =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          [0, sim.uniforms],
          [25, outputs[i]],
          ...(i === 1 ? [[18, sim.solarNormalization]] : []),
        ].map(([binding, buffer]) => ({ binding, resource: { buffer } })),
      })
    );
    try {
      for (const [round, boundary] of [0, 1, 0].entries()) {
        config.atmosphereBoundary = boundary;
        sim.reset(false);
        const encoder = device.createCommandEncoder();
        sim.step(encoder, terrain, fluids, 0);
        pipelines.forEach((pipeline, i) => {
          const pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, groups[i]);
          pass.dispatchWorkgroups(Math.ceil(n / 16), Math.ceil(n / 16));
          pass.end();
        });
        device.queue.submit([encoder.finish()]);
        const values = await readBuffers(device, outputs);
        const delta = difference(values[0], values[1]);
        check(
          `Surface mapping bit-identical: ${n}, boundary ${boundary}, change ${round}`,
          delta.mismatches === 0 && delta.finite,
          delta
        );
      }
    } finally {
      sim.destroy();
      [terrain, fluids, ...outputs].forEach((buffer) => buffer.destroy());
    }
  }
}
