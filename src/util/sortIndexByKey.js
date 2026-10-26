/**
 * Y-sort key for a sprite or Adobe root. Rounded to a whole pixel so a
 * sub-pixel pose tremor does not change bits. `ySortK` is the gap that
 * leaves room for a decoration's integer innerZ inside the pixel.
 * Same-pixel ties stay ties. A fractional entity id was measured and
 * made PainterMove's pixi step about twice as expensive, so it is not here.
 * @param {number} y
 * @param {number} ySortK
 */
export function spriteYSortKey(y, ySortK) {
  return Math.round(y) * ySortK;
}

/**
 * Y-sort line for a sprite: the world Y of its bottom edge, not its pose.
 * Identity rotation: y + (1 - anchorY) * height * scaleY, or, flipped
 * (scaleY < 0), y + anchorY * height * |scaleY|: the shader places local y at
 * (v - anchorY) * height * scaleY, so a flip puts the frame's top edge
 * lowest. With rotation it
 * is the same local offset the sprite vertex shader uses — which means it has
 * to use the SAME rotation the sprite is drawn with. `inheritRotation[index]`
 * is that choice: truthy takes the body pose's rotation, falsy takes the
 * sprite's own facing (`spriteRotC`/`spriteRotS`). `emitSpriteQueue` and the
 * pixi self-lit path both branch on that flag; a sort line that ignores it
 * puts a turning sprite on the wrong side of its neighbours (a car whose
 * facing lives in the frame, on a body that steers, is the live case).
 *
 * `w`/`h` are the frame size in px, 0 when the texture is unresolved — then
 * the offset is 0 and the sort line collapses to the pose, which is the old
 * behaviour for a missing frame, not a special case.
 *
 * @param {object} s component arrays: anchorX, anchorY, scaleX, scaleY,
 *   inheritRotation, spriteRotC, spriteRotS. Any missing array falls back to poseY.
 * @param {number} index entity slot
 * @param {number} poseY world Y of the pose
 * @param {number} rotC pose rotation cos
 * @param {number} rotS pose rotation sin
 * @param {number} w frame width px, 0 if unknown
 * @param {number} h frame height px, 0 if unknown
 * @returns {number} world Y of the sprite's bottom edge
 */
export function spriteSortFootY(s, index, poseY, rotC, rotS, w, h) {
  if (!s || !s.anchorX || !s.anchorY || !s.scaleX || !s.scaleY) return poseY;
  const ax = s.anchorX[index];
  const ay = s.anchorY[index];
  // Feet-anchored sprites sort on the pose itself. Callers may short-circuit
  // this before resolving the frame; the check lives here so the helper is
  // correct standalone.
  if (ax === 0.5 && ay === 1.0) return poseY;
  const sy = s.scaleY[index];
  const ox = (0.5 - ax) * w * s.scaleX[index];
  // The lower edge on screen: the frame's top edge when vertically flipped.
  const oy = sy < 0 ? -ay * h * sy : (1 - ay) * h * sy;
  const inherit = s.inheritRotation;
  if (inherit && !inherit[index]) {
    rotC = s.spriteRotC[index];
    rotS = s.spriteRotS[index];
  }
  return poseY + ox * rotS + oy * rotC;
}

/** Width of one zIndex band. Larger than any Y key inside the world. */
export function zSortBand(worldHeight) {
  const h = worldHeight > 0 ? worldHeight : 1;
  return h * 128 + 128;
}

/**
 * Coarse key is zIndex. With ySort, Y (already round(y)*128 + innerZ) sits inside the band.
 * Without ySort the key is the integer. Larger is in front.
 * ponytail: zIndex is int16. A Y past ±worldHeight overlaps the next band.
 */
export function orderSortKey(yKey, zIndex, ySort, band) {
  const z = zIndex | 0;
  if (!ySort) return z;
  return z * band + yKey;
}
