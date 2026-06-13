export interface Config {
  // Grid size of the simulation
  gridSize: number;

  // Simulation speed and physical properties
  waterGravity: number; // Gravity acceleration for waves
  waterDamping: number; // Friction / damping (1.0 = no friction)
  lavaViscosity: number; // Rate at which lava spreads (low values mean high viscosity)
  sandSlideRate: number; // Rate at which sand collapses beyond angle of repose
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
}

export const config: Config = {
  gridSize: 1024,
  waterGravity: 9.81,
  waterDamping: 0.99,
  lavaViscosity: 0.005,
  sandSlideRate: 0.05,
  evaporation: 0.0,
  paused: false,

  brushType: 0,
  brushRadius: 15,
  brushStrength: 1.0,

  viewMode: 'realistic',
  timeOfDay: 12.0,
  autoRotate: false,
  heightScale: 18.0,
};
