struct TerrainCell {
    rock: f32,
    sand: f32,
    suspended_sand: f32,
    avalanche: f32, // Packed independent flags: sand = 1, soil = 2.
    soil: f32,
    suspended_soil: f32,
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
    sediment_slide_rate: f32,
    sand_static_repose_slope: f32,
    sand_dynamic_repose_slope: f32,
    erosion_rate: f32,
    capacity_factor: f32,
    deposition_rate: f32,
    reserved_evaporation: f32,
    initialized: f32,
    paused: f32,
    brush_active: f32,
    brush_type: f32,
    brush_strength: f32,
    brush_radius: f32,
    brush_x: f32,
    brush_y: f32,
    time: f32,
    reserved_rain_active: f32,
    reserved_rain_quantity: f32,
    reserved_rain_size: f32,
    reserved_border_behavior: f32,
    reserved_border_water_height: f32,
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
    soil_static_repose_slope: f32,
    soil_dynamic_repose_slope: f32,
    terrain_soil_height: f32,
    padding_0: f32,
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

// React locally before sliding. Every neighbor recomputes the same exchange
// from the input buffers, so erosion and avalanches cannot spend the same grain.
struct FullCellData {
    rock: f32,
    sand: f32,
    soil: f32,
    suspended: vec2<f32>, // sand, soil; kept separate throughout transport
    water: f32,
    avalanche: vec2<f32>, // Independent sand and soil collapse histories.
};

fn get_full_cell_data(x: u32, y: u32, grid_size: u32) -> FullCellData {
    let idx = y * grid_size + x;
    let terrain = terrain_in[idx];
    let fluid = fluids_in[idx];
    var rock = terrain.rock;
    var ground = vec2<f32>(terrain.sand, terrain.soil);
    var suspended = vec2<f32>(terrain.suspended_sand, terrain.suspended_soil);
    if (uniforms.paused < 0.5) {
        if (fluid.water > 0.0001 && fluid.lava > 0.0001) {
            rock += min(fluid.water, fluid.lava) * 2.0;
        }
        if (fluid.water <= 0.001) {
            ground += suspended;
            suspended = vec2<f32>(0.0);
        } else {
            let f = water_flux[idx];
            let velocity = (f.left + f.right + f.bottom + f.top) / fluid.water;
            var depth_multiplier = 1.0;
            if (uniforms.min_water_depth > 0.0) {
                depth_multiplier = smoothstep(uniforms.min_water_depth * 0.5, uniforms.min_water_depth * 1.5, fluid.water);
            }
            // One carrying capacity shared by both materials, never doubled.
            let capacity = velocity * velocity * velocity * fluid.water * uniforms.capacity_factor * 2.0 * depth_multiplier;
            let load = suspended.x + suspended.y;
            let spare = capacity - load;
            if (spare > 0.0) {
                // One rate and one erosion budget; consume the exposed layer
                // first, then spend the remainder on the soil directly beneath.
                let erosion_budget = spare * clamp(uniforms.erosion_rate, 0.0, 1.0);
                let eroded_sand = min(ground.x, erosion_budget);
                let eroded_soil = min(ground.y, max(0.0, erosion_budget - eroded_sand));
                let eroded = vec2<f32>(eroded_sand, eroded_soil);
                ground -= eroded;
                suspended += eroded;
            } else if (load > 0.0) {
                let rate = mix(1.0, clamp(uniforms.deposition_rate, 0.0, 1.0), clamp(velocity * 5.0, 0.0, 1.0));
                let deposited = suspended * clamp(-spare * rate / load, 0.0, 1.0);
                // Deposited soil joins the layer below the sand in this heightfield.
                ground += deposited;
                suspended -= deposited;
            }
        }
    }
    let flags = u32(terrain.avalanche);
    return FullCellData(rock, ground.x, ground.y, suspended, fluid.water,
        vec2<f32>(f32(flags & 1u), f32((flags >> 1u) & 1u)));
}

// Both flows are paired between cells. Soil can retain a near-vertical face;
// sand rests on the combined rock/soil bed. Each material has its own hysteresis.
fn computeGroundFlow(src_x: u32, src_y: u32, dst_x: u32, dst_y: u32, dist: f32, grid_size: u32) -> vec2<f32> {
    let src = get_full_cell_data(src_x, src_y, grid_size);
    if (src.sand <= 0.0 && src.soil <= 0.0) { return vec2<f32>(0.0); }
    let dst = get_full_cell_data(dst_x, dst_y, grid_size);
    let heights = vec2<f32>(src.rock + src.soil + src.sand, src.rock + src.soil);
    let static_repose = vec2<f32>(uniforms.sand_static_repose_slope, uniforms.soil_static_repose_slope);
    let dynamic_repose = min(static_repose,
        vec2<f32>(uniforms.sand_dynamic_repose_slope, uniforms.soil_dynamic_repose_slope));
    let repose = mix(static_repose, dynamic_repose, src.avalanche);
    let excess = max(vec2<f32>(0.0), heights - (dst.rock + dst.soil + dst.sand) - repose * dist);
    if (all(excess <= vec2<f32>(0.0))) { return vec2<f32>(0.0); }
    var sum_excess = vec2<f32>(0.0);
    let dirs_x = array<i32, 8>(-1, 1, 0, 0, -1, 1, -1, 1);
    let dirs_y = array<i32, 8>(0, 0, -1, 1, -1, -1, 1, 1);
    let dists = array<f32, 8>(1.0, 1.0, 1.0, 1.0, 1.41421356, 1.41421356, 1.41421356, 1.41421356);
    for (var i = 0; i < 8; i++) {
        let nx = i32(src_x) + dirs_x[i];
        let ny = i32(src_y) + dirs_y[i];
        if (nx < 0 || ny < 0 || nx >= i32(grid_size) || ny >= i32(grid_size)) { continue; }
        let neighbor = get_full_cell_data(u32(nx), u32(ny), grid_size);
        sum_excess += max(vec2<f32>(0.0), heights - (neighbor.rock + neighbor.soil + neighbor.sand) - repose * dists[i]);
    }
    var slide = sum_excess * clamp(uniforms.sediment_slide_rate, 0.0, 0.11);
    if (uniforms.sediment_slide_rate > 0.0) {
        slide = select(slide, min(vec2<f32>(0.008), sum_excess * 0.25),
            src.avalanche > vec2<f32>(0.5));
    }
    let total_slide = min(vec2<f32>(src.sand, src.soil) * 0.25, slide);
    return total_slide * excess / max(sum_excess, vec2<f32>(0.00000001));
}

fn incomingSediment(x: u32, y: u32, grid_size: u32, flux: f32) -> vec2<f32> {
    let cell = get_full_cell_data(x, y, grid_size);
    if (cell.water <= 0.001) { return vec2<f32>(0.0); }
    let f = water_flux[y * grid_size + x];
    let total_flux = f.left + f.right + f.bottom + f.top;
    return cell.suspended * flux / max(cell.water, total_flux);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let grid_size = u32(uniforms.grid_size);
    let x = id.x;
    let y = id.y;
    if (x >= grid_size || y >= grid_size) { return; }
    let idx = y * grid_size + x;

    if (uniforms.initialized < 0.5) {
        var rock = 0.0;
        var sand = 0.0;
        let uv = vec2<f32>(f32(x), f32(y)) / f32(grid_size);
        if (uniforms.terrain_type < 0.5) {
            let p = uv * uniforms.terrain_scale + vec2<f32>(uniforms.seed);
            rock = fbm(p, i32(uniforms.fbm_octaves), uniforms.fbm_persistence);
            rock = pow(max(0.0, rock), uniforms.terrain_sharpness) * 2.1;
            rock = max(0.0, rock + (uv.x - 0.5) * uniforms.terrain_tilt);
            sand = max(0.0, 0.16 - rock) * 1.5 + uniforms.terrain_sand_height;
        } else {
            rock = max(0.0, uniforms.flat_rock_height + (uv.x - 0.5) * uniforms.terrain_tilt);
            sand = uniforms.terrain_sand_height;
        }
        terrain_out[idx] = TerrainCell(rock, sand, 0.0, 0.0, max(0.0, uniforms.terrain_soil_height), 0.0);
        return;
    }

    let cell = get_full_cell_data(x, y, grid_size);
    var rock = cell.rock;
    var ground = vec2<f32>(cell.sand, cell.soil);
    var suspended = cell.suspended;
    var avalanche = cell.avalanche;
    if (uniforms.paused < 0.5) {
        var ground_in = vec2<f32>(0.0);
        var ground_out = vec2<f32>(0.0);
        let h_center = vec2<f32>(rock + cell.soil + cell.sand, rock + cell.soil);
        var max_slope = vec2<f32>(0.0);
        let dirs_x = array<i32, 8>(-1, 1, 0, 0, -1, 1, -1, 1);
        let dirs_y = array<i32, 8>(0, 0, -1, 1, -1, -1, 1, 1);
        let dists = array<f32, 8>(1.0, 1.0, 1.0, 1.0, 1.41421356, 1.41421356, 1.41421356, 1.41421356);
        for (var i = 0; i < 8; i++) {
            let nx = i32(x) + dirs_x[i];
            let ny = i32(y) + dirs_y[i];
            if (nx < 0 || ny < 0 || nx >= i32(grid_size) || ny >= i32(grid_size)) { continue; }
            ground_in += computeGroundFlow(u32(nx), u32(ny), x, y, dists[i], grid_size);
            ground_out += computeGroundFlow(x, y, u32(nx), u32(ny), dists[i], grid_size);
            let neighbor = get_full_cell_data(u32(nx), u32(ny), grid_size);
            max_slope = max(max_slope, (h_center - neighbor.rock - neighbor.soil - neighbor.sand) / dists[i]);
        }
        ground = max(vec2<f32>(0.0), ground - ground_out + ground_in);
        let local_static = vec2<f32>(uniforms.sand_static_repose_slope, uniforms.soil_static_repose_slope)
            + (noise(vec2<f32>(f32(x), f32(y)) + uniforms.time * 0.1) - 0.5) * 0.0005;
        if (max_slope.x > local_static.x) { avalanche.x = 1.0; }
        else if (max_slope.x <= min(uniforms.sand_dynamic_repose_slope, uniforms.sand_static_repose_slope)) { avalanche.x = 0.0; }
        if (max_slope.y > local_static.y) { avalanche.y = 1.0; }
        else if (max_slope.y <= min(uniforms.soil_dynamic_repose_slope, uniforms.soil_static_repose_slope)) { avalanche.y = 0.0; }
        if (ground.x <= 0.0) { avalanche.x = 0.0; }
        if (ground.y <= 0.0) { avalanche.y = 0.0; }

        // The same outgoing fractions are used by every receiving neighbor.
        var susp_out = vec2<f32>(0.0);
        if (cell.water > 0.001) {
            let f = water_flux[idx];
            susp_out = suspended * min(1.0, (f.left + f.right + f.bottom + f.top) / cell.water);
        }
        var susp_in = vec2<f32>(0.0);
        if (x > 0u) { susp_in += incomingSediment(x - 1u, y, grid_size, water_flux[idx - 1u].right); }
        if (x + 1u < grid_size) { susp_in += incomingSediment(x + 1u, y, grid_size, water_flux[idx + 1u].left); }
        if (y > 0u) { susp_in += incomingSediment(x, y - 1u, grid_size, water_flux[idx - grid_size].top); }
        if (y + 1u < grid_size) { susp_in += incomingSediment(x, y + 1u, grid_size, water_flux[idx + grid_size].bottom); }
        suspended = max(vec2<f32>(0.0), suspended - susp_out + susp_in);

    }

    if (uniforms.brush_active > 0.5) {
        let uv = vec2<f32>(f32(x), f32(y)) / f32(grid_size);
        let dist = distance(uv, vec2<f32>(uniforms.brush_x, uniforms.brush_y));
        if (dist < uniforms.brush_radius) {
            let falloff = 1.0 - smoothstep(uniforms.brush_radius * 0.2, uniforms.brush_radius, dist);
            let amount = falloff * uniforms.brush_strength * 0.015;
            if (uniforms.brush_type == 2.0) { ground.x += amount * 1.5; }
            else if (uniforms.brush_type == 9.0) { ground.y += amount * 1.5; }
            else if (uniforms.brush_type == 3.0) { rock += amount; }
            else if (uniforms.brush_type == 4.0) { rock = max(0.0, rock - amount); }
            else if (uniforms.brush_type == 5.0) {
                // Erase the upper sand layer before reaching the soil beneath.
                let removed_sand = min(ground.x, amount * 4.0);
                ground.x -= removed_sand;
                ground.y = max(0.0, ground.y - (amount * 4.0 - removed_sand));
            }
        }
    }
    let flags = u32(avalanche.x) | (u32(avalanche.y) << 1u);
    terrain_out[idx] = TerrainCell(clamp(rock, 0.0, 10.0), ground.x, suspended.x,
        f32(flags), ground.y, suspended.y);
}
