struct Uniforms {
    inverse: mat4x4<f32>,
    settings: vec4<f32>, // surface size, height scale, air offset, opacity
    mode: vec4<f32>, // air mode, reserved
    grid: vec4<f32>, // atmospheric nx, ny, nz, reserved
};
struct Air { velocity: vec4<f32>, moisture: vec4<f32> };
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var<storage, read> surface: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> air: array<Air>;
@group(0) @binding(4) var<storage, read> columns: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> terrain: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read> fluids: array<vec4<f32>>;
fn position(pixel: vec2<i32>) -> vec4<f32> {
    let size = vec2<i32>(textureDimensions(depth));
    if (any(pixel < vec2<i32>(0)) || any(pixel >= size)) { return vec4<f32>(0.0); }
    let d = textureLoad(depth, pixel, 0);
    let ndc = (vec2<f32>(pixel) + 0.5) / vec2<f32>(size) * 2.0 - 1.0;
    let p = u.inverse * vec4<f32>(ndc.x, -ndc.y, d, 1.0);
    let world = p.xyz / p.w;
    return vec4<f32>(world, select(0.0, 1.0, d < 1.0 && all(abs(world.xy) <= vec2<f32>(100.0))));
}
// Fine surface values and heights share the same bilinear reconstruction.
fn surface_at(xy: vec2<f32>) -> vec2<f32> {
    let grid = (xy + 100.0) / 200.0 * u.settings.x - 0.5;
    let base = vec2<i32>(floor(grid));
    let f = fract(grid);
    var value = vec2<f32>(0.0);
    for (var y = 0; y < 2; y++) {
        for (var x = 0; x < 2; x++) {
            let c = clamp(base + vec2<i32>(x,y), vec2<i32>(0), vec2<i32>(i32(u.settings.x)-1));
            let i = c.y * i32(u.settings.x) + c.x;
            let s = surface[i];
            let height = (terrain[i].x + terrain[i].y + max(fluids[i].x,0.0) + max(fluids[i].y,0.0) + max(s.x,0.0)*5.0 + max(s.y,0.0)/0.917) * u.settings.y;
            let w = select(1.0-f.x,f.x,x==1) * select(1.0-f.y,f.y,y==1);
            value += vec2<f32>(s.z,height)*w;
        }
    }
    return value;
}
// Ignore buried cells. Near ground, use the first valid air layer; never invent
// fine atmospheric detail below the simulation's vertical spacing.
fn air_at(xy: vec2<f32>, height: f32) -> vec2<f32> {
    let nx = i32(u.grid.x);
    let ny = i32(u.grid.y);
    let nz = i32(u.grid.z);
    let layerSize = nx * ny;
    let dz = u.grid.w / u.grid.z;
    if (height > u.grid.w - 0.5 * dz) { return vec2<f32>(0.0); }
    let grid = (xy+100.0)/200.0*u.grid.xy-vec2<f32>(0.5);
    let base = vec2<i32>(floor(grid));
    let f = fract(grid);
    var total = 0.0;
    var weights = 0.0;
    for (var y=0; y<2; y++) {
        for (var x=0; x<2; x++) {
            let c = clamp(base+vec2<i32>(x,y),vec2<i32>(0),vec2<i32>(nx-1,ny-1));
            let ci = c.x+c.y*nx;
            let first = max(0,i32(floor(columns[ci].x/dz-0.5))+1);
            if (first >= nz) { continue; }
            let z = clamp(height/dz-0.5,f32(first),f32(nz-1));
            let lo = i32(floor(z));
            let hi = min(lo+1,nz-1);
            let t = mix(air[ci+lo*layerSize].velocity.w,air[ci+hi*layerSize].velocity.w,fract(z));
            let w = select(1.0-f.x,f.x,x==1)*select(1.0-f.y,f.y,y==1);
            total += t*w;
            weights += w;
        }
    }
    return vec2<f32>(total/max(weights,0.00001),weights);
}
fn thermal_color(t: f32) -> vec3<f32> {
    if (t < 0.0) { return mix(vec3<f32>(0.16,0.25,0.85),vec3<f32>(0.82,0.96,1.0),clamp((t+30.0)/30.0,0.0,1.0)); }
    if (t < 15.0) { return mix(vec3<f32>(0.82,0.96,1.0),vec3<f32>(1.0,0.8,0.28),t/15.0); }
    return mix(vec3<f32>(1.0,0.8,0.28),vec3<f32>(0.9,0.12,0.08),clamp((t-15.0)/20.0,0.0,1.0));
}
@vertex fn vs(@builtin(vertex_index) i:u32) -> @builtin(position) vec4<f32> {
    let p = vec2<f32>(f32((i<<1u)&2u),f32(i&2u));
    return vec4<f32>(p*2.0-1.0,0.0,1.0);
}
@fragment fn fs(@builtin(position) pixel:vec4<f32>) -> @location(0) vec4<f32> {
    let p = position(vec2<i32>(pixel.xy));
    if (p.w == 0.0) { discard; }
    let s = surface_at(p.xy);
    var t = s.x;
    if (u.mode.x > 0.5) {
        let a = air_at(p.xy,s.y+u.settings.z);
        if (a.y <= 0.0) { discard; }
        t = a.x;
    }
    return vec4<f32>(thermal_color(t)*u.settings.w,u.settings.w);
}

