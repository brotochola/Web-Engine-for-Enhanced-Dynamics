// editorShell.js — the editor page (VISUAL_EDITOR_PLAN.md D9, ED-15): the game's own page in a same-origin iframe,
// docks around it, and the host that the game page's debug UI connects to (window.__weedEditorHost). The editor's
// code runs in the game page, as in edit mode there; this page lays it out, keeps what a reload of the game page
// hands over, and passes on the keys typed here.
//
//   /editor?scene=platformergame        the dev server's game page (/demos/ in the engine's repository, / for a game)
//                                       with this query (server/editorPage.js fills it into index.html)
//   /editor?game=<a page of this server> any game page; also /src/core/debug/editor/shell/?game=… from the source
//
// The address follows the game page open in it, in its shortest form, so a reload or a bookmark opens it again.
//
// The docks resize and fold (editorLayout.js, ED-50); Ctrl+1, Ctrl+2 and Ctrl+3 fold them, typed here or in the game
// page (its editor passes them on: dockKey).
//
// Nothing of the game page is kept past its pagehide: its nodes are taken out of the docks, its objects are dropped,
// and the state it hands over is copied with this page's own structuredClone. Any object of a reloaded page's realm
// (a node, a function, a plain object) would keep that realm alive, and its shared memories with it. The styles it
// sends are text, put into a style element of this page's.

import { DockLayout, dockLayoutElements } from './editorLayout.js';

/** Where the game page looks for the host (editorHost.js). */
export const HOST_KEY = '__weedEditorHost';
/**
 * The protocol's version: a game page of another version runs as if it were not hosted. What was added since its
 * first form is optional: dockKey (a game page checks that its host has it).
 */
export const HOST_VERSION = 1;
/** The docks a game page fills. */
export const SLOT_NAMES = ['toolbar', 'tree', 'inspector', 'assets', 'console', 'debug'];
/** The last game page opened here, for the form (this viewer's convenience only). */
const LAST_GAME_KEY = 'weed.editor.lastGame';

export class EditorHost {
  /**
   * @param {{ slots: Record<string, Element>, frame?: { focus(): void, contentWindow?: object } | null,
   *   document?: Document | null, onStatus?: (text: string) => void, onSceneReady?: () => void,
   *   onDockKey?: (digit: number) => boolean }} parts
   */
  constructor({ slots, frame = null, document: doc = null, onStatus = null, onSceneReady = null, onDockKey = null }) {
    this.version = HOST_VERSION;
    this._slots = slots;
    this._frame = frame;
    this._document = doc;
    this._onStatus = onStatus;
    this._onSceneReady = onSceneReady;
    this._onDockKey = onDockKey;
    /** The game page connected now (its editorHost.js), or null. */
    this._client = null;
    /** What the last game page handed over, as this page's own copy, until the next one takes it. */
    this._kept = null;
    /** Style elements of this page's, by id, holding what game pages sent. */
    this._styles = new Map();
  }

  /** Whether a game page is connected. */
  get connected() {
    return this._client !== null;
  }

  /**
   * A game page's debug UI connects (at its construction). It gets the docks to fill and what the page before it
   * handed over: this page's copy, which it copies again into its own realm. The host lets go of it then.
   * @param {object} client - the game page's side (onHostKey)
   * @returns {{ version: number, slots: Record<string, Element>, kept: object|null }}
   */
  connect(client) {
    if (this._client !== null) this._dropClient();
    this._client = client;
    const kept = this._kept;
    this._kept = null;
    this._status('');
    return { version: HOST_VERSION, slots: { ...this._slots }, kept };
  }

  /**
   * The game page leaves (its pagehide). Its state is copied, then everything of it is let go: the nodes it put into
   * the docks and the page itself.
   * @param {object} client
   * @param {object|null} state - what it hands over (EditMode.handover), or null
   */
  disconnect(client, state) {
    if (client !== this._client) return;
    let kept = null;
    if (state !== null && state !== undefined) {
      try {
        kept = structuredClone(state);
      } catch (error) {
        console.warn('[WeedJS] editor page: the game page handed over a state that cannot be copied; it is dropped', error);
      }
    }
    this._kept = kept;
    this._dropClient();
    this._status('The game is reloading…');
  }

  /** CSS a game page sends (its debug UI's), into a style element of this page's own. */
  addStyles(id, cssText) {
    const doc = this._document;
    if (doc === null || typeof cssText !== 'string') return;
    let style = this._styles.get(id);
    if (style === undefined) {
      style = doc.createElement('style');
      style.dataset.weedStyles = id;
      doc.head.appendChild(style);
      this._styles.set(id, style);
    }
    if (style.textContent !== cssText) style.textContent = cssText;
  }

  /** Give the game the keys (Play from the toolbar: the game's keys go to it, not to this page). */
  focusGame() {
    const frame = this._frame;
    if (frame === null) return;
    frame.focus();
    frame.contentWindow?.focus();
  }

  /** The connected game page's scene is ready: the page may have changed its address since it loaded (a demo chosen). */
  sceneReady(client) {
    if (client === this._client && this._onSceneReady !== null) this._onSceneReady();
  }

  /** Whether the connected game page's editor has changes its file does not hold (this page's unload asks first). */
  hasUnsavedChanges() {
    return this._client !== null && this._client.hasUnsavedChanges?.() === true;
  }

  /** A key typed in this page: the connected game page's editor takes the ones it wants. */
  onKeyDown(e) {
    if (this._client !== null) this._client.onHostKey(e);
  }

  /**
   * Ctrl+1, Ctrl+2 or Ctrl+3 typed in the game page (its editor passes them on): fold or unfold a dock of this page.
   * Optional in the protocol: a game page checks that it is there.
   * @param {number} digit
   * @returns {boolean} whether this page took it
   */
  dockKey(digit) {
    return this._onDockKey !== null && this._onDockKey(digit) === true;
  }

  _dropClient() {
    this._client = null;
    for (const name of SLOT_NAMES) this._slots[name]?.replaceChildren();
  }

  _status(text) {
    if (this._onStatus !== null) this._onStatus(text);
  }
}

/**
 * The game page a `game` query names, as a URL of this server, or null: none, or another origin.
 * @param {string|null} game
 * @param {string} pageUrl - this page's URL
 */
export function gamePageUrl(game, pageUrl) {
  if (typeof game !== 'string' || game.trim() === '') return null;
  let url;
  try {
    url = new URL(game.trim(), pageUrl);
  } catch {
    return null;
  }
  return url.origin === new URL(pageUrl).origin ? url.href : null;
}

/**
 * The game page this editor page opens: its `game` query (a page of this server); else the server's game page
 * (`defaultPage`) with this page's query, so /editor?scene=x opens /demos/?scene=x; else null (the form asks).
 * @param {string} search - this page's query
 * @param {string} pageUrl - this page's URL
 * @param {string} defaultPage - index.html's weed-game-page ('' when nothing filled it)
 */
export function gamePageFor(search, pageUrl, defaultPage) {
  const params = new URLSearchParams(search);
  if (params.has('game')) return gamePageUrl(params.get('game'), pageUrl);
  const home = gamePageUrl(defaultPage, pageUrl);
  if (home === null) return null;
  const url = new URL(home);
  for (const [key, value] of params) url.searchParams.append(key, value);
  return url.href;
}

/**
 * This page's query for the game page open in it, the shortest: the game page's own query when it is the server's
 * game page (`?scene=x`, or none), else `?game=` and its path.
 * @param {string} gameUrl
 * @param {string} pageUrl - this page's URL
 * @param {string} defaultPage
 */
export function editorQueryFor(gameUrl, pageUrl, defaultPage) {
  const url = new URL(gameUrl);
  if (defaultPage) {
    const home = new URL(defaultPage, pageUrl);
    if (url.origin === home.origin && pagePath(url.pathname) === pagePath(home.pathname) && !url.searchParams.has('game') && url.hash === '') {
      return url.search;
    }
  }
  return `?game=${encodeURIComponent(url.pathname + url.search + url.hash)}`;
}

/** A folder's page and its index.html are one page. */
const pagePath = (pathname) => (pathname.endsWith('/index.html') ? pathname.slice(0, -'index.html'.length) : pathname);

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // storage blocked
  }
}

/** Build the editor page from its markup (index.html): the host, the game's iframe, the docks, the keys. */
export function startEditorShell(doc) {
  const win = doc.defaultView;
  const slots = {};
  for (const el of doc.querySelectorAll('[data-slot]')) slots[el.dataset.slot] = el;
  const frame = doc.getElementById('game');
  const status = doc.getElementById('status');
  const gameOnly = doc.getElementById('gameOnly');
  const defaultPage = doc.querySelector('meta[name="weed-game-page"]')?.getAttribute('content') || '';
  // The docks: this viewer's sizes and folds, the handles, the fold buttons, the Console's pane.
  const layout = new DockLayout(dockLayoutElements(doc), { win, storage: storage() }).start();
  // The address follows the game page open here (a demo chosen in it, a link followed), in its shortest form.
  const showGamePage = () => {
    let href = '';
    try {
      href = frame.contentWindow?.location.href || '';
    } catch {
      return; // a page of another origin
    }
    if (!href.startsWith('http')) return; // about:blank
    gameOnly.href = href;
    const query = editorQueryFor(href, win.location.href, defaultPage);
    if (query !== win.location.search) win.history.replaceState(win.history.state, '', `${win.location.pathname}${query}`);
    const url = new URL(href);
    try {
      storage()?.setItem(LAST_GAME_KEY, url.pathname + url.search);
    } catch {
      // full or blocked: the form starts empty next time
    }
  };
  const host = new EditorHost({
    slots,
    frame,
    document: doc,
    onStatus: (text) => {
      status.textContent = text;
    },
    onSceneReady: showGamePage,
    onDockKey: (digit) => layout.toggleDock(digit),
  });
  win[HOST_KEY] = host;
  // Ctrl+1, 2, 3 are the docks'; the rest goes to the game page's editor.
  win.addEventListener('keydown', (e) => {
    if (!layout.onKey(e)) host.onKeyDown(e);
  });
  // Reloading or closing this page drops the editor's state with it: ask first when it has unsaved changes. A reload
  // of the game page alone keeps them (the handover).
  win.addEventListener('beforeunload', (e) => {
    if (!host.hasUnsavedChanges()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  const game = gamePageFor(win.location.search, win.location.href, defaultPage);
  const form = doc.getElementById('open');
  const input = doc.getElementById('gameUrl');
  if (game === null) {
    frame.hidden = true;
    form.hidden = false;
    input.value = storage()?.getItem(LAST_GAME_KEY) || '';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const url = gamePageUrl(input.value, win.location.href);
      if (url === null) {
        status.textContent = 'A page on this server, please';
        return;
      }
      const params = new URLSearchParams(win.location.search);
      params.set('game', input.value.trim());
      win.location.search = params.toString();
    });
    return host;
  }
  gameOnly.href = game;
  doc.getElementById('reload').addEventListener('click', () => frame.contentWindow?.location.reload());
  status.textContent = 'Loading the game…';
  frame.addEventListener('load', () => {
    showGamePage();
    // The page loaded and has not connected: it has no debug UI (debug: true), or another version of it.
    if (!host.connected) status.textContent = 'This page has no WeedJS debug UI: create its GameEngine with debug: true';
  });
  frame.src = game;
  return host;
}
