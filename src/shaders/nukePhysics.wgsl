struct Terrain { rock: f32, sand: f32, suspended_sand: f32, avalanche: f32, soil: f32, suspended_soil: f32 };
struct Pulse { blast: vec4<f32>, region: vec4<f32>, clock: vec4<f32>, options: vec4<f32> };
@group(0) @binding(0) var<uniform> pulse: Pulse;
@group(0) @binding(1) var<storage, read_write> terrain: array<Terrain>;
@group(0) @binding(2) var<storage, read_write> fluids: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> surface: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> moved_terrain: array<Terrain>;
@group(0) @binding(5) var<storage, read_write> moved_fluids: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> moved_surface: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> water_flux: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read_write> lava_flux: array<vec4<f32>>;
@group(0) @binding(9) var<storage, read_write> origins: array<vec4<f32>>;

struct Flow { soil: vec4<f32>, water: vec4<f32> };
fn outgoing(p: vec2<i32>) -> Flow {
    let n = i32(pulse.region.w);
    if (any(p < vec2<i32>(0)) || any(p >= vec2<i32>(n))) { return Flow(vec4<f32>(0.0), vec4<f32>(0.0)); }
    let delta = (vec2<f32>(p) + 0.5) / f32(n) - pulse.blast.xy;
    let distance = length(delta);
    let radius = pulse.blast.z;
    let pressure = nukePressure(distance, radius, pulse.clock.x, 1.0 / f32(n));
    let direction = delta / max(abs(delta.x) + abs(delta.y), 0.25 / f32(n));
    var weights = max(vec4<f32>(-direction.x, direction.x, -direction.y, direction.y), vec4<f32>(0.0));
    if (p.x == 0) { weights.x = 0.0; }
    if (p.x == n - 1) { weights.y = 0.0; }
    if (p.y == 0) { weights.z = 0.0; }
    if (p.y == n - 1) { weights.w = 0.0; }
    let soil = min(0.65, 0.42 * pulse.blast.w) * pressure * NUKE_TRANSPORT_SCALE;
    // Water continues moving through the cleared wake, instead of falling straight
    // back into the center. The footprint still ends at the selected radius.
    let front = radius * nukeFront(pulse.clock.x);
    let wake = (1.0 - smoothstep(front * 0.85, front, distance))
        * (1.0 - smoothstep(radius * 0.93, radius, distance))
        * (1.0 - smoothstep(0.9, 1.0, nukeProgress(pulse.clock.x)));
    let water = min(0.92, 0.80 * pulse.blast.w) * max(pressure, wake) * NUKE_TRANSPORT_SCALE;
    // With the wave speed multiplier, per-tick exports still stay below the reservoir.
    return Flow(weights * soil, weights * water);
}

fn capacity(t: Terrain, f: vec4<f32>, s: vec4<f32>) -> f32 {
    return materialHeatCapacity(t.sand, t.soil, f.x, s.y, s.x);
}
struct Source { t: Terrain, f: vec4<f32>, s: vec4<f32>, energy: f32 };
fn source(p: vec2<i32>) -> Source {
    let n = i32(pulse.region.w); let index = u32(p.y * n + p.x);
    let t = terrain[index]; var f = fluids[index]; var s = surface[index];
    var energy = capacity(t, f, s) * s.z;
    let distance = length((vec2<f32>(p) + 0.5) / f32(n) - pulse.blast.xy);
    let melt_front = min(pulse.blast.z,
        pulse.blast.z * nukeFront(pulse.clock.x) + NUKE_MELT_LEAD_CELLS / f32(n));
    // The heat front leads the pressure by three cells, capped at the tool radius.
    // Ice turns instantly into the exact same water-equivalent amount of liquid.
    let melted = select(0.0, s.y, pulse.options.x > 0.5 && distance <= melt_front);
    // This is an external heat source: supply missing fusion energy if the ice is
    // too cold, without adding any water. Every neighbor sees this same source.
    if (melted > 0.0) { energy = max(energy, melted * 80.0); }
    f.x += melted;
    s.y -= melted;
    energy -= melted * 80.0;
    return Source(t, f, s, energy);
}

var<workgroup> height_bounds: array<vec2<f32>,256>;
@compute @workgroup_size(256)
fn capture_origin(@builtin(local_invocation_index) lane: u32) {
    let n = u32(pulse.region.w); let width = u32(pulse.region.z);
    var minimum = 1e10; var maximum = -1e10;
    for (var cell_index = lane; cell_index < width * width; cell_index += 256u) {
        let cell = vec2<u32>(pulse.region.xy) + vec2<u32>(cell_index % width, cell_index / width);
        if (any(cell >= vec2<u32>(n))) { continue; }
        let j = cell.y * n + cell.x; let t = terrain[j]; let f = fluids[j]; let s = surface[j];
        let height = (t.rock + t.sand + t.soil + f.x + f.y + s.x * 2.5 + s.y / 0.917) * pulse.clock.w;
        minimum = min(minimum,height); maximum = max(maximum,height);
    }
    height_bounds[lane] = vec2<f32>(minimum,maximum);
    for (var stride=128u; stride>0u; stride/=2u) {
        workgroupBarrier();
        if (lane < stride) { height_bounds[lane] = vec2<f32>(min(height_bounds[lane].x,height_bounds[lane+stride].x),max(height_bounds[lane].y,height_bounds[lane+stride].y)); }
    }
    workgroupBarrier();
    if (lane != 0u) { return; }
    let p = min(vec2<u32>(pulse.blast.xy * f32(n)), vec2<u32>(n - 1u));
    let i = p.y * n + p.x; let t = terrain[i]; let f = fluids[i]; let s = surface[i];
    let h = (t.rock + t.sand + t.soil + f.x + f.y + s.x * 2.5 + s.y / 0.917) * pulse.clock.w;
    origins[u32(pulse.clock.z) * 2u] = vec4<f32>(pulse.blast.xy * 200.0 - 100.0, h, pulse.blast.z * 200.0);
    origins[u32(pulse.clock.z) * 2u + 1u] = vec4<f32>(height_bounds[0],0.0,0.0);
}

@compute @workgroup_size(8, 8)
fn transport(@builtin(global_invocation_id) id: vec3<u32>) {
    let width = u32(pulse.region.z);
    if (id.x >= width || id.y >= width) { return; }
    let p = vec2<i32>(id.xy) + vec2<i32>(pulse.region.xy);
    let n = i32(pulse.region.w);
    if (any(p >= vec2<i32>(n))) { return; }
    let scratch = id.y * width + id.x;
    let flow = outgoing(p);
    let soil_out = dot(flow.soil, vec4<f32>(1.0));
    let water_out = dot(flow.water, vec4<f32>(1.0));
    let src = source(p);
    // Rock is copied exactly, never excavated. Sand is 25% more mobile than soil.
    var t = Terrain(src.t.rock, src.t.sand * (1.0 - soil_out * 1.25),
        src.t.suspended_sand * (1.0 - water_out), src.t.avalanche,
        src.t.soil * (1.0 - soil_out), src.t.suspended_soil * (1.0 - water_out));
    var f = src.f * vec4<f32>(1.0 - water_out, 1.0 - soil_out * 0.65, 1.0, 1.0 - water_out);
    var s = src.s;
    s.x *= 1.0 - soil_out * 1.25;
    var energy = src.energy * (1.0 - water_out);
    let offsets = array<vec2<i32>, 4>(vec2<i32>(-1,0), vec2<i32>(1,0), vec2<i32>(0,-1), vec2<i32>(0,1));
    let opposite = array<u32, 4>(1u,0u,3u,2u);
    for (var k=0u; k<4u; k++) {
        let neighbor = p + offsets[k];
        let neighbor_flow = outgoing(neighbor);
        let soil_in = neighbor_flow.soil[opposite[k]];
        let water_in = neighbor_flow.water[opposite[k]];
        if (soil_in <= 0.0 && water_in <= 0.0) { continue; }
        let donor = source(neighbor);
        t.sand += donor.t.sand * soil_in * 1.25;
        t.soil += donor.t.soil * soil_in;
        t.suspended_sand += donor.t.suspended_sand * water_in;
        t.suspended_soil += donor.t.suspended_soil * water_in;
        f += donor.f * vec4<f32>(water_in, soil_in * 0.65, 0.0, water_in);
        s.x += donor.s.x * soil_in * 1.25;
        energy += donor.energy * water_in;
    }
    if (soil_out > 0.001) { t.avalanche = 3.0; }
    s.z = energy / capacity(t,f,s);
    moved_terrain[scratch] = t;
    moved_fluids[scratch] = f;
    moved_surface[scratch] = s;
}

@compute @workgroup_size(8, 8)
fn commit(@builtin(global_invocation_id) id: vec3<u32>) {
    let width = u32(pulse.region.z);
    if (id.x >= width || id.y >= width) { return; }
    let p = vec2<u32>(id.xy) + vec2<u32>(pulse.region.xy);
    let n = u32(pulse.region.w);
    if (any(p >= vec2<u32>(n))) { return; }
    let index = p.y * n + p.x; let scratch = id.y * width + id.x;
    let f = moved_fluids[scratch];
    terrain[index] = moved_terrain[scratch]; fluids[index] = f; surface[index] = moved_surface[scratch];
    let push = outgoing(vec2<i32>(p));
    if (dot(push.water, vec4<f32>(1.0)) > 0.0) {
        var w = water_flux[index] + push.water * f.x * 0.5;
        var l = lava_flux[index] + push.soil * f.y * 0.2;
        w *= min(1.0, f.x / max(dot(w,vec4<f32>(1.0)),0.0000001));
        l *= min(1.0, f.y / max(dot(l,vec4<f32>(1.0)),0.0000001));
        water_flux[index] = w; lava_flux[index] = l;
    }
}
