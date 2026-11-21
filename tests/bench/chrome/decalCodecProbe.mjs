// N-314: how a save could store its decal tiles, timed in the browser on the same tiles decalSnapshotParity.mjs makes:
// PNG through a canvas (today's form), one tile after another or several at once, against the raw bytes through the
// browser's own CompressionStream (deflate-raw, gzip), serial and all at once. Encode and decode times, the bytes
// kept, and whether the decoded tile is the original (PNG goes through premultiplied alpha; deflate is exact).
//   MSYS_NO_PATHCONV=1 node tests/bench/chromeKernel.mjs --module /tests/bench/chrome/decalCodecProbe.mjs \
//     [--args '{"tiles":77,"tilePixelSize":256,"rounds":3}']

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeTiles(count, size, seed) {
  const r = mulberry32(seed);
  const tiles = [];
  for (let i = 0; i < count; i++) {
    const px = new Uint8ClampedArray(size * size * 4);
    for (let s = 0; s < 40; s++) {
      const cx = (r() * size) | 0;
      const cy = (r() * size) | 0;
      const rad = 2 + ((r() * 12) | 0);
      const red = (r() * 255) | 0;
      const alpha = 40 + ((r() * 215) | 0);
      for (let y = Math.max(0, cy - rad); y < Math.min(size, cy + rad); y++) {
        for (let x = Math.max(0, cx - rad); x < Math.min(size, cx + rad); x++) {
          const o = (y * size + x) * 4;
          px[o] = red;
          px[o + 1] = 20;
          px[o + 2] = 10;
          px[o + 3] = alpha;
        }
      }
    }
    tiles.push(px);
  }
  return tiles;
}

async function pngEncode(px, size) {
  const canvas = new OffscreenCanvas(size, size);
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px), size, size), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

async function pngDecode(bytes, size) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, size, size).data;
}

async function streamThrough(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

const deflateEncode = (format) => (px) => streamThrough(px, new CompressionStream(format));
const deflateDecode = (format) => (bytes) => streamThrough(bytes, new DecompressionStream(format));

async function timeForm(tiles, encode, decode, parallel) {
  const t0 = performance.now();
  const packed = parallel ? await Promise.all(tiles.map((px) => encode(px))) : [];
  if (!parallel) for (const px of tiles) packed.push(await encode(px));
  const encodeMs = performance.now() - t0;
  const t1 = performance.now();
  const back = parallel ? await Promise.all(packed.map((b) => decode(b))) : [];
  if (!parallel) for (const b of packed) back.push(await decode(b));
  const decodeMs = performance.now() - t1;
  let bytes = 0;
  for (const b of packed) bytes += b.byteLength;
  let exact = 0;
  for (let k = 0; k < tiles.length; k++) {
    const a = tiles[k];
    const b = back[k];
    let same = a.length === b.length;
    for (let j = 0; same && j < a.length; j++) if (a[j] !== b[j]) same = false;
    if (same) exact++;
  }
  return { encodeMs, decodeMs, bytes, exact };
}

export async function run(args = {}) {
  const size = args.tilePixelSize ?? 256;
  const tiles = makeTiles(args.tiles ?? 77, size, 0x314);
  const rounds = args.rounds ?? 3;
  const forms = {
    'png serial': [(px) => pngEncode(px, size), (b) => pngDecode(b, size), false],
    'png all at once': [(px) => pngEncode(px, size), (b) => pngDecode(b, size), true],
    'deflate-raw serial': [deflateEncode('deflate-raw'), deflateDecode('deflate-raw'), false],
    'deflate-raw all at once': [deflateEncode('deflate-raw'), deflateDecode('deflate-raw'), true],
    'gzip all at once': [deflateEncode('gzip'), deflateDecode('gzip'), true],
  };
  const out = {};
  for (let round = 0; round < rounds; round++) {
    for (const [name, [enc, dec, parallel]] of Object.entries(forms)) {
      const r = await timeForm(tiles, enc, dec, parallel);
      const row = (out[name] ??= { encodeMs: [], decodeMs: [], bytes: r.bytes, exact: r.exact, tiles: tiles.length });
      row.encodeMs.push(Math.round(r.encodeMs));
      row.decodeMs.push(Math.round(r.decodeMs));
    }
  }
  return out;
}
