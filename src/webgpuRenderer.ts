import * as THREE from 'three';
import { config } from './config';

import simFluxWGSL from './shaders/simFlux.wgsl?raw';
import simFluidsWGSL from './shaders/simFluids.wgsl?raw';
import simTerrainWGSL from './shaders/simTerrain.wgsl?raw';
import renderWGSL from './shaders/render.wgsl?raw';

export class GPGPUSimulation {
  private size: number;
  private canvas: HTMLCanvasElement;

  private adapter: GPUAdapter | null = null;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = 'rgba8unorm';

  // State
  private initialized = false;
  private resourcesReady = false;
  private seed: number;
  private time = 0;
  private isPaused = 0;

  // Storage buffers (ping-pong pairs)
  private terrainBufferA: GPUBuffer | null = null;
  private terrainBufferB: GPUBuffer | null = null;
  private fluidsBufferA: GPUBuffer | null = null;
  private fluidsBufferB: GPUBuffer | null = null;
  private waterFluxBufferA: GPUBuffer | null = null;
  private waterFluxBufferB: GPUBuffer | null = null;
  private lavaFluxBufferA: GPUBuffer | null = null;
  private lavaFluxBufferB: GPUBuffer | null = null;

  // Uniform buffers
  private computeUniformBuffer: GPUBuffer | null = null;
  private renderUniformBufferTerrain: GPUBuffer | null = null;
  private renderUniformBufferFluids: GPUBuffer | null = null;

  // Vertex/Index buffers for rendering
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private indexCount = 0;

  // Depth texture for rendering
  private depthTexture: GPUTexture | null = null;

  // Pipelines
  private simFluxPipeline: GPUComputePipeline | null = null;
  private simFluidsPipeline: GPUComputePipeline | null = null;
  private simTerrainPipeline: GPUComputePipeline | null = null;
  private renderTerrainPipeline: GPURenderPipeline | null = null;
  private renderFluidsPipeline: GPURenderPipeline | null = null;

  // Bind groups
  private computeBindGroupA: GPUBindGroup | null = null;
  private computeBindGroupB: GPUBindGroup | null = null;
  private fluidsBindGroupA: GPUBindGroup | null = null;
  private fluidsBindGroupB: GPUBindGroup | null = null;
  private terrainBindGroupA: GPUBindGroup | null = null;
  private terrainBindGroupB: GPUBindGroup | null = null;

  private renderTerrainBindGroupA: GPUBindGroup | null = null;
  private renderTerrainBindGroupB: GPUBindGroup | null = null;
  private renderFluidsBindGroupA: GPUBindGroup | null = null;
  private renderFluidsBindGroupB: GPUBindGroup | null = null;

  // Ping-pong toggle
  private pingPongToggle = false;

  // Brush settings cached to write during step
  private brushActive = 0;
  private brushX = 0;
  private brushY = 0;
  private brushType = 0;
  private brushRadius = 0.05;
  private brushStrength = 1.0;

  // GPU Picking variables
  private pickingTexture: GPUTexture | null = null;
  private pickingDepthTexture: GPUTexture | null = null;
  private pickingReadbackBuffer: GPUBuffer | null = null;
  private renderPickingPipeline: GPURenderPipeline | null = null;
  private pickingBindGroupA: GPUBindGroup | null = null;
  private pickingBindGroupB: GPUBindGroup | null = null;
  private isPickingMapInProgress = false;
  public pointerUV: THREE.Vector2 | null = null;

  constructor(canvas: HTMLCanvasElement, size = 256) {
    this.size = size;
    this.canvas = canvas;
    this.seed = Math.random() * 1000.0;
  }

  /**
   * Initializes the WebGPU context, shaders, buffers, and pipelines asynchronously
   */
  public async initWebGPU(): Promise<boolean> {
    if (!navigator.gpu) {
      console.error('WebGPU is not supported in this browser.');
      return false;
    }

    this.adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!this.adapter) {
      console.error('Failed to request GPU adapter.');
      return false;
    }

    this.device = await this.adapter.requestDevice();
    if (!this.device) {
      console.error('Failed to request GPU device.');
      return false;
    }

    this.context = this.canvas.getContext('webgpu');
    if (!this.context) {
      console.error('Failed to get WebGPU context.');
      return false;
    }

    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'opaque',
    });

    const numCells = this.size * this.size;
    const bufferSize = numCells * 16; // 4 floats * 4 bytes per cell struct

    // 1. Create storage buffers
    this.terrainBufferA = this.device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.terrainBufferB = this.device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    this.fluidsBufferA = this.device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.fluidsBufferB = this.device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    this.waterFluxBufferA = this.device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.waterFluxBufferB = this.device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    this.lavaFluxBufferA = this.device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.lavaFluxBufferB = this.device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    // 2. Create uniform buffers
    this.computeUniformBuffer = this.device.createBuffer({
      size: 144, // 36 floats * 4 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.renderUniformBufferTerrain = this.device.createBuffer({
      size: 160, // 40 floats * 4 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.renderUniformBufferFluids = this.device.createBuffer({
      size: 160, // 40 floats * 4 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // 3. Create grid mesh buffers
    const renderSegments = Math.max(1, Math.floor(this.size * config.renderResolution) - 1);
    const vertices: number[] = [];
    const indices: number[] = [];
    const step = 200 / renderSegments;
    for (let y = 0; y <= renderSegments; y++) {
      for (let x = 0; x <= renderSegments; x++) {
        const px = x * step - 100;
        const py = y * step - 100;
        const u = x / renderSegments;
        const v = y / renderSegments;
        vertices.push(px, py, 0, u, v);
      }
    }
    for (let y = 0; y < renderSegments; y++) {
      for (let x = 0; x < renderSegments; x++) {
        const i0 = y * (renderSegments + 1) + x;
        const i1 = i0 + 1;
        const i2 = i0 + (renderSegments + 1);
        const i3 = i2 + 1;
        indices.push(i0, i2, i1);
        indices.push(i1, i2, i3);
      }
    }
    this.indexCount = indices.length;

    this.vertexBuffer = this.device.createBuffer({
      size: vertices.length * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(this.vertexBuffer.getMappedRange()).set(vertices);
    this.vertexBuffer.unmap();

    this.indexBuffer = this.device.createBuffer({
      size: indices.length * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint32Array(this.indexBuffer.getMappedRange()).set(indices);
    this.indexBuffer.unmap();

    // 4. Create depth texture
    this.resizeDepthTexture();

    // 5. Create picking resources
    this.pickingTexture = this.device.createTexture({
      size: [1, 1],
      format: 'rgba32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.pickingDepthTexture = this.device.createTexture({
      size: [1, 1],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.pickingReadbackBuffer = this.device.createBuffer({
      size: 16, // 4 floats * 4 bytes
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    // 6. Create pipelines
    const simFluxModule = this.device.createShaderModule({ code: simFluxWGSL });
    const simFluidsModule = this.device.createShaderModule({ code: simFluidsWGSL });
    const simTerrainModule = this.device.createShaderModule({ code: simTerrainWGSL });
    const renderModule = this.device.createShaderModule({ code: renderWGSL });

    // Compute Pipelines
    this.simFluxPipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: simFluxModule, entryPoint: 'main' },
    });
    this.simFluidsPipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: simFluidsModule, entryPoint: 'main' },
    });
    this.simTerrainPipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: simTerrainModule, entryPoint: 'main' },
    });

    // Create explicit layout for all render pipelines to share bind groups
    const renderBindGroupLayout = this.device.createBindGroupLayout({
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
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' },
        },
      ],
    });

    const renderPipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [renderBindGroupLayout],
    });

    // Render Pipelines (Terrain is opaque, Fluids has transparent blending)
    this.renderTerrainPipeline = this.device.createRenderPipeline({
      layout: renderPipelineLayout,
      vertex: {
        module: renderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 20, // 5 floats * 4 bytes
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
              { shaderLocation: 1, offset: 12, format: 'float32x2' }, // uv
            ],
          },
        ],
      },
      fragment: {
        module: renderModule,
        entryPoint: 'fs_main',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' },
    });

    this.renderFluidsPipeline = this.device.createRenderPipeline({
      layout: renderPipelineLayout,
      vertex: {
        module: renderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 20,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x2' },
            ],
          },
        ],
      },
      fragment: {
        module: renderModule,
        entryPoint: 'fs_main',
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
      depthStencil: { depthWriteEnabled: false, depthCompare: 'less', format: 'depth24plus' },
    });

    // Picking Render Pipeline (outputs UV coordinates directly to a Float textures)
    this.renderPickingPipeline = this.device.createRenderPipeline({
      layout: renderPipelineLayout,
      vertex: {
        module: renderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 20,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x2' },
            ],
          },
        ],
      },
      fragment: {
        module: renderModule,
        entryPoint: 'fs_picking',
        targets: [{ format: 'rgba32float' }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' },
    });

    // 7. Bind Group Creations
    this.createBindGroups();

    // Clear simulation buffers to default zero states
    this.clearFluids();
    this.resetTerrain();

    this.resourcesReady = true;
    return true;
  }

  private resizeDepthTexture() {
    if (!this.device) return;
    if (this.depthTexture) this.depthTexture.destroy();
    this.depthTexture = this.device.createTexture({
      size: [Math.max(1, this.canvas.width), Math.max(1, this.canvas.height)],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  private createBindGroups() {
    if (
      !this.device ||
      !this.simFluxPipeline ||
      !this.simFluidsPipeline ||
      !this.simTerrainPipeline ||
      !this.renderTerrainPipeline ||
      !this.renderPickingPipeline
    )
      return;

    // A/B Ping Pong mappings
    // Group A uses Buffer A as Read (Input) and Buffer B as Write (Output)
    // Group B uses Buffer B as Read (Input) and Buffer A as Write (Output)

    this.computeBindGroupA = this.device.createBindGroup({
      layout: this.simFluxPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.computeUniformBuffer! } },
        { binding: 1, resource: { buffer: this.terrainBufferA! } },
        { binding: 2, resource: { buffer: this.fluidsBufferA! } },
        { binding: 3, resource: { buffer: this.waterFluxBufferA! } },
        { binding: 4, resource: { buffer: this.waterFluxBufferB! } },
        { binding: 5, resource: { buffer: this.lavaFluxBufferA! } },
        { binding: 6, resource: { buffer: this.lavaFluxBufferB! } },
      ],
    });

    this.computeBindGroupB = this.device.createBindGroup({
      layout: this.simFluxPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.computeUniformBuffer! } },
        { binding: 1, resource: { buffer: this.terrainBufferB! } },
        { binding: 2, resource: { buffer: this.fluidsBufferB! } },
        { binding: 3, resource: { buffer: this.waterFluxBufferB! } },
        { binding: 4, resource: { buffer: this.waterFluxBufferA! } },
        { binding: 5, resource: { buffer: this.lavaFluxBufferB! } },
        { binding: 6, resource: { buffer: this.lavaFluxBufferA! } },
      ],
    });

    this.fluidsBindGroupA = this.device.createBindGroup({
      layout: this.simFluidsPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.computeUniformBuffer! } },
        { binding: 1, resource: { buffer: this.terrainBufferB! } }, // Needs newly generated terrain (from A_write which is B)
        { binding: 2, resource: { buffer: this.fluidsBufferA! } },
        { binding: 3, resource: { buffer: this.fluidsBufferB! } },
        { binding: 4, resource: { buffer: this.waterFluxBufferB! } }, // Read newest fluxes (written in B)
        { binding: 5, resource: { buffer: this.lavaFluxBufferB! } },
      ],
    });

    this.fluidsBindGroupB = this.device.createBindGroup({
      layout: this.simFluidsPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.computeUniformBuffer! } },
        { binding: 1, resource: { buffer: this.terrainBufferA! } }, // Needs newly generated terrain (from B_write which is A)
        { binding: 2, resource: { buffer: this.fluidsBufferB! } },
        { binding: 3, resource: { buffer: this.fluidsBufferA! } },
        { binding: 4, resource: { buffer: this.waterFluxBufferA! } }, // Read newest fluxes (written in A)
        { binding: 5, resource: { buffer: this.lavaFluxBufferA! } },
      ],
    });

    this.terrainBindGroupA = this.device.createBindGroup({
      layout: this.simTerrainPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.computeUniformBuffer! } },
        { binding: 1, resource: { buffer: this.terrainBufferA! } },
        { binding: 2, resource: { buffer: this.terrainBufferB! } },
        { binding: 3, resource: { buffer: this.fluidsBufferA! } },
        { binding: 4, resource: { buffer: this.waterFluxBufferB! } }, // Read newest fluxes (written in B)
      ],
    });

    this.terrainBindGroupB = this.device.createBindGroup({
      layout: this.simTerrainPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.computeUniformBuffer! } },
        { binding: 1, resource: { buffer: this.terrainBufferB! } },
        { binding: 2, resource: { buffer: this.terrainBufferA! } },
        { binding: 3, resource: { buffer: this.fluidsBufferB! } },
        { binding: 4, resource: { buffer: this.waterFluxBufferA! } }, // Read newest fluxes (written in A)
      ],
    });

    // Render Terrain Bind Groups
    this.renderTerrainBindGroupA = this.device.createBindGroup({
      layout: this.renderTerrainPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.renderUniformBufferTerrain! } },
        { binding: 1, resource: { buffer: this.terrainBufferA! } },
        { binding: 2, resource: { buffer: this.fluidsBufferA! } },
        { binding: 3, resource: { buffer: this.waterFluxBufferA! } },
      ],
    });

    this.renderTerrainBindGroupB = this.device.createBindGroup({
      layout: this.renderTerrainPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.renderUniformBufferTerrain! } },
        { binding: 1, resource: { buffer: this.terrainBufferB! } },
        { binding: 2, resource: { buffer: this.fluidsBufferB! } },
        { binding: 3, resource: { buffer: this.waterFluxBufferB! } },
      ],
    });

    // Render Fluids Bind Groups
    this.renderFluidsBindGroupA = this.device.createBindGroup({
      layout: this.renderTerrainPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.renderUniformBufferFluids! } },
        { binding: 1, resource: { buffer: this.terrainBufferA! } },
        { binding: 2, resource: { buffer: this.fluidsBufferA! } },
        { binding: 3, resource: { buffer: this.waterFluxBufferA! } },
      ],
    });

    this.renderFluidsBindGroupB = this.device.createBindGroup({
      layout: this.renderTerrainPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.renderUniformBufferFluids! } },
        { binding: 1, resource: { buffer: this.terrainBufferB! } },
        { binding: 2, resource: { buffer: this.fluidsBufferB! } },
        { binding: 3, resource: { buffer: this.waterFluxBufferB! } },
      ],
    });

    // Picking Bind Groups (uses terrain uniform buffer)
    this.pickingBindGroupA = this.device.createBindGroup({
      layout: this.renderTerrainPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.renderUniformBufferTerrain! } },
        { binding: 1, resource: { buffer: this.terrainBufferA! } },
        { binding: 2, resource: { buffer: this.fluidsBufferA! } },
        { binding: 3, resource: { buffer: this.waterFluxBufferA! } },
      ],
    });

    this.pickingBindGroupB = this.device.createBindGroup({
      layout: this.renderTerrainPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.renderUniformBufferTerrain! } },
        { binding: 1, resource: { buffer: this.terrainBufferB! } },
        { binding: 2, resource: { buffer: this.fluidsBufferB! } },
        { binding: 3, resource: { buffer: this.waterFluxBufferB! } },
      ],
    });
  }

  /**
   * Set dynamic brush properties
   */
  public setBrush(
    active: boolean,
    uv: THREE.Vector2 | null,
    type: number,
    radius: number,
    strength: number
  ) {
    this.brushActive = active && uv !== null ? 1.0 : 0.0;
    this.brushX = uv ? uv.x : 0.0;
    this.brushY = uv ? uv.y : 0.0;
    this.brushRadius = radius / this.size; // in UV coordinates
    this.brushType = type;
    this.brushStrength = strength;
  }

  public updateParameters() {
    this.isPaused = config.paused ? 1.0 : 0.0;
  }

  /**
   * Clears liquids and fluxes back to zero states
   */
  public clearFluids() {
    if (!this.device) return;
    const numCells = this.size * this.size;
    const zeroData = new Float32Array(numCells * 4); // 4 floats per struct cell (FluidCell, FluxCell)

    this.device.queue.writeBuffer(this.fluidsBufferA!, 0, zeroData);
    this.device.queue.writeBuffer(this.fluidsBufferB!, 0, zeroData);
    this.device.queue.writeBuffer(this.waterFluxBufferA!, 0, zeroData);
    this.device.queue.writeBuffer(this.waterFluxBufferB!, 0, zeroData);
    this.device.queue.writeBuffer(this.lavaFluxBufferA!, 0, zeroData);
    this.device.queue.writeBuffer(this.lavaFluxBufferB!, 0, zeroData);
  }

  /**
   * Resets simulation initialized status to trigger procedural terrain regeneration
   */
  public resetTerrain(newSeed = true) {
    this.initialized = false;
    if (newSeed) {
      this.seed = Math.random() * 1000.0;
    }
    this.clearFluids();
  }

  /**
   * Update uniforms buffer and dispatch compute shaders
   */
  public step() {
    if (!this.device || !this.resourcesReady) return;

    this.updateParameters();
    this.time = performance.now() * 0.001;

    // Write Compute Uniform Buffer
    const computeUniforms = new Float32Array(36);
    computeUniforms[0] = this.size;
    computeUniforms[1] = config.waterGravity;
    computeUniforms[2] = config.waterDamping;
    computeUniforms[3] = config.lavaGravity;
    computeUniforms[4] = config.lavaDamping;
    computeUniforms[5] = config.sandSlideRate;
    computeUniforms[6] = config.sandStaticReposeSlope;
    computeUniforms[7] = config.sandDynamicReposeSlope;
    computeUniforms[8] = config.erosionRate;
    computeUniforms[9] = config.capacityFactor;
    computeUniforms[10] = config.depositionRate;
    computeUniforms[11] = config.evaporation;
    computeUniforms[12] = this.initialized ? 1.0 : 0.0;
    computeUniforms[13] = this.isPaused;
    computeUniforms[14] = this.brushActive;
    computeUniforms[15] = this.brushType;
    computeUniforms[16] = this.brushStrength;
    computeUniforms[17] = this.brushRadius;
    computeUniforms[18] = this.brushX;
    computeUniforms[19] = this.brushY;
    computeUniforms[20] = this.time;
    computeUniforms[21] = config.rainActive ? 1.0 : 0.0;
    computeUniforms[22] = config.rainQuantity;
    computeUniforms[23] = config.rainSize;
    computeUniforms[24] = config.borderBehavior;
    computeUniforms[25] = config.borderWaterHeight;
    computeUniforms[26] = this.seed;
    computeUniforms[27] = config.terrainType;
    computeUniforms[28] = config.terrainSandHeight;
    computeUniforms[29] = config.flatRockHeight;
    computeUniforms[30] = config.terrainScale;
    computeUniforms[31] = config.terrainSharpness;
    computeUniforms[32] = config.terrainTilt;
    computeUniforms[33] = config.fbmOctaves;
    computeUniforms[34] = config.fbmPersistence;
    computeUniforms[35] = config.minWaterDepth;

    this.device.queue.writeBuffer(this.computeUniformBuffer!, 0, computeUniforms);

    const commandEncoder = this.device.createCommandEncoder();

    // Toggle ping pong bind group
    const activeBindGroup = this.pingPongToggle ? this.computeBindGroupB! : this.computeBindGroupA!;
    const activeTerrainBindGroup = this.pingPongToggle
      ? this.terrainBindGroupB!
      : this.terrainBindGroupA!;
    const activeFluidsBindGroup = this.pingPongToggle
      ? this.fluidsBindGroupB!
      : this.fluidsBindGroupA!;

    const workgroupCount = Math.ceil(this.size / 16);

    // 1. Sim Flux Pass
    const passFlux = commandEncoder.beginComputePass();
    passFlux.setPipeline(this.simFluxPipeline!);
    passFlux.setBindGroup(0, activeBindGroup);
    passFlux.dispatchWorkgroups(workgroupCount, workgroupCount, 1);
    passFlux.end();

    // 2. Sim Terrain Pass
    const passTerrain = commandEncoder.beginComputePass();
    passTerrain.setPipeline(this.simTerrainPipeline!);
    passTerrain.setBindGroup(0, activeTerrainBindGroup);
    passTerrain.dispatchWorkgroups(workgroupCount, workgroupCount, 1);
    passTerrain.end();

    // 3. Sim Fluids Pass
    const passFluids = commandEncoder.beginComputePass();
    passFluids.setPipeline(this.simFluidsPipeline!);
    passFluids.setBindGroup(0, activeFluidsBindGroup);
    passFluids.dispatchWorkgroups(workgroupCount, workgroupCount, 1);
    passFluids.end();

    this.device.queue.submit([commandEncoder.finish()]);

    // Swap read/write pointers
    this.pingPongToggle = !this.pingPongToggle;

    if (!this.initialized) {
      this.initialized = true;
    }
  }

  /**
   * Run picking pass over a 1x1 render target centered under cursor
   */
  public async performPicking(camera: THREE.PerspectiveCamera, x: number, y: number) {
    if (!this.device || !this.resourcesReady || this.isPickingMapInProgress) return;

    this.isPickingMapInProgress = true;

    // Set viewport offset in Three camera to render only the 1x1 window under cursor
    camera.setViewOffset(window.innerWidth, window.innerHeight, x, y, 1, 1);
    camera.updateProjectionMatrix();

    // WebGPU NDC Z correction matrix: maps Z from [-1, 1] to [0, 1]
    const webgpuProj = new THREE.Matrix4()
      .set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(camera.projectionMatrix);

    // Apply the X-axis -90 degree rotation matrix (model matrix) matching the grid orientation
    const modelMatrix = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    const mvp = new THREE.Matrix4()
      .multiplyMatrices(webgpuProj, camera.matrixWorldInverse)
      .multiply(modelMatrix);

    // Transform camera and light coordinates to local space
    const invModel = new THREE.Matrix4().copy(modelMatrix).invert();
    const localSun = new THREE.Vector3(0.0, 1.0, 0.5).normalize().applyMatrix4(invModel);
    const localCameraPos = new THREE.Vector3().copy(camera.position).applyMatrix4(invModel);

    // Write Render Uniform buffer for picking
    const renderUniforms = new Float32Array(40);
    renderUniforms.set(mvp.elements, 0); // 0-15
    renderUniforms.set([localSun.x, localSun.y, localSun.z], 16); // 16-18
    renderUniforms[19] = config.heightScale; // 19
    renderUniforms.set([1.0, 0.95, 0.85], 20); // 20-22 (sun color)
    renderUniforms[23] = this.size; // 23
    renderUniforms.set([localCameraPos.x, localCameraPos.y, localCameraPos.z], 24); // 24-26
    renderUniforms[27] = 0.0; // 27: layer (terrain picking only)
    renderUniforms[28] = config.showRock ? 1.0 : 0.0;
    renderUniforms[29] = config.showSand ? 1.0 : 0.0;
    renderUniforms[30] = config.showWater ? 1.0 : 0.0;
    renderUniforms[31] = config.showLava ? 1.0 : 0.0;
    renderUniforms[32] = config.showSuspendedSand ? 1.0 : 0.0;
    renderUniforms[33] = this.time;
    renderUniforms[34] = config.smoothRendering ? 1.0 : 0.0;
    renderUniforms[35] = config.borderBehavior;
    renderUniforms[36] = config.borderWaterHeight;
    renderUniforms[37] = 0; // padding 0
    renderUniforms[38] = 0; // padding 1
    renderUniforms[39] = 0; // padding 2

    this.device.queue.writeBuffer(this.renderUniformBufferTerrain!, 0, renderUniforms);

    const commandEncoder = this.device.createCommandEncoder();

    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.pickingTexture!.createView(),
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.pickingDepthTexture!.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    passEncoder.setPipeline(this.renderPickingPipeline!);
    passEncoder.setBindGroup(
      0,
      this.pingPongToggle ? this.pickingBindGroupB! : this.pickingBindGroupA!
    );
    passEncoder.setVertexBuffer(0, this.vertexBuffer!);
    passEncoder.setIndexBuffer(this.indexBuffer!, 'uint32');
    passEncoder.drawIndexed(this.indexCount, 1, 0, 0, 0);
    passEncoder.end();

    // Copy picking 1x1 result to mapping buffer
    commandEncoder.copyTextureToBuffer(
      { texture: this.pickingTexture! },
      { buffer: this.pickingReadbackBuffer! },
      [1, 1, 1]
    );

    this.device.queue.submit([commandEncoder.finish()]);

    // Restore camera matrix
    camera.clearViewOffset();
    camera.updateProjectionMatrix();

    // Map buffer to retrieve float UV pixel data
    try {
      await this.pickingReadbackBuffer!.mapAsync(GPUMapMode.READ);
      const arrayBuffer = this.pickingReadbackBuffer!.getMappedRange();
      const floats = new Float32Array(arrayBuffer);

      if (floats[3] > 0.0) {
        if (!this.pointerUV) this.pointerUV = new THREE.Vector2();
        this.pointerUV.set(floats[0], floats[1]);
      } else {
        this.pointerUV = null;
      }
      this.pickingReadbackBuffer!.unmap();
    } catch (err) {
      console.warn('Picking buffer mapping failed:', err);
      this.pointerUV = null;
    } finally {
      this.isPickingMapInProgress = false;
    }
  }

  /**
   * Main rendering loop to draw the terrain and fluid layers to the canvas
   */
  public render(camera: THREE.PerspectiveCamera) {
    if (!this.device || !this.resourcesReady) return;

    // Recreate depth texture if canvas dimensions changed
    const currentWidth = Math.max(1, this.canvas.width);
    const currentHeight = Math.max(1, this.canvas.height);
    if (
      !this.depthTexture ||
      this.depthTexture.width !== currentWidth ||
      this.depthTexture.height !== currentHeight
    ) {
      this.resizeDepthTexture();
    }

    // WebGPU NDC Z correction matrix: maps Z from [-1, 1] to [0, 1]
    const webgpuProj = new THREE.Matrix4()
      .set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(camera.projectionMatrix);

    // Apply the X-axis -90 degree rotation matrix (model matrix) matching the grid orientation
    const modelMatrix = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    const mvp = new THREE.Matrix4()
      .multiplyMatrices(webgpuProj, camera.matrixWorldInverse)
      .multiply(modelMatrix);

    // Transform camera and light coordinates to local space
    const invModel = new THREE.Matrix4().copy(modelMatrix).invert();
    const localSun = new THREE.Vector3(0.0, 1.0, 0.5).normalize().applyMatrix4(invModel);
    const localCameraPos = new THREE.Vector3().copy(camera.position).applyMatrix4(invModel);

    // Render active bind group selection
    const activeRenderTerrainBindGroup = this.pingPongToggle
      ? this.renderTerrainBindGroupB!
      : this.renderTerrainBindGroupA!;
    const activeRenderFluidsBindGroup = this.pingPongToggle
      ? this.renderFluidsBindGroupB!
      : this.renderFluidsBindGroupA!;

    const commandEncoder = this.device.createCommandEncoder();

    // --- PASS 1: Render Opaque Terrain ---
    // Clear to noon sky color (matching Three.js clear)
    const skyColor = { r: 0.2, g: 0.45, b: 0.75, a: 1.0 };

    // Write Render Uniforms for Terrain layer
    const renderUniforms = new Float32Array(40);
    renderUniforms.set(mvp.elements, 0); // 0-15
    renderUniforms.set([localSun.x, localSun.y, localSun.z], 16); // 16-18
    renderUniforms[19] = config.heightScale; // 19
    renderUniforms.set([1.0, 0.95, 0.85], 20); // 20-22
    renderUniforms[23] = this.size; // 23
    renderUniforms.set([localCameraPos.x, localCameraPos.y, localCameraPos.z], 24); // 24-26
    renderUniforms[27] = 0.0; // layer 0 (Terrain)
    renderUniforms[28] = config.showRock ? 1.0 : 0.0;
    renderUniforms[29] = config.showSand ? 1.0 : 0.0;
    renderUniforms[30] = config.showWater ? 1.0 : 0.0;
    renderUniforms[31] = config.showLava ? 1.0 : 0.0;
    renderUniforms[32] = config.showSuspendedSand ? 1.0 : 0.0;
    renderUniforms[33] = this.time;
    renderUniforms[34] = config.smoothRendering ? 1.0 : 0.0;
    renderUniforms[35] = config.borderBehavior;
    renderUniforms[36] = config.borderWaterHeight;

    this.device.queue.writeBuffer(this.renderUniformBufferTerrain!, 0, renderUniforms);

    // Write Render Uniforms for Fluids layer
    const renderUniformsFluids = new Float32Array(renderUniforms);
    renderUniformsFluids[27] = 1.0; // layer 1 (Fluids)
    this.device.queue.writeBuffer(this.renderUniformBufferFluids!, 0, renderUniformsFluids);

    const canvasTextureView = this.context!.getCurrentTexture().createView();

    const passTerrain = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: canvasTextureView,
          clearValue: skyColor,
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.depthTexture!.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    passTerrain.setPipeline(this.renderTerrainPipeline!);
    passTerrain.setBindGroup(0, activeRenderTerrainBindGroup);
    passTerrain.setVertexBuffer(0, this.vertexBuffer!);
    passTerrain.setIndexBuffer(this.indexBuffer!, 'uint32');
    passTerrain.drawIndexed(this.indexCount, 1, 0, 0, 0);
    passTerrain.end();

    // --- PASS 2: Render Blended Fluids (Water/Lava) ---
    const passFluids = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: canvasTextureView,
          loadOp: 'load', // Load previously rendered terrain
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.depthTexture!.createView(),
        depthLoadOp: 'load', // Keep depth buffer for occlusion
        depthStoreOp: 'store',
      },
    });

    passFluids.setPipeline(this.renderFluidsPipeline!);
    passFluids.setBindGroup(0, activeRenderFluidsBindGroup);
    passFluids.setVertexBuffer(0, this.vertexBuffer!);
    passFluids.setIndexBuffer(this.indexBuffer!, 'uint32');
    passFluids.drawIndexed(this.indexCount, 1, 0, 0, 0);
    passFluids.end();

    this.device.queue.submit([commandEncoder.finish()]);
  }
}
