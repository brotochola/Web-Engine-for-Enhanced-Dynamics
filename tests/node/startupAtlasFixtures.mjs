// SST-5 tests' fixtures: a 2D canvas and createImageBitmap in memory, standing in for the browser's in Node, with the semantics the
// atlas code relies on: a canvas keeps premultiplied pixels (as a browser's 2D canvas does) and getImageData returns
// them un-premultiplied, so a pixel of low alpha comes back rounded as it does in Chrome; the reference of the page's
// old decal readback, a fake atlas worker and fetch. Shared by the startupAtlas* tests (not a test file: no `.test.js`).

import { runAtlasJob } from '../../src/workers/atlasWorker.js';

/** Premultiply one channel (Skia's rounding: (c·a + 127) / 255). */
const premul = (c, a) => ((c * a + 127) / 255) | 0;
/** Un-premultiply one stored channel (getImageData: round(p·255 / a)). */
const unpremul = (p, a) => (a === 0 ? 0 : Math.min(255, Math.round((p * 255) / a)));

/** An image in memory: straight RGBA (a decoded PNG). */
export class MemImage {
  constructor(width, height, data = new Uint8ClampedArray(width * height * 4)) {
    this.width = width;
    this.height = height;
    this.data = data;
    this.closed = false;
  }

  close() {
    this.closed = true;
  }
}

/** A 2D canvas in memory: premultiplied store, drawImage of a MemImage / MemCanvas / bitmap of either at whole pixels. */
export class MemCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.store = new Uint8ClampedArray(width * height * 4);
  }

  /** Its pixels as an image (premultiplied store un-premultiplied), as drawImage reads another canvas. */
  _straightAt(x, y) {
    const s = (y * this.width + x) * 4;
    const a = this.store[s + 3];
    return [unpremul(this.store[s], a), unpremul(this.store[s + 1], a), unpremul(this.store[s + 2], a), a];
  }

  getContext() {
    const c = this;
    const ctx = {
      canvas: c,
      fillStyle: '#000',
      clearRect() {},
      drawImage(img, ...args) {
        let sx = 0, sy = 0, sw = img.width, sh = img.height, dx, dy;
        if (args.length === 2) [dx, dy] = args;
        else if (args.length === 4) [dx, dy] = args;
        else [sx, sy, sw, sh, dx, dy] = args;
        for (let y = 0; y < sh; y++) {
          const ty = dy + y;
          const fy = sy + y;
          if (ty < 0 || ty >= c.height || fy < 0 || fy >= img.height) continue;
          for (let x = 0; x < sw; x++) {
            const tx = dx + x;
            const fx = sx + x;
            if (tx < 0 || tx >= c.width || fx < 0 || fx >= img.width) continue;
            const d = (ty * c.width + tx) * 4;
            if (img instanceof MemCanvas) {
              // Canvas to canvas: the premultiplied store as it is.
              const s = (fy * img.width + fx) * 4;
              for (let k = 0; k < 4; k++) c.store[d + k] = img.store[s + k];
            } else {
              const s = (fy * img.width + fx) * 4;
              const a = img.data[s + 3];
              c.store[d] = premul(img.data[s], a);
              c.store[d + 1] = premul(img.data[s + 1], a);
              c.store[d + 2] = premul(img.data[s + 2], a);
              c.store[d + 3] = a;
            }
          }
        }
      },
      getImageData(x, y, w, h) {
        const out = new Uint8ClampedArray(w * h * 4);
        for (let r = 0; r < h; r++) {
          for (let q = 0; q < w; q++) {
            const px = x + q;
            const py = y + r;
            if (px < 0 || py < 0 || px >= c.width || py >= c.height) continue;
            out.set(c._straightAt(px, py), (r * w + q) * 4);
          }
        }
        return { data: out, width: w, height: h };
      },
      putImageData(img, dx, dy) {
        for (let r = 0; r < img.height; r++) {
          for (let q = 0; q < img.width; q++) {
            const s = (r * img.width + q) * 4;
            const d = ((dy + r) * c.width + dx + q) * 4;
            const a = img.data[s + 3];
            c.store[d] = premul(img.data[s], a);
            c.store[d + 1] = premul(img.data[s + 1], a);
            c.store[d + 2] = premul(img.data[s + 2], a);
            c.store[d + 3] = a;
          }
        }
      },
      // What the built-ins' canvases draw with (atlasBuiltins.js): every fill is opaque white over the rectangle or the
      // whole canvas (a path), enough to see where a built-in lands.
      fillRect(x, y, w, h) {
        for (let r = Math.max(0, y); r < Math.min(c.height, y + h); r++) {
          for (let q = Math.max(0, x); q < Math.min(c.width, x + w); q++) c.store.set([255, 255, 255, 255], (r * c.width + q) * 4);
        }
      },
      createRadialGradient() {
        return { addColorStop() {} };
      },
      createLinearGradient() {
        return { addColorStop() {} };
      },
      beginPath() {},
      arc() {},
      fill() {
        ctx.fillRect(0, 0, c.width, c.height);
      },
      createImageData(w, h) {
        return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
      },
    };
    return ctx;
  }

  transferToImageBitmap() {
    const img = new MemImage(this.width, this.height);
    for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) img.data.set(this._straightAt(x, y), (y * this.width + x) * 4);
    return img;
  }

  /** A PNG of it: its pixels as getImageData reads them (un-premultiplied), copied now. */
  convertToBlob() {
    return Promise.resolve(memPng(this.transferToImageBitmap()));
  }
}

/** A PNG in memory: a Blob whose bytes name an image the fake createImageBitmap decodes. */
const decoded = new Map();
let nextPng = 1;

/** A Blob standing for a PNG of `image` (straight RGBA). */
export function memPng(image) {
  const key = `mempng:${nextPng++}`;
  decoded.set(key, image);
  return new Blob([key], { type: 'image/png' });
}

/** createImageBitmap for the fakes: a memPng Blob decodes to a copy of its image; an image or canvas is copied. */
export async function memCreateImageBitmap(source) {
  if (source instanceof Blob) {
    const key = await source.text();
    const image = decoded.get(key);
    if (!image) throw new Error(`memCreateImageBitmap: ${key} is not a memPng`);
    return new MemImage(image.width, image.height, image.data.slice());
  }
  if (source instanceof MemCanvas) return source.transferToImageBitmap();
  if (source instanceof MemImage) return new MemImage(source.width, source.height, source.data.slice());
  if (source && source.data && source.width) return new MemImage(source.width, source.height, new Uint8ClampedArray(source.data));
  throw new Error('memCreateImageBitmap: unknown source');
}

/** ImageData for the fakes. */
export class MemImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

/**
 * Run `fn` with the fakes as the globals OffscreenCanvas, createImageBitmap and ImageData (no `document`, as in a worker).
 * @template T
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function withMemCanvas(fn) {
  const saved = {
    OffscreenCanvas: globalThis.OffscreenCanvas,
    createImageBitmap: globalThis.createImageBitmap,
    ImageData: globalThis.ImageData,
  };
  globalThis.OffscreenCanvas = MemCanvas;
  globalThis.createImageBitmap = memCreateImageBitmap;
  globalThis.ImageData = MemImageData;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  }
}

/** A deterministic random source. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    s = Math.imul(s ^ (s >>> 13), 3266489909) >>> 0;
    return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
  };
}

/** An image of w × h of random pixels: transparent, opaque and soft alphas mixed (decals and texels see them all). */
export function randomImage(r, w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const k = r();
    const a = k < 0.3 ? 0 : k < 0.7 ? 255 : (r() * 256) | 0;
    data[p * 4] = (r() * 256) | 0;
    data[p * 4 + 1] = (r() * 256) | 0;
    data[p * 4 + 2] = (r() * 256) | 0;
    data[p * 4 + 3] = a;
  }
  return new MemImage(w, h, data);
}

/** FNV-1a of bytes, as a hex string: a hash to compare pixels and JSON by. */
export function hashBytes(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** The hash of a JSON value's text. */
export function hashJson(value) {
  return hashBytes(new TextEncoder().encode(JSON.stringify(value)));
}

/** Scene.extractDecalTextures as it was before SST-5 (the reference): getImageData of the atlas canvas a texture. */
export function extractDecalTexturesReference(atlasCanvas, atlasJson) {
  const ctx = atlasCanvas.getContext('2d', { willReadFrequently: true });
  const textures = {};
  const animationNames = Object.keys(atlasJson.animations);
  for (let textureId = 0; textureId < animationNames.length; textureId++) {
    const frameList = atlasJson.animations[animationNames[textureId]];
    if (!frameList || frameList.length === 0) continue;
    const frameData = atlasJson.frames[frameList[0]];
    if (!frameData) continue;
    const frame = frameData.frame;
    textures[textureId] = { width: frame.w, height: frame.h, rgba: ctx.getImageData(frame.x, frame.y, frame.w, frame.h).data.buffer };
  }
  const frameNameToId = {};
  let frameTextureId = animationNames.length;
  for (const frameName of Object.keys(atlasJson.frames)) {
    const frameData = atlasJson.frames[frameName];
    if (!frameData) continue;
    const frame = frameData.frame;
    textures[frameTextureId] = { width: frame.w, height: frame.h, rgba: ctx.getImageData(frame.x, frame.y, frame.w, frame.h).data.buffer };
    frameNameToId[frameName] = frameTextureId;
    frameTextureId++;
  }
  return { textures, frameNameToId };
}

/** The atlas drawn into a canvas, as the page did before (Scene._canvasFromImageBitmap). */
export function canvasOfImage(image) {
  const canvas = new MemCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  return canvas;
}

export function decalHashes(decals) {
  const out = {};
  for (const [id, t] of Object.entries(decals.textures)) out[id] = `${t.width}x${t.height}:${hashBytes(new Uint8Array(t.rgba))}`;
  return out;
}

/** A Worker running the atlas worker module in this thread, a turn later, as postMessage does. */
export function fakeWorker({ loads = true } = {}) {
  const w = {
    onmessage: null,
    onerror: null,
    posted: 0,
    terminated: false,
    postMessage(msg) {
      w.posted++;
      setTimeout(async () => {
        if (!loads) {
          w.onerror?.({ message: 'module failed', preventDefault() {} });
          return;
        }
        const { message } = await runAtlasJob({ ...msg });
        w.onmessage?.({ data: message });
      }, 0);
    },
    terminate() {
      w.terminated = true;
    },
  };
  return w;
}

/** fetch for the baked atlas's files. */
export function withFetch(files, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => {
    // An absolute URL of the test's origin is its path (the worker gets URLs resolved against the page).
    const body = files[String(url).replace(/^https?:\/\/[^/]+/, '')];
    if (body === undefined) return new Response('missing', { status: 404 });
    return new Response(body, { status: 200 });
  };
  return Promise.resolve().then(fn).finally(() => {
    globalThis.fetch = saved;
  });
}

/** An image of w × h, transparent, with `blobs` random rectangles of colour (soft, half and solid alphas). */
export function blobImage(r, w, h, blobs = 6) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let b = 0; b < blobs; b++) {
    const x0 = (r() * w) | 0;
    const y0 = (r() * h) | 0;
    const x1 = Math.min(w, x0 + 1 + ((r() * w) / 3) | 0);
    const y1 = Math.min(h, y0 + 1 + ((r() * h) / 3) | 0);
    const k = r();
    const a = k < 0.5 ? 255 : (1 + r() * 254) | 0;
    const rgb = [(r() * 256) | 0, (r() * 256) | 0, (r() * 256) | 0];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set([...rgb, a], (y * w + x) * 4);
  }
  return new MemImage(w, h, data);
}

/**
 * A scene's atlas sources, served by withFetch: two textures, two sheets on one json (as Predator's civilians), one with
 * an excluded animation, and a sheet with height and normal maps (a twin page).
 * @returns {{ files: Record<string, string | Blob>, assets: object }}
 */
export function packScene(seed) {
  const r = rng(seed);
  const files = {};
  const png = (url, image) => {
    files[url] = memPng(image);
    return url;
  };
  const grid = (cols, rows, size, anims) => {
    const frames = {};
    const animations = {};
    let k = 0;
    for (const [name, count] of anims) {
      animations[name] = [];
      for (let i = 0; i < count; i++, k++) {
        const fname = `${name}_${i}`;
        frames[fname] = { frame: { x: (k % cols) * size, y: ((k / cols) | 0) * size, w: size, h: size } };
        animations[name].push(fname);
      }
    }
    return { frames, animations };
  };
  const walkerJson = grid(4, 3, 16, [['walk', 4], ['run', 4], ['hurt', 2]]);
  files['/s/walker.json'] = JSON.stringify(walkerJson);
  const farmJson = grid(2, 2, 24, [['a', 2], ['b', 2]]);
  files['/s/farm.json'] = JSON.stringify(farmJson);
  // Heights in R·256 + G (1/64 px), normals as colours: anything, the twin page carries them.
  const heights = new MemImage(48, 48);
  for (let p = 0; p < 48 * 48; p++) heights.data.set([0, (r() * 255) | 0, 0, 255], p * 4);
  return {
    files,
    assets: {
      rock: png('/s/rock.png', blobImage(r, 30, 20, 3)),
      bg: png('/s/bg.png', randomImage(r, 12, 9)),
      spritesheets: {
        walkerA: { json: '/s/walker.json', png: png('/s/walkerA.png', blobImage(r, 64, 48, 30)), excludeAnimations: ['hurt'] },
        walkerB: { json: '/s/walker.json', png: png('/s/walkerB.png', blobImage(r, 64, 48, 30)), excludeAnimations: ['hurt'] },
        farm: {
          json: '/s/farm.json',
          png: png('/s/farm.png', blobImage(r, 48, 48, 12)),
          heightMap: png('/s/farm_h.png', heights),
          normalMap: png('/s/farm_n.png', randomImage(r, 48, 48)),
        },
      },
    },
  };
}

/** The store of a canvas (its premultiplied pixels) or an image's bytes, hashed. */
export function hashPixels(source) {
  return hashBytes(source.store ?? source.data);
}

/** Cache Storage in memory (open, match, put, keys, delete), its entries' bodies kept as their bytes. */
export class MemCacheStorage {
  constructor() {
    this.caches = new Map();
    this.opened = 0;
  }

  async open(name) {
    this.opened++;
    let entries = this.caches.get(name);
    if (!entries) this.caches.set(name, (entries = new Map()));
    const urlOf = (r) => (typeof r === 'string' ? r : r.url);
    return {
      async match(request) {
        const e = entries.get(urlOf(request));
        return e ? new Response(e.body.slice(0), { headers: e.headers }) : undefined;
      },
      async put(request, response) {
        entries.set(urlOf(request), { body: await response.arrayBuffer(), headers: Object.fromEntries(response.headers) });
      },
      async keys() {
        return [...entries.keys()].map((url) => ({ url }));
      },
      async delete(request) {
        return entries.delete(urlOf(request));
      },
    };
  }

  /** The URLs of the entries in one cache. */
  urls(name) {
    return [...(this.caches.get(name)?.keys() || [])];
  }
}
