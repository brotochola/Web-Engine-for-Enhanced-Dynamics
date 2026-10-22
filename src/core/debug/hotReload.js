// Hot reload that keeps the game state (debug build only; prod uses stubs/hotReload.js).
//
// `npm run dev` pushes a Server-Sent Event on /__weed/reload when a served file
// changes. The page saves the running scene to a reserved slot, notes the scene
// URL (and its loadScene data) in sessionStorage, and reloads. The next
// loadScene of that URL restores the slot once. A full reload sidesteps the
// browser's module cache: the main thread would keep the old entity modules.

const SLOT = '__weed-hot-reload';
const KEY = 'weed.hotReload';
const ENDPOINT = '/__weed/reload';

function session() {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null; // storage blocked (privacy mode, sandboxed iframe)
  }
}

export class HotReload {
  static SLOT = SLOT;
  static _source = null;
  static _busy = false;

  /** Listen for the dev server's change events. A server without the endpoint closes it quietly. */
  static start(game) {
    if (this._source !== null || typeof EventSource === 'undefined' || typeof location === 'undefined') return;
    let opened = false;
    const source = new EventSource(ENDPOINT);
    source.onopen = () => {
      opened = true;
    };
    source.onerror = () => {
      if (!opened) source.close(); // not `npm run dev`: do not retry forever
    };
    source.onmessage = () => {
      this.reloadKeepingState(game);
    };
    this._source = source;
  }

  static stop() {
    if (this._source !== null) this._source.close();
    this._source = null;
  }

  /** Save the running scene, remember which one it was, reload the page. */
  static async reloadKeepingState(game) {
    if (this._busy) return;
    this._busy = true;
    const store = session();
    const scene = game && game.currentScene;
    try {
      if (store && scene && scene.sceneScriptUrl && game.state === 1) {
        const { saveGame } = await import('../save/saveGame.js');
        await saveGame(scene, SLOT);
        store.setItem(KEY, JSON.stringify({ url: scene.sceneScriptUrl, data: scene.data ?? null }));
      }
    } catch (error) {
      console.warn('[WeedJS] hot reload: could not save the scene; reloading without its state', error);
      if (store) store.removeItem(KEY);
    }
    location.reload();
  }

  /**
   * loadScene: if this page was reloaded by a change while `sceneScriptUrl` ran,
   * return how to restore it. The note is used up by the first loadScene either
   * way, so it never restores into a scene loaded later. Null otherwise.
   * @param {string|null} sceneScriptUrl
   * @returns {{ restoreSlot: string, data: unknown } | null}
   */
  static takeRestore(sceneScriptUrl) {
    const store = session();
    if (!store || !sceneScriptUrl) return null;
    let rec = null;
    try {
      rec = JSON.parse(store.getItem(KEY) || 'null');
    } catch {
      rec = null;
    }
    if (!rec) return null;
    store.removeItem(KEY);
    if (rec.url !== sceneScriptUrl) return null;
    return { restoreSlot: SLOT, data: rec.data ?? null };
  }

  /**
   * The state saved before the reload, or null when it is gone (the page
   * unloaded before the save committed) or does not decode. A hot reload must
   * never stop the scene from loading: with null, loadScene starts it fresh.
   */
  static async readSlot() {
    try {
      const { SaveStore, decodeSave } = await import('../save/saveGame.js');
      const blob = await SaveStore.get(SLOT);
      if (blob) return await decodeSave(blob);
      console.warn('[WeedJS] hot reload: the saved state is gone; starting the scene fresh');
    } catch (error) {
      console.warn('[WeedJS] hot reload: could not read the saved state; starting the scene fresh', error);
    }
    return null;
  }

  /** After the restore: the reserved slot is not a save the player made. */
  static async discardSlot() {
    try {
      const { SaveStore } = await import('../save/saveStore.js');
      await SaveStore.remove(SLOT);
    } catch {
      /* nothing to clean */
    }
  }
}
