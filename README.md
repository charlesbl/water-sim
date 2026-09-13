# TerraGPU — Paint the weather, shape the terrain

A WebGPU god-game sandbox inspired by _From Dust_. Paint water, lava, sand, soil and clouds; carve rivers, fill lakes, freeze valleys and thaw new channels.

[Published demo](https://charlesbl.github.io/water-sim/) — deployment follows pushes to `main`; it may differ from your local checkout.

## Play

- **Clouds:** paint a persistent intensity field. More paint produces stronger precipitation directly underneath. Right-drag thins it; **Climate → Clear sky** removes all clouds while preserving the landscape and its temperature.
- **Climate:** drag the three cooling points. The middle point moves in altitude as well as strength. Changes gradually affect the existing temperature field, snow and ice.
- **Sun:** adjust intensity, elevation and direction. Surface orientation, cloud shade and material albedo affect heating. Albedo strength ranges from 0 (equal solar absorption) through 1 (normal) to 2 (doubled reflectivity, capped at 100%). Materials retain their own thermal inertia.
- **Water and terrain:** rain feeds the existing river, lake and erosion solver. Sculpt rock or add sand/soil to divert the flow. Sand and soil have separate reservoirs and repose angles, with shared erosion and transport rules.
- **Snow and ice:** cold precipitation accumulates as snow. Cooling freezes existing water gradually; warming returns frozen mass to liquid. Snow occupies 2.5 times its liquid-equivalent depth. Ice is attached to the bed, with liquid flowing above it.
- **Heat and Cool:** apply local thermal impulses. Residual heat/cold diffuses and fades toward the surrounding climate.
- **Nuke:** uses the same selected radius as every other tool, up to 300 cells. The pressure front expands over about 8.3 seconds (×1.5 wave speed), with a rolling volumetric dust cloud and a mushroom cloud that dissipates over 45 seconds. Rock stays fixed, soil moves normally, sand moves 25% more readily, and water is strongly swept out of the interior. Ice melts instantly three cells ahead of the advancing hot front, becoming an equal quantity of liquid water, which is then pushed outward. The nuclear heat source supplies fusion energy when needed. The moving ridge consists of displaced sediment, with no added terrain or material. Right-click creates an icy blast. Each click produces one finite effect, including while paused; size and strength control its reach and force.
- **Right-click:** remove the selected material only. Raise/Dig and Heat/Cool reverse each other. **Erase** removes all local material layers and clouds with either mouse button.
- **Map edges:** choose **Walls** or **Passthrough** in Water & Lava. Passthrough lets water, lava and carried sediment leave the map; nothing flows in from outside.

Use the top bar for pause, **World speed**, cloud visibility and the cloud intensity, precipitation or surface-temperature overlays. The dock stays accessible while editing settings. Numeric values are editable, settings are searchable, and individual resets are available. Settings and camera position survive reload; the painted world itself is not saved.

Move with W/A/S/D and Q/E, hold the middle mouse button to look around, use Space to accelerate and Shift to slow down. Brushes remain usable while paused; freeze/thaw and rain advance when simulation resumes.

## Run locally

Requires Node.js and a browser/device with WebGPU. Use localhost or HTTPS. The default simulation is **2048 × 2048**, which requires substantial GPU memory. Mesh Resolution changes the rendering mesh, not the simulation grid.

```bash
npm install
npm run dev
```

Open `http://localhost:5173/water-sim/` (or the address printed by Vite).

```bash
npm run typecheck
npm run lint
npm run build
```

The build is written to `dist/`. GitHub Pages deployment uses [.github/workflows/deploy.yml](.github/workflows/deploy.yml) and the base path in [vite.config.ts](vite.config.ts).

## Validate

Keep Vite running in a separate terminal, then run:

```bash
npm run test:weather
npm run test:nuke
npm run test:ui
npm run test:preferences
```

The GPU runner exercises the production shaders for painted rain, local thermal diffusion, the cooling curve, albedo, high cloud clearance, progressive phase changes, snow depth, water accounting, selective erasing, open edges, sediments and brush picking. UI tests exercise the real app, including dragging the cooling curve, painting, right-click input and layouts from 390 to 1920 px. Preferences are checked through an actual page reload and reset.

The runners use installed Chrome with WebGPU. Override `CHROME_PATH` or `TEST_BASE_URL` for another local setup. UI tests print the temporary directory containing screenshots and their checks. Individual GPU fixtures can be run with, for example, `node tests/run-gpu.mjs painted-weather sediments`, or opened under `/water-sim/tests/`.

The nuke fixture checks equal tool radii, immobile rock, material-dependent transport, ice-to-water conversion, near-total clearing of interior water, a traveling sediment ridge, and conservation of sediment, water inventory and sensible plus latent heat. It also covers boundary and overlapping blasts, frame-rate independence, simulation buffer swaps, effect expiry and hot/cold volume rendering. Blast computation uses a local scratch region rather than another full-size simulation grid.

See [the weather model and validation notes](docs/painted-weather.md) for rules, buffer ownership and deliberate limitations.
