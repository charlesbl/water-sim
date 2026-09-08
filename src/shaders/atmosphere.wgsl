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
    hydrology: vec4<f32>,            // closed water cycle, boundary (0 periodic/1 walls), evaporation rate, heating contrast
    convection: vec4<f32>,           // cap start/end height, upper lapse, buoyancy response
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
// Residual r, diagonal-preconditioned residual z, search direction p, A p.
@group(0) @binding(13) var<storage, read_write> cgState: array<vec4<f32>>;
@group(0) @binding(14) var<storage, read_write> cgPartials: array<vec2<f32>>;
@group(0) @binding(15) var<storage, read_write> cgCoefficients: vec4<f32>;
@group(0) @binding(16) var<storage, read_write> surfaceHeat: array<f32>;
@group(0) @binding(17) var<storage, read_write> solarPartials: array<vec2<f32>>;
// Entry 0: solar normalization and mean fluxes. Entries 1..nx*ny: mean surface
// IR emission, downwelling surface flux, escaping top flux, unused.
@group(0) @binding(18) var<storage, read_write> radiationBudget: array<vec4<f32>>;
// Air temperature intercept, vertical gradient, speed, inverse footprint capacity.
@group(0) @binding(19) var<storage, read_write> heatProfiles: array<vec4<f32>>;
// Signed surface-to-air energy for the four bilinear neighbors (00, 10, 01, 11).
@group(0) @binding(20) var<storage, read_write> heatTransfers: array<vec4<f32>>;
@group(0) @binding(22) var<storage, read_write> longwaveHeating: array<f32>;

const dryLapse: f32 = 0.16;

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
    // Integrate a smooth lapse transition: nearly neutral lower air, stable
    // upper air. This is an initial profile, never a thermostat in emergent mode.
    let depth = u.convection.y - u.convection.x;
    let t = clamp((height - u.convection.x) / depth, 0.0, 1.0);
    let capIntegral = depth * t * t * t * (1.0 - 0.5 * t) + max(height - u.convection.y, 0.0);
    return u.forcing.x - u.physics.x * height + (u.physics.x - u.convection.z) * capIntegral;
}

fn saturation(temperature: f32) -> f32 {
    return cloudSaturation(temperature);
}

fn targetVapor(height: f32) -> f32 {
    // The initialization slider describes relative humidity throughout the
    // column, instead of inadvertently starting cold upper layers saturated.
    return saturation(ambientTemperature(height)) * max(u.forcing.y, 0.0);
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
fn outgoingCourant(p: vec3<i32>) -> f32 {
    let positive = faceVelocity(p);
    let negative = vec3<f32>(
        faceVelocity(p - vec3<i32>(1, 0, 0)).x,
        faceVelocity(p - vec3<i32>(0, 1, 0)).y,
        faceVelocity(p - vec3<i32>(0, 0, 1)).z);
    return dot(max(positive, vec3<f32>(0.0)) + max(-negative, vec3<f32>(0.0)),
        vec3<f32>(u.spacingTime.w) / u.spacingTime.xyz);
}

fn limitedSlope(left: vec4<f32>, center: vec4<f32>, right: vec4<f32>) -> vec4<f32> {
    let before = center - left;
    let after = right - center;
    return select(vec4<f32>(0.0), sign(before) * min(abs(before), abs(after)), before * after > vec4<f32>(0.0));
}

fn waterFlux(p: vec3<i32>, axis: u32) -> vec4<f32> {
    var offset = vec3<i32>(0);
    offset[axis] = 1;
    if (!air(p) || !air(p + offset)) { return vec4<f32>(0.0); }
    let speed = volumeIn[index(p)].velocityTemperature[axis];
    let donor = select(p + offset, p, speed >= 0.0);
    let courant = outgoingCourant(donor);
    var value = volumeIn[index(donor)].moisture;
    if (courant <= 0.5 && air(donor - offset) && air(donor + offset)) {
        // MUSCL reconstruction preserves coherent humid plumes. Minmod bounds
        // each face by 1.5 times its donor. At combined CFL <= 0.5, the total
        // outgoing amount is therefore below 0.75 of the available inventory.
        let slope = limitedSlope(volumeIn[index(donor - offset)].moisture,
            value, volumeIn[index(donor + offset)].moisture);
        value += 0.5 * sign(speed) * (1.0 - courant) * slope;
    }
    // At high combined CFL fall back to positive, conservative donor transport.
    return value / max(1.0, courant) * (speed * u.spacingTime.w / u.spacingTime[axis]);
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

fn potentialTemperature(p: vec3<i32>) -> f32 {
    // A dry rising parcel preserves this quantity. The positive Kelvin offset
    // permits the same positivity-preserving large-CFL fallback as water.
    let height = (f32(p.z) + 0.5) * u.spacingTime.z;
    return volumeIn[index(p)].velocityTemperature.w + 273.15 + dryLapse * height;
}

fn heatFlux(p: vec3<i32>, axis: u32) -> f32 {
    var offset = vec3<i32>(0);
    offset[axis] = 1;
    if (!air(p) || !air(p + offset)) { return 0.0; }
    let speed = volumeIn[index(p)].velocityTemperature[axis];
    let donor = select(p + offset, p, speed >= 0.0);
    let courant = outgoingCourant(donor);
    var value = potentialTemperature(donor);
    if (courant <= 0.5 && air(donor - offset) && air(donor + offset)) {
        let before = value - potentialTemperature(donor - offset);
        let after = potentialTemperature(donor + offset) - value;
        if (before * after > 0.0) {
            value += 0.5 * sign(speed) * (1.0 - courant) * sign(before) * min(abs(before), abs(after));
        }
    }
    return value / max(1.0, courant) * (speed * u.spacingTime.w / u.spacingTime[axis]);
}

fn transportTemperature(p: vec3<i32>) -> f32 {
    var potential = potentialTemperature(p);
    for (var axis = 0u; axis < 3u; axis++) {
        var offset = vec3<i32>(0);
        offset[axis] = 1;
        potential += heatFlux(p - offset, axis) - heatFlux(p, axis);
    }
    return potential - 273.15 - dryLapse * (f32(p.z) + 0.5) * u.spacingTime.z;
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
    // 2048 is not divisible by 96: columns contain 21 or 22 fine cells per
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
        // Horizontal symmetry is broken by the actual surface, not seeded noise.
        cell.velocityTemperature = vec4<f32>(constrainFaces(p, vec3<f32>(u.forcing.zw, 0.0)), ambientTemperature(height));
        cell.moisture.x = targetVapor(height);
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
    var temperature = transportTemperature(p) + longwaveHeating[i];
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
        // Adiabatic cooling/warming is already encoded by potential temperature.
        velocity *= exp(-dt * 0.0015);
    }
    let groundDistance = max(height - column.x, 0.0);
    let nearGround = exp(-groundDistance / 5.0);
    // Surface drag dissipates the boundary layer; free air retains momentum.
    let drag = exp(-dt * nearGround * 0.09);
    velocity.x *= drag;
    velocity.y *= drag;
    if (!air(p - vec3<i32>(0, 0, 1))) {
        // The heat pass debits the surface and credits this cell in the same step.
        temperature += surfaceHeat[columnIndex(p)];
        // The previous surface pass debited exactly this water from fluids.
        water.x += column.z * column.w * max(u.environment.y, 0.001) / u.spacingTime.z;
    }

    // Saturation adjustment solves vapor/condensate/latent heat together. Heat
    // raises saturation during condensation, so raw supersaturation must not
    // all be removed at the old temperature. This is fast microphysics, while
    // droplet growth below controls the much longer lifetime of the cloud.
    let latentHeat = cloudLatentHeat;
    let phaseTransfer = cloudPhaseTransfer(temperature, water.x, water.y) * (1.0 - exp(-8.0 * dt));
    water.x -= phaseTransfer;
    water.y += phaseTransfer;
    temperature += phaseTransfer * latentHeat;
    // Small droplets travel with the air. Collision/coalescence accelerates
    // in dense clouds and around existing precipitation, over tens of seconds.
    let autoconversion = water.y * (1.0 - exp(-cloudConversionRate(water.y) * dt));
    let accretion = water.y * (1.0 - exp(-min((water.z + water.w) * 4.0, 0.08) * dt));
    let precipitationFormed = min(water.y, autoconversion + accretion);
    let snowFraction = 1.0 - smoothstep(-1.5, 1.5, temperature);
    water.y -= precipitationFormed;
    water.z += precipitationFormed * (1.0 - snowFraction);
    water.w += precipitationFormed * snowFraction;
    let frozen = water.z * min(max(-temperature, 0.0) * dt * 0.18, 1.0);
    let melted = water.w * min(max(temperature, 0.0) * dt * 0.18, 1.0);
    water.z += melted - frozen;
    water.w += frozen - melted;
    temperature += (frozen - melted) * 25.0;
    let rainEvaporated = max(0.0, -cloudPhaseTransfer(temperature, water.x, water.z)) * (1.0 - exp(-0.15 * dt));
    water.z -= rainEvaporated;
    water.x += rainEvaporated;
    temperature -= rainEvaporated * latentHeat;

    // React to this step's sensible AND latent heat. The scene-scale multiplier
    // changes acceleration, never the temperature or water inventory itself.
    let reference = layerMeans[id.z];
    let buoyancy = 9.81 * (temperature - reference.x) / max(reference.x + 273.15, 180.0)
        + (water.x - reference.y) * 6.0 - (water.y + water.z + water.w) * 9.81;
    velocity.z += buoyancy * u.convection.w * dt;

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
    if (!air(p)) { divergenceField[i] = 0.0; cgState[i] = vec4<f32>(0.0); return; }
    let positive = faceVelocity(p);
    let negative = vec3<f32>(faceVelocity(p - vec3<i32>(1, 0, 0)).x, faceVelocity(p - vec3<i32>(0, 1, 0)).y, faceVelocity(p - vec3<i32>(0, 0, 1)).z);
    divergenceField[i] = dot(positive - negative, 1.0 / u.spacingTime.xyz);
    let residual = -divergenceField[i];
    let preconditioned = residual / max(pressureDiagonal(p), 0.00001);
    cgState[i] = vec4<f32>(residual, preconditioned, preconditioned, 0.0);
}

fn pressureDiagonal(p: vec3<i32>) -> f32 {
    var weights = 0.0;
    for (var axis = 0u; axis < 3u; axis++) {
        var offset = vec3<i32>(0);
        offset[axis] = 1;
        let weight = 1.0 / (u.spacingTime[axis] * u.spacingTime[axis]);
        if (air(p + offset)) { weights += weight; }
        if (air(p - offset)) { weights += weight; }
    }
    return weights;
}

fn linearCoordinate(i: u32) -> vec3<i32> {
    let n = vec3<u32>(u.grid.xyz);
    return vec3<i32>(i32(i % n.x), i32((i / n.x) % n.y), i32(i / (n.x * n.y)));
}

var<workgroup> cgSum: array<vec2<f32>, 256>;

fn reducePressureDot(lane: u32) {
    workgroupBarrier();
    for (var stride = 128u; stride > 0u; stride /= 2u) {
        if (lane < stride) { cgSum[lane] += cgSum[lane + stride]; }
        workgroupBarrier();
    }
}

// A is the positive semi-definite negative Laplacian with the exact same face
// mask as divergence/project. Closed Neumann components retain arbitrary
// constant pressure, which has no effect on their velocity gradients.
@compute @workgroup_size(256)
fn cgApply(@builtin(global_invocation_id) id: vec3<u32>,
    @builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let i = id.x;
    var dotProducts = vec2<f32>(0.0);
    if (i < u32(u.grid.x * u.grid.y * u.grid.z)) {
        let p = linearCoordinate(i);
        if (air(p)) {
            let state = cgState[i];
            var product = 0.0;
            for (var axis = 0u; axis < 3u; axis++) {
                var offset = vec3<i32>(0);
                offset[axis] = 1;
                let weight = 1.0 / (u.spacingTime[axis] * u.spacingTime[axis]);
                if (air(p + offset)) { product += (state.z - cgState[index(p + offset)].z) * weight; }
                if (air(p - offset)) { product += (state.z - cgState[index(p - offset)].z) * weight; }
            }
            cgState[i].w = product;
            dotProducts = vec2<f32>(state.x * state.y, state.z * product);
        }
    }
    cgSum[lane] = dotProducts;
    reducePressureDot(lane);
    if (lane == 0u) { cgPartials[group.x] = cgSum[0]; }
}

@compute @workgroup_size(256)
fn cgReduceBefore(@builtin(local_invocation_index) lane: u32) {
    let count = (u32(u.grid.x * u.grid.y * u.grid.z) + 255u) / 256u;
    var total = vec2<f32>(0.0);
    for (var i = lane; i < count; i += 256u) { total += cgPartials[i]; }
    cgSum[lane] = total;
    reducePressureDot(lane);
    if (lane == 0u) {
        let sums = cgSum[0];
        var alpha = 0.0;
        if (sums.x > 1e-25 && sums.y > 1e-25) { alpha = sums.x / sums.y; }
        cgCoefficients = vec4<f32>(alpha, 0.0, sums.x, 0.0);
    }
}

@compute @workgroup_size(256)
fn cgUpdate(@builtin(global_invocation_id) id: vec3<u32>,
    @builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let i = id.x;
    var product = 0.0;
    if (i < u32(u.grid.x * u.grid.y * u.grid.z)) {
        let p = linearCoordinate(i);
        if (air(p)) {
            var state = cgState[i];
            pressureOut[i] += cgCoefficients.x * state.z;
            state.x -= cgCoefficients.x * state.w;
            state.y = state.x / max(pressureDiagonal(p), 0.00001);
            product = state.x * state.y;
            cgState[i] = state;
        }
    }
    cgSum[lane] = vec2<f32>(product, 0.0);
    reducePressureDot(lane);
    if (lane == 0u) { cgPartials[group.x] = cgSum[0]; }
}

@compute @workgroup_size(256)
fn cgReduceAfter(@builtin(local_invocation_index) lane: u32) {
    let count = (u32(u.grid.x * u.grid.y * u.grid.z) + 255u) / 256u;
    var total = vec2<f32>(0.0);
    for (var i = lane; i < count; i += 256u) { total += cgPartials[i]; }
    cgSum[lane] = total;
    reducePressureDot(lane);
    if (lane == 0u) {
        var beta = 0.0;
        if (cgCoefficients.z > 1e-25) { beta = cgSum[0].x / cgCoefficients.z; }
        cgCoefficients.y = beta;
    }
}

@compute @workgroup_size(256)
fn cgDirection(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= u32(u.grid.x * u.grid.y * u.grid.z)) { return; }
    let state = cgState[id.x];
    cgState[id.x].z = state.y + cgCoefficients.y * state.z;
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
                // Reconstruct the current profile, not the initialization
                // lapse. A fixed lapse warmed an isothermal surface/air pair
                // repeatedly even with every external energy source disabled.
                var temperatureGradient = 0.0;
                if (firstZ + 1 < i32(u.grid.z)) {
                    let above = volumeIn[index(vec3<i32>(p.xy, firstZ + 1))].velocityTemperature.w;
                    temperatureGradient = clamp((above - cell.velocityTemperature.w) / u.spacingTime.z, -0.4, 0.4);
                }
                result.x += (cell.velocityTemperature.w + temperatureGradient * (height - airHeight)) * weight;
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

fn surfaceHeatCapacity(i: u32, liquid: f32, ice: f32, snow: f32) -> f32 {
    return materialHeatCapacity(terrain[i].y, liquid, ice, snow);
}

// Return raw absorption and its contrast weight. The score is the local warming
// tendency (absorption / capacity), so high-absorptivity deep water does not
// automatically take energy away from the more responsive dry land.
fn solarWeights(pos: vec2<i32>) -> vec2<f32> {
    let i = u32(pos.y) * u32(u.grid.w) + u32(pos.x);
    let cover = surface[i];
    let liquid = max(fluids[i].x, 0.0);
    let albedo = materialAlbedo(terrain[i].y, liquid, cover.y, cover.x);
    let normal = normalize(vec3<f32>(
        terrainElevation(pos - vec2<i32>(1, 0)) - terrainElevation(pos + vec2<i32>(1, 0)),
        terrainElevation(pos - vec2<i32>(0, 1)) - terrainElevation(pos + vec2<i32>(0, 1)), 400.0 / u.grid.w));
    let exposure = max(0.0, dot(normal, u.radiation.xyz));
    let absorbed = (1.0 - albedo) * exposure * 0.65;
    let response = clamp((1.0 - albedo) * exposure / surfaceHeatCapacity(i, liquid, cover.y, cover.x), 0.0, 1.0);
    // Positive, bounded sharpening. No artificial heating of unlit cells and no
    // unstable powers near sunset; normalization below restores the raw budget.
    let shaped = absorbed * exp((u.hydrology.w - 1.0) * (response - 1.0));
    return vec2<f32>(absorbed, shaped);
}

var<workgroup> solarSum: array<vec2<f32>, 256>;

fn sumSolar(lane: u32) {
    workgroupBarrier();
    for (var stride = 128u; stride > 0u; stride /= 2u) {
        if (lane < stride) { solarSum[lane] += solarSum[lane + stride]; }
        workgroupBarrier();
    }
}

@compute @workgroup_size(16, 16)
fn prepareSolar(@builtin(global_invocation_id) id: vec3<u32>,
    @builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    var value = vec2<f32>(0.0);
    if (all(id.xy < vec2<u32>(u32(u.grid.w)))) { value = solarWeights(vec2<i32>(id.xy)); }
    solarSum[lane] = value;
    sumSolar(lane);
    if (lane == 0u) { solarPartials[group.y * ((u32(u.grid.w) + 15u) / 16u) + group.x] = solarSum[0]; }
}

@compute @workgroup_size(256)
fn normalizeSolar(@builtin(local_invocation_index) lane: u32) {
    let groups = (u32(u.grid.w) + 15u) / 16u;
    var total = vec2<f32>(0.0);
    for (var i = lane; i < groups * groups; i += 256u) { total += solarPartials[i]; }
    solarSum[lane] = total;
    sumSolar(lane);
    if (lane == 0u) {
        let sums = solarSum[0];
        radiationBudget[0] = vec4<f32>(sums.x / max(sums.y, 1e-20), sums / (u.grid.w * u.grid.w), 0.0);
    }
}

// Cache the air properties once per column, before any surface temperature changes.
// The tent footprint replaces integer buckets for heat exchange. Its quadrature
// weight gives the air capacity per represented surface area, even at walls or
// on non-divisible grids. A zero inverse capacity denotes an unavailable column.
@compute @workgroup_size(8, 8)
fn prepareHeat(@builtin(global_invocation_id) id: vec3<u32>) {
    let n = vec2<u32>(u.grid.xy);
    if (any(id.xy >= n)) { return; }
    let ci = id.y * n.x + id.x;
    heatProfiles[ci] = vec4<f32>(0.0);
    let column = columns[ci];
    let firstZ = max(0, i32(floor(column.x / u.spacingTime.z - 0.5)) + 1);
    if (firstZ >= i32(u.grid.z)) { return; }
    let p = vec3<i32>(vec2<i32>(id.xy), firstZ);
    let cell = volumeIn[index(p)];
    let airHeight = (f32(firstZ) + 0.5) * u.spacingTime.z;
    var gradient = 0.0;
    if (firstZ + 1 < i32(u.grid.z)) {
        gradient = clamp((volumeIn[index(p + vec3<i32>(0, 0, 1))].velocityTemperature.w
            - cell.velocityTemperature.w) / u.spacingTime.z, -0.4, 0.4);
    }
    let airCapacity = u.spacingTime.z * depositionWeights[ci] / max(u.environment.y, 0.001);
    let speed = length(0.5 * (faceVelocity(p) + vec3<f32>(
        faceVelocity(p - vec3<i32>(1, 0, 0)).x,
        faceVelocity(p - vec3<i32>(0, 1, 0)).y,
        faceVelocity(p - vec3<i32>(0, 0, 1)).z)));
    heatProfiles[ci] = vec4<f32>(cell.velocityTemperature.w - gradient * airHeight,
        gradient, speed, 1.0 / airCapacity);
}

// Each fine cell exchanges with four air columns. Weight pairwise relaxation,
// rather than the timestep, so both surface and air updates remain bounded by
// their capacities when all neighbors contribute. Store the exact signed debits
// for the subsequent gather: no float atomics or concurrent surface writes.
@compute @workgroup_size(16, 16)
fn exchangeHeat(@builtin(global_invocation_id) id: vec3<u32>) {
    let fine = u32(u.grid.w);
    if (any(id.xy >= vec2<u32>(fine))) { return; }
    let i = id.y * fine + id.x;
    let cover = surface[i];
    let liquid = max(fluids[i].x, 0.0);
    let height = max(0.0, terrain[i].x + terrain[i].y + liquid + max(fluids[i].y, 0.0)
        + cover.x * 5.0 + cover.y / 0.917) * u.environment.y;
    let capacity = surfaceHeatCapacity(i, liquid, cover.y, cover.x);
    let insulation = 1.0 + cover.x * 5.0 * u.environment.y * 5.0;
    let xy = (vec2<f32>(id.xy) + 0.5) * u.grid.xy / u.grid.w - 0.5;
    let base = vec2<i32>(floor(xy));
    let f = fract(xy);
    var transfers = vec4<f32>(0.0);
    for (var y = 0; y < 2; y++) {
        for (var x = 0; x < 2; x++) {
            let profile = heatProfiles[columnIndex(vec3<i32>(base + vec2<i32>(x, y), 0))];
            if (profile.w <= 0.0) { continue; }
            let weight = select(1.0 - f, f, vec2<bool>(x == 1, y == 1));
            let difference = cover.z - (profile.x + profile.y * height);
            let mixing = 1.0 + min(2.0, profile.z * 0.12 + sqrt(max(difference, 0.0)) * 0.15);
            let conductance = 0.45 * mixing / insulation;
            let inverseCapacity = 1.0 / capacity + profile.w;
            transfers[y * 2 + x] = weight.x * weight.y * difference
                * (1.0 - exp(-conductance * inverseCapacity * u.spacingTime.w)) / inverseCapacity;
        }
    }
    heatTransfers[i] = transfers;
    surface[i].z = cover.z - dot(transfers, vec4<f32>(1.0)) / capacity;
}

fn longwaveEmission(temperature: f32) -> f32 {
    let kelvin = max(temperature + 273.15, 150.0);
    return u.radiation.w * 0.25 * pow(kelvin / 288.15, 4.0);
}

var<workgroup> gatheredHeat: array<vec2<f32>, 64>;

// One workgroup gathers a column's overlapping tent footprint. Read each stored
// debit exactly once for its recipient, including both clamped neighbors at a
// wall and wrapped neighbors at periodic edges. Convert fine-cell surface energy
// to the receiving air cell's temperature using physical areas, not bucket sizes.
@compute @workgroup_size(64)
fn gatherHeat(@builtin(workgroup_id) id: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let n = vec2<u32>(u.grid.xy);
    if (any(id.xy >= n)) { return; }
    let fine = i32(u.grid.w);
    let ci = id.y * n.x + id.x;
    var start = vec2<i32>(ceil((vec2<f32>(id.xy) - 0.5) * u.grid.w / u.grid.xy - 0.5));
    var end = vec2<i32>(ceil((vec2<f32>(id.xy) + 1.5) * u.grid.w / u.grid.xy - 0.5));
    if (u.hydrology.y > 0.5) {
        start = max(start, vec2<i32>(0));
        end = min(end, vec2<i32>(fine));
    }
    let extent = end - start;
    var heat = vec2<f32>(0.0);
    for (var k = i32(lane); k < extent.x * extent.y; k += 64) {
        let unfolded = start + vec2<i32>(k % extent.x, k / extent.x);
        let q = ((unfolded % vec2<i32>(fine)) + vec2<i32>(fine)) % vec2<i32>(fine);
        let xy = (vec2<f32>(q) + 0.5) * u.grid.xy / u.grid.w - 0.5;
        let base = vec2<i32>(floor(xy));
        let transfers = heatTransfers[q.y * fine + q.x];
        let emission = longwaveEmission(surface[q.y * fine + q.x].z);
        let f = fract(xy);
        for (var y = 0; y < 2; y++) {
            for (var x = 0; x < 2; x++) {
                if (columnIndex(vec3<i32>(base + vec2<i32>(x, y), 0)) == ci) {
                    let weight = select(1.0 - f, f, vec2<bool>(x == 1, y == 1));
                    heat += vec2<f32>(transfers[y * 2 + x], emission * weight.x * weight.y);
                }
            }
        }
    }
    gatheredHeat[lane] = heat;
    workgroupBarrier();
    for (var stride = 32u; stride > 0u; stride /= 2u) {
        if (lane < stride) { gatheredHeat[lane] += gatheredHeat[lane + stride]; }
        workgroupBarrier();
    }
    if (lane == 0u) {
        let areaRatio = u.grid.x * u.grid.y / (u.grid.w * u.grid.w);
        surfaceHeat[ci] = gatheredHeat[0].x * areaRatio
            * max(u.environment.y, 0.001) / u.spacingTime.z;
        radiationBudget[ci + 1u] = vec4<f32>(gatheredHeat[0].y * areaRatio * depositionWeights[ci], 0.0, 0.0, 0.0);
    }
}

fn airEmissivity(cell: AtmosphereCell) -> f32 {
    // Gray-gas optical depth at the illustrative domain scale. Even dry air
    // radiates; vapor and condensed water increase absorption and emission.
    let opacity = 1.2 + 50.0 * min(cell.moisture.x, 0.06)
        + 250.0 * min(cell.moisture.y + cell.moisture.z + cell.moisture.w, 0.03);
    return 1.0 - exp(-opacity * u.spacingTime.z / u.environment.w);
}

// Two-stream infrared transfer, independent of air motion and solar input.
// The mechanical lid is transparent to radiation: no incoming IR from space.
// Each layer absorbs incoming flux and emits in both directions. Flux differences
// telescope, so surface + air lose exactly the energy escaping at the top.
@compute @workgroup_size(8, 8)
fn radiateColumns(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy >= vec2<u32>(u.grid.xy))) { return; }
    let ci = id.y * u32(u.grid.x) + id.x;
    let capacity = u.spacingTime.z * depositionWeights[ci] / max(u.environment.y, 0.001);
    let toTemperature = u.spacingTime.w / capacity;
    var downward = 0.0;
    for (var z = i32(u.grid.z) - 1; z >= 0; z--) {
        let p = vec3<i32>(vec2<i32>(id.xy), z);
        let i = index(p);
        longwaveHeating[i] = 0.0;
        if (!air(p) || u.radiation.w <= 0.0) { continue; }
        let cell = volumeIn[i];
        let absorbed = airEmissivity(cell) * (downward - longwaveEmission(cell.velocityTemperature.w));
        downward -= absorbed;
        longwaveHeating[i] = absorbed * toTemperature;
    }
    radiationBudget[ci + 1u].y = downward;
    var upward = radiationBudget[ci + 1u].x;
    for (var z = 0; z < i32(u.grid.z); z++) {
        let p = vec3<i32>(vec2<i32>(id.xy), z);
        if (!air(p) || u.radiation.w <= 0.0) { continue; }
        let i = index(p);
        let cell = volumeIn[i];
        let absorbed = airEmissivity(cell) * (upward - longwaveEmission(cell.velocityTemperature.w));
        upward -= absorbed;
        longwaveHeating[i] += absorbed * toTemperature;
    }
    radiationBudget[ci + 1u].z = upward;
}

fn surfaceDownwardLongwave(xy: vec2<f32>) -> f32 {
    let base = vec2<i32>(floor(xy));
    let f = fract(xy);
    var flux = 0.0;
    for (var y = 0; y < 2; y++) {
        for (var x = 0; x < 2; x++) {
            let weight = select(1.0 - f, f, vec2<bool>(x == 1, y == 1));
            flux += weight.x * weight.y * radiationBudget[columnIndex(vec3<i32>(base + vec2<i32>(x, y), 0)) + 1u].y;
        }
    }
    return flux;
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
    // Use the same material state as prepareSolar, before precipitation and
    // phase changes alter its cover. No CPU readback or additional solar source.
    let absorbedSolar = u.environment.x * solarWeights(vec2<i32>(id.xy)).y * radiationBudget[0].x;
    var cover = surface[i];
    var liquid = fluids[i];
    let height = (terrain[i].x + terrain[i].y + max(liquid.x, 0.0) + max(liquid.y, 0.0) + cover.x * 5.0 + cover.y / 0.917) * u.environment.y;
    let sampleXY = (vec2<f32>(id.xy) + vec2<f32>(0.5)) * u.grid.xy / u.grid.w - vec2<f32>(0.5);
    // Use the same pre-phase surface emission gathered for the air budget.
    let netLongwave = surfaceDownwardLongwave(sampleXY) - longwaveEmission(cover.z);
    let weather = surfaceWeather(sampleXY, height);
    let airTemperature = weather.x;
    let vapor = weather.y;
    let fallen = weather.zw;
    liquid.x = max(liquid.x, 0.0);
    cover.x = max(cover.x, 0.0);
    cover.y = max(cover.y, 0.0);
    let latentFusion = 80.0;
    var energy = cover.z * surfaceHeatCapacity(i, liquid.x, cover.y, cover.x);
    liquid.x += fallen.x;
    cover.x += fallen.y;
    energy += fallen.x * 8.0 * airTemperature + fallen.y * 2.0 * min(airTemperature, 0.0);
    // The water model has one liquid reservoir above a fixed bed of ice.
    // Snow meeting this water melts into that reservoir, removing latent heat.
    // It never becomes a floating solid lid; sufficiently cold water can then
    // freeze progressively into the bed below it.
    if (liquid.x > 0.0 && cover.x > 0.0) {
        energy -= cover.x * latentFusion;
        liquid.x += cover.x;
        cover.x = 0.0;
    }
    cover.z = energy / surfaceHeatCapacity(i, liquid.x, cover.y, cover.x);
    // Sensible heat was exchanged conservatively before atmospheric transport.
    let lavaHeat = min(max(liquid.y, 0.0) * 120.0, 70.0) * 0.35;
    energy += (absorbedSolar + netLongwave + lavaHeat) * dt;
    // Continuous heat-limited phase transfer: consume only the sensible energy
    // available relative to 0 C, and approach equilibrium over several seconds.
    // Recompute capacity after transfer; latent heat cannot overshoot 0 C.
    if (energy < 0.0) {
        let frozenWater = min(liquid.x, -energy / latentFusion * (1.0 - exp(-0.18 * dt)));
        liquid.x -= frozenWater;
        cover.y += frozenWater;
        energy += frozenWater * latentFusion;
    } else {
        let meltBudget = energy / latentFusion * (1.0 - exp(-0.25 * dt));
        let snowMelt = min(cover.x, meltBudget);
        let iceMelt = min(cover.y, max(meltBudget - snowMelt, 0.0));
        cover.x -= snowMelt;
        cover.y -= iceMelt;
        liquid.x += snowMelt + iceMelt;
        energy -= (snowMelt + iceMelt) * latentFusion;
    }
    cover.z = energy / surfaceHeatCapacity(i, liquid.x, cover.y, cover.x);
    let deficit = max(saturation(cover.z) - vapor, 0.0);
    // Only water actually present is evaporated; dry land cannot create vapor.
    var evaporation = 0.0;
    if (availableAir) { evaporation = min(max(liquid.x, 0.0), deficit * dt * max(u.hydrology.z, 0.0)); }
    liquid.x = max(liquid.x - evaporation, 0.0);
    energy -= evaporation * (450.0 + 8.0 * cover.z);
    cover.z = clamp(energy / surfaceHeatCapacity(i, liquid.x, cover.y, cover.x), -70.0, 90.0);
    if (availableAir) {
        // The old cover.w was injected by advect this step. Lava-generated
        // steam is also real water-equivalent volume and joins the next step.
        cover.w = evaporation + max(liquid.w, 0.0);
        liquid.w = 0.0;
    }
    surface[i] = cover;
    fluids[i] = liquid;
}
