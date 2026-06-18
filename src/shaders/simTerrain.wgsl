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
@group(0) @binding(2) var<storage, read_write> terrain_out : array<TerrainCell>;
@group(0) @binding(3) var<storage, read> fluids_in : array<FluidCell>;
@group(0) @binding(4) var<storage, read> water_flux : array<FluxCell>;

// --- NOISE AND PROCEDURAL GENERATION ---
fn hash(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453123);
}

fn noise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i + vec2<f32>(0.0, 0.0)), hash(i + vec2<f32>(1.0, 0.0)), u.x),
               mix(hash(i + vec2<f32>(0.0, 1.0)), hash(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}

fn fbm(p_in: vec2<f32>, octaves: i32, persistence: f32) -> f32 {
    var p = p_in;
    var v = 0.0;
    var a = 0.5;
    let c = cos(0.5);
    let s = sin(0.5);
    for (var i = 0; i < 8; i = i + 1) {
        if (i >= octaves) {
            break;
        }
        v = v + a * noise(p);
        let next_p = vec2<f32>(
            (p.x * c - p.y * s) * 2.1 + 10.0,
            (p.x * s + p.y * c) * 2.1 + 10.0
        );
        p = next_p;
        a = a * persistence;
    }
    return v;
}

// --- HELPER FOR FULL CELL DATA ---
struct FullCellData {
    rock: f32,
    sand: f32,
    suspended_sand: f32,
    water: f32,
    lava: f32,
    avalanche: f32,
};

fn get_full_cell_data(x: u32, y: u32, grid_size: u32) -> FullCellData {
    let idx = y * grid_size + x;
    let cell_a = terrain_in[idx];
    let cell_b = fluids_in[idx];

    var rock = cell_a.rock;
    var sand = cell_a.sand;
    let suspended_sand = cell_a.suspended_sand;
    let avalanche = cell_a.avalanche;
    var water = cell_b.water;
    let lava = cell_b.lava;

    // React lava + water to form rock
    if (uniforms.paused < 0.5) {
        if (water > 0.0001 && lava > 0.0001) {
            let react = min(water, lava);
            rock = rock + react * 2.0; // Perfect volume conservation prevents vacuum spikes!
        }
    }

    return FullCellData(rock, sand, suspended_sand, water, lava, avalanche);
}

// --- SAND SLIDING FLOW CALCULATION ---
fn computeSandFlow(src_x: u32, src_y: u32, dst_x: u32, dst_y: u32, dist: f32, grid_size: u32) -> f32 {
    let src = get_full_cell_data(src_x, src_y, grid_size);
    if (src.sand <= 0.0001) {
        return 0.0;
    }

    let dst = get_full_cell_data(dst_x, dst_y, grid_size);
    
    let h_src = src.rock + src.sand;
    let h_dst = dst.rock + dst.sand;

    let diff = h_src - h_dst;
    let current_repose = mix(uniforms.sand_static_repose_slope, uniforms.sand_dynamic_repose_slope, src.avalanche);
    let threshold = current_repose * dist;

    if (diff > threshold) {
        var sum_excess = 0.0;
        let excess_dst = diff - threshold;

        let dirs_x = array<i32, 8>(-1, 1, 0, 0, -1, 1, -1, 1);
        let dirs_y = array<i32, 8>(0, 0, -1, 1, -1, -1, 1, 1);
        let dists = array<f32, 8>(1.0, 1.0, 1.0, 1.0, 1.414, 1.414, 1.414, 1.414);

        for (var i = 0; i < 8; i = i + 1) {
            let nx = u32(clamp(i32(src_x) + dirs_x[i], 0, i32(grid_size - 1u)));
            let ny = u32(clamp(i32(src_y) + dirs_y[i], 0, i32(grid_size - 1u)));
            let n_data = get_full_cell_data(nx, ny, grid_size);
            
            let h_n = n_data.rock + n_data.sand;
            let n_diff = h_src - h_n;
            let n_thresh = current_repose * dists[i];
            if (n_diff > n_thresh) {
                sum_excess = sum_excess + (n_diff - n_thresh);
            }
        }

        if (sum_excess > 0.0) {
            var total_slide = 0.0;
            if (src.avalanche > 0.5) {
                let rupture_speed = 0.008;
                total_slide = min(rupture_speed, sum_excess * 0.25);
            } else {
                let effective_rate = min(0.11, uniforms.sand_slide_rate);
                total_slide = sum_excess * effective_rate;
            }
            total_slide = min(src.sand * 0.25, total_slide);
            return total_slide * (excess_dst / sum_excess);
        }
    }
    return 0.0;
}

// --- EROSION AND SEDIMENT CAPACITY ---
fn getNewSuspended(x: u32, y: u32, grid_size: u32) -> f32 {
    let cell = get_full_cell_data(x, y, grid_size);
    if (cell.water <= 0.001) {
        return 0.0;
    }
    
    let idx = y * grid_size + x;
    let f = water_flux[idx];
    let total_flux = f.left + f.right + f.bottom + f.top;
    let velocity = total_flux / cell.water;
    
    var depth_multiplier = 1.0;
    if (uniforms.min_water_depth > 0.0) {
        depth_multiplier = smoothstep(uniforms.min_water_depth * 0.5, uniforms.min_water_depth * 1.5, cell.water);
    }
    
    let capacity = (velocity * velocity * velocity) * cell.water * uniforms.capacity_factor * 2.0 * depth_multiplier;
    let diff = capacity - cell.suspended_sand;
    
    let active_dep_rate = mix(1.0, uniforms.deposition_rate, clamp(velocity * 5.0, 0.0, 1.0));
    let active_rate = select(active_dep_rate, uniforms.erosion_rate, diff > 0.0);
    
    var change = diff * active_rate;
    if (change > 0.0) {
        change = min(cell.sand, change);
    } else {
        change = max(-cell.suspended_sand, change);
    }
    
    return cell.suspended_sand + change;
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

    // --- PROCEDURAL GENERATION PASS ---
    if (uniforms.initialized < 0.5) {
        var rock = 0.0;
        var sand = 0.0;
        let uv = vec2<f32>(f32(x) / f32(grid_size), f32(y) / f32(grid_size));

        if (uniforms.terrain_type < 0.5) {
            let p = uv * uniforms.terrain_scale + vec2<f32>(uniforms.seed);
            rock = fbm(p, i32(uniforms.fbm_octaves), uniforms.fbm_persistence);
            rock = pow(max(0.0, rock), uniforms.terrain_sharpness) * 2.1;
            
            // Add tilt
            rock += (uv.x - 0.5) * uniforms.terrain_tilt;
            rock = max(0.0, rock);
            
            // Place initial sand in valleys
            sand = max(0.0, 0.16 - rock) * 1.5 + uniforms.terrain_sand_height;
        } else {
            rock = uniforms.flat_rock_height;
            rock += (uv.x - 0.5) * uniforms.terrain_tilt;
            rock = max(0.0, rock);
            sand = uniforms.terrain_sand_height;
        }
        
        terrain_out[idx] = TerrainCell(rock, sand, 0.0, 0.0);
        return;
    }

    // --- SIMULATION PASS ---
    let cell = get_full_cell_data(x, y, grid_size);
    var rock = cell.rock;
    var sand = cell.sand;
    var suspended_sand = cell.suspended_sand;
    let water = cell.water;
    var avalanche = cell.avalanche;

    if (uniforms.paused < 0.5) {
        // 1. Calculate Sand sliding incoming/outgoing (Avalanches)
        var sand_in = 0.0;
        var sand_out = 0.0;
        
        let h_center = rock + sand;
        var max_slope = 0.0;

        let dirs_x = array<i32, 8>(-1, 1, 0, 0, -1, 1, -1, 1);
        let dirs_y = array<i32, 8>(0, 0, -1, 1, -1, -1, 1, 1);
        let dists = array<f32, 8>(1.0, 1.0, 1.0, 1.0, 1.414, 1.414, 1.414, 1.414);

        for (var i = 0; i < 8; i = i + 1) {
            let nx = u32(clamp(i32(x) + dirs_x[i], 0, i32(grid_size - 1u)));
            let ny = u32(clamp(i32(y) + dirs_y[i], 0, i32(grid_size - 1u)));
            
            sand_in += computeSandFlow(nx, ny, x, y, dists[i], grid_size);
            sand_out += computeSandFlow(x, y, nx, ny, dists[i], grid_size);
            
            let n_data = get_full_cell_data(nx, ny, grid_size);
            let h_n = n_data.rock + n_data.sand;
            max_slope = max(max_slope, (h_center - h_n) / dists[i]);
        }
        
        // Avalanche hysteresis
        let noise_uv = vec2<f32>(f32(x), f32(y));
        let local_static = uniforms.sand_static_repose_slope + (noise(noise_uv + uniforms.time * 0.1) - 0.5) * 0.0005;
        if (max_slope > local_static) {
            avalanche = 1.0;
        } else if (max_slope < uniforms.sand_dynamic_repose_slope) {
            avalanche = 0.0;
        }

        // 2. Erosion / Deposition reaction
        var ground_sand_change = 0.0;
        var local_susp = suspended_sand;
        
        if (water <= 0.001) {
            ground_sand_change = suspended_sand; // Evaporated, dump suspended sand
            local_susp = 0.0;
        } else {
            let f = water_flux[idx];
            let total_flux = f.left + f.right + f.bottom + f.top;
            let velocity = total_flux / water;
            
            var depth_multiplier = 1.0;
            if (uniforms.min_water_depth > 0.0) {
                depth_multiplier = smoothstep(uniforms.min_water_depth * 0.5, uniforms.min_water_depth * 1.5, water);
            }
            
            let capacity = (velocity * velocity * velocity) * water * uniforms.capacity_factor * 2.0 * depth_multiplier;
            let diff = capacity - suspended_sand;
            
            let active_dep_rate = mix(1.0, uniforms.deposition_rate, clamp(velocity * 5.0, 0.0, 1.0));
            let active_rate = select(active_dep_rate, uniforms.erosion_rate, diff > 0.0);
            
            var change = diff * active_rate;
            if (change > 0.0) {
                change = min(sand, change);
            } else {
                change = max(-suspended_sand, change);
            }
            
            ground_sand_change = -change;
            local_susp = suspended_sand + change;
        }
        
        sand = max(0.0, sand - sand_out + sand_in + ground_sand_change);
        
        // 3. Advection: Suspended sand transport
        var susp_out = 0.0;
        if (water > 0.001) {
            let f = water_flux[idx];
            let total_flux = f.left + f.right + f.bottom + f.top;
            susp_out = local_susp * min(1.0, total_flux / water);
        }

        var susp_in = 0.0;
        // Left neighbor
        if (x > 0u) {
            let n_idx = y * grid_size + (x - 1u);
            let n_w = fluids_in[n_idx].water;
            if (n_w > 0.001) {
                susp_in += getNewSuspended(x - 1u, y, grid_size) * min(1.0, water_flux[n_idx].right / n_w);
            }
        }
        // Right neighbor
        if (x < grid_size - 1u) {
            let n_idx = y * grid_size + (x + 1u);
            let n_w = fluids_in[n_idx].water;
            if (n_w > 0.001) {
                susp_in += getNewSuspended(x + 1u, y, grid_size) * min(1.0, water_flux[n_idx].left / n_w);
            }
        }
        // Bottom neighbor
        if (y > 0u) {
            let n_idx = (y - 1u) * grid_size + x;
            let n_w = fluids_in[n_idx].water;
            if (n_w > 0.001) {
                susp_in += getNewSuspended(x, y - 1u, grid_size) * min(1.0, water_flux[n_idx].top / n_w);
            }
        }
        // Top neighbor
        if (y < grid_size - 1u) {
            let n_idx = (y + 1u) * grid_size + x;
            let n_w = fluids_in[n_idx].water;
            if (n_w > 0.001) {
                susp_in += getNewSuspended(x, y + 1u, grid_size) * min(1.0, water_flux[n_idx].bottom / n_w);
            }
        }

        // Boundary drainage for sand (if behavior allows pass-all)
        if (uniforms.border_behavior == 1.0) {
            if (x == 0u || x == grid_size - 1u || y == 0u || y == grid_size - 1u) {
                sand_in = 0.0;
                susp_in = 0.0;
                local_susp = 0.0;
            }
        }

        suspended_sand = max(0.0, local_susp - susp_out + susp_in);
    }

    // --- BRUSH PAINTING INTERFACE ---
    if (uniforms.brush_active > 0.5) {
        let uv = vec2<f32>(f32(x) / f32(grid_size), f32(y) / f32(grid_size));
        let dist = distance(uv, vec2<f32>(uniforms.brush_x, uniforms.brush_y));
        if (dist < uniforms.brush_radius) {
            let falloff = 1.0 - smoothstep(uniforms.brush_radius * 0.2, uniforms.brush_radius, dist);
            let amount = falloff * uniforms.brush_strength * 0.015;

            if (uniforms.brush_type == 2.0) { // Add Sand
                sand += amount * 1.5;
            } else if (uniforms.brush_type == 3.0) { // Raise Rock
                rock += amount;
            } else if (uniforms.brush_type == 4.0) { // Dig Rock
                rock = max(0.0, rock - amount);
            } else if (uniforms.brush_type == 5.0) { // Clear Sand
                sand = max(0.0, sand - amount * 4.0);
            }
        }
    }

    rock = clamp(rock, 0.0, 10.0);
    sand = clamp(sand, 0.0, 10.0);
    suspended_sand = clamp(suspended_sand, 0.0, 10.0);
    avalanche = clamp(avalanche, 0.0, 1.0);

    terrain_out[idx] = TerrainCell(rock, sand, suspended_sand, avalanche);
}
