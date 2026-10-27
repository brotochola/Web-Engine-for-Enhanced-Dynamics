// shipRow.js — the last row of the editor's Assets dock (the palette, VISUAL_EDITOR_PLAN.md Stage 5): Bake atlas
// (ED-31), and a line that says what the last one made and where it went. Built once with the palette's body; the
// DOM changes only when a button is used.

import { bakeAtlas } from './atlasBake.js';

const NOTE_STYLE = 'font-size:10px;white-space:normal;overflow-wrap:anywhere;margin-top:4px';

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
    this._buttons.appendChild(this._bake);
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
