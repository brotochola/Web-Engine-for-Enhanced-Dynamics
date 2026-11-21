// Where two captures differ (N-272's tool): the differing pixels by distance to the nearest screen edge, and those
// within 64 px by which edge, for a render fix that must change only what lies near the screen's edges.
//   node tests/bench/captureDiffWhere.mjs a.png b.png   (two PNGs of one size, compareCaptures --save makes them)
import fs from 'node:fs';
import { chromium } from 'playwright';

const [aPath, bPath] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const toUrl = (p) => `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
const result = await page.evaluate(async ({ a, b }) => {
  const load = async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, img.width, img.height);
  };
  const A = await load(a);
  const B = await load(b);
  const w = A.width;
  const h = A.height;
  const bands = [[0, 1], [1, 4], [4, 16], [16, 64], [64, 1e9]];
  const byBand = bands.map(() => 0);
  const byEdge = { top: 0, bottom: 0, left: 0, right: 0 };
  let differing = 0;
  let maxDelta = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let d = 0;
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(A.data[o + c] - B.data[o + c]));
      if (d === 0) continue;
      differing++;
      if (d > maxDelta) maxDelta = d;
      const dist = Math.min(x, y, w - 1 - x, h - 1 - y);
      for (let k = 0; k < bands.length; k++) if (dist >= bands[k][0] && dist < bands[k][1]) byBand[k]++;
      const edge = dist === y ? 'top' : dist === h - 1 - y ? 'bottom' : dist === x ? 'left' : 'right';
      if (dist < 64) byEdge[edge]++;
    }
  }
  return { w, h, differing, maxDelta, byBand: bands.map((b, k) => `${b[0]}-${b[1] > 1e8 ? 'in' : b[1]}px: ${byBand[k]}`), byEdgeUnder64px: byEdge };
}, { a: toUrl(aPath), b: toUrl(bPath) });
console.log(JSON.stringify(result));
await browser.close();
