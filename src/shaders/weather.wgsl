struct TerrainCell { rock:f32, sand:f32, suspended_sand:f32, avalanche:f32, soil:f32, suspended_soil:f32 };
struct WeatherUniforms {
    grid:vec4<f32>, // surface size, summary size, dt, height scale
    sun:vec4<f32>, // direction and strength
    cooling:vec4<f32>, // low, middle, high, middle altitude
    climate:vec4<f32>, // fixed top, cloud shielding, rain rate, evaporation
    clock:vec4<f32>, // time, partial count, albedo strength, reserved
    clouds:vec4<f32>, // minimum cloud base, ground clearance, canopy width, unused
};
@group(0) @binding(0) var<uniform> u:WeatherUniforms;
@group(0) @binding(1) var<storage,read> terrain:array<TerrainCell>;
@group(0) @binding(2) var<storage,read_write> fluids:array<vec4<f32>>;
@group(0) @binding(3) var<storage,read_write> surface:array<vec4<f32>>;
@group(0) @binding(4) var<storage,read_write> diffusion:array<vec2<f32>>;
@group(0) @binding(5) var<storage,read_write> weatherMap:array<vec4<f32>>;
@group(0) @binding(6) var<storage,read_write> partials:array<vec4<f32>>;
@group(0) @binding(7) var<storage,read_write> energyFlux:vec4<f32>;
@group(0) @binding(8) var<storage,read_write> waterExchange:vec4<f32>;
@group(0) @binding(9) var<uniform> pulse:vec4<f32>;
@group(0) @binding(10) var<storage,read_write> cloudCanopy:array<f32>;

fn index(p:vec2<i32>) -> u32 { let q=clamp(p,vec2<i32>(0),vec2<i32>(i32(u.grid.x)-1)); return u32(q.y)*u32(u.grid.x)+u32(q.x); }
fn capacity(i:u32) -> f32 {return materialHeatCapacity(terrain[i].sand,terrain[i].soil,fluids[i].x,surface[i].y,surface[i].x);}
fn height(i:u32) -> f32 { return (terrain[i].rock+terrain[i].sand+terrain[i].soil+max(fluids[i].x,0.0)+max(fluids[i].y,0.0)+surface[i].x*2.5+surface[i].y/0.917)*u.grid.w; }
fn coolingAt(h:f32) -> f32 {
    let mid=clamp(u.cooling.w,0.1,u.climate.x-0.1);
    if(h<mid){return mix(u.cooling.x,u.cooling.y,clamp(h/mid,0.0,1.0));}
    return mix(u.cooling.y,u.cooling.z,clamp((h-mid)/(u.climate.x-mid),0.0,1.0));
}
@compute @workgroup_size(16,16) fn initialize(@builtin(global_invocation_id) id:vec3<u32>) {
    if(any(id.xy>=vec2<u32>(u32(u.grid.x)))){return;} surface[id.y*u32(u.grid.x)+id.x]=vec4<f32>(0,0,12,0);
}
@compute @workgroup_size(16,16) fn clearCover(@builtin(global_invocation_id) id:vec3<u32>) {
    if(any(id.xy>=vec2<u32>(u32(u.grid.x)))){return;} let i=id.y*u32(u.grid.x)+id.x; surface[i]=vec4<f32>(0,0,12,surface[i].w);
}
@compute @workgroup_size(16,16) fn eraseClouds(@builtin(global_invocation_id) id:vec3<u32>) {
    if(any(id.xy>=vec2<u32>(u32(u.grid.x)))){return;} surface[id.y*u32(u.grid.x)+id.x].w=0.0;
}
@compute @workgroup_size(16,16) fn heatPulse(@builtin(global_invocation_id) id:vec3<u32>) {
    if(any(id.xy>=vec2<u32>(u32(u.grid.x)))){return;} let i=id.y*u32(u.grid.x)+id.x;
    let falloff=1.0-smoothstep(pulse.z*0.2,pulse.z,distance((vec2<f32>(id.xy)+0.5)/u.grid.x,pulse.xy));
    surface[i].z=clamp(surface[i].z+pulse.w*falloff/capacity(i),-70.0,90.0);
}
// Paired neighbor exchanges use the same capacities in both directions. No in-place temperature reads.
@compute @workgroup_size(16,16) fn diffuse(@builtin(global_invocation_id) id:vec3<u32>) {
    if(any(id.xy>=vec2<u32>(u32(u.grid.x)))){return;} let p=vec2<i32>(id.xy); let i=index(p); let ci=capacity(i);
    let weight=min(0.24,0.08*u.grid.z/pow(200.0/u.grid.x,2.0));
    var energy=0.0;
    let directions=array<vec2<i32>,4>(vec2<i32>(-1,0),vec2<i32>(1,0),vec2<i32>(0,-1),vec2<i32>(0,1));
    for(var k=0;k<4;k++){let j=index(p+directions[k]); energy+=(surface[j].z-surface[i].z)/(1.0/ci+1.0/capacity(j))*weight;}
    let normal=normalize(vec3<f32>(height(index(p-vec2<i32>(1,0)))-height(index(p+vec2<i32>(1,0))),height(index(p-vec2<i32>(0,1)))-height(index(p+vec2<i32>(0,1))),400.0/u.grid.x));
    diffusion[i]=vec2<f32>(energy,max(dot(normal,u.sun.xyz),0.0));
}
var<workgroup> sums:array<vec4<f32>,256>;
fn sumGroup(lane:u32){for(var stride=128u;stride>0u;stride/=2u){workgroupBarrier();if(lane<stride){sums[lane]+=sums[lane+stride];}}workgroupBarrier();}
@compute @workgroup_size(16,16) fn evolve(@builtin(global_invocation_id) id:vec3<u32>,@builtin(local_invocation_index) lane:u32,@builtin(workgroup_id) group:vec3<u32>) {
    var flux=vec4<f32>(0.0);
    if(all(id.xy<vec2<u32>(u32(u.grid.x)))){
        let i=id.y*u32(u.grid.x)+id.x; let p=vec2<i32>(id.xy); let dt=u.grid.z;
        var s=surface[i]; var water=max(fluids[i].x,0.0); var energy=s.z*capacity(i)+diffusion[i].x;
        // Temperature changes and precipitation phase are continuous around freezing.
        let rain=max(s.w,0.0)*max(u.climate.z,0.0)*dt;
        let snow=rain*(1.0-smoothstep(-1.0,1.0,s.z));
        water+=rain-snow; s.x+=snow;
        energy+=(rain-snow)*8.0*s.z+snow*2.0*min(s.z,0.0);
        let albedo=clamp(materialAlbedo(terrain[i].sand,terrain[i].soil,water,s.y,s.x)*u.clock.z,0.0,1.0);
        let sun=max(u.sun.w,0.0)*(1.0-albedo)*diffusion[i].y*0.65*cloudTransmission(s.w,u.climate.y);
        let cooling=max(coolingAt(height(i)),0.0)*0.25*pow(max(s.z+273.15,0.0)/288.15,4.0);
        energy+=(sun-cooling)*dt;
        // Submerged snow compacts or melts only in proportion to submerged material.
        let wet=wetSnowTransfer(water,s.x,energy);
        water+=wet.x; s.x-=wet.x+wet.y; s.y+=wet.y; energy-=wet.x*80.0;
        if(energy<0.0){let frozen=min(water,-energy/80.0*(1.0-exp(-0.18*dt)));water-=frozen;s.y+=frozen;energy+=frozen*80.0;}
        else {let budget=energy/80.0*(1.0-exp(-0.25*dt));let snowMelt=min(s.x,budget);let iceMelt=min(s.y,max(budget-snowMelt,0.0));s.x-=snowMelt;s.y-=iceMelt;water+=snowMelt+iceMelt;energy-=(snowMelt+iceMelt)*80.0;}
        let cap=materialHeatCapacity(terrain[i].sand,terrain[i].soil,water,s.y,s.x);
        let requested=water*(1.0-exp(-max(u.climate.w,0.0)*dt/45.0))*smoothstep(0.0,40.0,energy/cap);
        let evaporated=min(requested,max(energy,0.0)/480.0);
        water-=evaporated;energy-=evaporated*480.0;
        s.z=clamp(energy/materialHeatCapacity(terrain[i].sand,terrain[i].soil,water,s.y,s.x),-70.0,90.0);
        surface[i]=s;fluids[i].x=water;
        // Steam is a cosmetic transient; evaporated water exits the sandbox.
        fluids[i].w=fluids[i].w*exp(-dt)+evaporated;
        flux=vec4<f32>(sun,cooling,rain,evaporated);
    }
    sums[lane]=flux;sumGroup(lane);
    if(lane==0u){partials[group.y*u32(ceil(u.grid.x/16.0))+group.x]=sums[0];}
}
@compute @workgroup_size(16,16) fn summarize(@builtin(global_invocation_id) id:vec3<u32>){
    if(any(id.xy>=vec2<u32>(u32(u.grid.y)))){return;}
    let start=id.xy*u32(u.grid.x)/u32(u.grid.y);let end=(id.xy+1u)*u32(u.grid.x)/u32(u.grid.y);var sum=vec4<f32>(0.0);var peak=0.0;
    for(var y=start.y;y<end.y;y++){for(var x=start.x;x<end.x;x++){let i=y*u32(u.grid.x)+x;let s=surface[i];peak=max(peak,height(i));sum+=vec4<f32>(height(i),s.w,s.z,0);}}
    weatherMap[id.y*u32(u.grid.y)+id.x]=vec4<f32>(sum.xyz/f32((end.x-start.x)*(end.y-start.y)),peak);
}
@compute @workgroup_size(256) fn reduceFlux(@builtin(local_invocation_index) lane:u32){
    var sum=vec4<f32>(0.0);for(var i=lane;i<u32(u.clock.y);i+=256u){sum+=partials[i];}sums[lane]=sum;sumGroup(lane);
    if(lane==0u){let area=pow(200.0/u.grid.x,2.0);let f=sums[0]*area;energyFlux=vec4<f32>(f.x,f.y,f.x-f.y,u.clock.x);waterExchange+=vec4<f32>(f.zw*u.grid.w,0,0);}
}

// A broad upper envelope bridges local valleys. Every interpolated corner includes
// the terrain under it, so the canopy preserves its clearance even above sharp peaks.
@compute @workgroup_size(16,16) fn canopy(@builtin(global_invocation_id) id:vec3<u32>){
    if(any(id.xy>=vec2<u32>(32))){return;}
    let n=u32(u.grid.y);let start=vec2<u32>(max(vec2<i32>(id.xy)-1,vec2<i32>(0)))*n/32u;
    let end=min(id.xy+2u,vec2<u32>(32))*n/32u;var peak=0.0;
    for(var y=start.y;y<end.y;y++){for(var x=start.x;x<end.x;x++){peak=max(peak,weatherMap[y*n+x].w);}}
    cloudCanopy[id.y*32u+id.x]=max(u.clouds.x,peak+u.clouds.y);
}
@compute @workgroup_size(256) fn canopyTop(@builtin(local_invocation_index) lane:u32){
    var top=0.0;for(var i=lane;i<1024u;i+=256u){top=max(top,cloudCanopy[i]);}
    sums[lane]=vec4<f32>(top);
    for(var stride=128u;stride>0u;stride/=2u){workgroupBarrier();if(lane<stride){sums[lane]=max(sums[lane],sums[lane+stride]);}}workgroupBarrier();
    if(lane==0u){cloudCanopy[1024]=sums[0].x;}
}
