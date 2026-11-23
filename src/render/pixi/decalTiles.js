/**
 * N-256 PW-10: the blood decal grid's tiles, moved out of pixiWorker.js as they were. The decal memory's RGBA tiles (W26)
 * drawn, the stamped ones in view (the cull, on a camera move), and each frame the dirty tiles premultiplied
 * (decalPremultiply.wasm, W21c) and uploaded, a few at a time (renderer.maxDecalTileUploadsPerFrame), the ones whose
 * layers follow one another in one call (E-270).
 *
 * E-552: the stamped tiles' texels are layers of array textures (a chunk holds decalChunkLayers of them), and each chunk
 * draws the tiles in view as one instanced mesh (decalTile.*): a sprite a tile made a texture of its own for each and
 * Pixi's batcher bound them sixteen at a time, about 700 binds and as many unit switches a frame in a Predator night.
 *
 * The grid's settings and shared views stay the worker's (initialize's _initDecals step binds them: the tile sizes and
 * counts, the dirty flags, the premultiply kernel, the container); until the renderer's other subsystems move
 * (N-256), what this class reads of the worker goes through `this.worker`.
 */

import { debugWorkerLog } from '../../util/debugLog.js';
import { Buffer, BufferUsage, Geometry, GlProgram, GpuProgram, Mesh, Shader, TextureSource } from '../../vendor/pixi.min.js';
import { premultiplyDecalTile } from '../decalPremultiplyClient.js';
import { gpuProgramFromWgsl } from '../webgpu/pixiMeshWgsl.js';
import { createDecalArrayTexture, writeRgba8Layers } from '../webgpu/pinGpuTexture.js';

/** E-552: a chunk's array texture holds at most this many bytes of texels, so big tiles make chunks of fewer layers. */
export const DECAL_CHUNK_BYTES = 8 << 20;
/** E-552: a chunk has at least this many layers (WebGPU's default view of a 1-layer texture is not an array). */
export const DECAL_CHUNK_MIN_LAYERS = 2;
/** E-270: one upload takes at most this many bytes of tiles (at least one tile). */
export const DECAL_RUN_BYTES = 1 << 18;

/**
 * E-552: the layers of a chunk of tiles of `tilePx` texels a side: DECAL_CHUNK_BYTES' worth, at least two, at most what the
 * context holds (`maxLayers`, the array textures' layer limit) and the grid's tiles.
 */
export function decalChunkLayers(tilePx, maxLayers, totalTiles) {
  const bytes = Math.max(1, tilePx * tilePx * 4);
  const byBytes = Math.floor(DECAL_CHUNK_BYTES / bytes);
  return Math.max(DECAL_CHUNK_MIN_LAYERS, Math.min(byBytes, Math.max(DECAL_CHUNK_MIN_LAYERS, maxLayers | 0), Math.max(DECAL_CHUNK_MIN_LAYERS, totalTiles | 0)));
}

/** E-270: the tiles of one upload: DECAL_RUN_BYTES' worth, at least one, at most a chunk's layers. */
export function decalRunTiles(tilePx, layersPerChunk) {
  return Math.max(1, Math.min(Math.floor(DECAL_RUN_BYTES / Math.max(1, tilePx * tilePx * 4)), layersPerChunk));
}

/** E-552: the array texture one chunk draws from, its instance buffer and its mesh. */
class DecalChunk {
  /**
   * @param {TextureSource} source the chunk's array texture
   * @param {Mesh} mesh
   * @param {Float32Array} instances a tile's corner (world px) and its layer an instance
   * @param {Buffer} buffer the instances' vertex buffer
   */
  constructor(source, mesh, instances, buffer) {
    this.source = source;
    this.mesh = mesh;
    this.instances = instances;
    this.buffer = buffer;
    this.count = 0;
    this.used = 0; // layers taken
  }
}

/** The decal grid's stamped tiles, their cull, their draws and their uploads, for one renderer worker. */
export class PixiDecalTiles {
  /** @param {object} worker the PixiRenderer that owns this (its renderer, camera, canvas and the grid's settings) */
  constructor(worker) {
    this.worker = worker;
    this.nextScanIndex = 0;
    // E-552: the chunks of the tiles' array textures, the layers in each, and where each stamped tile sits
    // (chunk * layersPerChunk + layer; -1 none).
    this.chunks = [];
    this.layersPerChunk = 0;
    this.tileSlot = new Int32Array(0);
    this.programOpts = null;
    this.quad = null;
    this.quadIndex = null;
    // E-175: which tiles have been stamped, and the tile range the camera's view covers (x0, y0, x1, y1; -1: none
    // yet): only stamped tiles in it are drawn. E-552: and whether a tile was stamped since the instances were built.
    this.stamped = new Uint8Array(0);
    this.view = new Int32Array([-1, -1, -1, -1]);
    this.instancesDirty = false;
    // E-270: the run of tiles the next upload takes, premultiplied, one after another: its tiles so far and the first's slot.
    this.run = new Uint8ClampedArray(0);
    this.runCap = 1;
    this.runTiles = 0;
    this.runSlot = 0;
  }

  /**
   * The decal tiles (SAB tiles, not TileMap background): nothing is drawn until a tile is stamped (update). E-552: the
   * program every chunk's mesh uses, made here so it links ahead with the others.
   */
  create() {
    const tiles = this.worker.decalsTilesX * this.worker.decalsTilesY;
    this.stamped = new Uint8Array(tiles);
    this.tileSlot = new Int32Array(tiles).fill(-1);
    this.view.fill(-1);
    const gl = this.worker._useWebGpu ? null : this.worker.pixiApp?.renderer?.gl;
    const limits = this.worker._useWebGpu ? this.worker.pixiApp?.renderer?.gpu?.device?.limits : null;
    const maxLayers = gl ? gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) : (limits?.maxTextureArrayLayers ?? 256);
    const px = this.worker.decalsTilePixelSize;
    this.layersPerChunk = decalChunkLayers(px, maxLayers, tiles);
    this.runCap = decalRunTiles(px, this.layersPerChunk);
    this.run = new Uint8ClampedArray(this.runCap * px * px * 4);
    const shaders = this.worker._engineShaders;
    this.programOpts = this.worker._useWebGpu
      ? { gpuProgram: gpuProgramFromWgsl(GpuProgram, shaders.decalTile, 'decal-tiles') }
      : { glProgram: GlProgram.from({ vertex: shaders.decalTileVert, fragment: shaders.decalTileFrag, name: 'decal-tiles' }) };
    this.quad = new Buffer({ data: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), usage: BufferUsage.VERTEX, label: 'decal-tile-quad' });
    this.quadIndex = new Buffer({ data: new Uint16Array([0, 1, 2, 0, 2, 3]), usage: BufferUsage.INDEX, label: 'decal-tile-index' });
    debugWorkerLog(`PIXI WORKER: ${this.worker.decalsTotalTiles} decal tiles, ${this.layersPerChunk} an array chunk`);
  }

  /** E-552: a chunk of layersPerChunk tiles: its array texture, its instanced mesh in the decal container, hidden. */
  _makeChunk() {
    const px = this.worker.decalsTilePixelSize;
    const layers = this.layersPerChunk;
    const gpu = this.worker._useWebGpu;
    const renderer = this.worker.pixiApp?.renderer;
    const source = new TextureSource({
      width: px,
      height: px,
      format: 'rgba8unorm',
      alphaMode: 'premultiplied-alpha',
      scaleMode: 'linear',
      addressMode: 'clamp-to-edge',
      viewDimension: '2d-array',
      arrayLayerCount: layers,
      autoGenerateMipmaps: false,
      label: 'weed-decal-tiles',
    });
    source.autoGarbageCollect = false;
    source.uploadMethodId = gpu ? 'external' : 'unknown';
    if (gpu) createDecalArrayTexture(renderer, source, px, layers);
    const instances = new Float32Array(layers * 3);
    const buffer = new Buffer({ data: instances, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST, label: 'weed-decal-tiles' });
    const geometry = new Geometry({
      attributes: {
        aPosition: { buffer: this.quad, format: 'float32x2', stride: 8, offset: 0 },
        aTile: { buffer, format: 'float32x3', stride: 12, offset: 0, instance: true },
      },
      indexBuffer: this.quadIndex,
    });
    geometry.instanceCount = 0;
    const uniforms = { uTileSize: { value: this.worker.decalsTileSize, type: 'f32' } };
    const shader = new Shader({
      ...this.programOpts,
      resources: gpu ? { uTiles: source, uTilesSampler: source.style, uniforms } : { uTiles: source, uniforms },
    });
    const mesh = new Mesh({ geometry, shader, label: 'weed-decal-tiles' });
    mesh.cullable = false;
    mesh.visible = false;
    const chunk = new DecalChunk(source, mesh, instances, buffer);
    this.chunks.push(chunk);
    this.worker.decalTileContainer.addChild(mesh);
    return chunk;
  }

  /** E-552: the tile's layer, in its chunk (a new chunk when the last one is full). The slot is kept for good. */
  _chunkSlot(tileIndex) {
    let slot = this.tileSlot[tileIndex];
    if (slot >= 0) return slot;
    const perChunk = this.layersPerChunk;
    let chunkIndex = this.chunks.length - 1;
    if (chunkIndex < 0 || this.chunks[chunkIndex].used >= perChunk) {
      this._makeChunk();
      chunkIndex = this.chunks.length - 1;
    }
    const layer = this.chunks[chunkIndex].used++;
    slot = chunkIndex * perChunk + layer;
    this.tileSlot[tileIndex] = slot;
    return slot;
  }

  /**
   * E-175: only the stamped decal tiles the camera's view covers are drawn (with a rotation, the view's bounding box).
   * E-552: the instances of each chunk's mesh are the stamped tiles in that range, rebuilt when the range moves or a tile
   * is stamped in it; a frame whose view stays on the same tiles changes nothing.
   */
  cull(zoom, cameraX, cameraY, rot) {
    const tilesX = this.worker.decalsTilesX | 0;
    const tilesY = this.worker.decalsTilesY | 0;
    const size = this.worker.decalsTileSize;
    if (tilesX <= 0 || tilesY <= 0 || !(size > 0) || this.tileSlot.length === 0) return;
    const z = zoom || 1;
    const w = (this.worker.canvasWidth || 0) / z;
    const h = (this.worker.canvasHeight || 0) / z;
    let x0 = cameraX;
    let y0 = cameraY;
    let x1 = cameraX + w;
    let y1 = cameraY + h;
    if (rot) {
      const cx = cameraX + w * 0.5;
      const cy = cameraY + h * 0.5;
      const c = Math.abs(Math.cos(rot));
      const s = Math.abs(Math.sin(rot));
      const hw = (w * c + h * s) * 0.5;
      const hh = (w * s + h * c) * 0.5;
      x0 = cx - hw;
      x1 = cx + hw;
      y0 = cy - hh;
      y1 = cy + hh;
    }
    const tx0 = Math.max(0, Math.min(tilesX - 1, Math.floor(x0 / size)));
    const tx1 = Math.max(0, Math.min(tilesX - 1, Math.floor(x1 / size)));
    const ty0 = Math.max(0, Math.min(tilesY - 1, Math.floor(y0 / size)));
    const ty1 = Math.max(0, Math.min(tilesY - 1, Math.floor(y1 / size)));
    const view = this.view;
    if (!this.instancesDirty && view[0] === tx0 && view[1] === ty0 && view[2] === tx1 && view[3] === ty1) return;
    view[0] = tx0;
    view[1] = ty0;
    view[2] = tx1;
    view[3] = ty1;
    this._buildInstances();
  }

  /** E-552: each chunk's instances: the stamped tiles in the view's range (x, y, layer), and its mesh shown if it has any. */
  _buildInstances() {
    this.instancesDirty = false;
    const tilesX = this.worker.decalsTilesX | 0;
    const size = this.worker.decalsTileSize;
    const perChunk = this.layersPerChunk;
    const chunks = this.chunks;
    const stamped = this.stamped;
    const tileSlot = this.tileSlot;
    const view = this.view;
    for (let c = 0; c < chunks.length; c++) chunks[c].count = 0;
    for (let ty = view[1]; ty <= view[3]; ty++) {
      for (let tx = view[0]; tx <= view[2]; tx++) {
        const i = tx + ty * tilesX;
        if (stamped[i] !== 1) continue;
        const slot = tileSlot[i];
        const chunk = chunks[(slot / perChunk) | 0];
        const at = chunk.count++ * 3;
        chunk.instances[at] = tx * size;
        chunk.instances[at + 1] = ty * size;
        chunk.instances[at + 2] = slot % perChunk;
      }
    }
    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c];
      chunk.mesh.geometry.instanceCount = chunk.count;
      chunk.mesh.visible = chunk.count > 0;
      if (chunk.count > 0) chunk.buffer.update(chunk.count * 12);
    }
  }

  /**
   * Update decal tile textures for any dirty tiles
   * Called each frame to check for tiles modified by particle_worker
   * Copies the SAB into a reused buffer and uploads with texSubImage3D / writeTexture.
   * Bytes are premultiplied so they match ImageBitmap UNPACK_PREMULTIPLY.
   * E-270: tiles claimed one after another whose layers are too go up in one call (the scan's order is the order they
   * were first stamped in wherever a scene stamps in order).
   */
  update() {
    if (!this.worker.decalsEnabled) return;

    // Use pixel size for buffer operations (not world tile size)
    const tilePixelSize = this.worker.decalsTilePixelSize;
    const bytesPerTile = tilePixelSize * tilePixelSize * 4;
    const totalTiles = this.worker.decalsTotalTiles;
    if (totalTiles <= 0) return;

    const maxUploads = Math.min(this.worker.maxDecalTileUploadsPerFrame || totalTiles, totalTiles);
    // E-272: the count with plain reads, four flags a word (carScene's 7 644 tiles: 55 us a frame with Atomics.load
    // per tile, 1.4 in words, Node). It only decides whether to scan and feeds a stat: a flag set while it reads is
    // seen next frame, which the claim below already allows for.
    const dirtyFlags = this.worker.decalsTilesDirty;
    const dirtyWords = this.worker._decalDirtyWords;
    const wordCount = dirtyWords.length;
    let dirtyN = 0;
    for (let k = 0; k < wordCount; k++) {
      const v = dirtyWords[k];
      if (v !== 0) {
        dirtyN += ((v & 0xff) !== 0 ? 1 : 0) + ((v & 0xff00) !== 0 ? 1 : 0) + ((v & 0xff0000) !== 0 ? 1 : 0) + (v >>> 24 !== 0 ? 1 : 0);
      }
    }
    for (let i = wordCount << 2; i < totalTiles; i++) {
      if (dirtyFlags[i] !== 0) dirtyN++;
    }
    this.worker._decalTilesDirtyThisFrame = dirtyN;
    if (dirtyN === 0) {
      this.worker._decalTilesUploadedThisFrame = 0;
      return;
    }

    let processed = 0;
    let scanned = 0;
    let tileIndex = this.nextScanIndex % totalTiles;
    const perChunk = this.layersPerChunk;
    const runCap = this.runCap;
    const run = this.run;

    // B-03. This flag has two agents writing it from two workers: the stamp
    // side sets 1, this loop sets 0. Both transitions are atomic now, and the
    // claim is an exchange rather than a read-then-clear so the two cannot
    // interleave between the check and the clear. E-272: a plain read first, so a clean tile costs a load, not an
    // exchange (which takes the flag's line from the stamping worker every frame); a flag that turns 1 just after it
    // is read waits a frame, as one set after the exchange does.

    while (scanned < totalTiles && processed < maxUploads) {
      // Claim the tile. If a stamp lands after this exchange it re-sets the
      // flag and the tile is picked up next frame - that is the direction that
      // self-heals, so clearing here can never lose an update.
      if (dirtyFlags[tileIndex] === 0 || Atomics.exchange(dirtyFlags, tileIndex, 0) === 0) {
        tileIndex = (tileIndex + 1) % totalTiles;
        scanned++;
        continue;
      }

      const slot = this._chunkSlot(tileIndex);
      // E-270: a tile whose layer does not follow the run's, the first layer of a chunk, or one past the run's room
      // sends the run and starts the next.
      if (this.runTiles > 0 && (slot !== this.runSlot + this.runTiles || slot % perChunk === 0 || this.runTiles === runCap)) this._uploadRun();
      if (this.runTiles === 0) this.runSlot = slot;
      // The tile, premultiplied in the decal memory's scratch, after the run's others.
      premultiplyDecalTile(this.worker._decalPremultiply, tileIndex, run, this.runTiles * bytesPerTile);
      this.runTiles++;
      if (this.stamped[tileIndex] === 0) {
        this.stamped[tileIndex] = 1;
        this.instancesDirty = true;
      }

      processed++;
      tileIndex = (tileIndex + 1) % totalTiles;
      scanned++;
    }

    this._uploadRun();
    this.nextScanIndex = tileIndex;
    this.worker._decalTilesUploadedThisFrame = processed;
  }

  /** E-270: the run's tiles (premultiplied RGBA, one after another) into their layers of the chunk's array texture. */
  _uploadRun() {
    const layers = this.runTiles;
    if (layers === 0) return;
    this.runTiles = 0;
    const source = this.chunks[(this.runSlot / this.layersPerChunk) | 0].source;
    const layer = this.runSlot % this.layersPerChunk;
    const data = this.run;
    const tilePx = this.worker.decalsTilePixelSize;
    const renderer = this.worker.pixiApp?.renderer;
    if (!renderer) return;
    if (this.worker._useWebGpu) {
      writeRgba8Layers(renderer, source, data, tilePx, layer, layers);
      return;
    }
    const gl = renderer.gl;
    const texSys = renderer.texture;
    if (!gl || !texSys) return;
    if (!source._decalGlReady) {
      // Pixi allocates the array (texImage3D, no data: the 'unknown' upload) at the source's first update.
      source.update();
      source._decalGlReady = true;
    }
    if (typeof texSys.bind === 'function') texSys.bind(source, 0);
    else if (typeof texSys.bindSource === 'function') texSys.bindSource(source, 0);
    const glSource = typeof texSys.getGlSource === 'function' ? texSys.getGlSource(source) : null;
    const target = gl.TEXTURE_2D_ARRAY;
    // N-94: the active unit's binding goes back after the upload (see _uploadRgba32FloatGl).
    const prev = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY);
    if (glSource?.texture) gl.bindTexture(target, glSource.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    if (gl.UNPACK_FLIP_Y_WEBGL != null) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    if (gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL != null) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    }
    gl.texSubImage3D(target, 0, 0, 0, layer, tilePx, tilePx, layers, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindTexture(target, prev);
  }
}
