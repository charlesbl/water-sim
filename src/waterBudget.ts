import { config } from './config';
import waterBudgetWGSL from './shaders/waterBudget.wgsl?raw';

export interface WaterInventory {
  total: number;
  liquid: number;
  snow: number;
  ice: number;
  vapor: number;
  cloud: number;
  rain: number;
  airSnow: number;
  pending: number;
  steam: number;
  /** Fractional variation from baseline; multiply by 100 for a percentage. */
  relativeDrift: number;
  baseline: number;
}

/** A two-stage GPU inventory; only 64 bytes return to the CPU per sample. */
export class WaterBudget {
  public latest: WaterInventory | null = null;

  private uniforms: GPUBuffer | null = null;
  private partials: GPUBuffer | null = null;
  private totals: GPUBuffer | null = null;
  private readback: GPUBuffer | null = null;
  private layout: GPUBindGroupLayout | null = null;
  private partialPipeline: GPUComputePipeline | null = null;
  private totalPipeline: GPUComputePipeline | null = null;
  private readonly partialCount: number;
  private readonly airCount: number;
  private readonly uniformData = new ArrayBuffer(32);
  private readonly uniformInts = new Uint32Array(this.uniformData);
  private readonly uniformFloats = new Float32Array(this.uniformData);
  private baseline: number | null = null;
  private epoch = 0;
  private busy = false;
  private destroyed = false;
  private lastSampleAt = -Infinity;
  private reportedReadError = false;

  constructor(
    private readonly device: GPUDevice,
    private readonly surfaceSize: number,
    dimensions: readonly [number, number, number],
    private readonly domainHeight: number
  ) {
    this.airCount = dimensions[0] * dimensions[1] * dimensions[2];
    this.partialCount = Math.ceil(Math.max(surfaceSize * surfaceSize, this.airCount) / 256);
  }

  async init(): Promise<void> {
    const module = this.device.createShaderModule({
      label: 'Water inventory reduction',
      code: waterBudgetWGSL,
    });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((message) => message.type === 'error');
    if (errors.length) {
      throw new Error(
        `Water budget shader: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n')}`
      );
    }

    this.uniforms = this.device.createBuffer({
      label: 'Water inventory parameters',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.partials = this.device.createBuffer({
      label: 'Water inventory partial sums',
      size: this.partialCount * 64,
      usage: GPUBufferUsage.STORAGE,
    });
    this.totals = this.device.createBuffer({
      label: 'Water inventory totals',
      size: 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.readback = this.device.createBuffer({
      label: 'Water inventory 64-byte readback',
      size: 64,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    this.layout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    [this.partialPipeline, this.totalPipeline] = await Promise.all([
      this.device.createComputePipelineAsync({
        label: 'Water inventory cell reduction',
        layout,
        compute: { module, entryPoint: 'reduce_cells' },
      }),
      this.device.createComputePipelineAsync({
        label: 'Water inventory final reduction',
        layout,
        compute: { module, entryPoint: 'reduce_totals' },
      }),
    ]);
  }

  /** Sample current post-step buffers, including while the simulation is paused. */
  sample(fluids: GPUBuffer, surface: GPUBuffer, volume: GPUBuffer): void {
    const now = performance.now();
    if (
      this.destroyed ||
      this.busy ||
      !this.partialPipeline ||
      !this.totalPipeline ||
      now - this.lastSampleAt < 1000
    ) {
      return;
    }
    this.busy = true;
    this.lastSampleAt = now;
    const epoch = this.epoch;
    try {
      this.uniformInts[0] = this.surfaceSize;
      this.uniformInts[1] = this.airCount;
      this.uniformInts[2] = this.partialCount;
      // Every component is measured as equivalent liquid-water volume, not
      // geometric snow/ice depth. Steam is also a true water reservoir.
      this.uniformFloats[4] = (200 / this.surfaceSize) ** 2 * config.heightScale;
      this.uniformFloats[5] = (40000 * this.domainHeight) / this.airCount;
      this.device.queue.writeBuffer(this.uniforms!, 0, this.uniformData);
      const bindGroup = this.device.createBindGroup({
        layout: this.layout!,
        entries: [
          { binding: 0, resource: { buffer: this.uniforms! } },
          { binding: 1, resource: { buffer: fluids } },
          { binding: 2, resource: { buffer: surface } },
          { binding: 3, resource: { buffer: volume } },
          { binding: 4, resource: { buffer: this.partials! } },
          { binding: 5, resource: { buffer: this.totals! } },
        ],
      });
      const encoder = this.device.createCommandEncoder({ label: 'Water inventory sample' });
      const pass = encoder.beginComputePass({ label: 'Water inventory reductions' });
      pass.setBindGroup(0, bindGroup);
      pass.setPipeline(this.partialPipeline);
      pass.dispatchWorkgroups(this.partialCount);
      pass.setPipeline(this.totalPipeline);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(this.totals!, 0, this.readback!, 0, 64);
      this.device.queue.submit([encoder.finish()]);
      void this.consumeReadback(this.readback!, epoch);
    } catch (error) {
      this.busy = false;
      this.reportError(error, epoch);
    }
  }

  private async consumeReadback(buffer: GPUBuffer, epoch: number): Promise<void> {
    try {
      await buffer.mapAsync(GPUMapMode.READ);
      if (this.destroyed || epoch !== this.epoch) return;
      const values = new Float32Array(buffer.getMappedRange());
      // Read nine reduced scalars, never an atmospheric or terrain-sized array.
      const liquid = values[0];
      const snow = values[1];
      const ice = values[2];
      const steam = values[3];
      const vapor = values[4];
      const cloud = values[5];
      const rain = values[6];
      const airSnow = values[7];
      const pending = values[8];
      const total = liquid + snow + ice + steam + vapor + cloud + rain + airSnow + pending;
      if (!Number.isFinite(total)) throw new Error('Non-finite water inventory');
      // The first completed, non-stale post-step sample establishes baseline.
      if (this.baseline === null) this.baseline = total;
      const relativeDrift = this.baseline !== 0 ? (total - this.baseline) / this.baseline : 0;
      this.latest = {
        total,
        liquid,
        snow,
        ice,
        vapor,
        cloud,
        rain,
        airSnow,
        pending,
        steam,
        relativeDrift,
        baseline: this.baseline,
      };
      this.reportedReadError = false;
      this.updateDisplay();
    } catch (error) {
      this.reportError(error, epoch);
    } finally {
      if (buffer.mapState === 'mapped') buffer.unmap();
      this.busy = false;
    }
  }

  private updateDisplay(): void {
    if (!this.latest || typeof document === 'undefined') return;
    const budget = this.latest;
    const format = (value: number) =>
      value.toLocaleString('en', { maximumFractionDigits: 3, minimumFractionDigits: 0 });
    const percent = budget.relativeDrift * 100;
    const drift =
      budget.baseline === 0 && budget.total !== 0
        ? 'n/a (zero baseline)'
        : `${percent >= 0 ? '+' : ''}${percent.toFixed(3)}%`;
    const summary = document.getElementById('water-budget');
    if (summary) {
      summary.textContent = `Water total ${format(budget.total)} u³ · drift ${drift}`;
      summary.title =
        'Measured GPU inventory, including all liquid, frozen and atmospheric reservoirs. Drift is relative to the latest reset; open modes also include external sources and sinks.';
    }
    const detail = document.getElementById('water-budget-detail');
    if (detail) {
      detail.textContent =
        `Liquid ${format(budget.liquid)} · snow ${format(budget.snow)} · ice ${format(budget.ice)} · ` +
        `vapor ${format(budget.vapor)} · clouds ${format(budget.cloud)} · ` +
        `rain ${format(budget.rain)} · airborne snow ${format(budget.airSnow)} · ` +
        `steam ${format(budget.steam)} · pending evaporation ${format(budget.pending)}`;
    }
  }

  private reportError(error: unknown, epoch: number): void {
    if (this.destroyed || epoch !== this.epoch) return;
    if (!this.reportedReadError) console.warn('Water inventory readback failed:', error);
    this.reportedReadError = true;
    if (typeof document !== 'undefined') {
      const summary = document.getElementById('water-budget');
      if (summary) summary.textContent = 'Water budget temporarily unavailable';
    }
  }

  resetBaseline(): void {
    this.epoch++;
    this.baseline = null;
    this.latest = null;
    this.lastSampleAt = -Infinity;
    if (typeof document !== 'undefined') {
      const summary = document.getElementById('water-budget');
      if (summary) summary.textContent = 'Water budget · measuring…';
      const detail = document.getElementById('water-budget-detail');
      if (detail) detail.textContent = '';
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.epoch++;
    this.uniforms?.destroy();
    this.partials?.destroy();
    this.totals?.destroy();
    this.readback?.destroy();
    this.uniforms = null;
    this.partials = null;
    this.totals = null;
    this.readback = null;
    this.partialPipeline = null;
    this.totalPipeline = null;
    this.layout = null;
    this.latest = null;
  }
}
