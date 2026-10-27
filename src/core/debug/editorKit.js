// editorKit.js — the engine modules the editor uses (VISUAL_EDITOR_PLAN.md ED-29), by their path under src/. The
// editor (src/core/debug/editor/) ships on its own, as the @weed.js/editor package (weed.editor); a debug build of the
// engine publishes these as WEED_EDITOR_KIT, and the editor's bundle resolves every import from outside its folder to
// them (webpack.editor.config.js), so the editor and the game share one Time, one Camera, the same component arrays.
// From source the editor imports the modules themselves. editorKit.test.js checks that every import the editor makes
// from outside its folder is here.

import * as transform from '../../components/transform.js';
import * as collider from '../../components/collider.js';
import * as spriteRenderer from '../../components/spriteRenderer.js';
import * as adobeAnimComponent from '../../components/adobeAnimComponent.js';
import * as meshRenderer from '../../components/meshRenderer.js';
import * as lightEmitter from '../../components/lightEmitter.js';
import * as spawnParams from '../spawnParams.js';
import * as messages from '../messages.js';
import * as sceneFile from '../sceneFile.js';
import * as timeScale from '../timeScale.js';
import * as mouse from '../mouse.js';
import * as camera from '../camera.js';
import * as gameObject from '../gameObject.js';
import * as layer from '../layer.js';
import * as spriteSheetRegistry from '../spriteSheetRegistry.js';
import * as utils from '../../util/utils.js';
import * as typingTarget from '../../util/typingTarget.js';
import * as consoleForward from '../../util/consoleForward.js';
import * as colliderUtils from '../../util/colliderUtils.js';
import * as configDefaults from '../../util/configDefaults.js';
import * as lightRadius from '../../util/lightRadius.js';
import * as floatingPanel from './ui/floatingPanel.js';
import * as debugDom from './ui/debugDom.js';
import * as hotReload from './hotReload.js';
import * as editorPage from './editorPage.js';
import * as tilemapReload from './tilemapReload.js';

/** Module namespaces by their path under src/. */
export const editorKit = Object.freeze({
  'components/transform.js': transform,
  'components/collider.js': collider,
  'components/spriteRenderer.js': spriteRenderer,
  'components/adobeAnimComponent.js': adobeAnimComponent,
  'components/meshRenderer.js': meshRenderer,
  'components/lightEmitter.js': lightEmitter,
  'core/spawnParams.js': spawnParams,
  'core/messages.js': messages,
  'core/sceneFile.js': sceneFile,
  'core/timeScale.js': timeScale,
  'core/mouse.js': mouse,
  'core/camera.js': camera,
  'core/gameObject.js': gameObject,
  'core/layer.js': layer,
  'core/spriteSheetRegistry.js': spriteSheetRegistry,
  'util/utils.js': utils,
  'util/typingTarget.js': typingTarget,
  'util/consoleForward.js': consoleForward,
  'util/colliderUtils.js': colliderUtils,
  'util/configDefaults.js': configDefaults,
  'util/lightRadius.js': lightRadius,
  'core/debug/ui/floatingPanel.js': floatingPanel,
  'core/debug/ui/debugDom.js': debugDom,
  'core/debug/hotReload.js': hotReload,
  'core/debug/editorPage.js': editorPage,
  'core/debug/tilemapReload.js': tilemapReload,
});
