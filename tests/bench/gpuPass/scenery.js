/**
 * What the GPU pass bench draws: the shapes sheet of spriteMapsStressScene (a sphere, a pillar and a crate from 8
 * directions, with their height and normal maps: tests/bench/stressScenes/maps), its twin page made by the engine's own
 * code (spriteMaps.js frameTwinTexels), its texture table with each frame's base measured by frameBase.js, and seeded
 * rows: sprites, sun casters, lamps' casters, lights and lamp tiles. Everything is made once a page; a pass only points
 * at it.
 */

import { mulberry32 } from '../benchMath.js';
import { frameTwinTexels } from '../../../src/render/spriteMaps.js';
import { FOOTPRINT_TEXELS, lutBaseFloats, measureLowestContact, measureStandingBase } from '../../../src/render/frameBase.js';
import { lampTileLayout } from '../../../src/render/lampShadowMap.js';
import { sunMapTerms } from '../../../src/render/sunShadowMap.js';

const SHAPES = '/tests/bench/stressScenes/maps/';
/** TEX_LUT_FLOATS and TEX_LUT_RGBA_WIDTH of instancedSpriteBatch.js (not imported: that module brings Pixi along). */
const LUT_FLOATS = 12;
const LUT_TEXELS = 3;
/** The light data texture's rows (utils.js LIGHT_DATA_TEX_HEIGHT). */
const LIGHT_ROWS = 4;

async function loadPixels(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`gpuPassBench: ${url} answered ${response.status}`);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  // The atlas as Pixi uploads it, premultiplied (WebGL ignores UNPACK_PREMULTIPLY_ALPHA for an ImageBitmap).
  const premultiplied = await createImageBitmap(blob, { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' });
  return { bitmap: premultiplied, width: bitmap.width, height: bitmap.height, data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data };
}

/** Pixi's matrix (a, b, c, d, tx, ty) as a mat3, column by column, mapping px of a w x h target to clip space. */
export function projection(w, h, backend) {
  // WebGL: px y 0 at the bottom row (gl_FragCoord.y 0); WebGPU: at the top row (its framebuffer's origin). Either way a
  // pass that reads a target where it was drawn (the light pass and the face map, the sun map, the lamps' tiles) agrees.
  return backend === 'webgpu' ? [2 / w, 0, 0, 0, -2 / h, 0, -1, 1, 1] : [2 / w, 0, 0, 0, 2 / h, 0, -1, -1, 1];
}

/** An interleaved float column of `n` rows of `size` floats from fn(i, out). */
function column(n, size, fn) {
  const out = new Float32Array(n * size);
  const row = new Float32Array(size);
  for (let i = 0; i < n; i++) {
    row.fill(0);
    fn(i, row);
    out.set(row, i * size);
  }
  return out;
}

/**
 * @param {object} p the page's parameters (page.js readParams)
 */
export async function buildScenery(p) {
  const [color, height, normal] = await Promise.all([
    loadPixels(`${SHAPES}shapes.png`),
    loadPixels(`${SHAPES}shapes_h.png`),
    loadPixels(`${SHAPES}shapes_n.png`),
  ]);
  const sheet = await (await fetch(`${SHAPES}shapes.json`)).json();
  const W = color.width;
  const H = color.height;
  const twin = frameTwinTexels({ color: color.data, height: height.data, normal: normal.data, w: W, h: H });
  const frames = Object.values(sheet.frames).map((f) => f.frame);

  // The texture table twice: frames as cards (one view: a standing base) and as renders (a contact: they cast columns).
  const lut = (mode) => {
    const out = new Float32Array(frames.length * LUT_TEXELS * 4);
    frames.forEach((f, i) => {
      const at = i * LUT_FLOATS;
      out.set([f.w, f.h, f.x / W, f.y / H, (f.x + f.w) / W, (f.y + f.h) / H, 0, 0, f.w, f.h], at);
      const opaque = (x, y) => color.data[((f.y + y) * W + f.x + x) * 4 + 3] > 127;
      if (mode === 'card') {
        lutBaseFloats(measureStandingBase(opaque, f.w, f.h), out, at + 10);
      } else {
        const heightAt = (x, y) => {
          const q = ((f.y + y) * W + f.x + x) * 4;
          return (height.data[q] * 256 + height.data[q + 1]) / 64;
        };
        const contact = measureLowestContact(opaque, heightAt, f.w, f.h);
        lutBaseFloats(contact === null ? null : { contact }, out, at + 10);
      }
    });
    return out;
  };

  const rng = mulberry32(0x6b5a55);
  const g = p.floorScaleY;
  const c = p.heightScaleY;
  const n = p.silhouettes;
  const frameCount = frames.length;
  // Sprites over the canvas (and a frame's size past it), in painter order (by their feet).
  const feet = Array.from({ length: n }, () => [rng() * (p.width + 96) - 48, rng() * (p.height + 96) - 24, (rng() * frameCount) | 0, 0.9 + rng() * 0.4]);
  feet.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const spriteRows = (rows, extra) => {
    const count = rows.length;
    const attributes = {
      aInstXY: column(count, 2, (i, o) => o.set([rows[i][0], rows[i][1]])),
      aInstScale: column(count, 2, (i, o) => o.set([rows[i][3], rows[i][3]])),
      aInstAnchor: column(count, 2, (i, o) => o.set([0.5, 0.75])),
      aInstRotCS: column(count, 2, (i, o) => o.set([1, 0])),
      aInstDepth: column(count, 1, (i, o) => { o[0] = extra?.depth ? (i + 1) / (count + 1) : 0; }),
      // White, alpha 255: written as bits (the float is a NaN, which a float copy may not keep).
      aInstTintBits: new Float32Array(new Uint32Array(count).fill(0xffffffff).buffer),
      aInstTexId: column(count, 1, (i, o) => { o[0] = rows[i][2]; }),
      aInstTileInv: new Float32Array(count * 2),
      aInstTileOff: new Float32Array(count * 2),
    };
    if (extra?.shadow) {
      attributes.aInstShadow = column(count, 3, (i, o) => o.set([1, 0, 0]));
      attributes.aInstLight = column(count, 4, (i, o) => o.set(extra.light ? extra.light(i) : [0, 0, 0, 0]));
      // E-379: the columns programs' block of the frame (x, y, the blocks a side): one block, the whole frame.
      attributes.aBlock = column(count, 4, (i, o) => o.set([0, 0, 1, 0]));
    }
    return { count, attributes };
  };

  // The sun: from the upper left, 38 degrees up (its direction in the floor's space, towards it).
  const towardsSun = [-0.62, -0.48, 0.62];
  const sunLen = Math.sqrt(towardsSun[0] ** 2 + towardsSun[1] ** 2 + towardsSun[2] ** 2);
  const sunUnit = towardsSun.map((v) => v / sunLen);
  const sunTerms = sunMapTerms(sunUnit, new Float32Array(4), 4);

  // Lamps with a tile: across the view, each with its casters around it (inside its reach).
  const lampCount = Math.max(1, p.lamps);
  const tileLayout = lampTileLayout(lampCount, p.tile);
  const lamps = Array.from({ length: lampCount }, () => ({ x: rng() * p.width, floorY: (rng() * p.height) / g, elevation: 60 + rng() * 40, reach: 260 + rng() * 120 }));
  const lampTiles = new Float32Array(lampCount * 4);
  lamps.forEach((l, t) => lampTiles.set([l.x, l.floorY, l.elevation, l.reach], t * 4));
  const lampFeet = [];
  for (let t = 0; t < lampCount; t++) {
    const l = lamps[t];
    for (let k = 0; k < p.casters; k++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * l.reach * 0.7;
      lampFeet.push([l.x + Math.cos(a) * r, (l.floorY + Math.sin(a) * r) * g, (rng() * frameCount) | 0, 1, t]);
    }
  }

  // The light data texture (pixiWorker: row 0 x, floor y, I', range² or the tile's tag; row 1 colour and height; row 2 a cone;
  // row 3 x a lamp's fade at the cut, N-212).
  const maxLights = Math.max(p.maxLights, p.lights, 1);
  const lightData = new Float32Array(maxLights * LIGHT_ROWS * 4);
  // The first `lamps` lights are the lamps with a tile (their tag in row 0's w): today's light pass does not read it, the
  // 3D one (LAMPMAP) looks each one up in the lamps' map.
  for (let i = 0; i < p.lights; i++) {
    const tiled = i < lampCount;
    const l = tiled ? lamps[i] : { x: rng() * p.width, floorY: (rng() * p.height) / g, elevation: 40 + rng() * 50, reach: 200 + rng() * 200 };
    // pixiWorker's _packLightData: I = (radius / 10)², raised by the height (I' = I + h²), the colour scaled by I / I'.
    const base = (l.reach / 10) ** 2;
    const intensity = base + l.elevation ** 2;
    const k = base / intensity;
    lightData.set([l.x, l.floorY, intensity, tiled ? -(i + 1) : l.reach * l.reach], i * 4);
    lightData.set([k, 0.85 * k, 0.6 * k, l.elevation], (maxLights + i) * 4);
    // N-212: no lamp fades at the cut here.
    lightData.set([1, 0, 0, 0], (maxLights * 3 + i) * 4);
    // DX-SPOT: the first p.cones lights are cones: a direction on the floor, the cosine of a 30 to 60 degree half aperture
    // and 1 / the soft edge's width (0.25).
    if (i < p.cones) {
      const a = rng() * Math.PI * 2;
      lightData.set([Math.cos(a), Math.sin(a), Math.cos(((30 + rng() * 30) * Math.PI) / 180), 4], (maxLights * 2 + i) * 4);
    }
  }

  // One empty footprint row (the columns' uFoot: no footprint, nothing swept north).
  const foot = new Float32Array(FOOTPRINT_TEXELS * 4);

  return {
    atlas: color.bitmap,
    atlasSize: [W, H],
    twin,
    lutCard: lut('card'),
    // The columns' instances with `cards` card rows among the renders: the table's frames as renders, then again as cards.
    lutMixed: (() => {
      const r = lut('render');
      const c = lut('card');
      const out = new Float32Array(r.length + c.length);
      out.set(r, 0);
      out.set(c, r.length);
      return out;
    })(),
    lutMixedSize: [LUT_TEXELS, frames.length * 2],
    columnRows: spriteRows(
      [
        ...feet.slice(0, Math.min(p.renders, feet.length)),
        ...Array.from({ length: p.cards }, (_, i) => {
          const f = feet[i % feet.length];
          return [f[0], f[1], f[2] + frameCount, f[3]];
        }),
      ],
      { shadow: true },
    ),
    lutRender: lut('render'),
    lutSize: [LUT_TEXELS, frames.length],
    sprites: spriteRows(feet, { depth: true }),
    sunCasters: spriteRows(feet, { shadow: true }),
    lampCasters: spriteRows(lampFeet, { shadow: true, light: (i) => [lamps[lampFeet[i][4]].x, lamps[lampFeet[i][4]].floorY * g, lampFeet[i][4] + 1, 1] }),
    renders: spriteRows(feet.slice(0, Math.min(p.renders, feet.length)), { shadow: true }),
    lampTiles,
    lampCount,
    tileLayout,
    lightData,
    maxLights,
    foot,
    sun: { towards: sunUnit, terms: sunTerms },
    camera: { floorScaleY: g, heightScaleY: c },
  };
}
