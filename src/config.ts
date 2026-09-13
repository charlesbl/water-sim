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
  brushType: number; // 0: Water, 1: Lava, 2: Sand, 3: Raise, 4: Dig, 5: Erase, 6: Ice, 7: Heat, 8: Cool, 9: Soil, 10: Clouds, 11: Nuke, 12–17: material erasers, 18: cold impulse
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

  // Painted weather and surface thermal balance.
  weatherEnabled: boolean;
  albedoStrength: number; // 0: equal solar absorption, 1: normal, 2: doubled albedo
  borderMode: number; // 0: walls, 1: passthrough (outflow only)
  solarHeating: number;
  sunElevation: number;
  sunAzimuth: number;
  coolingLow: number;
  coolingMiddle: number;
  coolingHigh: number;
  coolingMiddleAltitude: number;
  rainRate: number;
  evaporationRate: number;
  cloudOpacity: number;
  cloudAltitude: number;
  cloudThickness: number;
  cloudDetail: number;
  cloudShadows: number;
  rainVisibility: number;
  weatherView: number; // 0: world, 1: cloud intensity, 2: precipitation
  thermalOverlay: boolean;
  viewOpacity: number;
}

export const config: Config = {
  thermalOverlay: false,
  viewOpacity: 0.72,
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

  weatherEnabled: true,
  albedoStrength: 1,
  borderMode: 0,
  solarHeating: 1,
  sunElevation: 40,
  sunAzimuth: 135,
  coolingLow: 0.7,
  coolingMiddle: 1,
  coolingHigh: 1.5,
  coolingMiddleAltitude: 16,
  rainRate: 0.002,
  evaporationRate: 0.05,
  cloudOpacity: 1,
  cloudAltitude: 40,
  cloudThickness: 10,
  cloudDetail: 0.6,
  cloudShadows: 0.65,
  rainVisibility: 1,
  weatherView: 0,
};
