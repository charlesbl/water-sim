import * as THREE from 'three';
import { simVS, simTerrainFS, simFluxFS, simFluidsFS } from './shaders';
import { config } from './config';

export class GPGPUSimulation {
  private renderer: THREE.WebGLRenderer;
  private size: number;

  // Render targets (ping-pong pairs)
  public targetA_read: THREE.WebGLRenderTarget;
  public targetA_write: THREE.WebGLRenderTarget;
  public targetB_read: THREE.WebGLRenderTarget;
  public targetB_write: THREE.WebGLRenderTarget;
  public targetFlux_read: THREE.WebGLRenderTarget;
  public targetFlux_write: THREE.WebGLRenderTarget;
  public targetLavaFlux_read: THREE.WebGLRenderTarget;
  public targetLavaFlux_write: THREE.WebGLRenderTarget;

  // GPGPU rendering helper scene
  private orthoScene: THREE.Scene;
  private orthoCamera: THREE.OrthographicCamera;
  private orthoMesh: THREE.Mesh;

  // Shader materials
  private simTerrainMaterial: THREE.ShaderMaterial;
  private simFluxMaterial: THREE.ShaderMaterial;
  private simLavaFluxMaterial: THREE.ShaderMaterial;
  private simFluidsMaterial: THREE.ShaderMaterial;

  // State
  private initialized = false;
  private seed: number;

  constructor(renderer: THREE.WebGLRenderer, size = 256) {
    this.renderer = renderer;
    this.size = size;
    this.seed = Math.random() * 1000.0;

    // Configure WebGL2 Float target options
    const options: THREE.RenderTargetOptions = {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.FloatType, // High precision required for physics calculations
      depthBuffer: false,
      stencilBuffer: false,
    };

    // Create target pairs for ping-ponging
    this.targetA_read = new THREE.WebGLRenderTarget(this.size, this.size, options);
    this.targetA_write = new THREE.WebGLRenderTarget(this.size, this.size, options);
    this.targetB_read = new THREE.WebGLRenderTarget(this.size, this.size, options);
    this.targetB_write = new THREE.WebGLRenderTarget(this.size, this.size, options);
    this.targetFlux_read = new THREE.WebGLRenderTarget(this.size, this.size, options);
    this.targetFlux_write = new THREE.WebGLRenderTarget(this.size, this.size, options);
    this.targetLavaFlux_read = new THREE.WebGLRenderTarget(this.size, this.size, options);
    this.targetLavaFlux_write = new THREE.WebGLRenderTarget(this.size, this.size, options);

    // Setup ortho camera and screen-space plane for simulation steps
    this.orthoScene = new THREE.Scene();
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.orthoMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), undefined);
    this.orthoScene.add(this.orthoMesh);

    // Material A: Terrain (Rock & Sand)
    this.simTerrainMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: simVS,
      fragmentShader: simTerrainFS,
      uniforms: {
        u_texA: { value: null },
        u_texB: { value: null },
        u_texFlux: { value: null },
        u_brush_active: { value: 0.0 },
        u_brush_uv: { value: new THREE.Vector2(0, 0) },
        u_brush_radius: { value: 0.05 },
        u_brush_type: { value: 0.0 },
        u_brush_strength: { value: 1.0 },
        u_grid_size: { value: this.size },
        u_sand_slide_rate: { value: config.sandSlideRate },
        u_sand_repose_slope: { value: config.sandReposeSlope },
        u_erosion_rate: { value: config.erosionRate },
        u_capacity_factor: { value: config.capacityFactor },
        u_deposition_rate: { value: config.depositionRate },
        u_min_erosion_speed: { value: config.minErosionSpeed },
        u_initialized: { value: 0.0 },
        u_seed: { value: this.seed },
        u_terrain_scale: { value: config.terrainScale },
        u_terrain_sharpness: { value: config.terrainSharpness },
        u_terrain_tilt: { value: config.terrainTilt },
        u_fbm_octaves: { value: config.fbmOctaves },
        u_fbm_persistence: { value: config.fbmPersistence },
        u_border_behavior: { value: config.borderBehavior },
      },
      depthWrite: false,
      depthTest: false,
    });

    // Material B1: Water Flux
    this.simFluxMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: simVS,
      fragmentShader: simFluxFS,
      uniforms: {
        u_texA: { value: null },
        u_texB: { value: null },
        u_texFlux: { value: null },
        u_grid_size: { value: this.size },
        u_gravity: { value: config.waterGravity },
        u_damping: { value: config.waterDamping },
        u_initialized: { value: 0.0 },
        u_is_lava: { value: 0.0 },
      },
      depthWrite: false,
      depthTest: false,
    });

    // Material B1.5: Lava Flux
    this.simLavaFluxMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: simVS,
      fragmentShader: simFluxFS,
      uniforms: {
        u_texA: { value: null },
        u_texB: { value: null },
        u_texFlux: { value: null },
        u_grid_size: { value: this.size },
        u_gravity: { value: config.lavaGravity },
        u_damping: { value: config.lavaDamping },
        u_initialized: { value: 0.0 },
        u_is_lava: { value: 1.0 },
      },
      depthWrite: false,
      depthTest: false,
    });

    // Material B2: Fluids (Water & Lava)
    this.simFluidsMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: simVS,
      fragmentShader: simFluidsFS,
      uniforms: {
        u_texA: { value: null },
        u_texB: { value: null },
        u_texFlux: { value: null },
        u_texLavaFlux: { value: null },
        u_brush_active: { value: 0.0 },
        u_brush_uv: { value: new THREE.Vector2(0, 0) },
        u_brush_radius: { value: 0.05 },
        u_brush_type: { value: 0.0 },
        u_brush_strength: { value: 1.0 },
        u_grid_size: { value: this.size },
        u_evaporation: { value: config.evaporation },
        u_initialized: { value: 0.0 },
        u_rain_active: { value: 0.0 },
        u_rain_quantity: { value: config.rainQuantity },
        u_rain_size: { value: config.rainSize },
        u_time: { value: 0.0 },
        u_border_behavior: { value: config.borderBehavior },
        u_border_water_height: { value: config.borderWaterHeight },
      },
      depthWrite: false,
      depthTest: false,
    });
  }

  /**
   * Set dynamic uniform values for mouse painting brush
   */
  public setBrush(
    active: boolean,
    uv: THREE.Vector2 | null,
    type: number,
    radius: number,
    strength: number
  ) {
    const activeVal = active && uv !== null ? 1.0 : 0.0;
    const uvVal = uv ? uv : new THREE.Vector2(0, 0);
    const uvRadius = radius / this.size;

    this.simTerrainMaterial.uniforms.u_brush_active.value = activeVal;
    this.simTerrainMaterial.uniforms.u_brush_uv.value = uvVal;
    this.simTerrainMaterial.uniforms.u_brush_radius.value = uvRadius;
    this.simTerrainMaterial.uniforms.u_brush_type.value = type;
    this.simTerrainMaterial.uniforms.u_brush_strength.value = strength;

    this.simFluidsMaterial.uniforms.u_brush_active.value = activeVal;
    this.simFluidsMaterial.uniforms.u_brush_uv.value = uvVal;
    this.simFluidsMaterial.uniforms.u_brush_radius.value = uvRadius;
    this.simFluidsMaterial.uniforms.u_brush_type.value = type;
    this.simFluidsMaterial.uniforms.u_brush_strength.value = strength;
  }

  /**
   * Update internal parameters from global configuration
   */
  public updateParameters() {
    this.simTerrainMaterial.uniforms.u_sand_slide_rate.value = config.sandSlideRate;
    this.simTerrainMaterial.uniforms.u_sand_repose_slope.value = config.sandReposeSlope;
    this.simTerrainMaterial.uniforms.u_erosion_rate.value = config.erosionRate;
    this.simTerrainMaterial.uniforms.u_capacity_factor.value = config.capacityFactor;
    this.simTerrainMaterial.uniforms.u_deposition_rate.value = config.depositionRate;
    this.simTerrainMaterial.uniforms.u_min_erosion_speed.value = config.minErosionSpeed;
    this.simTerrainMaterial.uniforms.u_terrain_scale.value = config.terrainScale;
    this.simTerrainMaterial.uniforms.u_terrain_sharpness.value = config.terrainSharpness;
    this.simTerrainMaterial.uniforms.u_terrain_tilt.value = config.terrainTilt;
    this.simTerrainMaterial.uniforms.u_fbm_octaves.value = Math.round(config.fbmOctaves);
    this.simTerrainMaterial.uniforms.u_fbm_persistence.value = config.fbmPersistence;
    this.simFluxMaterial.uniforms.u_gravity.value = config.waterGravity;
    this.simFluxMaterial.uniforms.u_damping.value = config.waterDamping;
    this.simLavaFluxMaterial.uniforms.u_gravity.value = config.lavaGravity;
    this.simLavaFluxMaterial.uniforms.u_damping.value = config.lavaDamping;
    this.simFluidsMaterial.uniforms.u_evaporation.value = config.evaporation;
    this.simFluidsMaterial.uniforms.u_rain_active.value = config.rainActive ? 1.0 : 0.0;
    this.simFluidsMaterial.uniforms.u_rain_quantity.value = config.rainQuantity;
    this.simFluidsMaterial.uniforms.u_rain_size.value = config.rainSize;
    this.simTerrainMaterial.uniforms.u_border_behavior.value = config.borderBehavior;
    this.simFluidsMaterial.uniforms.u_border_behavior.value = config.borderBehavior;
    this.simFluidsMaterial.uniforms.u_border_water_height.value = config.borderWaterHeight;
  }

  /**
   * Clears the fluids (water and lava) textures to zero
   */
  public clearFluids() {
    const currentRenderTarget = this.renderer.getRenderTarget();

    // Clear read target B
    this.renderer.setRenderTarget(this.targetB_read);
    this.renderer.clearColor();
    this.renderer.clear();

    // Clear write target B
    this.renderer.setRenderTarget(this.targetB_write);
    this.renderer.clearColor();
    this.renderer.clear();

    // Clear read target Flux
    this.renderer.setRenderTarget(this.targetFlux_read);
    this.renderer.clearColor();
    this.renderer.clear();

    // Clear write target Flux
    this.renderer.setRenderTarget(this.targetFlux_write);
    this.renderer.clearColor();
    this.renderer.clear();

    // Clear read target Lava Flux
    this.renderer.setRenderTarget(this.targetLavaFlux_read);
    this.renderer.clearColor();
    this.renderer.clear();

    // Clear write target Lava Flux
    this.renderer.setRenderTarget(this.targetLavaFlux_write);
    this.renderer.clearColor();
    this.renderer.clear();

    this.renderer.setRenderTarget(currentRenderTarget);
  }

  /**
   * Resets simulation status and noise seed to regenerate the terrain
   */
  public resetTerrain(newSeed = true) {
    this.initialized = false;
    if (newSeed) {
      this.seed = Math.random() * 1000.0;
    }
    this.simTerrainMaterial.uniforms.u_initialized.value = 0.0;
    this.simTerrainMaterial.uniforms.u_seed.value = this.seed;
    this.simFluidsMaterial.uniforms.u_initialized.value = 0.0;
    this.clearFluids();
  }

  /**
   * Execute GPGPU pass A and B, swap buffers (ping-ponging)
   */
  public step() {
    const currentRenderTarget = this.renderer.getRenderTarget();

    // Sync parameters from UI config
    this.updateParameters();

    const initVal = this.initialized ? 1.0 : 0.0;
    this.simTerrainMaterial.uniforms.u_initialized.value = initVal;
    this.simFluidsMaterial.uniforms.u_initialized.value = initVal;
    this.simFluidsMaterial.uniforms.u_time.value = performance.now() * 0.001;

    // --- PASS B1: Simulate Water Flux ---
    this.simFluxMaterial.uniforms.u_texA.value = this.targetA_read.texture;
    this.simFluxMaterial.uniforms.u_texB.value = this.targetB_read.texture;
    this.simFluxMaterial.uniforms.u_texFlux.value = this.targetFlux_read.texture;
    this.simFluxMaterial.uniforms.u_initialized.value = initVal;

    this.orthoMesh.material = this.simFluxMaterial;
    this.renderer.setRenderTarget(this.targetFlux_write);
    this.renderer.render(this.orthoScene, this.orthoCamera);

    // --- PASS B1.5: Simulate Lava Flux ---
    this.simLavaFluxMaterial.uniforms.u_texA.value = this.targetA_read.texture;
    this.simLavaFluxMaterial.uniforms.u_texB.value = this.targetB_read.texture;
    this.simLavaFluxMaterial.uniforms.u_texFlux.value = this.targetLavaFlux_read.texture;
    this.simLavaFluxMaterial.uniforms.u_initialized.value = initVal;

    this.orthoMesh.material = this.simLavaFluxMaterial;
    this.renderer.setRenderTarget(this.targetLavaFlux_write);
    this.renderer.render(this.orthoScene, this.orthoCamera);

    // --- PASS A: Simulate Terrain & Sand sliding ---
    // Read A_read and B_read, write to A_write
    this.simTerrainMaterial.uniforms.u_texA.value = this.targetA_read.texture;
    this.simTerrainMaterial.uniforms.u_texB.value = this.targetB_read.texture;
    this.simTerrainMaterial.uniforms.u_texFlux.value = this.targetFlux_write.texture;

    this.orthoMesh.material = this.simTerrainMaterial;
    this.renderer.setRenderTarget(this.targetA_write);
    this.renderer.render(this.orthoScene, this.orthoCamera);

    // --- PASS B2: Simulate Fluid flow and evaporation ---
    // Read A_write (new terrain state), B_read, Flux_write, write to B_write
    this.simFluidsMaterial.uniforms.u_texA.value = this.targetA_write.texture;
    this.simFluidsMaterial.uniforms.u_texB.value = this.targetB_read.texture;
    this.simFluidsMaterial.uniforms.u_texFlux.value = this.targetFlux_write.texture;
    this.simFluidsMaterial.uniforms.u_texLavaFlux.value = this.targetLavaFlux_write.texture;

    this.orthoMesh.material = this.simFluidsMaterial;
    this.renderer.setRenderTarget(this.targetB_write);
    this.renderer.render(this.orthoScene, this.orthoCamera);

    // --- PING-PONG SWAPPING ---
    // Swap Terrain buffers (A)
    const tempA = this.targetA_read;
    this.targetA_read = this.targetA_write;
    this.targetA_write = tempA;

    // Swap Flux buffers
    const tempFlux = this.targetFlux_read;
    this.targetFlux_read = this.targetFlux_write;
    this.targetFlux_write = tempFlux;

    const tempLavaFlux = this.targetLavaFlux_read;
    this.targetLavaFlux_read = this.targetLavaFlux_write;
    this.targetLavaFlux_write = tempLavaFlux;

    // Swap Fluids buffers (B)
    const tempB = this.targetB_read;
    this.targetB_read = this.targetB_write;
    this.targetB_write = tempB;

    // Restore renderer's active render target
    this.renderer.setRenderTarget(currentRenderTarget);

    if (!this.initialized) {
      this.initialized = true;
    }
  }
}
