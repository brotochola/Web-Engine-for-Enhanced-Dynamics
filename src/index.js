// ============================================================================
// WeedJS - Multithreaded Game Engine 🌿
// Main entry point for the engine
// ============================================================================

import { sceneParams } from './core/sceneParams.js';
import * as shared from './weedNames.js';
import { enums } from './weedEnums.js';
import { GameEngine } from './core/gameEngine.js';
import { Scene } from './core/scene.js';
import { DebugUI } from './core/debug/debugUi.js';
import { BigAtlasInspector } from './core/bigAtlasInspector.js';
import { setupWorkerCommunication } from './util/utils.js';
import {
  SaveStore,
  saveGame,
  loadGame,
  buildSavePayload,
  encodeSave,
  decodeSave,
} from './core/save/saveGame.js';

// Every name the workers' WEED has too (weedNames.js: the engine's classes, components, pools, helpers and enums), then
// the page's own.
export * from './weedNames.js';
export {
  GameEngine,
  Scene,
  DebugUI,
  BigAtlasInspector,
  setupWorkerCommunication,
  SaveStore,
  saveGame,
  loadGame,
  buildSavePayload,
  encodeSave,
  decodeSave,
};
export { sceneParams } from './core/sceneParams.js';

const SaveGame = Object.freeze({
  SaveStore,
  saveGame,
  loadGame,
  buildSavePayload,
  encodeSave,
  decodeSave,
});

export { SaveGame };

// ============================================================================
// WEED NAMESPACE - PIXI-style usage 🌿
// ============================================================================
const WEED = Object.freeze({
  /** The page's URL parameters (or loadScene's { params }), the same on every thread. */
  get params() {
    return sceneParams();
  },
  author: 'Facundo Saiegh',
  github: 'https://github.com/brotochola/Web-Engine-for-Enhanced-Dynamics',
  ...enums,
  ...shared,
  enums,

  GameEngine,
  Scene,
  DebugUI,
  BigAtlasInspector,
  SaveGame,
  SaveStore,
  saveGame,
  loadGame,
  buildSavePayload,
  encodeSave,
  decodeSave,
  setupWorkerCommunication,
});

if (typeof window !== 'undefined') {
  window.WEED = WEED;
}

export default WEED;
