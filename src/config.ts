export interface Config {
  // Grid size of the simulation
  gridSize: number;

  // Simulation speed and physical properties
  waterGravity: number; // Gravity acceleration for waves
  waterDamping: number; // Friction / damping (1.0 = no friction)
  lavaGravity: number; // Gravity acceleration for lava
  lavaDamping: number; // Friction / damping for lava
  sandSlideRate: number; // Rate at which sand collapses beyond angle of repose
  erosionRate: number; // Rate at which water flow erodes sand
  evaporation: number; // Water evaporation rate per step
  paused: boolean; // Is the simulation paused?

  // Brush settings
  brushType: number; // 0: Water, 1: Lava, 2: Sand, 3: Raise Rock, 4: Dig Rock, 5: Erase
  brushRadius: number; // Radius of the brush in grid units
  brushStrength: number; // Strength/rate of drawing

  // Visual settings
  viewMode: 'realistic' | 'heightmap' | 'water-only' | 'lava-only' | 'sand-only';
  timeOfDay: number; // Sun position hour (0 to 24)
  autoRotate: boolean; // Auto-rotation of OrbitControls
  heightScale: number; // Scaling of Z-height displacement for mesh

  // Terrain generation settings
  terrainScale: number; // Frequency/zoom of terrain noise
  terrainSharpness: number; // Exponent for peak sharpness
  fbmOctaves: number; // Number of noise detail layers
  fbmPersistence: number; // Persistence of details in FBM

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
  erosionRate: 0.01,
  evaporation: 0.0,
  paused: false,

  brushType: 0,
  brushRadius: 15,
  brushStrength: 1.0,

  viewMode: 'realistic',
  timeOfDay: 12.0,
  autoRotate: false,
  heightScale: 18.0,

  terrainScale: 4.0,
  terrainSharpness: 1.4,
  fbmOctaves: 4,
  fbmPersistence: 0.44,

  rainActive: false,
  rainQuantity: 0.0005,
  rainSize: 0.005,
};
