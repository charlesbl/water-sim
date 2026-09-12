# TerraGPU - Regional Weather & Terrain Simulation

🚀 **Live Demo:** [https://charlesbl.github.io/water-sim/](https://charlesbl.github.io/water-sim/)

An interactive GPU sandbox inspired by _From Dust_, coupling water, sand, soil, lava and terrain to **two horizontal atmospheric layers**. This experimental branch, `codex/two-layer-weather`, replaces the 96 × 96 × 64 atmosphere with **256 × 256 × 2 cells**. The existing **2048 × 2048** terrain and surface-fluid simulation retains its resolution and flow parameters.

The default game region is nominally **10 km wide**, with roughly **2 km air-mass features** and a sealed atmospheric boundary. These are game scales, not a calibrated forecast. The deployed demo may still use the older model.

---

## Features

- **Interactive Brushes:**
  - A colored circle and center mark preview the exact brush radius on the terrain, following its relief before and during painting. The preview updates with the camera and hides over the interface or sky.
  - **Water & Lava:** Paint dynamic, physics-based fluids.
  - **Sand & Soil:** Paint sand or brown soil. The layers are rock → soil → sand. Both materials use exactly the same physics and shared rates; only their static and dynamic repose angles differ.
  - **Terrain Editing:** Dynamically raise or dig the terrain.
  - **Eraser:** Clear fluids instantly.
- **Fluid & Erosion Simulation:**
  - Dynamic shallow water equation solver.
  - Ice forms a solid layer on the bed, and the remaining liquid flows above it in the existing 2.5D solver.
  - Cooling freezes available water progressively; melting returns the same water-equivalent mass to the liquid reservoir.
  - Water erodes exposed sand first, then the underlying soil. Both materials share a carrying capacity, travel separately with the flow, and settle back into their own layers; dry cells deposit all remaining sediment. Sealed walls retain both sediment inventories.
  - Interactive sliders for fluid parameters (gravity and damping).
  - Permanently closed walls for fluids, sediments and air.
- **Climate in a Bottle:**
  - Lower air exchanges heat and moisture with the landscape; upper air transports clouds and most precipitation.
  - Conservative horizontal vapor/cloud/rain/snow transport, terrain lifting, convection and exchanges between layers.
  - No prescribed regional circulation, wind target, temperature target or humidity reservoir. Initial wind is zero by default.
  - Cloud maturation delays rain so evaporated water can reach inland areas. Shallow fog produces rain more slowly than upper clouds.
  - Snow albedo, thermal inertia, cloud shading, infrared cooling, evaporation, freezing and thawing couple the atmosphere to the existing terrain.
  - **Restart air** applies initial conditions while preserving terrain, water, snow and ice.
  - A permanently closed water cycle. Sunlight in and infrared out are the only automatic boundary energy inputs/outputs; brushes and resets are manual interventions.
  - A compact collapsible **Energy** panel on the left shows absorbed sunlight, escaping infrared and their difference, read from the GPU.
  - Live inventory accounts for liquid, snow, ice, vapor, clouds, airborne precipitation, steam and pending evaporation.
  - Reconstructed volumetric clouds, low fog, rain/snow particles, shadows and wind tracers. Maps show temperature, humidity, wind, current precipitation or recent rain history.
- **Visuals & Customization:**
  - Observatory-style command UI with a persistent power dock, time controls, searchable settings, and an expandable inspector.
  - Layer visibility toggles (Rock, Soil, Sand, Water, Lava, Suspended Sand & Soil/Mud).
  - Free camera and smooth rendering modes.
  - Built-in real-time performance indicator (FPS).

---

## Getting Started

### Prerequisites

You will need [Node.js](https://nodejs.org/) and a browser/device with WebGPU support. Run from localhost or HTTPS. The default surface grid is 2048 × 2048 and needs substantial GPU memory; lowering **Mesh Resolution** reduces rendering work without changing either simulation grid.

### Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/charlesbl/water-sim.git
   cd water-sim
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

### Local Development

Run the Vite development server locally:

```bash
npm run dev
```

Open the local URL (usually `http://localhost:5173`) in your web browser.

### Production Build

To build the application for production:

```bash
npm run build
```

This generates optimized static files inside the `dist/` directory.

### Exploring the weather

The world opens with the inspector closed and the Water power selected. **Climate** separates initial conditions (air temperature, humidity, stability, a lower-air impulse whose return is pressure-solved, and spatial contrasts) from live parameters (layer exchange, cloud-to-rain time and terrain response). **Restart air** applies initial values while preserving ground water, snow and ice; **Reset weather** also clears snow and ice. Each manual reset starts a new water-inventory baseline.

The bottle has permanently sealed walls, with no periodic wrapping, external rain, humidity thermostat or sustained regional wind. Sunlight and infrared radiation are configured in **Sun**, along with surface evaporation. Land/water heating differences come from local albedo and heat capacity; the artificial solar-contrast redistribution is removed. The previous extra evaporation shortcut and permanent lava heating are removed; painting lava supplies a finite manual heat pulse. The wind now uses independent MAC velocities in both layers and at their vertical interface. Conservative momentum transport and a coupled multigrid pressure projection let currents travel and find return paths through the closed domain. Thermal buoyancy and mechanical dissipation retain explicit sensible-heat counterparts; this remains a simplified thermal-work model rather than a complete atmospheric energy model.

Open **Energy** on the left for `Sun absorbed → bottle → IR to space` and **IN − OUT**. Values are game energy units per weather second, measured from applied GPU radiative fluxes. Reflected sunlight is excluded from the absorbed input; infrared reabsorbed inside the atmosphere is an internal transfer. Paused or disabled weather shows zero applied exchange. This is a boundary-flow readout, not a proof that the existing numerical model conserves total stored energy. Brushes and resets are explicitly outside this readout.

**Climate** exposes **Thermal expansion**, **Air friction**, **Air viscosity**, **Pressure quality** and **Surface–air heat exchange**. Friction defaults to 0.006 /s near the ground and is ten times weaker aloft; pressure quality defaults to three multigrid cycles. The old default friction is migrated while changed values are retained. The **Updrafts & downdrafts** view shows the signed vertical flow, and wind tracers include vertical motion.

**Cloud adjustment** controls how quickly condensation/evaporation converts stored latent energy into air heating/cooling. **Rain evaporation** lets falling rain cool dry lower air before reaching the ground, feeding cold-pool circulation through the coupled buoyancy/pressure response. Both act live and accept zero to isolate their effects. Surface evaporation and condensation now share the same latent cost; sensible heat carried across the air/surface boundary has paired debits and credits. **Sun → Cloud sun shielding** already affected heating and now shares its attenuation law with visible shadows. These internal feedbacks add no prescribed wind or cooling source; sustained moving showers still need gameplay validation.

The top bar contains the view selector, a shared view opacity, pause, and **World speed** / **Weather speed** shortcuts. The right-hand domains are **World**, **Climate**, **Sun**, **Water & Lava**, **Sediments**, **Observe**, and **Settings**. Select a domain again or press Escape to close its inspector. All controls are available without an Advanced mode. Every numeric slider has an editable value with its limits and precision; search jumps directly to a control. **World** generation settings regenerate terrain immediately.

**Observe** contains rendering adjustments, visible layers and the complete water inventory. The inventory includes liquid, snow, ice, vapor, clouds, airborne precipitation, steam and pending evaporation. Manual additions, erasing and resets start a new baseline. The ten powers and brush controls remain in the bottom dock; UI interactions do not paint through onto the world.

Ice always forms a solid layer attached to the terrain, with liquid water above it. Freezing consumes available liquid and grows that layer as cooling removes heat; sustained cooling can freeze the entire water column. Melting lowers the solid bed and returns the same water-equivalent mass to liquid. Only the submerged portion of snow interacts with liquid water: available heat melts it, while the remainder compacts into anchored ice. Traces of rain or meltwater therefore leave the snowpack intact, and snow on dry terrain can accumulate. This is a deliberate simplification for the 2.5D model: it does not reproduce the floating ice cover of a real lake. There is one liquid reservoir per column, with no floating sheets, ice mechanics, or stacked layers of liquid.

Use the top-bar view selector for clouds, surface/layer temperature, humidity, wind, **Rain & snow radar**, or **Recent wetness**. Temperature/humidity/wind maps select either lower air or the cloud layer. Wetness records recent rainfall with a three-minute decay; it is not groundwater or a vegetation simulation. Cloud base, thickness and detail are visual controls independent of the simulated water inventory. **Pause** freezes simulation while leaving the camera usable.

Surface fluids advance at a fixed **60 Hz**, weather at **20 Hz**. Both use elapsed time and bounded catch-up. **World speed** scales both clocks; **Weather speed** additionally scales weather. Under sustained GPU overload, catch-up limits can slow simulated time. Evaporation now gives a shallow water film roughly a three-minute drying time at the default rate, allowing rain to collect and flow through the existing river solver.

The **Ice** brush adds solid ice beneath the water. **Erase** also removes snow and ice. **Heat** and **Cool** add or remove surface heat using the brush size and strength; deep water responds more slowly. Enable **Simulate weather** and resume the simulation for progressive freezing and melting. Adding or erasing ice resets the water-inventory baseline; thermal brushes preserve the water inventory.

Move the camera with W/A/S/D and Q/E; hold the middle mouse button to look around. Space accelerates movement and Shift slows it down.

See [the bottle model and validation notes](docs/regional-weather.md). See also [the MAC wind design](docs/mac-wind.md). Historical 3D atmosphere tests and optimization fixtures describe the previous model; vegetation is not implemented on this branch.

### Checks

Minimum checks passed on September 12, 2026: **typecheck, production build and four targeted suites (47 assertions)**. A reserved WGSL entry-point name was fixed during GPU validation. The existing `npm run test:weather` suites still contain regional-forcing and obsolete-control expectations and need adaptation before broader validation. Earlier results for regional weather do not validate the bottle model.

A dedicated `bottle-circulation` GPU suite is prepared but has not been run. Broader validation should cover radiative GPU sums, energy-panel pause/reset behavior, full-resolution coupling, and retained water/ice/snow/sediment behavior. Lint, performance and visual review remain pending. See [the model notes](docs/regional-weather.md) for the separate total-energy conservation limitation.

The `mac-pressure`, `mac-momentum` and updated `wind-brush` suites **passed**, covering pressure at 256², same-direction layer currents, moving vortex pairs, the mechanical/thermal balance of that isolated case, brush propagation, walls and the shared Courant limiter. `mac-wind-ui` **passed** for the wind controls, resets and preference migration.

`bottle-feedbacks` is also prepared, **not run**, for condensation, rain cooling, cold-pool circulation, paired evaporation/deposition heat, snow formation and solar shielding. Those feedback controls and their individual resets still need interface validation.

---

## Deployment

This project is configured to automatically deploy to GitHub Pages via **GitHub Actions**.

Whenever changes are pushed to the `main` branch, the workflow defined in [deploy.yml](.github/workflows/deploy.yml) triggers automatically, builds the project using the configured base URL in [vite.config.ts](vite.config.ts), and deploys the build artifacts to GitHub Pages.

The top-bar temperature view uses a fixed −30 to +35 °C scale. Select **Surface**, **Lower air** or **Cloud layer** and adjust shared opacity. The 16-unit reference layer depth is for accounting, independent of rendered cloud altitude.

### Soil and sand regression

Open `/water-sim/tests/sediments.html` on the Vite server, or run `node tests/run-gpu.mjs sediments` with Chrome installed, to exercise the production GPU shaders: layered generation, soil painting and erasing, steep slope stability, protected soil, identical erosion rates, separate transport and deposition, and sediment conservation. The suite also checks hydraulic rest above a varying soil bed and the atmospheric surface elevation. Set `CHROME_PATH` or `TEST_BASE_URL` if needed.

Terrain cells use six floats (rock, sand, suspended sand, avalanche flags, soil, suspended soil); fluid and weather surface cells still use four. The controls display all repose angles in degrees on the same 0–89° range: 70° static / 55° dynamic for soil, and 43° static / 20° dynamic for sand at the default grid and height scale. The GPU stores height differences per cell; the UI converts using the grid spacing and height scale. Lowering the angle lets an existing pile spread. Increasing it permits steeper slopes without rebuilding the pile, and it cannot flatten the underlying rock. Each material’s dynamic angle cannot exceed its static angle. Both retain independent avalanche histories: a pile starts moving above its static threshold and continues toward its dynamic threshold. The existing avalanche channel packs the two flags (sand = 1, soil = 2), without enlarging terrain buffers.

Run `node tests/run-gpu.mjs repose sediments` to check the production angle controls, their conversion to GPU parameters, the response of an existing soil pile when the angle changes, independent sand/soil hysteresis, and identical behavior when both materials have matching angles.
