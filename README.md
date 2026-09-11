# TerraGPU - Regional Weather & Terrain Simulation

🚀 **Live Demo:** [https://charlesbl.github.io/water-sim/](https://charlesbl.github.io/water-sim/)

An interactive GPU sandbox inspired by _From Dust_, coupling water, sand, soil, lava and terrain to **two horizontal atmospheric layers**. This experimental branch, `codex/two-layer-weather`, replaces the 96 × 96 × 64 atmosphere with **256 × 256 × 2 cells**. The existing **2048 × 2048** terrain and surface-fluid simulation retains its resolution and flow parameters.

The default game region is nominally **10 km wide**, with roughly **2 km air-mass features** and a **180-second regional evolution time**. These are game scales, not a calibrated forecast. The deployed demo may still use the older model.

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
- **Regional Weather:**
  - Lower air exchanges heat and moisture with the landscape; upper air transports clouds and most precipitation.
  - Conservative horizontal vapor/cloud/rain/snow transport, terrain lifting, convection and exchanges between layers.
  - Regional energy sustains evolving thermal contrasts and curved winds. This represents the surrounding weather system; it never adds water or directly creates rain. Set **Regional energy** to 0 for isolated, decaying weather.
  - Cloud maturation delays rain so evaporated water can reach inland areas. Shallow fog produces rain more slowly than upper clouds.
  - Snow albedo, thermal inertia, cloud shading, infrared cooling, evaporation, freezing and thawing couple the atmosphere to the existing terrain.
  - Mild, Snow, Thaw, Storm and Dry presets. **Restart air** preserves terrain, water, snow and ice.
  - A closed water cycle by default, with periodic atmospheric edges or closed walls. Manual rain and open surface boundaries remain available when the cycle is opened.
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

The world opens with the inspector closed and the Water power selected. **Climate → Regional weather** exposes landscape scale, air-mass size, regional energy, regional evolution time, cloud-to-rain time and mountain influence. **Advanced** adds thermal contrasts, seed, wind shear, turning and mixing controls. Regional energy is enabled by default: a small isolated atmosphere otherwise loses its initial contrasts and settles into local recycling above water.

Humidity and stability are initial conditions applied by **Restart air**. Reference temperature and wind, pattern scale and contrasts also shape the live regional environment when regional energy is enabled. Set that energy to 0 to test freely evolving air. Solar forcing, rain timing, relief response and surface feedbacks remain live. Presets restart the air while preserving the ground; they start a new water-inventory baseline.

The top bar controls pause and provides synchronized shortcuts to **World speed**, **Weather speed**, **Temperature opacity**, and **Cloud opacity** in the right inspector. Set temperature opacity to 0 to hide its overlay; all ten powers and their size/strength controls stay in the bottom dock. A narrow navigation rail on the right opens its inspector directly alongside it. On small screens the domain navigation sits directly below the drawer. The six domains are **World**, **Climate**, **Water & Lava**, **Sediments**, **Observe**, and **Settings**. Select a domain again or press Escape to close its inspector. **Advanced** exposes every parameter of that domain, using two columns on screens at least 1100 px wide. Below 760 px the inspector becomes a bottom drawer.

Every numeric slider has an editable value with its original limits and precision. Type a number and press Enter or leave the field to apply it. Search by a current or former control name to jump to its original control, including advanced or temporarily unavailable settings. Press **/** to focus search. Disabled controls explain their prerequisites and link to the relevant mode. **World** generation controls still regenerate the terrain immediately; their labels say **Regenerates terrain**.

Find the closed water cycle, manual rain, solar evaporation and surface boundaries in **Water & Lava**. **Observe** groups atmospheric views, thermal overlays, visible layers and the complete water inventory. Active thermal and slice views expose their contextual controls without requiring Advanced. **Settings** contains rendering quality, camera help and simulation details. UI interactions never paint through onto the world. Camera shortcuts remain active after using buttons, checkboxes, or sliders, including Space to move faster; text and numeric fields keep the keyboard while editing.

**Closed water cycle** is also enabled by default. Solar evaporation moves available liquid water into the air; condensation and precipitation return it to the surface. Snow and ice melting return liquid water. The total includes water in every reservoir and pending transfers, and is conserved during internal evolution to floating-point precision. **Water inventory** shows that total, its drift from the current balance, and its distribution. Presets, air restarts, resets, and adding or erasing water deliberately change the water inventory and start a new balance.

**Atmosphere boundaries** offers two closed choices: **Periodic** carries air and its water across to the opposite horizontal edge; **Closed walls** blocks outward flow. Both keep ground and ceiling closed. The closed water cycle independently seals surface-water edges, suspends manual rain, and disables humidity forcing. The corresponding controls display their effective settings while preserving your choices for open mode. Disabling the closed cycle restores those choices and permits external water sources or losses; it does not create an open atmospheric boundary.

Choose **Snow** to start with cold, humid air, add some liquid water with the Water brush, and let the weather evolve. Select **Thaw** on the same landscape to initialize warmer air while preserving the accumulated snow and ice. Melting transfers solid water into the liquid water buffer, where it can flow through the existing surface simulation. **Restart air** and the presets preserve the ground and its water reservoirs; **Reset Weather** clears snow and ice as well as restarting the atmosphere.

Ice always forms a solid layer attached to the terrain, with liquid water above it. Freezing consumes available liquid and grows that layer as cooling removes heat; sustained cooling can freeze the entire water column. Melting lowers the solid bed and returns the same water-equivalent mass to liquid. Only the submerged portion of snow interacts with liquid water: available heat melts it, while the remainder compacts into anchored ice. Traces of rain or meltwater therefore leave the snowpack intact, and snow on dry terrain can accumulate. This is a deliberate simplification for the 2.5D model: it does not reproduce the floating ice cover of a real lake. There is one liquid reservoir per column, with no floating sheets, ice mechanics, or stacked layers of liquid.

Use **Observe → Explore atmosphere** for clouds, temperature, humidity, wind, **Rain & snow radar**, or **Recent wetness**. Temperature/humidity/wind maps select either lower air or the cloud layer. Wetness records recent rainfall with a three-minute decay; it is not groundwater or a vegetation simulation. Cloud base, thickness and detail are visual controls independent of the simulated water inventory. **Pause** freezes simulation while leaving the camera usable.

Surface fluids advance at a fixed **60 Hz**, weather at **20 Hz**. Both use elapsed time and bounded catch-up. **World speed** scales both clocks; **Weather speed** additionally scales weather. Under sustained GPU overload, catch-up limits can slow simulated time. Evaporation now gives a shallow water film roughly a three-minute drying time at the default rate, allowing rain to collect and flow through the existing river solver.

The **Ice** brush adds solid ice beneath the water. **Erase** also removes snow and ice. **Heat** and **Cool** add or remove surface heat using the brush size and strength; deep water responds more slowly. Enable **Simulate weather** and resume the simulation for progressive freezing and melting. Adding or erasing ice resets the water-inventory baseline; thermal brushes preserve the water inventory.

Move the camera with W/A/S/D and Q/E; hold the middle mouse button to look around. Space accelerates movement and Shift slows it down.

See [the two-layer design and test recipes](docs/regional-weather.md). Historical 3D atmosphere tests and optimization fixtures describe the previous model; vegetation is not implemented on this branch.

### Checks

Start Vite, then run:

```bash
npm run test:weather
npm run typecheck
npm run lint
npm run build
```

The weather command runs:

- `regional-ui`: real panel bindings, numeric limits, search, presets, layer legends and preferences.
- `regional-weather-full`: full 256² × 2 atmospheric grid; rain/dry areas, eleven-minute sea-to-inland transport, persistent changing winds, closed/wall water inventories, freezing/thawing and rain timing.
- `regional-integration`: full 2048² terrain/water coupling, CPU/GPU water-budget comparison and all six weather views plus thermal overlays.
- `bottom-ice`, `snow-cover`, `sediments`: retained surface freezing, snow/ice, fluid-flow and erosion regressions.

Set `CHROME_PATH`, `TEST_BASE_URL` or `TEST_VERBOSE=1` as needed. Tests use a separate Chrome profile. The long atmospheric test runs at 256² surface resolution to isolate the atmosphere; full-resolution coupling is tested separately.

Historical 3D pressure/projection, volume-slice and A/B benchmark pages remain as references and are not compatible with the two-layer solver. The older `ui` inventory and `brushes` suites also fail on the unmodified parent commit; this branch has dedicated current-panel coverage. Existing `run-ui.mjs` is available for general responsive layout checks. GPU-time gains have not been benchmarked against the old model: the structural reduction is 589,824 → 131,072 air cells and removal of iterative 3D pressure projection.

---

## Deployment

This project is configured to automatically deploy to GitHub Pages via **GitHub Actions**.

Whenever changes are pushed to the `main` branch, the workflow defined in [deploy.yml](.github/workflows/deploy.yml) triggers automatically, builds the project using the configured base URL in [vite.config.ts](vite.config.ts), and deploys the build artifacts to GitHub Pages.

Temperature overlay in **Observe** uses a fixed −30 to +35 °C scale. Select **Surface** or **Air above surface** and adjust opacity. Air sampling interpolates between the two terrain-following layer temperatures; the 16-unit reference layer depth is for accounting, independent of rendered cloud altitude. Selecting a weather map disables this overlay. Painting, erasing and camera controls remain available.

### Soil and sand regression

Open `/water-sim/tests/sediments.html` on the Vite server, or run `node tests/run-gpu.mjs sediments` with Chrome installed, to exercise the production GPU shaders: layered generation, soil painting and erasing, steep slope stability, protected soil, identical erosion rates, separate transport and deposition, and sediment conservation. The suite also checks hydraulic rest above a varying soil bed and the atmospheric surface elevation. Set `CHROME_PATH` or `TEST_BASE_URL` if needed.

Terrain cells use six floats (rock, sand, suspended sand, avalanche flags, soil, suspended soil); fluid and weather surface cells still use four. The controls display all repose angles in degrees on the same 0–89° range: 70° static / 55° dynamic for soil, and 43° static / 20° dynamic for sand at the default grid and height scale. The GPU stores height differences per cell; the UI converts using the grid spacing and height scale. Lowering the angle lets an existing pile spread. Increasing it permits steeper slopes without rebuilding the pile, and it cannot flatten the underlying rock. Each material’s dynamic angle cannot exceed its static angle. Both retain independent avalanche histories: a pile starts moving above its static threshold and continues toward its dynamic threshold. The existing avalanche channel packs the two flags (sand = 1, soil = 2), without enlarging terrain buffers.

Run `node tests/run-gpu.mjs repose sediments` to check the production angle controls, their conversion to GPU parameters, the response of an existing soil pile when the angle changes, independent sand/soil hysteresis, and identical behavior when both materials have matching angles.
