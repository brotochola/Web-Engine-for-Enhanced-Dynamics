// renderPanel.js — DBG-5: the Render tab. A View select draws one of the frame's buffers decoded over the picture (the
// Pixi worker's render views, src/render/renderViews.js); the views the scene has no buffer for are disabled, each with
// the config that would make it. An opacity slider blends the view over the final picture.

import { createPanel, createRow, createStat } from '../ui/debugDom.js';
import { RENDER_VIEW, RENDER_VIEWS } from '../../../render/renderViews.js';
import { DebugPanel } from '../ui/debugPanel.js';
import { Mouse } from '../../mouse.js';

const LEGENDS = Object.freeze({
  [RENDER_VIEW.NORMALS]: 'normal → RGB (0.5 + 0.5·n); magenta an unshaded pixel, grey one lit as drawn, black no face',
  [RENDER_VIEW.HEIGHT]: 'height above the floor, 0 (blue) to 256 px (white); black no face',
  [RENDER_VIEW.IDS]: 'a colour per entity (the G-buffer ids map); black none',
  [RENDER_VIEW.FLAGS]: "grey a face, magenta unshaded, blue lit as drawn, yellow a sprite's own normal; green: shades itself",
  [RENDER_VIEW.LIGHT]: "the light alone, at lighting.resolution's size",
  [RENDER_VIEW.UNSHADED]: 'the unshaded colours, as the unshaded pass drew them',
  [RENDER_VIEW.SHADOWS]: 'the casted shadows layer, on white',
  [RENDER_VIEW.SUN_MAP]: "the sun's shadow map: caster heights as a ramp (the whole map, margins included)",
  [RENDER_VIEW.LAMP_MAP]: "the lamps' shadow atlas: every lamp's tile, heights as a ramp",
  [RENDER_VIEW.LIGHT_TILES]: 'lights per light tile: black none, the ramp up to 32 (or lighting.maxLights) white; the tile grid in grey',
});

export class RenderPanel extends DebugPanel {
  constructor(debugUI) {
    super(debugUI);
    this.select = null;
    this.opacity = null;
    this.opacityVal = null;
    this.legend = null;
    this.views = [RENDER_VIEW.FINAL];
    this.view = RENDER_VIEW.FINAL;
    this._worker = null;
    this.tileReadout = null;
    this._onMessage = (e) => {
      if (e.data?.msg === 'lightTile') this._takeTile(e.data);
      else this._takeViews(e.data);
    };
  }

  create() {
    this.panel = createPanel();
    const row = createRow('gap:8px;align-items:center');
    row.appendChild(createStat('View'));
    this.select = document.createElement('select');
    this.select.style.cssText = 'font-size:10px;padding:2px 4px;background:rgba(0,0,0,0.5);color:white;'
      + 'border:1px solid rgba(255,255,255,0.3);border-radius:3px';
    for (const v of RENDER_VIEWS) {
      const opt = document.createElement('option');
      opt.value = String(v.id);
      opt.textContent = v.label;
      this.select.appendChild(opt);
    }
    this.select.onchange = () => this._send();
    row.appendChild(this.select);

    row.appendChild(createStat('Opacity'));
    this.opacity = document.createElement('input');
    this.opacity.type = 'range';
    this.opacity.className = 'debug-ui-range';
    this.opacity.min = '0.1';
    this.opacity.max = '1';
    this.opacity.step = '0.05';
    this.opacity.value = '1';
    this.opacity.title = 'The view over the final picture: 1 the buffer alone';
    this.opacityVal = createStat('100%');
    this.opacity.oninput = () => {
      this.opacityVal.textContent = `${Math.round(Number(this.opacity.value) * 100)}%`;
      this._send();
    };
    row.appendChild(this.opacity);
    row.appendChild(this.opacityVal);
    this.panel.appendChild(row);

    this.legend = createStat('');
    this.legend.style.cssText = 'display:block;margin-top:6px;font-size:10px;color:rgba(255,255,255,0.55)';
    this.panel.appendChild(this.legend);
    // DBG-7: the light tile under the mouse, while the Light tiles view is on.
    this.tileReadout = createStat('');
    this.tileReadout.style.cssText = 'display:none;margin-top:4px;font-size:10px;font-family:monospace;color:rgba(255,255,255,0.8)';
    this.panel.appendChild(this.tileReadout);
    this._syncOptions();
    return this.panel;
  }

  attach() {
    const worker = this.debugUI.scene?.workers?.renderer ?? null;
    if (this._worker && this._worker !== worker) this._worker.removeEventListener('message', this._onMessage);
    this._worker = worker;
    this.views = [RENDER_VIEW.FINAL];
    this.view = RENDER_VIEW.FINAL;
    if (this.select) this.select.value = '0';
    if (worker) {
      worker.addEventListener('message', this._onMessage);
      worker.postMessage({ msg: 'listRenderViews' });
    }
    this._syncOptions();
  }

  update() {
    // The buffers a scene has can change as it plays (the G-buffer turns on with the first decoration that carries a
    // normal): ask again while the tab is open.
    if (this._worker) this._worker.postMessage({ msg: 'listRenderViews' });
    // DBG-7: the mouse's light tile, at this interval.
    if (this._worker && this.view === RENDER_VIEW.LIGHT_TILES && Mouse.isPresent) {
      this._worker.postMessage({ msg: 'lightTileAt', x: Mouse.canvasXAt(0), y: Mouse.canvasYAt(0) });
    }
  }

  /** DBG-7: the worker's light tile under the mouse, as one line. */
  _takeTile(data) {
    if (!this.tileReadout || this.view !== RENDER_VIEW.LIGHT_TILES) return;
    const grid = `${data.cols} x ${data.rows} tiles of ${data.tilePx} px, ${data.wordsUsed} words`;
    let text;
    if (data.x < 0) {
      text = `outside the grid (${grid})`;
    } else {
      const lights = Array.isArray(data.lights) ? data.lights : [];
      const shown = lights.slice(0, 24).join(', ');
      text = `tile ${data.x}, ${data.y} of ${grid}: ${lights.length} lights${lights.length ? ` [${shown}${lights.length > 24 ? ', ...' : ''}]` : ''}`;
    }
    if (this.tileReadout.textContent !== text) this.tileReadout.textContent = text;
  }

  /** The worker's answer: the views it can draw now and the one it draws. */
  _takeViews(data) {
    if (!data || data.msg !== 'renderViews') return;
    this.views = Array.isArray(data.views) ? data.views : [RENDER_VIEW.FINAL];
    this.view = data.view | 0;
    this._syncOptions();
  }

  _send() {
    if (!this._worker) return;
    this._worker.postMessage({ msg: 'setRenderView', view: Number(this.select.value) | 0, opacity: Number(this.opacity.value) });
  }

  _syncOptions() {
    if (!this.select) return;
    const have = new Set(this.views);
    const options = this.select.options || this.select.children || [];
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const spec = RENDER_VIEWS[i];
      const off = !have.has(spec.id);
      if (opt.disabled !== off) opt.disabled = off;
      const title = off ? `This scene has no such buffer: ${spec.needs}` : (LEGENDS[spec.id] || '');
      if (opt.title !== title) opt.title = title;
    }
    if (document.activeElement !== this.select && this.select.value !== String(this.view)) this.select.value = String(this.view);
    const legend = LEGENDS[this.view] || 'The final picture.';
    if (this.legend.textContent !== legend) this.legend.textContent = legend;
    const tiles = this.view === RENDER_VIEW.LIGHT_TILES ? 'block' : 'none';
    if (this.tileReadout && this.tileReadout.style.display !== tiles) this.tileReadout.style.display = tiles;
  }
}
