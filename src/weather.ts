import boundaryShader from './shaders/boundaryFlux.wgsl?raw';
import { config } from './config';
import shader from './shaders/weather.wgsl?raw';
import materials from './shaders/surfaceThermal.wgsl?raw';

export const WEATHER_TIMESTEP = 1 / 20;
export const CLIMATE_TOP = 32; // Fixed scene altitude, independent of terrain edits.
const passes = [
  'initialize',
  'clearCover',
  'eraseClouds',
  'heatPulse',
  'diffuse',
  'evolve',
  'summarize',
  'canopy',
  'canopyTop',
  'reduceFlux',
] as const;
type Pass = (typeof passes)[number];

/** Painted precipitation and surface thermodynamics. No simulated atmosphere. */
export class WeatherSimulation {
  public readonly surfaceBuffer: GPUBuffer; // snow SWE, ice SWE, temperature, painted cloud intensity
  public readonly weatherMap: GPUBuffer; // mean surface height, cloud intensity, temperature, maximum surface height
  public readonly energyFlux: GPUBuffer;
  public readonly cloudCanopy: GPUBuffer;
  public readonly waterExchange: GPUBuffer; // cumulative rain, evaporation and boundary drainage, in scene volume
  public readonly mapSize: number;
  public simulationTime = 0;
  private readonly diffusion: GPUBuffer;
  private readonly partials: GPUBuffer;
  private readonly uniform: GPUBuffer;
  private readonly pulse: GPUBuffer;
  private readonly boundaryUniform: GPUBuffer;
  private boundaryPipeline!: GPUComputePipeline;
  private readonly boundaryGroups = new WeakMap<GPUBuffer, GPUBindGroup>();
  private pipelines!: Record<Pass, GPUComputePipeline>;
  private pendingReset = true;
  private pendingClear = false;
  private readonly cache = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, Record<Pass, GPUBindGroup>>>();

  constructor(
    private readonly device: GPUDevice,
    public readonly size: number
  ) {
    this.mapSize = Math.min(256, size);
    const storage = (label: string, bytes: number) =>
      device.createBuffer({
        label,
        size: bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });
    this.surfaceBuffer = storage('Snow, ice, temperature and painted clouds', size * size * 16);
    this.cloudCanopy = storage('Smooth cloud canopy and maximum', (32 * 32 + 1) * 4);
    this.diffusion = storage('Conservative thermal exchange', size * size * 8);
    this.weatherMap = storage('Weather render summary', this.mapSize ** 2 * 16);
    this.partials = storage('Applied weather flux partials', Math.ceil(size / 16) ** 2 * 16);
    this.energyFlux = storage('Absorbed sun and radiative cooling', 16);
    this.waterExchange = storage('External precipitation, evaporation and drainage', 16);
    this.uniform = device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.boundaryUniform = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pulse = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  async init(): Promise<void> {
    this.boundaryPipeline = await this.device.createComputePipelineAsync({
      layout: 'auto',
      compute: {
        module: this.device.createShaderModule({ code: boundaryShader }),
        entryPoint: 'main',
      },
    });
    const module = this.device.createShaderModule({
      label: 'Painted weather',
      code: materials + '\n' + shader,
    });
    const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error');
    if (errors.length)
      throw new Error(errors.map((m) => `Weather ${m.lineNum}: ${m.message}`).join('\n'));
    this.pipelines = Object.fromEntries(
      await Promise.all(
        passes.map(async (name) => [
          name,
          await this.device.createComputePipelineAsync({
            label: name,
            layout: 'auto',
            compute: { module, entryPoint: name },
          }),
        ])
      )
    ) as Record<Pass, GPUComputePipeline>;
  }

  private bindings(terrain: GPUBuffer, fluids: GPUBuffer): Record<Pass, GPUBindGroup> {
    let byFluid = this.cache.get(terrain);
    if (!byFluid) {
      byFluid = new WeakMap();
      this.cache.set(terrain, byFluid);
    }
    let groups = byFluid.get(fluids);
    if (groups) return groups;
    const buffers = [
      this.uniform,
      terrain,
      fluids,
      this.surfaceBuffer,
      this.diffusion,
      this.weatherMap,
      this.partials,
      this.energyFlux,
      this.waterExchange,
      this.pulse,
      this.cloudCanopy,
    ];
    const used: Record<Pass, number[]> = {
      initialize: [0, 3],
      clearCover: [0, 3],
      eraseClouds: [0, 3],
      heatPulse: [0, 1, 2, 3, 9],
      diffuse: [0, 1, 2, 3, 4],
      evolve: [0, 1, 2, 3, 4, 6],
      summarize: [0, 1, 2, 3, 5],
      canopy: [0, 5, 10],
      canopyTop: [10],
      reduceFlux: [0, 6, 7, 8],
    };
    groups = Object.fromEntries(
      passes.map((name) => [
        name,
        this.device.createBindGroup({
          layout: this.pipelines[name].getBindGroupLayout(0),
          entries: used[name].map((binding) => ({
            binding,
            resource: { buffer: buffers[binding] },
          })),
        }),
      ])
    ) as Record<Pass, GPUBindGroup>;
    byFluid.set(fluids, groups);
    return groups;
  }

  step(encoder: GPUCommandEncoder, terrain: GPUBuffer, fluids: GPUBuffer, dt: number): void {
    const step = config.weatherEnabled
      ? Math.max(0, Math.min(WEATHER_TIMESTEP, Number.isFinite(dt) ? dt : 0))
      : 0;
    const elevation = (config.sunElevation * Math.PI) / 180,
      azimuth = (config.sunAzimuth * Math.PI) / 180;
    this.device.queue.writeBuffer(
      this.uniform,
      0,
      new Float32Array([
        this.size,
        this.mapSize,
        step,
        config.heightScale,
        Math.cos(elevation) * Math.cos(azimuth),
        Math.cos(elevation) * Math.sin(azimuth),
        Math.sin(elevation),
        config.solarHeating,
        config.coolingLow,
        config.coolingMiddle,
        config.coolingHigh,
        config.coolingMiddleAltitude,
        CLIMATE_TOP,
        config.cloudShadows,
        config.rainRate,
        config.evaporationRate,
        this.simulationTime + step,
        Math.ceil(this.size / 16) ** 2,
        config.albedoStrength,
        0,
        config.cloudAltitude,
        14,
        32,
        0,
      ])
    );
    const groups = this.bindings(terrain, fluids);
    const run = (name: Pass, n = this.size) => {
      const pass = encoder.beginComputePass({ label: name });
      pass.setPipeline(this.pipelines[name]);
      pass.setBindGroup(0, groups[name]);
      if (name === 'reduceFlux' || name === 'canopyTop') pass.dispatchWorkgroups(1);
      else pass.dispatchWorkgroups(Math.ceil(n / 16), Math.ceil(n / 16));
      pass.end();
    };
    if (this.pendingReset) {
      run('initialize');
      encoder.clearBuffer(this.waterExchange);
      encoder.clearBuffer(this.energyFlux);
      this.pendingReset = false;
      this.pendingClear = false;
    }
    if (this.pendingClear) {
      run('clearCover');
      this.pendingClear = false;
    }
    if (this.clearCloudsPending) {
      run('eraseClouds');
      this.clearCloudsPending = false;
    }
    if (step > 0) {
      run('diffuse');
      run('evolve');
      run('reduceFlux');
      this.simulationTime += step;
    }
    // Also refresh after painting or editing terrain while paused.
    run('summarize', this.mapSize);
    run('canopy', 32);
    run('canopyTop');
  }

  addSurfaceHeat(
    encoder: GPUCommandEncoder,
    terrain: GPUBuffer,
    fluids: GPUBuffer,
    x: number,
    y: number,
    radius: number,
    energy: number
  ): void {
    this.step(encoder, terrain, fluids, 0);
    this.device.queue.writeBuffer(this.pulse, 0, new Float32Array([x, y, radius, energy]));
    const pass = encoder.beginComputePass({ label: 'Manual heat impulse' });
    pass.setPipeline(this.pipelines.heatPulse);
    pass.setBindGroup(0, this.bindings(terrain, fluids).heatPulse);
    pass.dispatchWorkgroups(Math.ceil(this.size / 16), Math.ceil(this.size / 16));
    pass.end();
  }

  recordOutflow(encoder: GPUCommandEncoder, flux: GPUBuffer): void {
    this.device.queue.writeBuffer(
      this.boundaryUniform,
      0,
      new Float32Array([this.size, config.heightScale, 0, 0])
    );
    let group = this.boundaryGroups.get(flux);
    if (!group) {
      group = this.device.createBindGroup({
        layout: this.boundaryPipeline.getBindGroupLayout(0),
        entries: [this.boundaryUniform, flux, this.waterExchange].map((buffer, binding) => ({
          binding,
          resource: { buffer },
        })),
      });
      this.boundaryGroups.set(flux, group);
    }
    const pass = encoder.beginComputePass({ label: 'Measure water leaving open boundaries' });
    pass.setPipeline(this.boundaryPipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  reset(): void {
    this.pendingReset = true;
    this.simulationTime = 0;
  }
  clearSurface(): void {
    this.pendingClear = true;
  }
  clearClouds(): void {
    // Cloud clearing uses a dedicated surface component; preserves water and heat.
    this.clearCloudsPending = true;
  }
  private clearCloudsPending = false;
  destroy(): void {
    for (const b of [
      this.surfaceBuffer,
      this.weatherMap,
      this.cloudCanopy,
      this.diffusion,
      this.partials,
      this.uniform,
      this.pulse,
      this.boundaryUniform,
      this.energyFlux,
      this.waterExchange,
    ])
      b.destroy();
  }
}
