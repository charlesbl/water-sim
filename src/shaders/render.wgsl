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
    padding: f32,
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
    padding_0: f32,
    padding_1: f32,
    padding_2: f32,
};

@group(0) @binding(0) var<uniform> uniforms : RenderUniforms;
@group(0) @binding(1) var<storage, read> terrain_in : array<TerrainCell>;
@group(0) @binding(2) var<storage, read> fluids_in : array<FluidCell>;
@group(0) @binding(3) var<storage, read> water_flux : array<FluxCell>;

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
};

// --- HEIGHT RETRIEVAL HELPERS ---
fn get_cell_ground_height(x: i32, y: i32, grid_size: i32) -> f32 {
    let cx = clamp(x, 0, grid_size - 1);
    let cy = clamp(y, 0, grid_size - 1);
    let idx = cy * grid_size + cx;
    return terrain_in[idx].rock + terrain_in[idx].sand;
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
    return terrain_in[idx].rock + terrain_in[idx].sand + fluids_in[idx].water + fluids_in[idx].lava;
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
    output.suspended_sand = cell_a.suspended_sand;
    output.water = cell_b.water;
    output.lava = cell_b.lava;

    var h = 0.0;
    if (uniforms.layer > 0.5) {
        if (uniforms.smooth_rendering > 0.5) {
            h = get_total_height_smooth(input.uv, grid_size);
        } else {
            h = cell_a.rock + cell_a.sand + cell_b.water + cell_b.lava;
        }
    } else {
        if (uniforms.smooth_rendering > 0.5) {
            h = get_ground_height_smooth(input.uv, grid_size);
        } else {
            h = cell_a.rock + cell_a.sand;
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

    if (uniforms.layer < 0.5) {
        // --- TERRAIN SHADING ---
        if (uniforms.show_rock < 0.5 && uniforms.show_sand < 0.5) {
            discard;
        }
        if (uniforms.show_rock < 0.5 && uniforms.show_sand > 0.5) {
            if (input.sand <= 0.001) {
                discard;
            }
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

        let spacing = 100.0 / uniforms.grid_size;
        let normal = normalize(vec3<f32>(
            (hL - hR) * uniforms.height_scale,
            (hD - hU) * uniforms.height_scale,
            2.0 * spacing
        ));

        let diff = max(0.05, dot(normal, uniforms.sun_dir));

        let rock_base = vec3<f32>(0.32, 0.29, 0.27);
        let r_noise = noise2D(input.uv * 180.0) * 0.08;
        let rock_color = rock_base + vec3<f32>(r_noise);

        let sand_base = vec3<f32>(0.88, 0.72, 0.42);
        let s_noise = noise2D(input.uv * 200.0) * 0.04;
        let sand_color = sand_base + vec3<f32>(s_noise);

        var ground_color = vec3<f32>(0.0);
        if (uniforms.show_rock > 0.5 && uniforms.show_sand > 0.5) {
            let sand_mask = smoothstep(0.0001, 0.05, input.sand);
            ground_color = mix(rock_color, sand_color, sand_mask);
        } else if (uniforms.show_rock > 0.5) {
            ground_color = rock_color;
        } else {
            ground_color = sand_color;
        }

        let terrain_lit = ground_color * (diff * uniforms.sun_color + vec3<f32>(0.12));
        return vec4<f32>(terrain_lit, 1.0);

    } else {
        // --- FLUIDS SHADING ---
        let has_water = (input.water > 0.001 && uniforms.show_water > 0.5);
        let has_lava = (input.lava > 0.001 && uniforms.show_lava > 0.5);
        let has_suspended = (input.suspended_sand > 0.0 && uniforms.show_suspended > 0.5);

        if (!has_water && !has_lava && !has_suspended) {
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

        let spacing = 100.0 / uniforms.grid_size;
        let normal = normalize(vec3<f32>(
            (hL - hR) * uniforms.height_scale,
            (hD - hU) * uniforms.height_scale,
            2.0 * spacing
        ));

        let diff = max(0.05, dot(normal, uniforms.sun_dir));
        var finalColor = vec4<f32>(0.0);

        // 1. Lava Rendering
        let lava_mask = smoothstep(0.001, 0.005, input.lava);
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
                    let mud_color = vec3<f32>(0.55, 0.43, 0.28);
                    let mud_factor = clamp(input.suspended_sand * 250.0, 0.0, 1.0);
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
                    finalColor = mix(waterColor, finalColor, lava_mask);
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
                finalColor = mix(suspColor, finalColor, lava_mask);
            } else {
                finalColor = suspColor;
            }
        }

        // 3. Map border glowing indicator
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
