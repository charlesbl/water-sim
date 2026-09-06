struct AtmosphereCell {
    // Velocity on the three positive faces; temperature at the cell center.
    velocityTemperature: vec4<f32>,
    // Water-equivalent volume fractions: vapor, cloud, rain, snow.
    moisture: vec4<f32>,
};

struct WeatherUniforms {
    grid: vec4<f32>,                 // nx, ny, nz, fine surface width
    spacingTime: vec4<f32>,          // dx, dy, dz, dt
    forcing: vec4<f32>,              // temperature, RH, wind x, wind y
    environment: vec4<f32>,          // solar, terrain height scale, time, domain height
    physics: vec4<f32>,              // lapse rate, rain fall speed, snow fall speed, emergent mode
    radiation: vec4<f32>,            // direction toward sun xyz, longwave cooling strength
    hydrology: vec4<f32>,            // closed water cycle, boundary (0 periodic/1 walls), evaporation rate, reserved
};

@group(0) @binding(0) var<uniform> u: WeatherUniforms;
@group(0) @binding(1) var<storage, read> volumeIn: array<AtmosphereCell>;
@group(0) @binding(2) var<storage, read_write> volumeOut: array<AtmosphereCell>;
// Highest surface elevation, mean temperature, mean evaporation, represented area ratio.
@group(0) @binding(3) var<storage, read_write> columns: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> terrain: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> fluids: array<vec4<f32>>;
// Snow SWE, ice SWE, temperature C, evaporated water awaiting available air.
@group(0) @binding(6) var<storage, read_write> surface: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read> pressureIn: array<f32>;
@group(0) @binding(8) var<storage, read_write> pressureOut: array<f32>;
@group(0) @binding(9) var<storage, read_write> divergenceField: array<f32>;
@group(0) @binding(10) var<storage, read_write> precipitation: array<vec2<f32>>;
@group(0) @binding(11) var<storage, read> depositionWeights: array<f32>;
@group(0) @binding(12) var<storage, read_write> layerMeans: array<vec4<f32>>;

fn wrap(p: vec3<i32>) -> vec3<i32> {
    let n = vec3<i32>(u.grid.xyz);
    if (u.hydrology.y > 0.5) { return clamp(p, vec3<i32>(0), n - vec3<i32>(1)); }
    return vec3<i32>(((p.xy % n.xy) + n.xy) % n.xy, clamp(p.z, 0, n.z - 1));
}

fn index(p: vec3<i32>) -> u32 {
    let q = wrap(p);
    let n = vec3<u32>(u.grid.xyz);
    return (u32(q.z) * n.y + u32(q.y)) * n.x + u32(q.x);
}

fn columnIndex(p: vec3<i32>) -> u32 {
    let q = wrap(p);
    return u32(q.y) * u32(u.grid.x) + u32(q.x);
}

fn inside(id: vec3<u32>) -> bool {
    return all(id < vec3<u32>(u.grid.xyz));
}

fn air(p: vec3<i32>) -> bool {
    if (p.z < 0 || p.z >= i32(u.grid.z)) { return false; }
    if (u.hydrology.y > 0.5 && (any(p.xy < vec2<i32>(0)) || any(p.xy >= vec2<i32>(u.grid.xy)))) { return false; }
    return (f32(p.z) + 0.5) * u.spacingTime.z > columns[columnIndex(p)].x;
}

fn ambientTemperature(height: f32) -> f32 {
    return u.forcing.x - u.physics.x * height;
}

fn saturation(temperature: f32) -> f32 {
    return clamp(0.008 * exp(0.065 * temperature), 0.0001, 0.1);
}

fn targetVapor(height: f32) -> f32 {
    return saturation(u.forcing.x) * max(u.forcing.y, 0.0) * exp(-height / 300.0);
}

fn emptyCell(height: f32) -> AtmosphereCell {
    return AtmosphereCell(vec4<f32>(0.0, 0.0, 0.0, ambientTemperature(height)), vec4<f32>(0.0));
}

fn constrainFaces(p: vec3<i32>, velocity: vec3<f32>) -> vec3<f32> {
    var v = velocity;
    if (!air(p + vec3<i32>(1, 0, 0))) { v.x = 0.0; }
    if (!air(p + vec3<i32>(0, 1, 0))) { v.y = 0.0; }
    if (!air(p + vec3<i32>(0, 0, 1))) { v.z = 0.0; }
    return v;
}

// Full trilinear interpolation in x/y/z. Solid samples are excluded and the
// weights renormalized, so terrain does not dilute humidity or temperature.
fn sampleAtmosphere(position: vec3<f32>) -> AtmosphereCell {
    var p = vec3<f32>(position.xy, clamp(position.z, 0.0, u.grid.z - 1.0));
    if (u.hydrology.y > 0.5) { p = clamp(p, vec3<f32>(0.0), u.grid.xyz - vec3<f32>(1.0)); }
    let base = vec3<i32>(floor(p));
    let fraction = fract(p);
    var velocityTemperature = vec4<f32>(0.0);
    var moisture = vec4<f32>(0.0);
    var total = 0.0;
    for (var z = 0; z < 2; z++) {
        for (var y = 0; y < 2; y++) {
            for (var x = 0; x < 2; x++) {
                let neighbor = base + vec3<i32>(x, y, z);
                let w = select(1.0 - fraction, fraction, vec3<bool>(x == 1, y == 1, z == 1));
                let weight = w.x * w.y * w.z;
                if (air(neighbor)) {
                    let cell = volumeIn[index(neighbor)];
                    velocityTemperature += cell.velocityTemperature * weight;
                    moisture += cell.moisture * weight;
                    total += weight;
                }
            }
        }
    }
    if (total < 0.00001) {
        return AtmosphereCell(vec4<f32>(vec3<f32>(0.0), volumeIn[index(base)].velocityTemperature.w), vec4<f32>(0.0));
    }
    return AtmosphereCell(velocityTemperature / total, max(moisture / total, vec4<f32>(0.0)));
}

fn faceVelocity(p: vec3<i32>) -> vec3<f32> {
    if (!air(p)) { return vec3<f32>(0.0); }
    return constrainFaces(p, volumeIn[index(p)].velocityTemperature.xyz);
}

// One common flux per face: both adjacent cells read the same donor value and
// limiter. Even a large combined 3-D Courant number cannot remove more water
// than the donor owns. All four phases are transported in actual water volume.
fn donorWater(p: vec3<i32>) -> vec4<f32> {
    let positive = faceVelocity(p);
    let negative = vec3<f32>(
        faceVelocity(p - vec3<i32>(1, 0, 0)).x,
        faceVelocity(p - vec3<i32>(0, 1, 0)).y,
        faceVelocity(p - vec3<i32>(0, 0, 1)).z);
    let outgoing = dot(max(positive, vec3<f32>(0.0)) + max(-negative, vec3<f32>(0.0)),
        vec3<f32>(u.spacingTime.w) / u.spacingTime.xyz);
    return volumeIn[index(p)].moisture / max(1.0, outgoing);
}

fn waterFlux(p: vec3<i32>, axis: u32) -> vec4<f32> {
    var offset = vec3<i32>(0);
    offset[axis] = 1;
    if (!air(p) || !air(p + offset)) { return vec4<f32>(0.0); }
    let speed = volumeIn[index(p)].velocityTemperature[axis];
    let donor = select(p + offset, p, speed >= 0.0);
    return donorWater(donor) * (speed * u.spacingTime.w / u.spacingTime[axis]);
}

fn transportWater(p: vec3<i32>) -> vec4<f32> {
    var water = volumeIn[index(p)].moisture;
    for (var axis = 0u; axis < 3u; axis++) {
        var offset = vec3<i32>(0);
        offset[axis] = 1;
        water += waterFlux(p - offset, axis) - waterFlux(p, axis);
    }
    // Only roundoff can cross zero; the face donor limiter guarantees positivity.
    return max(water, vec4<f32>(0.0));
}

@compute @workgroup_size(16, 16)
fn initializeSurface(@builtin(global_invocation_id) id: vec3<u32>) {
    let n = u32(u.grid.w);
    if (id.x >= n || id.y >= n) { return; }
    let i = id.y * n + id.x;
    let height = (terrain[i].x + terrain[i].y) * u.environment.y;
    surface[i] = vec4<f32>(0.0, 0.0, ambientTemperature(height), 0.0);
}

// Exact integer buckets match the fine-to-coarse lookup in surfaceExchange.
// Every fine surface cell is reduced once. No CPU readback and no float atomics.
@compute @workgroup_size(8, 8)
fn reduceColumns(@builtin(global_invocation_id) id: vec3<u32>) {
    let n = vec2<u32>(u.grid.xy);
    if (any(id.xy >= n)) { return; }
    let fine = u32(u.grid.w);
    let start = (id.xy * fine + n - vec2<u32>(1)) / n;
    let end = ((id.xy + vec2<u32>(1)) * fine + n - vec2<u32>(1)) / n;
    var totals = vec2<f32>(0.0);
    var highest = 0.0;
    var count = 0.0;
    for (var y = start.y; y < end.y; y++) {
        for (var x = start.x; x < end.x; x++) {
            let i = y * fine + x;
            let cover = surface[i];
            let height = max(0.0, terrain[i].x + terrain[i].y + max(fluids[i].x, 0.0) + max(fluids[i].y, 0.0) + cover.x * 5.0 + cover.y / 0.917) * u.environment.y;
            highest = max(highest, height);
            totals += vec2<f32>(cover.z, max(cover.w, 0.0));
            count += 1.0;
        }
    }
    // 2048 is not divisible by 48: columns contain 42 or 43 fine cells per
    // direction. Account for their exact physical area in both water transfers.
    let areaRatio = max(count * f32(n.x * n.y) / f32(fine * fine), 0.000001);
    columns[id.y * n.x + id.x] = vec4<f32>(highest, totals / max(count, 1.0), areaRatio);
}

@compute @workgroup_size(4, 4, 4)
fn initializeVolume(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!inside(id)) { return; }
    let p = vec3<i32>(id);
    let height = (f32(id.z) + 0.5) * u.spacingTime.z;
    var cell = emptyCell(height);
    if (air(p)) {
        let phase = vec3<f32>(id) / u.grid.xyz * 6.2831853;
        let perturbation = sin(phase.x * 2.0 + phase.z) * cos(phase.y * 3.0 - phase.z);
        cell.velocityTemperature = vec4<f32>(constrainFaces(p, vec3<f32>(u.forcing.zw, 0.0)), ambientTemperature(height) + perturbation * 0.6);
        cell.moisture.x = targetVapor(height) * (1.0 + perturbation * 0.15);
    }
    volumeOut[index(p)] = cell;
}

// Terrain, deep water or growing snow can engulf an existing air cell. Return
// its complete inventory to the surface before advect clears the solid cell.
// One invocation owns the whole column, including columns with no air left.
@compute @workgroup_size(8, 8)
fn captureObstructedWater(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy >= vec2<u32>(u.grid.xy))) { return; }
    var recovered = vec2<f32>(0.0);
    for (var z = 0; z < i32(u.grid.z); z++) {
        let p = vec3<i32>(vec2<i32>(id.xy), z);
        if (!air(p)) {
            let water = volumeIn[index(p)].moisture;
            recovered += vec2<f32>(water.x + water.y + water.z, water.w);
        }
    }
    precipitation[id.y * u32(u.grid.x) + id.x] = recovered * u.spacingTime.z / max(u.environment.y, 0.001);
}

var<workgroup> layerSum: array<vec4<f32>, 64>;

// Buoyancy references the actual horizontal atmosphere, not a user thermostat.
@compute @workgroup_size(64)
fn reduceLayers(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let n = vec2<u32>(u.grid.xy);
    var total = vec4<f32>(0.0);
    for (var cell = lane; cell < n.x * n.y; cell += 64u) {
        let p = vec3<i32>(i32(cell % n.x), i32(cell / n.x), i32(group.x));
        if (air(p)) {
            let value = volumeIn[index(p)];
            total += vec4<f32>(value.velocityTemperature.w, value.moisture.x, value.moisture.y, 1.0);
        }
    }
    layerSum[lane] = total;
    workgroupBarrier();
    for (var stride = 32u; stride > 0u; stride /= 2u) {
        if (lane < stride) { layerSum[lane] += layerSum[lane + stride]; }
        workgroupBarrier();
    }
    if (lane == 0u) { layerMeans[group.x] = layerSum[0] / max(layerSum[0].w, 1.0); }
}

@compute @workgroup_size(4, 4, 4)
fn advect(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!inside(id)) { return; }
    let p = vec3<i32>(id);
    let i = index(p);
    let height = (f32(id.z) + 0.5) * u.spacingTime.z;
    if (!air(p)) {
        volumeOut[i] = AtmosphereCell(vec4<f32>(vec3<f32>(0.0), volumeIn[i].velocityTemperature.w), vec4<f32>(0.0));
        return;
    }
    let dt = u.spacingTime.w;
    let previous = volumeIn[i];
    // Center the packed face velocities to trace the scalar characteristic.
    let centerVelocity = 0.5 * (previous.velocityTemperature.xyz + vec3<f32>(
        faceVelocity(p - vec3<i32>(1, 0, 0)).x,
        faceVelocity(p - vec3<i32>(0, 1, 0)).y,
        faceVelocity(p - vec3<i32>(0, 0, 1)).z));
    let departure = vec3<f32>(id) - centerVelocity * dt / u.spacingTime.xyz;
    var cell = sampleAtmosphere(departure);
    var velocity = cell.velocityTemperature.xyz;
    var temperature = cell.velocityTemperature.w;
    var water = transportWater(p);
    let column = columns[columnIndex(p)];
    let environmentTemperature = ambientTemperature(height);

    if (u.physics.w < 0.5) {
        // Optional imposed weather reservoir. Emergent mode bypasses all three
        // relaxations: sliders become initialization parameters only.
        temperature += (environmentTemperature - temperature) * min(dt * 0.16, 1.0);
        if (u.hydrology.x < 0.5) {
            water.x += (targetVapor(height) - water.x) * min(dt * 0.05, 1.0);
        }
        velocity += (vec3<f32>(u.forcing.zw, 0.0) - velocity) * dt * 0.22;
    } else {
        // Rising air cools; descending air warms. Small viscosity dissipates
        // momentum without imposing a preferred wind speed or direction.
        temperature -= centerVelocity.z * u.physics.x * dt;
        velocity *= exp(-dt * 0.015);
    }
    let nearGround = exp(-max(height - column.x, 0.0) / 12.0);
    temperature += (column.y - temperature) * nearGround * dt * 0.22;
    let reference = layerMeans[id.z];
    let buoyancy = (temperature - reference.x) * 0.35 + (water.x - reference.y) * 35.0 - water.y * 25.0;
    velocity.z += buoyancy * dt;
    if (!air(p - vec3<i32>(0, 0, 1))) {
        // The previous surface pass debited exactly this water from fluids.
        water.x += column.z * column.w * max(u.environment.y, 0.001) / u.spacingTime.z;
    }

    let saturated = saturation(temperature);
    let condensed = max(water.x - saturated, 0.0) * (1.0 - exp(-2.0 * dt));
    let evaporated = min(water.y, max(saturated - water.x, 0.0) * (1.0 - exp(-0.7 * dt)));
    water.x += evaporated - condensed;
    water.y += condensed - evaporated;
    temperature += (condensed - evaporated) * 180.0;
    let precipitationFormed = min(water.y, max(water.y - 0.0012, 0.0) * dt * 0.4);
    let snowFraction = 1.0 - smoothstep(-1.5, 1.5, temperature);
    water.y -= precipitationFormed;
    water.z += precipitationFormed * (1.0 - snowFraction);
    water.w += precipitationFormed * snowFraction;
    let frozen = water.z * min(max(-temperature, 0.0) * dt * 0.18, 1.0);
    let melted = water.w * min(max(temperature, 0.0) * dt * 0.18, 1.0);
    water.z += melted - frozen;
    water.w += frozen - melted;
    temperature += (frozen - melted) * 25.0;
    let rainEvaporated = min(water.z, max(saturation(temperature) - water.x, 0.0) * dt * 0.15);
    water.z -= rainEvaporated;
    water.x += rainEvaporated;
    temperature -= rainEvaporated * 180.0;

    cell.velocityTemperature = vec4<f32>(constrainFaces(p, clamp(velocity, vec3<f32>(-40.0), vec3<f32>(40.0))), clamp(temperature, -70.0, 65.0));
    cell.moisture = max(water, vec4<f32>(0.0));
    volumeOut[i] = cell;
}

@compute @workgroup_size(4, 4, 4)
fn divergence(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!inside(id)) { return; }
    let p = vec3<i32>(id);
    let i = index(p);
    pressureOut[i] = 0.0;
    if (!air(p)) { divergenceField[i] = 0.0; return; }
    let positive = faceVelocity(p);
    let negative = vec3<f32>(faceVelocity(p - vec3<i32>(1, 0, 0)).x, faceVelocity(p - vec3<i32>(0, 1, 0)).y, faceVelocity(p - vec3<i32>(0, 0, 1)).z);
    divergenceField[i] = dot(positive - negative, 1.0 / u.spacingTime.xyz);
}

@compute @workgroup_size(4, 4, 4)
fn pressure(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!inside(id)) { return; }
    let p = vec3<i32>(id);
    let i = index(p);
    if (!air(p)) { pressureOut[i] = 0.0; return; }
    var total = 0.0;
    var weights = 0.0;
    for (var axis = 0u; axis < 3u; axis++) {
        var offset = vec3<i32>(0);
        offset[axis] = 1;
        let weight = 1.0 / (u.spacingTime[axis] * u.spacingTime[axis]);
        if (air(p + offset)) { total += pressureIn[index(p + offset)] * weight; weights += weight; }
        if (air(p - offset)) { total += pressureIn[index(p - offset)] * weight; weights += weight; }
    }
    pressureOut[i] = (total - divergenceField[i]) / max(weights, 0.00001);
}

@compute @workgroup_size(4, 4, 4)
fn project(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!inside(id)) { return; }
    let p = vec3<i32>(id);
    let i = index(p);
    var cell = volumeIn[i];
    if (!air(p)) { cell.velocityTemperature = vec4<f32>(vec3<f32>(0.0), cell.velocityTemperature.w); volumeOut[i] = cell; return; }
    var velocity = cell.velocityTemperature.xyz;
    let center = pressureIn[i];
    for (var axis = 0u; axis < 3u; axis++) {
        var offset = vec3<i32>(0);
        offset[axis] = 1;
        if (air(p + offset)) { velocity[axis] -= (pressureIn[index(p + offset)] - center) / u.spacingTime[axis]; }
        else { velocity[axis] = 0.0; }
    }
    cell.velocityTemperature = vec4<f32>(velocity, cell.velocityTemperature.w);
    volumeOut[i] = cell;
}

// Conservative downward face fluxes for rain/snow, after 3-D wind advection.
@compute @workgroup_size(4, 4, 4)
fn sediment(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!inside(id)) { return; }
    let p = vec3<i32>(id);
    let i = index(p);
    var cell = volumeIn[i];
    if (!air(p)) { volumeOut[i] = cell; return; }
    let fraction = min(vec2<f32>(0.95), u.physics.yz * u.spacingTime.w / u.spacingTime.z);
    let outgoing = cell.moisture.zw * fraction;
    var incoming = vec2<f32>(0.0);
    if (air(p + vec3<i32>(0, 0, 1))) { incoming = volumeIn[index(p + vec3<i32>(0, 0, 1))].moisture.zw * fraction; }
    cell.moisture.z = max(0.0, cell.moisture.z + incoming.x - outgoing.x);
    cell.moisture.w = max(0.0, cell.moisture.w + incoming.y - outgoing.y);
    volumeOut[i] = cell;
    if (!air(p - vec3<i32>(0, 0, 1))) {
        precipitation[columnIndex(p)] += outgoing * u.spacingTime.z / max(u.environment.y, 0.001);
    }
}

// Continuous reconstruction across coarse column boundaries. The separate
// normalization accounts for each tent kernel's discrete footprint, so smoothing
// changes the distribution of precipitation, never the amount transferred.
fn surfaceWeather(xy: vec2<f32>, height: f32) -> vec4<f32> {
    let base = vec2<i32>(floor(xy));
    let f = fract(xy);
    var result = vec4<f32>(0.0); // local air temperature, vapor, rain, snow
    for (var y = 0; y < 2; y++) {
        for (var x = 0; x < 2; x++) {
            let p = vec3<i32>(base + vec2<i32>(x, y), 0);
            let ci = columnIndex(p);
            let column = columns[ci];
            let firstZ = max(0, i32(floor(column.x / u.spacingTime.z - 0.5)) + 1);
            let w = select(1.0 - f, f, vec2<bool>(x == 1, y == 1));
            let weight = w.x * w.y;
            if (firstZ < i32(u.grid.z)) {
                let cell = volumeIn[index(vec3<i32>(p.xy, firstZ))];
                let airHeight = (f32(firstZ) + 0.5) * u.spacingTime.z;
                result.x += (cell.velocityTemperature.w + u.physics.x * (airHeight - height)) * weight;
                result.y += cell.moisture.x * weight;
            } else {
                // A column entirely outside the air domain has no exchange.
                // Its existing surface temperature is supplied by the caller.
                result.x += columns[ci].y * weight;
            }
            result.z += precipitation[ci].x * depositionWeights[ci] * weight;
            result.w += precipitation[ci].y * depositionWeights[ci] * weight;
        }
    }
    return result;
}

fn terrainElevation(p: vec2<i32>) -> f32 {
    let n = i32(u.grid.w);
    let q = clamp(p, vec2<i32>(0), vec2<i32>(n - 1));
    let cell = terrain[u32(q.y * n + q.x)];
    return (cell.x + cell.y) * u.environment.y;
}

// Each invocation owns exactly one fine cell. No neighboring fluids are read
// or written, so the existing fluid buffer can safely be updated in place.
@compute @workgroup_size(16, 16)
fn surfaceExchange(@builtin(global_invocation_id) id: vec3<u32>) {
    let n = u32(u.grid.w);
    if (id.x >= n || id.y >= n) { return; }
    let i = id.y * n + id.x;
    let xy = vec2<i32>(id.xy * vec2<u32>(u.grid.xy) / n);
    let ci = u32(xy.y) * u32(u.grid.x) + u32(xy.x);
    let column = columns[ci];
    let firstAirZ = max(0, i32(floor(column.x / u.spacingTime.z - 0.5)) + 1);
    let availableAir = firstAirZ < i32(u.grid.z);
    let dt = u.spacingTime.w;
    var cover = surface[i];
    var liquid = fluids[i];
    let height = (terrain[i].x + terrain[i].y + max(liquid.x, 0.0) + max(liquid.y, 0.0) + cover.x * 5.0 + cover.y / 0.917) * u.environment.y;
    let sampleXY = (vec2<f32>(id.xy) + vec2<f32>(0.5)) * u.grid.xy / u.grid.w - vec2<f32>(0.5);
    let weather = surfaceWeather(sampleXY, height);
    let airTemperature = weather.x;
    let vapor = weather.y;
    let fallen = weather.zw;
    liquid.x = max(liquid.x, 0.0) + fallen.x;
    cover.x = max(cover.x, 0.0) + fallen.y;
    cover.y = max(cover.y, 0.0);
    // Snow albedo and liquid-water thermal inertia temper daytime heating.
    let albedo = mix(0.25, 0.82, clamp(cover.x * 300.0, 0.0, 1.0));
    let pos = vec2<i32>(id.xy);
    let normal = normalize(vec3<f32>(
        terrainElevation(pos - vec2<i32>(1, 0)) - terrainElevation(pos + vec2<i32>(1, 0)),
        terrainElevation(pos - vec2<i32>(0, 1)) - terrainElevation(pos + vec2<i32>(0, 1)), 400.0 / u.grid.w));
    let exposure = max(0.0, dot(normal, u.radiation.xyz));
    let absorbedSolar = u.environment.x * (1.0 - albedo) * exposure * 1.8;
    let kelvin = max(cover.z + 273.15, 150.0);
    let longwaveLoss = u.radiation.w * 0.25 * pow(kelvin / 288.15, 4.0);
    let sensibleHeat = (airTemperature - cover.z) * 0.22;
    let lavaHeat = min(max(liquid.y, 0.0) * 120.0, 70.0) * 0.35;
    let heatCapacity = 1.0 + liquid.x * 8.0 + cover.y * 5.0 + cover.x * 2.0;
    cover.z += (absorbedSolar - longwaveLoss + sensibleHeat + lavaHeat) * dt / heatCapacity;
    let snowMelt = min(cover.x, max(cover.z, 0.0) * dt * 0.00013);
    let iceMelt = min(cover.y, max(cover.z, 0.0) * dt * 0.000055);
    let frozenWater = min(liquid.x, max(-cover.z, 0.0) * dt * 0.00015);
    cover.x -= snowMelt;
    cover.y += frozenWater - iceMelt;
    liquid.x += snowMelt + iceMelt - frozenWater;
    cover.z += (frozenWater - snowMelt - iceMelt) * 80.0;
    let deficit = max(saturation(cover.z) - vapor, 0.0);
    // Only water actually present is evaporated; dry land cannot create vapor.
    var evaporation = 0.0;
    if (availableAir) { evaporation = min(max(liquid.x, 0.0), deficit * dt * max(u.hydrology.z, 0.0)); }
    liquid.x = max(liquid.x - evaporation, 0.0);
    cover.z = clamp(cover.z - evaporation * 450.0, -70.0, 90.0);
    if (availableAir) {
        // The old cover.w was injected by advect this step. Lava-generated
        // steam is also real water-equivalent volume and joins the next step.
        cover.w = evaporation + max(liquid.w, 0.0);
        liquid.w = 0.0;
    }
    surface[i] = cover;
    fluids[i] = liquid;
}
