// The street demos' cars (the sun street's and the night street's, headlightsScene): the standard sheets of
// demos/img/autos (MinZiin's TopDown Vehicles, CC BY 4.0, baked by demos/tools/bakeCarSheet.mjs). Every cell has the
// car's centre on the floor at the sheet's anchor, and index.js gives that anchor and the car's box (x0, x1, y0, y1 in
// floor px, x along the car with its front at x1, and its roof's height). The pack's pictures draw the floor 0.736 as
// tall and a px of height 0.752 px tall (its projection, as nm-core fitted it: demos/tools/nmCore.cjs). A volume's
// heights are screen px, so they are the car's times 0.752, and its floor is drawn as the pictures draw it.

import { CARS } from '/demos/img/autos/index.js';

const CAR_FLOOR_SCALE = 0.7364193217154872;
const CAR_HEIGHT_SCALE = 0.7516549042792687;

/**
 * The street cars, in the order a scene paints them, with what their boxes do not say: the height of the body, and the
 * cabin on it (the glass and the roof: from x0 to x1 at its base, from roofX0 to roofX1 at the roof, halfWidth either
 * side), floor px. Both are the model the bake fitted to the car's pictures (nm-core's buildParts).
 */
const CAR_SHAPES = {
  hatch_rojo: { bodyTop: 8.3, cabin: [-33.7, 31, -29.7, 18.6, 15.2] },
  taxi: { bodyTop: 14.4, cabin: [-25.7, 26.6, -14.9, 7.1, 14.6] },
  hatch_azul: { bodyTop: 8.3, cabin: [-33.7, 31, -29.7, 18.6, 15.2] },
  sedan_blanco: { bodyTop: 14.4, cabin: [-26.3, 26.3, -16, 8.6, 14.4] },
  sedan_negro: { bodyTop: 14.4, cabin: [-26.3, 26.3, -16, 8.6, 14.4] },
  policia: { bodyTop: 14.4, cabin: [-25.6, 21.8, -14.1, 6.7, 15.3] },
};
/** The car sheets, in the order a street scene paints its cars; a scene loads each under its own name. */
export const CAR_SHEETS = Object.keys(CAR_SHAPES);

/** A level's outline: the rectangle x0..x1 by y0..y1, its front right corner first. */
const outline = (x0, x1, y0, y1) => [x1, y0, x1, y1, x0, y1, x0, y0];

/**
 * A street car's sheet on its entity (a Collider, a DirectionalSprite and a ShadowCaster), in onSpawned: the sheet drawn
 * by heading (setAnimation('drive'): the game writes directionalSprite.facing), its picture never turned, its centre on
 * the floor at the entity's spot, its box as the collider, and its body and cabin as the sun's volume.
 * @returns {number} the box's front: px ahead of the entity, where a headlight sits on the bumper
 */
export function setUpStreetCar(go, sheet) {
  const { anchor, box } = CARS[sheet];
  const [x0, x1, y0, y1, roof] = box;
  const { bodyTop, cabin } = CAR_SHAPES[sheet];
  const [cabinX0, cabinX1, roofX0, roofX1, half] = cabin;
  go.setSpritesheet(sheet);
  go.spriteRenderer.anchorX = anchor[0];
  go.spriteRenderer.anchorY = anchor[1];
  // The sheet draws the heading: the entity turns, its picture does not.
  go.spriteRenderer.inheritTransformRotation = 0;
  go.spriteRenderer.spriteRotation = 0;
  go.setAnimation('drive');
  go.collider.width = x1 - x0;
  go.collider.height = y1 - y0;
  const body = outline(x0, x1, y0, y1);
  const bodyHeight = bodyTop * CAR_HEIGHT_SCALE;
  go.shadowCaster.addLevel(body, 0, bodyHeight, body, { floorScaleY: CAR_FLOOR_SCALE });
  go.shadowCaster.addLevel(outline(cabinX0, cabinX1, -half, half), bodyHeight, roof * CAR_HEIGHT_SCALE, outline(roofX0, roofX1, -half, half));
  return x1;
}
