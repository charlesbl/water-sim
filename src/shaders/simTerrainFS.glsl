precision highp float;
precision highp sampler2D;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_texA; // Previous Terrain state
uniform sampler2D u_texB; // Previous Fluids state
uniform sampler2D u_texFlux; // Previous Water flux

// Brush settings
uniform float u_brush_active;
uniform vec2 u_brush_uv;
uniform float u_brush_radius;
uniform float u_brush_type;
uniform float u_brush_strength;

// Parameters
uniform float u_grid_size;
uniform float u_sand_slide_rate;
uniform float u_sand_repose_slope;
uniform float u_erosion_rate;
uniform float u_capacity_factor;
uniform float u_deposition_rate;
uniform float u_min_water_depth;
uniform float u_initialized;
uniform float u_seed;
uniform float u_border_behavior;

// Terrain parameters
uniform float u_terrain_type; // 0: realistic, 1: flat
uniform float u_terrain_sand_height;
uniform float u_flat_rock_height;
uniform float u_terrain_scale;
uniform float u_terrain_sharpness;
uniform float u_terrain_tilt;
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
void getCellData(vec2 uv, out float rock, out float sand, out float suspended_sand, out float water, out float lava) {
  vec4 a = texture(u_texA, uv);
  vec4 b = texture(u_texB, uv);
  rock = a.r;
  sand = a.g;
  suspended_sand = a.b;
  water = b.r;
  lava = b.g;

  // Water/Lava interaction: convert lava to rock gradually
  if (water > 0.01 && lava > 0.01) {
    float react = min(0.002, lava);
    rock += react;
  }
}

// Calculate sliding sand flow from src to dst
float computeSandFlow(vec2 src_uv, vec2 dst_uv, float dist) {
  float src_rock, src_sand, src_susp, src_water, src_lava;
  getCellData(src_uv, src_rock, src_sand, src_susp, src_water, src_lava);
  if (src_sand <= 0.0001) return 0.0;

  float h_src = src_rock + src_sand;

  float dst_rock, dst_sand, dst_susp, dst_water, dst_lava;
  getCellData(dst_uv, dst_rock, dst_sand, dst_susp, dst_water, dst_lava);
  float h_dst = dst_rock + dst_sand;

  float diff = h_src - h_dst;
  float threshold = u_sand_repose_slope * dist; // Angle of repose threshold, adjusted for distance
  if (diff > threshold) {
    float sum_excess = 0.0;
    float excess_dst = diff - threshold;

    vec2 texel = 1.0 / vec2(u_grid_size);
    vec2 dirs[8] = vec2[](
      vec2(-1.0, 0.0), vec2(1.0, 0.0),
      vec2(0.0, -1.0), vec2(0.0, 1.0),
      vec2(-1.0, -1.0), vec2(1.0, -1.0),
      vec2(-1.0, 1.0), vec2(1.0, 1.0)
    );
    float dists[8] = float[](
      1.0, 1.0, 1.0, 1.0,
      1.414, 1.414, 1.414, 1.414
    );

    for (int i = 0; i < 8; i++) {
      vec2 n_uv = clamp(src_uv + dirs[i] * texel, 0.0, 1.0);
      float n_rock, n_sand, n_susp, n_water, n_lava;
      getCellData(n_uv, n_rock, n_sand, n_susp, n_water, n_lava);
      float h_n = n_rock + n_sand;
      float n_diff = h_src - h_n;
      float n_thresh = u_sand_repose_slope * dists[i];
      if (n_diff > n_thresh) {
        sum_excess += (n_diff - n_thresh);
      }
    }

    if (sum_excess > 0.0) {
      // The absolute mathematical stability limit for 8 neighbors is 1/9 (approx 0.111).
      // We clamp the rate to 0.11 to guarantee it never explodes (checkerboard pattern),
      // regardless of how high the user sets the slider.
      float effective_rate = min(0.11, u_sand_slide_rate);
      float total_slide = min(src_sand * 0.25, sum_excess * effective_rate);
      return total_slide * (excess_dst / sum_excess);
    }
  }
  return 0.0;
}

// Compute local suspended sand after erosion/deposition reaction
float getNewSuspended(vec2 uv) {
  float r, s, susp, w, l;
  getCellData(uv, r, s, susp, w, l);
  if (w <= 0.001) return 0.0;
  
  vec4 f = texture(u_texFlux, uv);
  float total_flux = f.r + f.g + f.b + f.a;
  float velocity = total_flux / w;
  
  float depth_multiplier = 1.0;
  if (u_min_water_depth > 0.0) {
    depth_multiplier = smoothstep(u_min_water_depth * 0.5, u_min_water_depth * 1.5, w);
  }
  
  float capacity = (velocity * velocity * velocity) * w * u_capacity_factor * 2.0 * depth_multiplier;
  
  float diff = capacity - susp;
  
  // Settling velocity increases as speed goes to 0 (less turbulent)
  float active_dep_rate = mix(1.0, u_deposition_rate, clamp(velocity * 5.0, 0.0, 1.0));
  float active_rate = (diff > 0.0) ? u_erosion_rate : active_dep_rate;
  
  float change = diff * active_rate;
  if (change > 0.0) {
    change = min(s, change);
  } else {
    change = max(-susp, change);
  }
  
  return susp + change;
}

void main() {
  // Initial procedural terrain generation on first pass
  if (u_initialized < 0.5) {
    float rock = 0.0;
    float sand = 0.0;

    if (u_terrain_type < 0.5) {
      // Realistic terrain (FBM noise)
      vec2 p = v_uv * u_terrain_scale + vec2(u_seed);
      rock = fbm(p);
      rock = pow(rock, u_terrain_sharpness) * 2.1;
      
      // Add tilt based on X axis
      rock += (v_uv.x - 0.5) * u_terrain_tilt;
      
      // Ensure rock doesn't go negative before sand calculation
      rock = max(0.0, rock);
      
      // Place initial sand in valleys and add a uniform layer everywhere
      sand = max(0.0, 0.16 - rock) * 1.5 + u_terrain_sand_height;
    } else {
      // Flat terrain
      rock = u_flat_rock_height;
      
      // Keep support for tilt even for flat terrain (useful for physics testing)
      rock += (v_uv.x - 0.5) * u_terrain_tilt;
      rock = max(0.0, rock);
      
      sand = u_terrain_sand_height;
    }
    
    fragColor = vec4(rock, sand, 0.0, 1.0);
    return;
  }

  // Read current state
  float rock, sand, suspended_sand, water, lava;
  getCellData(v_uv, rock, sand, suspended_sand, water, lava);

  // Compute sand sliding changes (cellular automata)
  vec2 texel = 1.0 / vec2(u_grid_size);
  vec2 dirs[8] = vec2[](
    vec2(-1.0, 0.0), vec2(1.0, 0.0),
    vec2(0.0, -1.0), vec2(0.0, 1.0),
    vec2(-1.0, -1.0), vec2(1.0, -1.0),
    vec2(-1.0, 1.0), vec2(1.0, 1.0)
  );
  float dists[8] = float[](
    1.0, 1.0, 1.0, 1.0,
    1.414, 1.414, 1.414, 1.414
  );

  float sand_in = 0.0;
  float sand_out = 0.0;

  for (int i = 0; i < 8; i++) {
    vec2 n_uv = clamp(v_uv + dirs[i] * texel, 0.0, 1.0);
    sand_in += computeSandFlow(n_uv, v_uv, dists[i]);
    sand_out += computeSandFlow(v_uv, n_uv, dists[i]);
  }

  // Reaction: Erosion / Deposition based on Carrying Capacity
  float ground_sand_change = 0.0;
  float local_susp = suspended_sand;
  
  if (water <= 0.001) {
    ground_sand_change = suspended_sand; // water evaporated, drop all sand
    local_susp = 0.0;
  } else {
    vec4 f = texture(u_texFlux, v_uv);
    float total_flux = f.r + f.g + f.b + f.a;
    float velocity = total_flux / water;
    
    float depth_multiplier = 1.0;
    if (u_min_water_depth > 0.0) {
      depth_multiplier = smoothstep(u_min_water_depth * 0.5, u_min_water_depth * 1.5, water);
    }
    
    float capacity = (velocity * velocity * velocity) * water * u_capacity_factor * 2.0 * depth_multiplier;
    
    float diff = capacity - suspended_sand;
    
    // Settling velocity increases as speed goes to 0 (less turbulent)
    float active_dep_rate = mix(1.0, u_deposition_rate, clamp(velocity * 5.0, 0.0, 1.0));
    float active_rate = (diff > 0.0) ? u_erosion_rate : active_dep_rate;
    
    float change = diff * active_rate;
    if (change > 0.0) {
      change = min(sand, change);
    } else {
      change = max(-suspended_sand, change);
    }
    
    ground_sand_change = -change;
    local_susp = suspended_sand + change;
  }
  
  sand = max(0.0, sand - sand_out + sand_in + ground_sand_change);
  
  // Advection: Transport of suspended sand
  float susp_out = 0.0;
  if (water > 0.001) {
    vec4 f = texture(u_texFlux, v_uv);
    float total_flux = f.r + f.g + f.b + f.a;
    susp_out = local_susp * min(1.0, total_flux / water);
  }

  float susp_in = 0.0;
  // Left neighbor flows Right (g)
  if (v_uv.x > texel.x) {
    vec2 n_uv = v_uv + vec2(-1.0, 0.0) * texel;
    float n_w = texture(u_texB, n_uv).r;
    if (n_w > 0.001) {
      susp_in += getNewSuspended(n_uv) * min(1.0, texture(u_texFlux, n_uv).g / n_w);
    }
  }
  // Right neighbor flows Left (r)
  if (v_uv.x < 1.0 - texel.x) {
    vec2 n_uv = v_uv + vec2(1.0, 0.0) * texel;
    float n_w = texture(u_texB, n_uv).r;
    if (n_w > 0.001) {
      susp_in += getNewSuspended(n_uv) * min(1.0, texture(u_texFlux, n_uv).r / n_w);
    }
  }
  // Bottom neighbor flows Top (a)
  if (v_uv.y > texel.y) {
    vec2 n_uv = v_uv + vec2(0.0, -1.0) * texel;
    float n_w = texture(u_texB, n_uv).r;
    if (n_w > 0.001) {
      susp_in += getNewSuspended(n_uv) * min(1.0, texture(u_texFlux, n_uv).a / n_w);
    }
  }
  // Top neighbor flows Bottom (b)
  if (v_uv.y < 1.0 - texel.y) {
    vec2 n_uv = v_uv + vec2(0.0, 1.0) * texel;
    float n_w = texture(u_texB, n_uv).r;
    if (n_w > 0.001) {
      susp_in += getNewSuspended(n_uv) * min(1.0, texture(u_texFlux, n_uv).b / n_w);
    }
  }

  // Boundary condition: Sand falls off the map (infinite drain to prevent stacking) under behavior 1 (pass all)
  if (u_border_behavior == 1.0) {
    if (v_uv.x <= texel.x || v_uv.x >= 1.0 - texel.x || v_uv.y <= texel.y || v_uv.y >= 1.0 - texel.y) {
      sand_in = 0.0;
      susp_in = 0.0;
      local_susp = 0.0;
    }
  }

  suspended_sand = max(0.0, local_susp - susp_out + susp_in);

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
  suspended_sand = clamp(suspended_sand, 0.0, 10.0);

  fragColor = vec4(rock, sand, suspended_sand, 1.0);
}
