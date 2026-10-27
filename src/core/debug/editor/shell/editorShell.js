// editorShell.js — the editor page (VISUAL_EDITOR_PLAN.md D9, ED-15): the game's own page in a same-origin iframe,
// docks around it, and the host that the game page's debug UI connects to (window.__weedEditorHost). The editor's
// code runs in the game page, as in edit mode there; this page lays it out, keeps what a reload of the game page
// hands over, and passes on the keys typed here.
//
//   /src/core/debug/editor/shell/?game=<the game's page, on this server>
//
// Nothing of the game page is kept past its pagehide: its nodes are taken out of the docks, its objects are dropped,
// and the state it hands over is copied with this page's own structuredClone. Any object of a reloaded page's realm
// (a node, a function, a plain object) would keep that realm alive, and its shared memories with it. The styles it
// sends are text, put into a style element of this page's.

/** Where the game page looks for the host (editorHost.js). */
export const HOST_KEY = '__weedEditorHost';
/** The protocol's version: a game page of another version runs as if it were not hosted. */
export const HOST_VERSION = 1;
/** The docks a game page fills. */
export const SLOT_NAMES = ['toolbar', 'tree', 'inspector', 'assets', 'console', 'debug'];
/** The last game page opened here, for the form (this viewer's convenience only). */
const LAST_GAME_KEY = 'weed.editor.lastGame';

export class EditorHost {
  /**
   * @param {{ slots: Record<string, Element>, frame?: { focus(): void, contentWindow?: object } | null,
   *   document?: Document | null, onStatus?: (text: string) => void }} parts
   */
  constructor({ slots, frame = null, document: doc = null, onStatus = null }) {
    this.version = HOST_VERSION;
    this._slots = slots;
    this._frame = frame;
    this._document = doc;
    this._onStatus = onStatus;
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

  /** A key typed in this page: the connected game page's editor takes the ones it wants. */
  onKeyDown(e) {
    if (this._client !== null) this._client.onHostKey(e);
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

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // storage blocked
  }
}

/** Build the editor page from its markup (index.html): the host, the game's iframe, the tabs, the keys. */
export function startEditorShell(doc) {
  const win = doc.defaultView;
  const slots = {};
  for (const el of doc.querySelectorAll('[data-slot]')) slots[el.dataset.slot] = el;
  const frame = doc.getElementById('game');
  const status = doc.getElementById('status');
  const host = new EditorHost({
    slots,
    frame,
    document: doc,
    onStatus: (text) => {
      status.textContent = text;
    },
  });
  win[HOST_KEY] = host;
  win.addEventListener('keydown', (e) => host.onKeyDown(e));

  // The bottom dock's tabs.
  for (const tab of doc.querySelectorAll('[data-tab]')) {
    tab.addEventListener('click', () => {
      for (const t of doc.querySelectorAll('[data-tab]')) t.classList.toggle('active', t === tab);
      for (const pane of doc.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== tab.dataset.tab;
    });
  }

  const game = gamePageUrl(new URLSearchParams(win.location.search).get('game'), win.location.href);
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
  try {
    storage()?.setItem(LAST_GAME_KEY, new URLSearchParams(win.location.search).get('game'));
  } catch {
    // full or blocked: the form starts empty next time
  }
  doc.getElementById('gameOnly').href = game;
  doc.getElementById('reload').addEventListener('click', () => frame.contentWindow?.location.reload());
  status.textContent = 'Loading the game…';
  frame.addEventListener('load', () => {
    // The page loaded and has not connected: it has no debug UI (debug: true), or another version of it.
    if (!host.connected) status.textContent = 'This page has no WeedJS debug UI: create its GameEngine with debug: true';
  });
  frame.src = game;
  return host;
}
