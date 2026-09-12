const defaultChecks = new WeakMap<Element, () => boolean>();

/** Keep the button's space while removing default-valued actions from view and focus. */
export function syncParameterResets(root: ParentNode = document): void {
  root.querySelectorAll<HTMLButtonElement>('[data-reset-for]').forEach((button) => {
    const id = button.dataset.resetFor!.replace(/^quick-/, '');
    const control = root.querySelector(`[id="${id}"]`);
    const isDefault = control ? defaultChecks.get(control)?.() : true;
    button.style.visibility = isDefault ? 'hidden' : 'visible';
    button.disabled = !!isDefault;
  });
}

/** Add a reset action without passing defaults through range rounding or coupled edits. */
export function addParameterReset(
  control: HTMLInputElement | HTMLSelectElement,
  reset: () => void,
  isDefault: () => boolean,
  exactValue?: () => number
): void {
  const group = control.closest('.control-group');
  if (!group) return;
  defaultChecks.set(control, isDefault);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'parameter-reset';
  button.dataset.resetFor = control.id;
  button.textContent = '↺';
  const label = group.querySelector('label')?.textContent?.trim() ?? control.id;
  button.title = `Reset ${label} to default`;
  button.setAttribute('aria-label', button.title);
  control.addEventListener('input', () => delete control.dataset.exactValue);
  button.addEventListener('click', () => {
    reset();
    if (exactValue) control.dataset.exactValue = String(exactValue());
    syncParameterResets(group);
  });
  (group.querySelector('.label-row') ?? group).append(button);
  syncParameterResets(group);
}
