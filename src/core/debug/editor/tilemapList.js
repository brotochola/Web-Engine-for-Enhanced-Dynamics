// tilemapList.js — the palette's Tilemaps section (VISUAL_EDITOR_PLAN.md ED-26): a line per Tiled tilemap the running
// scene declares, with its id, its file, its size in tiles and layers, the scene layers that show it, and a button
// that loads its file again in place (tilemapReload.js). Hot reload does the same by itself when the dev server says
// the file changed. Painting stays in Tiled. Built when the scene changes, never per frame; hidden for a scene with
// no tilemap.

import { sceneTilemaps, reloadTilemap } from '../tilemapReload.js';

const TEXT_STYLE = 'font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

export class TilemapList {
  /** @param {object} editMode - the EditMode whose status line says how a reload went */
  constructor(editMode) {
    this.editMode = editMode;
    this._box = null;
    this._boxScene = null;
  }

  /**
   * The rows of the running scene's tilemaps into `box`: built when the scene changes, not on every palette refresh.
   * @param {HTMLElement} box
   */
  fill(box) {
    const scene = this.editMode.debugUI.scene ?? null;
    if (box === this._box && scene === this._boxScene) return;
    this._box = box;
    this._boxScene = scene;
    box.textContent = '';
    const maps = sceneTilemaps(scene);
    box.style.display = maps.length === 0 ? 'none' : '';
    if (maps.length === 0) return;
    const head = document.createElement('div');
    head.textContent = 'Tilemaps · painted in Tiled';
    head.style.cssText = 'font-size:9px;color:#888;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:2px';
    box.appendChild(head);
    for (const map of maps) box.appendChild(this._row(map));
  }

  /**
   * Load tilemap `id`'s file again in place; the status line says how it went.
   * @returns {Promise<string>} reloadTilemap's result
   */
  async reload(id) {
    const { result, reason } = await reloadTilemap(this.editMode.debugUI.scene, id);
    if (result === 'reloaded') this.editMode._setStatus(`Tilemap ${id} reloaded from its file`, false);
    else if (result === 'reload') this.editMode._setStatus(`Tilemap ${id}: ${reason}. Reload the game to load it`, true);
    else this.editMode._setStatus(`Tilemap ${id}: ${reason}`, true);
    return result;
  }

  _row(map) {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:1fr auto;align-items:center;gap:2px 6px;margin:2px 0';
    row.dataset.tilemap = map.id;
    const file = map.json === null ? '(no file)' : decodeURIComponent(map.json.split('/').pop());
    const name = document.createElement('span');
    name.textContent = `${map.id}  ·  ${file}`;
    name.title = `${map.json ?? ''}\ntileset ${map.png ?? '(none)'}`;
    name.style.cssText = `${TEXT_STYLE};color:#ddd`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'debug-ui-btn';
    button.textContent = '↻';
    button.title = `Load ${file} again: its tiles go in place, the editor keeps its state`;
    button.onclick = () => this.reload(map.id);
    const detail = document.createElement('span');
    const tilemap = map.tilemap;
    const size = tilemap === null ? 'did not load' : `${tilemap.mapWidth}×${tilemap.mapHeight} tiles of ${tilemap.tileWidth} px, ${plural(tilemap.getLayerNames().length, 'layer')}`;
    detail.textContent = map.shownBy.length === 0 ? `${size}; no layer shows it` : `${size}; on ${map.shownBy.join(', ')}`;
    detail.style.cssText = `${TEXT_STYLE};color:#888;font-size:10px;grid-column:1 / 3`;
    row.append(name, button, detail);
    return row;
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
