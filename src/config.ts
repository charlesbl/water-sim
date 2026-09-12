export interface Config {
  // Grid size of the simulation
  gridSize: number;

  // Simulation speed and physical properties
  waterGravity: number; // Gravity acceleration for waves
  waterDamping: number; // Friction / damping (1.0 = no friction)
  lavaGravity: number; // Gravity acceleration for lava
  lavaDamping: number; // Friction / damping for lava
  sedimentSlideRate: number; // Shared sand/soil collapse rate beyond their angles of repose
  sandStaticReposeSlope: number; // Height difference per cell that starts an avalanche; UI displays degrees
  sandDynamicReposeSlope: number; // Height difference per cell where an avalanche stops; UI displays degrees
  soilStaticReposeSlope: number; // Height difference per cell that starts soil collapse; UI displays degrees
  soilDynamicReposeSlope: number; // Height difference per cell where soil collapse stops; UI displays degrees
  erosionRate: number; // Shared sand/soil water erosion rate
  capacityFactor: number; // Multiplier for sediment carrying capacity
  depositionRate: number; // Rate at which suspended sand and soil deposit
  paused: boolean; // Is the simulation paused?
  simSpeed: number; // Time multiplier for the fixed simulation clocks

  // Brush settings
  brushType: number; // 0: Water, 1: Lava, 2: Sand, 3: Raise, 4: Dig, 5: Erase, 6: Ice, 7: Heat, 8: Cool, 9: Soil, 10: Wind
  brushRadius: number; // Radius of the brush in grid units
  brushStrength: number; // Strength/rate of drawing

  // Visual settings
  showRock: boolean;
  showSand: boolean;
  showSoil: boolean;
  showWater: boolean;
  showLava: boolean;
  showSuspendedSand: boolean;
  smoothRendering: boolean;
  renderResolution: number; // Multiplier for rendering mesh resolution
  heightScale: number; // Scaling of Z-height displacement for mesh
  minWaterDepth: number; // Minimum water depth/volume to transport sediments

  // Terrain generation settings
  terrainType: number; // 0: realistic (noise), 1: flat
  terrainSandHeight: number; // Initial sand thickness/height on the map
  terrainSoilHeight: number; // Initial soil thickness between rock and sand
  flatRockHeight: number; // Initial rock thickness/height in flat mode
  terrainScale: number; // Frequency/zoom of terrain noise
  terrainSharpness: number; // Exponent for peak sharpness
  fbmOctaves: number; // Number of noise detail layers
  fbmPersistence: number; // Persistence of details in FBM
  terrainTilt: number; // Incline the map (one side higher than the other)

  // Two terrain-following air layers, independent of the surface grid.
  atmosphereEnabled: boolean;
  evaporationRate: number; // Surface evaporation coefficient, 0..1
  airTemperature: number; // Initial air temperature, degrees Celsius
  relativeHumidity: number; // Initial humidity: 1 = 100%, may be supersaturated
  airStability: number; // Initial lower-air stability: 0 neutral, 1 stable
  convectionStrength: number; // Live inter-layer exchange response to instability
  windSpeed: number; // Initial km per game minute across the nominal map
  windDirection: number; // Initial direction of travel in the horizontal plane, degrees
  solarHeating: number; // Relative solar heating strength
  airBuoyancy: number; // Potential-temperature buoyancy multiplier for the coupled MAC flow
  airDrag: number; // Lower-air damping per second; upper air has one tenth this drag
  airViscosity: number; // Momentum diffusion in simulation distance² per weather second
  pressureCycles: number; // Coupled pressure multigrid V-cycles, 1..6
  surfaceAirHeatExchange: number; // Paired surface-air conductance; water retains its larger capacity
  sunElevation: number; // Sun angle above horizon, degrees
  sunAzimuth: number; // Sun direction in terrain coordinates, degrees
  radiativeCooling: number; // Longwave heat loss multiplier
  atmosphereTimeScale: number; // Weather time multiplier
  cloudOpacity: number;
  showWind: boolean;
  atmosphereView: number; // 0: no overlay, 1: temperature, 2: humidity, 3: wind, 4: radar, 5: recent wetness, 6: vertical circulation
  atmosphereSlice: number; // 0: lower air, 1: cloud layer
  thermalOverlay: boolean;
  thermalAir: boolean;
  thermalOpacity: number;
  viewOpacity: number;
  thermalHeight: number;
  weatherMapSizeKm: number; // Nominal geography; surface fluid tuning is unchanged
  weatherCellSizeKm: number; // Initial air-mass scale
  weatherVariability: number; // Initial temperature/humidity contrasts only
  weatherSeed: number;
  rainLifetime: number; // Cloud-to-rain conversion time in weather seconds
  condensationRate: number; // Cloud/vapor relaxation per weather second; latent heat stays fixed
  rainEvaporationRate: number; // Rain evaporation in unsaturated air, per weather second
  orographicLift: number;
  airMixing: number; // Background exchange between the two layers, per second
  cloudAltitude: number; // Visual base above sea level, in nominal km
  cloudThickness: number; // Visual depth, in nominal km
  cloudDetail: number;
  cloudShadows: number;
  rainVisibility: number;
}

export const config: Config = {
  thermalOverlay: false,
  thermalAir: false,
  thermalOpacity: 0.72,
  viewOpacity: 0.72,
  thermalHeight: 6.25,
  gridSize: 2048,
  waterGravity: 9.81,
  waterDamping: 0.998,
  lavaGravity: 6.01,
  lavaDamping: 0.95,
  sedimentSlideRate: 0.1,
  sandStaticReposeSlope: 0.005,
  sandDynamicReposeSlope: 0.002,
  // 70° static / 55° dynamic at the default grid size and height scale.
  soilStaticReposeSlope: (Math.tan((70 * Math.PI) / 180) * 200) / (2048 * 18),
  soilDynamicReposeSlope: (Math.tan((55 * Math.PI) / 180) * 200) / (2048 * 18),
  erosionRate: 0.005,
  capacityFactor: 0.1,
  depositionRate: 0.05,
  paused: false,
  simSpeed: 1.0,

  brushType: 0,
  brushRadius: 15,
  brushStrength: 1.0,

  showRock: true,
  showSand: true,
  showSoil: true,
  showWater: true,
  showLava: true,
  showSuspendedSand: true,
  smoothRendering: true,
  renderResolution: 1.0,
  heightScale: 18.0,
  minWaterDepth: 0.0,

  terrainType: 0,
  terrainSandHeight: 0.05,
  terrainSoilHeight: 0.15,
  flatRockHeight: 0.05,
  terrainScale: 4.0,
  terrainSharpness: 1.4,
  fbmOctaves: 4,
  fbmPersistence: 0.44,
  terrainTilt: 0.0,

  atmosphereEnabled: true,
  evaporationRate: 0.25,
  airTemperature: 12,
  relativeHumidity: 0.85,
  airStability: 0.25,
  convectionStrength: 1,
  windSpeed: 0,
  windDirection: 45,
  solarHeating: 1,
  airBuoyancy: 1,
  airDrag: 0.006,
  airViscosity: 0.005,
  pressureCycles: 3,
  surfaceAirHeatExchange: 0.45,
  sunElevation: 40,
  sunAzimuth: 135,
  radiativeCooling: 1,
  atmosphereTimeScale: 1,
  cloudOpacity: 1,
  showWind: false,
  atmosphereView: 0,
  atmosphereSlice: 1,
  weatherMapSizeKm: 10,
  weatherCellSizeKm: 2,
  weatherVariability: 0.8,
  weatherSeed: 7,
  rainLifetime: 60,
  condensationRate: 2,
  rainEvaporationRate: 0.4,
  orographicLift: 1.5,
  airMixing: 0.008,
  cloudAltitude: 0.9,
  cloudThickness: 0.5,
  cloudDetail: 0.6,
  cloudShadows: 0.65,
  rainVisibility: 1,
};
