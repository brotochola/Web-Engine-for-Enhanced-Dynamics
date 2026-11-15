// A small PNG reader and writer for the light bench's asset tools: 8-bit greyscale, RGB, RGBA and palette images
// (with tRNS), not interlaced, in; RGBA out. Node only (zlib), no dependencies.

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32 of a chunk's type and data. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode a PNG into straight (not premultiplied) RGBA.
 * @param {Buffer} file
 * @returns {{ width: number, height: number, data: Uint8Array }}
 */
export function decodePng(file) {
  if (!file.subarray(0, 8).equals(SIGNATURE)) throw new Error('png: not a PNG file');
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idat = [];
  for (let at = 8; at < file.length; ) {
    const len = file.readUInt32BE(at);
    const type = file.toString('latin1', at + 4, at + 8);
    const data = file.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`png: only 8-bit, non-interlaced images (depth ${depth}, interlace ${interlace})`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`png: colour type ${colorType} not read`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? rows[dst + x - channels] : 0;
      const b = y > 0 ? rows[dst - stride + x] : 0;
      const c = x >= channels && y > 0 ? rows[dst - stride + x - channels] : 0;
      const v = raw[src + x];
      let out;
      if (filter === 0) out = v;
      else if (filter === 1) out = v + a;
      else if (filter === 2) out = v + b;
      else if (filter === 3) out = v + ((a + b) >> 1);
      else if (filter === 4) out = v + paeth(a, b, c);
      else throw new Error(`png: filter ${filter}`);
      rows[dst + x] = out & 0xff;
    }
  }
  const out = new Uint8Array(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const o = i * 4;
    if (colorType === 6) {
      out[o] = rows[i * 4];
      out[o + 1] = rows[i * 4 + 1];
      out[o + 2] = rows[i * 4 + 2];
      out[o + 3] = rows[i * 4 + 3];
    } else if (colorType === 2) {
      out[o] = rows[i * 3];
      out[o + 1] = rows[i * 3 + 1];
      out[o + 2] = rows[i * 3 + 2];
      out[o + 3] = 255;
    } else if (colorType === 3) {
      const p = rows[i];
      out[o] = palette[p * 3];
      out[o + 1] = palette[p * 3 + 1];
      out[o + 2] = palette[p * 3 + 2];
      out[o + 3] = trns && p < trns.length ? trns[p] : 255;
    } else if (colorType === 0) {
      out[o] = out[o + 1] = out[o + 2] = rows[i];
      out[o + 3] = 255;
    } else {
      out[o] = out[o + 1] = out[o + 2] = rows[i * 2];
      out[o + 3] = rows[i * 2 + 1];
    }
  }
  return { width, height, data: out };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A palette PNG (PLTE + tRNS, rows unfiltered) when the picture has 256 colours or fewer, else null. */
function encodePalette(width, height, data) {
  const index = new Map();
  const n = width * height;
  const px = new Uint8Array(n);
  const view = new Uint32Array(data.buffer, data.byteOffset, n);
  for (let i = 0; i < n; i++) {
    // Every fully transparent pixel is one colour.
    const v = data[i * 4 + 3] === 0 ? 0 : view[i];
    let k = index.get(v);
    if (k === undefined) {
      if (index.size === 256) return null;
      k = index.size;
      index.set(v, k);
    }
    px[i] = k;
  }
  const plte = Buffer.alloc(index.size * 3);
  const trns = Buffer.alloc(index.size);
  for (const [v, k] of index) {
    plte[k * 3] = v & 0xff;
    plte[k * 3 + 1] = (v >>> 8) & 0xff;
    plte[k * 3 + 2] = (v >>> 16) & 0xff;
    trns[k] = v >>> 24;
  }
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) raw.set(px.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('tRNS', trns),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Encode straight RGBA as an 8-bit PNG: a palette one when 256 colours do (exact), else RGBA with each row's filter the
 * one that sums smallest (the usual heuristic).
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} data
 */
export function encodePng(width, height, data) {
  const palette = encodePalette(width, height, data);
  if (palette) return palette;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    let best = 0;
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = cand[f];
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const v = data[row + x];
        const a = x >= 4 ? data[row + x - 4] : 0;
        const b = y > 0 ? data[row - stride + x] : 0;
        const c = x >= 4 && y > 0 ? data[row - stride + x - 4] : 0;
        let p;
        if (f === 0) p = v;
        else if (f === 1) p = v - a;
        else if (f === 2) p = v - b;
        else if (f === 3) p = v - ((a + b) >> 1);
        else p = v - paeth(a, b, c);
        p &= 0xff;
        out[x] = p;
        sum += p < 128 ? p : 256 - p;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    raw[y * (stride + 1)] = best;
    cand[best].copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
