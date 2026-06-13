precision highp float;
precision highp sampler2D;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_texA; // Previous Terrain state
uniform sampler2D u_texB; // Previous Fluids state

// Brush settings
uniform float u_brush_active;
uniform vec2 u_brush_uv;
uniform float u_brush_radius;
uniform float u_brush_type;
uniform float u_brush_strength;

// Parameters
uniform float u_grid_size;
uniform float u_sand_slide_rate;
uniform float u_initialized;
uniform float u_seed;

// Terrain parameters
uniform float u_terrain_scale;
uniform float u_terrain_sharpness;
uniform int u_fbm_octaves;
uniform float u_fbm_persistence;

// Simple pseudo-random hash
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// 2D Value Noise
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i + vec2(0.0,0.0)), hash(i + vec2(1.0,0.0)), u.x),
             mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), u.x), u.y);
}

// Fractional Brownian Motion (fBm) noise
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
  for (int i = 0; i < 8; ++i) {
    if (i >= u_fbm_octaves) break;
    v += a * noise(p);
    p = rot * p * 2.1 + vec2(10.0);
    a *= u_fbm_persistence;
  }
  return v;
}

// Access cellular data at a given UV
void getCellData(vec2 uv, out float rock, out float sand, out float water, out float lava) {
  vec4 a = texture(u_texA, uv);
  vec4 b = texture(u_texB, uv);
  rock = a.r;
  sand = a.g;
  water = b.r;
  lava = b.g;

  // Water/Lava interaction: convert lava to rock gradually
  if (water > 0.01 && lava > 0.01) {
    float react = min(0.002, lava);
    rock += react;
  }
}

// Calculate sliding sand flow from src to dst
float computeSandFlow(vec2 src_uv, vec2 dst_uv) {
  float src_rock, src_sand, src_water, src_lava;
  getCellData(src_uv, src_rock, src_sand, src_water, src_lava);
  if (src_sand <= 0.0001) return 0.0;

  float h_src = src_rock + src_sand;

  float dst_rock, dst_sand, dst_water, dst_lava;
  getCellData(dst_uv, dst_rock, dst_sand, dst_water, dst_lava);
  float h_dst = dst_rock + dst_sand;

  float diff = h_src - h_dst;
  float threshold = 0.05; // Angle of repose threshold
  if (diff > threshold) {
    float sum_excess = 0.0;
    float excess_dst = diff - threshold;

    vec2 texel = 1.0 / vec2(u_grid_size);
    vec2 dirs[4] = vec2[](
      vec2(-1.0, 0.0), vec2(1.0, 0.0),
      vec2(0.0, -1.0), vec2(0.0, 1.0)
    );

    for (int i = 0; i < 4; i++) {
      vec2 n_uv = clamp(src_uv + dirs[i] * texel, 0.0, 1.0);
      float n_rock, n_sand, n_water, n_lava;
      getCellData(n_uv, n_rock, n_sand, n_water, n_lava);
      float h_n = n_rock + n_sand;
      float n_diff = h_src - h_n;
      if (n_diff > threshold) {
        sum_excess += (n_diff - threshold);
      }
    }

    if (sum_excess > 0.0) {
      float total_slide = min(src_sand * 0.25, sum_excess * u_sand_slide_rate);
      return total_slide * (excess_dst / sum_excess);
    }
  }
  return 0.0;
}

void main() {
  // Initial procedural terrain generation on first pass
  if (u_initialized < 0.5) {
    vec2 p = v_uv * u_terrain_scale + vec2(u_seed);
    float rock = fbm(p);
    rock = pow(rock, u_terrain_sharpness) * 2.1;
    
    // Place initial sand in valleys
    float sand = max(0.0, 0.16 - rock) * 1.5;
    
    fragColor = vec4(rock, sand, 0.0, 1.0);
    return;
  }

  // Read current state
  float rock, sand, water, lava;
  getCellData(v_uv, rock, sand, water, lava);

  // Compute sand sliding changes (cellular automata)
  vec2 texel = 1.0 / vec2(u_grid_size);
  vec2 dirs[4] = vec2[](
    vec2(-1.0, 0.0), vec2(1.0, 0.0),
    vec2(0.0, -1.0), vec2(0.0, 1.0)
  );

  float sand_in = 0.0;
  float sand_out = 0.0;

  for (int i = 0; i < 4; i++) {
    vec2 n_uv = clamp(v_uv + dirs[i] * texel, 0.0, 1.0);
    sand_in += computeSandFlow(n_uv, v_uv);
    sand_out += computeSandFlow(v_uv, n_uv);
  }

  sand = max(0.0, sand - sand_out + sand_in);

  // Brush painting interface
  if (u_brush_active > 0.5) {
    float dist = distance(v_uv, u_brush_uv);
    if (dist < u_brush_radius) {
      float falloff = 1.0 - smoothstep(u_brush_radius * 0.2, u_brush_radius, dist);
      float amount = falloff * u_brush_strength * 0.015;

      if (u_brush_type == 2.0) { // Add Sand
        sand += amount * 1.5;
      } else if (u_brush_type == 3.0) { // Raise Rock
        rock += amount;
      } else if (u_brush_type == 4.0) { // Dig Rock
        rock = max(0.0, rock - amount);
      } else if (u_brush_type == 5.0) { // Erase/Clear Sand
        sand = max(0.0, sand - amount * 4.0);
      }
    }
  }

  // Safety checks
  rock = clamp(rock, 0.0, 10.0);
  sand = clamp(sand, 0.0, 10.0);

  fragColor = vec4(rock, sand, 0.0, 1.0);
}
