import shader from './shaders/atmospherePressure.wgsl?raw';

const PASSES = ['buildRhs', 'relaxPressure', 'residual', 'restrictResidual', 'prolong', 'project'] as const;
type Pass = (typeof PASSES)[number];
interface Level {
  width: number;
  uniform: GPUBuffer;
  pressure: [GPUBuffer, GPUBuffer];
  rhs: GPUBuffer;
  residual: GPUBuffer;
}

/** Geometric V-cycles in XY, with exact two-layer block relaxation in Z. */
export class AtmospherePressure {
  private readonly levels: Level[] = [];
  private pipelines!: Record<Pass, GPUComputePipeline>;
  private readonly groups = new Map<string, GPUBindGroup>();
  private readonly ids = new WeakMap<GPUBuffer, number>();
  private nextId = 0;

  constructor(private readonly device: GPUDevice, width: number, depth: number) {
    let size = width;
    for (;;) {
      // Production resolutions are powers of two. Odd diagnostic grids stop
      // coarsening here and use a longer solve on their last valid level.
      const child = size > 1 && size % 2 === 0 ? size / 2 : 0;
      const storage = (name: string) => device.createBuffer({
        label: `Weather pressure ${size} ${name}`, size: size * size * 8,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      const uniform = device.createBuffer({
        label: `Pressure grid ${size}`, size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(uniform, 0, new Uint32Array([size, size, child, child]));
      device.queue.writeBuffer(uniform, 16, new Float32Array([
        (size / 200) ** 2, (size / 200) ** 2, 1 / depth ** 2, 2 / 3,
      ]));
      this.levels.push({ width: size, uniform, pressure: [storage('A'), storage('B')],
        rhs: storage('rhs'), residual: storage('residual') });
      if (!child) break;
      size = child;
    }
  }

  async init(): Promise<void> {
    const module = this.device.createShaderModule({ label: 'Coupled MAC pressure multigrid', code: shader });
    const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error');
    if (errors.length) throw new Error(errors.map((m) => `Pressure ${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
    const pipelines = await Promise.all(PASSES.map(async (name) => [name,
      await this.device.createComputePipelineAsync({ label: `Pressure ${name}`, layout: 'auto',
        compute: { module, entryPoint: name } }),
    ] as const));
    this.pipelines = Object.fromEntries(pipelines) as Record<Pass, GPUComputePipeline>;
  }

  private group(name: Pass, entries: Array<[number, GPUBuffer]>): GPUBindGroup {
    const key = name + entries.map(([binding, buffer]) => {
      if (!this.ids.has(buffer)) this.ids.set(buffer, this.nextId++);
      return `/${binding}:${this.ids.get(buffer)}`;
    }).join('');
    let group = this.groups.get(key);
    if (!group) {
      group = this.device.createBindGroup({ label: `Pressure ${name}`,
        layout: this.pipelines[name].getBindGroupLayout(0),
        entries: entries.map(([binding, buffer]) => ({ binding, resource: { buffer } })),
      });
      this.groups.set(key, group);
    }
    return group;
  }

  encode(encoder: GPUCommandEncoder, velocity: GPUBuffer, output: GPUBuffer, cycles: number): void {
    const active = this.levels.map(() => 0);
    const dispatch = (name: Pass, level: Level, entries: Array<[number, GPUBuffer]>, size = level.width, z = 1) => {
      const pass = encoder.beginComputePass({ label: `Pressure ${name} ${level.width}` });
      pass.setPipeline(this.pipelines[name]);
      pass.setBindGroup(0, this.group(name, [[0, level.uniform], ...entries]));
      pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8), z);
      pass.end();
    };
    const smooth = (depth: number, iterations: number) => {
      const level = this.levels[depth];
      for (let j = 0; j < iterations; j++) {
        const current = active[depth];
        dispatch('relaxPressure', level, [[1, level.pressure[current]], [2, level.rhs], [3, level.pressure[1 - current]]]);
        active[depth] = 1 - current;
      }
    };
    const cycle = (depth: number) => {
      const level = this.levels[depth];
      if (depth === this.levels.length - 1) {
        smooth(depth, level.width === 1 ? 1 : 96);
        return;
      }
      smooth(depth, 3);
      dispatch('residual', level, [[1, level.pressure[active[depth]]], [2, level.rhs], [3, level.residual]]);
      const child = this.levels[depth + 1];
      dispatch('restrictResidual', level, [[1, level.residual], [3, child.rhs]], child.width);
      encoder.clearBuffer(child.pressure[0]); encoder.clearBuffer(child.pressure[1]);
      active[depth + 1] = 0;
      cycle(depth + 1);
      const current = active[depth];
      dispatch('prolong', level, [[1, level.pressure[current]], [2, child.pressure[active[depth + 1]]],
        [3, level.pressure[1 - current]]]);
      active[depth] = 1 - current;
      smooth(depth, 3);
    };
    const finest = this.levels[0];
    encoder.clearBuffer(finest.pressure[0]); encoder.clearBuffer(finest.pressure[1]);
    dispatch('buildRhs', finest, [[3, finest.rhs], [4, velocity]]);
    for (let i = 0; i < cycles; i++) cycle(0);
    dispatch('project', finest, [[1, finest.pressure[active[0]]], [4, velocity], [5, output]], finest.width, 2);
  }

  destroy(): void {
    for (const level of this.levels) {
      for (const buffer of [level.uniform, ...level.pressure, level.rhs, level.residual]) buffer.destroy();
    }
    this.groups.clear();
  }
}
