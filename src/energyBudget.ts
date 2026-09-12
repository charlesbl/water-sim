import { config } from './config';

export interface RadiativeFlux {
  incoming: number;
  outgoing: number;
  net: number;
  weatherTime: number;
}

/** Reads the applied radiative boundary fluxes, not the total stored energy. */
export class EnergyBudget {
  public latest: RadiativeFlux | null = null;
  private readonly readback: GPUBuffer;
  private readonly panel = typeof document === 'undefined'
    ? null
    : document.querySelector<HTMLDetailsElement>('#energy-panel');
  private busy = false;
  private destroyed = false;
  private epoch = 0;
  private lastSampleAt = -Infinity;
  private failed = false;
  private manual = false;
  private displayState = '';

  constructor(private readonly device: GPUDevice, private readonly flux: GPUBuffer) {
    this.readback = device.createBuffer({
      label: 'Radiative energy 16-byte readback',
      size: 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  sample(manualIntervention = false): void {
    if (this.destroyed || !this.panel?.open) return;
    this.manual = manualIntervention;
    const state = `${config.paused}:${config.atmosphereEnabled}:${this.manual}`;
    if (state !== this.displayState) {
      this.displayState = state;
      this.updateDisplay();
    }
    const now = performance.now();
    if (config.paused || !config.atmosphereEnabled || this.busy || now - this.lastSampleAt < 1000)
      return;
    this.busy = true;
    this.lastSampleAt = now;
    const epoch = this.epoch;
    try {
      const encoder = this.device.createCommandEncoder({ label: 'Radiative energy sample' });
      encoder.copyBufferToBuffer(this.flux, 0, this.readback, 0, 16);
      this.device.queue.submit([encoder.finish()]);
      void this.consumeReadback(epoch);
    } catch (error) {
      this.busy = false;
      this.reportError(error, epoch);
    }
  }

  private async consumeReadback(epoch: number): Promise<void> {
    try {
      await this.readback.mapAsync(GPUMapMode.READ);
      if (this.destroyed || epoch !== this.epoch) return;
      const values = new Float32Array(this.readback.getMappedRange());
      if (!values.every(Number.isFinite)) throw new Error('Non-finite radiative energy flux');
      this.latest = values[3] > 0
        ? { incoming: values[0], outgoing: values[1], net: values[2], weatherTime: values[3] }
        : null;
      this.failed = false;
      this.updateDisplay();
    } catch (error) {
      this.reportError(error, epoch);
    } finally {
      if (this.readback.mapState === 'mapped') this.readback.unmap();
      this.busy = false;
    }
  }

  private updateDisplay(): void {
    if (!this.panel) return;
    const held = config.paused || !config.atmosphereEnabled;
    const value = held ? { incoming: 0, outgoing: 0, net: 0 } : this.failed ? null : this.latest;
    const format = (n: number) => n.toLocaleString('en', { maximumFractionDigits: 1 });
    const set = (id: string, text: string) => {
      const element = this.panel!.querySelector<HTMLElement>(`#${id}`);
      if (element) element.textContent = text;
    };
    set('energy-in', value ? format(value.incoming) : '—');
    set('energy-out', value ? format(value.outgoing) : '—');
    set('energy-net', value ? `${value.net > 0 ? '+' : ''}${format(value.net)}` : '—');
    const row = this.panel.querySelector<HTMLElement>('#energy-net-row');
    if (row) row.dataset.sign = !value || Math.abs(value.net) < 0.05
      ? 'balanced' : value.net > 0 ? 'incoming' : 'outgoing';
    set('energy-status', this.manual
      ? 'Manual intervention · radiative flows shown'
      : held
        ? 'Weather held · no radiative exchange'
        : this.failed
          ? 'Energy measurement unavailable'
          : !this.latest
            ? 'Waiting for the first weather step'
            : 'Closed walls · no automatic matter exchange');
  }

  private reportError(error: unknown, epoch: number): void {
    if (this.destroyed || epoch !== this.epoch) return;
    if (!this.failed) console.warn('Radiative energy readback failed:', error);
    this.failed = true;
    this.updateDisplay();
  }

  reset(): void {
    this.epoch++;
    this.latest = null;
    this.failed = false;
    this.lastSampleAt = -Infinity;
    this.displayState = '';
    this.updateDisplay();
  }

  destroy(): void {
    this.destroyed = true;
    this.epoch++;
    this.readback.destroy();
  }
}
