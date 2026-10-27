// editorPage.js — what a debug build of the engine knows of the editor page (VISUAL_EDITOR_PLAN.md D9, ED-29) before
// the editor itself is loaded: whether this page runs in it (findEditorHost), and where it is (editorPageUrl). The
// editor's code (src/core/debug/editor/, the @weed.js/editor package) is loaded only when it is needed.

/** Where the editor page puts its host (editor/shell/editorShell.js). */
export const HOST_KEY = '__weedEditorHost';
/** The protocol this side speaks: a host of another version is not used. */
export const HOST_VERSION = 1;
/** The dev server's route to the editor page (server/editorPage.js, the @weed.js/editor package's server). */
export const EDITOR_PAGE_ROUTE = '/__weed/editor/';

/**
 * The editor page this page runs in, or null: not in a frame, a frame of another origin (the read throws), or a
 * parent that is no editor page of this version.
 * @param {object} [win]
 */
export function findEditorHost(win = typeof window !== 'undefined' ? window : null) {
  try {
    const parent = win?.parent;
    if (!parent || parent === win) return null;
    const host = parent[HOST_KEY];
    return host && host.version === HOST_VERSION ? host : null;
  } catch {
    return null;
  }
}

/**
 * The editor page for this page: beside the editor's source when this module is served from source, else the dev
 * server's route (npm run dev, and a game's dev server with @weed.js/editor).
 * @param {string} [moduleUrl]
 * @param {string} [pageOrigin]
 */
export function editorPageUrl(moduleUrl = import.meta.url, pageOrigin = typeof location !== 'undefined' ? location.origin : '') {
  try {
    const url = new URL('./editor/shell/', moduleUrl);
    if (url.origin === pageOrigin) return url.href;
  } catch {
    // a bundle: no module URL of this server
  }
  return pageOrigin ? new URL(EDITOR_PAGE_ROUTE, pageOrigin).href : EDITOR_PAGE_ROUTE;
}
