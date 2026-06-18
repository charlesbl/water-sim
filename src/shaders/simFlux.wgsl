struct TerrainCell {
    rock: f32,
    sand: f32,
    suspended_sand: f32,
    avalanche: f32,
};

struct FluidCell {
    water: f32,
    lava: f32,
    temp: f32,
    steam: f32,
};

struct FluxCell {
    left: f32,
    right: f32,
    bottom: f32,
    top: f32,
};

struct SimUniforms {
    grid_size: f32,
    water_gravity: f32,
    water_damping: f32,
    lava_gravity: f32,
    lava_damping: f32,
    sand_slide_rate: f32,
    sand_static_repose_slope: f32,
    sand_dynamic_repose_slope: f32,
    erosion_rate: f32,
    capacity_factor: f32,
    deposition_rate: f32,
    evaporation: f32,
    initialized: f32,
    paused: f32,
    brush_active: f32,
    brush_type: f32,
    brush_strength: f32,
    brush_radius: f32,
    brush_x: f32,
    brush_y: f32,
    time: f32,
    rain_active: f32,
    rain_quantity: f32,
    rain_size: f32,
    border_behavior: f32,
    border_water_height: f32,
    seed: f32,
    terrain_type: f32,
    terrain_sand_height: f32,
    flat_rock_height: f32,
    terrain_scale: f32,
    terrain_sharpness: f32,
    terrain_tilt: f32,
    fbm_octaves: f32,
    fbm_persistence: f32,
    min_water_depth: f32,
};

@group(0) @binding(0) var<uniform> uniforms : SimUniforms;
@group(0) @binding(1) var<storage, read> terrain_in : array<TerrainCell>;
@group(0) @binding(2) var<storage, read> fluids_in : array<FluidCell>;
@group(0) @binding(3) var<storage, read> water_flux_in : array<FluxCell>;
@group(0) @binding(4) var<storage, read_write> water_flux_out : array<FluxCell>;
@group(0) @binding(5) var<storage, read> lava_flux_in : array<FluxCell>;
@group(0) @binding(6) var<storage, read_write> lava_flux_out : array<FluxCell>;

fn get_cell_solid_fluid(x: u32, y: u32, grid_size: u32, is_lava: bool) -> vec2<f32> {
    let idx = y * grid_size + x;
    let cell_a = terrain_in[idx];
    let cell_b = fluids_in[idx];
    if (is_lava) {
        let solid = cell_a.rock + cell_a.sand;
        let fluid = cell_b.lava;
        return vec2<f32>(solid, fluid);
    } else {
        let solid = cell_a.rock + cell_a.sand + cell_b.lava;
        let fluid = cell_b.water;
        return vec2<f32>(solid, fluid);
    }
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let grid_size = u32(uniforms.grid_size);
    let x = id.x;
    let y = id.y;

    if (x >= grid_size || y >= grid_size) {
        return;
    }

    let idx = y * grid_size + x;

    if (uniforms.initialized < 0.5) {
        water_flux_out[idx] = FluxCell(0.0, 0.0, 0.0, 0.0);
        lava_flux_out[idx] = FluxCell(0.0, 0.0, 0.0, 0.0);
        return;
    }

    if (uniforms.paused > 0.5) {
        water_flux_out[idx] = water_flux_in[idx];
        lava_flux_out[idx] = lava_flux_in[idx];
        return;
    }

    let g_dt_water = uniforms.water_gravity * 0.016;
    let g_dt_lava = uniforms.lava_gravity * 0.016;

    // --- WATER FLUX CALCULATION ---
    let water_data = get_cell_solid_fluid(x, y, grid_size, false);
    let solid_w = water_data.x;
    let fluid_w = water_data.y;
    let h_src_w = solid_w + fluid_w;

    var w_flux = water_flux_in[idx];

    // Left neighbor (-1, 0)
    let left_x = max(0u, x - 1u);
    let left_data_w = get_cell_solid_fluid(left_x, y, grid_size, false);
    let diff_w_l = h_src_w - (left_data_w.x + left_data_w.y);
    w_flux.left = max(0.0, w_flux.left * uniforms.water_damping + diff_w_l * g_dt_water);

    // Right neighbor (+1, 0)
    let right_x = min(grid_size - 1u, x + 1u);
    let right_data_w = get_cell_solid_fluid(right_x, y, grid_size, false);
    let diff_w_r = h_src_w - (right_data_w.x + right_data_w.y);
    w_flux.right = max(0.0, w_flux.right * uniforms.water_damping + diff_w_r * g_dt_water);

    // Bottom neighbor (0, -1)
    let bottom_y = max(0u, y - 1u);
    let bottom_data_w = get_cell_solid_fluid(x, bottom_y, grid_size, false);
    let diff_w_b = h_src_w - (bottom_data_w.x + bottom_data_w.y);
    w_flux.bottom = max(0.0, w_flux.bottom * uniforms.water_damping + diff_w_b * g_dt_water);

    // Top neighbor (0, +1)
    let top_y = min(grid_size - 1u, y + 1u);
    let top_data_w = get_cell_solid_fluid(x, top_y, grid_size, false);
    let diff_w_t = h_src_w - (top_data_w.x + top_data_w.y);
    w_flux.top = max(0.0, w_flux.top * uniforms.water_damping + diff_w_t * g_dt_water);

    // Boundary conditions
    if (x == 0u) { w_flux.left = 0.0; }
    if (x == grid_size - 1u) { w_flux.right = 0.0; }
    if (y == 0u) { w_flux.bottom = 0.0; }
    if (y == grid_size - 1u) { w_flux.top = 0.0; }

    // Prevent draining more than exists
    let w_sum = w_flux.left + w_flux.right + w_flux.bottom + w_flux.top;
    if (w_sum > 0.0) {
        let K_w = min(1.0, fluid_w / w_sum);
        w_flux.left *= K_w;
        w_flux.right *= K_w;
        w_flux.bottom *= K_w;
        w_flux.top *= K_w;
    }
    water_flux_out[idx] = w_flux;


    // --- LAVA FLUX CALCULATION ---
    let lava_data = get_cell_solid_fluid(x, y, grid_size, true);
    let solid_l = lava_data.x;
    let fluid_l = lava_data.y;
    let h_src_l = solid_l + fluid_l;

    var l_flux = lava_flux_in[idx];

    // Left neighbor
    let left_data_l = get_cell_solid_fluid(left_x, y, grid_size, true);
    let diff_l_l = h_src_l - (left_data_l.x + left_data_l.y);
    l_flux.left = max(0.0, l_flux.left * uniforms.lava_damping + diff_l_l * g_dt_lava);

    // Right neighbor
    let right_data_l = get_cell_solid_fluid(right_x, y, grid_size, true);
    let diff_l_r = h_src_l - (right_data_l.x + right_data_l.y);
    l_flux.right = max(0.0, l_flux.right * uniforms.lava_damping + diff_l_r * g_dt_lava);

    // Bottom neighbor
    let bottom_data_l = get_cell_solid_fluid(x, bottom_y, grid_size, true);
    let diff_l_b = h_src_l - (bottom_data_l.x + bottom_data_l.y);
    l_flux.bottom = max(0.0, l_flux.bottom * uniforms.lava_damping + diff_l_b * g_dt_lava);

    // Top neighbor
    let top_data_l = get_cell_solid_fluid(x, top_y, grid_size, true);
    let diff_l_t = h_src_l - (top_data_l.x + top_data_l.y);
    l_flux.top = max(0.0, l_flux.top * uniforms.lava_damping + diff_l_t * g_dt_lava);

    // Boundary conditions
    if (x == 0u) { l_flux.left = 0.0; }
    if (x == grid_size - 1u) { l_flux.right = 0.0; }
    if (y == 0u) { l_flux.bottom = 0.0; }
    if (y == grid_size - 1u) { l_flux.top = 0.0; }

    // Prevent draining more than exists
    let l_sum = l_flux.left + l_flux.right + l_flux.bottom + l_flux.top;
    if (l_sum > 0.0) {
        let K_l = min(1.0, fluid_l / l_sum);
        l_flux.left *= K_l;
        l_flux.right *= K_l;
        l_flux.bottom *= K_l;
        l_flux.top *= K_l;
    }
    lava_flux_out[idx] = l_flux;
}
