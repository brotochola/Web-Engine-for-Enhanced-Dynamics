// editorMain.js — the editor's entry (VISUAL_EDITOR_PLAN.md ED-29): what a debug build of the engine asks for when it
// first needs the editor (Shift+E, the Edit button, the editor page). From source it is this module; a game on the
// engine's bundles gets it from the @weed.js/editor package (weed.editor), whose script sets globalThis.WEED_EDITOR
// to it, or through an import map entry for '@weed.js/editor' (editorLoader.bundle.js).

export { EditMode } from './editMode.js';
export { HostedEditor } from './editorHost.js';
