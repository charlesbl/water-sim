struct Terrain { rock: f32, sand: f32, suspended_sand: f32, avalanche: f32, soil: f32, suspended_soil: f32 };
struct Blast { timing: vec4<f32>, detail: vec4<f32> };
struct Scene {
    mvp: mat4x4<f32>, inverse_mvp: mat4x4<f32>, camera: vec4<f32>, map: vec4<f32>, sun: vec4<f32>,
    right: vec4<f32>, up: vec4<f32>, blasts: array<Blast, 8>,
};
@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var<storage, read> origins: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> terrain: array<Terrain>;
@group(0) @binding(3) var<storage, read> fluids: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> surface: array<vec4<f32>>;
@group(0) @binding(5) var scene_depth: texture_depth_2d;

fn nukeHash(p: vec3<f32>) -> f32 {
    var q = fract(p * 0.1031);
    q = q + dot(q, q.yzx + vec3<f32>(33.33));
    return fract((q.x + q.y) * q.z);
}
fn nukeNoise(p: vec3<f32>) -> f32 {
    let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(nukeHash(i), nukeHash(i + vec3<f32>(1,0,0)), u.x),
        mix(nukeHash(i + vec3<f32>(0,1,0)), nukeHash(i + vec3<f32>(1,1,0)), u.x), u.y),
        mix(mix(nukeHash(i + vec3<f32>(0,0,1)), nukeHash(i + vec3<f32>(1,0,1)), u.x),
        mix(nukeHash(i + vec3<f32>(0,1,1)), nukeHash(i + vec3<f32>(1,1,1)), u.x), u.y), u.z);
}
fn cloudNoise(p: vec3<f32>) -> f32 {
    return nukeNoise(p) * 0.57 + nukeNoise(p * 2.03 + 17.3) * 0.29 + nukeNoise(p * 4.07 + 41.7) * 0.14;
}
fn groundCell(p: vec2<i32>) -> f32 {
    let n = i32(scene.map.x);
    let c = clamp(p, vec2<i32>(0), vec2<i32>(n - 1));
    let i = u32(c.y * n + c.x); let t = terrain[i]; let f = fluids[i]; let s = surface[i];
    return (t.rock + t.sand + t.soil + f.x + f.y + s.x * 2.5 + s.y / 0.917) * scene.map.y;
}
fn groundHeight(xy: vec2<f32>) -> f32 {
    let p = (xy + 100.0) / 200.0 * scene.map.x - 0.5;
    let c = vec2<i32>(floor(p)); let f = fract(p);
    return mix(mix(groundCell(c), groundCell(c + vec2<i32>(1,0)), f.x),
        mix(groundCell(c + vec2<i32>(0,1)), groundCell(c + vec2<i32>(1,1)), f.x), f.y);
}

// These densities are decorative. Excavated material stays in the simulation buffers.
// x: rolling ground dust, y: rising mushroom, z: incandescent core.
fn media(p: vec3<f32>, ground: f32, b: Blast) -> vec3<f32> {
    let t = b.timing.x / NUKE_TIME_SCALE;
    let wave_time = b.timing.x / NUKE_SHOCK_SECONDS * 1.25;
    let front = nukeFront(b.timing.x);
    let r = length(p.xy);
    let h = p.z - ground;
    let growth = 1.0 - exp(-t * 1.3);
    let seed = vec3<f32>(b.detail.x * 7.13, 0.0, 0.0);
    var dust = 0.0; var smoke = 0.0; var fire = 0.0;

    // Thick toroidal roll and a softer wake follow the actual displaced terrain.
    let roll_width = 0.025 + front * 0.073;
    let roll_height = 0.022 + front * 0.062;
    let radial = r - (front - roll_width * 0.32);
    let z = h - roll_height * 0.55;
    let section = vec2<f32>(radial / roll_width, z / roll_height);
    let roll_shape = length(section);
    let wake = exp(-pow((r - front * 0.82) / max(0.02, front * 0.14), 2.0))
        * exp(-pow((h - roll_height * 0.22) / (roll_height * 0.75), 2.0));
    if (h > -0.035 && r < 1.02 && (roll_shape < 1.65 || wake > 0.03)) {
        let angle = atan2(z, radial) - wave_time * 2.0;
        let roll_point = vec3<f32>(p.xy * 32.0, sin(angle) * 1.4 + cos(angle) * 0.7 + wave_time * 0.5);
        let detail = cloudNoise(roll_point + seed);
        let shape = 1.0 - smoothstep(0.35, 1.22, roll_shape + (detail - 0.5) * 0.8);
        let fade = smoothstep(0.0, 0.08, wave_time) * (1.0 - smoothstep(1.10, 2.05, wave_time));
        dust = (shape * 2.4 + wake * 0.58) * (0.55 + detail * 0.9) * fade
            * (1.0 - smoothstep(0.97, 1.02, r));
    }

    let cap_height = 0.09 + 0.55 * (1.0 - exp(-t * 0.65));
    let cap_radius = 0.085 + 0.31 * (1.0 - exp(-t * 0.85));
    let drift = vec2<f32>(0.009, 0.004) * t * t;
    let cap_p = vec3<f32>(p.xy - drift, (p.z - cap_height) * 1.7);
    let cap_distance = length(cap_p) / cap_radius;
    let stem_radius = 0.035 + 0.028 * growth + 0.025 * pow(clamp(p.z / max(cap_height, 0.01), 0.0, 1.0), 3.0);
    let stem_distance = length(p.xy - drift * clamp(p.z / max(cap_height, 0.01), 0.0, 1.0)) / stem_radius;
    if (cap_distance < 1.5 || (stem_distance < 1.6 && p.z > -0.02 && p.z < cap_height)) {
        let detail = cloudNoise(p * vec3<f32>(22.0, 22.0, 28.0) - vec3<f32>(0, 0, t * 1.6) + seed);
        let cap = 1.0 - smoothstep(0.58, 1.18, cap_distance + (detail - 0.5) * 0.7);
        let stem = (1.0 - smoothstep(0.45, 1.15, stem_distance + (detail - 0.5) * 0.7))
            * smoothstep(-0.02, 0.045, p.z) * (1.0 - smoothstep(cap_height * 0.8, cap_height, p.z));
        smoke = max(cap, stem * 0.75) * (0.7 + detail * 0.7) * 2.1
            * smoothstep(0.08, 0.5, t) * (1.0 - smoothstep(2.7, 4.5, t));
    }

    let fire_radius = 0.012 + 0.205 * (1.0 - exp(-t * 4.0));
    let fire_p = vec3<f32>(p.xy, (p.z - fire_radius * 0.75 - max(t - 0.3, 0.0) * 0.05) * 1.15);
    let fire_shape = length(fire_p) / fire_radius;
    if (fire_shape < 1.5 && t < 1.5) {
        let detail = cloudNoise(p * 35.0 - vec3<f32>(0.0, 0.0, t * 2.5) + seed);
        fire = (1.0 - smoothstep(0.42, 1.15, fire_shape + (detail - 0.5) * 0.8))
            * (1.0 - smoothstep(0.65, 1.5, t)) * 3.0;
    }
    return vec3<f32>(dust, smoke, fire);
}

struct VolumeVertex { @builtin(position) position: vec4<f32>, @location(0) @interpolate(flat) blast: u32 };
@vertex
fn vs_volume(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VolumeVertex {
    let positions = array<vec2<f32>,3>(vec2<f32>(-1,-1), vec2<f32>(3,-1), vec2<f32>(-1,3));
    return VolumeVertex(vec4<f32>(positions[vertex], 0, 1), instance);
}
fn unproject(ndc: vec2<f32>, depth: f32) -> vec3<f32> {
    let p = scene.inverse_mvp * vec4<f32>(ndc, depth, 1.0);
    return p.xyz / p.w;
}
@fragment
fn fs_volume(input: VolumeVertex) -> @location(0) vec4<f32> {
    let b = scene.blasts[input.blast];
    let anchor = origins[u32(b.timing.w) * 2u];
    let bounds = origins[u32(b.timing.w) * 2u + 1u];
    let radius = max(anchor.w, 0.0001);
    let pixels = vec2<f32>(textureDimensions(scene_depth));
    let ndc = vec2<f32>(input.position.x / pixels.x * 2.0 - 1.0, 1.0 - input.position.y / pixels.y * 2.0);
    let near = unproject(ndc, 0.0);
    let ray = normalize(unproject(ndc, 1.0) - scene.camera.xyz);
    let origin = (scene.camera.xyz - anchor.xyz) / radius;
    let safe_ray = select(vec3<f32>(0.000001), ray, abs(ray) > vec3<f32>(0.000001));
    let low = vec3<f32>(-1.04, -1.04, (bounds.x - anchor.z) / radius - 0.1);
    let high = vec3<f32>(1.04, 1.04, max(1.05, (bounds.y - anchor.z) / radius + 0.28));
    let a = (low - origin) / safe_ray; let z = (high - origin) / safe_ray;
    let entering = min(a, z); let leaving = max(a, z);
    let start = max(max(entering.x, max(entering.y, entering.z)), length(near - scene.camera.xyz) / radius);
    let box_end = min(leaving.x, min(leaving.y, leaving.z));
    if (box_end <= start) { discard; }
    let depth = textureLoad(scene_depth, vec2<i32>(input.position.xy), 0);
    let hit = unproject(ndc, depth);
    let end = min(box_end, length(hit - scene.camera.xyz) / radius);
    if (end <= start) { discard; }
    let step_size = (end - start) / 64.0;
    var distance = start + step_size * nukeHash(vec3<f32>(floor(input.position.xy), 9.7));
    var transmittance = 1.0; var radiance = vec3<f32>(0.0);
    let t = b.timing.x / NUKE_TIME_SCALE;
    let cold = b.timing.z;
    let front = nukeFront(b.timing.x);
    for (var step = 0u; step < 64u; step++) {
        if (distance >= end || transmittance < 0.015) { break; }
        let p = origin + ray * distance;
        let xy = anchor.xy + p.xy * radius;
        var ground = 0.0;
        if (abs(length(p.xy) - front) < 0.32) { ground = (groundHeight(xy) - anchor.z) / radius; }
        var density = media(p, ground, b);
        if (any(abs(xy) > vec2<f32>(100.0))) { density.x = 0.0; }
        let total = density.x + density.y + density.z;
        if (total > 0.005) {
            let lit = media(p + scene.sun.xyz * 0.045, ground, b);
            let occlusion = exp(-(lit.x + lit.y) * 0.8);
            let light = 0.26 + occlusion * 0.74;
            let dust_color = mix(vec3<f32>(0.30,0.235,0.17), vec3<f32>(0.86,0.80,0.68), light);
            let smoke_color = mix(vec3<f32>(0.115,0.13,0.15), vec3<f32>(0.63,0.63,0.61), light);
            let ember = exp(-length(p - vec3<f32>(0,0,0.12)) * 6.0) * exp(-t * 1.6);
            var scatter = (dust_color * density.x + (smoke_color + vec3<f32>(0.75,0.15,0.018) * ember) * density.y) / max(density.x + density.y, 0.001);
            scatter = mix(scatter, mix(vec3<f32>(0.28,0.44,0.58), vec3<f32>(0.84,0.95,1.0), light), cold);
            let temperature = clamp(density.z * 0.42 - t * 0.10, 0.0, 1.0);
            let flame = mix(vec3<f32>(1.5,0.12,0.008), vec3<f32>(4.0,3.6,2.8), pow(temperature, 1.4));
            let fire_color = mix(vec3<f32>(1.0) - exp(-flame), vec3<f32>(0.35,0.82,1.0) + temperature * 0.45, cold);
            scatter = mix(scatter, fire_color, density.z / max(total, 0.001));
            let alpha = 1.0 - exp(-total * step_size * 22.0);
            radiance += transmittance * alpha * scatter;
            transmittance *= 1.0 - alpha;
        }
        distance += step_size;
    }
    // Condensation and pressure glow follow the existing surface, without adding height.
    if (depth < 1.0 && all(abs(hit.xy) <= vec2<f32>(100.0))) {
        let r = length(hit.xy - anchor.xy) / radius;
        let edge = exp(-pow((r - front - 0.014) / 0.012, 2.0));
        let halo = exp(-pow((r - front) / 0.065, 2.0));
        let wave_time = b.timing.x / NUKE_SHOCK_SECONDS * 1.25;
        let alpha = (edge * 0.60 + halo * 0.08) * smoothstep(0.0,0.10,wave_time) * (1.0 - smoothstep(1.0,1.32,wave_time));
        radiance += transmittance * alpha * mix(vec3<f32>(0.93,0.91,0.82), vec3<f32>(0.66,0.91,1.0), cold);
        transmittance *= 1.0 - alpha;
    }
    let alpha = 1.0 - transmittance;
    return vec4<f32>(radiance / max(alpha, 0.0001), alpha);
}

struct Particle { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) color: vec4<f32> };
@vertex
fn vs_particle(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Particle {
    let corners = array<vec2<f32>,6>(vec2<f32>(-1,-1),vec2<f32>(1,-1),vec2<f32>(-1,1),vec2<f32>(-1,1),vec2<f32>(1,-1),vec2<f32>(1,1));
    let b = scene.blasts[instance / 128u]; let i = f32(instance % 128u);
    let seed = vec3<f32>(i, b.detail.x, 7.0);
    let a = nukeHash(seed); let c = nukeHash(seed + 9.7); let d = nukeHash(seed + 23.1);
    let anchor = origins[u32(b.timing.w) * 2u]; let radius = anchor.w;
    let t = max(0.0, b.timing.x / NUKE_TIME_SCALE - c * 0.09);
    let angle = a * 6.2831853;
    let direction = vec2<f32>(cos(angle),sin(angle));
    let speed = 0.35 + c * 0.45;
    let height = (0.5 + d * 0.5) * t - 0.85 * t * t;
    let pos = anchor.xyz + vec3<f32>(direction * speed * t, height) * radius;
    let velocity = vec3<f32>(direction * speed, 0.5 + d * 0.5 - 1.7 * t);
    let projected = vec2<f32>(dot(velocity,scene.right.xyz),dot(velocity,scene.up.xyz));
    let axis = projected / max(length(projected),0.0001);
    let up = scene.right.xyz * axis.x + scene.up.xyz * axis.y;
    let right = scene.right.xyz * axis.y - scene.up.xyz * axis.x;
    let uv = corners[vertex]; let scale = radius * (0.0012 + d * 0.002);
    let alpha = smoothstep(0.0,0.025,t) * (1.0 - smoothstep(0.55,1.2,t)) * smoothstep(-0.02,0.025,height);
    let color = mix(vec3<f32>(1.0,0.72,0.32),vec3<f32>(0.23,0.19,0.14),smoothstep(0.3,0.9,t));
    return Particle(scene.mvp * vec4<f32>(pos + right * uv.x * scale + up * uv.y * scale * 5.0,1),uv,
        vec4<f32>(mix(color,vec3<f32>(0.65,0.93,1.0),b.timing.z),alpha));
}
@fragment
fn fs_particle(input: Particle) -> @location(0) vec4<f32> {
    return vec4<f32>(input.color.rgb,input.color.a * (1.0 - smoothstep(0.1,1.0,length(input.uv))));
}
