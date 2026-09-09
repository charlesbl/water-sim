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

struct RenderUniforms {
    model_view_proj_matrix: mat4x4<f32>,
    sun_dir: vec3<f32>,
    height_scale: f32,
    sun_color: vec3<f32>,
    grid_size: f32,
    local_camera_pos: vec3<f32>,
    layer: f32, // 0: Terrain, 1: Fluids
    show_rock: f32,
    show_sand: f32,
    show_water: f32,
    show_lava: f32,
    show_suspended: f32,
    time: f32,
    smooth_rendering: f32,
    border_behavior: f32,
    border_water_height: f32,
    show_soil: f32,
    padding_1: f32,
    padding_2: f32,
};

@group(0) @binding(0) var<uniform> uniforms : RenderUniforms;
@group(0) @binding(1) var<storage, read> terrain_in : array<TerrainCell>;
@group(0) @binding(2) var<storage, read> fluids_in : array<FluidCell>;
@group(0) @binding(3) var<storage, read> water_flux : array<FluxCell>;
// Snow and ice are stored as water equivalent depths; z is surface temperature.
@group(0) @binding(4) var<storage, read> weather_surface : array<vec4<f32>>;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) uv: vec2<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) pos: vec3<f32>,
    @location(2) rock: f32,
    @location(3) sand: f32,
    @location(4) suspended_sand: f32,
    @location(5) water: f32,
    @location(6) lava: f32,
    @location(7) temp: f32,
    @location(8) steam: f32,
    @location(9) snow_ice: vec2<f32>,
    @location(10) soil: f32,
    @location(11) suspended_soil: f32,
};

// --- HEIGHT RETRIEVAL HELPERS ---
fn frozen_depth(idx: i32) -> f32 {
    let weather = max(weather_surface[idx].xy, vec2<f32>(0.0));
    return weather.x * 5.0 + weather.y / 0.917;
}

fn get_weather_surface(uv: vec2<f32>, grid_size: i32) -> vec2<f32> {
    let p = uv * f32(grid_size) - 0.5;
    let lower = vec2<i32>(floor(p));
    let a = clamp(lower, vec2<i32>(0), vec2<i32>(grid_size - 1));
    let b = clamp(lower + vec2<i32>(1), vec2<i32>(0), vec2<i32>(grid_size - 1));
    let f = fract(p);
    return max(mix(
        mix(weather_surface[a.y * grid_size + a.x].xy, weather_surface[a.y * grid_size + b.x].xy, f.x),
        mix(weather_surface[b.y * grid_size + a.x].xy, weather_surface[b.y * grid_size + b.x].xy, f.x), f.y), vec2<f32>(0.0));
}

fn get_cell_ground_height(x: i32, y: i32, grid_size: i32) -> f32 {
    let cx = clamp(x, 0, grid_size - 1);
    let cy = clamp(y, 0, grid_size - 1);
    let idx = cy * grid_size + cx;
    // Ice is a fixed bed beneath the remaining water, just like solid terrain.
    return terrain_in[idx].rock + terrain_in[idx].soil + terrain_in[idx].sand + frozen_depth(idx);
}

fn get_ground_height_smooth(uv: vec2<f32>, grid_size: i32) -> f32 {
    let p = uv * f32(grid_size) - 0.5;
    let i = floor(p);
    let f = fract(p);
    let ix = i32(i.x);
    let iy = i32(i.y);
    
    let tl = get_cell_ground_height(ix, iy, grid_size);
    let tr = get_cell_ground_height(ix + 1, iy, grid_size);
    let bl = get_cell_ground_height(ix, iy + 1, grid_size);
    let br = get_cell_ground_height(ix + 1, iy + 1, grid_size);
    
    return mix(mix(tl, tr, f.x), mix(bl, br, f.x), f.y);
}

fn get_cell_total_height(x: i32, y: i32, grid_size: i32) -> f32 {
    let cx = clamp(x, 0, grid_size - 1);
    let cy = clamp(y, 0, grid_size - 1);
    let idx = cy * grid_size + cx;
    return terrain_in[idx].rock + terrain_in[idx].soil + terrain_in[idx].sand + fluids_in[idx].water + fluids_in[idx].lava + frozen_depth(idx);
}

fn get_total_height_smooth(uv: vec2<f32>, grid_size: i32) -> f32 {
    let p = uv * f32(grid_size) - 0.5;
    let i = floor(p);
    let f = fract(p);
    let ix = i32(i.x);
    let iy = i32(i.y);
    
    let tl = get_cell_total_height(ix, iy, grid_size);
    let tr = get_cell_total_height(ix + 1, iy, grid_size);
    let bl = get_cell_total_height(ix, iy + 1, grid_size);
    let br = get_cell_total_height(ix + 1, iy + 1, grid_size);
    
    return mix(mix(tl, tr, f.x), mix(bl, br, f.x), f.y);
}

// --- VERTEX SHADER ---
@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.uv = input.uv;

    let grid_size = i32(uniforms.grid_size);
    let cell_x = clamp(u32(input.uv.x * uniforms.grid_size), 0u, u32(grid_size - 1));
    let cell_y = clamp(u32(input.uv.y * uniforms.grid_size), 0u, u32(grid_size - 1));
    let idx = cell_y * u32(grid_size) + cell_x;

    let cell_a = terrain_in[idx];
    let cell_b = fluids_in[idx];

    output.rock = cell_a.rock;
    output.sand = cell_a.sand;
    output.soil = cell_a.soil;
    output.suspended_soil = cell_a.suspended_soil;
    output.suspended_sand = cell_a.suspended_sand;
    output.water = cell_b.water;
    output.lava = cell_b.lava;
    output.temp = cell_b.temp;
    output.steam = cell_b.steam * 25.0; // Render density, separate from water-equivalent inventory.
    output.snow_ice = max(weather_surface[idx].xy, vec2<f32>(0.0));
    if (uniforms.smooth_rendering > 0.5) {
        output.snow_ice = get_weather_surface(input.uv, grid_size);
    }

    var h = 0.0;
    if (uniforms.layer > 0.5) {
        if (uniforms.smooth_rendering > 0.5) {
            h = get_total_height_smooth(input.uv, grid_size);
        } else {
            h = get_cell_total_height(i32(cell_x), i32(cell_y), grid_size);
        }
        // Keep steam visible after the last liquid freezes into the solid bed.
        if (output.snow_ice.y > 0.00001) { h += 0.00005; }
    } else {
        if (uniforms.smooth_rendering > 0.5) {
            h = get_ground_height_smooth(input.uv, grid_size);
        } else {
            h = get_cell_ground_height(i32(cell_x), i32(cell_y), grid_size);
        }
    }

    var displaced = input.position;
    displaced.z = h * uniforms.height_scale;
    output.pos = displaced;

    output.clip_position = uniforms.model_view_proj_matrix * vec4<f32>(displaced, 1.0);
    return output;
}

// --- NOISE HELPERS FOR SHADING ---
fn hash2D(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453123);
}

fn noise2D(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2D(i + vec2<f32>(0.0, 0.0)), hash2D(i + vec2<f32>(1.0, 0.0)), u.x),
               mix(hash2D(i + vec2<f32>(0.0, 1.0)), hash2D(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}

// Static crystal cells in terrain space. The two nearest seeds define an
// angular fracture; retaining their separation gives a consistent line width.
fn ice_fracture(p: vec2<f32>) -> vec3<f32> {
    let cell = floor(p);
    let local = fract(p);
    var nearest = vec2<f32>(0.0);
    var runner_up = vec2<f32>(0.0);
    var distances = vec2<f32>(100.0);
    var crystal = 0.0;
    var runner_up_crystal = 0.0;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let offset = vec2<f32>(f32(x), f32(y));
            let seed = vec2<f32>(hash2D(cell + offset), hash2D(cell + offset + vec2<f32>(19.7, 8.3)));
            let delta = offset + seed - local;
            let distance_sq = dot(delta, delta);
            if (distance_sq < distances.x) {
                distances.y = distances.x;
                runner_up = nearest;
                runner_up_crystal = crystal;
                distances.x = distance_sq;
                nearest = delta;
                crystal = seed.x;
            } else if (distance_sq < distances.y) {
                distances.y = distance_sq;
                runner_up = delta;
                runner_up_crystal = seed.x;
            }
        }
    }
    let edge = (distances.y - distances.x) / max(2.0 * length(runner_up - nearest), 0.001);
    // Both sides of a shared edge use the same strength. Only some crystal
    // boundaries fracture visibly, avoiding a regular, tiled appearance.
    let edge_seed = vec2<f32>(min(crystal, runner_up_crystal), max(crystal, runner_up_crystal));
    return vec3<f32>(edge, crystal, hash2D(edge_seed * 71.3));
}

fn ice_line(distance: f32, width: f32, footprint: f32) -> f32 {
    let aa = max(footprint, 0.0005);
    // Fade subpixel lines instead of turning them into bright, flickering dots.
    return (1.0 - smoothstep(max(0.0, width - aa), width + aa, distance)) * min(1.0, width / aa);
}

fn shade_ice(input: VertexOutput, normal: vec3<f32>, view_dir: vec3<f32>, ground_lit: vec3<f32>, footprint: f32) -> vec3<f32> {
    let p = input.pos.xy;
    let thickness = input.snow_ice.y / 0.917;
    let mature = 1.0 - exp(-thickness * 16.0);
    let exposed = 1.0 - smoothstep(0.001, 0.035, input.water);

    let cloudiness = noise2D(p * 0.065 + vec2<f32>(7.1, 12.8));
    let grain_visibility = 1.0 - smoothstep(0.15, 0.8, footprint);
    let grain = (noise2D(p * 1.6) - 0.5) * grain_visibility;
    let frost = clamp(smoothstep(0.48, 0.82, cloudiness) * mature
        + (1.0 - smoothstep(0.006, 0.055, thickness)) * 0.3, 0.0, 1.0);

    let warp = vec2<f32>(noise2D(p * 0.12), noise2D(p * 0.12 + vec2<f32>(34.2, 6.7))) - 0.5;
    let fracture = ice_fracture(p * 0.075 + warp * 0.22);
    let fracture_strength = smoothstep(0.25, 0.8, fracture.z) * (0.35 + 0.65 * noise2D(p * 0.3));
    let crack_width = 0.003 + cloudiness * 0.004;
    let crack = ice_line(fracture.x, crack_width, footprint * 0.095) * mature * fracture_strength;
    let crack_halo = ice_line(fracture.x, 0.018, footprint * 0.095) * mature * fracture_strength;

    // Small, stationary changes in the normal break up the polished highlight.
    // Project the perturbation onto the surface so sloping ice stays coherent.
    let relief = vec3<f32>(warp * 0.10 + vec2<f32>(grain, -grain) * 0.018, 0.0);
    let ice_normal = normalize(normal + (relief - normal * dot(relief, normal)) * (1.0 - frost * 0.6));
    let ndv = clamp(dot(ice_normal, view_dir), 0.0, 1.0);
    let diffuse = max(0.0, dot(ice_normal, uniforms.sun_dir));
    let lighting = uniforms.sun_color * (diffuse * 0.72) + vec3<f32>(0.20, 0.25, 0.30);

    // Thin ice reveals the shaded ground. Longer optical paths absorb more red
    // light, while thicker and cloudy regions scatter a pale blue into the body.
    let optical_depth = thickness * (1.0 + frost * 1.8) / max(ndv, 0.35);
    let transmission = exp(-vec3<f32>(8.0, 4.0, 2.4) * optical_depth);
    let body_color = mix(vec3<f32>(0.28, 0.51, 0.62), vec3<f32>(0.72, 0.84, 0.89), frost * 0.72);
    var body = ground_lit * transmission + body_color * lighting * (vec3<f32>(1.0) - transmission);
    body += vec3<f32>(0.035, 0.055, 0.065) * (cloudiness - 0.5) * mature;
    body += vec3<f32>(0.06, 0.12, 0.15) * crack_halo;
    let fracture_color = vec3<f32>(0.72, 0.87, 0.92) * lighting;
    body = mix(body, fracture_color, crack * (0.45 + fracture.y * 0.3));
    body += vec3<f32>(grain * frost * 0.035);

    // Ice/air Fresnel (IOR about 1.31), with a broader lobe on frosted areas.
    // Submerged ice is lit through the water pass instead of reflecting sky twice.
    let fresnel = (0.018 + 0.982 * pow(1.0 - ndv, 5.0)) * (1.0 - frost * 0.55) * exposed;
    let reflected_view = reflect(-view_dir, ice_normal);
    let sky = mix(vec3<f32>(0.72, 0.83, 0.90), vec3<f32>(0.23, 0.46, 0.73),
        smoothstep(0.0, 0.85, reflected_view.z)) * (uniforms.sun_color + vec3<f32>(0.12));
    let sun_alignment = max(0.0, dot(reflect(-uniforms.sun_dir, ice_normal), view_dir));
    let polish = pow(sun_alignment, mix(180.0, 38.0, frost));
    let sheen = pow(sun_alignment, 18.0) * 0.07;
    let specular = (polish * mix(0.7, 0.18, frost) + sheen) * diffuse * exposed;
    return mix(body, sky, fresnel) + uniforms.sun_color * specular;
}

fn mod289_3(x: vec3<f32>) -> vec3<f32> {
    return x - floor(x * (1.0 / 289.0)) * 289.0;
}

fn mod289_2(x: vec2<f32>) -> vec2<f32> {
    return x - floor(x * (1.0 / 289.0)) * 289.0;
}

fn permute(x: vec3<f32>) -> vec3<f32> {
    return mod289_3(((x * 34.0) + 1.0) * x);
}

fn snoise(v: vec2<f32>) -> f32 {
    let C = vec4<f32>(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    var i = floor(v + dot(v, C.yy));
    let x0 = v - i + dot(i, C.xx);
    var i1: vec2<f32>;
    if (x0.x > x0.y) {
        i1 = vec2<f32>(1.0, 0.0);
    } else {
        i1 = vec2<f32>(0.0, 1.0);
    }
    var x12 = x0.xyxy + C.xxzz;
    x12.x = x12.x - i1.x;
    x12.y = x12.y - i1.y;
    let i_mod = mod289_2(i);
    let p = permute(permute(i_mod.y + vec3<f32>(0.0, i1.y, 1.0)) + i_mod.x + vec3<f32>(0.0, i1.x, 1.0));
    var m = max(0.5 - vec3<f32>(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), vec3<f32>(0.0));
    m = m * m;
    m = m * m;
    let x = 2.0 * fract(p * C.www) - 1.0;
    let h = abs(x) - 0.5;
    let ox = floor(x + 0.5);
    let a0 = x - ox;
    m = m * (1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h));
    var g: vec3<f32>;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.y = a0.y * x12.x + h.y * x12.y;
    g.z = a0.z * x12.z + h.z * x12.w;
    return 130.0 * dot(m, g);
}

// --- FLUX INTERPOLATION ---
fn get_cell_flux(x: i32, y: i32, grid_size: i32) -> vec4<f32> {
    let cx = clamp(x, 0, grid_size - 1);
    let cy = clamp(y, 0, grid_size - 1);
    let idx = cy * grid_size + cx;
    let f = water_flux[idx];
    return vec4<f32>(f.left, f.right, f.bottom, f.top);
}

fn get_smooth_flux(uv: vec2<f32>, grid_size: i32) -> vec4<f32> {
    let p = uv * f32(grid_size) - 0.5;
    let i = floor(p);
    let f = fract(p);
    let ix = i32(i.x);
    let iy = i32(i.y);
    
    let tl = get_cell_flux(ix, iy, grid_size);
    let tr = get_cell_flux(ix + 1, iy, grid_size);
    let bl = get_cell_flux(ix, iy + 1, grid_size);
    let br = get_cell_flux(ix + 1, iy + 1, grid_size);
    
    let tA = mix(tl, tr, f.x);
    let tB = mix(bl, br, f.x);
    return mix(tA, tB, f.y);
}

fn get_streak(uv: vec2<f32>, dir: vec2<f32>, n_scale: f32) -> f32 {
    let step_size = 0.4 / n_scale;
    var acc = 0.0;
    acc += snoise((uv - dir * step_size * 2.0) * n_scale);
    acc += snoise(uv * n_scale);
    acc += snoise((uv + dir * step_size * 2.0) * n_scale);
    return acc * 0.3333 * 1.5 + 0.5;
}

// --- FRAGMENT SHADER ---
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let grid_size = i32(uniforms.grid_size);
    let texel = vec2<f32>(1.0 / uniforms.grid_size);
    let view_dir = normalize(uniforms.local_camera_pos - input.pos);
    // Derivatives must be evaluated before any nonuniform material branches.
    let surface_footprint = max(length(dpdx(input.pos.xy)), length(dpdy(input.pos.xy)));

    if (uniforms.layer < 0.5) {
        // --- TERRAIN SHADING ---
        if (uniforms.show_rock < 0.5
            && (uniforms.show_soil < 0.5 || input.soil <= 0.0001)
            && (uniforms.show_sand < 0.5 || input.sand <= 0.0001)) {
            discard;
        }

        var hL: f32; var hR: f32; var hD: f32; var hU: f32;
        if (uniforms.smooth_rendering > 0.5) {
            hL = get_ground_height_smooth(input.uv - vec2<f32>(texel.x, 0.0), grid_size);
            hR = get_ground_height_smooth(input.uv + vec2<f32>(texel.x, 0.0), grid_size);
            hD = get_ground_height_smooth(input.uv - vec2<f32>(0.0, texel.y), grid_size);
            hU = get_ground_height_smooth(input.uv + vec2<f32>(0.0, texel.y), grid_size);
        } else {
            let cx = i32(input.uv.x * uniforms.grid_size);
            let cy = i32(input.uv.y * uniforms.grid_size);
            hL = get_cell_ground_height(cx - 1, cy, grid_size);
            hR = get_cell_ground_height(cx + 1, cy, grid_size);
            hD = get_cell_ground_height(cx, cy - 1, grid_size);
            hU = get_cell_ground_height(cx, cy + 1, grid_size);
        }

        // The terrain spans 200 world units; the samples are two cells apart.
        let spacing = 200.0 / uniforms.grid_size;
        let normal = normalize(vec3<f32>(
            (hL - hR) * uniforms.height_scale,
            (hD - hU) * uniforms.height_scale,
            2.0 * spacing
        ));

        let diff = max(0.05, dot(normal, uniforms.sun_dir));

        let rock_base = vec3<f32>(0.32, 0.29, 0.27);
        let obsidian_base = vec3<f32>(0.08, 0.07, 0.08); // Dark cooling rock
        let active_rock_base = mix(rock_base, obsidian_base, clamp(input.temp * 1.5, 0.0, 1.0));
        let r_noise = noise2D(input.uv * 180.0) * 0.08;
        let rock_color = active_rock_base + vec3<f32>(r_noise);

        let sand_base = vec3<f32>(0.88, 0.72, 0.42);
        let s_noise = noise2D(input.uv * 200.0) * 0.04;
        let sand_color = sand_base + vec3<f32>(s_noise);

        let soil_noise = noise2D(input.uv * 155.0) * 0.06;
        let soil_base = vec3<f32>(0.36, 0.20, 0.10) + vec3<f32>(soil_noise);
        let wetness = smoothstep(0.0001, 0.02, input.water);
        let soil_color = soil_base * (1.0 - wetness * 0.3);
        var ground_color = rock_color;
        if (uniforms.show_soil > 0.5) {
            let soil_mask = select(1.0, smoothstep(0.0001, 0.03, input.soil), uniforms.show_rock > 0.5);
            ground_color = mix(ground_color, soil_color, soil_mask);
        }
        if (uniforms.show_sand > 0.5) {
            // Thin sand coats the upper face; steep eroded faces reveal the soil.
            let has_bed = uniforms.show_rock > 0.5 || (uniforms.show_soil > 0.5 && input.soil > 0.0001);
            let sand_mask = select(1.0, smoothstep(0.0001, 0.05, input.sand * normal.z), has_bed);
            ground_color = mix(ground_color, sand_color, sand_mask);
        }

        var terrain_lit = ground_color * (diff * uniforms.sun_color + vec3<f32>(0.12));
        
        // Add glowing red/orange emission for hot rock (only where sand is not covering it)
        let rock_glow = vec3<f32>(1.0, 0.25, 0.0) * input.temp * 0.8;
        terrain_lit += rock_glow * (1.0 - smoothstep(0.0001, 0.05, input.sand + input.soil));

        let ice_cover = smoothstep(0.00001, 0.004, input.snow_ice.y);
        let snow_cover = smoothstep(0.00001, 0.008, input.snow_ice.x);
        if (ice_cover > 0.0 && snow_cover < 1.0) {
            let ice_lit = shade_ice(input, normal, view_dir, terrain_lit, surface_footprint);
            terrain_lit = mix(terrain_lit, ice_lit, ice_cover);
        }
        if (snow_cover > 0.0) {
            let grain = noise2D(input.uv * 1200.0);
            let snow_base = mix(vec3<f32>(0.84, 0.91, 1.0), vec3<f32>(0.97, 0.99, 1.0), grain);
            let snow_specular = pow(max(0.0, dot(reflect(-uniforms.sun_dir, normal), view_dir)), 42.0) * 0.14;
            let snow_lit = snow_base * (diff * uniforms.sun_color * 0.78 + vec3<f32>(0.24)) + vec3<f32>(snow_specular);
            terrain_lit = mix(terrain_lit, snow_lit, snow_cover);
        }

        return vec4<f32>(terrain_lit, 1.0);

    } else {
        // --- FLUIDS SHADING ---
        let has_water = (input.water > 0.001 && uniforms.show_water > 0.5);
        let has_lava = (input.lava > 0.001 && uniforms.show_lava > 0.5);
        let sediment_load = input.suspended_sand + input.suspended_soil;
        let has_suspended = (sediment_load > 0.0 && uniforms.show_suspended > 0.5);
        let has_steam = (input.steam > 0.001);

        if (!has_water && !has_lava && !has_suspended && !has_steam) {
            discard;
        }

        var hL: f32; var hR: f32; var hD: f32; var hU: f32;
        if (uniforms.smooth_rendering > 0.5) {
            hL = get_total_height_smooth(input.uv - vec2<f32>(texel.x, 0.0), grid_size);
            hR = get_total_height_smooth(input.uv + vec2<f32>(texel.x, 0.0), grid_size);
            hD = get_total_height_smooth(input.uv - vec2<f32>(0.0, texel.y), grid_size);
            hU = get_total_height_smooth(input.uv + vec2<f32>(0.0, texel.y), grid_size);
        } else {
            let cx = i32(input.uv.x * uniforms.grid_size);
            let cy = i32(input.uv.y * uniforms.grid_size);
            hL = get_cell_total_height(cx - 1, cy, grid_size);
            hR = get_cell_total_height(cx + 1, cy, grid_size);
            hD = get_cell_total_height(cx, cy - 1, grid_size);
            hU = get_cell_total_height(cx, cy + 1, grid_size);
        }

        let spacing = 200.0 / uniforms.grid_size;
        let normal = normalize(vec3<f32>(
            (hL - hR) * uniforms.height_scale,
            (hD - hU) * uniforms.height_scale,
            2.0 * spacing
        ));

        let diff = max(0.05, dot(normal, uniforms.sun_dir));
        var finalColor = vec4<f32>(0.0);

        // 1. Lava Rendering
        let lava_mask = smoothstep(0.0001, 0.001, input.lava); // Sharper mask to prevent muddy mix
        if (has_lava && lava_mask > 0.0) {
            let shallow_lava_col = vec3<f32>(1.0, 0.38, 0.0);
            let deep_lava_col = vec3<f32>(0.55, 0.03, 0.0);
            
            let depth = input.lava * 15.0;
            let transmission = exp(-depth);
            
            // Animated crust and glowing cracks
            let noise_uv = input.uv * 80.0; // Restored to a higher detail scale, but with softer contrast
            let t = uniforms.time * 0.04;   // Slower motion for high viscosity
            let n1 = snoise(noise_uv + vec2<f32>(t, t * 0.5));
            let n2 = snoise(noise_uv * 2.0 - vec2<f32>(t * 1.2, -t * 0.8));
            let lava_noise = n1 * 0.65 + n2 * 0.35;
            
            // Cooled crust color (warm dark burgundy/brown instead of cold grey)
            let crust_color = vec3<f32>(0.16, 0.04, 0.03);
            
            // Crust is more prominent in deep, slow-moving pools
            let crust_factor = smoothstep(-0.2, 0.35, lava_noise) * (1.0 - transmission * 0.5);
            
            // Glowing cracks
            let crack_dist = abs(lava_noise - 0.05);
            let crack = smoothstep(0.07, 0.01, crack_dist);
            let crack_glow = vec3<f32>(1.0, 0.45, 0.0) * crack * 1.8;
            
            // Base lava color gradient
            let base_lava = mix(deep_lava_col, shallow_lava_col, transmission);
            
            // Combine crust, glowing base and bright cracks with lighter contrast (0.75 max crust)
            var lava_body_col = mix(base_lava, crust_color, crust_factor * 0.75);
            lava_body_col = lava_body_col + crack_glow * (1.0 - crust_factor * 0.65);

            // Specular reflections (from sun)
            let r_lava = reflect(-uniforms.sun_dir, normal);
            let spec_lava = pow(max(0.0, dot(r_lava, view_dir)), 80.0) * 0.8;

            // Fresnel and sky reflection
            // Lava is mostly emissive, so we do NOT mix out the core lava color completely.
            // Instead, we add a very subtle sky reflection on the edges and blend with specular.
            let fresnel = 0.02 + 0.98 * pow(1.0 - max(0.0, dot(normal, view_dir)), 5.0);
            let sky_refl = vec3<f32>(0.65, 0.8, 1.0) * (uniforms.sun_color + vec3<f32>(0.1)) * 0.05;
            
            // We blend the specular reflection and a very faint sky reflection onto the emissive body
            let lava_shaded = lava_body_col + (sky_refl + vec3<f32>(spec_lava)) * fresnel;
            
            let base_alpha = mix(1.0, 0.85, transmission);
            let lava_alpha = mix(base_alpha, 1.0, fresnel);

            finalColor = vec4<f32>(lava_shaded, lava_alpha * lava_mask);
        }

        // 2. Water & Suspended Sand Rendering
        if (has_water) {
            let water_mask = smoothstep(0.001, 0.005, input.water);
            if (water_mask > 0.0) {
                let flux = get_smooth_flux(input.uv, grid_size);
                let flowDir = vec2<f32>(flux.y - flux.x, flux.w - flux.z);
                let speed = length(flowDir);

                let r_water = reflect(-uniforms.sun_dir, normal);
                let spec_water = pow(max(0.0, dot(r_water, view_dir)), 80.0) * 0.8;

                let fresnel = 0.02 + 0.98 * pow(1.0 - max(0.0, dot(normal, view_dir)), 5.0);

                var shallow_water_col = vec3<f32>(0.0, 0.9, 0.8);
                var deep_water_col = vec3<f32>(0.0, 0.1, 0.45);
                
                let depth = input.water * 15.0;
                let transmission = exp(-depth);
                var water_body_col = mix(deep_water_col, shallow_water_col, transmission);

                if (has_suspended) {
                    let soil_fraction = input.suspended_soil / max(sediment_load, 0.00000001);
                    let mud_color = mix(vec3<f32>(0.65, 0.51, 0.30), vec3<f32>(0.32, 0.18, 0.08), soil_fraction);
                    let mud_factor = clamp(sediment_load * 250.0, 0.0, 1.0);
                    water_body_col = mix(water_body_col, mud_color, mud_factor);
                }

                let visual_speed = log(1.0 + speed * 50.0);
                let foam_mask = smoothstep(0.1, 1.5, visual_speed);
                
                let dir = normalize(flowDir + vec2<f32>(0.0001));
                let flow_time = uniforms.time * visual_speed * 1.5;
                let cycle1 = fract(flow_time);
                let cycle2 = fract(flow_time + 0.5);
                
                let weight1 = 1.0 - abs(cycle1 - 0.5) * 2.0;
                let weight2 = 1.0 - abs(cycle2 - 0.5) * 2.0;
                
                let uv1 = input.uv - dir * (cycle1 * 0.03);
                let uv2 = input.uv - dir * (cycle2 * 0.03);
                
                let n_scale = 1000.0;
                let streak1 = get_streak(uv1, dir, n_scale);
                let streak2 = get_streak(uv2, dir, n_scale);
                let streak = streak1 * weight1 + streak2 * weight2;
                
                let current_foam = foam_mask * smoothstep(0.55, 0.70, streak);
                water_body_col = mix(water_body_col, vec3<f32>(1.0), current_foam * 0.7);

                let sky_refl = vec3<f32>(0.65, 0.8, 1.0) * (uniforms.sun_color + vec3<f32>(0.1));
                let water_shaded = mix(water_body_col, sky_refl + vec3<f32>(spec_water), fresnel);
                
                let base_alpha = mix(0.85, 0.65, transmission);
                let water_alpha = mix(base_alpha, 1.0, fresnel);

                let waterColor = vec4<f32>(water_shaded, water_alpha * water_mask);
                
                if (has_lava) {
                    // Blend water OVER lava. Lava is physically under the water.
                    finalColor = vec4<f32>(mix(finalColor.rgb, waterColor.rgb, waterColor.a), max(finalColor.a, waterColor.a));
                } else {
                    finalColor = waterColor;
                }
            }
        } else if (has_suspended) {
            let density = input.suspended_sand;
            let alpha = clamp(density * 250.0, 0.0, 1.0);
            let mud_color = mix(vec3<f32>(0.3, 0.25, 0.2), vec3<f32>(0.65, 0.53, 0.35), clamp(density * 10.0, 0.0, 1.0));
            let mud_shaded = mud_color * (diff * uniforms.sun_color + vec3<f32>(0.15));
            let suspColor = vec4<f32>(mud_shaded, alpha * 0.85);
            
            if (has_lava) {
                // Suspended sand floats over lava
                finalColor = vec4<f32>(mix(finalColor.rgb, suspColor.rgb, suspColor.a), max(finalColor.a, suspColor.a));
            } else {
                finalColor = suspColor;
            }
        }

        // 3. Steam Rendering
        if (has_steam) {
            let steam_color = vec3<f32>(0.92, 0.92, 0.95);
            let noise_uv = input.uv * 120.0;
            let t = uniforms.time * 1.5;
            let n1 = snoise(noise_uv + vec2<f32>(t, -t * 0.5));
            let n2 = snoise(noise_uv * 2.0 - vec2<f32>(-t * 0.8, t * 1.2));
            let steam_noise = clamp(n1 * 0.6 + n2 * 0.4 + 0.3, 0.0, 1.0);
            let steam_alpha = clamp(input.steam * steam_noise * 1.5, 0.0, 1.0);
            
            finalColor = vec4<f32>(mix(finalColor.rgb, steam_color, steam_alpha), max(finalColor.a, steam_alpha));
        }

        // 4. Map border glowing indicator
        if (uniforms.border_behavior > 0.5 && uniforms.border_water_height > 0.0) {
            let b_dist = min(min(input.uv.x, 1.0 - input.uv.x), min(input.uv.y, 1.0 - input.uv.y));
            let border_width = 2.5 / uniforms.grid_size;
            if (b_dist < border_width) {
                var ground: f32;
                if (uniforms.smooth_rendering > 0.5) {
                    ground = get_ground_height_smooth(input.uv, grid_size);
                } else {
                    let cx = i32(input.uv.x * uniforms.grid_size);
                    let cy = i32(input.uv.y * uniforms.grid_size);
                    ground = get_cell_ground_height(cx, cy, grid_size);
                }
                if (uniforms.border_water_height > ground) {
                    let edge_factor = pow(1.0 - (b_dist / border_width), 1.5);
                    let pulse = 0.5 + 0.5 * sin(uniforms.time * 5.0);
                    let glow_color = vec3<f32>(0.0, 0.8, 1.0);
                    finalColor = vec4<f32>(mix(finalColor.rgb, glow_color, edge_factor * 0.8 * pulse), max(finalColor.a, edge_factor * 0.8));
                }
            }
        }

        return finalColor;
    }
}

// --- PICKING FRAGMENT SHADER ---
@fragment
fn fs_picking(input: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(input.uv.x, input.uv.y, 0.0, 1.0);
}
