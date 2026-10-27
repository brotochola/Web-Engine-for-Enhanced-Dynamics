// blastforgePanel.js – the Blastforge demo's side panel. Main thread only: the scene builds it in create() and
// removes it in destroy(). Blast choices go to BlastSettings (read by the Detonator on a logic worker); the look
// goes straight to the field layer's uniforms.

const PANEL_ID = 'blastforge-panel';

const CSS = `
#${PANEL_ID} {
  position: fixed; right: 12px; top: 56px; bottom: 12px; width: 300px; z-index: 950; box-sizing: border-box;
  overflow-y: auto; pointer-events: auto; padding: 14px 16px 24px; border-radius: 10px;
  background: rgba(34, 30, 39, 0.94); color: #efe6d8; border: 1px solid #3f3847;
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
}
#${PANEL_ID} h1 { font: 600 22px/1 ui-monospace, Menlo, Consolas, monospace; margin: 0 0 6px; letter-spacing: 0.5px; }
#${PANEL_ID} p { color: #a69caa; margin: 0 0 12px; }
#${PANEL_ID} h2 { font: 600 14px/1.2 ui-monospace, Menlo, Consolas, monospace; margin: 16px 0 8px; }
#${PANEL_ID} .presets { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
#${PANEL_ID} .preset {
  appearance: none; border: 1px solid #3f3847; background: transparent; color: inherit; border-radius: 4px;
  padding: 7px 7px 6px; text-align: left; cursor: pointer; font: 13px/1.1 ui-monospace, Menlo, Consolas, monospace;
  display: flex; flex-direction: column; gap: 5px;
}
#${PANEL_ID} .preset:hover { border-color: #a69caa; }
#${PANEL_ID} .preset[aria-pressed="true"] { border-color: #f2a33a; background: #2c2732; box-shadow: inset 0 0 0 1px #f2a33a; }
#${PANEL_ID} .strip { display: flex; height: 5px; }
#${PANEL_ID} .strip i { flex: 1; }
#${PANEL_ID} .row { margin: 8px 0; }
#${PANEL_ID} .row label { display: flex; justify-content: space-between; gap: 8px; font-weight: 500; }
#${PANEL_ID} .row output { color: #a69caa; font-variant-numeric: tabular-nums; }
#${PANEL_ID} input[type=range] { width: 100%; accent-color: #f2a33a; margin: 4px 0 0; }
#${PANEL_ID} .check { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-weight: 500; }
#${PANEL_ID} .check input { accent-color: #f2a33a; width: 15px; height: 15px; }
`;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

function hex(color) {
  return '#' + color.toString(16).padStart(6, '0');
}

/**
 * Build the panel. Returns a function that removes it.
 * @param {object} opts
 * @param {object[]} opts.presets the presets, in BlastSettings.preset's order
 * @param {typeof import('./blastforgeScene.js').BlastSettings} opts.settings
 * @param {object} opts.fieldLayer the field layer (Layer.get), for its look uniforms
 */
export function buildBlastPanel({ presets, settings, fieldLayer }) {
  const style = el('style', { textContent: CSS });
  const panel = el('aside', { id: PANEL_ID });
  panel.append(
    el('h1', { textContent: 'Blastforge' }),
    el('p', { textContent: 'Pixel-art explosions made of thousands of particles. Click the ground or press Space.' }),
    el('p', {
      textContent: 'Fire, smoke, dust and embers are GPU particles, sorted among the trees and rocks; sparks and ' +
        'debris bounce on the CPU.',
    }),
    el('h2', { textContent: 'Presets' })
  );

  const grid = el('div', { className: 'presets' });
  presets.forEach((preset, index) => {
    const strip = el('span', { className: 'strip' });
    strip.setAttribute('aria-hidden', 'true');
    for (const color of preset.palette.fire) strip.append(el('i', { style: `background:${hex(color)}` }));
    const button = el('button', { type: 'button', className: 'preset' }, [el('span', { textContent: preset.name }), strip]);
    button.setAttribute('aria-pressed', String(index === settings.preset[0]));
    button.addEventListener('click', () => {
      settings.preset[0] = index; // the Detonator recolors the field layer and sets the preset off once
      for (const other of grid.children) other.setAttribute('aria-pressed', String(other === button));
    });
    grid.append(button);
  });
  panel.append(grid, el('h2', { textContent: 'Tune' }));

  const slider = (label, min, max, step, value, apply, format) => {
    const input = el('input', { type: 'range', min, max, step, value });
    const output = el('output');
    const update = () => {
      const v = Number(input.value);
      apply(v);
      output.textContent = format(v);
    };
    input.addEventListener('input', update);
    update();
    panel.append(el('div', { className: 'row' }, [el('label', {}, [label, output]), input]));
  };
  const check = (label, checked, apply) => {
    const input = el('input', { type: 'checkbox', checked });
    input.addEventListener('change', () => apply(input.checked ? 1 : 0));
    panel.append(el('label', { className: 'check' }, [input, label]));
  };

  slider('Blast size', 0.25, 2, 0.05, 1, (v) => (settings.size[0] = v), (v) => '×' + v.toFixed(2));
  slider('Particle amount', 0.25, 3, 0.25, 1, (v) => (settings.amount[0] = v), (v) => '×' + v);
  slider('Wind', -60, 60, 1, 0, (v) => (settings.wind[0] = v), (v) => (v === 0 ? 'calm' : (v < 0 ? '← ' : '→ ') + Math.abs(v)));
  slider('Dither', 0, 1, 0.05, 0.6, (v) => fieldLayer.setUniform('uDither', v), (v) => Math.round(v * 100) + '%');
  check('Dark outline on smoke', true, (on) => fieldLayer.setUniform('uOutline', on));
  check('Auto-detonate', false, (on) => (settings.autoDetonate[0] = on));
  check('Show the raw field', false, (on) => fieldLayer.setUniform('uShowField', on));

  document.head.append(style);
  document.body.append(panel);
  return () => {
    panel.remove();
    style.remove();
  };
}
