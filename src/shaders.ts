/**
 * GLSL ES 3.0 Shaders for GPGPU Physics and Custom Terrain Rendering.
 */

// Vertex Shader for GPGPU fullscreen quad rendering
export const simVS = `
  out vec2 v_uv;
  void main() {
    v_uv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

// Fragment Shader for Pass A (Terrain & Sand Simulation)
export const simTerrainFS = `
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
    for (int i = 0; i < 5; ++i) {
      v += a * noise(p);
      p = rot * p * 2.1 + vec2(10.0);
      a *= 0.48;
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

    // Water/Lava interaction: convert lava to rock in-place
    if (water > 0.01 && lava > 0.01) {
      rock += lava;
      lava = 0.0;
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
      vec2 p = v_uv * 6.0 + vec2(u_seed);
      float rock = fbm(p);
      rock = pow(rock, 1.4) * 2.1; // Exaggerate peaks, make mountains 3x higher and create more valleys
      
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
`;

// Fragment Shader for Pass B1 (Flux Simulation: Water momentum)
export const simFluxFS = `
  precision highp float;
  precision highp sampler2D;

  in vec2 v_uv;
  out vec4 fragColor;

  uniform sampler2D u_texA; // Terrain state
  uniform sampler2D u_texB; // Fluids state
  uniform sampler2D u_texFlux; // Previous fluxes

  uniform float u_grid_size;
  uniform float u_water_gravity;
  uniform float u_water_damping;
  uniform float u_initialized;

  void getCellData(vec2 uv, out float solid, out float water) {
    vec4 a = texture(u_texA, uv);
    vec4 b = texture(u_texB, uv);
    solid = a.r + a.g + b.g; // rock + sand + lava
    water = b.r;
  }

  void main() {
    if (u_initialized < 0.5) {
      fragColor = vec4(0.0);
      return;
    }

    float solid, water;
    getCellData(v_uv, solid, water);
    vec4 flux = texture(u_texFlux, v_uv);

    vec2 texel = 1.0 / vec2(u_grid_size);
    vec2 dirs[4] = vec2[](
      vec2(-1.0, 0.0), vec2(1.0, 0.0),
      vec2(0.0, -1.0), vec2(0.0, 1.0)
    );

    float h_src = solid + water;
    float g_dt = u_water_gravity * 0.016;

    // Update fluxes
    for (int i = 0; i < 4; i++) {
      vec2 n_uv = clamp(v_uv + dirs[i] * texel, 0.0, 1.0);
      float n_solid, n_water;
      getCellData(n_uv, n_solid, n_water);
      float h_n = n_solid + n_water;
      
      float diff = h_src - h_n;
      
      if (i == 0) flux.r = max(0.0, flux.r * u_water_damping + diff * g_dt);
      else if (i == 1) flux.g = max(0.0, flux.g * u_water_damping + diff * g_dt);
      else if (i == 2) flux.b = max(0.0, flux.b * u_water_damping + diff * g_dt);
      else if (i == 3) flux.a = max(0.0, flux.a * u_water_damping + diff * g_dt);
    }

    // Boundary conditions
    if (v_uv.x <= texel.x) flux.r = 0.0;
    if (v_uv.x >= 1.0 - texel.x) flux.g = 0.0;
    if (v_uv.y <= texel.y) flux.b = 0.0;
    if (v_uv.y >= 1.0 - texel.y) flux.a = 0.0;

    // Scale fluxes to prevent draining more water than exists
    float sum_flux = flux.r + flux.g + flux.b + flux.a;
    if (sum_flux > 0.0) {
      // Allow max outflow to be the total water volume. K is scaling factor.
      float K = min(1.0, water / sum_flux);
      flux *= K;
    }

    fragColor = flux;
  }
`;

// Fragment Shader for Pass B2 (Fluids Simulation: Water & Lava)
export const simFluidsFS = `
  precision highp float;
  precision highp sampler2D;

  in vec2 v_uv;
  out vec4 fragColor;

  uniform sampler2D u_texA; // Updated Terrain state
  uniform sampler2D u_texB; // Previous Fluids state
  uniform sampler2D u_texFlux; // Calculated water fluxes

  // Brush settings
  uniform float u_brush_active;
  uniform vec2 u_brush_uv;
  uniform float u_brush_radius;
  uniform float u_brush_type;
  uniform float u_brush_strength;

  // Parameters
  uniform float u_grid_size;
  uniform float u_lava_viscosity;
  uniform float u_evaporation;
  uniform float u_initialized;

  void getCellData(vec2 uv, out float ground, out float water, out float lava) {
    vec4 a = texture(u_texA, uv);
    vec4 b = texture(u_texB, uv);
    
    float rock = a.r;
    float sand = a.g;
    water = b.r;
    lava = b.g;

    ground = rock + sand;

    if (water > 0.01 && b.g > 0.01) {
      lava = 0.0;
      water = max(0.0, water - 0.05);
    }
  }

  // Calculate flow of liquid from src to dst (LAVA ONLY)
  float computeLavaFlow(vec2 src_uv, vec2 dst_uv) {
    float src_ground, src_water, src_lava;
    getCellData(src_uv, src_ground, src_water, src_lava);

    if (src_lava <= 0.0001) return 0.0;

    float rate = u_lava_viscosity;
    float h_src = src_ground + src_water + src_lava;

    float dst_ground, dst_water, dst_lava;
    getCellData(dst_uv, dst_ground, dst_water, dst_lava);
    float h_dst = dst_ground + dst_water + dst_lava;

    float diff = h_src - h_dst;
    if (diff > 0.00001) {
      float sum_diff = 0.0;
      vec2 texel = 1.0 / vec2(u_grid_size);
      vec2 dirs[4] = vec2[](
        vec2(-1.0, 0.0), vec2(1.0, 0.0),
        vec2(0.0, -1.0), vec2(0.0, 1.0)
      );

      for (int i = 0; i < 4; i++) {
        vec2 n_uv = clamp(src_uv + dirs[i] * texel, 0.0, 1.0);
        float n_ground, n_water, n_lava;
        getCellData(n_uv, n_ground, n_water, n_lava);
        float h_n = n_ground + n_water + n_lava;
        float n_diff = h_src - h_n;
        if (n_diff > 0.0) sum_diff += n_diff;
      }

      if (sum_diff > 0.0) {
        float max_out = sum_diff * 0.2;
        float total_out = min(src_lava * rate, max_out);
        return total_out * (diff / sum_diff);
      }
    }
    return 0.0;
  }

  void main() {
    if (u_initialized < 0.5) {
      fragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    float ground, water, lava;
    getCellData(v_uv, ground, water, lava);

    vec2 texel = 1.0 / vec2(u_grid_size);
    vec2 dirs[4] = vec2[](
      vec2(-1.0, 0.0), vec2(1.0, 0.0),
      vec2(0.0, -1.0), vec2(0.0, 1.0)
    );

    // WATER VOLUME UPDATE (Virtual Pipe Model)
    vec4 my_flux = texture(u_texFlux, v_uv);
    float water_out = my_flux.r + my_flux.g + my_flux.b + my_flux.a;
    float water_in = 0.0;
    
    // In from Left neighbor
    if (v_uv.x > texel.x) water_in += texture(u_texFlux, v_uv + vec2(-1.0, 0.0) * texel).g;
    // In from Right neighbor
    if (v_uv.x < 1.0 - texel.x) water_in += texture(u_texFlux, v_uv + vec2(1.0, 0.0) * texel).r;
    // In from Bottom neighbor
    if (v_uv.y > texel.y) water_in += texture(u_texFlux, v_uv + vec2(0.0, -1.0) * texel).a;
    // In from Top neighbor
    if (v_uv.y < 1.0 - texel.y) water_in += texture(u_texFlux, v_uv + vec2(0.0, 1.0) * texel).b;

    water = max(0.0, water - water_out + water_in);

    // LAVA VOLUME UPDATE (Viscous Cellular Automata)
    float lava_in = 0.0;
    float lava_out = 0.0;
    for (int i = 0; i < 4; i++) {
      vec2 n_uv = clamp(v_uv + dirs[i] * texel, 0.0, 1.0);
      lava_in += computeLavaFlow(n_uv, v_uv);
      lava_out += computeLavaFlow(v_uv, n_uv);
    }
    lava = max(0.0, lava - lava_out + lava_in);

    // Evaporate water slowly
    if (water > 0.0) {
      water = max(0.0, water - u_evaporation);
    }

    // Brush painting interface
    if (u_brush_active > 0.5) {
      float dist = distance(v_uv, u_brush_uv);
      if (dist < u_brush_radius) {
        float falloff = 1.0 - smoothstep(u_brush_radius * 0.2, u_brush_radius, dist);
        float amount = falloff * u_brush_strength * 0.06;

        if (u_brush_type == 0.0) water += amount * 1.5;
        else if (u_brush_type == 1.0) lava += amount;
        else if (u_brush_type == 5.0) {
          water = max(0.0, water - amount * 5.0);
          lava = max(0.0, lava - amount * 5.0);
        }
      }
    }

    water = clamp(water, 0.0, 10.0);
    lava = clamp(lava, 0.0, 10.0);

    float temp = lava > 0.01 ? 1.0 : 0.0;
    fragColor = vec4(water, lava, 0.0, temp);
  }
`;

// Vertex Shader for terrain visualization
export const renderVS = `
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
`;

// Fragment Shader for terrain visualization
export const renderFS = `
  precision highp float;
  precision highp sampler2D;

  in vec2 v_uv;
  in vec3 v_pos;
  in float v_rock;
  in float v_sand;
  in float v_water;
  in float v_lava;

  out vec4 fragColor;

  uniform sampler2D u_texA;
  uniform sampler2D u_texB;
  uniform sampler2D u_texFlux;
  uniform float u_height_scale;
  uniform float u_grid_size;
  uniform float u_view_mode; // 0: Realistic, 1: Heightmap, 2: Water Only, 3: Lava Only, 4: Sand Only
  uniform float u_time;
  uniform float u_layer;

  uniform vec3 u_sun_dir;      // Light direction in local space
  uniform vec3 u_sun_color;    // Diffuse light color
  uniform vec3 u_local_camera_pos; // Camera position in local space

  // Pseudo-random noise for textures
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i + vec2(0.0,0.0)), hash(i + vec2(1.0,0.0)), u.x),
               mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), u.x), u.y);
  }

  // Get total height (rock + sand + water + lava) at given UV
  float get_height(vec2 uv) {
    vec4 a = texture(u_texA, uv);
    vec4 b = texture(u_texB, uv);
    return a.r + a.g + b.r + b.g;
  }

  // Get ground height (rock + sand) at given UV
  float get_ground_height(vec2 uv) {
    vec4 a = texture(u_texA, uv);
    return a.r + a.g;
  }

  void main() {
    vec2 texel = 1.0 / vec2(u_grid_size);
    vec3 view_dir = normalize(u_local_camera_pos - v_pos);

    if (u_layer < 0.5) {
      // -------------------------------------------------------------
      // TERRAIN LAYER
      // -------------------------------------------------------------
      if (u_view_mode == 2.0 || u_view_mode == 3.0) discard;

      if (u_view_mode == 1.0) { // Heightmap (Rock)
        fragColor = vec4(vec3(v_rock * 1.5), 1.0);
        return;
      } else if (u_view_mode == 4.0) { // Sand Only
        fragColor = vec4(0.85, 0.75, 0.3, v_sand > 0.01 ? 1.0 : 0.0);
        if (v_sand <= 0.01) discard;
        return;
      }

      float hL = get_ground_height(v_uv - vec2(texel.x, 0.0));
      float hR = get_ground_height(v_uv + vec2(texel.x, 0.0));
      float hD = get_ground_height(v_uv - vec2(0.0, texel.y));
      float hU = get_ground_height(v_uv + vec2(0.0, texel.y));

      float spacing = 100.0 / u_grid_size;
      vec3 normal = normalize(vec3(
        (hL - hR) * u_height_scale,
        (hD - hU) * u_height_scale,
        2.0 * spacing
      ));

      float diff = max(0.05, dot(normal, u_sun_dir));

      vec3 rock_base = vec3(0.32, 0.29, 0.27);
      float r_noise = noise(v_uv * 180.0) * 0.08;
      vec3 rock_color = rock_base + vec3(r_noise);

      vec3 sand_base = vec3(0.88, 0.72, 0.42);
      float s_noise = noise(v_uv * 200.0) * 0.04;
      vec3 sand_color = sand_base + vec3(s_noise);

      float slope = 1.0 - normal.z; 
      float sand_mask = smoothstep(0.01, 0.15, v_sand) * (1.0 - smoothstep(0.35, 0.6, slope));
      vec3 ground_color = mix(rock_color, sand_color, sand_mask);

      vec3 terrain_lit = ground_color * (diff * u_sun_color + vec3(0.12));
      fragColor = vec4(terrain_lit, 1.0);

    } else {
      // -------------------------------------------------------------
      // FLUID LAYER
      // -------------------------------------------------------------
      if (v_water <= 0.001 && v_lava <= 0.001) discard;
      if (u_view_mode == 1.0 || u_view_mode == 4.0) discard;

      if (u_view_mode == 2.0) { // Water Only
        fragColor = vec4(0.0, 0.4, 1.0, v_water > 0.01 ? 1.0 : 0.0);
        if (v_water <= 0.01) discard;
        return;
      } else if (u_view_mode == 3.0) { // Lava Only
        fragColor = vec4(1.0, 0.25, 0.0, v_lava > 0.01 ? 1.0 : 0.0);
        if (v_lava <= 0.01) discard;
        return;
      }

      float hL = get_height(v_uv - vec2(texel.x, 0.0));
      float hR = get_height(v_uv + vec2(texel.x, 0.0));
      float hD = get_height(v_uv - vec2(0.0, texel.y));
      float hU = get_height(v_uv + vec2(0.0, texel.y));

      float spacing = 100.0 / u_grid_size;
      vec3 normal = normalize(vec3(
        (hL - hR) * u_height_scale,
        (hD - hU) * u_height_scale,
        2.0 * spacing
      ));

      float diff = max(0.05, dot(normal, u_sun_dir));
      vec4 finalColor = vec4(0.0);

      // Lava
      float lava_mask = smoothstep(0.01, 0.1, v_lava);
      if (lava_mask > 0.0) {
        float crust_pattern = noise(v_uv * 45.0 + vec2(u_time * 0.04));
        float crust = smoothstep(0.36, 0.55, crust_pattern);

        vec3 glowing_lava = vec3(2.2, 0.45, 0.01);
        vec3 basalt_crust = vec3(0.1, 0.09, 0.09) * (diff * u_sun_color + vec3(0.05));
        vec3 lava_base_col = mix(glowing_lava, basalt_crust, crust);

        if (crust < 0.2) {
          lava_base_col += vec3(0.4, 0.08, 0.0) * (1.0 - crust * 5.0);
        }

        finalColor = mix(finalColor, vec4(lava_base_col, 1.0), lava_mask);
      }

      // Water
      float water_mask = smoothstep(0.01, 0.1, v_water);
      if (water_mask > 0.0) {
        // Read flux to compute flow velocity
        vec4 flux = texture(u_texFlux, v_uv);
        vec2 flowDir = vec2(flux.g - flux.r, flux.a - flux.b);
        float speed = length(flowDir);

        vec3 r_water = reflect(-u_sun_dir, normal);
        float spec_water = pow(max(0.0, dot(r_water, view_dir)), 80.0) * 0.8;

        float fresnel = 0.02 + 0.98 * pow(1.0 - max(0.0, dot(normal, view_dir)), 5.0);

        vec3 shallow_water_col = vec3(0.0, 0.9, 0.8);
        vec3 deep_water_col = vec3(0.0, 0.1, 0.45);
        
        float depth = v_water * 15.0;
        float transmission = exp(-depth);
        vec3 water_body_col = mix(deep_water_col, shallow_water_col, transmission);

        // Add visual foam/streaks based on current speed
        float foam_mask = smoothstep(0.001, 0.01, speed);
        vec2 flowUV = v_uv * 400.0 - normalize(flowDir + vec2(0.0001)) * (u_time * speed * 200.0);
        float streak = noise(flowUV);
        float current_foam = foam_mask * smoothstep(0.4, 0.6, streak);
        
        water_body_col = mix(water_body_col, vec3(1.0), current_foam * 0.7);

        vec3 sky_refl = vec3(0.65, 0.8, 1.0) * (u_sun_color + vec3(0.1));
        vec3 water_shaded = mix(water_body_col, sky_refl + vec3(spec_water), fresnel);
        
        // Increase opacity of shallow water (was 0.35, changed to 0.7)
        float base_alpha = mix(0.9, 0.7, transmission);
        float water_alpha = mix(base_alpha, 1.0, fresnel);

        finalColor = mix(finalColor, vec4(water_shaded, water_alpha), water_mask);
      }

      fragColor = finalColor;
    }
  }
`;
