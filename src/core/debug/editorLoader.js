// editorLoader.js — where a debug build finds the editor (VISUAL_EDITOR_PLAN.md ED-29). From source: the editor's
// modules beside this one. The bundles alias this module to editorLoader.bundle.js, which takes the @weed.js/editor
// package's script, so the engine's debug bundle carries no editor code.

/** The editor's entry module (editor/editorMain.js). */
export function loadEditorModule() {
  return import('./editor/editorMain.js');
}
