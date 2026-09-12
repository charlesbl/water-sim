// Coupled two-layer MAC flow. Each layer owns east/north faces; the lower
// layer also owns the interface face. Bottom, lid and normal wall fluxes are zero.
@group(0) @binding(26) var<storage, read_write> circulationFaces: array<vec4<f32>>;
@group(0) @binding(27) var<storage, read_write> nextCirculationFaces: array<vec4<f32>>;
@group(0) @binding(28) var<storage, read_write> momentumScratch: array<vec4<f32>>;
@group(0) @binding(29) var<storage, read_write> faceHeat: array<vec4<f32>>;
@group(0) @binding(30) var<storage, read_write> flowPartials: array<vec4<f32>>;
@group(0) @binding(31) var<storage, read_write> flowControl: vec4<f32>;

fn offset(axis: u32) -> vec3<i32> { var p=vec3<i32>(0); p[axis]=1; return p; }
fn validFace(p: vec3<i32>, axis: u32) -> bool {
    return all(p>=vec3<i32>(0)) && all(p<vec3<i32>(u.grid.xyz)) && p[axis]<i32(u.grid[axis])-1;
}
fn initialFace(p: vec2<i32>, axis: u32) -> f32 {
    if (!validFace(vec3<i32>(p,0),axis)) { return 0.0; }
    return u.initialAir[axis+2u];
}
fn oldFace(p: vec3<i32>, axis: u32) -> f32 {
    if (!validFace(p,axis)) { return 0.0; }
    return circulationFaces[index(p)][axis];
}
fn currentFace(p: vec3<i32>, axis: u32) -> f32 {
    if (!validFace(p,axis)) { return 0.0; }
    return nextCirculationFaces[index(p)][axis];
}
fn interfaceVelocity(p: vec2<i32>) -> f32 { return currentFace(vec3<i32>(p,0),2u); }
fn centerVelocity(p: vec3<i32>) -> vec3<f32> {
    return 0.5*vec3<f32>(currentFace(p,0u)+currentFace(p-offset(0u),0u),
        currentFace(p,1u)+currentFace(p-offset(1u),1u),currentFace(p,2u)+currentFace(p-offset(2u),2u));
}
fn cellMechanicalHeat(p: vec3<i32>) -> f32 {
    var heat=0.0;
    for (var axis=0u; axis<3u; axis++) {
        if (validFace(p,axis)) { heat+=0.5*faceHeat[index(p)][axis]; }
        let q=p-offset(axis);
        if (validFace(q,axis)) { heat+=0.5*faceHeat[index(q)][axis]; }
    }
    return heat;
}
fn minmod(a: f32, b: f32) -> f32 { return select(0.0,sign(a)*min(abs(a),abs(b)),a*b>0.0); }

@compute @workgroup_size(8,8)
fn syncAirVelocity(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!inside(id)) { return; }
    let p=vec3<i32>(id); let i=index(p);
    volumeOut[i].velocityTemperature=vec4<f32>(centerVelocity(p),volumeOut[i].velocityTemperature.w);
}
@compute @workgroup_size(8,8)
fn applyAirHeat(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!inside(id)) { return; }
    let i=index(vec3<i32>(id)); var cell=volumeIn[i];
    cell.velocityTemperature.w+=longwaveHeating[i];
    if (id.z==0u) {
        let ci=columnIndex(vec3<i32>(id)); let toAir=columns[ci].w*u.environment.y/u.spacingTime.z;
        cell.velocityTemperature.w+=surfaceHeat[ci]+columns[ci].y*toAir;
        cell.moisture.x+=columns[ci].z*toAir;
    }
    cell=adjustCloudPhase(cell,0.5*u.spacingTime.w);
    cell=evaporateRain(cell,0.5*u.spacingTime.w);
    volumeOut[i]=cell;
}

fn momentumValue(p: vec3<i32>, component: u32, stage: u32) -> f32 {
    if (!validFace(p,component)) { return 0.0; }
    if (stage==0u) { return circulationFaces[index(p)][component]; }
    return momentumScratch[index(p)][component];
}
// Velocity through staggered dual faces. Hold the last projected advecting
// field during the RK stages; the transported momentum itself evolves.
fn momentumSpeed(p: vec3<i32>, component: u32, direction: u32) -> f32 {
    if (!validFace(p,component) || !validFace(p+offset(direction),component)) { return 0.0; }
    let q=p+offset(component);
    return 0.5*(oldFace(p,direction)+oldFace(q,direction));
}
fn projectedMomentumSpeed(p: vec3<i32>, component: u32, direction: u32) -> f32 {
    if (!validFace(p,component) || !validFace(p+offset(direction),component)) { return 0.0; }
    return 0.5*(currentFace(p,direction)+currentFace(p+offset(component),direction));
}
// Momentum and matching kinetic-energy fluxes. Only their discrepancy with
// resulting kinetic energy is heat; spatial energy transport is not heating.
fn momentumFlux(p: vec3<i32>, component: u32, direction: u32, stage: u32) -> vec2<f32> {
    let e=offset(direction); let q=p+e;
    if (!validFace(p,component) || !validFace(q,component)) { return vec2<f32>(0.0); }
    let speed=momentumSpeed(p,component,direction);
    let donor=select(p,q,speed<0.0); let value=momentumValue(donor,component,stage);
    let slope=minmod(value-momentumValue(donor-e,component,stage),momentumValue(donor+e,component,stage)-value);
    let reconstructed=value+select(0.5,-0.5,speed<0.0)*slope;
    let left=momentumValue(p,component,stage); let right=momentumValue(q,component,stage);
    let diffusion=-u.dynamics.x*(right-left)/u.spacingTime[direction];
    return vec2<f32>(speed*reconstructed+diffusion,
        speed*0.5*reconstructed*reconstructed+diffusion*0.5*(left+right));
}
fn momentumTendency(p: vec3<i32>, component: u32, stage: u32) -> vec2<f32> {
    var tendency=vec2<f32>(0.0);
    for (var direction=0u; direction<3u; direction++) {
        tendency+=(momentumFlux(p-offset(direction),component,direction,stage)
            -momentumFlux(p,component,direction,stage))/u.spacingTime[direction];
    }
    return tendency;
}
@compute @workgroup_size(8,8)
fn advectMomentum(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!inside(id)) { return; }
    let p=vec3<i32>(id); let i=index(p); var next=vec4<f32>(0.0); var energy=vec4<f32>(0.0);
    for (var component=0u; component<3u; component++) {
        if (!validFace(p,component)) { continue; }
        let tendency=momentumTendency(p,component,0u);
        next[component]=circulationFaces[i][component]+u.spacingTime.w*tendency.x;
        energy[component]=tendency.y;
    }
    momentumScratch[i]=next; faceHeat[i]=energy;
}
@compute @workgroup_size(8,8)
fn finishMomentum(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!inside(id)) { return; }
    let p=vec3<i32>(id); let i=index(p); var next=vec4<f32>(0.0); var heat=vec4<f32>(0.0);
    for (var component=0u; component<3u; component++) {
        if (!validFace(p,component)) { continue; }
        let tendency=momentumTendency(p,component,1u); let old=circulationFaces[i][component];
        let speed=0.5*(old+momentumScratch[i][component]+u.spacingTime.w*tendency.x);
        next[component]=speed;
        heat[component]=0.5*(old*old-speed*speed)+0.5*u.spacingTime.w*(faceHeat[i][component]+tendency.y);
    }
    nextCirculationFaces[i]=next; faceHeat[i]=heat;
}
@compute @workgroup_size(8,8)
fn forceMomentum(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!inside(id)) { return; }
    let p=vec3<i32>(id); let i=index(p); let ci=columnIndex(p); let count=u32(u.grid.x*u.grid.y);
    let old=nextCirculationFaces[i]; var next=old; var heat=faceHeat[i];
    if (id.z==0u) {
        // Potential-temperature buoyancy. A uniform reference changes only
        // hydrostatic pressure; no air temperature is restored to a target.
        let low=volumeIn[ci].velocityTemperature.w; let high=volumeIn[ci+count].velocityTemperature.w;
        let theta=0.5*(low+high)+u.physics.x*(columns[ci].x+0.5*u.spacingTime.z);
        let buoyancy=9.81*max(u.hydrology.x,0.0)/288.15*(theta-12.0);
        let energyLimit=sqrt(old.z*old.z+2.0*max(min(low,high)+65.0,0.0));
        next.z=clamp(old.z+u.spacingTime.w*buoyancy,-energyLimit,energyLimit);
    }
    let friction=max(u.hydrology.y,0.0)*select(1.0,0.1,id.z==1u);
    next.x*=exp(-friction*u.spacingTime.w); next.y*=exp(-friction*u.spacingTime.w);
    next.z*=exp(-0.1*max(u.hydrology.y,0.0)*u.spacingTime.w);
    // Finite thermal-work approximation: buoyancy spends heat; drag returns
    // heat. No separate prognostic potential-energy reservoir is claimed.
    heat+=vec4<f32>(0.5*(old.xyz*old.xyz-next.xyz*next.xyz),0.0);
    if (id.z==0u && u.windBrush.z>0.0) {
        for (var axis=0u; axis<2u; axis++) {
            if (!validFace(p,axis)) { continue; }
            var uv=(vec2<f32>(p.xy)+0.5)/u.grid.xy; uv[axis]+=0.5/u.grid[axis];
            let falloff=1.0-smoothstep(0.0,u.windBrush.z,distance(uv,u.windBrush.xy));
            // Explicit user work is not borrowed from the thermal reservoir.
            next[axis]+=u.spacingTime.w*u.windForce[axis]*falloff;
        }
    }
    momentumScratch[i]=next; faceHeat[i]=heat;
}

fn flowOutflow(p: vec3<i32>) -> f32 {
    var rate=0.0;
    for (var axis=0u; axis<3u; axis++) {
        rate+=(max(currentFace(p,axis),0.0)+max(-currentFace(p-offset(axis),axis),0.0))/u.spacingTime[axis];
    }
    for (var component=0u; component<3u; component++) {
        if (!validFace(p,component)) { continue; }
        var dual=0.0;
        for (var axis=0u; axis<3u; axis++) {
            dual+=(max(projectedMomentumSpeed(p,component,axis),0.0)
                +max(-projectedMomentumSpeed(p-offset(axis),component,axis),0.0))/u.spacingTime[axis];
        }
        rate=max(rate,dual);
    }
    return rate;
}
var<workgroup> flowSums: array<vec4<f32>,256>;
fn mergeFlow(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> { return vec4<f32>(a.xy+b.xy,max(a.z,b.z),a.w+b.w); }
@compute @workgroup_size(8,8)
fn measureFlow(@builtin(global_invocation_id) id: vec3<u32>, @builtin(workgroup_id) group: vec3<u32>,
    @builtin(local_invocation_index) lane: u32) {
    var value=vec4<f32>(0.0);
    if (inside(id)) {
        let i=index(vec3<i32>(id)); let before=momentumScratch[i].xyz; let after=nextCirculationFaces[i].xyz;
        value=vec4<f32>(0.5*dot(before,before),0.5*dot(after,after),flowOutflow(vec3<i32>(id)),dot(before-after,before-after));
    }
    flowSums[lane]=value; workgroupBarrier();
    for (var stride=32u; stride>0u; stride/=2u) {
        if (lane<stride) { flowSums[lane]=mergeFlow(flowSums[lane],flowSums[lane+stride]); }
        workgroupBarrier();
    }
    if (lane==0u) {
        let tiles=(vec2<u32>(u.grid.xy)+7u)/8u;
        flowPartials[group.x+tiles.x*(group.y+tiles.y*group.z)]=flowSums[0];
    }
}
@compute @workgroup_size(256)
fn reduceFlow(@builtin(local_invocation_index) lane: u32) {
    let tiles=(vec2<u32>(u.grid.xy)+7u)/8u; let count=tiles.x*tiles.y*2u;
    var total=vec4<f32>(0.0);
    for (var i=lane; i<count; i+=256u) { total=mergeFlow(total,flowPartials[i]); }
    flowSums[lane]=total; workgroupBarrier();
    for (var stride=128u; stride>0u; stride/=2u) {
        if (lane<stride) { flowSums[lane]=mergeFlow(flowSums[lane],flowSums[lane+stride]); }
        workgroupBarrier();
    }
    if (lane==0u) {
        let sums=flowSums[0];
        // A single scalar preserves projected continuity. Protect all future
        // supported weather steps, including a return from a shorter timestep.
        var energyScale=1.0;
        if (sums.y>sums.x && sums.y>0.0) { energyScale=sqrt(sums.x/sums.y); }
        let scale=min(min(1.0,u.dynamics.w/max(u.dynamics.y*sums.z,0.000001)),energyScale);
        let lost=max(0.0,sums.x-scale*scale*sums.y);
        let weight=sums.w+(1.0-scale*scale)*sums.y;
        var heatScale=0.0;
        if (weight>0.0) { heatScale=lost/weight; }
        flowControl=vec4<f32>(scale,heatScale,sums.z,lost);
    }
}
@compute @workgroup_size(8,8)
fn finalizeMomentum(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!inside(id)) { return; }
    let i=index(vec3<i32>(id)); let before=momentumScratch[i].xyz; let after=nextCirculationFaces[i].xyz;
    let weight=(before-after)*(before-after)+(1.0-flowControl.x*flowControl.x)*0.5*after*after;
    faceHeat[i]+=vec4<f32>(weight*flowControl.y,0.0);
    let velocity=vec4<f32>(after*flowControl.x,0.0);
    nextCirculationFaces[i]=velocity; circulationFaces[i]=velocity;
}

// Shared conservative MUSCL fluxes for the four water reservoirs and potential
// temperature. Vertical reconstruction falls back to constant near the lid.
fn tracer(p: vec3<i32>, channel: u32) -> f32 {
    let q=bounded(p); let cell=volumeIn[index(q)];
    if (channel<4u) { return cell.moisture[channel]; }
    return cell.velocityTemperature.w+u.physics.x*(columns[columnIndex(q)].x+f32(q.z)*u.spacingTime.z);
}
fn tracerFlux(p: vec3<i32>, axis: u32, channel: u32) -> f32 {
    let speed=currentFace(p,axis);
    if (speed==0.0) { return 0.0; }
    let e=offset(axis); let donor=select(p,p+e,speed<0.0); let value=tracer(donor,channel);
    let slope=minmod(value-tracer(donor-e,channel),tracer(donor+e,channel)-value);
    return speed*(value+select(0.5,-0.5,speed<0.0)*slope);
}
fn transported(p: vec3<i32>) -> AtmosphereCell {
    var cell=volumeIn[index(p)];
    for (var channel=0u; channel<5u; channel++) {
        var tendency=0.0;
        for (var axis=0u; axis<3u; axis++) {
            tendency+=(tracerFlux(p-offset(axis),axis,channel)-tracerFlux(p,axis,channel))/u.spacingTime[axis];
        }
        if (channel<4u) { cell.moisture[channel]+=u.spacingTime.w*tendency; }
        else { cell.velocityTemperature.w+=u.spacingTime.w*tendency; }
    }
    return cell;
}
@compute @workgroup_size(8,8)
fn transportPredict(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!inside(id)) { return; }
    volumeOut[index(vec3<i32>(id))]=transported(vec3<i32>(id));
}
@compute @workgroup_size(8,8)
fn transportFinish(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!inside(id)) { return; }
    let p=vec3<i32>(id); let i=index(p); let advanced=transported(p);
    // Only the owning invocation reads its original output cell. All neighbor
    // reads use the separate first-stage buffer, so this is race-free.
    let original=volumeOut[i];
    let temperature=0.5*(original.velocityTemperature.w+advanced.velocityTemperature.w)+cellMechanicalHeat(p);
    volumeOut[i]=AtmosphereCell(vec4<f32>(centerVelocity(p),temperature),0.5*(original.moisture+advanced.moisture));
}
