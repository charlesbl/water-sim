/** Deliberately extravagant sandbox energy, not a real-world weapon model. */
export const NUKE_BRUSH = 11;
export const COLD_BLAST = 18;
export const NUKE_HEAT = 1_000_000;

/** The dock's size controls a six-times-wider thermal footprint for this power. */
export function powerRadius(type: number, radius: number): number {
  return radius * (type === NUKE_BRUSH || type === COLD_BLAST ? 6 : 1);
}

export function flashNuke(cold = false): void {
  const flash = document.getElementById('nuke-flash');
  if (!flash) return;
  flash.classList.toggle('cold', cold);
  flash.getAnimations().forEach((animation) => animation.cancel());
  flash.animate([{ opacity: 0.92 }, { opacity: 0.32, offset: 0.18 }, { opacity: 0 }], {
    duration: 900,
    easing: 'ease-out',
  });
}
