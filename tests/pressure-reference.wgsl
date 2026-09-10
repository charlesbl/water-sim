// Frozen pre-cache kernels from 825ee0badec3540d51a977c960470708f8361e26.
// Test-only A/B reference; shared unchanged helpers come from the production module.

@compute @workgroup_size(4, 4, 4)
fn referenceDivergence(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!inside(id)) { return; }
    let p = vec3<i32>(id);
    let i = index(p);
    pressureOut[i] = 0.0;
    if (!air(p)) { divergenceField[i] = 0.0; cgState[i] = vec4<f32>(0.0); return; }
    let positive = faceVelocity(p);
    let negative = vec3<f32>(faceVelocity(p - vec3<i32>(1, 0, 0)).x, faceVelocity(p - vec3<i32>(0, 1, 0)).y, faceVelocity(p - vec3<i32>(0, 0, 1)).z);
    divergenceField[i] = dot(positive - negative, 1.0 / u.spacingTime.xyz);
    let residual = -divergenceField[i];
    let preconditioned = residual / max(referencePressureDiagonal(p), 0.00001);
    cgState[i] = vec4<f32>(residual, preconditioned, preconditioned, 0.0);
}

fn referencePressureDiagonal(p: vec3<i32>) -> f32 {
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

@compute @workgroup_size(256)
fn referenceCgApply(@builtin(global_invocation_id) id: vec3<u32>,
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
fn referenceCgUpdate(@builtin(global_invocation_id) id: vec3<u32>,
    @builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let i = id.x;
    var product = 0.0;
    if (i < u32(u.grid.x * u.grid.y * u.grid.z)) {
        let p = linearCoordinate(i);
        if (air(p)) {
            var state = cgState[i];
            pressureOut[i] += cgCoefficients.x * state.z;
            state.x -= cgCoefficients.x * state.w;
            state.y = state.x / max(referencePressureDiagonal(p), 0.00001);
            product = state.x * state.y;
            cgState[i] = state;
        }
    }
    cgSum[lane] = vec2<f32>(product, 0.0);
    reducePressureDot(lane);
    if (lane == 0u) { cgPartials[group.x] = cgSum[0]; }
}
