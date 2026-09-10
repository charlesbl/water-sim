import * as THREE from 'three';
import { AtmosphereSimulation } from './atmosphere';
import { config } from './config';
import atmosphereRenderWGSL from './shaders/renderAtmosphere.wgsl?raw';
import cloudPhysicsWGSL from './shaders/cloudPhysics.wgsl?raw';

/** Draw the simulated XYZ air volume, diagnostic slices and GPU precipitation. */
export class AtmosphereRenderer {
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private volumePipeline: GPURenderPipeline | null = null;
  private particlePipeline: GPURenderPipeline | null = null;
  private readonly uniforms = new Float32Array(52);
  private readonly inverseMvp = new THREE.Matrix4();

  constructor(
    private readonly device: GPUDevice,
    private readonly format: GPUTextureFormat,
    private readonly atmosphere: AtmosphereSimulation
  ) {}

  async init(): Promise<void> {
    const module = this.device.createShaderModule({
      label: 'Atmosphere volume and precipitation',
      code: cloudPhysicsWGSL + '\n' + atmosphereRenderWGSL,
    });
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter((message) => message.type === 'error');
    if (errors.length > 0) {
      throw new Error(
        `Atmosphere rendering shader: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n')}`
      );
    }
    this.uniformBuffer = this.device.createBuffer({
      label: 'Atmosphere render uniforms',
      size: this.uniforms.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'depth' },
        },
      ],
    });
    const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });
    const target: GPUColorTargetState = {
      format: this.format,
      // Both shaders output premultiplied radiance.
      blend: {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      },
    };
    this.volumePipeline = await this.device.createRenderPipelineAsync({
      label: 'Atmosphere trilinear volume raymarch',
      layout,
      vertex: { module, entryPoint: 'vs_volume' },
      fragment: { module, entryPoint: 'fs_volume', targets: [target] },
      primitive: { topology: 'triangle-list' },
    });
    this.particlePipeline = await this.device.createRenderPipelineAsync({
      label: 'Atmosphere rain snow and wind tracers',
      layout,
      vertex: { module, entryPoint: 'vs_particle' },
      fragment: { module, entryPoint: 'fs_particle', targets: [target] },
      primitive: { topology: 'triangle-list' },
    });
  }

  render(
    encoder: GPUCommandEncoder,
    colorView: GPUTextureView,
    depthView: GPUTextureView,
    mvp: THREE.Matrix4,
    localCamera: THREE.Vector3
  ): void {
    if (!config.atmosphereEnabled || !this.volumePipeline || !this.particlePipeline) return;

    this.inverseMvp.copy(mvp).invert();
    this.uniforms.set(this.inverseMvp.elements, 0);
    this.uniforms.set(mvp.elements, 16);
    this.uniforms.set(
      [localCamera.x, localCamera.y, localCamera.z, this.atmosphere.simulationTime],
      32
    );
    this.uniforms.set([...this.atmosphere.dimensions, this.atmosphere.domainHeight], 36);
    this.uniforms.set(
      [
        config.atmosphereView,
        config.atmosphereSlice,
        config.cloudOpacity,
        config.showWind || config.atmosphereView === 3 ? 1 : 0,
      ],
      40
    );
    const inv = this.inverseMvp.elements;
    const right = new THREE.Vector3(inv[0], inv[1], inv[2]).normalize();
    const up = new THREE.Vector3(inv[4], inv[5], inv[6]).normalize();
    this.uniforms.set([right.x, right.y, right.z, 0], 44);
    this.uniforms.set([up.x, up.y, up.z, 0], 48);
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, this.uniforms);

    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer! } },
        { binding: 1, resource: { buffer: this.atmosphere.volumeBuffer } },
        { binding: 2, resource: depthView },
      ],
    });
    // Depth is sampled, never attached at the same time, so clouds stop at the
    // opaque terrain and work from above, below and inside the air volume.
    const pass = encoder.beginRenderPass({
      label: 'Atmosphere compositing',
      colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setBindGroup(0, bindGroup);
    pass.setPipeline(this.volumePipeline);
    pass.draw(3);
    pass.setPipeline(this.particlePipeline);
    pass.draw(6, 8192 + (config.showWind || config.atmosphereView === 3 ? 2048 : 0));
    pass.end();
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.uniformBuffer = null;
    this.volumePipeline = null;
    this.particlePipeline = null;
    this.bindGroupLayout = null;
  }
}
