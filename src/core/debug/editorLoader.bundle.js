// editorLoader.bundle.js — where the engine's debug bundle finds the editor (VISUAL_EDITOR_PLAN.md ED-29): the
// @weed.js/editor package's script (weed.editor.min.js, which sets globalThis.WEED_EDITOR), or its ES module through an
// import map entry for '@weed.js/editor'. The bundles alias editorLoader.js to this file.

/** Said once when the editor is asked for and is not there. */
export const EDITOR_MISSING =
  'WeedJS: the editor is not loaded. Install @weed.js/editor (npm i -D @weed.js/editor) and add its ' +
  'dist/weed.editor.min.js to the page after the engine, or map "@weed.js/editor" to its dist/weed.editor.esm.min.js.';

/** The editor's entry module, or a rejection that says how to add it. */
export async function loadEditorModule() {
  if (globalThis.WEED_EDITOR) return globalThis.WEED_EDITOR;
  try {
    return await import(/* webpackIgnore: true */ '@weed.js/editor');
  } catch {
    throw new Error(EDITOR_MISSING);
  }
}
