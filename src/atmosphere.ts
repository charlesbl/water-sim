import { config } from './config';
import atmosphereWGSL from './shaders/atmosphere.wgsl?raw';
import surfaceThermalWGSL from './shaders/surfaceThermal.wgsl?raw';
import cloudPhysicsWGSL from './shaders/cloudPhysics.wgsl?raw';
export const ATMOSPHERE_DIMENSIONS: readonly [number, number, number] = [256, 256, 2];
export const WEATHER_TIMESTEP = 1 / 20;
const PASSES = [
  'initializeSurface',
  'reduceColumns',
  'initializeVolume',
  'prepareSurfaceMapping',
  'prepareSolar',
  'normalizeSolar',
  'prepareHeat',
  'exchangeHeat',
  'gatherHeat',
  'radiateColumns',
  'moveAir',
  'prepareCourant',
  'transport',
  'microphysics',
  'surfaceExchange',
] as const;
type PassName = (typeof PASSES)[number];
type Bindings = Record<PassName, [GPUBindGroup, GPUBindGroup]>;
/**
 * Two terrain-following layers over a nominal 10 km game region.
 * XY velocity, diagnostic pressure anomaly and temperature occupy the first
 * vec4; vapor/cloud/rain/snow densities occupy the second. Water uses shared,
 * positivity-limited face fluxes and conservative inter-layer transfers.
 * The pressure is an explicit damped gravity-wave approximation, not the old
 * 3-D incompressible projection. No global iterative pressure solve is needed.
 * Surface hydrology, snow/ice, paired heat exchange and water units are retained.
 */
export class AtmosphereSimulation {
  public readonly dimensions: readonly [number, number, number];
  // Accounting depth, independent of the artist-controlled cloud geometry.
  public readonly domainHeight = 32;
  public readonly surfaceBuffer: GPUBuffer;
  public readonly columns: GPUBuffer;
  // Rain-memory wetness, rain rate, convective exchange, cloud coverage.
  public readonly weatherMap: GPUBuffer;
  public simulationTime = 0;
  private readonly volumes: [GPUBuffer, GPUBuffer];
  private readonly precipitation: GPUBuffer;
  private readonly outgoingCourants: GPUBuffer;
  private readonly surfaceHeat: GPUBuffer;
  private readonly heatProfiles: GPUBuffer;
  private readonly heatTransfers: GPUBuffer;
  private readonly longwaveHeating: GPUBuffer;
  private readonly solarPartials: GPUBuffer;
  private readonly solarNormalization: GPUBuffer;
  private readonly depositionWeights: GPUBuffer;
  private readonly depositionWeightValues: [Float32Array, Float32Array];
  private depositionBoundary = -1;
  private readonly uniforms: GPUBuffer;
  private readonly uniformValues = new Float32Array(48);
  private readonly bindCache = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, Bindings>>();
  private pipelines: Record<PassName, GPUComputePipeline> | null = null;
  private needsReset = true;
  private needsSurfaceClear = true;
  constructor(
    private readonly device: GPUDevice,
    private readonly surfaceSize: number
  ) {
    const width = Math.min(ATMOSPHERE_DIMENSIONS[0], surfaceSize);
    this.dimensions = [width, width, 2];
    const [nx, ny, nz] = this.dimensions;
    const count = nx * ny;
    const storage = (label: string, size: number): GPUBuffer =>
      device.createBuffer({
        label,
        size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
    this.volumes = [
      storage('Two-layer air', count * nz * 32),
      storage('Air transport scratch', count * nz * 32),
    ];
    this.surfaceBuffer = storage(
      'Snow, ice, temperature, pending evaporation',
      surfaceSize ** 2 * 16
    );
    this.columns = storage('Terrain-following air columns', count * 16);
    this.weatherMap = storage('Regional weather diagnostics', count * 16);
    this.precipitation = storage('Conservative rain and snow deposition', count * 8);
    this.outgoingCourants = storage('Air transport donor limits', count * nz * 4);
    this.surfaceHeat = storage('Paired surface to air heat', count * 4);
    this.heatProfiles = storage('Near-ground thermal profiles', count * 16);
    this.heatTransfers = storage('Four paired surface heat transfers', surfaceSize ** 2 * 16);
    this.longwaveHeating = storage('Two-layer infrared exchange', count * nz * 4);
    this.solarPartials = storage('Solar absorption partials', Math.ceil(surfaceSize / 16) ** 2 * 8);
    this.solarNormalization = storage(
      'Radiation and surface mapping',
      (1 + count) * 16 + surfaceSize * 32
    );
    this.depositionWeights = storage('Smooth conservative deposition weights', count * 4);
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
      label: 'Regional weather parameters',
      size: this.uniformValues.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }
  public get volumeBuffer(): GPUBuffer {
    return this.volumes[0];
  }
  public async init(): Promise<void> {
    const module = this.device.createShaderModule({
      label: 'Two-layer regional weather',
      code: surfaceThermalWGSL + '\n' + cloudPhysicsWGSL + '\n' + atmosphereWGSL,
    });
    const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error');
    if (errors.length)
      throw new Error(
        errors.map((m) => `Weather ${m.lineNum}:${m.linePos} ${m.message}`).join('\n')
      );
    const compiled = await Promise.all(
      PASSES.map(
        async (name) =>
          [
            name,
            await this.device.createComputePipelineAsync({
              label: `Weather ${name}`,
              layout: 'auto',
              compute: { module, entryPoint: name },
            }),
          ] as const
      )
    );
    this.pipelines = Object.fromEntries(compiled) as Record<PassName, GPUComputePipeline>;
  }
  /** Once per submitted encoder; zero dt still applies explicit pending resets. */
  public step(encoder: GPUCommandEncoder, terrain: GPUBuffer, fluids: GPUBuffer, dt: number): void {
    if (!this.pipelines) return;
    const timestep =
      config.atmosphereEnabled && Number.isFinite(dt) ? Math.min(0.1, Math.max(0, dt)) : 0;
    if (!timestep && !this.needsReset && !this.needsSurfaceClear) return;
    const [nx, ny, nz] = this.dimensions;
    const mapKm = Math.max(5, Math.min(50, config.weatherMapSizeKm));
    const wind = ((Math.max(0, Math.min(6, config.windSpeed)) / 60) * 200) / mapKm;
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
      wind * Math.cos(angle),
      wind * Math.sin(angle),
      config.solarHeating,
      config.heightScale,
      this.simulationTime,
      this.domainHeight,
      0.3,
      2.5,
      5,
      config.emergentWeather ? 1 : 0,
      Math.cos(elevation) * Math.cos(azimuth),
      Math.cos(elevation) * Math.sin(azimuth),
      Math.sin(elevation),
      config.radiativeCooling,
      config.closedWaterCycle ? 1 : 0,
      config.atmosphereBoundary,
      config.evaporationRate,
      Math.max(1, Math.min(10, config.heatingContrast)),
      config.airStability,
      config.orographicLift,
      config.airMixing,
      config.convectionStrength,
      mapKm,
      Math.max(0.5, config.weatherCellSizeKm),
      config.weatherVariability,
      config.weatherSeed,
      Math.max(10, config.rainLifetime),
      config.windShear,
      config.circulationStrength,
      config.cloudShadows,
      Math.max(0, Math.min(3, config.regionalDrive)),
      Math.max(60, config.weatherRenewal),
      Math.max(0, Math.min(3, config.windRotation)),
      0,
      0,
      0,
      0,
      0,
    ]);
    this.device.queue.writeBuffer(this.uniforms, 0, this.uniformValues);
    const groups = this.bindings(terrain, fluids);
    const dispatch = (name: PassName, i: number, x: number, y = 1, z = 1) => {
      const pass = encoder.beginComputePass({ label: `Weather ${name}` });
      pass.setPipeline(this.pipelines![name]);
      pass.setBindGroup(0, groups[name][i]);
      pass.dispatchWorkgroups(x, y, z);
      pass.end();
    };
    const columnPass = (name: PassName, i = 0) =>
      dispatch(name, i, Math.ceil(nx / 8), Math.ceil(ny / 8));
    const airPass = (name: PassName, i = 0) =>
      dispatch(name, i, Math.ceil(nx / 8), Math.ceil(ny / 8), nz);
    const finePass = (name: PassName) =>
      dispatch(name, 0, Math.ceil(this.surfaceSize / 16), Math.ceil(this.surfaceSize / 16));
    const boundary = config.atmosphereBoundary === 1 ? 1 : 0;
    if (this.depositionBoundary !== boundary) {
      this.device.queue.writeBuffer(
        this.depositionWeights,
        0,
        this.depositionWeightValues[boundary].slice().buffer
      );
      dispatch('prepareSurfaceMapping', 0, Math.ceil(this.surfaceSize / 64));
      this.depositionBoundary = boundary;
    }
    if (this.needsSurfaceClear) {
      finePass('initializeSurface');
      this.needsSurfaceClear = false;
    }
    columnPass('reduceColumns');
    if (this.needsReset) {
      airPass('initializeVolume');
      airPass('initializeVolume', 1);
      this.needsReset = false;
    }
    if (!timestep) return;
    finePass('prepareSolar');
    dispatch('normalizeSolar', 0, 1);
    columnPass('prepareHeat');
    finePass('exchangeHeat');
    dispatch('gatherHeat', 0, nx, ny);
    columnPass('radiateColumns');
    airPass('moveAir');
    airPass('prepareCourant', 1);
    airPass('transport', 1);
    columnPass('microphysics');
    finePass('surfaceExchange');
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
    for (const b of [
      ...this.volumes,
      this.surfaceBuffer,
      this.columns,
      this.weatherMap,
      this.precipitation,
      this.outgoingCourants,
      this.surfaceHeat,
      this.heatProfiles,
      this.heatTransfers,
      this.longwaveHeating,
      this.solarPartials,
      this.solarNormalization,
      this.depositionWeights,
      this.uniforms,
    ])
      b.destroy();
    this.pipelines = null;
  }
  private bindings(terrain: GPUBuffer, fluids: GPUBuffer): Bindings {
    let cache = this.bindCache.get(terrain);
    if (!cache) {
      cache = new WeakMap();
      this.bindCache.set(terrain, cache);
    }
    const found = cache.get(fluids);
    if (found) return found;
    const buffers = new Map<number, GPUBuffer>([
      [0, this.uniforms],
      [3, this.columns],
      [4, terrain],
      [5, fluids],
      [6, this.surfaceBuffer],
      [10, this.precipitation],
      [11, this.depositionWeights],
      [16, this.surfaceHeat],
      [17, this.solarPartials],
      [18, this.solarNormalization],
      [19, this.heatProfiles],
      [20, this.heatTransfers],
      [21, this.weatherMap],
      [22, this.longwaveHeating],
      [24, this.outgoingCourants],
    ]);
    const layouts: Record<PassName, number[]> = {
      initializeSurface: [4, 6],
      reduceColumns: [3, 4, 5, 6],
      initializeVolume: [2, 3, 21],
      prepareSurfaceMapping: [18],
      prepareSolar: [4, 5, 6, 17],
      normalizeSolar: [17, 18],
      prepareHeat: [1, 3, 11, 19],
      exchangeHeat: [4, 5, 6, 18, 19, 20],
      gatherHeat: [6, 11, 16, 18, 20],
      radiateColumns: [1, 11, 18, 22],
      moveAir: [1, 2, 3, 16, 22],
      prepareCourant: [1, 24],
      transport: [1, 2, 24],
      microphysics: [2, 3, 10, 21],
      surfaceExchange: [1, 3, 4, 5, 6, 10, 11, 18],
    };
    const result = Object.fromEntries(
      PASSES.map((name) => [
        name,
        [0, 1].map((i) => {
          const selected = new Map(buffers);
          selected.set(1, this.volumes[i]);
          selected.set(
            2,
            this.volumes[name === 'initializeVolume' || name === 'microphysics' ? i : 1 - i]
          );
          return this.device.createBindGroup({
            label: `${name} ${i}`,
            layout: this.pipelines![name].getBindGroupLayout(0),
            entries: [0, ...layouts[name]].map((binding) => ({
              binding,
              resource: { buffer: selected.get(binding)! },
            })),
          });
        }),
      ])
    ) as Bindings;
    cache.set(fluids, result);
    return result;
  }
}
