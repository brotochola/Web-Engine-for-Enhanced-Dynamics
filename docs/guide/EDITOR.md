# The editor

The editor works on a running game: you place and tune what a level holds, try it, and save it to its scene file ([SCENE_FILES.md](./SCENE_FILES.md)). It runs inside a debug build of the engine (`new GameEngine({ debug: true })`), in two ways:

- **In the game page.** Press Shift+E. The world holds still and the view is yours; the Editor and Palette panels float over the game.
- **In the editor page.** The game page runs in the middle of a page with docks around it: the scene's entities on the left, the inspector and the assets on the right, the console and the debug panels below. Open `/editor` on the dev server (in this repository `/editor?scene=platformergame` opens that demo, and `/editor` alone the demo list), or press the Scene panel's "Editor page" button. The address follows the game page open in it, so a reload or a bookmark comes back to it; `/editor?game=<a page of the server>` opens any other page.

The editor is the package `@weed.js/editor`. Games made with `npm create weed-game` have it as a dev dependency, and `npm run dev` serves its page and its routes. `npm run build` leaves it out: players never download it. To add it to another game, see the package's README.

## Edit and play

| | |
| --- | --- |
| Shift+E, or ✎ Edit | Edit mode: the world holds still (time scale 0), the camera is free and the game gets no input |
| ▶ Play | Leave edit mode: the game runs from here |
| ■ Stop | Back to the level as its scene file's document has it, in edit mode |

Stop throws away what happened while playing: where things moved, what spawned, the score. It keeps what you changed in the level, saved or not, with its undo. If the game went to another level while you played (a goal), Stop goes back to the one Play started from.

In edit mode:

| Key or action | What it does |
| --- | --- |
| Click | Select what is under the pointer; again on the same spot, the next one under it |
| Drag the selection | Move it (a dashed ghost shows where it lands; it moves on release) |
| Arrows, Shift+arrows | Nudge by the grid step, or ten steps |
| G | Grid step: 1, 8, 16, 32 px |
| Right or middle drag, wheel | Pan, zoom |
| Ctrl+S | Save the level to its scene file |
| Ctrl+Z, Ctrl+Y | Undo, redo |
| Ctrl+D, Del | Duplicate, delete |
| Esc | Stop placing; clear the selection; leave edit mode |

## Placed and runtime entities

An entity the scene file places has a name there (`Platform3`): it is **placed**. Selecting it shows its spawn params as fields: a slider for a number with a range, a color picker, a dropdown for an enum or an entity param. A change rewrites its record in the file's document and respawns it, so what you see is what the file will load. Each change is one undo.

An entity your code spawned (the player, enemies, bullets) is **runtime**: the file does not hold it, and the editor shows it read-only.

The Palette (in the editor page, Assets) lists the scene's entity classes, with how many the file places against each pool. Its `+` places one wherever you click, on the grid, under a free name, until Esc. A full pool says which count to raise in the scene's `static entities`.

## Live values

Below the params, the inspector shows the selected entity as it is now: each column of its components, refreshed while the game plays. A field there changes the live entity (its position through `setPosition`, a column through its component's setter), not the file, so Stop throws it away. A column a worker writes every frame (a body's velocity, a pose) shows the worker's value again.

**Copy to scene** writes the live entity into its record, as one change: its position, and each spawn param named like a column of its components, such as a platform's `width` from its Collider or its `tint` from its SpriteRenderer. Tune while playing, then copy what you like.

## Levels

The level row (Palette, Assets) lists the scene files of the running one's folder. Open loads one: a fast swap when it is a level of the running scene class. New writes an empty level of the same scene class. Save As writes the level to another file and goes on in that one. Unsaved changes are never dropped without asking.

Saving needs the dev server's routes: they write only `*.scene.json` files inside the served folder, and answer only pages of this machine.

## The editor page

- **Scene**: every entity, grouped by class, placed ones by name and runtime ones by index. Only the rows on screen are drawn, so a scene of tens of thousands of entities lists quickly. A click selects; a double click centers the view on it.
- **Inspector**, **Assets**: as above.
- **Console**: what the game page and its workers log (a worker's `console.log` included), and each error your game code throws in a worker, once, with how many times it happened since; a click on an error selects the entity that threw.
- **Debug**: the engine's debug panels (scene, performance, memory, layers, …).

The editor page outlives the game page: when the game page reloads (hot reload of an engine file, Reload game), the level you were editing comes back with its unsaved changes, its undo, the selection and the view. Reloading or closing the editor page itself asks first when there are unsaved changes.

While its console shows, the workers pass their console calls to the page; DevTools then names `consoleForward.js` as where each one comes from. The game page on its own, and production, do not do this.
