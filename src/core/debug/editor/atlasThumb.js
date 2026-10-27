// atlasThumb.js — one frame of the running scene's atlas drawn into a small canvas: the sprite and animation pickers'
// thumbnails (assetPicker.js, ED-45) and the palette's class pictures (classThumbs.js, ED-65). Each is drawn when what
// it shows changes, never per frame.

import { SpriteSheetRegistry } from '../../spriteSheetRegistry.js';

/** No tint: the frame's own colors. */
export const NO_TINT = 0xffffff;

/** A stretched picture is drawn no wider than this many times its height (nor taller): a 1200 × 36 platform reads as a bar. */
const MAX_ASPECT = 4;

/**
 * The atlas frame (a key of the scene's bigAtlasJson.frames) that a sprite shows first, from its SpriteRenderer
 * columns: a static sprite (setSprite: the bigAtlas sheet and the texture's index), or the first frame of a
 * spritesheet's animation (setSpritesheet and setAnimation: the sheet and the animation's index in that sheet).
 * @param {number} spritesheetId - SpriteRenderer.spritesheetId
 * @param {number} animIndex - SpriteRenderer.animationState
 * @returns {string|null} null when the registry has nothing there
 */
export function spriteFrameOf(spritesheetId, animIndex) {
  if (!(spritesheetId > 0)) return null;
  const sheetName = SpriteSheetRegistry.getSpritesheetName(spritesheetId);
  const sheet = sheetName ? SpriteSheetRegistry.spritesheets.get(sheetName) : undefined;
  const atlas = SpriteSheetRegistry.spritesheets.get('bigAtlas');
  if (!sheet || !atlas) return null;
  const name = sheet.indexToName ? sheet.indexToName[animIndex] : undefined;
  if (name === undefined) return null;
  // A proxy sheet's animations are the atlas's under the sheet's prefix (SpriteSheetRegistry.getBigAtlasAnimName).
  const entry = sheet.isProxy ? sheet.animations[name]?.prefixedName : sheetName === 'bigAtlas' ? name : `${sheetName}_${name}`;
  const animation = entry === undefined ? undefined : atlas.animations[entry];
  return animation && animation.frames && animation.frames.length > 0 ? animation.frames[0] : null;
}

/**
 * Draw atlas frame `frame` into `canvas`, as large as fits and centered; clear the canvas first, and leave it clear when
 * there is no such frame.
 * @param {HTMLCanvasElement} canvas
 * @param {object|null} scene - the running scene: its bigAtlasCanvas and bigAtlasJson
 * @param {string|null} frame
 * @param {number} [scaleX] - an entity's scale: a scale that is not the same on both axes stretches the frame as the
 *   renderer does (no wider than 4 times its height, nor taller); a flip is drawn unflipped
 * @param {number} [scaleY]
 * @param {number} [tint] - 0xRRGGBB multiplied in, as the renderer tints a sprite; NO_TINT: none
 * @returns {boolean} whether a frame was drawn
 */
export function drawAtlasFrame(canvas, scene, frame, scaleX = 1, scaleY = 1, tint = NO_TINT) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const image = scene ? scene.bigAtlasCanvas : null;
  const rect = frame !== null && frame !== undefined && scene && scene.bigAtlasJson ? scene.bigAtlasJson.frames?.[frame]?.frame : null;
  if (!image || !rect || !(rect.w > 0 && rect.h > 0)) return false;
  const sx = Math.abs(scaleX);
  const sy = Math.abs(scaleY);
  let w;
  let h;
  if (sx > 0 && sy > 0 && sx !== sy) {
    const drawn = (rect.w * sx) / (rect.h * sy);
    const a = drawn > MAX_ASPECT ? MAX_ASPECT : drawn < 1 / MAX_ASPECT ? 1 / MAX_ASPECT : drawn;
    const k = Math.min(canvas.width / a, canvas.height);
    w = a * k;
    h = k;
  } else {
    const k = Math.min(canvas.width / rect.w, canvas.height / rect.h);
    w = rect.w * k;
    h = rect.h * k;
  }
  const x = (canvas.width - w) / 2;
  const y = (canvas.height - h) / 2;
  ctx.imageSmoothingEnabled = w < rect.w || h < rect.h; // pixel art stays crisp when it is drawn larger
  ctx.drawImage(image, rect.x, rect.y, rect.w, rect.h, x, y, w, h);
  if ((tint & NO_TINT) !== NO_TINT) {
    // The renderer multiplies a sprite's colors by its tint: the same here, then the frame's own alpha again.
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = `#${(tint & NO_TINT).toString(16).padStart(6, '0')}`;
    ctx.fillRect(x, y, w, h);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(image, rect.x, rect.y, rect.w, rect.h, x, y, w, h);
    ctx.globalCompositeOperation = 'source-over';
  }
  return true;
}
