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

// Simplex 2D noise
vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x, 289.0); }
float snoise(vec2 v){
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
           -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy) );
  vec2 x0 = v -   i + dot(i, C.xx);
  vec2 i1;
  i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 ))
  + i.x + vec3(0.0, i1.x, 1.0 ));
  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy),
    dot(x12.zw,x12.zw)), 0.0);
  m = m*m ;
  m = m*m ;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
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

// Bilinear interpolation for flux to prevent blocky flow directions
vec4 get_smooth_flux(vec2 uv) {
  vec2 texel = 1.0 / vec2(u_grid_size);
  vec2 p = uv * u_grid_size - 0.5;
  vec2 f = fract(p);
  vec2 i = floor(p) * texel + texel * 0.5;
  
  vec4 tl = texture(u_texFlux, i);
  vec4 tr = texture(u_texFlux, i + vec2(texel.x, 0.0));
  vec4 bl = texture(u_texFlux, i + vec2(0.0, texel.y));
  vec4 br = texture(u_texFlux, i + texel);
  
  vec4 tA = mix(tl, tr, f.x);
  vec4 tB = mix(bl, br, f.x);
  return mix(tA, tB, f.y);
}

// Line Integral Convolution (LIC) blur to create flow-aligned streaks
float get_streak(vec2 uv, vec2 dir, float n_scale) {
  float step_size = 0.4 / n_scale; 
  float acc = 0.0;
  acc += snoise((uv - dir * step_size * 3.0) * n_scale);
  acc += snoise((uv - dir * step_size * 2.0) * n_scale);
  acc += snoise((uv - dir * step_size * 1.0) * n_scale);
  acc += snoise(uv * n_scale);
  acc += snoise((uv + dir * step_size * 1.0) * n_scale);
  acc += snoise((uv + dir * step_size * 2.0) * n_scale);
  acc += snoise((uv + dir * step_size * 3.0) * n_scale);
  return acc * 0.1428 * 1.5 + 0.5; // average and map to roughly 0-1
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
    float water_mask = smoothstep(0.001, 0.005, v_water);
    if (water_mask > 0.0) {
      // Read flux to compute flow velocity with bilinear smoothing
      vec4 flux = get_smooth_flux(v_uv);
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

      // Use a logarithmic response to balance small and large flows visually
      float visual_speed = log(1.0 + speed * 50.0);
      float foam_mask = smoothstep(0.1, 1.5, visual_speed);
      
      vec2 dir = normalize(flowDir + vec2(0.0001));
      
      // Flow map time cycles
      float flow_time = u_time * visual_speed * 1.5;
      float cycle1 = fract(flow_time);
      float cycle2 = fract(flow_time + 0.5);
      
      float weight1 = 1.0 - abs(cycle1 - 0.5) * 2.0;
      float weight2 = 1.0 - abs(cycle2 - 0.5) * 2.0;
      
      // Advect UVs without rotating space, preventing circular Moire
      vec2 uv1 = v_uv - dir * (cycle1 * 0.03);
      vec2 uv2 = v_uv - dir * (cycle2 * 0.03);
      
      float n_scale = 1000.0;
      float streak1 = get_streak(uv1, dir, n_scale);
      float streak2 = get_streak(uv2, dir, n_scale);
      
      float streak = streak1 * weight1 + streak2 * weight2;
      
      float current_foam = foam_mask * smoothstep(0.55, 0.70, streak);
      
      water_body_col = mix(water_body_col, vec3(1.0), current_foam * 0.7);

      vec3 sky_refl = vec3(0.65, 0.8, 1.0) * (u_sun_color + vec3(0.1));
      vec3 water_shaded = mix(water_body_col, sky_refl + vec3(spec_water), fresnel);
      
      // Base transparency (slightly more transparent than before)
      float base_alpha = mix(0.85, 0.65, transmission);
      float water_alpha = mix(base_alpha, 1.0, fresnel);

      finalColor = mix(finalColor, vec4(water_shaded, water_alpha), water_mask);
    }

    fragColor = finalColor;
  }
}
