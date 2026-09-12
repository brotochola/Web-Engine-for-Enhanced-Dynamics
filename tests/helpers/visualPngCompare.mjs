/**
 * Compare Playwright PNG buffers using the browser's image decoder.
 * No extra deps — OffscreenCanvas + getImageData.
 */

export async function analyzePng(page, pngBuffer) {
  return page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bin], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    const d = img.data;
    let nonBlack = 0;
    let maxChannel = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      if (r > maxChannel) maxChannel = r;
      if (g > maxChannel) maxChannel = g;
      if (b > maxChannel) maxChannel = b;
      if (r > 8 || g > 8 || b > 8) nonBlack++;
    }
    return {
      width: img.width,
      height: img.height,
      pixels: (d.length / 4) | 0,
      nonBlack,
      maxChannel,
    };
  }, pngBuffer.toString('base64'));
}

export async function diffPngs(page, pngA, pngBufferB) {
  return page.evaluate(
    async ({ a64, b64 }) => {
      async function load(b64) {
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bin], { type: 'image/png' }));
        const canvas = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(0, 0, bmp.width, bmp.height);
      }
      const A = await load(a64);
      const B = await load(b64);
      if (A.width !== B.width || A.height !== B.height) {
        return {
          sameSize: false,
          widthA: A.width,
          heightA: A.height,
          widthB: B.width,
          heightB: B.height,
          differing: -1,
          maxDelta: 0,
          pixels: 0,
        };
      }
      const a = A.data;
      const b = B.data;
      let differing = 0;
      let maxDelta = 0;
      for (let i = 0; i < a.length; i += 4) {
        const dr = Math.abs(a[i] - b[i]);
        const dg = Math.abs(a[i + 1] - b[i + 1]);
        const db = Math.abs(a[i + 2] - b[i + 2]);
        const d = dr > dg ? (dr > db ? dr : db) : dg > db ? dg : db;
        if (d > 0) {
          differing++;
          if (d > maxDelta) maxDelta = d;
        }
      }
      return {
        sameSize: true,
        widthA: A.width,
        heightA: A.height,
        pixels: (a.length / 4) | 0,
        differing,
        maxDelta,
      };
    },
    { a64: pngA.toString('base64'), b64: pngBufferB.toString('base64') },
  );
}

export function verdictFromDiff({ black, differing, pixels, maxDelta }) {
  if (black) return 'black';
  if (differing === 0) return 'exact';
  const frac = pixels > 0 ? differing / pixels : 1;
  if (frac < 0.001 && maxDelta <= 16) return 'near';
  return 'drift';
}

export async function captureCanvasPng(page) {
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (box && box.width > 0 && box.height > 0) {
    return page.screenshot({ type: 'png', clip: box });
  }
  return canvas.screenshot({ type: 'png' });
}
