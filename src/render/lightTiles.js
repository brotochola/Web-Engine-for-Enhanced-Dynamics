/**
 * E-205: the light pass's lights by screen tile. lightingBasic (GLSL and WGSL, their TILES blocks) looped over every light
 * at every pixel; with the tiles a pixel loops over the lights whose reach meets its tile, in the order the old loops took
 * them. A light adds exactly 0 at and past its radius (reachWindow), so a bin that never leaves a light out of a tile it
 * reaches leaves the picture as it was.
 *
 * The grid: tiles of `tilePx` px of the light pass's target, in its unflipped px (x right, y down: weedWorldToNorm times
 * uViewport), with `border` tiles more on every side for a face pixel whose floor point lies past the screen's edge (the
 * shader looks a face pixel's tile up at its floor point, where its lights' reach is measured: the top of a wall reads
 * the tile of the wall's foot). A point past even the border reads the every-light row.
 *
 * The texture (R32UI): a bit a light in its slot (the cones first, as _packLightData packs them), 32 a word. Word k of tile
 * (x, y) is texel (x, y + k · rowsPerWord); row `rows` of each word's band holds every light.
 *
 * A light's reach is a circle of radius R = 10 √(I' − h²) on the floor (I' its intensity with the height folded in, h its
 * height: lightingBasic reachWindow is 0 from there). On the screen that is an ellipse: x as the floor's, y over
 * groundInvScaleY, turned and scaled by the camera. Each tile row takes the tiles the ellipse spans over the row's band, the
 * band and the span widened by `margin` px for the GPU's float error (and pixel art's snap of the point).
 */

/** A tile's side in px of the light pass's target (doubled while the texture would pass MAX_TEXTURE_ROWS). */
export const LIGHT_TILE_PX = 16;
/** Tiles past each edge of the target, for face pixels whose floor point is off the screen. */
export const LIGHT_TILE_BORDER = 4;
/** The px the bin widens every ellipse by (the GPU's float error is a small fraction of one). */
export const LIGHT_TILE_MARGIN_PX = 1;
/** The texture's rows at most (WebGL 2 guarantees 2048; 4096 everywhere the engine runs). */
const MAX_TEXTURE_ROWS = 4096;

/** The camera's terms in LightTiles.cam (doubles in a typed array, not across a call), then the bin's margins. */
export const TILE_CAM_ZOOM = 0;
export const TILE_CAM_X = 1;
export const TILE_CAM_Y = 2;
export const TILE_CAM_COS = 3;
export const TILE_CAM_SIN = 4;
export const TILE_CAM_FULL_W = 5;
export const TILE_CAM_FULL_H = 6;
export const TILE_CAM_GROUND_INV_Y = 7;
/** The px every ellipse is widened by (LIGHT_TILE_MARGIN_PX). */
export const TILE_CAM_MARGIN = 8;
/** World px each axis that lighting.pixelArt moves the shaded point by (0.5 with it, else 0): the margin grows by its px. */
export const TILE_CAM_SNAP = 9;
const TILE_CAM_TERMS = 10;

/** The bins of one light pass: its grid, its words and the camera they were made for. */
export class LightTiles {
  constructor() {
    /** The tile's side asked for (layoutLightTiles), and the one laid out. */
    this.tileWanted = LIGHT_TILE_PX;
    this.tilePx = LIGHT_TILE_PX;
    this.border = LIGHT_TILE_BORDER;
    this.viewW = 0;
    this.viewH = 0;
    this.maxLights = 0;
    this.rowAlign = 1;
    /** The grid, border included. */
    this.cols = 0;
    this.rows = 0;
    /** A word's band of texel rows: the grid's rows and the every-light row. */
    this.rowsPerWord = 0;
    /** Words a tile for maxLights, and the texture's size (its width a multiple of rowAlign). */
    this.words = 0;
    this.texWidth = 0;
    this.texHeight = 0;
    /** Words the last bin wrote (32 lights each): the shader reads these, the upload sends their bands. */
    this.wordsUsed = 0;
    this.bits = new Uint32Array(0);
    this.cam = new Float64Array(TILE_CAM_TERMS);
    this.cam[TILE_CAM_MARGIN] = LIGHT_TILE_MARGIN_PX;
  }
}

/**
 * The grid for a light pass of viewW x viewH px and up to maxLights lights; rowAlign rounds the texture's width up (WebGPU's
 * writeTexture wants rows of 256 bytes: 64); tiles of `tile` px (doubled while the texture would pass MAX_TEXTURE_ROWS).
 * Returns true when it changed (the texture is made again) and clears the bits.
 * @param {LightTiles} t
 * @returns {boolean}
 */
export function layoutLightTiles(t, viewW, viewH, maxLights, rowAlign = 1, tile = LIGHT_TILE_PX) {
  const w = Math.max(1, viewW | 0);
  const h = Math.max(1, viewH | 0);
  const lights = Math.max(1, maxLights | 0);
  const align = Math.max(1, rowAlign | 0);
  const wanted = Math.max(4, tile | 0);
  if (w === t.viewW && h === t.viewH && lights === t.maxLights && align === t.rowAlign && wanted === t.tileWanted) return false;
  const words = (lights + 31) >> 5;
  let tilePx = wanted;
  let rows = Math.ceil(h / tilePx) + 2 * t.border;
  while ((rows + 1) * words > MAX_TEXTURE_ROWS && tilePx < 256) {
    tilePx *= 2;
    rows = Math.ceil(h / tilePx) + 2 * t.border;
  }
  const cols = Math.ceil(w / tilePx) + 2 * t.border;
  t.viewW = w;
  t.viewH = h;
  t.maxLights = lights;
  t.rowAlign = align;
  t.tileWanted = wanted;
  t.tilePx = tilePx;
  t.cols = cols;
  t.rows = rows;
  t.rowsPerWord = rows + 1;
  t.words = words;
  t.texWidth = Math.ceil(cols / align) * align;
  t.texHeight = t.rowsPerWord * words;
  const size = t.texWidth * t.texHeight;
  if (t.bits.length < size) t.bits = new Uint32Array(size);
  else t.bits.fill(0);
  t.wordsUsed = 0;
  return true;
}

/**
 * Bins the first `count` lights of the light data (lightingBasic's texture: row 0 x, floor y, I'; row 1's w the height)
 * for the camera in t.cam: each light's bit goes in every tile its reach may touch, and in the every-light row. Returns
 * the words written (the shader's uTileWords.x).
 * @param {LightTiles} t laid out (layoutLightTiles)
 * @param {Float32Array} lightData
 * @param {number} maxLights the light data's width (its rows' stride in texels)
 * @param {number} count
 * @returns {number}
 */
export function binLightTiles(t, lightData, maxLights, count) {
  const bits = t.bits;
  const stride = t.texWidth;
  const plane = t.rowsPerWord * stride;
  const cols = t.cols;
  const rows = t.rows;
  const border = t.border;
  const tilePx = t.tilePx;
  const n = Math.max(0, Math.min(count | 0, t.maxLights, maxLights | 0));
  const words = (n + 31) >> 5;
  const clearWords = words > t.wordsUsed ? words : t.wordsUsed;
  if (clearWords > 0) bits.fill(0, 0, clearWords * plane);
  t.wordsUsed = words;
  if (n === 0) return 0;

  const cam = t.cam;
  const zoom = cam[TILE_CAM_ZOOM];
  const c = cam[TILE_CAM_COS];
  const s = cam[TILE_CAM_SIN];
  const fullW = cam[TILE_CAM_FULL_W];
  const fullH = cam[TILE_CAM_FULL_H];
  const gInv = cam[TILE_CAM_GROUND_INV_Y];
  // weedWorldToNorm × uViewport: px = ((c dx − s dy, s dx + c dy) · zoom + full / 2) · view / full, d = world − focus.
  const ax = (t.viewW / fullW) * zoom;
  const ay = (t.viewH / fullH) * zoom;
  const focusX = cam[TILE_CAM_X] + fullW / (2 * zoom);
  const focusY = cam[TILE_CAM_Y] + fullH / (2 * zoom);
  const halfW = t.viewW * 0.5;
  const halfH = t.viewH * 0.5;
  // Pixel art moves the point up to `snap` world px each axis: at most that times √2 times the larger scale, in px.
  const margin = cam[TILE_CAM_MARGIN] + cam[TILE_CAM_SNAP] * 1.4143 * (ax > ay ? ax : ay);
  const row1 = maxLights * 4;
  const allRow = rows * stride;
  const gridOk = ax > 0 && ay > 0 && gInv > 0 && ax < Infinity && ay < Infinity && gInv < Infinity;

  for (let i = 0; i < n; i++) {
    const base = (i >> 5) * plane;
    const bit = 1 << (i & 31);
    // The every-light row: a point off the grid loops over every light, as the old loop did.
    bits[base + allRow] |= bit;
    const i0 = i * 4;
    const intensity = lightData[i0 + 2];
    // The shader skips a light without intensity in both loops.
    if (!(intensity > 0)) continue;
    const lx = lightData[i0];
    const ly = lightData[i0 + 1];
    const h = lightData[row1 + i0 + 3];
    // reachWindow: q = floorD² / (100 max(I' − h², 1e-6)), 0 from q = 1. Widened by a few float32 ulps of I' and h² (the
    // GPU subtracts them in float32), then by `margin` px on the screen.
    const room = intensity - h * h + 1e-6 * (intensity + h * h);
    const r = 10 * Math.sqrt(room > 1e-6 ? room : 1e-6);
    // The ellipse: centre and the matrix M taking the unit circle to it (world x ± r, world y ± r / gInv).
    const dx = lx - focusX;
    const dy = ly / gInv - focusY;
    const cx = (c * dx - s * dy) * ax + halfW;
    const cy = (s * dx + c * dy) * ay + halfH;
    const ry = r / gInv;
    const m00 = c * r * ax;
    const m01 = -s * ry * ax;
    const m10 = s * r * ay;
    const m11 = c * ry * ay;
    const a = m00 * m00 + m01 * m01;
    const d = m10 * m10 + m11 * m11;
    const b = m00 * m10 + m01 * m11;
    const det = m00 * m11 - m01 * m10;
    const detS = det * det;
    const hx = Math.sqrt(a);
    const hy = Math.sqrt(d);
    const finite = hx > 0 && hy > 0 && hx < Infinity && hy < Infinity && Math.abs(cx) < Infinity && Math.abs(cy) < Infinity;
    if (!gridOk || !finite || !(Math.abs(h) < Infinity)) {
      // Nothing to bound it by (a degenerate camera or light): every tile.
      for (let ty = 0; ty < rows; ty++) {
        const rowBase = base + ty * stride;
        for (let tx = 0; tx < cols; tx++) bits[rowBase + tx] |= bit;
      }
      continue;
    }
    let ty0 = Math.floor((cy - hy - margin) / tilePx) + border;
    let ty1 = Math.floor((cy + hy + margin) / tilePx) + border;
    if (ty1 < 0 || ty0 >= rows) continue;
    if (ty0 < 0) ty0 = 0;
    if (ty1 > rows - 1) ty1 = rows - 1;
    // Over a band of rows, the ellipse's right edge is furthest at dy = b / hx (its rightmost point), the left at −b / hx.
    const yTurn = b / hx;
    for (let ty = ty0; ty <= ty1; ty++) {
      const bandLo = (ty - border) * tilePx - margin - cy;
      const bandHi = bandLo + tilePx + 2 * margin;
      const lo = bandLo > -hy ? bandLo : -hy;
      const hi = bandHi < hy ? bandHi : hy;
      if (lo > hi) continue;
      const yr = yTurn < lo ? lo : yTurn > hi ? hi : yTurn;
      const yl = -yTurn < lo ? lo : -yTurn > hi ? hi : -yTurn;
      const sr = detS * (d - yr * yr);
      const sl = detS * (d - yl * yl);
      const xr = (b * yr + Math.sqrt(sr > 0 ? sr : 0)) / d;
      const xl = (b * yl - Math.sqrt(sl > 0 ? sl : 0)) / d;
      let tx0 = Math.floor((cx + xl - margin) / tilePx) + border;
      let tx1 = Math.floor((cx + xr + margin) / tilePx) + border;
      if (tx1 < 0 || tx0 >= cols) continue;
      if (tx0 < 0) tx0 = 0;
      if (tx1 > cols - 1) tx1 = cols - 1;
      const rowBase = base + ty * stride;
      for (let tx = tx0; tx <= tx1; tx++) bits[rowBase + tx] |= bit;
    }
  }
  return words;
}

/**
 * The shader's uTileGrid (a tile's px, the border's tiles, the grid's columns and rows) and uTileWords (words in use,
 * texel rows a word's band) into their uniform arrays.
 * @param {LightTiles} t
 * @param {Float32Array} grid
 * @param {Float32Array} words
 */
export function writeLightTileUniforms(t, grid, words) {
  grid[0] = t.tilePx;
  grid[1] = t.border;
  grid[2] = t.cols;
  grid[3] = t.rows;
  words[0] = t.wordsUsed;
  words[1] = t.rowsPerWord;
}

/**
 * WebGL: the bins into their R32UI texture, raw GL as the GPU particle records (Pixi only binds it: its upload method is
 * 'unknown'). `allocate` makes the texture at the grid's size; otherwise the bands in use go up. `unit` is the one the
 * shader sync binds integer textures in (scripts/pixi-stubs/shaderSyncPolyfill.mjs, N-109: the last).
 * @param {object} renderer Pixi's WebGL renderer
 * @param {object} source the texture's TextureSource ('r32uint')
 * @param {LightTiles} t
 * @param {number} unit
 * @param {boolean} allocate
 * @returns {boolean} false when there was no GL to send it to
 */
export function uploadLightTilesGl(renderer, source, t, unit, allocate) {
  const gl = renderer?.gl;
  const texSys = renderer?.texture;
  if (!gl || !texSys || t.texWidth < 1) return false;
  const rows = allocate ? t.texHeight : t.wordsUsed * t.rowsPerWord;
  if (rows < 1) return true;
  texSys.bind(source, unit);
  const glSource = texSys.getGlSource(source);
  // N-94: the active unit's binding goes back after the upload (see pixiWorker's _uploadRgba32FloatGl).
  const prev = gl.getParameter(gl.TEXTURE_BINDING_2D);
  gl.bindTexture(gl.TEXTURE_2D, glSource.texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  if (allocate) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, t.texWidth, t.texHeight, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, t.bits, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  } else {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.texWidth, rows, gl.RED_INTEGER, gl.UNSIGNED_INT, t.bits, 0);
  }
  gl.bindTexture(gl.TEXTURE_2D, prev);
  return true;
}

/**
 * WebGPU: the bins into an r32uint GPUTexture the source is pinned to (pinGpuTexture), made again when the grid's size
 * changes; the bands in use go up (t.texWidth is a multiple of 64: rows of 256 bytes).
 * @param {object} renderer Pixi's WebGPU renderer
 * @param {object} source the texture's TextureSource
 * @param {LightTiles} t laid out with rowAlign 64
 * @param {(renderer: object, source: object, texture: object) => void} pin pinGpuTexture
 */
export function uploadLightTilesGpu(renderer, source, t, pin) {
  const device = renderer?.gpu?.device;
  if (!device || !source || t.texWidth < 1) return;
  let texture = source._gpuData?.[renderer.uid]?.gpuTexture;
  if (!texture || texture.width !== t.texWidth || texture.height !== t.texHeight || texture.format !== 'r32uint') {
    texture = device.createTexture({
      label: 'weed-light-tiles',
      size: { width: t.texWidth, height: t.texHeight },
      format: 'r32uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    pin(renderer, source, texture);
    // A new texture starts at zeros: every band goes up once.
    device.queue.writeTexture({ texture }, t.bits, { bytesPerRow: t.texWidth * 4, rowsPerImage: t.texHeight }, { width: t.texWidth, height: t.texHeight });
    return;
  }
  const rows = t.wordsUsed * t.rowsPerWord;
  if (rows < 1) return;
  device.queue.writeTexture({ texture }, t.bits, { bytesPerRow: t.texWidth * 4, rowsPerImage: rows }, { width: t.texWidth, height: rows });
}

/**
 * The light pass's WebGPU program with the tiles' texture (group 2, binding 8, texture_2d<u32>): `make` is
 * lightingGpuProgram's call, handed a GpuProgram whose `from` adds the binding to the options it is given.
 * @param {{ from: (options: object) => object }} GpuProgram
 * @param {(gpuProgram: { from: (options: object) => object }) => object} make
 */
export function lightTilesGpuProgram(GpuProgram, make) {
  return make({
    from: (options) => {
      const stage = globalThis.GPUShaderStage ? globalThis.GPUShaderStage.FRAGMENT : 2;
      const layout = { ...options.layout, 2: { ...options.layout[2], uLightTiles: LIGHT_TILES_BINDING } };
      const gpuLayout = options.gpuLayout.slice();
      gpuLayout[2] = [
        ...gpuLayout[2],
        { binding: LIGHT_TILES_BINDING, visibility: stage, texture: { sampleType: 'uint', viewDimension: '2d', multisampled: false } },
      ];
      return GpuProgram.from({ ...options, layout, gpuLayout });
    },
  });
}

/** The tiles' binding in the light pass's group 2 (lightingBasic.wgsl). */
export const LIGHT_TILES_BINDING = 8;
