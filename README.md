# TerraGPU - 3D Atmosphere & Terrain Simulation

🚀 **Live Demo:** [https://charlesbl.github.io/water-sim/](https://charlesbl.github.io/water-sim/)

An interactive GPU sandbox inspired by _From Dust_, with a **volumetric 3D atmosphere** coupled to water, sand, soil, lava, and terrain. Weather evolves in a separate **96 × 96 × 64 grid (589,824 cells)** using WebGPU compute shaders. The existing terrain and surface fluids remain a 2.5D heightfield.

This is a qualitative miniature weather model for experimentation, with simplified units and physical processes. It is not a calibrated forecasting model. The live demo above reflects the latest deployed version and may differ from the current working tree.

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
  - Water erodes exposed sand first, then the underlying soil. Both materials share a carrying capacity, travel separately with the flow, and settle back into their own layers; dry cells deposit all remaining sediment. Closed and water-only borders conserve each sediment inventory.
  - Interactive sliders for fluid parameters (gravity, damping, evaporation).
  - Map border behaviors (block all, pass all, pass water only).
- **3D Atmosphere:**
  - A three-component wind field, 3D advection, convection, and pressure projection.
  - Temperature, humidity, condensation, clouds, and precipitation throughout the volume.
  - Surface snow accumulation, ice formation, and melting back into liquid water.
  - Emergent weather by default: temperature, humidity, and wind evolve from their initial state without being pulled toward slider targets.
  - Solar intensity and direction, radiative cooling, surface heat exchange, thermal inertia, snow albedo, and buoyancy drive local changes.
  - Moist convection couples rising-air cooling with condensation heat, humidity buoyancy, and condensate loading; land–water heating contrasts can create circulation without imposed wind.
  - Cloud droplets remain airborne while a slower growth process forms precipitation, allowing clouds to travel before releasing their water.
  - Initial air conditions and Mild, Snow, Thaw, and Storm presets; restarting the air preserves the terrain, liquid water, snow, and ice.
  - A closed water cycle by default: vapor, cloud water, rain, snow, ice, and liquid water exchange mass through conservative transfers, within floating-point precision.
  - Live water inventory and reservoir breakdown, with a new balance after adding or erasing water, applying a preset, or resetting.
  - Periodic atmospheric edges that wrap air to the opposite side, or closed walls; ground and ceiling remain closed.
  - An optional forced mode maintains temperature and wind reference conditions; humidity forcing is available only with the closed cycle disabled.
  - Smooth precipitation transfer between the atmosphere and surface, with area-normalized deposition to avoid coarse grid boundaries in snow.
  - Volumetric cloud rendering, 3D wind vectors, and adjustable horizontal slices for temperature, humidity, and wind speed.
  - Manual rain and open surface edges remain available when the closed cycle is disabled.
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

The world opens with the inspector closed and the Water power selected. Choose **Climate** on the right to explore the atmosphere, which starts in emergent mode. Temperature, humidity, and wind sliders specify **initial air conditions**. Apply them with **Restart air**; the solar controls and radiative cooling under **Advanced** affect the running simulation immediately. Temperature and wind then evolve through surface heating, cooling, air transport, and buoyancy. Forced mode is available when you want continuous reference conditions.

The top bar controls pause and provides synchronized shortcuts to **World speed**, **Weather speed**, **Temperature opacity**, and **Cloud opacity** in the right inspector. Set temperature opacity to 0 to hide its overlay; all ten powers and their size/strength controls stay in the bottom dock. A narrow navigation rail on the right opens its inspector directly alongside it. On small screens the domain navigation sits directly below the drawer. The six domains are **World**, **Climate**, **Water & Lava**, **Sediments**, **Observe**, and **Settings**. Select a domain again or press Escape to close its inspector. **Advanced** exposes every parameter of that domain, using two columns on screens at least 1100 px wide. Below 760 px the inspector becomes a bottom drawer.

Every numeric slider has an editable value with its original limits and precision. Type a number and press Enter or leave the field to apply it. Search by a current or former control name to jump to its original control, including advanced or temporarily unavailable settings. Press **/** to focus search. Disabled controls explain their prerequisites and link to the relevant mode. **World** generation controls still regenerate the terrain immediately; their labels say **Regenerates terrain**.

Find the closed water cycle, manual rain, solar evaporation and surface boundaries in **Water & Lava**. **Observe** groups atmospheric views, thermal overlays, visible layers and the complete water inventory. Active thermal and slice views expose their contextual controls without requiring Advanced. **Settings** contains rendering quality, camera help and simulation details. UI interactions never paint through onto the world. Camera shortcuts remain active after using buttons, checkboxes, or sliders, including Space to move faster; text and numeric fields keep the keyboard while editing.

**Closed water cycle** is also enabled by default. Solar evaporation moves available liquid water into the air; condensation and precipitation return it to the surface. Snow and ice melting return liquid water. The total includes water in every reservoir and pending transfers, and is conserved during internal evolution to floating-point precision. **Water inventory** shows that total, its drift from the current balance, and its distribution. Presets, air restarts, resets, and adding or erasing water deliberately change the water inventory and start a new balance.

**Atmosphere boundaries** offers two closed choices: **Periodic** carries air and its water across to the opposite horizontal edge; **Closed walls** blocks outward flow. Both keep ground and ceiling closed. The closed water cycle independently seals surface-water edges, suspends manual rain, and disables humidity forcing. The corresponding controls display their effective settings while preserving your choices for open mode. Disabling the closed cycle restores those choices and permits external water sources or losses; it does not create an open atmospheric boundary.

Choose **Snow** to start with cold, humid air, add some liquid water with the Water brush, and let the weather evolve. Select **Thaw** on the same landscape to initialize warmer air while preserving the accumulated snow and ice. Melting transfers solid water into the liquid water buffer, where it can flow through the existing surface simulation. **Restart air** and the presets preserve the ground and its water reservoirs; **Reset Weather** clears snow and ice as well as restarting the atmosphere.

Ice always forms a solid layer attached to the terrain, with liquid water above it. Freezing consumes available liquid and grows that layer as cooling removes heat; sustained cooling can freeze the entire water column. Melting lowers the solid bed and returns the same water-equivalent mass to liquid. Only the submerged portion of snow interacts with liquid water: available heat melts it, while the remainder compacts into anchored ice. Traces of rain or meltwater therefore leave the snowpack intact, and snow on dry terrain can accumulate. This is a deliberate simplification for the 2.5D model: it does not reproduce the floating ice cover of a real lake. There is one liquid reservoir per column, with no floating sheets, ice mechanics, or stacked layers of liquid.

Use **Explore atmosphere** to switch between cloud volume and temperature, humidity, or wind slices. **Slice altitude** moves the diagnostic plane through the volume. The wind view includes 3D vectors; **Show 3D wind vectors** also overlays them on the other views. **Pause** freezes the simulation while the camera remains usable. **Simulate weather** suspends the atmosphere independently of the surface fluids.

Surface fluids advance at a fixed 60 Hz, and the atmosphere and its thermal exchanges at 30 Hz. Submerged snow also melts or compacts during the surface-fluid steps, using the same water and energy accounting. Both clocks use elapsed time instead of frame count, with bounded catch-up after slow frames. **World speed** scales both clocks; **Weather speed** additionally scales the atmospheric clock. Under sustained GPU overload, the catch-up limits can slow simulated time.

The **Ice** brush adds solid ice beneath the water. **Erase** also removes snow and ice. **Heat** and **Cool** add or remove surface heat using the brush size and strength; deep water responds more slowly. Enable **Simulate weather** and resume the simulation for progressive freezing and melting. Adding or erasing ice resets the water-inventory baseline; thermal brushes preserve the water inventory.

Move the camera with W/A/S/D and Q/E; hold the middle mouse button to look around. Space accelerates movement and Shift slows it down.

See [the atmospheric implementation and manual checks](docs/atmosphere-3d.md) for the model's scope, controls, and limitations. The older [climate and vegetation roadmap](docs/climate-vegetation/README.md) describes a separate 2.5D design; it is not the implementation contract for this 3D atmosphere, and vegetation is not implemented here.

### GPU checks

With Vite running, **node tests/run-gpu.mjs ui** checks the production HTML and control bindings against the pre-refactor inventory in **tests/ui-baseline.json**. It covers all 64 settings, original ranges, search aliases, numeric edits, dependent controls, presets, actions and keyboard navigation without allocating a simulation GPU.

**node tests/run-ui.mjs** opens the real WebGPU app in an isolated headless Chrome profile, verifies responsive layouts and input isolation, and captures screenshots at 1920 × 1080, 1366 × 768 and 390 × 844 (plus the single-column breakpoint). Screenshots and check results go to a temporary review directory printed by the runner; set **UI_ARTIFACT_DIR** to choose a destination.

The additional `/water-sim/tests/brushes.html` page verifies ice addition and erasure, local heating/cooling, thermal inertia, and the resulting conservative freezing/melting.

With the Vite server running, open these pages in a WebGPU browser:

- `/water-sim/tests/atmosphere.html`: volume transport, emerging circulation, freezing, snow and ice melting, liquid recovery, pause, resets, smooth deposition, and rendering integration.
- `/water-sim/tests/water-cycle.html`: evaporation from initially dry air, condensation, precipitation, return to the ground and re-evaporation, total water conservation over thousands of steps, both boundary modes, terrain obstruction, stored steam, and the GPU inventory against an independent CPU sum.
- `/water-sim/tests/bottom-ice.html`: gradual and complete freezing, melting, snow falling into water, solid ice geometry beneath the water, liquid flow over the frozen bed, and water conservation.
- `/water-sim/tests/snow-cover.html`: trace rain across atmospheric tiles, gradual thaw, warm/cold snow flooding, and water/energy conservation in both fluid and weather steps. Run with `node tests/run-gpu.mjs snow-cover`.
- `/water-sim/tests/surface-heat.html`: continuous air–surface heat exchange and freezing across atmospheric cell boundaries, paired energy conservation, and closed/periodic edges on several surface resolutions.
- `/water-sim/tests/radiation.html`: infrared energy balance between surface, atmosphere and space, upper-air cooling after reduced sunlight, terrain obstruction, and live radiation controls.
- `/water-sim/tests/air-masses.html`: circulation from initially resting air, moisture rising and moving beyond a lake, persistent clouds over land, pressure projection, thermal stability, and the complete water inventory.

Each page reports individual results and stops at a failure. `npm run typecheck`, `npm run lint`, and `npm run build` complement these runtime checks; shader execution must be checked in a WebGPU browser.

The pressure geometry cache has dedicated A/B checks:

- `node tests/run-gpu.mjs pressure-cache` compares the cached solver with the original pressure kernels after 1, 100, and 1,000 weather ticks, with both boundary modes and changing terrain, water, snow, and ice. It also checks every cached face mask against an independent CPU calculation.
- `node tests/run-gpu.mjs pressure-performance` compares both versions on the full 2048² surface with a 1280 × 720 canvas and maximum mesh resolution. It measures one surface tick, two weather ticks, and rendering from identical GPU snapshots, then replays the application's ×4 weather clock. This benchmark requires GPU timestamp queries and substantial GPU memory for snapshots. Set `TEST_VERBOSE=1` in the environment to print timings and samples.

See [the pressure-cache implementation and measured results](docs/optimisation-meteo/01-geometrie-pression.md). The A/B reference contains the three changed pre-cache kernels; all other simulation passes are shared with production. Timing tools and reference switching exist only in the test pages.

The shared water/heat transport and per-cell Courant cache have corresponding checks:

- `node tests/run-gpu.mjs transport` compares face fluxes around the CFL reconstruction threshold, then complete states after 1, 100, and 1,000 ticks, including boundary and terrain changes.
- `node tests/run-gpu.mjs transport-performance` uses the same full-scene benchmark, with the pressure optimization retained in both versions. The reference uses the original transport; optimized timings include Courant preparation as well as advection. Set `TEST_VERBOSE=1` to retain detailed measurements.
- `node tests/run-gpu.mjs transport-courant-performance` isolates the benefit of the Courant cache against shared transport with local Courant calculation.

See [the transport implementation and measured results](docs/optimisation-meteo/02-calculs-transport.md). The frozen reference and all A/B instrumentation are confined to the test pages.

The fine-surface to atmospheric-column mapping table has dedicated checks:

- `node tests/run-gpu.mjs surface-exchange-cache` compares cached neighbors and interpolation fractions with the original GPU expressions, then complete states and energy budgets after 1, 100, and 1,000 ticks with changing boundaries and terrain.
- `node tests/run-gpu.mjs surface-exchange-performance` compares the full 2048² scene against optimizations 1 and 2 alone. It also measures the occasional mapping-table rebuild and checks bit-identical coupled states. Set `TEST_VERBOSE=1` for detailed samples.

See [the surface-exchange implementation and measured results](docs/optimisation-meteo/03-echanges-sol-atmosphere.md). The retained table adds 64 KiB at 2048² and is rebuilt at initialization or when horizontal boundaries change. The larger solar/infrared caches evaluated during this work were removed after performance regressions.

---

## Deployment

This project is configured to automatically deploy to GitHub Pages via **GitHub Actions**.

Whenever changes are pushed to the `main` branch, the workflow defined in [deploy.yml](.github/workflows/deploy.yml) triggers automatically, builds the project using the configured base URL in [vite.config.ts](vite.config.ts), and deploys the build artifacts to GitHub Pages.

Temperature overlay is available in **Observe**. It tints the
normal landscape with a fixed −30 to +35 °C scale (colors saturate outside that
range). Choose **Surface** or **Air above
surface**, adjust opacity, and set air height in simulation units. Air sampling
follows the physical surface including water, snow and ice. Its coarser grid has
1.5625-unit vertical layers; samples near terrain use the first valid air layer,
and points above the sampled domain have no air overlay.

Painting, erasing and camera controls remain available with the overlay visible.
The overlay returns to the
normal cloud view; selecting an atmospheric slice disables the overlay. Pausing
or disabling weather keeps the stored temperatures available for inspection.

### Soil and sand regression

Open `/water-sim/tests/sediments.html` on the Vite server, or run `node tests/run-gpu.mjs sediments` with Chrome installed, to exercise the production GPU shaders: layered generation, soil painting and erasing, steep slope stability, protected soil, identical erosion rates, separate transport and deposition, and sediment conservation. The suite also checks hydraulic rest above a varying soil bed and the atmospheric surface elevation. Set `CHROME_PATH` or `TEST_BASE_URL` if needed.

Terrain cells use six floats (rock, sand, suspended sand, avalanche flags, soil, suspended soil); fluid and weather surface cells still use four. The controls display all repose angles in degrees on the same 0–89° range: 70° static / 55° dynamic for soil, and 43° static / 20° dynamic for sand at the default grid and height scale. The GPU stores height differences per cell; the UI converts using the grid spacing and height scale. Lowering the angle lets an existing pile spread. Increasing it permits steeper slopes without rebuilding the pile, and it cannot flatten the underlying rock. Each material’s dynamic angle cannot exceed its static angle. Both retain independent avalanche histories: a pile starts moving above its static threshold and continues toward its dynamic threshold. The existing avalanche channel packs the two flags (sand = 1, soil = 2), without enlarging terrain buffers.

Run `node tests/run-gpu.mjs repose sediments` to check the production angle controls, their conversion to GPU parameters, the response of an existing soil pile when the angle changes, independent sand/soil hysteresis, and identical behavior when both materials have matching angles.
