import * as THREE from 'three';
import { config } from './config';
import physicsWGSL from './shaders/nukePhysics.wgsl?raw';
import renderWGSL from './shaders/renderNuke.wgsl?raw';
import materialsWGSL from './shaders/surfaceThermal.wgsl?raw';
import {
  NUKE_LIFETIME,
  NUKE_SHOCK_SECONDS,
  NUKE_PHYSICS_STRIDE,
  NUKE_SHADER_PROFILE,
} from './nuke';

const MAX_BLASTS = 8;
const TICK = 1 / 60;
type State = [GPUBuffer, GPUBuffer, GPUBuffer, GPUBuffer, GPUBuffer];
interface Blast {
  x: number;
  y: number;
  radius: number;
  strength: number;
  cold: boolean;
  age: number;
  slot: number;
  seed: number;
  ticks: number;
}

/** Local conservative transport and instanced world-space explosion particles. */
export class NukeEffects {
  private blasts: Blast[] = [];
  private accumulator = 0;
  private sequence = 0;
  private scratch: GPUBuffer[] = [];
  private scratchCells = 0;
  private computeUniform: GPUBuffer;
  private renderUniform: GPUBuffer;
  private origins: GPUBuffer;
  private capturePipeline!: GPUComputePipeline;
  private transportPipeline!: GPUComputePipeline;
  private commitPipeline!: GPUComputePipeline;
  private particlePipeline!: GPURenderPipeline;
  private volumePipeline!: GPURenderPipeline;
  private readonly renderData = new Float32Array(52 + MAX_BLASTS * 8);

  constructor(
    private readonly device: GPUDevice,
    private readonly size: number,
    private readonly format: GPUTextureFormat
  ) {
    this.computeUniform = this.buffer(64, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.renderUniform = this.buffer(
      this.renderData.byteLength,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    );
    this.origins = this.buffer(MAX_BLASTS * 32, GPUBufferUsage.STORAGE);
  }

  private buffer(size: number, usage: GPUBufferUsageFlags) {
    return this.device.createBuffer({ label: 'Nuke effect', size, usage });
  }

  async init() {
    const physics = this.device.createShaderModule({
      code: NUKE_SHADER_PROFILE + materialsWGSL + '\n' + physicsWGSL,
    });
    const render = this.device.createShaderModule({ code: NUKE_SHADER_PROFILE + renderWGSL });
    for (const module of [physics, render]) {
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((m) => m.type === 'error');
      if (errors.length)
        throw new Error(
          'Nuke shader: ' + errors.map((m) => `${m.lineNum}: ${m.message}`).join('\n')
        );
    }
    const compute = (entryPoint: string) =>
      this.device.createComputePipeline({
        layout: 'auto',
        compute: { module: physics, entryPoint },
      });
    this.capturePipeline = compute('capture_origin');
    this.transportPipeline = compute('transport');
    this.commitPipeline = compute('commit');
    const descriptor: GPURenderPipelineDescriptor = {
      layout: 'auto',
      vertex: { module: render, entryPoint: 'vs_particle' },
      fragment: {
        module: render,
        entryPoint: 'fs_particle',
        targets: [
          {
            format: this.format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
    };
    this.particlePipeline = this.device.createRenderPipeline(descriptor);
    this.volumePipeline = this.device.createRenderPipeline({
      ...descriptor,
      vertex: { module: render, entryPoint: 'vs_volume' },
      fragment: { ...descriptor.fragment!, entryPoint: 'fs_volume' },
      depthStencil: undefined,
    });
  }

  private region(blast: Blast) {
    const extent = Math.ceil(blast.radius * this.size) + 2;
    return [
      Math.max(0, Math.floor(blast.x * this.size) - extent),
      Math.max(0, Math.floor(blast.y * this.size) - extent),
      Math.min(this.size, extent * 2 + 2),
      this.size,
    ];
  }

  private writePulse(blast: Blast) {
    this.device.queue.writeBuffer(
      this.computeUniform,
      0,
      new Float32Array([
        blast.x,
        blast.y,
        blast.radius,
        blast.strength,
        ...this.region(blast),
        blast.age,
        NUKE_SHOCK_SECONDS,
        blast.slot,
        config.heightScale,
        blast.cold ? 0 : 1,
        0,
        0,
        0,
      ])
    );
  }

  private bindings(pipeline: GPUComputePipeline, state: State, indices: number[]) {
    const buffers = [
      this.computeUniform,
      ...state.slice(0, 3),
      ...this.scratch,
      ...state.slice(3),
      this.origins,
    ];
    return this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: indices.map((binding) => ({ binding, resource: { buffer: buffers[binding] } })),
    });
  }

  add(x: number, y: number, radius: number, strength: number, cold: boolean, state: State) {
    if (!this.blasts.length) this.accumulator = 0;
    // Bound particle work and reuse the oldest slot when clicks arrive in a burst.
    if (this.blasts.length === MAX_BLASTS) this.blasts.shift();
    const slot = Array.from({ length: MAX_BLASTS }, (_, i) => i).find(
      (i) => !this.blasts.some((b) => b.slot === i)
    )!;
    const blast = { x, y, radius, strength, cold, age: 0, slot, seed: ++this.sequence, ticks: 0 };
    this.blasts.push(blast);
    const width = this.region(blast)[2];
    if (width * width > this.scratchCells) {
      this.scratch.forEach((b) => b.destroy());
      this.scratchCells = width * width;
      this.scratch = [24, 16, 16].map((stride) =>
        this.buffer(this.scratchCells * stride, GPUBufferUsage.STORAGE)
      );
    }
    this.writePulse(blast);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.capturePipeline);
    pass.setBindGroup(0, this.bindings(this.capturePipeline, state, [0, 1, 2, 3, 9]));
    pass.dispatchWorkgroups(1);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /** A click remains a finite direct edit, including while the world is paused. */
  advance(elapsed: number, state: State) {
    if (!this.blasts.length || !Number.isFinite(elapsed) || elapsed <= 0) return;
    this.accumulator += Math.min(elapsed, 0.1);
    while (this.accumulator + 1e-8 >= TICK) {
      this.accumulator -= TICK;
      for (const blast of this.blasts) {
        blast.age += TICK;
        blast.ticks++;
        if (blast.age > NUKE_SHOCK_SECONDS || blast.ticks % NUKE_PHYSICS_STRIDE !== 0) continue;
        this.writePulse(blast);
        const encoder = this.device.createCommandEncoder({ label: 'Conservative blast transport' });
        for (const [pipeline, bindings] of [
          [this.transportPipeline, [0, 1, 2, 3, 4, 5, 6]],
          [this.commitPipeline, [0, 1, 2, 3, 4, 5, 6, 7, 8]],
        ] as const) {
          const pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, this.bindings(pipeline, state, [...bindings]));
          const groups = Math.ceil(this.region(blast)[2] / 8);
          pass.dispatchWorkgroups(groups, groups);
          pass.end();
        }
        this.device.queue.submit([encoder.finish()]);
      }
      this.blasts = this.blasts.filter((b) => b.age < NUKE_LIFETIME);
      if (!this.blasts.length) this.clear();
    }
  }

  render(
    encoder: GPUCommandEncoder,
    color: GPUTextureView,
    depth: GPUTextureView,
    mvp: THREE.Matrix4,
    camera: THREE.PerspectiveCamera,
    state: State
  ) {
    if (!this.blasts.length) return;
    const local = new THREE.Matrix4().makeRotationX(Math.PI / 2).multiply(camera.matrixWorld);
    const right = new THREE.Vector3().setFromMatrixColumn(local, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(local, 1);
    const data = this.renderData;
    data.set(mvp.elements);
    data.set(mvp.clone().invert().elements, 16);
    const eye = camera.position
      .clone()
      .applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    const elevation = (config.sunElevation * Math.PI) / 180,
      azimuth = (config.sunAzimuth * Math.PI) / 180;
    data.set(
      [
        eye.x,
        eye.y,
        eye.z,
        0,
        this.size,
        config.heightScale,
        0,
        0,
        Math.cos(elevation) * Math.cos(azimuth),
        Math.cos(elevation) * Math.sin(azimuth),
        Math.sin(elevation),
        0,
        right.x,
        right.y,
        right.z,
        0,
        up.x,
        up.y,
        up.z,
        0,
      ],
      32
    );
    data.fill(0, 52);
    this.blasts.forEach((b, i) =>
      data.set([b.age, b.strength, b.cold ? 1 : 0, b.slot, b.seed, 0, 0, 0], 52 + i * 8)
    );
    this.device.queue.writeBuffer(this.renderUniform, 0, data);
    const volume = encoder.beginRenderPass({
      label: 'Volumetric nuclear cloud and ground-hugging pressure front',
      colorAttachments: [{ view: color, loadOp: 'load', storeOp: 'store' }],
    });
    const buffers = [this.renderUniform, this.origins, ...state.slice(0, 3)];
    volume.setPipeline(this.volumePipeline);
    volume.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: this.volumePipeline.getBindGroupLayout(0),
        entries: [
          ...buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
          { binding: 5, resource: depth },
        ],
      })
    );
    volume.draw(3, this.blasts.length);
    volume.end();
    const pass = encoder.beginRenderPass({
      label: 'Fine ballistic ejecta',
      colorAttachments: [{ view: color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: depth, depthLoadOp: 'load', depthStoreOp: 'store' },
    });
    for (const [pipeline, bindings, vertices, instances] of [
      [this.particlePipeline, [0, 1], 6, this.blasts.length * 128],
    ] as const) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: bindings.map((binding) => ({ binding, resource: { buffer: buffers[binding] } })),
        })
      );
      pass.draw(vertices, instances);
    }
    pass.end();
  }

  clear() {
    this.blasts.length = 0;
    this.accumulator = 0;
    this.scratch.forEach((b) => b.destroy());
    this.scratch = [];
    this.scratchCells = 0;
  }
}
