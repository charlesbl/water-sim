precision highp float;
precision highp sampler2D;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_texA; // Updated Terrain state
uniform sampler2D u_texB; // Previous Fluids state
uniform sampler2D u_texFlux; // Calculated water fluxes
uniform sampler2D u_texLavaFlux; // Calculated lava fluxes

// Brush settings
uniform float u_brush_active;
uniform vec2 u_brush_uv;
uniform float u_brush_radius;
uniform float u_brush_type;
uniform float u_brush_strength;

// Parameters
uniform float u_grid_size;
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
    float react = min(0.002, lava);
    lava = max(0.0, lava - react);
    water = max(0.0, water - react * 2.0); // Evaporates water faster
  }
}

void main() {
  if (u_initialized < 0.5) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float ground, water, lava;
  getCellData(v_uv, ground, water, lava);

  vec2 texel = 1.0 / vec2(u_grid_size);

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

  // LAVA VOLUME UPDATE (Virtual Pipe Model)
  vec4 my_lava_flux = texture(u_texLavaFlux, v_uv);
  float lava_out = my_lava_flux.r + my_lava_flux.g + my_lava_flux.b + my_lava_flux.a;
  float lava_in = 0.0;
  
  // In from Left neighbor
  if (v_uv.x > texel.x) lava_in += texture(u_texLavaFlux, v_uv + vec2(-1.0, 0.0) * texel).g;
  // In from Right neighbor
  if (v_uv.x < 1.0 - texel.x) lava_in += texture(u_texLavaFlux, v_uv + vec2(1.0, 0.0) * texel).r;
  // In from Bottom neighbor
  if (v_uv.y > texel.y) lava_in += texture(u_texLavaFlux, v_uv + vec2(0.0, -1.0) * texel).a;
  // In from Top neighbor
  if (v_uv.y < 1.0 - texel.y) lava_in += texture(u_texLavaFlux, v_uv + vec2(0.0, 1.0) * texel).b;

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

  // Boundary condition: Destroy liquids at bounds (infinite drain)
  if (v_uv.x <= texel.x || v_uv.x >= 1.0 - texel.x || v_uv.y <= texel.y || v_uv.y >= 1.0 - texel.y) {
    water = 0.0;
    lava = 0.0;
  }

  water = clamp(water, 0.0, 10.0);
  lava = clamp(lava, 0.0, 10.0);

  float temp = lava > 0.01 ? 1.0 : 0.0;
  fragColor = vec4(water, lava, 0.0, temp);
}
