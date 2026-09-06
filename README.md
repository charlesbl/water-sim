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
  - Sediment transport, erosion, and deposition model.
  - Interactive sliders for fluid parameters (gravity, damping, evaporation).
  - Map border behaviors (block all, pass all, pass water only).
- **3D Atmosphere:**
  - A three-component wind field, 3D advection, convection, and pressure projection.
  - Temperature, humidity, condensation, clouds, and precipitation throughout the volume.
  - Surface snow accumulation, ice formation, and melting back into liquid water.
  - Emergent weather by default: temperature, humidity, and wind evolve from their initial state without being pulled toward slider targets.
  - Solar intensity and direction, radiative cooling, surface heat exchange, thermal inertia, snow albedo, and buoyancy drive local changes.
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

Use **Explore atmosphere** to switch between cloud volume and temperature, humidity, or wind slices. **Slice altitude** moves the diagnostic plane through the volume. The wind view includes 3D vectors; **Show 3D wind vectors** also overlays them on the other views. **Pause** freezes the simulation while the camera remains usable. **Simulate weather** suspends the atmosphere independently of the surface fluids.

Move the camera with W/A/S/D and Q/E; hold the middle mouse button to look around. Space accelerates movement and Shift slows it down.

See [the atmospheric implementation and manual checks](docs/atmosphere-3d.md) for the model's scope, controls, and limitations. The older [climate and vegetation roadmap](docs/climate-vegetation/README.md) describes a separate 2.5D design; it is not the implementation contract for this 3D atmosphere, and vegetation is not implemented here.

### GPU checks

With the Vite server running, open these pages in a WebGPU browser:

- `/water-sim/tests/atmosphere.html`: volume transport, emerging circulation, freezing, snow and ice melting, liquid recovery, pause, resets, smooth deposition, and rendering integration.
- `/water-sim/tests/water-cycle.html`: evaporation from initially dry air, condensation, precipitation, return to the ground and re-evaporation, total water conservation over thousands of steps, both boundary modes, terrain obstruction, stored steam, and the GPU inventory against an independent CPU sum.

Each page reports individual results and stops at a failure. `npm run typecheck`, `npm run lint`, and `npm run build` complement these runtime checks; shader execution must be checked in a WebGPU browser.

---

## Deployment

This project is configured to automatically deploy to GitHub Pages via **GitHub Actions**.

Whenever changes are pushed to the `main` branch, the workflow defined in [deploy.yml](.github/workflows/deploy.yml) triggers automatically, builds the project using the configured base URL in [vite.config.ts](vite.config.ts), and deploys the build artifacts to GitHub Pages.
