# Painted weather

## Gameplay contract

The player draws precipitation intensity. The drawing stays in place and does not deplete, spread or drift. At every cell, precipitation is `cloud intensity × precipitation strength × elapsed time`. Fine terrain, liquid flow and erosion determine where that water goes next. Climate settings change energy input/output, never replace temperature or melt an entire landscape on a settings change.

Cloud intensity is clamped to 0–2 with a smooth brush falloff. Brush strength controls how quickly the intensity is built or removed. Clear sky removes only intensity. Weather can be held independently to edit a drawing; one World speed scales both running clocks. Pause also permits manual brushes.

## Surface climate

Each surface cell retains a temperature with material-dependent heat capacity. Four neighboring cells exchange heat symmetrically using their capacities. A separate exchange pass avoids reading temperatures while another cell is changing them.

Absorbed sunlight depends on sun direction, the local surface normal, cloud shade and material albedo. Albedo strength multiplies reflectivity before clamping to 0–1: zero gives equal absorbed sunlight across materials, one preserves normal reflectivity and two doubles it. Water and dry land still respond at different rates because heat capacity is independent of reflectivity. There is no separate material-dependent cooling multiplier.

Three points define radiative cooling versus scene altitude:

| Point  | Altitude           | Cooling strength |
| ------ | ------------------ | ---------------- |
| Low    | 0                  | Editable         |
| Middle | Editable, 0.5–31.5 | Editable         |
| High   | 32                 | Editable         |

The segments interpolate linearly and meet continuously. Values clamp beyond the endpoints. The altitude reference is fixed: raising a remote mountain never changes the climate of an untouched valley. Higher strength removes energy faster; it is not a target temperature. Infrared loss also varies smoothly with the current absolute temperature. Sun intensity zero with positive cooling progressively chills the whole map.

Rain/snow phase blends smoothly between −1 and +1 °C at the receiving surface. Freezing, melting and evaporation consume or release latent energy and change the same liquid-equivalent reservoirs. Snow and ice melt progressively after heat impulses or climate changes. Manual Heat/Cool and hot/cold Nuke impulses modify local stored heat; diffusion and radiative exchange subsequently evolve it. Nuke is a one-shot impulse, not a permanent heat source.

Ice forms a solid bed attached to the terrain, with liquid above it. Snow geometry uses **2.5 × water-equivalent depth**, half the previous thickness at equal water mass. Only submerged snow interacts with liquid: available heat melts that portion; the remaining submerged portion compacts into bed ice. Trace rain therefore does not collapse a dry snowpack.

## Rendering and causal readability

Painted intensity drives the volume and precipitation overlay. Rendering opacity, detail, base altitude and thickness do not change precipitation or temperature. The visual shadow and absorbed sunlight use the same cloud-transmission function. Surface orientation modulates sunlight; there is no additional terrain shadow-ray simulation.

The cloud base uses a broad upper envelope of the surface rather than each terrain cell's height. A 32² canopy takes neighborhood maxima of a summary that retains the maximum fine-cell height. Bilinear interpolation connects the canopy heights. Every corner influencing a position includes its underlying terrain, leaving at least **14 scene units** above the exposed surface, including exceptional peaks. The default minimum altitude is 40. Nearby valleys are bridged; large mountain ranges can lift a broad part of the layer. The raymarch bounds include the maximum canopy height so tall peaks do not clip the volume.

Rain and snow are falling particles below the cloud base. There is no opaque precipitation fog filling that gap. While the cloud brush or a diagnostic overlay is selected, cloud opacity is reduced to keep the drawing surface readable. Other views show the configured opacity.

## Brushes and boundaries

| Selected power | Right mouse action                                                           |
| -------------- | ---------------------------------------------------------------------------- |
| Water / Lava   | Remove that fluid only                                                       |
| Sand / Soil    | Remove that material, including its suspended reservoir                      |
| Ice            | Remove snow and ice; leave liquid water                                      |
| Clouds         | Thin cloud intensity only                                                    |
| Raise / Dig    | Apply the opposite terrain action                                            |
| Heat / Cool    | Apply the opposite thermal action                                            |
| Nuke           | Apply a cold impulse with the same footprint                                 |
| Erase          | Remove rock, sand, soil, suspended sediment, fluids, frozen cover and clouds |

Brushes are soft and strength-dependent. Erase leaves temperature in place, because temperature is a state rather than a removable material.

Walls suppress outgoing edge flux. Passthrough permits outward water/lava flux and transports carried sand/soil out with water. Incoming flux is zero. Dry ground does not slide through the border. The water-inventory reduction measures actual outgoing water flux, including corner edges, after the hydraulic flux pass.

## Implementation map

| Module                                                          | Responsibility                                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/weather.ts`, `shaders/weather.wgsl`                        | Initialization, painted cloud clearing, thermal evolution, precipitation and render summaries |
| `src/shaders/surfaceThermal.wgsl`                               | Shared capacities, reflectivity, cloud transmission and submerged-snow transfer               |
| `src/weatherRenderer.ts`, `shaders/renderWeather.wgsl`          | Cloud volumes, precipitation particles and weather overlays                                   |
| `src/coolingCurve.ts`, `src/weatherControls.ts`                 | Three-point editing and live climate controls                                                 |
| `src/brushes.ts`, `src/nuke.ts`                                 | Inverse brush actions and one-shot thermal powers                                             |
| `src/shaders/simFlux.wgsl`, `simFluids.wgsl`, `simTerrain.wgsl` | Existing hydraulic/erosion solver and selected-material removal                               |
| `src/shaders/boundaryFlux.wgsl`                                 | Water drainage measurement                                                                    |
| `src/waterBudget.ts`, `src/energyBudget.ts`                     | GPU inventory and applied radiative-flow readbacks                                            |

Surface state is a full-resolution `vec4(snow SWE, ice SWE, temperature, cloud intensity)`. Diffusion scratch holds exchange energy and incident sunlight. A render summary up to 256² holds mean height, cloud intensity, temperature and maximum height. A 32² canopy plus one maximum-height value bounds cloud rendering. The weather does not allocate or evolve atmospheric air, vapor, pressure or velocity fields.

Surface fluids advance at 60 Hz; thermal weather advances at 20 Hz, scaled by the same World speed. Both clocks use elapsed time and bounded catch-up. Under sustained GPU overload, the cap can slow simulated time. Weather summaries refresh during paused editing. Terrain regeneration initializes a new thermal field; live climate and visualization changes preserve it.

Rain is an external water input; evaporation and boundary drainage are external outputs. Clouds and cosmetic steam are excluded from stored water. The inventory sums liquid + snow SWE + ice SWE and accounts for measured external exchanges when reporting numerical drift. Manual water additions/removal and regeneration start a fresh baseline. Radiative diagnostics display applied absorbed sunlight, outgoing cooling and their difference; they do not claim total energy conservation for the coupled hydraulic/terrain system.

Settings are versioned as `painted-weather-v1`. Removed settings are neither restored nor saved; incompatible previous weather settings use new defaults. Camera and compatible terrain/fluid preferences remain. The world buffers are not serialized.

## Checks and limits

`npm run test:weather` runs production GPU fixtures for rain localization and proportionality, stable painting, cold precipitation, continuous phase blending, climate-change inertia, progressive melting/freezing and water conservation, local heat diffusion, heat pulses, solar shade/albedo, cloud clearance, snow thickness, selected-material erasing, wall/outflow behavior, sediment conservation, repose and picking. UI and preferences have separate runners documented in the README.

This is a controllable game climate. It has one local surface temperature, no advected fluid-temperature field, no floating ice mechanics and no closed atmospheric water cycle. Clouds do not form automatically from evaporation. The canopy is spatially smooth but can move immediately after terrain edits. These choices keep the player's drawn rain and cooling profile legible while allowing rivers, lakes and erosion to supply the emergence.
