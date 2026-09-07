# TerraGPU - 3D Atmosphere & Terrain Simulation

🚀 **Live Demo:** [https://charlesbl.github.io/water-sim/](https://charlesbl.github.io/water-sim/)

An interactive GPU sandbox inspired by _From Dust_, with a **volumetric 3D atmosphere** coupled to water, sand, lava, and terrain. Weather evolves in a separate **48 × 48 × 32 grid (73,728 cells)** using WebGPU compute shaders. The existing terrain and surface fluids remain a 2.5D heightfield.

This is a qualitative miniature weather model for experimentation, with simplified units and physical processes. It is not a calibrated forecasting model. The live demo above reflects the latest deployed version and may differ from the current working tree.

---

## Features

- **Interactive Brushes:**
  - **Water & Lava:** Paint dynamic, physics-based fluids.
  - **Sand:** Deposit sand that interacts with fluid flows.
  - **Terrain Editing:** Dynamically raise or dig the terrain.
  - **Eraser:** Clear fluids instantly.
- **Fluid & Erosion Simulation:**
  - Dynamic shallow water equation solver.
  - Ice forms a solid layer on the bed, and the remaining liquid flows above it in the existing 2.5D solver.
  - Cooling freezes available water progressively; melting returns the same water-equivalent mass to the liquid reservoir.
  - Sediment transport, erosion, and deposition model.
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
  - Beautiful glassmorphic UI overlay.
  - Layer visibility toggles (Rock, Sand, Water, Lava, Suspended Sand/Mud).
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

The **3D Atmosphere** panel opens by default in emergent mode. Temperature, humidity, and wind sliders specify **initial air conditions**. Apply them with **Restart air**; the solar controls and radiative cooling affect the running simulation immediately. Temperature and wind then evolve through surface heating, cooling, air transport, and buoyancy. Forced mode is available when you want continuous reference conditions.

**Closed water cycle** is also enabled by default. Solar evaporation moves available liquid water into the air; condensation and precipitation return it to the surface. Snow and ice melting return liquid water. The total includes water in every reservoir and pending transfers, and is conserved during internal evolution to floating-point precision. **Water inventory** shows that total, its drift from the current balance, and its distribution. Presets, air restarts, resets, and adding or erasing water deliberately change the water inventory and start a new balance.

**Atmosphere boundaries** offers two closed choices: **Periodic** carries air and its water across to the opposite horizontal edge; **Closed walls** blocks outward flow. Both keep ground and ceiling closed. The closed water cycle independently seals surface-water edges, suspends manual rain, and disables humidity forcing. The corresponding controls display their effective settings while preserving your choices for open mode. Disabling the closed cycle restores those choices and permits external water sources or losses; it does not create an open atmospheric boundary.

Choose **Snow** to start with cold, humid air, add some liquid water with the Water brush, and let the weather evolve. Select **Thaw** on the same landscape to initialize warmer air while preserving the accumulated snow and ice. Melting transfers solid water into the liquid water buffer, where it can flow through the existing surface simulation. **Restart air** and the presets preserve the ground and its water reservoirs; **Reset Weather** clears snow and ice as well as restarting the atmosphere.

Ice always forms a solid layer attached to the terrain, with liquid water above it. Freezing consumes available liquid and grows that layer as cooling removes heat; sustained cooling can freeze the entire water column. Melting lowers the solid bed and returns the same water-equivalent mass to liquid. Snow falling into liquid water joins that reservoir and cools it through melting, while snow on dry terrain can accumulate. This is a deliberate simplification for the 2.5D model: it does not reproduce the floating ice cover of a real lake. There is one liquid reservoir per column, with no floating sheets, ice mechanics, or stacked layers of liquid.

Use **Explore atmosphere** to switch between cloud volume and temperature, humidity, or wind slices. **Slice altitude** moves the diagnostic plane through the volume. The wind view includes 3D vectors; **Show 3D wind vectors** also overlays them on the other views. **Pause** freezes the simulation while the camera remains usable. **Simulate weather** suspends the atmosphere independently of the surface fluids.

Surface fluids advance at a fixed 60 Hz, and the atmosphere and its thermal exchanges at 30 Hz. Snow inundated by surface water also melts during the surface-fluid steps. Both clocks use elapsed time instead of frame count, with bounded catch-up after slow frames. **Simulation Speed** scales both clocks; **Weather speed** additionally scales the atmospheric clock. Under sustained GPU overload, the catch-up limits can slow simulated time.

The **Ice** brush adds solid ice beneath the water. **Erase** also removes snow and ice. **Heat** and **Cool** add or remove surface heat using the brush size and strength; deep water responds more slowly. Enable **Simulate weather** and resume the simulation for progressive freezing and melting. Adding or erasing ice resets the water-inventory baseline; thermal brushes preserve the water inventory.

Move the camera with W/A/S/D and Q/E; hold the middle mouse button to look around. Space accelerates movement and Shift slows it down.

See [the atmospheric implementation and manual checks](docs/atmosphere-3d.md) for the model's scope, controls, and limitations. The older [climate and vegetation roadmap](docs/climate-vegetation/README.md) describes a separate 2.5D design; it is not the implementation contract for this 3D atmosphere, and vegetation is not implemented here.

### GPU checks

The additional `/water-sim/tests/brushes.html` page verifies ice addition and erasure, local heating/cooling, thermal inertia, and the resulting conservative freezing/melting.

With the Vite server running, open these pages in a WebGPU browser:

- `/water-sim/tests/atmosphere.html`: volume transport, emerging circulation, freezing, snow and ice melting, liquid recovery, pause, resets, smooth deposition, and rendering integration.
- `/water-sim/tests/water-cycle.html`: evaporation from initially dry air, condensation, precipitation, return to the ground and re-evaporation, total water conservation over thousands of steps, both boundary modes, terrain obstruction, stored steam, and the GPU inventory against an independent CPU sum.
- `/water-sim/tests/bottom-ice.html`: gradual and complete freezing, melting, snow falling into water, solid ice geometry beneath the water, liquid flow over the frozen bed, and water conservation.
- `/water-sim/tests/air-masses.html`: circulation from initially resting air, moisture rising and moving beyond a lake, persistent clouds over land, pressure projection, thermal stability, and the complete water inventory.

Each page reports individual results and stops at a failure. `npm run typecheck`, `npm run lint`, and `npm run build` complement these runtime checks; shader execution must be checked in a WebGPU browser.

---

## Deployment

This project is configured to automatically deploy to GitHub Pages via **GitHub Actions**.

Whenever changes are pushed to the `main` branch, the workflow defined in [deploy.yml](.github/workflows/deploy.yml) triggers automatically, builds the project using the configured base URL in [vite.config.ts](vite.config.ts), and deploys the build artifacts to GitHub Pages.

Temperature overlay is available at the top of **3D Atmosphere**. It tints the
normal landscape with a fixed −30 to +35 °C scale (colors saturate outside that
range). Choose **Surface** or **Air above
surface**, adjust opacity, and set air height in simulation units. Air sampling
follows the physical surface including water, snow and ice. Its coarser grid has
3.125-unit vertical layers; samples near terrain use the first valid air layer,
and points above the sampled domain have no air overlay.

Painting, erasing and camera controls remain available with the overlay visible.
The overlay returns to the
normal cloud view; selecting an atmospheric slice disables the overlay. Pausing
or disabling weather keeps the stored temperatures available for inspection.
