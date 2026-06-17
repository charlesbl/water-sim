export interface Config {
  // Grid size of the simulation
  gridSize: number;

  // Simulation speed and physical properties
  waterGravity: number; // Gravity acceleration for waves
  waterDamping: number; // Friction / damping (1.0 = no friction)
  lavaGravity: number; // Gravity acceleration for lava
  lavaDamping: number; // Friction / damping for lava
  sandSlideRate: number; // Rate at which sand collapses beyond angle of repose
  sandStaticReposeSlope: number; // Slope threshold needed to start an avalanche
  sandDynamicReposeSlope: number; // Slope threshold below which an avalanche stops
  erosionRate: number; // Rate at which water flow erodes sand
  capacityFactor: number; // Multiplier for sediment carrying capacity
  depositionRate: number; // Rate at which suspended sand deposits
  evaporation: number; // Water evaporation rate per step
  paused: boolean; // Is the simulation paused?
  simSpeed: number; // Simulation ticks per frame

  // Brush settings
  brushType: number; // 0: Water, 1: Lava, 2: Sand, 3: Raise Rock, 4: Dig Rock, 5: Erase
  brushRadius: number; // Radius of the brush in grid units
  brushStrength: number; // Strength/rate of drawing

  // Visual settings
  showRock: boolean;
  showSand: boolean;
  showWater: boolean;
  showLava: boolean;
  showSuspendedSand: boolean;
  autoRotate: boolean; // Auto-rotation of OrbitControls
  smoothRendering: boolean;
  renderResolution: number; // Multiplier for rendering mesh resolution
  heightScale: number; // Scaling of Z-height displacement for mesh
  minWaterDepth: number; // Minimum water depth/volume to transport sand

  // Terrain generation settings
  terrainType: number; // 0: realistic (noise), 1: flat
  terrainSandHeight: number; // Initial sand thickness/height on the map
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

  // Map border settings
  borderBehavior: number; // 0: block all, 1: pass all, 2: pass water but not sand
  borderWaterHeight: number; // Height of water maintained at the border (relative to ground height)
}

export const config: Config = {
  gridSize: 2048,
  waterGravity: 9.81,
  waterDamping: 0.998,
  lavaGravity: 6.01,
  lavaDamping: 0.95,
  sandSlideRate: 0.11,
  sandStaticReposeSlope: 0.003,
  sandDynamicReposeSlope: 0.0025,
  erosionRate: 0.005,
  capacityFactor: 0.4,
  depositionRate: 0.05,
  evaporation: 0.0,
  paused: false,
  simSpeed: 1.0,

  brushType: 0,
  brushRadius: 15,
  brushStrength: 1.0,

  showRock: true,
  showSand: true,
  showWater: true,
  showLava: true,
  showSuspendedSand: true,
  autoRotate: false,
  smoothRendering: true,
  renderResolution: 1.0,
  heightScale: 18.0,
  minWaterDepth: 0.0,

  terrainType: 0,
  terrainSandHeight: 0.05,
  flatRockHeight: 0.05,
  terrainScale: 4.0,
  terrainSharpness: 1.4,
  fbmOctaves: 4,
  fbmPersistence: 0.44,
  terrainTilt: 0.0,

  rainActive: false,
  rainQuantity: 0.0005,
  rainSize: 0.005,
  borderBehavior: 1,
  borderWaterHeight: 0.0,
};
