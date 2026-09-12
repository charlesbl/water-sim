import { config } from './config';
import atmosphereWGSL from './shaders/atmosphere.wgsl?raw';
import circulationWGSL from './shaders/circulation.wgsl?raw';
import surfaceThermalWGSL from './shaders/surfaceThermal.wgsl?raw';
import cloudPhysicsWGSL from './shaders/cloudPhysics.wgsl?raw';
import { AtmospherePressure } from './atmospherePressure';
export const ATMOSPHERE_DIMENSIONS: readonly [number, number, number] = [256, 256, 2];
export const WEATHER_TIMESTEP = 1 / 20;
const PASSES = [
  'initializeSurface',
  'reduceColumns',
  'initializeVolume',
  'syncAirVelocity',
  'prepareSurfaceMapping',
  'prepareHeat',
  'exchangeHeat',
  'gatherHeat',
  'radiateColumns',
  'applyAirHeat',
  'advectMomentum',
  'finishMomentum',
  'forceMomentum',
  'measureFlow',
  'reduceFlow',
  'finalizeMomentum',
  'transportPredict',
  'transportFinish',
  'microphysics',
  'surfaceExchange',
  'reduceEnergy',
] as const;
type PassName = (typeof PASSES)[number];
type Bindings = Record<PassName, [GPUBindGroup, GPUBindGroup]>;
/**
 * Two terrain-following layers in a bottle with impermeable walls.
 * XYZ center velocity and temperature occupy the first vec4; conserved
 * vapor/cloud/rain/snow densities occupy the second. Independent MAC face
 * velocities carry momentum in both layers and through their shared interface.
 * A multigrid pressure projection enforces closed incompressible circulation.
 * Mechanical dissipation and thermal work have explicit heat counterparts.
 * Surface hydrology, snow/ice, paired heat exchange and water units are retained.
 */
export class AtmosphereSimulation {
  public readonly dimensions: readonly [number, number, number];
  // Accounting depth, independent of the artist-controlled cloud geometry.
  public readonly domainHeight = 32;
  public readonly surfaceBuffer: GPUBuffer;
  public readonly columns: GPUBuffer;
  // Rain-memory wetness, rain rate, interface vertical speed, cloud coverage.
  public readonly weatherMap: GPUBuffer;
  public simulationTime = 0;
  private readonly volumes: [GPUBuffer, GPUBuffer];
  private readonly precipitation: GPUBuffer;
  public readonly circulationFaces: GPUBuffer;
  private readonly nextCirculationFaces: GPUBuffer;
  private readonly momentumScratch: GPUBuffer;
  private readonly faceHeat: GPUBuffer;
  private readonly flowPartials: GPUBuffer;
  public readonly flowControl: GPUBuffer;
  private readonly pressure: AtmospherePressure;
  private readonly surfaceHeat: GPUBuffer;
  private readonly heatProfiles: GPUBuffer;
  private readonly heatTransfers: GPUBuffer;
  private readonly longwaveHeating: GPUBuffer;
  private readonly radiationState: GPUBuffer;
  private readonly depositionWeights: GPUBuffer;
  private mappingReady = false;
  public readonly energyFlux: GPUBuffer;
  private readonly uniforms: GPUBuffer;
  private readonly uniformValues = new Float32Array(52);
  private readonly windBrush = new Float32Array(8);

  public setWindBrush(x: number, y: number, radius: number, vx: number, vy: number): void {
    this.windBrush.set([x, y, radius, 0, vx, vy, 0, 0]);
  }
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
    this.weatherMap = storage('Bottle weather diagnostics', count * 16);
    this.precipitation = storage('Rain, snow and paired deposition heat', count * 16);
    this.circulationFaces = storage('Two-layer MAC faces: east, north, up, padding', count * nz * 16);
    this.nextCirculationFaces = storage('Projected MAC faces', count * nz * 16);
    this.momentumScratch = storage('Momentum RK stage and pressure predictor', count * nz * 16);
    this.faceHeat = storage('Paired mechanical heat at MAC faces', count * nz * 16);
    this.flowPartials = storage('Flow energy and Courant reduction', Math.ceil(nx / 8) * Math.ceil(ny / 8) * nz * 16);
    this.flowControl = storage('Global flow scale and numerical dissipation', 16);
    this.pressure = new AtmospherePressure(device, width, this.domainHeight / nz);
    this.surfaceHeat = storage('Paired surface to air heat', count * 4);
    this.heatProfiles = storage('Near-ground thermal profiles', count * 16);
    // Reused after gathering: w holds evaporation's sensible heat until next step.
    this.heatTransfers = storage('Surface heat transfers and pending vapor heat', surfaceSize ** 2 * 16);
    this.longwaveHeating = storage('Two-layer infrared exchange', count * nz * 4);
    this.radiationState = storage(
      'Radiation and surface mapping',
      (1 + count) * 16 + surfaceSize * 32 + Math.ceil(surfaceSize / 16) ** 2 * 16
    );
    this.depositionWeights = storage('Smooth conservative deposition weights', count * 4);
    this.energyFlux = storage('Radiative energy entering and leaving the bottle', 16);
    const axisWeights = (count: number) => {
      const weights = new Float64Array(count);
      for (let fine = 0; fine < surfaceSize; fine++) {
        const p = ((fine + 0.5) * count) / surfaceSize - 0.5;
        const left = Math.floor(p);
        const fraction = p - left;
        const coordinate = (i: number) => Math.max(0, Math.min(count - 1, i));
        weights[coordinate(left)] += 1 - fraction;
        weights[coordinate(left + 1)] += fraction;
      }
      return weights;
    };
    const weightTable = (): Float32Array => {
      const weightsX = axisWeights(nx);
      const weightsY = axisWeights(ny);
      const weights = new Float32Array(nx * ny);
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          weights[y * nx + x] = (surfaceSize * surfaceSize) / (nx * ny * weightsX[x] * weightsY[y]);
        }
      }
      return weights;
    };
    this.device.queue.writeBuffer(this.depositionWeights, 0, weightTable().slice().buffer);
    this.uniforms = device.createBuffer({
      label: 'Bottle weather parameters',
      size: this.uniformValues.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }
  public get volumeBuffer(): GPUBuffer {
    return this.volumes[0];
  }
  public async init(): Promise<void> {
    const module = this.device.createShaderModule({
      label: 'Two-layer bottle weather',
      code: surfaceThermalWGSL + '\n' + cloudPhysicsWGSL + '\n' + atmosphereWGSL + '\n' + circulationWGSL,
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
    await this.pressure.init();
  }
  /** Once per submitted encoder; zero dt still applies explicit pending resets. */
  public step(encoder: GPUCommandEncoder, terrain: GPUBuffer, fluids: GPUBuffer, dt: number): void {
    if (!this.pipelines) return;
    const timestep =
      config.atmosphereEnabled && Number.isFinite(dt) ? Math.min(WEATHER_TIMESTEP, Math.max(0, dt)) : 0;
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
      0,
      Math.cos(elevation) * Math.cos(azimuth),
      Math.cos(elevation) * Math.sin(azimuth),
      Math.sin(elevation),
      config.radiativeCooling,
      Math.max(0, Math.min(3, config.airBuoyancy)),
      Math.max(0, Math.min(0.2, config.airDrag)),
      config.evaporationRate,
      Math.max(0, Math.min(2, config.surfaceAirHeatExchange)),
      config.airStability,
      config.orographicLift,
      config.airMixing,
      config.convectionStrength,
      mapKm,
      Math.max(0.5, config.weatherCellSizeKm),
      config.weatherVariability,
      config.weatherSeed,
      Math.max(10, config.rainLifetime),
      Math.max(0, Math.min(4, config.condensationRate)),
      Math.max(0, Math.min(1, config.rainEvaporationRate)),
      config.cloudShadows,
    ]);
    this.uniformValues.set(this.windBrush, 40);
    this.uniformValues.set([Math.max(0, Math.min(0.1, config.airViscosity)), WEATHER_TIMESTEP, 0, 0.4], 48);
    this.device.queue.writeBuffer(this.uniforms, 0, this.uniformValues);
    const groups = this.bindings(terrain, fluids);
    const pressureCycles = Math.max(1, Math.min(6, Math.round(config.pressureCycles)));
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
    if (!this.mappingReady) {
      dispatch('prepareSurfaceMapping', 0, Math.ceil(this.surfaceSize / 64));
      this.mappingReady = true;
    }
    if (this.needsSurfaceClear) {
      finePass('initializeSurface');
      this.needsSurfaceClear = false;
    }
    columnPass('reduceColumns');
    if (this.needsReset) {
      airPass('initializeVolume');
      airPass('initializeVolume', 1);
      // Initial wind is a finite lower-air impulse. Its return path is solved
      // with the same closed pressure operator as subsequent brush strokes.
      encoder.clearBuffer(this.faceHeat);
      encoder.copyBufferToBuffer(this.circulationFaces, 0, this.momentumScratch, 0, this.circulationFaces.size);
      this.pressure.encode(encoder, this.momentumScratch, this.nextCirculationFaces, pressureCycles);
      airPass('measureFlow');
      dispatch('reduceFlow', 0, 1);
      airPass('finalizeMomentum');
      airPass('syncAirVelocity');
      airPass('syncAirVelocity', 1);
      this.needsReset = false;
    }
    if (!timestep) return;
    columnPass('prepareHeat');
    finePass('exchangeHeat');
    dispatch('gatherHeat', 0, nx, ny);
    columnPass('radiateColumns');
    airPass('applyAirHeat');
    airPass('advectMomentum');
    airPass('finishMomentum');
    airPass('forceMomentum', 1);
    this.pressure.encode(encoder, this.momentumScratch, this.nextCirculationFaces, pressureCycles);
    airPass('measureFlow');
    dispatch('reduceFlow', 0, 1);
    airPass('finalizeMomentum');
    // B holds the heated initial state. A is the RK predictor, then B receives
    // the final average. Keep A as the stable public buffer for render/coupling.
    airPass('transportPredict', 1);
    airPass('transportFinish');
    encoder.copyBufferToBuffer(this.volumes[1], 0, this.volumes[0], 0, this.volumes[0].size);
    columnPass('microphysics');
    finePass('surfaceExchange');
    dispatch('reduceEnergy', 0, 1);
    this.simulationTime += timestep;
  }
  public reset(clearSurface = true): void {
    this.needsReset = true;
    this.needsSurfaceClear ||= clearSurface;
    this.simulationTime = 0;
    this.device.queue.writeBuffer(this.energyFlux, 0, new Float32Array(4));
  }
  public clearSurface(): void {
    this.needsSurfaceClear = true;
    this.device.queue.writeBuffer(this.energyFlux, 0, new Float32Array(4));
  }
  public destroy(): void {
    for (const b of [
      ...this.volumes,
      this.surfaceBuffer,
      this.columns,
      this.weatherMap,
      this.precipitation,
      this.circulationFaces,
      this.nextCirculationFaces,
      this.momentumScratch,
      this.faceHeat,
      this.flowPartials,
      this.flowControl,
      this.surfaceHeat,
      this.heatProfiles,
      this.heatTransfers,
      this.longwaveHeating,
      this.radiationState,
      this.depositionWeights,
      this.uniforms,
      this.energyFlux,
    ])
      b.destroy();
    this.pipelines = null;
    this.pressure.destroy();
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
      [18, this.radiationState],
      [19, this.heatProfiles],
      [20, this.heatTransfers],
      [21, this.weatherMap],
      [22, this.longwaveHeating],
      [26, this.circulationFaces],
      [27, this.nextCirculationFaces],
      [28, this.momentumScratch],
      [29, this.faceHeat],
      [30, this.flowPartials],
      [31, this.flowControl],
      [25, this.energyFlux],
    ]);
    const layouts: Record<PassName, number[]> = {
      initializeSurface: [4, 6, 20],
      reduceColumns: [3, 4, 5, 6, 20],
      initializeVolume: [2, 3, 21, 26],
      syncAirVelocity: [2, 27],
      prepareSurfaceMapping: [18],
      prepareHeat: [1, 3, 11, 19],
      exchangeHeat: [4, 5, 6, 18, 19, 20],
      gatherHeat: [6, 11, 16, 18, 20],
      radiateColumns: [1, 11, 18, 22],
      applyAirHeat: [1, 2, 3, 16, 22],
      advectMomentum: [26, 28, 29],
      finishMomentum: [26, 27, 28, 29],
      forceMomentum: [1, 3, 27, 28, 29],
      measureFlow: [27, 28, 30],
      reduceFlow: [30, 31],
      finalizeMomentum: [26, 27, 28, 29, 31],
      transportPredict: [1, 2, 3, 27],
      transportFinish: [1, 2, 3, 27, 29],
      microphysics: [2, 3, 10, 21, 27],
      surfaceExchange: [1, 4, 5, 6, 10, 11, 18, 20],
      reduceEnergy: [18, 25],
    };
    const result = Object.fromEntries(
      PASSES.map((name) => [
        name,
        [0, 1].map((i) => {
          const selected = new Map(buffers);
          selected.set(1, this.volumes[i]);
          selected.set(
            2,
            this.volumes[name === 'initializeVolume' || name === 'microphysics' || name === 'syncAirVelocity' ? i : 1 - i]
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
