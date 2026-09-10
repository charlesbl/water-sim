import { config } from './config';

/** Covers HTML and SVG descendants of all overlay surfaces. */
export function isUIEventTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-ui]') !== null;
}

function isEditing(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('input, select, textarea, [contenteditable="true"]') !== null
  );
}

/** Navigation, numeric companions and search never hold a second copy of Config. */
export function setupCommandUI(): void {
  const ui = document.getElementById('command-ui')!;
  const inspector = document.getElementById('inspector')!;
  const body = inspector.querySelector<HTMLElement>('.inspector-body')!;
  const title = document.getElementById('inspector-title')!;
  const description = document.getElementById('inspector-description')!;
  const advancedButton = document.getElementById('toggle-advanced')!;
  const mode = document.getElementById('inspector-mode')!;
  const navButtons = Array.from(ui.querySelectorAll<HTMLButtonElement>('[data-domain]'));
  const domains = Array.from(ui.querySelectorAll<HTMLElement>('.domain-content'));
  const search = document.getElementById('command-search') as HTMLInputElement;
  const results = document.getElementById('search-results')!;
  const legend = document.getElementById('view-legend')!;
  const legendSlot = document.createElement('div');
  legendSlot.id = 'inspector-legend-slot';
  body.prepend(legendSlot);
  const smallScreen = matchMedia('(max-width: 759px)');
  const placeLegend = () => {
    const parent = smallScreen.matches && !inspector.hidden ? legendSlot : ui;
    if (legend.parentElement !== parent) parent.append(legend);
  };
  smallScreen.addEventListener('change', placeLegend);
  let currentDomain: string | null = null;
  let highlightTimer: ReturnType<typeof setTimeout> | undefined;

  const setAdvanced = (advanced: boolean) => {
    inspector.classList.toggle('advanced', advanced);
    advancedButton.setAttribute('aria-pressed', String(advanced));
    mode.textContent = advanced ? 'All parameters' : 'Essential controls';
  };
  const openDomain = (name: string | null, focus = false) => {
    currentDomain = name;
    inspector.hidden = name === null;
    setAdvanced(false);
    for (const button of navButtons) {
      button.setAttribute('aria-expanded', String(button.dataset.domain === name));
    }
    for (const domain of domains) {
      domain.hidden = domain.id !== 'domain-' + name;
      if (!domain.hidden) {
        title.textContent = domain.dataset.title!;
        description.textContent = domain.dataset.description!;
        advancedButton.hidden = name === 'settings';
      }
    }
    body.scrollTop = 0;
    placeLegend();
    if (focus && name) document.getElementById('close-inspector')!.focus();
  };
  const closeInspector = () => {
    const previous = currentDomain;
    openDomain(null);
    navButtons.find((button) => button.dataset.domain === previous)?.focus();
  };
  navButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const name = button.dataset.domain!;
      if (currentDomain === name) closeInspector();
      else openDomain(name, true);
    });
  });
  document.getElementById('close-inspector')!.addEventListener('click', closeInspector);
  advancedButton.addEventListener('click', () => {
    setAdvanced(!inspector.classList.contains('advanced'));
  });

  const numbers = Array.from(ui.querySelectorAll<HTMLInputElement>('[data-number-for]')).map(
    (number) => ({
      number,
      range: document.getElementById(number.dataset.numberFor!) as HTMLInputElement,
    })
  );
  const sync = () => {
    for (const { number, range } of numbers) {
      if (document.activeElement !== number) number.value = range.value;
      number.disabled = range.disabled;
      const label = ui.querySelector<HTMLLabelElement>('label[for="' + range.id + '"]');
      if (label) number.setAttribute('aria-label', label.textContent!.trim() + ' exact value');
      const amount =
        (range.valueAsNumber - Number(range.min)) / (Number(range.max) - Number(range.min));
      range.style.setProperty(
        '--range-progress',
        String(Math.max(0, Math.min(100, amount * 100))) + '%'
      );
    }
    ui.querySelectorAll<HTMLElement>('[data-availability]').forEach((note) => {
      note.hidden = !note
        .closest('.control-group')
        ?.querySelector('input:disabled, select:disabled');
    });
    ui.querySelectorAll<HTMLButtonElement>('[data-brush]').forEach((button) => {
      const active = Number(button.dataset.brush) === config.brushType;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('active', active);
      if (active) document.getElementById('active-power')!.textContent = button.textContent!.trim();
    });
    const state = document.getElementById('runtime-state')!;
    state.textContent = config.paused ? 'Paused' : 'Running';
    state.dataset.paused = String(config.paused);
    document
      .getElementById('thermal-controls')!
      .classList.toggle('context-active', config.thermalOverlay);
    document
      .getElementById('atmosphere-slice-group')!
      .classList.toggle('context-active', config.atmosphereView !== 0);
    legend.hidden = !config.thermalOverlay && config.atmosphereView === 0;
    document.getElementById('slice-legend')!.hidden = config.atmosphereView === 0;
    document.getElementById('slice-legend-title')!.textContent =
      ['', 'Air temperature', 'Relative humidity', 'Wind speed'][config.atmosphereView] +
      ' · altitude ' +
      Math.round(config.atmosphereSlice * 100) +
      '%';
    const gradient = document.getElementById('slice-gradient')!;
    gradient.style.background = [
      '',
      'linear-gradient(to right, #2940d9, #d1f5ff 46.154%, #ffcc47 69.231%, #e61f14)',
      'linear-gradient(to right, #916b48, #67dce9)',
      'linear-gradient(to right, #364bc1, #49dbb4 38%, #f3a450)',
    ][config.atmosphereView];
    document.getElementById('view-options')!.dataset.reveal = config.thermalOverlay
      ? 'thermal-mode'
      : 'atmosphere-slice';
  };

  for (const { number, range } of numbers) {
    const commit = () => {
      if (!number.disabled && Number.isFinite(number.valueAsNumber)) {
        // Let the native range apply its original clamp and step sanitization.
        const previous = range.value;
        range.value = number.value;
        if (range.value !== previous) range.dispatchEvent(new Event('input', { bubbles: true }));
      }
      number.value = range.value;
      sync();
    };
    number.addEventListener('change', commit);
    number.addEventListener('blur', () => {
      number.value = range.value;
    });
    number.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
        number.blur();
      }
    });
  }
  // These bubble after the existing simulation handlers, including presets.
  ui.addEventListener('input', sync);
  ui.addEventListener('change', sync);
  ui.addEventListener('click', sync);

  const entries = Array.from(ui.querySelectorAll<HTMLElement>('[data-control]'));
  const labelFor = (entry: HTMLElement): string => {
    const label = entry.querySelector('label');
    const button = entry.matches('button') ? entry : entry.querySelector('button');
    return (label?.textContent || button?.textContent || entry.dataset.control || '').trim();
  };
  const closeSearch = () => {
    results.hidden = true;
    search.setAttribute('aria-expanded', 'false');
  };
  const reveal = (id: string) => {
    const entry = entries.find((item) => item.dataset.control === id);
    if (!entry) return;
    const domain = entry.closest<HTMLElement>('.domain-content');
    if (domain) {
      const name = domain.id.replace('domain-', '');
      if (currentDomain !== name) openDomain(name);
      if (entry.closest('[data-advanced]')) setAdvanced(true);
    }
    closeSearch();
    ui.querySelectorAll('.search-highlight').forEach((item) =>
      item.classList.remove('search-highlight')
    );
    clearTimeout(highlightTimer);
    entry.classList.add('search-highlight');
    const control = entry.matches('button')
      ? entry
      : entry.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), button');
    // Disabled settings still expose a keyboard-focusable link to their prerequisite.
    control?.focus({ preventScroll: true });
    entry.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    highlightTimer = setTimeout(() => entry.classList.remove('search-highlight'), 2200);
  };
  ui.querySelectorAll<HTMLElement>('[data-reveal]').forEach((button) => {
    button.addEventListener('click', () => reveal(button.dataset.reveal!));
  });
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  const showResults = () => {
    const terms = normalize(search.value).trim().split(/\s+/).filter(Boolean);
    results.replaceChildren();
    if (!terms.length) {
      closeSearch();
      return;
    }
    const matches = entries.filter((entry) => {
      const domain = entry.closest<HTMLElement>('.domain-content')?.dataset.title ?? '';
      const text = normalize(labelFor(entry) + ' ' + entry.dataset.keywords + ' ' + domain);
      return terms.every((term) => text.includes(term));
    });
    for (const entry of matches) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-result';
      button.dataset.target = entry.dataset.control;
      const label = document.createElement('span');
      label.textContent = labelFor(entry);
      const path = document.createElement('small');
      const domain = entry.closest<HTMLElement>('.domain-content')?.dataset.title;
      path.textContent =
        (domain ?? (entry.closest('.power-dock') ? 'World powers' : 'Simulation time')) +
        (entry.closest('[data-advanced]') ? ' / Advanced' : '');
      button.append(label, path);
      button.addEventListener('click', () => reveal(entry.dataset.control!));
      results.append(button);
    }
    if (!matches.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-search';
      empty.textContent = 'No settings found. Try “rain”, “soil” or “temperature”.';
      results.append(empty);
    }
    document.getElementById('search-status')!.textContent = matches.length + ' matching settings';
    results.hidden = false;
    search.setAttribute('aria-expanded', 'true');
  };
  search.addEventListener('input', showResults);
  search.addEventListener('focus', showResults);
  search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter') {
      const first = results.querySelector<HTMLButtonElement>('button');
      if (first) {
        event.preventDefault();
        if (event.key === 'Enter') first.click();
        else first.focus();
      }
    }
  });
  results.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = Array.from(results.querySelectorAll<HTMLButtonElement>('button'));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = index + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) search.focus();
    else buttons[Math.min(next, buttons.length - 1)]?.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (event.target instanceof Element && !event.target.closest('.search-area')) closeSearch();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!results.hidden) {
        closeSearch();
        search.focus();
        closeSearch();
      } else if (!inspector.hidden) closeInspector();
    } else if (event.key === '/' && !isEditing(event.target) && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      search.focus();
    }
  });
  // Measure both toolbars, including wrapped labels and larger touch controls.
  const dock = document.getElementById('power-dock')!;
  const navigation = ui.querySelector<HTMLElement>('.domain-nav')!;
  const layoutObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      document.documentElement.style.setProperty(
        entry.target === dock ? '--dock-height' : '--nav-height',
        entry.target.getBoundingClientRect().height + 'px'
      );
    }
  });
  layoutObserver.observe(dock);
  layoutObserver.observe(navigation);
  openDomain(null);
  sync();
}
