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
@group(0) @binding(3) var<storage, read_write> fluids_out : array<FluidCell>;
@group(0) @binding(4) var<storage, read> water_flux : array<FluxCell>;
@group(0) @binding(5) var<storage, read> lava_flux : array<FluxCell>;

fn hash3D(p: vec3<u32>) -> u32 {
    var p3 = p * vec3<u32>(1103515245u, 205891187u, 123456789u);
    var h = p3.x ^ p3.y ^ p3.z;
    h = h * 0x27d4eb2du;
    h = h ^ (h >> 15u);
    return h;
}

fn random3D(p: vec3<u32>) -> f32 {
    return f32(hash3D(p)) * (1.0 / 4294967295.0);
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
        fluids_out[idx] = FluidCell(0.0, 0.0, 0.0, 0.0);
        return;
    }

    let cell_a = terrain_in[idx];
    let cell_b = fluids_in[idx];

    var water = cell_b.water;
    var lava = cell_b.lava;

    var steam = cell_b.steam;
    var temp = cell_b.temp;
    var steam_gen = 0.0;

    // React lava + water to form rock (processed dynamically in fluids state update)
    if (uniforms.paused < 0.5) {
        if (water > 0.0001 && lava > 0.0001) {
            let react = min(water, lava);
            lava = max(0.0, lava - react);
            water = max(0.0, water - react);
            steam_gen = react * 25.0; // generate intense steam
            temp = 1.0; // The new rock barrier is blazing hot
        }
    }

    if (uniforms.paused < 0.5) {
        // --- WATER UPDATE (Virtual Pipe Model) ---
        let my_w_flux = water_flux[idx];
        let w_out = my_w_flux.left + my_w_flux.right + my_w_flux.bottom + my_w_flux.top;
        var w_in = 0.0;

        // In from Left neighbor (its outgoing right flux)
        if (x > 0u) {
            w_in += water_flux[y * grid_size + (x - 1u)].right;
        }
        // In from Right neighbor (its outgoing left flux)
        if (x < grid_size - 1u) {
            w_in += water_flux[y * grid_size + (x + 1u)].left;
        }
        // In from Bottom neighbor (its outgoing top flux)
        if (y > 0u) {
            w_in += water_flux[(y - 1u) * grid_size + x].top;
        }
        // In from Top neighbor (its outgoing bottom flux)
        if (y < grid_size - 1u) {
            w_in += water_flux[(y + 1u) * grid_size + x].bottom;
        }

        water = max(0.0, water - w_out + w_in);

        // Rain simulation
        if (uniforms.rain_active > 0.5) {
            let cell = vec2<u32>(x, y);
            let t = u32(uniforms.time * 60.0);
            let h = random3D(vec3<u32>(cell, t));
            let threshold = 1.0 - uniforms.rain_quantity;
            if (h > threshold) {
                water += uniforms.rain_size;
            }
        }

        // --- LAVA UPDATE (Virtual Pipe Model) ---
        let my_l_flux = lava_flux[idx];
        let l_out = my_l_flux.left + my_l_flux.right + my_l_flux.bottom + my_l_flux.top;
        var l_in = 0.0;

        // In from Left neighbor
        if (x > 0u) {
            l_in += lava_flux[y * grid_size + (x - 1u)].right;
        }
        // In from Right neighbor
        if (x < grid_size - 1u) {
            l_in += lava_flux[y * grid_size + (x + 1u)].left;
        }
        // In from Bottom neighbor
        if (y > 0u) {
            l_in += lava_flux[(y - 1u) * grid_size + x].top;
        }
        // In from Top neighbor
        if (y < grid_size - 1u) {
            l_in += lava_flux[(y + 1u) * grid_size + x].bottom;
        }

        lava = max(0.0, lava - l_out + l_in);

        // Evaporate water slowly
        if (water > 0.0) {
            water = max(0.0, water - uniforms.evaporation);
        }
    }

    // --- BRUSH PAINTING INTERFACE ---
    if (uniforms.brush_active > 0.5) {
        let uv = vec2<f32>(f32(x) / f32(grid_size), f32(y) / f32(grid_size));
        let dist = distance(uv, vec2<f32>(uniforms.brush_x, uniforms.brush_y));
        if (dist < uniforms.brush_radius) {
            let falloff = 1.0 - smoothstep(uniforms.brush_radius * 0.2, uniforms.brush_radius, dist);
            let amount = falloff * uniforms.brush_strength * 0.06;

            if (uniforms.brush_type == 0.0) { // Add Water
                water += amount * 1.5;
            } else if (uniforms.brush_type == 1.0) { // Add Lava
                lava += amount;
            } else if (uniforms.brush_type == 5.0) { // Erase liquids
                water = max(0.0, water - amount * 5.0);
                lava = max(0.0, lava - amount * 5.0);
            }
        }
    }

    // --- BOUNDARY DRAINAGE CONDITIONS ---
    if (uniforms.paused < 0.5) {
        if (uniforms.border_behavior > 0.5) {
            if (x == 0u || x == grid_size - 1u || y == 0u || y == grid_size - 1u) {
                let ground = cell_a.rock + cell_a.sand;
                water = max(0.0, uniforms.border_water_height - ground);
                lava = 0.0;
            }
        }
    }

    water = clamp(water, 0.0, 10.0);
    lava = clamp(lava, 0.0, 10.0);

    // Steam diffusion and dissipation
    if (uniforms.paused < 0.5) {
        var steam_neighbors = 0.0;
        var count = 0.0;
        if (x > 0u) { steam_neighbors += fluids_in[y * grid_size + (x - 1u)].steam; count += 1.0; }
        if (x < grid_size - 1u) { steam_neighbors += fluids_in[y * grid_size + (x + 1u)].steam; count += 1.0; }
        if (y > 0u) { steam_neighbors += fluids_in[(y - 1u) * grid_size + x].steam; count += 1.0; }
        if (y < grid_size - 1u) { steam_neighbors += fluids_in[(y + 1u) * grid_size + x].steam; count += 1.0; }
        
        if (count > 0.0) {
            steam = mix(steam, steam_neighbors / count, 0.3); // diffuse steam
        }
        
        steam = max(0.0, steam - 0.04); // fade out steam
        steam += steam_gen;
        steam = clamp(steam, 0.0, 5.0);

        // Temp cooling
        if (lava > 0.01) {
            temp = 1.0;
        } else {
            if (water > 0.01) {
                temp = max(0.0, temp - 0.005); // fast cooling by water
            } else {
                temp = max(0.0, temp - 0.001); // slow natural cooling
            }
        }
    }

    // Zero-out Epsilon: completely destroy mathematically insignificant amounts
    if (water < 0.0001) { water = 0.0; }
    if (lava < 0.0001) { lava = 0.0; }
    if (steam < 0.001) { steam = 0.0; }

    fluids_out[idx] = FluidCell(water, lava, temp, steam);
}
