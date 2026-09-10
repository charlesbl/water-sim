import { config } from './config';
import atmosphereWGSL from './shaders/atmosphere.wgsl?raw';
import surfaceThermalWGSL from './shaders/surfaceThermal.wgsl?raw';
import cloudPhysicsWGSL from './shaders/cloudPhysics.wgsl?raw';

export const ATMOSPHERE_DIMENSIONS: readonly [number, number, number] = [96, 96, 64];

type PassName =
  | 'initializeSurface'
  | 'reduceColumns'
  | 'initializeVolume'
  | 'captureObstructedWater'
  | 'reduceLayers'
  | 'prepareHeat'
  | 'exchangeHeat'
  | 'gatherHeat'
  | 'radiateColumns'
  | 'prepareSolar'
  | 'normalizeSolar'
  | 'prepareSurfaceMapping'
  | 'prepareCourant'
  | 'advect'
  | 'divergence'
  | 'cgApply'
  | 'cgReduceBefore'
  | 'cgUpdate'
  | 'cgReduceAfter'
  | 'cgDirection'
  | 'project'
  | 'sediment'
  | 'surfaceExchange';

interface AtmosphericBindings {
  initializeSurface: GPUBindGroup;
  reduceColumns: GPUBindGroup;
  initializeVolume: [GPUBindGroup, GPUBindGroup];
  captureObstructedWater: [GPUBindGroup, GPUBindGroup];
  reduceLayers: [GPUBindGroup, GPUBindGroup];
  prepareHeat: [GPUBindGroup, GPUBindGroup];
  exchangeHeat: GPUBindGroup;
  gatherHeat: GPUBindGroup;
  radiateColumns: [GPUBindGroup, GPUBindGroup];
  prepareSolar: GPUBindGroup;
  normalizeSolar: GPUBindGroup;
  prepareSurfaceMapping: GPUBindGroup;
  prepareCourant: [GPUBindGroup, GPUBindGroup];
  advect: [GPUBindGroup, GPUBindGroup];
  divergence: [GPUBindGroup, GPUBindGroup];
  cgApply: GPUBindGroup;
  cgReduceBefore: GPUBindGroup;
  cgUpdate: GPUBindGroup;
  cgReduceAfter: GPUBindGroup;
  cgDirection: GPUBindGroup;
  project: [GPUBindGroup, GPUBindGroup];
  sediment: [GPUBindGroup, GPUBindGroup];
  surfaceExchange: [GPUBindGroup, GPUBindGroup];
}

/**
 * A small, genuinely volumetric weather model, entirely stepped by WebGPU.
 *
 * The 3-D grid uses periodic or sealed horizontal boundaries, solid terrain and
 * lid, and a staggered divergence/pressure-gradient pair. Velocities in each
 * cell are stored on its positive x/y/z faces. Scalars live at cell centers.
 * Moisture is equivalent liquid-water volume per local air volume; snow and
 * ice at the surface use the same water-equivalent units as fluids.water.
 *
 * Water uses conservative finite-volume transport with common face fluxes and
 * a limited second-order reconstruction, falling back to donor transport at
 * large Courant numbers. Potential temperature uses conservative face fluxes;
 * velocity uses semi-Lagrangian transport.
 * Closed-cycle mode disables moisture forcing. Exact fine-grid area weights
 * preserve surface transfers, and pending evaporation waits for available air.
 * Initialization and resets explicitly edit the inventory. This is an
 * illustrative weather model, not a scientific forecast model.
 */
export class AtmosphereSimulation {
  public readonly dimensions: readonly [number, number, number] = ATMOSPHERE_DIMENSIONS;
  public readonly domainHeight = 100;
  public readonly surfaceBuffer: GPUBuffer;
  public simulationTime = 0;

  private readonly volumes: [GPUBuffer, GPUBuffer];
  private readonly pressureBuffer: GPUBuffer;
  private readonly pressureGeometry: GPUBuffer;
  private readonly outgoingCourants: GPUBuffer;
  public readonly columns: GPUBuffer;
  private readonly precipitation: GPUBuffer;
  private readonly divergenceBuffer: GPUBuffer;
  private readonly conjugateState: GPUBuffer;
  private readonly conjugatePartials: GPUBuffer;
  private readonly conjugateCoefficients: GPUBuffer;
  private readonly layerMeans: GPUBuffer;
  private readonly surfaceHeat: GPUBuffer;
  private readonly heatProfiles: GPUBuffer;
  private readonly heatTransfers: GPUBuffer;
  private readonly longwaveHeating: GPUBuffer;
  private readonly solarPartials: GPUBuffer;
  private readonly solarNormalization: GPUBuffer;
  private readonly depositionWeights: GPUBuffer;
  private readonly depositionWeightValues: [Float32Array, Float32Array];
  private depositionBoundary = -1;
  private surfaceMappingBoundary = -1;
  private readonly uniforms: GPUBuffer;
  private readonly uniformValues = new Float32Array(32);
  private readonly bindCache = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, AtmosphericBindings>>();
  private pipelines: Record<PassName, GPUComputePipeline> | null = null;
  private current = 0;
  private needsReset = true;
  private needsSurfaceClear = true;

  constructor(
    private readonly device: GPUDevice,
    private readonly surfaceSize: number
  ) {
    const [nx, ny, nz] = this.dimensions;
    const volumeCells = nx * ny * nz;
    const storage = (label: string, size: number): GPUBuffer =>
      device.createBuffer({
        label,
        size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
    this.volumes = [
      storage('Atmosphere volume A', volumeCells * 32),
      storage('Atmosphere volume B', volumeCells * 32),
    ];
    this.pressureBuffer = storage('Atmosphere pressure', volumeCells * 4);
    this.pressureGeometry = storage('Pressure face mask and diagonal', volumeCells * 8);
    this.outgoingCourants = storage('Outgoing atmospheric Courant numbers', volumeCells * 4);
    this.surfaceBuffer = storage(
      'Snow, ice, surface temperature, evaporated water',
      surfaceSize * surfaceSize * 16
    );
    this.columns = storage(
      'Terrain and surface exchange reduced to atmospheric columns',
      nx * ny * 16
    );
    this.precipitation = storage('Atmospheric rain and snow deposition', nx * ny * 8);
    this.divergenceBuffer = storage('Atmosphere divergence', volumeCells * 4);
    this.conjugateState = storage(
      'Pressure residual, preconditioner, direction, matrix product',
      volumeCells * 16
    );
    this.conjugatePartials = storage(
      'Pressure dot product partial sums',
      Math.ceil(volumeCells / 256) * 8
    );
    this.conjugateCoefficients = storage('Pressure conjugate gradient coefficients', 16);
    this.layerMeans = storage('Horizontal mean air temperature and vapor', nz * 16);
    this.surfaceHeat = storage('Paired surface to air sensible heat', nx * ny * 4);
    this.heatProfiles = storage('Near-ground air thermal profiles', nx * ny * 16);
    this.heatTransfers = storage(
      'Four conservative heat transfers per surface cell',
      surfaceSize * surfaceSize * 16
    );
    this.longwaveHeating = storage('Atmospheric infrared temperature increments', volumeCells * 4);
    this.solarPartials = storage(
      'Raw and contrasted solar energy sums',
      Math.ceil(surfaceSize / 16) ** 2 * 8
    );
    // Share the radiation budget binding to keep surfaceExchange within the
    // default WebGPU limit of eight storage buffers per shader stage.
    this.solarNormalization = storage(
      'Solar normalization, column infrared fluxes and surface mapping',
      (1 + nx * ny) * 16 + surfaceSize * 32
    );
    this.depositionWeights = storage('Conservative smooth precipitation weights', nx * ny * 4);
    // Geometry-only quadrature weights. Physics and deposition remain on GPU.
    // Normalize the tent footprint of each coarse cell on the fine grid,
    // including periodic edges and non-divisible surface sizes (e.g. 2048/96).
    const axisWeights = (count: number, sealed: boolean) => {
      const weights = new Float64Array(count);
      for (let fine = 0; fine < surfaceSize; fine++) {
        const p = ((fine + 0.5) * count) / surfaceSize - 0.5;
        const left = Math.floor(p);
        const fraction = p - left;
        const coordinate = (i: number) =>
          sealed ? Math.max(0, Math.min(count - 1, i)) : (i + count) % count;
        weights[coordinate(left)] += 1 - fraction;
        weights[coordinate(left + 1)] += fraction;
      }
      return weights;
    };
    const weightTable = (sealed: boolean): Float32Array => {
      const weightsX = axisWeights(nx, sealed);
      const weightsY = axisWeights(ny, sealed);
      const weights = new Float32Array(nx * ny);
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          weights[y * nx + x] = (surfaceSize * surfaceSize) / (nx * ny * weightsX[x] * weightsY[y]);
        }
      }
      return weights;
    };
    this.depositionWeightValues = [weightTable(false), weightTable(true)];
    this.uniforms = device.createBuffer({
      label: 'Atmosphere parameters',
      size: this.uniformValues.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  public get volumeBuffer(): GPUBuffer {
    return this.volumes[this.current];
  }

  public async init(): Promise<void> {
    const module = this.device.createShaderModule({
      label: 'Volumetric atmosphere WGSL',
      code: surfaceThermalWGSL + '\n' + cloudPhysicsWGSL + '\n' + atmosphereWGSL,
    });
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter((message) => message.type === 'error');
    if (errors.length > 0) {
      throw new Error(
        `Atmosphere shader compilation failed:\n${errors.map((error) => `${error.lineNum}:${error.linePos} ${error.message}`).join('\n')}`
      );
    }
    const names: PassName[] = [
      'initializeSurface',
      'reduceColumns',
      'initializeVolume',
      'captureObstructedWater',
      'reduceLayers',
      'prepareHeat',
      'exchangeHeat',
      'gatherHeat',
      'radiateColumns',
      'prepareSolar',
      'normalizeSolar',
      'prepareSurfaceMapping',
      'prepareCourant',
      'advect',
      'divergence',
      'cgApply',
      'cgReduceBefore',
      'cgUpdate',
      'cgReduceAfter',
      'cgDirection',
      'project',
      'sediment',
      'surfaceExchange',
    ];
    const compiled = await Promise.all(
      names.map(async (name) => {
        try {
          const pipeline = await this.device.createComputePipelineAsync({
            label: `Atmosphere ${name}`,
            layout: 'auto',
            compute: { module, entryPoint: name },
          });
          return [name, pipeline] as const;
        } catch (error) {
          throw new Error(`Atmosphere pipeline ${name} failed: ${String(error)}`);
        }
      })
    );
    this.pipelines = Object.fromEntries(compiled) as Record<PassName, GPUComputePipeline>;
  }

  /**
   * Call once per submitted encoder (the parameter upload precedes submission).
   * dt is already scaled by the caller; zero dt still processes pending resets.
   */
  public step(encoder: GPUCommandEncoder, terrain: GPUBuffer, fluids: GPUBuffer, dt: number): void {
    if (!this.pipelines) return;
    const timestep =
      config.atmosphereEnabled && Number.isFinite(dt) ? Math.min(0.1, Math.max(0, dt)) : 0;
    if (timestep === 0 && !this.needsReset && !this.needsSurfaceClear) return;

    const [nx, ny, nz] = this.dimensions;
    const angle = (config.windDirection * Math.PI) / 180;
    const elevation = (config.sunElevation * Math.PI) / 180;
    const azimuth = (config.sunAzimuth * Math.PI) / 180;
    this.uniformValues.set([
      nx,
      ny,
      nz,
      this.surfaceSize,
      200 / nx,
      200 / ny,
      this.domainHeight / nz,
      timestep,
      config.airTemperature,
      config.relativeHumidity,
      config.windSpeed * Math.cos(angle),
      config.windSpeed * Math.sin(angle),
      config.solarHeating,
      config.heightScale,
      this.simulationTime,
      this.domainHeight,
      0.16 - 0.04 * Math.max(0, Math.min(1, config.airStability)),
      14,
      2.5,
      config.emergentWeather ? 1 : 0,
      Math.cos(elevation) * Math.cos(azimuth),
      Math.cos(elevation) * Math.sin(azimuth),
      Math.sin(elevation),
      config.radiativeCooling,
      config.closedWaterCycle ? 1 : 0,
      config.atmosphereBoundary,
      config.evaporationRate,
      Math.max(1, Math.min(10, config.heatingContrast)),
      this.domainHeight * 0.4,
      this.domainHeight * 0.65,
      0.04,
      Math.max(0, Math.min(8, config.convectionStrength)),
    ]);
    this.device.queue.writeBuffer(this.uniforms, 0, this.uniformValues);
    const boundary = config.atmosphereBoundary === 1 ? 1 : 0;
    if (this.depositionBoundary !== boundary) {
      this.device.queue.writeBuffer(
        this.depositionWeights,
        0,
        this.depositionWeightValues[boundary].slice().buffer
      );
      this.depositionBoundary = boundary;
    }
    const groups = this.bindings(terrain, fluids);
    const dispatch = (name: PassName, group: GPUBindGroup, x: number, y: number, z = 1): void => {
      const pass = encoder.beginComputePass({ label: `Atmosphere ${name}` });
      pass.setPipeline(this.pipelines![name]);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(x, y, z);
      pass.end();
    };
    const volumePass = (name: PassName, group: GPUBindGroup): void =>
      dispatch(name, group, Math.ceil(nx / 4), Math.ceil(ny / 4), Math.ceil(nz / 4));
    const surfaceGroups = Math.ceil(this.surfaceSize / 16);

    // Dimensions are fixed for this instance. Rebuild only when horizontal
    // boundaries change, including resets at zero dt before the first exchange.
    if (this.surfaceMappingBoundary !== boundary) {
      dispatch(
        'prepareSurfaceMapping',
        groups.prepareSurfaceMapping,
        Math.ceil(this.surfaceSize / 64),
        1
      );
      this.surfaceMappingBoundary = boundary;
    }

    if (this.needsSurfaceClear) {
      dispatch('initializeSurface', groups.initializeSurface, surfaceGroups, surfaceGroups);
      this.needsSurfaceClear = false;
    }
    dispatch('reduceColumns', groups.reduceColumns, Math.ceil(nx / 8), Math.ceil(ny / 8));
    if (this.needsReset) {
      volumePass('initializeVolume', groups.initializeVolume[0]);
      volumePass('initializeVolume', groups.initializeVolume[1]);
      this.current = 0;
      this.needsReset = false;
    }
    if (timestep === 0) return;

    const source = this.current;
    const advected = 1 - source;
    dispatch(
      'captureObstructedWater',
      groups.captureObstructedWater[source],
      Math.ceil(nx / 8),
      Math.ceil(ny / 8)
    );
    dispatch('reduceLayers', groups.reduceLayers[source], nz, 1);
    dispatch('prepareSolar', groups.prepareSolar, surfaceGroups, surfaceGroups);
    dispatch('normalizeSolar', groups.normalizeSolar, 1, 1);
    dispatch('prepareHeat', groups.prepareHeat[source], Math.ceil(nx / 8), Math.ceil(ny / 8));
    dispatch('exchangeHeat', groups.exchangeHeat, surfaceGroups, surfaceGroups);
    dispatch('gatherHeat', groups.gatherHeat, nx, ny);
    dispatch('radiateColumns', groups.radiateColumns[source], Math.ceil(nx / 8), Math.ceil(ny / 8));
    volumePass('prepareCourant', groups.prepareCourant[source]);
    volumePass('advect', groups.advect[source]);
    volumePass('divergence', groups.divergence[advected]);
    // Preconditioned conjugate gradients resolve broad circulation modes that
    // local Jacobi sweeps leave divergent. Every dot product stays on the GPU.
    const pressureGroups = Math.ceil((nx * ny * nz) / 256);
    for (let iteration = 0; iteration < 20; iteration++) {
      dispatch('cgApply', groups.cgApply, pressureGroups, 1);
      dispatch('cgReduceBefore', groups.cgReduceBefore, 1, 1);
      dispatch('cgUpdate', groups.cgUpdate, pressureGroups, 1);
      dispatch('cgReduceAfter', groups.cgReduceAfter, 1, 1);
      dispatch('cgDirection', groups.cgDirection, pressureGroups, 1);
    }
    volumePass('project', groups.project[advected]);
    volumePass('sediment', groups.sediment[source]);
    this.current = advected;
    dispatch('surfaceExchange', groups.surfaceExchange[this.current], surfaceGroups, surfaceGroups);
    this.simulationTime += timestep;
  }

  public reset(clearSurface = true): void {
    this.needsReset = true;
    this.needsSurfaceClear ||= clearSurface;
    this.simulationTime = 0;
  }

  public clearSurface(): void {
    this.needsSurfaceClear = true;
  }

  public destroy(): void {
    for (const buffer of [
      ...this.volumes,
      this.pressureBuffer,
      this.pressureGeometry,
      this.outgoingCourants,
      this.surfaceBuffer,
      this.columns,
      this.precipitation,
      this.divergenceBuffer,
      this.conjugateState,
      this.conjugatePartials,
      this.conjugateCoefficients,
      this.layerMeans,
      this.surfaceHeat,
      this.heatProfiles,
      this.heatTransfers,
      this.longwaveHeating,
      this.solarPartials,
      this.solarNormalization,
      this.depositionWeights,
      this.uniforms,
    ])
      buffer.destroy();
    this.pipelines = null;
  }

  private bindings(terrain: GPUBuffer, fluids: GPUBuffer): AtmosphericBindings {
    let terrainCache = this.bindCache.get(terrain);
    if (!terrainCache) {
      terrainCache = new WeakMap();
      this.bindCache.set(terrain, terrainCache);
    }
    const cached = terrainCache.get(fluids);
    if (cached) return cached;
    const group = (name: PassName, buffers: Array<readonly [number, GPUBuffer]>): GPUBindGroup =>
      this.device.createBindGroup({
        label: `Atmosphere ${name} bindings`,
        layout: this.pipelines![name].getBindGroupLayout(0),
        entries: [[0, this.uniforms] as const, ...buffers].map(([binding, buffer]) => ({
          binding,
          resource: { buffer },
        })),
      });
    const pair = (create: (index: number) => GPUBindGroup): [GPUBindGroup, GPUBindGroup] => [
      create(0),
      create(1),
    ];
    const groups: AtmosphericBindings = {
      initializeSurface: group('initializeSurface', [
        [4, terrain],
        [6, this.surfaceBuffer],
      ]),
      reduceColumns: group('reduceColumns', [
        [3, this.columns],
        [4, terrain],
        [5, fluids],
        [6, this.surfaceBuffer],
      ]),
      initializeVolume: pair((i) =>
        group('initializeVolume', [
          [2, this.volumes[i]],
          [3, this.columns],
        ])
      ),
      captureObstructedWater: pair((i) =>
        group('captureObstructedWater', [
          [1, this.volumes[i]],
          [3, this.columns],
          [10, this.precipitation],
        ])
      ),
      reduceLayers: pair((i) =>
        group('reduceLayers', [
          [1, this.volumes[i]],
          [3, this.columns],
          [12, this.layerMeans],
        ])
      ),
      prepareHeat: pair((i) =>
        group('prepareHeat', [
          [1, this.volumes[i]],
          [3, this.columns],
          [11, this.depositionWeights],
          [19, this.heatProfiles],
        ])
      ),
      exchangeHeat: group('exchangeHeat', [
        [4, terrain],
        [5, fluids],
        [6, this.surfaceBuffer],
        [19, this.heatProfiles],
        [20, this.heatTransfers],
        [18, this.solarNormalization],
      ]),
      gatherHeat: group('gatherHeat', [
        [6, this.surfaceBuffer],
        [11, this.depositionWeights],
        [16, this.surfaceHeat],
        [20, this.heatTransfers],
        [18, this.solarNormalization],
      ]),
      radiateColumns: pair((i) =>
        group('radiateColumns', [
          [1, this.volumes[i]],
          [3, this.columns],
          [11, this.depositionWeights],
          [18, this.solarNormalization],
          [22, this.longwaveHeating],
        ])
      ),
      prepareSolar: group('prepareSolar', [
        [4, terrain],
        [5, fluids],
        [6, this.surfaceBuffer],
        [17, this.solarPartials],
      ]),
      prepareSurfaceMapping: group('prepareSurfaceMapping', [[18, this.solarNormalization]]),
      normalizeSolar: group('normalizeSolar', [
        [17, this.solarPartials],
        [18, this.solarNormalization],
      ]),
      prepareCourant: pair((i) =>
        group('prepareCourant', [
          [1, this.volumes[i]],
          [3, this.columns],
          [24, this.outgoingCourants],
        ])
      ),
      advect: pair((i) =>
        group('advect', [
          [1, this.volumes[i]],
          [2, this.volumes[1 - i]],
          [3, this.columns],
          [12, this.layerMeans],
          [16, this.surfaceHeat],
          [22, this.longwaveHeating],
          [24, this.outgoingCourants],
        ])
      ),
      divergence: pair((i) =>
        group('divergence', [
          [1, this.volumes[i]],
          [3, this.columns],
          [8, this.pressureBuffer],
          [9, this.divergenceBuffer],
          [13, this.conjugateState],
          [23, this.pressureGeometry],
        ])
      ),
      cgApply: group('cgApply', [
        [13, this.conjugateState],
        [14, this.conjugatePartials],
        [23, this.pressureGeometry],
      ]),
      cgReduceBefore: group('cgReduceBefore', [
        [14, this.conjugatePartials],
        [15, this.conjugateCoefficients],
      ]),
      cgUpdate: group('cgUpdate', [
        [8, this.pressureBuffer],
        [13, this.conjugateState],
        [14, this.conjugatePartials],
        [15, this.conjugateCoefficients],
        [23, this.pressureGeometry],
      ]),
      cgReduceAfter: group('cgReduceAfter', [
        [14, this.conjugatePartials],
        [15, this.conjugateCoefficients],
      ]),
      cgDirection: group('cgDirection', [
        [13, this.conjugateState],
        [15, this.conjugateCoefficients],
      ]),
      project: pair((i) =>
        group('project', [
          [1, this.volumes[i]],
          [2, this.volumes[1 - i]],
          [3, this.columns],
          [7, this.pressureBuffer],
        ])
      ),
      sediment: pair((i) =>
        group('sediment', [
          [1, this.volumes[i]],
          [2, this.volumes[1 - i]],
          [3, this.columns],
          [10, this.precipitation],
        ])
      ),
      surfaceExchange: pair((i) =>
        group('surfaceExchange', [
          [1, this.volumes[i]],
          [3, this.columns],
          [4, terrain],
          [5, fluids],
          [6, this.surfaceBuffer],
          [10, this.precipitation],
          [11, this.depositionWeights],
          [18, this.solarNormalization],
        ])
      ),
    };
    terrainCache.set(fluids, groups);
    return groups;
  }
}
