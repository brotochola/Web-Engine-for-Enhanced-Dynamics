// Hot reload (debug build only; prod uses stubs/hotReload.js).
//
// `npm run dev` pushes a Server-Sent Event on /__weed/reload when a served file
// changes. A script of the running scene (the scene file and what it imports)
// is swapped in place, on the page and in every worker (hotSwap.js): no reload,
// the shared memory and everything in it stay as they are.
//
// Anything else (an asset, a shader, the page, an engine file), or a change the
// running game cannot take (components, pools, which hooks a class defines...),
// falls back to a reload that keeps the state: the page saves the running scene
// to a reserved slot, notes the scene URL (and its loadScene data) in
// sessionStorage, and reloads. The next loadScene of that URL restores it once.

import { nativeImport } from '../../util/sceneScript.js';
import { expandBlobEntityScripts } from '../../util/utils.js';
import { swapModule, hotModuleUrl } from './hotSwap.js';

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
  static _queue = Promise.resolve();
  static _version = 0;

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
    source.onmessage = (event) => {
      // One change at a time: a save that lands mid-swap waits for it.
      this._queue = this._queue.then(() => this.onFileChanged(game, event.data)).catch((error) => {
        console.warn('[WeedJS] hot reload failed; reloading the page', error);
        this.reloadKeepingState(game);
      });
    };
    this._source = source;
  }

  /**
   * A served file changed. A script of the running scene is swapped in place;
   * anything else reloads the page keeping the scene's state.
   * @param {object} game
   * @param {string} data the event's JSON: { file } relative to the served folder
   */
  static async onFileChanged(game, data) {
    let file = '';
    try {
      file = JSON.parse(data).file || '';
    } catch {
      /* an older server sends no file: reload */
    }
    const scene = game && game.currentScene;
    if (!/\.m?js$/i.test(file) || !scene || !scene.sceneScriptUrl || game.state !== 1) {
      return this.reloadKeepingState(game);
    }
    const url = new URL(file.replace(/^\/+/, ''), `${location.origin}/`).href;
    const graph = await expandBlobEntityScripts([scene.sceneScriptUrl]);
    // Swap the module under the URL the game loaded it with (the scene's may carry a query).
    const loaded = graph.find((u) => u.split(/[?#]/)[0] === url);
    if (!loaded) return this.reloadKeepingState(game);

    const result = await this.swapEverywhere(scene, loaded);
    if (result.reload) {
      console.info(`[WeedJS] hot reload: ${result.reload}; reloading the page with the scene's state`);
      return this.reloadKeepingState(game);
    }
    console.info(`[WeedJS] hot swapped ${file}${result.swapped.length ? ` (${result.swapped.join(', ')})` : ''}`);
    return result;
  }

  /**
   * Swap a module on the page, then in every worker. The first thread that cannot
   * take the change stops it: the caller reloads, which also drops partial swaps.
   * @param {object} scene
   * @param {string} url
   * @returns {Promise<{ swapped: string[], reload: string|null }>}
   */
  static async swapEverywhere(scene, url) {
    const version = ++this._version;
    let here;
    try {
      here = swapModule(await nativeImport(url), await nativeImport(hotModuleUrl(url, version)));
    } catch (error) {
      return { swapped: [], reload: `could not load the new ${url} (${error && error.message})` };
    }
    if (here.reload) return here;

    // Every engine worker loaded the scene's scripts; the Box2D host did not.
    const workers = scene.getAllWorkers().filter((w) => w !== scene.workers.physics);
    const answers = await new Promise((resolve) => {
      const got = [];
      const timer = setTimeout(() => {
        scene._hotSwapReply = null;
        resolve(null);
      }, 5000);
      scene._hotSwapReply = (reply) => {
        if (reply.id !== version) return;
        got.push(reply);
        if (got.length < workers.length) return;
        clearTimeout(timer);
        scene._hotSwapReply = null;
        resolve(got);
      };
      for (const worker of workers) worker.postMessage({ msg: 'hotSwap', url, version, id: version });
    });
    if (!answers) return { swapped: here.swapped, reload: 'a worker did not answer the swap' };
    for (const answer of answers) {
      if (answer.reload) return { swapped: here.swapped, reload: `${answer.worker}: ${answer.reload}` };
    }
    return here;
  }

  static stop() {
    if (this._source !== null) this._source.close();
    this._source = null;
  }

  /**
   * Save the running scene, remember which one it was, reload the page. The save
   * holds every entity, serializable or not: the whole scene comes back.
   */
  static async reloadKeepingState(game) {
    if (this._busy) return;
    this._busy = true;
    const store = session();
    const scene = game && game.currentScene;
    try {
      if (store && scene && scene.sceneScriptUrl && game.state === 1) {
        const { saveGame } = await import('../save/saveGame.js');
        await saveGame(scene, SLOT, { allEntities: true, instanceFields: true });
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
   * unloaded before the save committed), does not decode, or belongs to another
   * scene class (the edit renamed it). A hot reload must never stop the scene
   * from loading: with null, loadScene starts it fresh.
   * @param {string} [sceneName] the scene class about to load
   */
  static async readSlot(sceneName) {
    try {
      const { SaveStore, decodeSave } = await import('../save/saveGame.js');
      const blob = await SaveStore.get(SLOT);
      if (blob) {
        const payload = await decodeSave(blob);
        if (!sceneName || !payload.sceneName || payload.sceneName === sceneName) return payload;
        console.warn(`[WeedJS] hot reload: the saved state is ${payload.sceneName}'s, not ${sceneName}'s; starting the scene fresh`);
        return null;
      }
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
