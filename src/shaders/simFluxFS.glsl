precision highp float;
precision highp sampler2D;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_texA; // Terrain state
uniform sampler2D u_texB; // Fluids state
uniform sampler2D u_texFlux; // Previous fluxes

uniform float u_grid_size;
uniform float u_gravity;
uniform float u_damping;
uniform float u_initialized;
uniform float u_is_lava;

void getCellData(vec2 uv, out float solid, out float fluid) {
  vec4 a = texture(u_texA, uv);
  vec4 b = texture(u_texB, uv);
  
  if (u_is_lava > 0.5) {
    solid = a.r + a.g; // rock + sand
    fluid = b.g;       // lava
  } else {
    solid = a.r + a.g + b.g; // rock + sand + lava
    fluid = b.r;             // water
  }
}

void main() {
  if (u_initialized < 0.5) {
    fragColor = vec4(0.0);
    return;
  }

  float solid, fluid;
  getCellData(v_uv, solid, fluid);
  vec4 flux = texture(u_texFlux, v_uv);

  vec2 texel = 1.0 / vec2(u_grid_size);
  vec2 dirs[4] = vec2[](
    vec2(-1.0, 0.0), vec2(1.0, 0.0),
    vec2(0.0, -1.0), vec2(0.0, 1.0)
  );

  float h_src = solid + fluid;
  float g_dt = u_gravity * 0.016;

  // Update fluxes
  for (int i = 0; i < 4; i++) {
    vec2 n_uv = clamp(v_uv + dirs[i] * texel, 0.0, 1.0);
    float n_solid, n_fluid;
    getCellData(n_uv, n_solid, n_fluid);
    float h_n = n_solid + n_fluid;
    
    float diff = h_src - h_n;
    
    if (i == 0) flux.r = max(0.0, flux.r * u_damping + diff * g_dt);
    else if (i == 1) flux.g = max(0.0, flux.g * u_damping + diff * g_dt);
    else if (i == 2) flux.b = max(0.0, flux.b * u_damping + diff * g_dt);
    else if (i == 3) flux.a = max(0.0, flux.a * u_damping + diff * g_dt);
  }

  // Boundary conditions
  if (v_uv.x <= texel.x) flux.r = 0.0;
  if (v_uv.x >= 1.0 - texel.x) flux.g = 0.0;
  if (v_uv.y <= texel.y) flux.b = 0.0;
  if (v_uv.y >= 1.0 - texel.y) flux.a = 0.0;

  // Scale fluxes to prevent draining more fluid than exists
  float sum_flux = flux.r + flux.g + flux.b + flux.a;
  if (sum_flux > 0.0) {
    float K = min(1.0, fluid / sum_flux);
    flux *= K;
  }

  fragColor = flux;
}
