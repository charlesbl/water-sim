import profileWGSL from './shaders/nukeProfile.wgsl?raw';

/** Deliberately extravagant sandbox energy, not a real-world weapon model. */
export const NUKE_BRUSH = 11;
export const COLD_BLAST = 18;
export const NUKE_HEAT = 1_000_000;
export const NUKE_TIME_SCALE = 10;
export const NUKE_WAVE_SPEED = 1.5;
export const NUKE_SHOCK_SECONDS = 12.5 / NUKE_WAVE_SPEED;
export const NUKE_MELT_LEAD_CELLS = 3;
export const NUKE_LIFETIME = 45;
export const NUKE_PHYSICS_STRIDE = 3; // 20 Hz transport, 60 Hz visual clock.
export const NUKE_SHADER_PROFILE = `
const NUKE_TIME_SCALE: f32 = ${NUKE_TIME_SCALE.toFixed(2)};
const NUKE_SHOCK_SECONDS: f32 = ${NUKE_SHOCK_SECONDS.toFixed(8)};
const NUKE_MELT_LEAD_CELLS: f32 = ${NUKE_MELT_LEAD_CELLS.toFixed(2)};
const NUKE_LIFETIME: f32 = ${NUKE_LIFETIME.toFixed(2)};
const NUKE_TRANSPORT_SCALE: f32 = ${((NUKE_PHYSICS_STRIDE * NUKE_WAVE_SPEED) / NUKE_TIME_SCALE).toFixed(2)};
${profileWGSL}`;

/** Every tool uses the size shown in the dock, including both explosion variants. */
export function powerRadius(_type: number, radius: number): number {
  return radius;
}

export function flashNuke(cold = false): void {
  const flash = document.getElementById('nuke-flash');
  if (!flash) return;
  flash.classList.toggle('cold', cold);
  flash.getAnimations().forEach((animation) => animation.cancel());
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  flash.animate(
    [{ opacity: reducedMotion ? 0.08 : 0.35 }, { opacity: 0.06, offset: 0.25 }, { opacity: 0 }],
    {
      duration: 1100,
      easing: 'ease-out',
    }
  );
}
