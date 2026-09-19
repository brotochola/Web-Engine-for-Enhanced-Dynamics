/** Fixed CCW fan for compound-fixture stress / kernels. vertsPerPoly 3 keeps the right triangle; 8 is a display octagon. */
export function makeIslandPolys(polyCount, cell = 12, vertsPerPoly = 3) {
  const n = vertsPerPoly < 3 ? 3 : vertsPerPoly > 8 ? 8 : vertsPerPoly | 0;
  const polys = [];
  for (let t = 0; t < polyCount; t++) {
    const ox = (t % 8) * cell;
    const oy = ((t / 8) | 0) * cell;
    if (n === 3) {
      polys.push([
        { x: ox, y: oy },
        { x: ox + cell - 1, y: oy },
        { x: ox, y: oy + cell - 1 },
      ]);
      continue;
    }
    const r = (cell - 1) * 0.5;
    const cx = ox + r;
    const cy = oy + r;
    const poly = [];
    for (let i = 0; i < n; i++) {
      const a = (i * Math.PI * 2) / n;
      poly.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    polys.push(poly);
  }
  return polys;
}
