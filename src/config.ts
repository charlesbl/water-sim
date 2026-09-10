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
  evaporation: number; // Water evaporation rate per step
  paused: boolean; // Is the simulation paused?
  simSpeed: number; // Time multiplier for the fixed simulation clocks

  // Brush settings
  brushType: number; // 0: Water, 1: Lava, 2: Sand, 3: Raise, 4: Dig, 5: Erase, 6: Ice, 7: Heat, 8: Cool, 9: Soil
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

  // Rain settings
  rainActive: boolean;
  rainQuantity: number;
  rainSize: number;

  // Volumetric atmosphere (independent 96 x 96 x 64 GPU grid)
  atmosphereEnabled: boolean;
  closedWaterCycle: boolean; // Keep all water reservoirs internal; suspend manual sources and open surface edges
  atmosphereBoundary: number; // 0: periodic horizontal boundaries, 1: closed walls
  evaporationRate: number; // Solar-driven evaporation coefficient, 0..1
  emergentWeather: boolean; // Initial air evolves freely; no temperature/humidity/wind thermostat
  airTemperature: number; // Reference air temperature, degrees Celsius
  relativeHumidity: number; // Reference humidity: 1 = 100%, may be supersaturated
  airStability: number; // Initial lower-air stability: 0 neutral, 1 stable
  convectionStrength: number; // Live buoyancy response at the illustrative scene scale
  windSpeed: number; // Horizontal wind forcing, simulation units per second
  windDirection: number; // Direction of travel in the horizontal plane, degrees
  solarHeating: number; // Relative solar heating strength
  heatingContrast: number; // Redistribute solar heating toward responsive surfaces, 1..10, same total energy
  sunElevation: number; // Sun angle above horizon, degrees
  sunAzimuth: number; // Sun direction in terrain coordinates, degrees
  radiativeCooling: number; // Longwave heat loss multiplier
  atmosphereTimeScale: number; // Weather time multiplier
  cloudOpacity: number;
  showWind: boolean;
  atmosphereView: number; // 0: volume, 1: temperature, 2: humidity, 3: wind
  atmosphereSlice: number; // Normalized altitude of the diagnostic slice
  thermalOverlay: boolean;
  thermalAir: boolean;
  thermalOpacity: number;
  thermalHeight: number;

  // Map border settings
  borderBehavior: number; // 0: block all, 1: pass all, 2: pass water but keep sediments
  borderWaterHeight: number; // Height of water maintained at the border (relative to ground height)
}

export const config: Config = {
  thermalOverlay: false,
  thermalAir: false,
  thermalOpacity: 0,
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
  evaporation: 0.0,
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

  rainActive: false,
  rainQuantity: 0.0005,
  rainSize: 0.005,

  atmosphereEnabled: true,
  closedWaterCycle: true,
  atmosphereBoundary: 0,
  evaporationRate: 0.25,
  emergentWeather: true,
  airTemperature: 8,
  relativeHumidity: 0.75,
  airStability: 0.125,
  convectionStrength: 4,
  windSpeed: 0,
  windDirection: 45,
  solarHeating: 1,
  heatingContrast: 3,
  sunElevation: 40,
  sunAzimuth: 135,
  radiativeCooling: 1,
  atmosphereTimeScale: 1,
  cloudOpacity: 1,
  showWind: false,
  atmosphereView: 0,
  atmosphereSlice: 0.5,

  borderBehavior: 1,
  borderWaterHeight: 0.0,
};
