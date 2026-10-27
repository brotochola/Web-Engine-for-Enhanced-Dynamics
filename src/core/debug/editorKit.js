// editorKit.js — the engine modules the editor uses (VISUAL_EDITOR_PLAN.md ED-29), by their path under src/. The
// editor (src/core/debug/editor/) ships on its own, as the @weed.js/editor package (weed.editor); a debug build of the
// engine publishes these as WEED.editorKit, and the editor's bundle resolves every import from outside its folder to
// them (webpack.editor.config.js), so the editor and the game share one Time, one Camera, the same component arrays.
// From source the editor imports the modules themselves. editorKit.test.js checks that every import the editor makes
// from outside its folder is here.

import * as transform from '../../components/transform.js';
import * as collider from '../../components/collider.js';
import * as spriteRenderer from '../../components/spriteRenderer.js';
import * as spawnParams from '../spawnParams.js';
import * as messages from '../messages.js';
import * as sceneFile from '../sceneFile.js';
import * as timeScale from '../timeScale.js';
import * as mouse from '../mouse.js';
import * as camera from '../camera.js';
import * as gameObject from '../gameObject.js';
import * as utils from '../../util/utils.js';
import * as typingTarget from '../../util/typingTarget.js';
import * as consoleForward from '../../util/consoleForward.js';
import * as colliderUtils from '../../util/colliderUtils.js';
import * as floatingPanel from './ui/floatingPanel.js';
import * as debugDom from './ui/debugDom.js';
import * as hotReload from './hotReload.js';

/** Module namespaces by their path under src/. */
export const editorKit = Object.freeze({
  'components/transform.js': transform,
  'components/collider.js': collider,
  'components/spriteRenderer.js': spriteRenderer,
  'core/spawnParams.js': spawnParams,
  'core/messages.js': messages,
  'core/sceneFile.js': sceneFile,
  'core/timeScale.js': timeScale,
  'core/mouse.js': mouse,
  'core/camera.js': camera,
  'core/gameObject.js': gameObject,
  'util/utils.js': utils,
  'util/typingTarget.js': typingTarget,
  'util/consoleForward.js': consoleForward,
  'util/colliderUtils.js': colliderUtils,
  'core/debug/ui/floatingPanel.js': floatingPanel,
  'core/debug/ui/debugDom.js': debugDom,
  'core/debug/hotReload.js': hotReload,
});
