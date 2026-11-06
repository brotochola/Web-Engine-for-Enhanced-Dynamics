/**
 * The faces and lamps of faceLightScene.js, shared with faceLightCheck.mjs, which works out what each should read.
 *
 * Coordinates are the floor's (src/render/faceMap.js): x along the screen, y across the floor towards the camera, z up.
 * A point lands on the screen at (x, y * groundScaleY - z * heightScaleY).
 *
 * A face is a parallelogram: `origin`, then two edges in 3D. Its sprite is the white texture scaled and sheared onto
 * what those three points project to, with its height and normal as the game gives them.
 */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
};

/** A 3D point on the screen. */
export function project(p, groundScaleY, heightScaleY) {
  return [p[0], p[1] * groundScaleY - p[2] * heightScaleY];
}

function face(name, origin, edgeU, edgeV, groundScaleY, heightScaleY) {
  const center = [0, 1, 2].map((i) => origin[i] + edgeU[i] * 0.5 + edgeV[i] * 0.5);
  const [cx, cy] = project(center, groundScaleY, heightScaleY);
  const p0 = project(origin, groundScaleY, heightScaleY);
  const pu = project([origin[0] + edgeU[0], origin[1] + edgeU[1], origin[2] + edgeU[2]], groundScaleY, heightScaleY);
  const pv = project([origin[0] + edgeV[0], origin[1] + edgeV[1], origin[2] + edgeV[2]], groundScaleY, heightScaleY);
  const u = sub([pu[0], pu[1], 0], [p0[0], p0[1], 0]);
  const v = sub([pv[0], pv[1], 0], [p0[0], p0[1], 0]);
  // x += skewX·y, y += skewY·x of a sprite scaleX by scaleY: its edges are (scaleX, skewY·scaleX) and (skewX·scaleY, scaleY).
  let normal = unit(cross(edgeU, edgeV));
  // towards the camera: above the floor and towards its near side
  if (normal[1] * heightScaleY + normal[2] * groundScaleY < 0) normal = normal.map((c) => -c);
  return {
    name,
    origin,
    edgeU,
    edgeV,
    normal,
    x: cx,
    y: cy,
    height: center[2],
    scaleX: u[0],
    scaleY: v[1],
    skewX: v[0] / v[1],
    skewY: u[1] / u[0],
    sortOffsetY: 0,
  };
}

/** @returns {{ faces: object[], lamps: { x: number, y: number, height: number, intensity: number }[] }} */
export function faceLightLayout(groundScaleY, heightScaleY) {
  const g = groundScaleY;
  const c = heightScaleY;
  const faces = [
    // A house with a front (towards the camera) and a right side.
    face('front', [200, 700, 80], [240, 0, 0], [0, 0, -80], g, c),
    face('side', [440, 700, 80], [100, -160, 0], [0, 0, -80], g, c),
    face('roof', [200, 540, 80], [240, 0, 0], [0, 160, 0], g, c),
    // A wall turned 45 degrees, a low wall on its other side.
    face('turned', [760, 620, 100], [160, 160, 0], [0, 0, -100], g, c),
    // A pitched roof: height across the floor, so the map has to work out the height of each corner.
    face('pitched', [1000, 500, 40], [180, 0, 0], [0, -140, 90], g, c),
  ];
  for (const f of faces) f.sortOffsetY = 1000;
  const lamps = [
    { x: 320, y: 790, height: 50, intensity: 5000 },
    { x: 760, y: 720, height: 60, intensity: 6000 },
    { x: 1090, y: 760, height: 220, intensity: 12000 },
  ];
  return { faces, lamps };
}
