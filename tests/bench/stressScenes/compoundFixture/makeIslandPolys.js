/** Fixed CCW triangle fan for compound-fixture stress / kernels. */
export function makeIslandPolys(triangleCount, cell = 12) {
  const polys = [];
  for (let t = 0; t < triangleCount; t++) {
    const ox = (t % 8) * cell;
    const oy = ((t / 8) | 0) * cell;
    polys.push([
      { x: ox, y: oy },
      { x: ox + cell - 1, y: oy },
      { x: ox, y: oy + cell - 1 },
    ]);
  }
  return polys;
}
