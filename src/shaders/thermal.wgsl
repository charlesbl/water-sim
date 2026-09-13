struct Uniforms {
    inverse: mat4x4<f32>,
    settings: vec4<f32>, // surface size, height scale, reserved, opacity
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var<storage, read> surface: array<vec4<f32>>;
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
            let w = select(1.0-f.x,f.x,x==1) * select(1.0-f.y,f.y,y==1);
            value += vec2<f32>(s.z,0)*w;
        }
    }
    return value;
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
    return vec4<f32>(thermal_color(t)*u.settings.w,u.settings.w);
}

