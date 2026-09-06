struct AirCell {
    velocity_temperature: vec4<f32>,
    moisture: vec4<f32>,
};

struct AtmosphereRenderUniforms {
    inverse_mvp: mat4x4<f32>,
    mvp: mat4x4<f32>,
    camera_time: vec4<f32>,
    grid_height: vec4<f32>,
    view_slice_clouds_wind: vec4<f32>,
    camera_right: vec4<f32>,
    camera_up: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: AtmosphereRenderUniforms;
@group(0) @binding(1) var<storage, read> atmosphere: array<AirCell>;
@group(0) @binding(2) var scene_depth: texture_depth_2d;

fn air_at(cell: vec3<i32>) -> AirCell {
    let dims = vec3<i32>(uniforms.grid_height.xyz);
    let c = clamp(cell, vec3<i32>(0), dims - vec3<i32>(1));
    return atmosphere[u32(c.x + dims.x * (c.y + dims.y * c.z))];
}

fn mix_air(a: AirCell, b: AirCell, t: f32) -> AirCell {
    return AirCell(mix(a.velocity_temperature, b.velocity_temperature, t), mix(a.moisture, b.moisture, t));
}

// Storage buffers allow the exact same 3D simulation state to be used without
// a texture upload or GPU -> CPU transfer. All three axes are interpolated.
fn sample_air(p: vec3<f32>) -> AirCell {
    let uvw = (p + vec3<f32>(100.0, 100.0, 0.0)) / vec3<f32>(200.0, 200.0, uniforms.grid_height.w);
    let grid = uvw * uniforms.grid_height.xyz - vec3<f32>(0.5);
    let c = vec3<i32>(floor(grid));
    let f = fract(grid);
    let z0 = mix_air(
        mix_air(air_at(c), air_at(c + vec3<i32>(1, 0, 0)), f.x),
        mix_air(air_at(c + vec3<i32>(0, 1, 0)), air_at(c + vec3<i32>(1, 1, 0)), f.x), f.y);
    let z1 = mix_air(
        mix_air(air_at(c + vec3<i32>(0, 0, 1)), air_at(c + vec3<i32>(1, 0, 1)), f.x),
        mix_air(air_at(c + vec3<i32>(0, 1, 1)), air_at(c + vec3<i32>(1, 1, 1)), f.x), f.y);
    return mix_air(z0, z1, f.z);
}

fn hash3(p: vec3<f32>) -> f32 {
    let q = fract(p * vec3<f32>(0.1031, 0.1030, 0.0973));
    let r = q + dot(q, q.yxz + vec3<f32>(33.33));
    return fract((r.x + r.y) * r.z);
}

fn unproject(ndc: vec2<f32>, depth: f32) -> vec3<f32> {
    let h = uniforms.inverse_mvp * vec4<f32>(ndc, depth, 1.0);
    return h.xyz / h.w;
}

fn ray_box(origin: vec3<f32>, direction: vec3<f32>) -> vec2<f32> {
    // Preserve the sign for parallel rays while avoiding a division by zero.
    let safe = select(vec3<f32>(-1.0), vec3<f32>(1.0), direction >= vec3<f32>(0.0)) * max(abs(direction), vec3<f32>(0.000001));
    let a = (vec3<f32>(-100.0, -100.0, 0.0) - origin) / safe;
    let b = (vec3<f32>(100.0, 100.0, uniforms.grid_height.w) - origin) / safe;
    let lo = min(a, b);
    let hi = max(a, b);
    return vec2<f32>(max(max(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z));
}

struct VolumeVertex {
    @builtin(position) position: vec4<f32>,
};

@vertex
fn vs_volume(@builtin(vertex_index) vertex: u32) -> VolumeVertex {
    let p = vec2<f32>(f32((vertex << 1u) & 2u), f32(vertex & 2u));
    return VolumeVertex(vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0));
}

fn temperature_color(temperature: f32) -> vec3<f32> {
    let cold = mix(vec3<f32>(0.15, 0.20, 0.80), vec3<f32>(0.22, 0.85, 0.98), clamp((temperature + 30.0) / 30.0, 0.0, 1.0));
    let warm = mix(vec3<f32>(0.97, 0.90, 0.43), vec3<f32>(0.95, 0.18, 0.09), clamp(temperature / 35.0, 0.0, 1.0));
    return mix(cold, warm, smoothstep(-1.0, 1.0, temperature));
}

@fragment
fn fs_volume(input: VolumeVertex) -> @location(0) vec4<f32> {
    let size = vec2<f32>(textureDimensions(scene_depth));
    let ndc = vec2<f32>(input.position.x / size.x * 2.0 - 1.0, 1.0 - input.position.y / size.y * 2.0);
    let origin = uniforms.camera_time.xyz;
    let near = unproject(ndc, 0.0);
    let direction = normalize(unproject(ndc, 1.0) - origin);
    let box = ray_box(origin, direction);
    let depth = textureLoad(scene_depth, vec2<i32>(input.position.xy), 0);
    let surface_distance = length(unproject(ndc, depth) - origin);
    let start = max(max(box.x, 0.0), length(near - origin));
    let end = min(box.y, surface_distance);
    if (end <= start) { discard; }

    if (uniforms.view_slice_clouds_wind.x > 0.5) {
        // A real horizontal plane through the volume, intersected by each ray.
        if (abs(direction.z) < 0.00001) { discard; }
        let height = clamp(uniforms.view_slice_clouds_wind.y, 0.005, 0.995) * uniforms.grid_height.w;
        let t = (height - origin.z) / direction.z;
        if (t < start || t > end) { discard; }
        let p = origin + direction * t;
        let cell = sample_air(p);
        var color = temperature_color(cell.velocity_temperature.w);
        if (uniforms.view_slice_clouds_wind.x > 1.5 && uniforms.view_slice_clouds_wind.x < 2.5) {
            let temperature = clamp(cell.velocity_temperature.w, -60.0, 50.0);
            let saturation = clamp(0.008 * exp(0.065 * temperature), 0.0001, 0.1);
            let humidity = clamp(cell.moisture.x / max(saturation, 0.0001), 0.0, 1.5);
            color = mix(vec3<f32>(0.66, 0.36, 0.17), vec3<f32>(0.14, 0.77, 0.94), clamp(humidity, 0.0, 1.0));
            color = mix(color, vec3<f32>(0.90, 0.96, 1.0), clamp(cell.moisture.y * 180.0, 0.0, 0.85));
        } else if (uniforms.view_slice_clouds_wind.x > 2.5) {
            let speed = length(cell.velocity_temperature.xyz);
            color = mix(vec3<f32>(0.10, 0.29, 0.58), vec3<f32>(0.16, 0.95, 0.68), clamp(speed / 12.0, 0.0, 1.0));
            color = mix(color, vec3<f32>(1.0, 0.46, 0.13), clamp((speed - 12.0) / 20.0, 0.0, 1.0));
        }
        let edge = min(100.0 - abs(p.x), 100.0 - abs(p.y));
        let grid = abs(fract((p.xy + vec2<f32>(100.0)) / 20.0) - vec2<f32>(0.5));
        let line = smoothstep(0.47, 0.495, max(grid.x, grid.y));
        color = mix(color, vec3<f32>(0.85, 0.96, 1.0), max(line * 0.18, 1.0 - smoothstep(0.0, 0.8, edge)));
        return vec4<f32>(color * 0.77, 0.77);
    }

    if (uniforms.view_slice_clouds_wind.z < 0.5) { discard; }
    // Spatially stable jitter keeps the paused scene completely stationary.
    let step_length = max(1.6, (end - start) / 64.0);
    let jitter = hash3(vec3<f32>(floor(input.position.xy), 0.0));
    var t = start + step_length * (0.15 + jitter * 0.7);
    var color = vec3<f32>(0.0);
    var transmittance = 1.0;
    for (var step = 0u; step < 64u; step++) {
        if (t >= end || transmittance < 0.025) { break; }
        let p = origin + direction * t;
        let cell = sample_air(p);
        let density = max(0.0, cell.moisture.y - 0.000015) * 155.0;
        if (density > 0.0001) {
            let alpha = 1.0 - exp(-density * step_length * 0.22);
            // Height and condensate approximate ambient light penetration;
            // geometry and opacity come exclusively from the simulated volume.
            let light = 0.56 + 0.40 * clamp(p.z / uniforms.grid_height.w, 0.0, 1.0);
            let cloud_color = mix(vec3<f32>(0.45, 0.53, 0.64), vec3<f32>(1.0, 0.98, 0.94), light / (1.0 + density * 0.13));
            color += transmittance * alpha * cloud_color;
            transmittance *= 1.0 - alpha;
        }
        t += step_length;
    }
    return vec4<f32>(color, 1.0 - transmittance);
}

struct ParticleVertex {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color_alpha: vec4<f32>,
    @location(2) @interpolate(flat) kind: f32,
};

@vertex
fn vs_particle(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> ParticleVertex {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
        vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
    let corner = corners[vertex];
    let id = f32(instance);
    let seed = vec3<f32>(hash3(vec3<f32>(id, 3.1, 8.7)), hash3(vec3<f32>(id, 17.3, 2.5)), hash3(vec3<f32>(id, 6.7, 34.1)));
    let domain = vec3<f32>(200.0, 200.0, uniforms.grid_height.w);
    let offset = vec3<f32>(100.0, 100.0, 0.0);
    let source = sample_air(seed * domain - offset);
    let is_wind = instance >= 8192u;
    let frozen = source.velocity_temperature.w < 0.0;
    let fall_speed = select(12.0, 2.0, frozen);
    let source_velocity = source.velocity_temperature.xyz - vec3<f32>(0.0, 0.0, select(fall_speed, 0.0, is_wind));
    let p = fract(seed + source_velocity * uniforms.camera_time.w / domain) * domain - offset;
    let air = sample_air(p);
    let snow_fraction = air.moisture.w / max(air.moisture.z + air.moisture.w, 0.000001);
    var alpha = smoothstep(0.000015, 0.0008, air.moisture.z + air.moisture.w) * 0.78;
    var color = mix(vec3<f32>(0.49, 0.74, 0.95), vec3<f32>(0.97, 0.99, 1.0), snow_fraction);
    var half_width = mix(0.025, 0.14 + seed.x * 0.09, snow_fraction);
    var half_length = mix(0.65 + seed.y * 0.5, half_width, snow_fraction);
    var long_axis = normalize(air.velocity_temperature.xyz - vec3<f32>(0.0, 0.0, mix(12.0, 2.0, snow_fraction)) + vec3<f32>(0.00001));
    var kind = snow_fraction;
    if (is_wind) {
        alpha = clamp(length(air.velocity_temperature.xyz) / 4.0, 0.0, 0.48);
        color = mix(vec3<f32>(0.35, 0.90, 1.0), vec3<f32>(1.0, 0.80, 0.35), clamp(air.velocity_temperature.z * 0.15 + 0.5, 0.0, 1.0));
        half_width = 0.06;
        half_length = 1.3;
        long_axis = normalize(air.velocity_temperature.xyz + vec3<f32>(0.00001));
        kind = 2.0;
    } else if (uniforms.view_slice_clouds_wind.x > 0.5) {
        alpha = 0.0;
    }
    var side = cross(long_axis, normalize(uniforms.camera_time.xyz - p + vec3<f32>(0.00001)));
    side = normalize(side + uniforms.camera_right.xyz * 0.00001);
    var point = p + side * corner.x * half_width + long_axis * corner.y * half_length;
    if (!is_wind && snow_fraction > 0.7) {
        point = p + uniforms.camera_right.xyz * corner.x * half_width + uniforms.camera_up.xyz * corner.y * half_width;
    }
    return ParticleVertex(uniforms.mvp * vec4<f32>(point, 1.0), corner, vec4<f32>(color, alpha), kind);
}

@fragment
fn fs_particle(input: ParticleVertex) -> @location(0) vec4<f32> {
    let depth = textureLoad(scene_depth, vec2<i32>(input.position.xy), 0);
    if (input.position.z > depth + 0.000001 || input.color_alpha.a < 0.001) { discard; }
    var shape = (1.0 - smoothstep(0.3, 1.0, abs(input.uv.x))) * (1.0 - smoothstep(0.5, 1.0, abs(input.uv.y)));
    if (input.kind > 0.7 && input.kind < 1.5) {
        shape = 1.0 - smoothstep(0.15, 1.0, dot(input.uv, input.uv));
    }
    let alpha = input.color_alpha.a * shape;
    return vec4<f32>(input.color_alpha.rgb * alpha, alpha);
}
