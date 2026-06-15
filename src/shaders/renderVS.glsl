out vec2 v_uv;
out vec3 v_pos;
out float v_rock;
out float v_sand;
out float v_suspended_sand;
out float v_water;
out float v_lava;

uniform sampler2D u_texA;
uniform sampler2D u_texB;
uniform float u_height_scale;
uniform float u_layer;
uniform float u_grid_size;
uniform float u_smooth;

float get_ground_height(vec2 uv) {
  if (u_smooth < 0.5) {
    vec4 a = texture(u_texA, uv);
    return a.r + a.g;
  }
  vec2 texel = 1.0 / vec2(u_grid_size);
  vec2 p = uv * u_grid_size - 0.5;
  vec2 f = fract(p);
  vec2 i = floor(p) * texel + texel * 0.5;
  
  float tl = texture(u_texA, i).r + texture(u_texA, i).g;
  float tr = texture(u_texA, i + vec2(texel.x, 0.0)).r + texture(u_texA, i + vec2(texel.x, 0.0)).g;
  float bl = texture(u_texA, i + vec2(0.0, texel.y)).r + texture(u_texA, i + vec2(0.0, texel.y)).g;
  float br = texture(u_texA, i + texel).r + texture(u_texA, i + texel).g;
  
  return mix(mix(tl, tr, f.x), mix(bl, br, f.x), f.y);
}

float get_height(vec2 uv) {
  if (u_smooth < 0.5) {
    vec4 a = texture(u_texA, uv);
    vec4 b = texture(u_texB, uv);
    return a.r + a.g + b.r + b.g;
  }
  vec2 texel = 1.0 / vec2(u_grid_size);
  vec2 p = uv * u_grid_size - 0.5;
  vec2 f = fract(p);
  vec2 i = floor(p) * texel + texel * 0.5;
  
  vec4 tlA = texture(u_texA, i);
  vec4 trA = texture(u_texA, i + vec2(texel.x, 0.0));
  vec4 blA = texture(u_texA, i + vec2(0.0, texel.y));
  vec4 brA = texture(u_texA, i + texel);

  vec4 tlB = texture(u_texB, i);
  vec4 trB = texture(u_texB, i + vec2(texel.x, 0.0));
  vec4 blB = texture(u_texB, i + vec2(0.0, texel.y));
  vec4 brB = texture(u_texB, i + texel);

  float tl = tlA.r + tlA.g + tlB.r + tlB.g;
  float tr = trA.r + trA.g + trB.r + trB.g;
  float bl = blA.r + blA.g + blB.r + blB.g;
  float br = brA.r + brA.g + brB.r + brB.g;
  
  return mix(mix(tl, tr, f.x), mix(bl, br, f.x), f.y);
}

void main() {
  v_uv = uv;

  vec4 cellA = texture(u_texA, uv);
  vec4 cellB = texture(u_texB, uv);

  v_rock = cellA.r;
  v_sand = cellA.g;
  v_suspended_sand = cellA.b;
  v_water = cellB.r;
  v_lava = cellB.g;

  float h;
  if (u_layer > 0.5) {
    h = get_height(uv);
  } else {
    h = get_ground_height(uv);
  }

  // Displace vertex position along its normal (which is local Z for PlaneGeometry)
  vec3 displaced = position;
  displaced.z = h * u_height_scale;
  v_pos = displaced;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
