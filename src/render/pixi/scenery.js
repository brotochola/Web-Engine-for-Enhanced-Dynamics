/**
 * N-256 PW-5: the renderer's scenery layers, moved out of pixiWorker.js as they were. A layer's content (LAYER_KIND's
 * scenery types, by handleSetLayerContent): a static sprite, a cover background, a tiling sprite or a tilemap, each
 * following the camera with its parallax. The tilemap is a scenery kind here: its pages and its gid program are made,
 * filled and freed with its layer's entry. (The split plan had a tilemap.js apart; the two share the layer entries'
 * bind and destroy, so they stay one class.)
 *
 * Until the renderer's other subsystems move (N-256), what this class reads of the worker (its renderer, backend,
 * camera, canvas, world, shaders, layer runtime and the asset textures) goes through `this.worker`.
 */

import { Layer } from '../../core/layer.js';
import { TileMap } from '../../core/tileMap.js';
import { Container, Geometry, GlProgram, GpuProgram, Mesh, Shader, Sprite, TextureSource, TilingSprite } from '../../vendor/pixi.min.js';
import { coverBackgroundTransform } from '../coverBackground.js';
import {
  gidLayersPerDraw,
  gidPageHasTile,
  gidPageQuads,
  gidPageSize,
  listGidPages,
  packGidStacksRgba8,
} from '../tilemapGid.js';
import { gpuProgramFromWgsl } from '../webgpu/pixiMeshWgsl.js';

// The Pixi classes the moved bodies name as PIXI.X, as pixiWorker.js's namespace does.
const PIXI = Object.freeze({ Container, Sprite, TilingSprite });

function gpuFromWgsl(source, name) {
  return gpuProgramFromWgsl(GpuProgram, source, name);
}

/** The scenery layers and their camera, for one renderer worker. */
export class PixiScenery {
  /** @param {object} worker the PixiRenderer that owns this (its renderer, camera, layers and assets) */
  constructor(worker) {
    this.worker = worker;
    /** @type {Array<{kind:string, displayObject:*, parallaxX:number, parallaxY:number, cover?:object, tilemap?:object}|null>} */
    this.layers = [];
    this.tilemapGidProgramOpts = null;
    this.camDirty = true;
    this.camZoom = NaN;
    this.camX = NaN;
    this.camY = NaN;
    this.camCw = -1;
    this.camCh = -1;
    this.camRot = NaN;
    this.coverBgArgs = null;
    this.coverBgOut = null;
  }

  destroy(layerId) {
    const s = this.layers[layerId];
    if (!s) return;
    if (s.tilemap) this._destroyTilemapPages(s.tilemap);
    if (s.displayObject) {
      if (s.displayObject.parent) s.displayObject.parent.removeChild(s.displayObject);
      s.displayObject.destroy({ children: true });
    }
    const name = Layer.getName(layerId);
    if (name) delete this.worker._layerRuntime[name];
    this.layers[layerId] = null;
    this.worker._syncLayerRefsFromRuntime();
  }

  _bind(layerId, layerName, entry) {
    const tmScale = entry.tilemap && entry.tilemap.scale;
    entry.sx = tmScale ? +tmScale.x || 1 : 1;
    entry.sy = tmScale ? +tmScale.y || 1 : 1;
    entry.px = Number.isFinite(entry.parallaxX) ? entry.parallaxX : 1;
    entry.py = Number.isFinite(entry.parallaxY) ? entry.parallaxY : 1;
    this.layers[layerId] = entry;
    this.camDirty = true;
    if (entry.displayObject) {
      this.worker._registerLayerDisplayObject(layerName, entry.displayObject);
      this.worker.pixiApp.stage.addChild(entry.displayObject);
    }
    this.worker._syncLayerRefsFromRuntime();
  }

  createStatic(layerId, layerName, textureId, parallaxX, parallaxY) {
    const texture = this.worker.assets.textures[textureId];
    if (!texture) {
      console.warn(`PIXI WORKER: Texture "${textureId}" not found for static scenery`);
      return;
    }
    const sprite = new PIXI.Sprite(texture);
    sprite.width = this.worker.worldWidth;
    sprite.height = this.worker.worldHeight;
    this._bind(layerId, layerName, {
      kind: 'static',
      displayObject: sprite,
      parallaxX: Number.isFinite(parallaxX) ? parallaxX : 1,
      parallaxY: Number.isFinite(parallaxY) ? parallaxY : 1,
    });
  }

  createCover(layerId, layerName, textureId, { parallaxX, parallaxY, margin, zoomParallax } = {}) {
    const texture = this.worker.assets.textures[textureId];
    if (!texture) {
      console.warn(`PIXI WORKER: Texture "${textureId}" not found for cover scenery`);
      return;
    }
    const sprite = new PIXI.Sprite(texture);
    const entry = {
      kind: 'cover',
      displayObject: sprite,
      parallaxX: Number.isFinite(parallaxX) ? parallaxX : 0,
      parallaxY: Number.isFinite(parallaxY) ? parallaxY : 0,
      cover: { parallaxX, parallaxY, margin, zoomParallax },
    };
    this._bind(layerId, layerName, entry);
    this._applyCoverTransform(entry);
  }

  createTiling(layerId, layerName, textureId, tileScale = 1, parallaxX, parallaxY) {
    const texture = this.worker.assets.textures[textureId];
    if (!texture) {
      console.warn(`PIXI WORKER: Texture "${textureId}" not found for tiling scenery`);
      return;
    }
    const sprite = new PIXI.TilingSprite({
      texture,
      width: this.worker.worldWidth,
      height: this.worker.worldHeight,
    });
    const scale = Number.isFinite(tileScale) ? tileScale : 1;
    sprite.tileScale.set(scale, scale);
    sprite.tilePosition.set(0, 0);
    this._bind(layerId, layerName, {
      kind: 'tiling',
      displayObject: sprite,
      parallaxX: Number.isFinite(parallaxX) ? parallaxX : 1,
      parallaxY: Number.isFinite(parallaxY) ? parallaxY : 1,
    });
  }

  applyCamera(zoom, cameraX, cameraY, rot = 0) {
    const cw = this.worker.canvasWidth;
    const ch = this.worker.canvasHeight;
    if (
      !this.camDirty &&
      zoom === this.camZoom &&
      cameraX === this.camX &&
      cameraY === this.camY &&
      cw === this.camCw &&
      ch === this.camCh &&
      rot === this.camRot
    ) {
      return;
    }
    this.camDirty = false;
    this.camZoom = zoom;
    this.camX = cameraX;
    this.camY = cameraY;
    this.camCw = cw;
    this.camCh = ch;
    this.camRot = rot;
    for (let i = 0; i < this.layers.length; i++) {
      const s = this.layers[i];
      if (!s || !s.displayObject) continue;
      if (s.kind === 'cover' && s.cover) {
        this._applyCoverTransform(s);
        continue;
      }
      if (rot) {
        this.worker._placeWorldCamera(s.displayObject, zoom * (s.sx || 1), cameraX, cameraY, rot);
        continue;
      }
      if (s.displayObject.rotation) s.displayObject.rotation = 0;
      if (s.displayObject.pivot && (s.displayObject.pivot.x || s.displayObject.pivot.y)) {
        s.displayObject.pivot.set(0, 0);
      }
      s.displayObject.scale.set(zoom * s.sx, zoom * s.sy);
      s.displayObject.x = -cameraX * zoom * s.px;
      s.displayObject.y = -cameraY * zoom * s.py;
    }
  }

  applyCoverTransforms() {
    for (let i = 0; i < this.layers.length; i++) {
      const s = this.layers[i];
      if (s?.kind === 'cover') this._applyCoverTransform(s);
    }
  }

  _applyCoverTransform(entry) {
    const sprite = entry?.displayObject;
    const cfg = entry?.cover;
    if (!sprite || !cfg) return;
    const tex = sprite.texture;
    const args = this.coverBgArgs || (this.coverBgArgs = {
      canvasW: 0,
      canvasH: 0,
      texW: 1,
      texH: 1,
      zoom: 1,
      cameraX: 0,
      cameraY: 0,
      worldW: 0,
      worldH: 0,
      parallaxX: 0,
      parallaxY: 0,
      margin: 0,
      zoomParallax: 0,
    });
    args.canvasW = this.worker.canvasWidth;
    args.canvasH = this.worker.canvasHeight;
    args.texW = tex?.width || 1;
    args.texH = tex?.height || 1;
    args.zoom = this.worker._renderZoom;
    args.cameraX = this.worker._renderCameraX;
    args.cameraY = this.worker._renderCameraY;
    args.worldW = this.worker.worldWidth;
    args.worldH = this.worker.worldHeight;
    args.parallaxX = cfg.parallaxX;
    args.parallaxY = cfg.parallaxY;
    args.margin = cfg.margin;
    args.zoomParallax = cfg.zoomParallax;
    const t = coverBackgroundTransform(args, this.coverBgOut || (this.coverBgOut = { scale: 1, x: 0, y: 0 }));
    sprite.scale.set(t.scale);
    sprite.x = t.x;
    sprite.y = t.y;
  }

  _createTilemapRuntime() {
    return {
      container: null,
      tilemapId: null,
      buildOptions: null,
      tilesetTexture: null,
      pages: [],
      scale: { x: 1, y: 1 },
    };
  }

  _destroyTilemapPages(tm) {
    if (!tm?.pages) return;
    for (let i = 0; i < tm.pages.length; i++) {
      const entry = tm.pages[i];
      if (entry.mesh) {
        if (entry.mesh.parent) entry.mesh.parent.removeChild(entry.mesh);
        entry.mesh.destroy();
      }
      if (entry.gidSource && typeof entry.gidSource.destroy === 'function') {
        entry.gidSource.destroy();
      }
    }
    tm.pages.length = 0;
  }

  initTilemapGidProgram() {
    if (this.tilemapGidProgramOpts) return;
    if (this.worker._useWebGpu) {
      const src = this.worker._engineShaders?.tilemapGid;
      if (!src) {
        throw new Error('WeedJS: tilemapGid.wgsl was not loaded before tilemap creation.');
      }
      this.tilemapGidProgramOpts = { gpuProgram: gpuFromWgsl(src, 'tilemap-gid') };
      return;
    }
    const vert = this.worker._engineShaders?.tilemapGidVert;
    const frag = this.worker._engineShaders?.tilemapGidFrag;
    if (!vert || !frag) {
      throw new Error('WeedJS: tilemapGid GLSL was not loaded before tilemap creation.');
    }
    this.tilemapGidProgramOpts = {
      glProgram: new GlProgram({ vertex: vert, fragment: frag, name: 'tilemap-gid' }),
    };
  }

  _createTilemapGidShader(gidSource, tilesetSource, uniforms) {
    this.initTilemapGidProgram();
    const resources = this.worker._useWebGpu
      ? {
        uGid: gidSource,
        uTileset: tilesetSource,
        uTilesetSampler: tilesetSource.style,
        uniforms,
      }
      : {
        uGid: gidSource,
        uTileset: tilesetSource,
        uniforms,
      };
    return new Shader({
      ...this.tilemapGidProgramOpts,
      resources,
    });
  }

  _fillTilemapPages(tm, tileMapData) {
    this._destroyTilemapPages(tm);
    const tileset = tileMapData.tilesets && tileMapData.tilesets[0];
    if (!tileset || !tm.tilesetTexture) return;
    const atlas = tm.tilesetTexture;
    const atlasSource = atlas.source || atlas;
    const atlasW = atlas.width || atlasSource.width || 1;
    const atlasH = atlas.height || atlasSource.height || 1;
    const tw = tileMapData.tileWidth || 1;
    const th = tileMapData.tileHeight || 1;
    const mapW = tileMapData.mapWidth;
    const pages = listGidPages(mapW, tileMapData.mapHeight);
    const layersFilter = tm.buildOptions && tm.buildOptions.layers;
    // The layers drawn, bottom first.
    const drawn = tileMapData
      .getLayers()
      .filter((layer) => layer.visible && (!layersFilter || layersFilter.includes(layer.name)));
    const maxSide = this._maxTextureSide();
    for (let pi = 0; pi < pages.length; pi++) {
      const page = pages[pi];
      const { pageW, pageH } = gidPageSize(page);
      if (pageW <= 0 || pageH <= 0) continue;
      const withTiles = drawn.filter((layer) => gidPageHasTile(layer.data, mapW, page));
      // E-432: one draw composites up to perDraw of the page's layers (each tile's stack of them in one texture), front
      // to back in the shader, over the chunks where one of them has tiles. Pages do not overlap, so only the order of a
      // page's draws matters: its bottom layers first.
      const perDraw = gidLayersPerDraw(pageH, maxSide);
      for (let g = 0; g < withTiles.length; g += perDraw) {
        const group = withTiles.slice(g, g + perDraw);
        const data = group.map((layer) => layer.data);
        const quads = gidPageQuads(data, mapW, page, tw, th);
        if (quads.quads === 0) continue;
        const { depth, bytes } = packGidStacksRgba8(data, mapW, page);
        const gidSource = TextureSource.from({
          resource: bytes,
          width: pageW,
          height: pageH * depth,
          format: 'rgba8unorm',
          scaleMode: 'nearest',
          addressMode: 'clamp-to-edge',
          autoGenerateMipmaps: false,
          alphaMode: 'no-premultiply-alpha',
        });
        gidSource.autoGarbageCollect = false;
        if (gidSource.style) {
          gidSource.style.scaleMode = 'nearest';
          gidSource.style.addressMode = 'clamp-to-edge';
        }
        const geometry = new Geometry({
          attributes: {
            aPosition: {
              buffer: quads.positions,
              format: 'float32x2',
            },
          },
          indexBuffer: quads.indices,
        });
        // Each layer's opacity, the group's layer l (a stack entry's index) at l (0 to 3 low, 4 to 7 high).
        const opacity = new Float32Array(8);
        for (let l = 0; l < group.length; l++) opacity[l] = group[l].opacity !== undefined ? +group[l].opacity : 1;
        const uniforms = {
          uTileSize: { value: new Float32Array([tw, th]), type: 'vec2<f32>' },
          uPageOrigin: { value: new Float32Array([page.minX, page.minY]), type: 'vec2<f32>' },
          uPageSize: { value: new Float32Array([pageW, pageH]), type: 'vec2<f32>' },
          uFirstGid: { value: tileset.firstgid || 1, type: 'f32' },
          uColumns: { value: tileset.columns || 1, type: 'f32' },
          uAtlasSize: { value: new Float32Array([atlasW, atlasH]), type: 'vec2<f32>' },
          uStackDepth: { value: depth, type: 'f32' },
          uOpacityLo: { value: opacity.slice(0, 4), type: 'vec4<f32>' },
          uOpacityHi: { value: opacity.slice(4, 8), type: 'vec4<f32>' },
        };
        const shader = this._createTilemapGidShader(gidSource, atlasSource, uniforms);
        const mesh = new Mesh({ geometry, shader });
        mesh.eventMode = 'none';
        tm.container.addChild(mesh);
        tm.pages.push({ mesh, gidSource });
      }
    }
  }

  /** E-432: the GPU's largest 2D texture side (WebGL's MAX_TEXTURE_SIZE, WebGPU's maxTextureDimension2D). */
  _maxTextureSide() {
    const renderer = this.worker.pixiApp?.renderer;
    if (this.worker._useWebGpu) return renderer?.gpu?.device?.limits?.maxTextureDimension2D || 8192;
    const gl = renderer?.gl;
    return gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 2048;
  }

  createTilemap(layerId, layerName, tilemapId, options = {}, parallaxX, parallaxY) {
    const texEntry = this.worker.assets.tilemaps[tilemapId];
    if (!texEntry || !texEntry.tilesetTexture) {
      console.warn(`PIXI WORKER: Tileset texture for "${tilemapId}" not found`);
      return;
    }

    const tileMapData = TileMap.get(tilemapId);
    if (!tileMapData) {
      console.warn(`PIXI WORKER: TileMap "${tilemapId}" not initialized (SAB not available)`);
      return;
    }

    const tm = this._createTilemapRuntime();
    tm.container = new PIXI.Container();
    tm.tilemapId = tilemapId;
    tm.buildOptions = options || {};
    tm.tilesetTexture = texEntry.tilesetTexture;
    this._destroyTilemapPages(tm);

    if (options.scale !== undefined) {
      if (typeof options.scale === 'number') {
        tm.scale = { x: options.scale, y: options.scale };
      } else if (typeof options.scale === 'object' && options.scale.x !== undefined) {
        tm.scale = {
          x: options.scale.x,
          y: options.scale.y !== undefined ? options.scale.y : options.scale.x,
        };
      }
    }

    this._bind(layerId, layerName, {
      kind: 'tilemap',
      displayObject: tm.container,
      parallaxX: Number.isFinite(parallaxX) ? parallaxX : 1,
      parallaxY: Number.isFinite(parallaxY) ? parallaxY : 1,
      tilemap: tm,
    });

    const zoom = this.worker.cameraData ? this.worker.cameraData[0] : 1;
    tm.container.scale.set(zoom * tm.scale.x, zoom * tm.scale.y);
    this._fillTilemapPages(tm, tileMapData);
  }
}
