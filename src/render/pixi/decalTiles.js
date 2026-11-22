/**
 * N-256 PW-10: the blood decal grid's tiles, moved out of pixiWorker.js as they were. A sprite a tile over the decal
 * memory's RGBA tiles (W26), the ones in view shown (the cull, on a camera move), and each frame the dirty tiles
 * premultiplied (decalPremultiply.wasm, W21c) and uploaded, a few at a time (renderer.maxDecalTileUploadsPerFrame).
 *
 * The grid's settings and shared views stay the worker's (initialize's _initDecals step binds them: the tile sizes and
 * counts, the dirty flags, the premultiply kernel, the container); until the renderer's other subsystems move
 * (N-256), what this class reads of the worker goes through `this.worker`.
 */

import { debugWorkerLog } from '../../util/debugLog.js';
import { ImageSource, Sprite, Texture } from '../../vendor/pixi.min.js';
import { premultiplyDecalTile } from '../decalPremultiplyClient.js';
import { writeRgba8 } from '../webgpu/pinGpuTexture.js';

// The Pixi classes the moved bodies name as PIXI.X, as pixiWorker.js's namespace does.
const PIXI = Object.freeze({ ImageSource, Sprite, Texture });

/** The decal grid's tile sprites, their cull and their uploads, for one renderer worker. */
export class PixiDecalTiles {
  /** @param {object} worker the PixiRenderer that owns this (its renderer, camera, canvas and the grid's settings) */
  constructor(worker) {
    this.worker = worker;
    this.nextScanIndex = 0;
    this.sprites = []; // Array of Sprite per tile
    this.textureSources = []; // TextureSource per tile (for updating)
    // E-175: which tiles have been stamped, and the tile range the camera's view covers (x0, y0, x1, y1; -1: none
    // yet): only stamped tiles in it are drawn.
    this.stamped = new Uint8Array(0);
    this.view = new Int32Array([-1, -1, -1, -1]);
    this.copyBuffers = null;
  }

  /**
   * Create sprites for each blood decal splat tile (SAB tiles, not TileMap background)
   * Each tile is a Sprite with an initially transparent texture
   * Textures are updated when particle_worker marks tiles as dirty
   */
  createSprites() {
    const tileSize = this.worker.decalsTileSize;

    for (let ty = 0; ty < this.worker.decalsTilesY; ty++) {
      for (let tx = 0; tx < this.worker.decalsTilesX; tx++) {
        const tileIndex = tx + ty * this.worker.decalsTilesX;

        // Create an initially transparent texture for this tile
        // We'll update the texture source when the tile becomes dirty
        const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
        sprite.x = tx * tileSize;
        sprite.y = ty * tileSize;
        sprite.width = tileSize;
        sprite.height = tileSize;
        sprite.visible = false; // Hidden until first decal splat, and while outside the view (_cullDecalTiles)

        this.sprites[tileIndex] = sprite;
        this.textureSources[tileIndex] = null; // Created on first update
        this.worker.decalTileContainer.addChild(sprite);
      }
    }

    this.stamped = new Uint8Array(this.worker.decalsTilesX * this.worker.decalsTilesY);
    this.view.fill(-1);
    debugWorkerLog(`PIXI WORKER: Created ${this.worker.decalsTotalTiles} decal tile sprites`);
  }

  /**
   * E-175: only the stamped decal tiles the camera's view covers are drawn (with a rotation, the view's bounding box).
   * The decal container is a render group, so a tile shown or hidden rebuilds its few instructions; a frame whose view
   * stays on the same tiles changes nothing.
   */
  cull(zoom, cameraX, cameraY, rot) {
    const sprites = this.sprites;
    const tilesX = this.worker.decalsTilesX | 0;
    const tilesY = this.worker.decalsTilesY | 0;
    const size = this.worker.decalsTileSize;
    if (tilesX <= 0 || tilesY <= 0 || !(size > 0) || sprites.length === 0) return;
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
    if (view[0] === tx0 && view[1] === ty0 && view[2] === tx1 && view[3] === ty1) return;
    const stamped = this.stamped;
    // The old range's tiles out, the new range's stamped tiles in.
    if (view[0] >= 0) {
      for (let ty = view[1]; ty <= view[3]; ty++) {
        for (let tx = view[0]; tx <= view[2]; tx++) {
          if (tx >= tx0 && tx <= tx1 && ty >= ty0 && ty <= ty1) continue;
          const sprite = sprites[tx + ty * tilesX];
          if (sprite.visible) sprite.visible = false;
        }
      }
    }
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const i = tx + ty * tilesX;
        const show = stamped[i] === 1;
        if (sprites[i].visible !== show) sprites[i].visible = show;
      }
    }
    view[0] = tx0;
    view[1] = ty0;
    view[2] = tx1;
    view[3] = ty1;
  }

  /** E-175: whether decal tile `tileIndex` is in the camera's view (_cullDecalTiles' last range). */
  _tileInView(tileIndex) {
    const view = this.view;
    if (view[0] < 0) return false;
    const tilesX = this.worker.decalsTilesX | 0;
    const tx = tileIndex % tilesX;
    const ty = (tileIndex - tx) / tilesX;
    return tx >= view[0] && tx <= view[2] && ty >= view[1] && ty <= view[3];
  }

  /**
   * Update decal tile textures for any dirty tiles
   * Called each frame to check for tiles modified by particle_worker
   * Copies the SAB into a reused buffer and uploads with texSubImage2D / writeTexture.
   * Bytes are premultiplied so they match ImageBitmap UNPACK_PREMULTIPLY.
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

      let tileRGBA = this.copyBuffers?.[tileIndex];
      if (!tileRGBA) {
        this.copyBuffers ??= [];
        tileRGBA = new Uint8ClampedArray(bytesPerTile);
        this.copyBuffers[tileIndex] = tileRGBA;
      }
      // The tile, premultiplied in the decal memory's scratch, into its own array for the upload.
      premultiplyDecalTile(this.worker._decalPremultiply, tileIndex, tileRGBA);

      const sprite = this.sprites[tileIndex];
      let source = this.textureSources[tileIndex];
      if (!source) {
        source = new PIXI.ImageSource({
          resource: tileRGBA,
          width: tilePixelSize,
          height: tilePixelSize,
          format: 'rgba8unorm',
          alphaMode: 'premultiplied-alpha',
          autoGenerateMipmaps: false,
        });
        source.uploadMethodId = this.worker._useWebGpu ? 'external' : 'unknown';
        sprite.texture = new PIXI.Texture({ source });
        this.textureSources[tileIndex] = source;
      }
      this._uploadRgba8(source, tileRGBA, tilePixelSize, tilePixelSize);
      this.stamped[tileIndex] = 1;
      sprite.visible = this._tileInView(tileIndex);

      processed++;
      tileIndex = (tileIndex + 1) % totalTiles;
      scanned++;
    }

    this.nextScanIndex = tileIndex;
    this.worker._decalTilesUploadedThisFrame = processed;
  }

  _uploadRgba8(source, data, width, height) {
    const renderer = this.worker.pixiApp?.renderer;
    if (!renderer || !source || !data) return;
    if (this.worker._useWebGpu) {
      writeRgba8(renderer, source, data, width, height, 'decal-tile');
      return;
    }
    const gl = renderer.gl;
    const texSys = renderer.texture;
    if (!gl || !texSys) return;
    if (!source._decalGlReady) {
      source.update();
      source._decalGlReady = true;
    }
    if (typeof texSys.bind === 'function') texSys.bind(source, 0);
    else if (typeof texSys.bindSource === 'function') texSys.bindSource(source, 0);
    const glSource = typeof texSys.getGlSource === 'function' ? texSys.getGlSource(source) : null;
    const target = glSource?.target || gl.TEXTURE_2D;
    // N-94: the active unit's binding goes back after the upload (see _uploadRgba32FloatGl).
    const prev = gl.getParameter(gl.TEXTURE_BINDING_2D);
    if (glSource?.texture) gl.bindTexture(target, glSource.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    if (gl.UNPACK_FLIP_Y_WEBGL != null) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    if (gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL != null) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    }
    gl.texSubImage2D(target, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindTexture(target, prev);
  }
}
