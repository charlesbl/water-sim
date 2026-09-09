import { config } from './config';

// The shaders compare stored height differences per cell. The controls expose
// the corresponding angle in the rendered world (200 units across the map).
export function angleToReposeSlope(angle: number, gridSize: number, heightScale: number): number {
  return (
    (Math.tan((Math.max(0, Math.min(89, angle)) * Math.PI) / 180) * 200) / (gridSize * heightScale)
  );
}

export function reposeSlopeToAngle(slope: number, gridSize: number, heightScale: number): number {
  return (Math.atan((Math.max(0, slope) * gridSize * heightScale) / 200) * 180) / Math.PI;
}

const controls = [
  ['soil-static-repose-slope', 'soilStaticReposeSlope'],
  ['soil-dynamic-repose-slope', 'soilDynamicReposeSlope'],
  ['sand-static-repose-slope', 'sandStaticReposeSlope'],
  ['sand-dynamic-repose-slope', 'sandDynamicReposeSlope'],
] as const;

const materialThresholds = [
  ['soilStaticReposeSlope', 'soilDynamicReposeSlope'],
  ['sandStaticReposeSlope', 'sandDynamicReposeSlope'],
] as const;

export function setupReposeControls(root: ParentNode = document): void {
  const refresh = () => {
    for (const [id, key] of controls) {
      const slider = root.querySelector<HTMLInputElement>(`#${id}`);
      const value = root.querySelector<HTMLElement>(`#${id}-val`);
      const angle = reposeSlopeToAngle(config[key], config.gridSize, config.heightScale);
      if (slider) {
        slider.value = angle.toFixed(1);
        slider.setAttribute('aria-valuetext', `${angle.toFixed(1)} degrees`);
      }
      if (value) value.textContent = `${angle.toFixed(1)}°`;
    }
  };

  for (const [id, key] of controls) {
    root.querySelector<HTMLInputElement>(`#${id}`)?.addEventListener('input', (event) => {
      const angle = (event.target as HTMLInputElement).valueAsNumber;
      if (!Number.isFinite(angle)) return;
      config[key] = angleToReposeSlope(angle, config.gridSize, config.heightScale);
      // An avalanche must stop at an angle no greater than its starting angle.
      for (const [staticKey, dynamicKey] of materialThresholds) {
        if (config[dynamicKey] > config[staticKey]) {
          if (key === staticKey) config[dynamicKey] = config[staticKey];
          else if (key === dynamicKey) config[staticKey] = config[dynamicKey];
        }
      }
      refresh();
    });
  }
  refresh();
}
