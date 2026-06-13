out vec2 v_uv;
out vec3 v_pos;
out float v_rock;
out float v_sand;
out float v_water;
out float v_lava;

uniform sampler2D u_texA;
uniform sampler2D u_texB;
uniform float u_height_scale;
uniform float u_layer;

void main() {
  v_uv = uv;

  vec4 cellA = texture(u_texA, uv);
  vec4 cellB = texture(u_texB, uv);

  v_rock = cellA.r;
  v_sand = cellA.g;
  v_water = cellB.r;
  v_lava = cellB.g;

  float h = v_rock + v_sand;
  if (u_layer > 0.5) {
    h += v_water + v_lava;
  }

  // Displace vertex position along its normal (which is local Z for PlaneGeometry)
  vec3 displaced = position;
  displaced.z = h * u_height_scale;
  v_pos = displaced;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
