// shipRow.js — the last row of the editor's Assets dock (the palette, VISUAL_EDITOR_PLAN.md Stage 5): Bake atlas
// (ED-31) and Export (ED-32), and a line that says what the last one made and where it went. Built once with the
// palette's body; the DOM changes only when a button is used. The editor page's toolbar exports through it too
// (exportFromEditor).

import { bakeAtlas } from './atlasBake.js';
import { exportRunningGame } from './gameExport.js';

const NOTE_STYLE = 'font-size:10px;white-space:normal;overflow-wrap:anywhere;margin-top:4px';

/** A row for an EditMode whose palette has none yet (its body is made when it is first shown). */
const detachedRows = new WeakMap();

/**
 * Export from the editor page's toolbar: through the Assets dock's row when it is there, so its line says where the
 * game went, else through a row of its own (the status line says it).
 * @param {object} editMode
 * @returns {Promise<object|null>}
 */
export function exportFromEditor(editMode) {
  let row = editMode.palette?.ship ?? detachedRows.get(editMode);
  if (!row) {
    row = new ShipRow(editMode);
    detachedRows.set(editMode, row);
  }
  return row.exportGame();
}

export class ShipRow {
  /** @param {object} editMode - the EditMode whose running scene it bakes */
  constructor(editMode) {
    this.editMode = editMode;
    this.el = document.createElement('div');
    this.el.style.cssText = 'margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.1)';
    this._buttons = document.createElement('div');
    this._buttons.style.cssText = 'display:flex;gap:4px';
    this._bake = this._button(
      'Bake atlas',
      'Write the atlas this scene packed at load as <Scene>.atlas.png and .atlas.json next to its module: a scene whose assets name them loads them instead of packing',
      () => this.bake(),
    );
    this._export = this._button(
      'Export',
      'Build this game into a static site (index.html, vendor/weed.js, game.min.js, assets/, _headers) with its atlas baked, in the folder the dev server exports to',
      () => this.exportGame(),
    );
    this._buttons.appendChild(this._bake);
    this._buttons.appendChild(this._export);
    this._note = document.createElement('div');
    this._note.style.cssText = NOTE_STYLE;
    this.el.appendChild(this._buttons);
    this.el.appendChild(this._note);
    /** The bake or export under way, so a second click waits for it. */
    this._busy = null;
  }

  /**
   * Bake the running scene's atlas next to its module (atlasBake.js) and say where it went, and what makes the scene
   * load it.
   * @returns {Promise<object|null>} what bakeAtlas returns, or null when it could not
   */
  bake() {
    return this._run('Baking the atlas…', async () => {
      const baked = await bakeAtlas(this.editMode.debugUI.scene);
      const file = baked.png.split('/').pop();
      this._say(
        `Baked ${baked.png} (${baked.width} × ${baked.height}, ${baked.frames} frames) and its .atlas.json. ` +
          `The scene loads them instead of packing once its static assets have ${baked.assets}.`,
        false,
      );
      this.editMode._setStatus(`Baked ${file}`, false);
      return baked;
    });
  }

  /**
   * Export the running game through the dev server (gameExport.js) and say where it went, with a link to it when the
   * server serves that folder. Unsaved edits are not exported: with some, it asks first.
   * @returns {Promise<object|null>} the route's answer, or null when it did not export
   */
  exportGame() {
    const editMode = this.editMode;
    if (editMode.dirty) {
      const go = typeof confirm === 'function' && confirm(`${editMode.sceneFileName} has unsaved changes, which the export leaves out. Export the saved files?`);
      if (!go) return Promise.resolve(null);
    }
    return this._run('Exporting: baking the atlas, bundling the game…', async () => {
      const done = await exportRunningGame(editMode.debugUI.scene);
      const mb = (done.bytes / (1024 * 1024)).toFixed(1);
      const kb = (done.gameBytes / 1024).toFixed(1);
      const warned = done.warnings.length ? ` ${done.warnings.join('; ')}.` : '';
      this._say(`Exported to ${done.outDir}: ${done.files.length} files, ${mb} MB (game.min.js ${kb} KB).${warned}`, false);
      if (done.url) {
        const link = document.createElement('a');
        link.href = done.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = ` Open ${done.url}`;
        link.style.color = '#7dd3fc';
        this._note.appendChild(link);
      }
      editMode._setStatus(`Exported to ${done.outDir}`, false);
      console.info(`[WeedJS] editor: exported to ${done.outDir}${done.url ? ` (served at ${done.url})` : ''}`);
      return done;
    });
  }

  /** Run one task at a time, with the buttons off and its outcome on the note line. */
  async _run(working, task) {
    if (this._busy !== null) return this._busy.then(() => null);
    this._setButtons(false);
    this._say(working, false);
    this._busy = (async () => {
      try {
        return await task();
      } catch (error) {
        console.error(`[WeedJS] editor: ${error.message}`);
        this._say(error.message, true);
        this.editMode._setStatus(error.message, true);
        return null;
      }
    })();
    try {
      return await this._busy;
    } finally {
      this._busy = null;
      this._setButtons(true);
    }
  }

  _setButtons(enabled) {
    for (const button of this._buttons.children) button.disabled = !enabled;
  }

  _say(text, isError) {
    this._note.textContent = text;
    this._note.style.color = isError ? '#f87171' : '#9aa0b0';
  }

  _button(text, title, onclick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'debug-ui-btn';
    button.textContent = text;
    button.title = title;
    button.onclick = onclick;
    return button;
  }
}
