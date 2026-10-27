# @weed.js/editor

The WeedJS visual editor. Your game runs in the middle; around it, the scene's entities, an inspector, the level
files and the classes to place, the console and the engine's debug panels. Click an entity to select it, drag it, tune
its params, place new ones, press Play to try the level and Stop to come back to it, and save the level to its
`*.scene.json` file.

It works with a debug build of the engine (`new GameEngine({ debug: true })`) and a dev server that has its routes.
Games made with `npm create weed-game` have both.

## Install

```sh
npm i -D @weed.js/editor
```

## Use it

1. Load the editor in the game page, after the engine, either as a script

   ```html
   <script src="./node_modules/@weed.js/editor/dist/weed.editor.min.js"></script>
   ```

   or through the page's import map (the engine loads it the first time it is needed):

   ```json
   { "imports": { "@weed.js/editor": "./node_modules/@weed.js/editor/dist/weed.editor.esm.min.js" } }
   ```

2. Give your dev server the editor's routes (saving and listing scene files, and the editor page):

   ```js
   import { handleDevRoute, serveEditorPage } from '@weed.js/editor/server';
   // in the request handler, before serving files:
   if (handleDevRoute(req, res, root, HEADERS)) return;
   if (serveEditorPage(req, res, { headers: HEADERS })) return;
   ```

3. Open `http://localhost:8000/editor`, or press Shift+E in the game to edit it in place.

The routes answer only pages of this machine, and write only `*.scene.json` files inside the served folder.

## Keys

| Key | What it does |
| --- | --- |
| Shift+E | Edit mode on and off (Play) |
| Click, drag | Select, move |
| Arrows (Shift: ×10) | Nudge by the grid step |
| G | Grid step: 1, 8, 16, 32 px |
| Ctrl+S | Save the level |
| Ctrl+Z, Ctrl+Y | Undo, redo |
| Ctrl+D, Del | Duplicate, delete |
| Esc | Stop placing, clear the selection, leave edit mode |
