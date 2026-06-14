export interface Config {
  // Grid size of the simulation
  gridSize: number;

  // Simulation speed and physical properties
  waterGravity: number; // Gravity acceleration for waves
  waterDamping: number; // Friction / damping (1.0 = no friction)
  lavaGravity: number; // Gravity acceleration for lava
  lavaDamping: number; // Friction / damping for lava
  sandSlideRate: number; // Rate at which sand collapses beyond angle of repose
  sandReposeSlope: number; // Slope threshold below which sand does not flow at all
  erosionRate: number; // Rate at which water flow erodes sand
  capacityFactor: number; // Multiplier for sediment carrying capacity
  depositionRate: number; // Rate at which suspended sand deposits
  minErosionSpeed: number; // Minimum water speed to pick up sand
  evaporation: number; // Water evaporation rate per step
  paused: boolean; // Is the simulation paused?

  // Brush settings
  brushType: number; // 0: Water, 1: Lava, 2: Sand, 3: Raise Rock, 4: Dig Rock, 5: Erase
  brushRadius: number; // Radius of the brush in grid units
  brushStrength: number; // Strength/rate of drawing

  // Visual settings
  viewMode: 'realistic' | 'heightmap' | 'water-only' | 'lava-only' | 'sand-only';
  autoRotate: boolean; // Auto-rotation of OrbitControls
  heightScale: number; // Scaling of Z-height displacement for mesh

  // Terrain generation settings
  terrainScale: number; // Frequency/zoom of terrain noise
  terrainSharpness: number; // Exponent for peak sharpness
  fbmOctaves: number; // Number of noise detail layers
  fbmPersistence: number; // Persistence of details in FBM
  terrainTilt: number; // Incline the map (one side higher than the other)

  // Rain settings
  rainActive: boolean;
  rainQuantity: number;
  rainSize: number;
}

export const config: Config = {
  gridSize: 2048,
  waterGravity: 9.81,
  waterDamping: 0.998,
  lavaGravity: 6.0,
  lavaDamping: 0.95,
  sandSlideRate: 0.05,
  sandReposeSlope: 0.0015,
  erosionRate: 0.005,
  capacityFactor: 0.4,
  depositionRate: 0.05,
  minErosionSpeed: 0.001,
  evaporation: 0.0,
  paused: false,

  brushType: 0,
  brushRadius: 15,
  brushStrength: 1.0,

  viewMode: 'realistic',
  autoRotate: false,
  heightScale: 18.0,

  terrainScale: 4.0,
  terrainSharpness: 1.4,
  fbmOctaves: 4,
  fbmPersistence: 0.44,
  terrainTilt: 0.0,

  rainActive: false,
  rainQuantity: 0.0005,
  rainSize: 0.005,
};
