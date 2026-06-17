# TerraGPU - 2.5D Fluid Simulation

🚀 **Live Demo:** [https://charlesbl.github.io/water-sim/](https://charlesbl.github.io/water-sim/)

A high-performance interactive 2.5D fluid and terrain simulation running entirely on the GPU, inspired by the mechanics of the game _From Dust_.

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
- **Climate & Weather System:**
  - Realistic rain generator with controls for droplet size and quantity.
- **Visuals & Customization:**
  - Beautiful glassmorphic UI overlay.
  - Layer visibility toggles (Rock, Sand, Water, Lava, Suspended Sand/Mud).
  - Camera auto-rotation and smooth rendering modes.
  - Built-in real-time performance indicator (FPS).

---

## Getting Started

### Prerequisites

You will need [Node.js](https://nodejs.org/) installed on your machine.

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

---

## Deployment

This project is configured to automatically deploy to GitHub Pages via **GitHub Actions**.

Whenever changes are pushed to the `main` branch, the workflow defined in [deploy.yml](file:///.github/workflows/deploy.yml) triggers automatically, builds the project using the configured base URL in [vite.config.ts](file:///vite.config.ts), and deploys the build artifacts to GitHub Pages.
