struct AirCell { velocity_temperature: vec4<f32>, moisture: vec4<f32> };
struct AtmosphereRenderUniforms {
    inverse_mvp: mat4x4<f32>, mvp: mat4x4<f32>, camera_time: vec4<f32>, grid_height: vec4<f32>,
    view_slice_clouds_wind: vec4<f32>, camera_right: vec4<f32>, camera_up: vec4<f32>,
    clouds: vec4<f32>, // reconstructed base, depth, detail, rain visibility
    region: vec4<f32>, // nominal map km, shadow strength, layer accounting depth, boundary
    sun: vec4<f32>,
};
@group(0) @binding(0) var<uniform> uniforms: AtmosphereRenderUniforms;
@group(0) @binding(1) var<storage, read> atmosphere: array<AirCell>;
@group(0) @binding(2) var scene_depth: texture_depth_2d;
@group(0) @binding(3) var<storage, read> columns: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> weather: array<vec4<f32>>;

fn cellIndex(p: vec2<i32>) -> u32 {
    let n=vec2<i32>(uniforms.grid_height.xy);
    var c=clamp(p,vec2<i32>(0),n-1);
    if (uniforms.region.w < 0.5) { c=((p%n)+n)%n; }
    return u32(c.x+c.y*n.x);
}
fn mixAir(a: AirCell,b: AirCell,t:f32) -> AirCell {
    return AirCell(mix(a.velocity_temperature,b.velocity_temperature,t),mix(a.moisture,b.moisture,t));
}
fn sampleAir(xy: vec2<f32>, layer: u32) -> AirCell {
    let grid=(xy+100.0)/200.0*uniforms.grid_height.xy-0.5;
    let b=vec2<i32>(floor(grid)); let f=fract(grid); let offset=layer*u32(uniforms.grid_height.x*uniforms.grid_height.y);
    return mixAir(mixAir(atmosphere[cellIndex(b)+offset],atmosphere[cellIndex(b+vec2<i32>(1,0))+offset],f.x),
        mixAir(atmosphere[cellIndex(b+vec2<i32>(0,1))+offset],atmosphere[cellIndex(b+vec2<i32>(1,1))+offset],f.x),f.y);
}
// Mean ground height, recent wetness, precipitation rate and cloud coverage.
fn sampleWeather(xy: vec2<f32>) -> vec4<f32> {
    let grid=(xy+100.0)/200.0*uniforms.grid_height.xy-0.5;
    let b=vec2<i32>(floor(grid)); let f=fract(grid); var out=vec4<f32>(0.0);
    for(var y=0;y<2;y++){for(var x=0;x<2;x++){
        let i=cellIndex(b+vec2<i32>(x,y)); let w=select(1.0-f,f,vec2<bool>(x==1,y==1));
        out+=vec4<f32>(columns[i].x,weather[i].x,weather[i].y,weather[i].w)*w.x*w.y;
    }}
    return out;
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
fn cloudBase(ground:f32) -> f32 { return max(ground+3.0,uniforms.clouds.x+ground*0.2); }
fn rayBox(o:vec3<f32>,d:vec3<f32>) -> vec2<f32> {
    let safe=select(vec3<f32>(-1.0),vec3<f32>(1.0),d>=vec3<f32>(0.0))*max(abs(d),vec3<f32>(0.000001));
    let a=(vec3<f32>(-100,-100,0)-o)/safe; let b=(vec3<f32>(100,100,uniforms.grid_height.w)-o)/safe;
    let lo=min(a,b); let hi=max(a,b); return vec2<f32>(max(max(lo.x,lo.y),lo.z),min(min(hi.x,hi.y),hi.z));
}
fn temperatureColor(t:f32) -> vec3<f32> {
    if(t<0.0){return mix(vec3<f32>(0.16,0.25,0.85),vec3<f32>(0.82,0.96,1.0),clamp((t+30.0)/30.0,0.0,1.0));}
    if(t<15.0){return mix(vec3<f32>(0.82,0.96,1.0),vec3<f32>(1.0,0.8,0.28),t/15.0);}
    return mix(vec3<f32>(1.0,0.8,0.28),vec3<f32>(0.9,0.12,0.08),clamp((t-15.0)/20.0,0.0,1.0));
}
@vertex fn vs_volume(@builtin(vertex_index) i:u32) -> @builtin(position) vec4<f32> {
    let p=vec2<f32>(f32((i<<1u)&2u),f32(i&2u)); return vec4<f32>(p*2.0-1.0,0.0,1.0);
}
@fragment fn fs_volume(@builtin(position) pixel:vec4<f32>) -> @location(0) vec4<f32> {
    let size=vec2<f32>(textureDimensions(scene_depth));
    let ndc=vec2<f32>(pixel.x/size.x*2.0-1.0,1.0-pixel.y/size.y*2.0);
    let depth=textureLoad(scene_depth,vec2<i32>(pixel.xy),0);
    let hit=unproject(ndc,depth);
    let onGround=depth<1.0 && all(abs(hit.xy)<=vec2<f32>(100.0));
    let view=uniforms.view_slice_clouds_wind.x;
    if(view>0.5){
        if(!onGround){discard;}
        let layer=u32(round(uniforms.view_slice_clouds_wind.y));
        let cell=sampleAir(hit.xy,layer); let weatherSample=sampleWeather(hit.xy);
        var color=temperatureColor(cell.velocity_temperature.w);
        if(view>1.5 && view<2.5){
            let rh=cell.moisture.x/max(cloudSaturation(cell.velocity_temperature.w),0.00001);
            color=mix(vec3<f32>(0.64,0.34,0.15),vec3<f32>(0.18,0.83,0.92),clamp(rh,0.0,1.0));
            color=mix(color,vec3<f32>(0.96,0.98,1.0),clamp(cell.moisture.y*120.0,0.0,0.8));
        }else if(view>2.5 && view<3.5){
            let speed=length(cell.velocity_temperature.xy)*uniforms.region.x/200.0*60.0;
            color=mix(vec3<f32>(0.14,0.23,0.57),vec3<f32>(0.25,0.85,0.7),clamp(speed/3.0,0.0,1.0));
            color=mix(color,vec3<f32>(1.0,0.55,0.16),clamp((speed-3.0)/3.0,0.0,1.0));
        }else if(view>3.5 && view<4.5){
            let rate=1.0-exp(-weatherSample.z*18000.0);
            color=mix(vec3<f32>(0.14,0.20,0.26),vec3<f32>(0.22,0.78,0.72),clamp(rate*2.0,0.0,1.0));
            color=mix(color,vec3<f32>(0.97,0.76,0.24),clamp(rate*2.0-1.0,0.0,1.0));
        }else if(view>4.5){color=mix(vec3<f32>(0.72,0.43,0.20),vec3<f32>(0.16,0.66,0.80),weatherSample.y);}
        return vec4<f32>(color*0.72,0.72);
    }
    let origin=uniforms.camera_time.xyz; let direction=normalize(unproject(ndc,1.0)-origin);
    let box=rayBox(origin,direction);
    let start=max(max(box.x,0.0),length(unproject(ndc,0.0)-origin));
    let end=min(box.y,length(hit-origin));
    let opacity=uniforms.view_slice_clouds_wind.z;
    var color=vec3<f32>(0.0); var trans=1.0;
    if(end>start && (opacity>0.0 || uniforms.clouds.w>0.0)){
        let stepSize=max(0.8,(end-start)/40.0);
        var t=start+stepSize*(0.15+0.7*hash3(vec3<f32>(floor(pixel.xy),0.0)));
        for(var step=0u;step<40u;step++){
            if(t>=end || trans<0.035){break;}
            let p=origin+direction*t; let info=sampleWeather(p.xy);
            let base=cloudBase(info.x); let z=(p.z-base)/max(uniforms.clouds.y,1.0);
            var extinction=0.0; var light=0.5;
            if(z>0.0 && z<1.4 && opacity>0.0){
                let air=sampleAir(p.xy,1u);
                let drift=vec3<f32>(air.velocity_temperature.xy*uniforms.camera_time.w,0.0);
                let point=(p-drift)*0.18;
                let detail=noise3(point)*0.7+noise3(point*2.3)*0.3;
                let top=0.7+detail*0.65*uniforms.clouds.z;
                let envelope=smoothstep(0.0,0.16,z)*(1.0-smoothstep(top*0.5,top,z));
                let textureWeight=mix(1.0,0.35+detail*1.2,uniforms.clouds.z);
                extinction=air.moisture.y*125.0*envelope*textureWeight*opacity;
                light=0.40+0.55*clamp(z/top,0.0,1.0);
            }
            // Low-layer condensate becomes a shallow fog bank hugging the terrain.
            let fogZ=(p.z-info.x)/4.0;
            if(fogZ>0.0 && fogZ<1.0 && opacity>0.0){
                extinction+=sampleAir(p.xy,0u).moisture.y*45.0*sin(fogZ*3.1415927)*opacity;
            }
            if(p.z>info.x && p.z<base){extinction+=info.z*85.0*uniforms.clouds.w;}
            let alpha=1.0-exp(-max(extinction,0.0)*stepSize);
            let forward=pow(max(dot(direction,uniforms.sun.xyz),0.0),5.0)*0.12;
            let cloudColor=mix(vec3<f32>(0.38,0.47,0.58),vec3<f32>(1.0,0.98,0.93),clamp(light+forward,0.0,1.0));
            color+=trans*alpha*cloudColor; trans*=1.0-alpha; t+=stepSize;
        }
    }
    var shadow=0.0;
    if(onGround){
        let info=sampleWeather(hit.xy);
        shadow=info.w*uniforms.region.y*0.55 + info.y*0.08;
    }
    // Cloud shadow and rain-darkened ground are composed underneath the volume.
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
    let isWind=instance>=8192u;
    let layer=u32(select(seed.z>0.5,uniforms.view_slice_clouds_wind.y>0.5,uniforms.view_slice_clouds_wind.x>0.5));
    let initial=sampleAir(seed.xy*200.0-100.0,layer);
    let xy=fract(seed.xy+initial.velocity_temperature.xy*uniforms.camera_time.w/200.0)*200.0-100.0;
    let info=sampleWeather(xy); let air=sampleAir(xy,layer);
    let low=sampleAir(xy,0u);
    let snow=low.moisture.w/max(low.moisture.z+low.moisture.w,0.000001);
    let fall=mix(12.0,2.0,snow); let base=cloudBase(info.x);
    let z=mix(info.x,base,fract(seed.z-uniforms.camera_time.w*fall/max(base-info.x,1.0)));
    var p=vec3<f32>(xy,z);
    var alpha=(1.0-exp(-info.z*20000.0))*0.72*uniforms.clouds.w;
    var tint=mix(vec3<f32>(0.51,0.74,0.91),vec3<f32>(0.97,0.99,1.0),snow);
    var width=mix(0.045,0.12+seed.x*0.08,snow);
    var extent=mix(0.6+seed.y*0.4,width,snow);
    var axis=normalize(vec3<f32>(low.velocity_temperature.xy,-fall)); var kind=snow;
    if(isWind){
        p.z=select(info.x+2.0,base+uniforms.clouds.y*0.5,layer==1u);
        alpha=min(0.65,length(air.velocity_temperature.xy)*0.6);
        tint=select(vec3<f32>(0.3,0.9,0.95),vec3<f32>(1.0,0.8,0.36),layer==1u);
        axis=normalize(vec3<f32>(air.velocity_temperature.xy,0.00001));width=0.07;extent=1.0;kind=2.0;
    }else if(uniforms.view_slice_clouds_wind.x>0.5){alpha=0.0;}
    var side=normalize(cross(axis,normalize(uniforms.camera_time.xyz-p+0.00001))+uniforms.camera_right.xyz*0.00001);
    var point=p+side*corner.x*width+axis*corner.y*extent;
    if(!isWind && snow>0.7){point=p+uniforms.camera_right.xyz*corner.x*width+uniforms.camera_up.xyz*corner.y*width;}
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
