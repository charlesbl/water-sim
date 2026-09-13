struct WeatherRenderUniforms {
    inverse_mvp: mat4x4<f32>, mvp: mat4x4<f32>, camera_time: vec4<f32>, grid_height: vec4<f32>,
    view_clouds: vec4<f32>, camera_right: vec4<f32>, camera_up: vec4<f32>,
    clouds: vec4<f32>, // reconstructed base, depth, detail, rain visibility
    region: vec4<f32>, // rain rate, shadow strength, enabled, canopy width
    sun: vec4<f32>,
};
@group(0) @binding(0) var<uniform> uniforms: WeatherRenderUniforms;
@group(0) @binding(1) var<storage, read> surface: array<vec4<f32>>;
@group(0) @binding(2) var scene_depth: texture_depth_2d;
@group(0) @binding(3) var<storage, read> summary: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> cloudCanopy: array<f32>;


fn cellIndex(p: vec2<i32>) -> u32 {
    let n=vec2<i32>(uniforms.grid_height.xy);
    let c=clamp(p,vec2<i32>(0),n-1);
    return u32(c.x+c.y*n.x);
}
fn sampleSurface(xy:vec2<f32>)->vec4<f32>{
    let n=i32(uniforms.grid_height.z);let grid=(xy+100.0)/200.0*f32(n)-0.5;
    let base=vec2<i32>(floor(grid));let f=fract(grid);var value=vec4<f32>(0.0);
    for(var y=0;y<2;y++){for(var x=0;x<2;x++){let p=clamp(base+vec2<i32>(x,y),vec2<i32>(0),vec2<i32>(n-1));let w=select(1.0-f,f,vec2<bool>(x==1,y==1));value+=surface[p.y*n+p.x]*w.x*w.y;}}return value;
}
// Height, unused, rain/snow rate, painted intensity. Geometry uses a coarse summary only.
fn sampleWeather(xy:vec2<f32>)->vec4<f32>{
    let grid=(xy+100.0)/200.0*uniforms.grid_height.xy-0.5;let b=vec2<i32>(floor(grid));let f=fract(grid);var out=vec4<f32>(0.0);
    for(var y=0;y<2;y++){for(var x=0;x<2;x++){let v=summary[cellIndex(b+vec2<i32>(x,y))];let w=select(1.0-f,f,vec2<bool>(x==1,y==1));out+=v*w.x*w.y;}}
    let s=sampleSurface(xy);return vec4<f32>(out.x,0.0,s.w*uniforms.region.x*uniforms.region.z,s.w);
}
fn hash3(p: vec3<f32>) -> f32 {
    let q=fract(p*vec3<f32>(0.1031,0.1030,0.0973)); let r=q+dot(q,q.yxz+33.33);
    return fract((r.x+r.y)*r.z);
}
fn noise3(p:vec3<f32>) -> f32 {
    let b=floor(p); var f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(mix(hash3(b),hash3(b+vec3<f32>(1,0,0)),f.x),
        mix(hash3(b+vec3<f32>(0,1,0)),hash3(b+vec3<f32>(1,1,0)),f.x),f.y),
        mix(mix(hash3(b+vec3<f32>(0,0,1)),hash3(b+vec3<f32>(1,0,1)),f.x),
        mix(hash3(b+vec3<f32>(0,1,1)),hash3(b+vec3<f32>(1,1,1)),f.x),f.y),f.z);
}
fn unproject(ndc:vec2<f32>,depth:f32) -> vec3<f32> {
    let p=uniforms.inverse_mvp*vec4<f32>(ndc,depth,1.0); return p.xyz/p.w;
}
fn cloudBase(xy:vec2<f32>)->f32 {
    let grid=(xy+100.0)/200.0*32.0-0.5;let b=vec2<i32>(floor(grid));let f=fract(grid);var h=0.0;
    for(var y=0;y<2;y++){for(var x=0;x<2;x++){let p=clamp(b+vec2<i32>(x,y),vec2<i32>(0),vec2<i32>(31));let w=select(1.0-f,f,vec2<bool>(x==1,y==1));h+=cloudCanopy[p.y*32+p.x]*w.x*w.y;}}return h;
}
fn rayBox(o:vec3<f32>,d:vec3<f32>) -> vec2<f32> {
    let safe=select(vec3<f32>(-1.0),vec3<f32>(1.0),d>=vec3<f32>(0.0))*max(abs(d),vec3<f32>(0.000001));
    let a=(vec3<f32>(-100,-100,0)-o)/safe; let b=(vec3<f32>(100,100,cloudCanopy[1024]+uniforms.clouds.y*2.0)-o)/safe;
    let lo=min(a,b); let hi=max(a,b); return vec2<f32>(max(max(lo.x,lo.y),lo.z),min(min(hi.x,hi.y),hi.z));
}
@vertex fn vs_volume(@builtin(vertex_index) i:u32) -> @builtin(position) vec4<f32> {
    let p=vec2<f32>(f32((i<<1u)&2u),f32(i&2u)); return vec4<f32>(p*2.0-1.0,0.0,1.0);
}
@fragment fn fs_overlay(@builtin(position) pixel:vec4<f32>) -> @location(0) vec4<f32> {
    let size=vec2<f32>(textureDimensions(scene_depth));
    let ndc=vec2<f32>(pixel.x/size.x*2.0-1.0,1.0-pixel.y/size.y*2.0);
    let depth=textureLoad(scene_depth,vec2<i32>(pixel.xy),0);
    let hit=unproject(ndc,depth);
    let onGround=depth<1.0 && all(abs(hit.xy)<=vec2<f32>(100.0));
    let view=uniforms.view_clouds.x;
    if(!onGround || view<0.5){discard;}
    let info=sampleWeather(hit.xy);
    let amount=clamp(select(info.w*0.5,info.z/0.004,view>1.5),0.0,1.0);
    var color=mix(vec3<f32>(0.14,0.20,0.26),vec3<f32>(0.22,0.78,0.72),clamp(amount*2.0,0.0,1.0));
    color=mix(color,vec3<f32>(0.97,0.76,0.24),clamp(amount*2.0-1.0,0.0,1.0));
    return vec4<f32>(color * uniforms.sun.w, uniforms.sun.w);
}
@fragment fn fs_volume(@builtin(position) pixel:vec4<f32>) -> @location(0) vec4<f32> {
    let size=vec2<f32>(textureDimensions(scene_depth));
    let ndc=vec2<f32>(pixel.x/size.x*2.0-1.0,1.0-pixel.y/size.y*2.0);
    let depth=textureLoad(scene_depth,vec2<i32>(pixel.xy),0);
    let hit=unproject(ndc,depth);
    let onGround=depth<1.0 && all(abs(hit.xy)<=vec2<f32>(100.0));
    let origin=uniforms.camera_time.xyz; let direction=normalize(unproject(ndc,1.0)-origin);
    let box=rayBox(origin,direction);
    let start=max(max(box.x,0.0),length(unproject(ndc,0.0)-origin));
    let end=min(box.y,length(hit-origin));
    let opacity=uniforms.view_clouds.z;
    var color=vec3<f32>(0.0); var trans=1.0;
    if(end>start && (opacity>0.0)){
        let stepSize=max(0.8,(end-start)/40.0);
        var t=start+stepSize*(0.15+0.7*hash3(vec3<f32>(floor(pixel.xy),0.0)));
        for(var step=0u;step<40u;step++){
            if(t>=end || trans<0.035){break;}
            let p=origin+direction*t; let info=sampleWeather(p.xy);
            let base=cloudBase(p.xy); let z=(p.z-base)/max(uniforms.clouds.y*(0.4+info.w*0.5),1.0);
            var extinction=0.0; var light=0.5;
            if(z>0.0 && z<1.4 && opacity>0.0){
                let point=p*0.18+vec3<f32>(sin(uniforms.camera_time.w*0.06)*0.15,0,0);
                let detail=noise3(point)*0.7+noise3(point*2.3)*0.3;
                let top=0.7+detail*0.65*uniforms.clouds.z;
                let envelope=smoothstep(0.0,0.16,z)*(1.0-smoothstep(top*0.5,top,z));
                let textureWeight=mix(1.0,0.35+detail*1.2,uniforms.clouds.z);
                extinction=info.w*0.65*envelope*textureWeight*opacity;
                light=0.40+0.55*clamp(z/top,0.0,1.0);
            }
            let alpha=1.0-exp(-max(extinction,0.0)*stepSize);
            let forward=pow(max(dot(direction,uniforms.sun.xyz),0.0),5.0)*0.12;
            let cloudColor=mix(vec3<f32>(0.38,0.47,0.58),vec3<f32>(1.0,0.98,0.93),clamp(light+forward,0.0,1.0));
            color+=trans*alpha*cloudColor; trans*=1.0-alpha; t+=stepSize;
        }
    }
    var shadow=0.0;
    if(onGround){
        let info=sampleWeather(hit.xy);
        let condensate=info.w;
        let shielding=1.0-cloudTransmission(condensate,uniforms.region.y);
        shadow=clamp(shielding*0.55,0.0,0.9);
    }
    // Cloud shadow is composed underneath the volume; precipitation uses separate particles.
    color+=trans*shadow*vec3<f32>(0.035,0.055,0.08);
    return vec4<f32>(color,1.0-trans*(1.0-shadow));
}
struct ParticleVertex {
    @builtin(position) position:vec4<f32>, @location(0) uv:vec2<f32>,
    @location(1) color_alpha:vec4<f32>, @location(2) @interpolate(flat) kind:f32,
};
@vertex fn vs_particle(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32) -> ParticleVertex {
    var corners=array<vec2<f32>,6>(vec2<f32>(-1,-1),vec2<f32>(1,-1),vec2<f32>(-1,1),vec2<f32>(-1,1),vec2<f32>(1,-1),vec2<f32>(1,1));
    let corner=corners[vertex]; let id=f32(instance);
    let seed=vec3<f32>(hash3(vec3<f32>(id,3.1,8.7)),hash3(vec3<f32>(id,17.3,2.5)),hash3(vec3<f32>(id,6.7,34.1)));
    let age=fract(seed.z+uniforms.camera_time.w/8.0);
    let xy=seed.xy*200.0-100.0;
    let visible=all(abs(xy)<vec2<f32>(99.0));
    let info=sampleWeather(xy);
    let snow=1.0-smoothstep(-1.0,1.0,sampleSurface(xy).z);
    let fall=mix(12.0,2.0,snow); let base=cloudBase(xy);
    let z=mix(info.x,base,fract(seed.z-uniforms.camera_time.w*fall/max(base-info.x,1.0)));
    var p=vec3<f32>(xy,z);
    var alpha=(1.0-exp(-info.z*800.0))*0.72*uniforms.clouds.w;
    var tint=mix(vec3<f32>(0.51,0.74,0.91),vec3<f32>(0.97,0.99,1.0),snow);
    var width=mix(0.045,0.12+seed.x*0.08,snow);
    var extent=mix(0.6+seed.y*0.4,width,snow);
    var axis=vec3<f32>(0,0,-1); var kind=snow;
    alpha *= select(0.0, smoothstep(0.0,0.12,age)*(1.0-smoothstep(0.8,1.0,age)), visible);
    var side=normalize(cross(axis,normalize(uniforms.camera_time.xyz-p+0.00001))+uniforms.camera_right.xyz*0.00001);
    var point=p+side*corner.x*width+axis*corner.y*extent;
    if(snow>0.7){point=p+uniforms.camera_right.xyz*corner.x*width+uniforms.camera_up.xyz*corner.y*width;}
    return ParticleVertex(uniforms.mvp*vec4<f32>(point,1.0),corner,vec4<f32>(tint,alpha),kind);
}
@fragment fn fs_particle(p:ParticleVertex) -> @location(0) vec4<f32> {
    let size=vec2<i32>(textureDimensions(scene_depth)); let pixel=vec2<i32>(p.position.xy);
    if(any(pixel<vec2<i32>(0)) || any(pixel>=size)){discard;}
    if(p.position.z>textureLoad(scene_depth,pixel,0)+0.000001 || p.color_alpha.a<0.001){discard;}
    var shape=(1.0-smoothstep(0.3,1.0,abs(p.uv.x)))*(1.0-smoothstep(0.5,1.0,abs(p.uv.y)));
    if(p.kind>0.7 && p.kind<1.5){shape=1.0-smoothstep(0.15,1.0,dot(p.uv,p.uv));}
    let alpha=p.color_alpha.a*shape;return vec4<f32>(p.color_alpha.rgb*alpha,alpha);
}
