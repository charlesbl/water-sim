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
@group(0) @binding(2) var<storage, read> fluids_in : array<FluidCell>;
@group(0) @binding(3) var<storage, read_write> fluids_out : array<FluidCell>;
@group(0) @binding(4) var<storage, read> water_flux : array<FluxCell>;
@group(0) @binding(5) var<storage, read> lava_flux : array<FluxCell>;
@group(0) @binding(6) var<storage, read_write> weather_surface : array<vec4<f32>>;

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

        // Contact quenches lava into rock (simTerrain). Water stays in the
        // bottle; evaporation is paid for by the surface's finite heat store.
        lava -= min(water, lava);
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
                // Manual injection supplies a finite pulse of sensible heat.
                // Existing lava never acts as a permanent atmospheric heater.
                let frozen = weather_surface[idx];
                let capacity = materialHeatCapacity(cell_a.sand, cell_a.soil, water, frozen.y, frozen.x);
                weather_surface[idx].z = min(90.0, frozen.z + amount * 450.0 / capacity);
            } else if (uniforms.brush_type == 5.0) { // Erase liquid and frozen water
                water = max(0.0, water - amount * 5.0);
                lava = max(0.0, lava - amount * 5.0);
                weather_surface[idx].x = max(0.0, weather_surface[idx].x - amount * 5.0);
                weather_surface[idx].y = max(0.0, weather_surface[idx].y - amount * 5.0);
            } else if (uniforms.brush_type == 6.0) { // Add bottom ice at -5 C
                var frozen = weather_surface[idx];
                let added = amount * 1.5; // Water-equivalent depth, like the water brush.
                let capacity = materialHeatCapacity(cell_a.sand, cell_a.soil, water, frozen.y, frozen.x);
                frozen.y += added;
                frozen.z = (capacity * frozen.z - added * 5.0 * 5.0) / (capacity + added * 5.0);
                weather_surface[idx] = frozen;
            } else if (uniforms.brush_type == 7.0 || uniforms.brush_type == 8.0) {
                // Supply/remove sensible energy; normal weather steps perform
                // phase changes. Deep water responds more slowly than dry land.
                let frozen = weather_surface[idx];
                let capacity = materialHeatCapacity(cell_a.sand, cell_a.soil, water, frozen.y, frozen.x);
                let direction = select(-1.0, 1.0, uniforms.brush_type == 7.0);
                weather_surface[idx].z = clamp(frozen.z + direction * amount * 8.0 / capacity, -70.0, 90.0);
            }
        }
    }

    water = max(water, 0.0);
    lava = clamp(lava, 0.0, 10.0);

    // Submerged snow joins the liquid/ice even when weather is disabled.
    // Each invocation owns its surface cell; neighbor fluxes have already run.
    // Match surfaceExchange's heat capacity and fusion energy accounting.
    if ((uniforms.paused < 0.5 || uniforms.brush_active > 0.5) && water > 0.0 && weather_surface[idx].x > 0.0) {
        var frozen = weather_surface[idx];
        let capacity = materialHeatCapacity(cell_a.sand, cell_a.soil, water, frozen.y, frozen.x);
        let transfer = wetSnowTransfer(water, frozen.x, capacity * frozen.z);
        let energy = capacity * frozen.z - 80.0 * transfer.x;
        water += transfer.x;
        frozen.x -= transfer.x + transfer.y;
        frozen.y += transfer.y;
        frozen.z = energy / materialHeatCapacity(cell_a.sand, cell_a.soil, water, frozen.y, frozen.x);
        weather_surface[idx] = frozen;
    }

    // Steam is water waiting to join the atmosphere, including while weather
    // is paused/disabled. Visual opacity is scaled separately in the renderer.
    if (uniforms.paused < 0.5) {
        // Cosmetic lava glow; atmospheric heat is stored in weather_surface.z.
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

    // Water and vapor have no artificial deletion threshold.
    if (lava < 0.0001) { lava = 0.0; }

    fluids_out[idx] = FluidCell(water, lava, temp, steam);
}
