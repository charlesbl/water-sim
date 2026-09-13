import * as THREE from 'three';
import { WeatherSimulation } from './weather';
import { config } from './config';
import weatherRenderWGSL from './shaders/renderWeather.wgsl?raw';
import materials from './shaders/surfaceThermal.wgsl?raw';
/** Render the painted cloud field, surface diagnostics and falling precipitation. */
export class WeatherRenderer {
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private overlayPipeline: GPURenderPipeline | null = null;
  private volumePipeline: GPURenderPipeline | null = null;
  private particlePipeline: GPURenderPipeline | null = null;
  private readonly uniforms = new Float32Array(64);
  private readonly inverseMvp = new THREE.Matrix4();
  constructor(
    private readonly device: GPUDevice,
    private readonly format: GPUTextureFormat,
    private readonly weather: WeatherSimulation
  ) {}
  async init(): Promise<void> {
    const module = this.device.createShaderModule({
      label: 'Painted clouds and precipitation',
      code: materials + '\n' + weatherRenderWGSL,
    });
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter((message) => message.type === 'error');
    if (errors.length > 0) {
      throw new Error(
        `Weather rendering shader: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n')}`
      );
    }
    this.uniformBuffer = this.device.createBuffer({
      label: 'Weather render uniforms',
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
        {
          binding: 3,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' },
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
    this.overlayPipeline = await this.device.createRenderPipelineAsync({
      label: 'Weather diagnostic overlay',
      layout,
      vertex: { module, entryPoint: 'vs_volume' },
      fragment: { module, entryPoint: 'fs_overlay', targets: [target] },
      primitive: { topology: 'triangle-list' },
    });
    this.volumePipeline = await this.device.createRenderPipelineAsync({
      label: 'Cloud column reconstruction',
      layout,
      vertex: { module, entryPoint: 'vs_volume' },
      fragment: { module, entryPoint: 'fs_volume', targets: [target] },
      primitive: { topology: 'triangle-list' },
    });
    this.particlePipeline = await this.device.createRenderPipelineAsync({
      label: 'Weather rain and snow',
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
    if (!this.volumePipeline || !this.particlePipeline) return;
    this.inverseMvp.copy(mvp).invert();
    this.uniforms.set(this.inverseMvp.elements, 0);
    this.uniforms.set(mvp.elements, 16);
    this.uniforms.set(
      [localCamera.x, localCamera.y, localCamera.z, this.weather.simulationTime],
      32
    );
    const base = config.cloudAltitude;
    const thickness = config.cloudThickness;
    this.uniforms.set(
      [
        this.weather.mapSize,
        this.weather.mapSize,
        this.weather.size,
        Math.max(100, base + thickness * 3),
      ],
      36
    );
    this.uniforms.set([base, thickness, config.cloudDetail, config.rainVisibility], 52);
    this.uniforms.set(
      [config.rainRate, config.cloudShadows, config.weatherEnabled ? 1 : 0, 32],
      56
    );
    const sunElevation = (config.sunElevation * Math.PI) / 180;
    const sunAzimuth = (config.sunAzimuth * Math.PI) / 180;
    this.uniforms.set(
      [
        Math.cos(sunElevation) * Math.cos(sunAzimuth),
        Math.cos(sunElevation) * Math.sin(sunAzimuth),
        Math.sin(sunElevation),
        config.viewOpacity,
      ],
      60
    );
    this.uniforms.set(
      [
        config.weatherView,
        0,
        config.cloudOpacity *
          (config.brushType === 10 || config.thermalOverlay || config.weatherView !== 0 ? 0.25 : 1),
        0,
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
        { binding: 1, resource: { buffer: this.weather.surfaceBuffer } },
        { binding: 2, resource: depthView },
        { binding: 3, resource: { buffer: this.weather.weatherMap } },
        { binding: 4, resource: { buffer: this.weather.cloudCanopy } },
      ],
    });
    // Depth is sampled, never attached at the same time, so clouds stop at the
    // opaque terrain and work from above, below and inside the air volume.
    const pass = encoder.beginRenderPass({
      label: 'Weather compositing',
      colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setBindGroup(0, bindGroup);
    // Diagnostics tint the surface; clouds and precipitation remain independent above them.
    if (config.weatherView !== 0 && config.viewOpacity > 0 && this.overlayPipeline) {
      pass.setPipeline(this.overlayPipeline);
      pass.draw(3);
    }
    pass.setPipeline(this.volumePipeline);
    pass.draw(3);
    pass.setPipeline(this.particlePipeline);
    pass.draw(6, 8192);
    pass.end();
  }
  destroy(): void {
    this.uniformBuffer?.destroy();
    this.uniformBuffer = null;
    this.volumePipeline = null;
    this.overlayPipeline = null;
    this.particlePipeline = null;
    this.bindGroupLayout = null;
  }
}
