// Frozen transport before optimization 2; pressure cache (optimization 1) retained.
// Source atmosphere.wgsl SHA-256: 7d07645368daba7c373c7d97dc7a45f661946ec2e1cebd5ace139c0b4cc0167b
// Shared unchanged helpers come from the production shader. Test-only.

fn referenceOutgoingCourant(p: vec3<i32>) -> f32 {
    let positive = faceVelocity(p);
    let negative = vec3<f32>(
        faceVelocity(p - vec3<i32>(1, 0, 0)).x,
        faceVelocity(p - vec3<i32>(0, 1, 0)).y,
        faceVelocity(p - vec3<i32>(0, 0, 1)).z);
    return dot(max(positive, vec3<f32>(0.0)) + max(-negative, vec3<f32>(0.0)),
        vec3<f32>(u.spacingTime.w) / u.spacingTime.xyz);
}

fn referenceLimitedSlope(left: vec4<f32>, center: vec4<f32>, right: vec4<f32>) -> vec4<f32> {
    let before = center - left;
    let after = right - center;
    return select(vec4<f32>(0.0), sign(before) * min(abs(before), abs(after)), before * after > vec4<f32>(0.0));
}

fn referenceWaterFlux(p: vec3<i32>, axis: u32) -> vec4<f32> {
    var offset = vec3<i32>(0);
    offset[axis] = 1;
    if (!air(p) || !air(p + offset)) { return vec4<f32>(0.0); }
    let speed = volumeIn[index(p)].velocityTemperature[axis];
    let donor = select(p + offset, p, speed >= 0.0);
    let courant = referenceOutgoingCourant(donor);
    var value = volumeIn[index(donor)].moisture;
    if (courant <= 0.5 && air(donor - offset) && air(donor + offset)) {
        // MUSCL reconstruction preserves coherent humid plumes. Minmod bounds
        // each face by 1.5 times its donor. At combined CFL <= 0.5, the total
        // outgoing amount is therefore below 0.75 of the available inventory.
        let slope = referenceLimitedSlope(volumeIn[index(donor - offset)].moisture,
            value, volumeIn[index(donor + offset)].moisture);
        value += 0.5 * sign(speed) * (1.0 - courant) * slope;
    }
    // At high combined CFL fall back to positive, conservative donor transport.
    return value / max(1.0, courant) * (speed * u.spacingTime.w / u.spacingTime[axis]);
}

fn referenceTransportWater(p: vec3<i32>) -> vec4<f32> {
    var water = volumeIn[index(p)].moisture;
    for (var axis = 0u; axis < 3u; axis++) {
        var offset = vec3<i32>(0);
        offset[axis] = 1;
        water += referenceWaterFlux(p - offset, axis) - referenceWaterFlux(p, axis);
    }
    // Only roundoff can cross zero; the face donor limiter guarantees positivity.
    return max(water, vec4<f32>(0.0));
}

fn referencePotentialTemperature(p: vec3<i32>) -> f32 {
    // A dry rising parcel preserves this quantity. The positive Kelvin offset
    // permits the same positivity-preserving large-CFL fallback as water.
    let height = (f32(p.z) + 0.5) * u.spacingTime.z;
    return volumeIn[index(p)].velocityTemperature.w + 273.15 + dryLapse * height;
}

fn referenceHeatFlux(p: vec3<i32>, axis: u32) -> f32 {
    var offset = vec3<i32>(0);
    offset[axis] = 1;
    if (!air(p) || !air(p + offset)) { return 0.0; }
    let speed = volumeIn[index(p)].velocityTemperature[axis];
    let donor = select(p + offset, p, speed >= 0.0);
    let courant = referenceOutgoingCourant(donor);
    var value = referencePotentialTemperature(donor);
    if (courant <= 0.5 && air(donor - offset) && air(donor + offset)) {
        let before = value - referencePotentialTemperature(donor - offset);
        let after = referencePotentialTemperature(donor + offset) - value;
        if (before * after > 0.0) {
            value += 0.5 * sign(speed) * (1.0 - courant) * sign(before) * min(abs(before), abs(after));
        }
    }
    return value / max(1.0, courant) * (speed * u.spacingTime.w / u.spacingTime[axis]);
}

fn referenceTransportTemperature(p: vec3<i32>) -> f32 {
    var potential = referencePotentialTemperature(p);
    for (var axis = 0u; axis < 3u; axis++) {
        var offset = vec3<i32>(0);
        offset[axis] = 1;
        potential += referenceHeatFlux(p - offset, axis) - referenceHeatFlux(p, axis);
    }
    return potential - 273.15 - dryLapse * (f32(p.z) + 0.5) * u.spacingTime.z;
}

@compute @workgroup_size(4, 4, 4)
fn referenceAdvect(@builtin(global_invocation_id) id: vec3<u32>) {
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
    var temperature = referenceTransportTemperature(p) + longwaveHeating[i];
    var water = referenceTransportWater(p);
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
