// A frame's trim as createBigAtlas found it until it read each sheet back once (SpriteSheetRegistry._getTrimBoundsFromCanvas
// at 1969bf1e): the frame drawn on a canvas of its own and read back. Kept as the reference tests/node/atlasTrim.test.js
// checks _getTrimBoundsInPixels against; the engine does not use it.

export function getTrimBoundsFromCanvas(ctx, width, height, alphaThreshold = 0) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  let minX = width, minY = height, maxX = -1, maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0 || maxY < 0) return null; // Fully transparent

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}
