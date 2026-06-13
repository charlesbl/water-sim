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
