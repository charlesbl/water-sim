import { config } from './config';
import { CLIMATE_TOP } from './weather';

/** Three control points on a fixed altitude scale, independent of terrain edits. */
export function setupCoolingCurve(): void {
  const svg = document.getElementById('cooling-curve') as unknown as SVGSVGElement;
  const keys = ['cooling-low', 'cooling-middle', 'cooling-high'] as const;
  let drag: number | null = null;
  const values = () => [config.coolingLow, config.coolingMiddle, config.coolingHigh];
  const draw = () => {
    const width = Math.max(240, svg.clientWidth),
      height = 210;
    const x = (h: number) => 48 + (h / CLIMATE_TOP) * (width - 72);
    const y = (v: number) => 165 - (v / 3) * 137;
    const points = [0, config.coolingMiddleAltitude, CLIMATE_TOP].map((h, i) => [
      x(h),
      y(values()[i]),
    ]);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.innerHTML = `<title>Cooling by altitude</title><path class="curve-grid" d="M48 28V165H${width - 24}"/>
      ${[1, 2, 3].map((n) => `<text x="35" y="${y(n) + 4}" text-anchor="end">${n}×</text>`).join('')}
      <text x="48" y="185">0</text><text x="${width - 24}" y="185" text-anchor="end">32</text>
      <text x="${width / 2}" y="205" text-anchor="middle">Altitude · u</text>
      <path class="curve-line" d="${points.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ')}"/>
      ${points.map((p, i) => `<g data-point="${i}"><circle class="curve-hit" cx="${p[0]}" cy="${p[1]}" r="18"/><circle class="curve-point" cx="${p[0]}" cy="${p[1]}" r="6"/></g>`).join('')}`;
  };
  const set = (id: string, value: number) => {
    const input = document.getElementById(id) as HTMLInputElement;
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  svg.addEventListener('pointerdown', (e) => {
    const point = (e.target as Element).closest('[data-point]');
    if (!point) return;
    drag = Number(point.getAttribute('data-point'));
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  svg.addEventListener('pointermove', (e) => {
    if (drag === null) return;
    const rect = svg.getBoundingClientRect(),
      width = Math.max(240, svg.clientWidth);
    const x = ((e.clientX - rect.left) * width) / rect.width,
      y = ((e.clientY - rect.top) * 210) / rect.height;
    set(keys[drag], Math.max(0.1, Math.min(3, ((165 - y) / 137) * 3)));
    if (drag === 1)
      set(
        'cooling-middle-altitude',
        Math.max(0.5, Math.min(31.5, ((x - 48) / (width - 72)) * CLIMATE_TOP))
      );
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'])
    svg.addEventListener(event, () => {
      drag = null;
    });
  document.getElementById('domain-climate')!.addEventListener('input', draw);
  document.getElementById('domain-climate')!.addEventListener('click', draw);
  new ResizeObserver(draw).observe(svg);
  draw();
}
