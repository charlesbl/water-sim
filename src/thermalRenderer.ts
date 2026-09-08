import * as THREE from 'three';
import { config } from './config';
import { AtmosphereSimulation } from './atmosphere';
import shader from './shaders/thermal.wgsl?raw';

/** Composites temperature without handling any pointer or brush input. */
export class ThermalRenderer {
  private uniform: GPUBuffer;
  private renderPipeline!: GPURenderPipeline;

  constructor(
    private device: GPUDevice,
    private format: GPUTextureFormat,
    private atmosphere: AtmosphereSimulation
  ) {
    this.uniform = device.createBuffer({
      size: 112,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  async init() {
    const module = this.device.createShaderModule({ code: shader, label: 'Thermal overlay' });
    const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error');
    if (errors.length)
      throw new Error(errors.map((m) => `Thermal ${m.lineNum}: ${m.message}`).join('\n'));
    this.renderPipeline = await this.device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [
          {
            format: this.format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  render(
    encoder: GPUCommandEncoder,
    color: GPUTextureView,
    depth: GPUTextureView,
    mvp: THREE.Matrix4,
    terrain: GPUBuffer,
    fluids: GPUBuffer,
    size: number
  ) {
    if (!config.thermalOverlay) return;
    const values = new Float32Array(28);
    values.set(mvp.clone().invert().elements);
    values.set([size, config.heightScale, config.thermalHeight, config.thermalOpacity], 16);
    values[20] = config.thermalAir ? 1 : 0;
    values.set([...this.atmosphere.dimensions, this.atmosphere.domainHeight], 24);
    this.device.queue.writeBuffer(this.uniform, 0, values);
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.uniform } },
      { binding: 1, resource: depth },
      { binding: 2, resource: { buffer: this.atmosphere.surfaceBuffer } },
      { binding: 3, resource: { buffer: this.atmosphere.volumeBuffer } },
      { binding: 4, resource: { buffer: this.atmosphere.columns } },
      { binding: 5, resource: { buffer: terrain } },
      { binding: 6, resource: { buffer: fluids } },
    ];
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: color, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: this.renderPipeline.getBindGroupLayout(0),
        entries,
      })
    );
    pass.draw(3);
    pass.end();
  }
}
