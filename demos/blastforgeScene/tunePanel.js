// tunePanel.js – the Blastforge panel's Speed slider and Tune section, as in Blastforge: a slider per preset field
// (SCHEMA), the palette, Reset preset and Copy settings as JSON. Main thread only. It keeps a tuned copy of every
// preset and writes the active one to BlastTuning, where the Detonator reads it.

import WEED from '/src/index.js';
import { PALETTES, SCHEMA } from './explosionPresets.js';
import { PALETTE_KEYS, paletteKey, writeTuning } from './blastTuning.js';

const { Time } = WEED;

const CSS = `
.bf-tune { margin-top: 16px; }
.bf-tune summary { font: 600 14px/1.2 ui-monospace, Menlo, Consolas, monospace; cursor: pointer; padding: 4px 0; }
.bf-tune summary:focus-visible, .bf-tune .act:focus-visible, .bf-tune select:focus-visible { outline: 2px solid #f2a33a; outline-offset: 2px; }
.bf-tune .palette { display: flex; align-items: center; gap: 10px; margin: 10px 0 4px; font-weight: 500; }
.bf-tune .note { color: #a69caa; margin: 8px 0 0; }
.bf-tune select {
  flex: 1; background: #2c2732; color: inherit; border: 1px solid #3f3847; border-radius: 4px; padding: 5px 6px;
  font: 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.bf-tune .btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.bf-tune .act {
  appearance: none; border: 1px solid #3f3847; background: transparent; color: inherit; border-radius: 4px;
  padding: 7px 10px; cursor: pointer; font: 13px/1.1 ui-monospace, Menlo, Consolas, monospace;
}
.bf-tune .act:hover { border-color: #a69caa; }
`;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

/** A slider's value, shown as Blastforge shows it. */
function format(value, step) {
  return step >= 1 ? String(Math.round(value)) : value.toFixed(step < 0.5 ? 2 : 1);
}

/** A slider row, styled by the panel's .row rules. */
function sliderRow(label, min, max, step, value, onInput, show) {
  const input = el('input', { type: 'range', min, max, step, value });
  const output = el('output', { textContent: show(value) });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    output.textContent = show(v);
    onInput(v);
  });
  const row = el('div', { className: 'row' }, [el('label', {}, [label, output]), input]);
  const set = (v) => {
    input.value = v;
    output.textContent = show(v);
  };
  return { row, set };
}

/**
 * The Speed row and the Tune section, for the panel to place. Writes the active preset's tuning at once, so the
 * Detonator's first blast is the tuned one.
 * @param {object} opts
 * @param {object[]} opts.presets the presets, in BlastSettings.preset's order
 * @param {object} opts.settings BlastSettings (its preset index)
 * @param {ArrayLike<HTMLElement>} [opts.buttons] the preset buttons, in the same order: their palette strip follows
 *   the tuned palette
 * @returns {{ speed: HTMLElement, tune: HTMLElement, select: (index: number) => void, remove: () => void }}
 */
export function buildTuneSection({ presets, settings, buttons = [] }) {
  const style = el('style', { textContent: CSS });
  document.head.append(style);
  const tuned = presets.map((preset) => ({ ...preset }));
  let active = settings.preset[0];

  // Speed scales game time: particles, logic and the sim clock the GPU particles age by.
  const speed = sliderRow('Speed', 0.05, 1.5, 0.05, Time.scale, (v) => (Time.scale = v), (v) => Math.round(v * 100) + '%').row;

  const send = () => writeTuning(active, tuned[active]);
  const paintStrip = (index) => {
    const strip = buttons[index]?.querySelector('.strip');
    if (!strip) return;
    const colors = tuned[index].palette.fire;
    [...strip.children].forEach((swatch, i) => (swatch.style.background = '#' + colors[i].toString(16).padStart(6, '0')));
  };

  const summary = el('summary');
  const paletteSelect = el('select', { id: 'bf-tune-palette' });
  for (const key of PALETTE_KEYS) paletteSelect.append(el('option', { value: key, textContent: key[0].toUpperCase() + key.slice(1) }));
  paletteSelect.addEventListener('change', () => {
    tuned[active].palette = PALETTES[paletteSelect.value];
    paintStrip(active);
    send();
  });

  const sliders = SCHEMA.map(([key, label, min, max, step]) =>
    sliderRow(label, min, max, step, tuned[active][key], (v) => {
      tuned[active][key] = v;
      send();
    }, (v) => format(v, step))
  );

  const reset = el('button', { type: 'button', className: 'act', textContent: 'Reset preset' });
  reset.addEventListener('click', () => {
    tuned[active] = { ...presets[active] };
    refresh();
    paintStrip(active);
    send();
  });
  const copy = el('button', { type: 'button', className: 'act', textContent: 'Copy settings as JSON' });
  copy.addEventListener('click', async () => {
    // The preset as explosionPresets.js lists it, its palette by key: it pastes in as it is.
    const preset = tuned[active];
    const fields = { name: preset.name, palette: paletteKey(preset.palette) };
    for (const [key] of SCHEMA) fields[key] = preset[key];
    const text = JSON.stringify(fields, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = 'Copied';
    } catch {
      window.prompt('Copy these settings:', text);
    }
    setTimeout(() => (copy.textContent = 'Copy settings as JSON'), 1400);
  });

  const tune = el('details', { className: 'bf-tune' }, [
    summary,
    el('p', { className: 'note', textContent: 'Shockwave distortion and Ground light are kept with the preset; the demo does not draw them yet.' }),
    el('label', { className: 'palette', htmlFor: 'bf-tune-palette' }, ['Palette', paletteSelect]),
    ...sliders.map((s) => s.row),
    el('div', { className: 'btns' }, [reset, copy]),
  ]);

  function refresh() {
    const preset = tuned[active];
    summary.textContent = 'Tune ' + preset.name;
    paletteSelect.value = paletteKey(preset.palette);
    SCHEMA.forEach(([key], i) => sliders[i].set(preset[key]));
  }

  /** Pick preset `index`: its tuning first, then the index, which the Detonator sets off at once. */
  const select = (index) => {
    active = index;
    send();
    settings.preset[0] = index;
    refresh();
  };

  refresh();
  send();
  return { speed, tune, select, remove: () => style.remove() };
}
