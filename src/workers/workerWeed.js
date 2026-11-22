/**
 * The `WEED` that workers hand to scene and entity scripts.
 *
 * Workers evaluate the scene file to find its entity classes, so every name an
 * entity may use at runtime is here: the names the page's WEED has too
 * (weedNames.js, N-303 CR-13). Main-thread-only names (GameEngine, saves, the
 * atlas inspector) are not. Bundled workers do not carry the main-thread
 * Scene: `class MyScene extends Scene` extends the empty stand-in below, and
 * the worker only reads its statics (`entities`, `sharedResources`).
 */
import { sceneParams } from '../core/sceneParams.js';
import * as shared from '../weedNames.js';
import { enums } from '../weedEnums.js';

/** Stand-in for the main-thread Scene: workers only read a scene class's statics. */
class Scene {}

export const WORKER_WEED = Object.freeze({
  /** The page's URL parameters: `location` here is this worker's script. */
  get params() {
    return sceneParams();
  },
  ...enums,
  ...shared,
  enums,
  Scene,
  DebugUI: shared.DebugDraw, // workers draw through DebugDraw; DebugUI.drawLine(...) still works
});
