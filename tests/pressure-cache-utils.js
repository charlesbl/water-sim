import atmosphere from '../src/shaders/atmosphere.wgsl?raw';
import thermal from '../src/shaders/surfaceThermal.wgsl?raw';
import clouds from '../src/shaders/cloudPhysics.wgsl?raw';
import reference from './pressure-reference.wgsl?raw';

// Install a test-only reference for the three changed kernels. All other passes,
// scheduling and arithmetic use the same production implementation in both arms.
export async function referenceSwitch(device, sim, pairs) {
  const optimizedPipelines = sim.pipelines;
  const originalBindings = sim.bindings.bind(sim);
  const module = device.createShaderModule({
    code: [thermal, clouds, atmosphere, reference].join('\n'),
  });
  const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error');
  if (errors.length) throw new Error(errors.map((m) => m.message).join('\n'));
  const referencePipelines = { ...optimizedPipelines };
  for (const name of ['divergence', 'cgApply', 'cgUpdate']) {
    referencePipelines[name] = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: `reference${name[0].toUpperCase()}${name.slice(1)}` },
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
  const records = pairs.map(([terrain, fluids]) => {
    const optimized = originalBindings(terrain, fluids);
    return {
      terrain,
      fluids,
      optimized,
      reference: {
        ...optimized,
        divergence: sim.volumes.map((volume) =>
          group('divergence', [
            [1, volume],
            [3, sim.columns],
            [8, sim.pressureBuffer],
            [9, sim.divergenceBuffer],
            [13, sim.conjugateState],
          ])
        ),
        cgApply: group('cgApply', [
          [3, sim.columns],
          [13, sim.conjugateState],
          [14, sim.conjugatePartials],
        ]),
        cgUpdate: group('cgUpdate', [
          [3, sim.columns],
          [8, sim.pressureBuffer],
          [13, sim.conjugateState],
          [14, sim.conjugatePartials],
          [15, sim.conjugateCoefficients],
        ]),
      },
    };
  });
  let useReference = false;
  sim.bindings = (terrain, fluids) => {
    const record = records.find((r) => r.terrain === terrain && r.fluids === fluids);
    if (!record) throw new Error('Unregistered buffers in pressure A/B test');
    return record[useReference ? 'reference' : 'optimized'];
  };
  return (enabled) => {
    useReference = enabled;
    sim.pipelines = enabled ? referencePipelines : optimizedPipelines;
  };
}

export async function readBuffers(device, buffers) {
  const size = buffers.reduce((sum, buffer) => sum + buffer.size, 0);
  const staging = device.createBuffer({
    size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  let offset = 0;
  for (const buffer of buffers) {
    encoder.copyBufferToBuffer(buffer, 0, staging, offset, buffer.size);
    offset += buffer.size;
  }
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const copy = staging.getMappedRange().slice(0);
  staging.unmap();
  staging.destroy();
  offset = 0;
  return buffers.map((buffer) => {
    const result = copy.slice(offset, offset + buffer.size);
    offset += buffer.size;
    return result;
  });
}

export function difference(a, b) {
  const wordsA = new Uint32Array(a),
    wordsB = new Uint32Array(b);
  const floatsA = new Float32Array(a),
    floatsB = new Float32Array(b);
  let mismatches = 0,
    maxAbsolute = 0,
    finite = true;
  for (let i = 0; i < wordsA.length; i++) {
    finite &&= Number.isFinite(floatsA[i]) && Number.isFinite(floatsB[i]);
    if (wordsA[i] !== wordsB[i]) {
      mismatches++;
      maxAbsolute = Math.max(maxAbsolute, Math.abs(floatsA[i] - floatsB[i]));
    }
  }
  return { values: wordsA.length, mismatches, maxAbsolute, finite };
}

// Test-only pass timestamps. No clocks, readbacks or switches enter production.
export class PassClock {
  constructor(device) {
    this.device = device;
    this.query = device.createQuerySet({ type: 'timestamp', count: 1024 });
    this.resolve = device.createBuffer({
      size: 8192,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.readback = device.createBuffer({
      size: 8192,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    this.createEncoder = device.createCommandEncoder.bind(device);
    device.createCommandEncoder = (...args) => {
      const encoder = this.createEncoder(...args);
      if (!this.active) return encoder;
      return new Proxy(encoder, {
        get: (target, key) => {
          if (key === 'beginComputePass' || key === 'beginRenderPass') {
            return (descriptor = {}) => {
              const index = this.records.length * 2;
              if (index + 1 >= 1024) throw new Error('Too many benchmark passes');
              this.records.push({ label: descriptor.label ?? key, phase: this.phase });
              return target[key]({
                ...descriptor,
                timestampWrites: {
                  querySet: this.query,
                  beginningOfPassWriteIndex: index,
                  endOfPassWriteIndex: index + 1,
                },
              });
            };
          }
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
  }
  start() {
    this.records = [];
    this.active = true;
  }
  async end() {
    this.active = false;
    const encoder = this.createEncoder();
    encoder.resolveQuerySet(this.query, 0, this.records.length * 2, this.resolve, 0);
    encoder.copyBufferToBuffer(this.resolve, 0, this.readback, 0, this.records.length * 16);
    this.device.queue.submit([encoder.finish()]);
    await this.readback.mapAsync(GPUMapMode.READ);
    const times = new BigUint64Array(this.readback.getMappedRange().slice(0));
    this.readback.unmap();
    const result = { totalSpanMs: Number(times[this.records.length * 2 - 1] - times[0]) / 1e6 };
    const spans = new Map();
    let pressureStart;
    let transportStart;
    let exchangeStart;
    this.records.forEach((record, i) => {
      const duration = Number(times[i * 2 + 1] - times[i * 2]) / 1e6;
      result[record.phase] = (result[record.phase] ?? 0) + duration;
      if (/Atmosphere (divergence|cg|project)/.test(record.label))
        result.pressure = (result.pressure ?? 0) + duration;
      if (record.label === 'Atmosphere divergence') pressureStart = times[i * 2];
      if (record.label === 'Atmosphere project')
        result.pressureSpanMs =
          (result.pressureSpanMs ?? 0) + Number(times[i * 2 + 1] - pressureStart) / 1e6;
      if (record.label === 'Atmosphere prepareCourant') transportStart = times[i * 2];
      if (record.label === 'Atmosphere advect') {
        result.transportSpanMs =
          (result.transportSpanMs ?? 0) +
          Number(times[i * 2 + 1] - (transportStart ?? times[i * 2])) / 1e6;
        transportStart = undefined;
      }
      if (record.label === 'Atmosphere prepareSolar') exchangeStart = times[i * 2];
      if (record.label === 'Atmosphere radiateColumns')
        result.exchangeSpanMs =
          (result.exchangeSpanMs ?? 0) + Number(times[i * 2 + 1] - exchangeStart) / 1e6;
      if (record.label === 'Atmosphere surfaceExchange')
        result.exchangeSpanMs = (result.exchangeSpanMs ?? 0) + duration;
      if (
        /Atmosphere (prepareSolar|normalizeSolar|prepareHeat|exchangeHeat|gatherHeat|radiateColumns|surfaceExchange)$/.test(
          record.label
        )
      )
        result[record.label] = (result[record.label] ?? 0) + duration;
      if (
        /Atmosphere (divergence|cgApply|cgUpdate|advect|prepareCourant|prepareSurfaceMapping)$/.test(
          record.label
        )
      ) {
        result[record.label] = (result[record.label] ?? 0) + duration;
      }
      const span = spans.get(record.phase) ?? { start: times[i * 2], end: 0n };
      span.end = times[i * 2 + 1];
      spans.set(record.phase, span);
    });
    for (const [phase, span] of spans)
      result[`${phase}SpanMs`] = Number(span.end - span.start) / 1e6;
    return result;
  }
  destroy() {
    this.device.createCommandEncoder = this.createEncoder;
    this.query.destroy();
    this.resolve.destroy();
    this.readback.destroy();
  }
}

export function summarize(rows) {
  const result = {};
  for (const key of Object.keys(rows[0])) {
    const values = rows.map((row) => row[key]).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    result[key] = {
      median,
      p95: values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)],
    };
  }
  return result;
}
