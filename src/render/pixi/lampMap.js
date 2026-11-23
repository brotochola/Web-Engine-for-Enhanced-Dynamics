/**
 * N-256: the lamps' shadow map, moved out of shadowMaps.js as it was. Its tiles (a lamp each, its floor point, height and
 * reach; DX-LAMPPANO: a floor half and a ceiling half), the cards and the columns drawn into them over the stamp rows (full
 * or keyed, E-395), the volumes drawn once a tile in use (E-389, E-453) and kept in a cache under the movers (E-508).
 *
 * What it shares with the sun's map (the columns' hosts and passes over keyed rows, the volumes' resources, whether the
 * volumes cast) stays in shadowMaps.js, reached through `this.worker.shadowMaps`; the rest of the renderer through
 * `this.worker`.
 */

import { LightEmitter } from '../../components/lightEmitter.js';
import { Transform } from '../../components/transform.js';
import {
  Buffer, BufferUsage, Container, Geometry, GlProgram, GpuProgram, Mesh, RenderTexture, Shader, TextureSource,
} from '../../vendor/pixi.min.js';
import {
  GPU_CASTER_FLOATS,
  GPU_CASTER_LIGHT_FLOAT,
  GPU_HDR_STAMP,
  GPU_HDR_STAMP_LIGHTS,
  GPU_KEYED_STAMP_FLOATS,
} from '../gpuQueueLayout.js';
import {
  LAMP_MAP_COLUMNS,
  autoLampTileSize,
  lampCardStrip,
  lampColumnGrid,
  lampColumnIndex,
  lampMapColumnsVertex,
  lampMapColumnsWgsl,
  lampMapFragment,
  lampMapVertex,
  lampMapWgsl,
  lampTileLayout,
  writeLampTile,
  writeLampTileOwner,
} from '../lampShadowMap.js';
import {
  LAMP_TILE_ROWS,
  createLampVolumeCache,
  lampCacheLayout,
  lampCachePays,
  planLampVolumeCache,
  writeDirectLampList,
} from '../lampVolumeCache.js';
import { spriteIndexedVertex, spriteIndexedWgsl } from '../spriteIndexed.js';
import {
  LAMP_CACHE_COPY_FRAGMENT,
  LAMP_CACHE_COPY_VERTEX,
  VOLUME_LAMP_CACHE_FRAGMENT,
  VOLUME_LAMP_FRAGMENT,
  lampCacheCopyGpuProgram,
  volumeLampVertex,
  volumeLampWgsl,
  volumeMapGpuProgram,
  writeVolumeLampTerms,
} from '../volumeShadowMap.js';
import { glProgramFrom } from '../webgl/glProgram.js';
import { sunShadowGpuProgram } from '../webgpu/instancedSpriteWgsl.js';
import { writeRgba32Float } from '../webgpu/pinGpuTexture.js';
import { mapDepthState } from './shadowMaps.js';

// The Pixi classes the moved bodies name as PIXI.X, as pixiWorker.js's namespace does.
const PIXI = Object.freeze({ Container, Geometry, GlProgram, Mesh, RenderTexture, Shader, TextureSource });

/** DX-LAMPPANO: how many of the stamp batch's geometries keep a lamp card strip of their own (its ring's slots, then some). */
const LAMP_STRIP_SOURCES = 8;

/** DX-SHADOW3D (F7): the volumes' lamp terms' scales, 1 / heightScaleY and 1 / groundScaleY (writeVolumeLampTerms). */
const VOLUME_LAMP_SCALES = new Float64Array(2);

/** The lamps' shadow map: its tiles, its passes and its volumes' cache, for one renderer worker. */
export class PixiLampMap {
  /** @param {object} worker the PixiRenderer that owns this (its renderer, lighting state, batches and shadow maps) */
  constructor(worker) {
    this.worker = worker;
    // DX-SHADOW3D (F7): the volumes in the lamps' map: { batch, host, mesh, geometry: the batch's vertices and indices,
    // drawn with an instance a tile in use (E-389, E-453) } a volumes' batch, and their program's options and state (made
    // on first use).
    this.volumeEntries = [];
    this.volumeProgram = null;
    this.volumeState = null;
    this.volumeCacheProgram = null;
    this.cache = createLampVolumeCache();
    this.cacheTarget = null;
    this.cacheColor = null;
    this.cacheDepth = null;
    this.cacheSlots = 0;
    this.cacheSize = 0;
    this.cachePerRow = 1;
    this.cacheCopy = null;
    this.volumesEpoch = 0;
    this.volumeScales = new Float64Array(2);
    // This frame's volumes' entries in order (_drawVolumes), and how many.
    this.volumeActive = [];
    this.volumeActiveCount = 0;
    /** N-196: this frame's widest casting lamp's reach (floor px; a double from the start). */
    this.maxReach = 0.5;
    this.tilesPerRow = 1;
    this.lights = 0;
    this.mesh = null;
    // E-395: the lamps' map over keyed stamp rows (WebGL): its two halves' meshes and host, and a strip a ring geometry.
    this.keyedMesh = null;
    this.keyedMeshCeil = null;
    this.keyedHost = null;
    this.keyedStrips = new Map();
    /** DX-LAMPPANO: the cards drawn into the ceiling's half (their own uniforms: uTileWorld.z 1). */
    this.meshCeil = null;
    this.host = null;
    this.columns = null;
    this.uniforms = null;
    this.uniformsCeil = null;
    /** DX-LAMPPANO: the cards' strip (lampCardStrip) and its geometry over the batch's instance attributes. */
    this.stripBuffer = null;
    this.stripIndex = new Uint16Array(0);
    this.stripGeometry = null;
    this.stripSource = null;
    /** The strip's geometry for each geometry of the batch's ring it was drawn over (made once each, a few at most). */
    this.stripBySource = new Map();
    this.mapClear = false;
    this.mapDrew = false;
    // Each tile's lamp (floor point, height, reach) as RGBA32F, a texel a tile, and below it (row 1) its owner (E-389);
    // entity -> tile; last frame's lamps.
    // E-508: a third row, the volumes' draws' lists (lampVolumeCache.js).
    this.tileData = new Float32Array(4 * LAMP_TILE_ROWS);
    this.tileSource = null;
    this.tileIds = new Uint32Array(1);
    this.tileCount = 0;
  }

  /**
   * DX-SHADOW3D (F7): this frame's lamps with a tile in the lamps' map, read before the light data is packed: pre-render's
   * stamp lights (the GPU queue's stampLightIds, a stamp row's stampLightIdx counts them), each one's tile its index. The
   * light pack tags their first row (_lampTileOf); the tiles' texture holds each lamp's floor point, height and reach
   * (lampShadowMap.js writeLampTile), which the map's programs read.
   */
  readTiles() {
    const gpu = this.worker._gpuQueueRead;
    const ids = gpu && gpu.stampLightIds ? gpu.stampLightIds : null;
    let n = ids && gpu.header ? Math.min(gpu.header[GPU_HDR_STAMP_LIGHTS] | 0, ids.length) : 0;
    // OL-5: pre-render names the casting lamps in a frame with no stamp row too. They take tiles then only when volumes
    // are there to draw into them: every pixel of a lamp reads its tile, and an empty one is read for nothing.
    if (n > 0 && (gpu.header[GPU_HDR_STAMP] | 0) <= 0 && !this.worker.shadowMaps._volumesCast()) n = 0;
    const entities = Transform.x ? Transform.x.length : 0;
    if (this.worker.lighting.lampTileOf.length !== entities) this.worker.lighting.lampTileOf = new Int16Array(entities).fill(-1);
    if (this.worker.lighting.lampFadeOf.length !== entities) this.worker.lighting.lampFadeOf = new Float32Array(entities).fill(1);
    const of = this.worker.lighting.lampTileOf;
    const fadeOf = this.worker.lighting.lampFadeOf;
    // N-212: pre-render's fades beside the ids (a queue without them: none fade).
    const fades = gpu && gpu.stampLightFade && gpu.stampLightFade.length >= n ? gpu.stampLightFade : null;
    const last = this.tileIds;
    for (let i = 0; i < this.tileCount; i++) {
      const id = last[i];
      if (id < of.length) {
        of[id] = -1;
        fadeOf[id] = 1;
      }
    }
    const cap = Math.max(1, ids ? ids.length : 1);
    if (this.tileIds.length < cap) this.tileIds = new Uint32Array(cap);
    if (this.tileData.length < cap * 4 * LAMP_TILE_ROWS) this.tileData = new Float32Array(cap * 4 * LAMP_TILE_ROWS);
    const data = this.tileData;
    // E-389: the texture's width; row 1 holds each tile's owner, row 2 the volumes' draws' lists (E-508).
    const width = data.length / (4 * LAMP_TILE_ROWS);
    const groundInvY = this.worker._groundInvScaleY || 1;
    let maxReach = 0.5;
    const worldX = Transform.x;
    const worldY = Transform.y;
    const rotC = Transform.rotC;
    const rotS = Transform.rotS;
    const offsetX = LightEmitter.offsetX;
    const offsetY = LightEmitter.offsetY;
    for (let t = 0; t < n; t++) {
      const id = ids[t];
      this.tileIds[t] = id;
      if (id < of.length) {
        of[id] = t;
        fadeOf[id] = fades !== null ? fades[t] : 1;
      }
      const ox = offsetX[id];
      const oy = offsetY[id];
      const x = worldX[id] + ox * rotC[id] - oy * rotS[id];
      const y = (worldY[id] + ox * rotS[id] + oy * rotC[id]) * groundInvY;
      const elevation = LightEmitter.elevation[id];
      // E-510: the tile spans how far its shadows reach: its shadowRange where that is under its radius (the light
      // data's fourth row carries the same, for the light pass).
      const radius = LightEmitter.radius[id];
      const shadowRange = LightEmitter.shadowRange[id];
      const reach = shadowRange > 0 && shadowRange < radius ? shadowRange : radius;
      writeLampTile(data, t, x, y, elevation, reach);
      writeLampTileOwner(data, width, t, id);
      if (elevation > 0 && reach > maxReach) maxReach = reach;
    }
    this.maxReach = maxReach;
    const stale = Math.max(n, this.tileCount);
    data.fill(0, n * 4, stale * 4);
    for (let t = n; t < stale; t++) writeLampTileOwner(data, width, t, -1);
    this.tileCount = n;
    this._uploadTiles();
  }

  /**
   * DX-SHADOW3D (F7): the tiles' texture (a texel a tile: its lamp in row 0, its owner in row 1), made on first use,
   * written each frame.
   */
  _uploadTiles() {
    const width = Math.max(1, this.tileData.length / (4 * LAMP_TILE_ROWS));
    if (this.tileSource === null || this.tileSource.width !== width) {
      const old = this.tileSource;
      this.tileSource = PIXI.TextureSource.from({
        resource: this.tileData,
        width,
        height: LAMP_TILE_ROWS,
        format: 'rgba32float',
        scaleMode: 'nearest',
        addressMode: 'clamp-to-edge',
        autoGenerateMipmaps: false,
      });
      this.tileSource.uploadMethodId = this.worker._useWebGpu ? 'external' : 'unknown';
      // Never unloaded by Pixi's texture GC while the programs keep it bound.
      this.tileSource.autoGarbageCollect = false;
      // Every program that binds it moves to the new one before the old one is destroyed.
      this._pointTilePrograms();
      if (old) old.destroy();
    }
    if (this.worker._useWebGpu) {
      const renderer = this.worker.pixiApp?.renderer;
      if (renderer?.gpu?.device) writeRgba32Float(renderer, this.tileSource, this.tileData, width, LAMP_TILE_ROWS, 'weed-lamp-tiles');
      return;
    }
    this.worker._uploadRgba32FloatGl(this.tileSource, this.tileData, width, LAMP_TILE_ROWS);
  }

  /**
   * DX-SHADOW3D (F7): every program that binds the tiles' lamps (uLampTiles) on the current source: the lamps' map's cards
   * and columns, and each volumes' layer's mesh.
   */
  _pointTilePrograms() {
    const source = this.tileSource;
    const shaders = [
      this.mesh && this.mesh.shader,
      this.meshCeil && this.meshCeil.shader,
      this.columns && this.columns.shader,
      this.columns && this.columns.shaderCeil,
    ];
    for (let i = 0; i < this.volumeEntries.length; i++) {
      shaders.push(this.volumeEntries[i].mesh.shader, this.volumeEntries[i].paintMesh.shader);
    }
    if (this.cacheCopy !== null) shaders.push(this.cacheCopy.mesh.shader);
    for (let i = 0; i < shaders.length; i++) {
      const shader = shaders[i];
      if (shader && shader.resources.uLampTiles !== source) shader.resources.uLampTiles = source;
    }
  }

  /**
   * DX-SHADOW3D (F7): the lamps' map, an atlas of a square tile a stamp light (lampTileLayout), bound to the light pass with
   * its layout (uLampAtlas: tiles a row, a tile's texels, the atlas's size). Made for the most lights the queue's stamps can
   * go to.
   * @returns {boolean}
   */
  _ensureMap(gpu) {
    const most = Math.max(1, (gpu && gpu.caps && gpu.caps.maxStampLights) | 0);
    let lights = most;
    let size = this.worker._lampTileSize;
    if (this.worker._lampTileAuto) {
      // N-196: a tile for each lamp casting now, rounded up to a power of two (the map is made again only when that
      // count or the tile's size changes), each as fine as the widest lamp's reach and the shadows' resolution ask.
      lights = 1;
      while (lights < this.tileCount && lights < most) lights *= 2;
      if (lights > most) lights = most;
      // DX-PIXELSHADOW: with pixel-art lighting a texel a floor px (twice the resolution), so a lamp's shadow steps on the
      // art's pixels rather than on pairs of them, as far as the map's room allows.
      size = autoLampTileSize(this.maxReach, this.worker.shadowResolution * (this.worker._pixelArtLight ? 2 : 1), lights);
    }
    if (this.worker.lighting.lampMapRT !== null && this.lights === lights && this.worker._lampTileSize === size) return true;
    this.worker._lampTileSize = size;
    const layout = lampTileLayout(lights, size, 4096);
    // The light pass lets go of the old map before it goes (Pixi warns of a source destroyed while bound).
    const old = this.worker.lighting.lampMapRT;
    this.worker.lighting.lampMapRT = PIXI.RenderTexture.create({ width: layout.width, height: layout.height, scaleMode: 'nearest' });
    const bound = this.worker.lighting.lightingShader?.resources;
    if (bound) bound.uLampMap = this.worker.lighting.lampMapRT.source;
    if (old) old.destroy(true);
    // DX-GBUF: its programs keep the highest caster point by a depth test, as the sun's.
    this.worker._ensureTargetDepth(this.worker.lighting.lampMapRT);
    this.lights = lights;
    this.tilesPerRow = layout.perRow;
    const a = this.worker.lighting.lampAtlas;
    a[0] = layout.perRow;
    a[1] = layout.size;
    a[2] = layout.width;
    a[3] = layout.height;
    this.mapClear = false;
    return true;
  }

  /**
   * DX-SHADOW3D (F7): a lamps' map program as a Shader's options: the cards (lampMapVertex: the casters facing their lamp)
   * or a render's columns (lampMapColumnsVertex), GLSL on WebGL and WGSL on WebGPU.
   * @param {boolean} columns
   */
  mapProgram(columns) {
    const shaders = this.worker._engineShaders;
    const name = columns ? 'lamp-map-columns' : 'lamp-map';
    if (this.worker._useWebGpu) {
      const source = columns ? lampMapColumnsWgsl(shaders.shadowWgsl) : lampMapWgsl(shaders.shadowWgsl);
      return { gpuProgram: sunShadowGpuProgram(GpuProgram, source, 'mainFragLamp', name, { maps: columns, lampTiles: true }) };
    }
    const vertex = columns ? lampMapColumnsVertex(shaders.shadowVert) : lampMapVertex(shaders.shadowVert);
    return { glProgram: glProgramFrom(PIXI.GlProgram, vertex, lampMapFragment(shaders.sunMapFrag), name) };
  }

  /**
   * DX-SHADOW3D (F7): this frame's stamp rows drawn into the lamps' map: each caster's card in its lamp's tile (max
   * blending: the highest point landing at each texel), a render's columns too. The rows are pre-render's full rows; their
   * light's z, which the lamps' programs do not read, carries the tile + 1 (stampLightIdx).
   * @returns {boolean} whether it drew
   */
  draw(batch, gpu, stampN, keyedRows = false) {
    const shaders = this.worker._engineShaders;
    if (!(this.worker._useWebGpu ? shaders?.shadowWgsl : shaders?.shadowVert && shaders?.sunMapFrag)) return false;
    if (!gpu.stampLightIdx || !this._ensureMap(gpu)) return false;
    if (this.tileSource === null) this._uploadTiles();
    if (this.mesh === null) {
      const r = batch.shadowShader.resources;
      const lampUniforms = () => ({
        uTileWorld: { value: new Float32Array(4), type: 'vec4<f32>' },
        uSun: { value: new Float32Array(4), type: 'vec4<f32>' },
        uLight: { value: new Float32Array(4), type: 'vec4<f32>' },
        uCam: { value: new Float32Array(4), type: 'vec4<f32>' },
        uPointScale: { value: 0, type: 'f32' },
        uGroundInvScaleY: { value: 1, type: 'f32' },
        uSunK: { value: new Float32Array(4), type: 'vec4<f32>' },
        uSunPerp: { value: new Float32Array(4), type: 'vec4<f32>' },
      });
      // DX-LAMPPANO: one program set for each half of the tiles, the ceiling's with uTileWorld.z 1.
      const cardShader = (uniforms) => new PIXI.Shader({
        ...this.mapProgram(false),
        resources: { uTexture: r.uTexture, uSampler: r.uSampler, uTexLut: r.uTexLut, uLampTiles: this.tileSource, uniforms },
      });
      const shader = cardShader(lampUniforms());
      const shaderCeil = cardShader(lampUniforms());
      this.uniforms = shader.resources.uniforms;
      this.uniformsCeil = shaderCeil.resources.uniforms;
      const state = mapDepthState();
      // DX-LAMPPANO: the cards on a strip of three rows (lampCardStrip) over the stamp rows' instance attributes.
      const strip = lampCardStrip();
      this.stripBuffer = new Buffer({ data: strip.vertices, usage: BufferUsage.VERTEX, label: 'lamp-card-strip' });
      this.stripIndex = strip.indices;
      this.stripGeometry = this._cardGeometry(batch);
      this.stripSource = batch.mesh.geometry;
      this.stripBySource.set(this.stripSource, this.stripGeometry);
      this.mesh = new PIXI.Mesh({ geometry: this.stripGeometry, shader, state, label: 'lamp-map' });
      this.meshCeil = new PIXI.Mesh({ geometry: this.stripGeometry, shader: shaderCeil, state, label: 'lamp-map-ceiling' });
      // A depth test keeps the highest caster point and its entity; a mesh's blend mode holds only as a child (the sun
      // map's host says why). Both halves in one render: they write apart.
      this.mesh.blendMode = 'none';
      this.meshCeil.blendMode = 'none';
      this.host = new PIXI.Container();
      this.host.addChild(this.mesh);
      this.host.addChild(this.meshCeil);
      const columnShader = (uniforms) => new PIXI.Shader({
        ...this.mapProgram(true),
        resources: {
          uTexture: r.uTexture,
          uSampler: r.uSampler,
          uTexLut: r.uTexLut,
          uMaps: this.worker.assets.atlasMapsSource ?? this.worker.lighting.emptyMapsSource(),
          uMapsLut: this.worker.assets.mapsTableSourceOrEmpty(),
          uFoot: this.worker.assets.footSourceOrEmpty(),
          uLampTiles: this.tileSource,
          uniforms,
        },
      });
      this.columns = {
        shader: columnShader(this.uniforms),
        shaderCeil: columnShader(this.uniformsCeil),
        grid: new Buffer({ data: lampColumnGrid(LAMP_MAP_COLUMNS), usage: BufferUsage.VERTEX }),
        index: lampColumnIndex(LAMP_MAP_COLUMNS),
        state,
        blendMode: 'none',
        rows: new Float32Array(64 * GPU_CASTER_FLOATS),
        blocks: new Float32Array(64 * 4),
        slots: [],
        ring: 0,
        label: 'lamp-map-columns',
      };
    }
    // E-395: keyed stamp rows (11 floats, the statics by key) through the keyed cards; full rows as below.
    if (keyedRows) return this._drawKeyed(gpu, stampN);
    // The stamp rows, their light's z the tile + 1.
    const n = stampN | 0;
    const cap = batch.capacity | 0;
    const keep = n > cap ? cap : n;
    const len = keep * GPU_CASTER_FLOATS;
    if (keep <= 0 || len > batch.data.length) return false;
    batch.copyIn(batch.data, gpu.stamp, len);
    const tiles = gpu.stampLightIdx;
    const data = batch.data;
    for (let i = 0, at = GPU_CASTER_LIGHT_FLOAT + 2; i < keep; i++, at += GPU_CASTER_FLOATS) data[at] = tiles[i] + 1;
    if (!batch.commitInstances(keep)) return false;
    // DX-LAMPPANO: the strip's geometry follows the batch's (a new one when the batch grows), drawn for these rows.
    const source = batch.mesh.geometry;
    if (this.stripSource !== source) {
      // The batch draws from a ring of geometries, a slot each frame: a strip over each, made once. Made again whenever
      // the slot changed, it was a geometry a frame (96 KB/s of Pixi's garbage in Predator ?light3d=1). A batch that grew
      // makes new ones: past a few, the strips go and are made again.
      let strip = this.stripBySource.get(source);
      if (strip === undefined) {
        if (this.stripBySource.size >= LAMP_STRIP_SOURCES) {
          for (const g of this.stripBySource.values()) g.destroy();
          this.stripBySource.clear();
        }
        strip = this._cardGeometry(batch);
        this.stripBySource.set(source, strip);
      }
      this.stripGeometry = strip;
      this.stripSource = source;
      this.mesh.geometry = strip;
      this.meshCeil.geometry = strip;
    }
    this.stripGeometry.instanceCount = keep;
    for (let half = 0; half < 2; half++) {
      const group = half === 0 ? this.uniforms : this.uniformsCeil;
      const u = group.uniforms;
      u.uTileWorld[0] = this.tilesPerRow;
      u.uTileWorld[1] = this.worker._lampTileSize;
      u.uTileWorld[2] = half;
      u.uSunK[3] = this.worker._heightScaleY > 0 ? this.worker._heightScaleY : 1;
      u.uGroundInvScaleY = this.worker._groundInvScaleY || 1;
      group.update();
    }
    const rtOpts = this.worker._rtRenderOpts;
    rtOpts.container = this.host;
    rtOpts.target = this.worker.lighting.lampMapRT;
    rtOpts.clear = true;
    rtOpts.clearColor = this.worker._clearTransparent;
    this.worker._submitRender(rtOpts);
    this.worker._gpuPassesThisFrame++;
    // E-379: the rows that cast columns towards their lamp, as their own instances.
    const lampColumns = this.worker.assets.atlasMapsSource !== null ? this.worker.shadowMaps._columnsHost(batch, keep, this.columns, 1) : null;
    if (lampColumns !== null) {
      rtOpts.container = lampColumns;
      rtOpts.clear = false;
      this.worker._submitRender(rtOpts);
      this.worker._gpuPassesThisFrame++;
    }
    this._drawVolumes(rtOpts);
    this.mapClear = false;
    return true;
  }

  /**
   * E-395: draw for keyed stamp rows (WebGL): their light's z the tile + 1 (commitKeyedCasterRows), the cards'
   * strip over the caster batch's keyed ring geometry (one a ring slot, made once), the two halves' keyed programs
   * (lampMapVertex over spriteIndexedVertex's keyed stamp rows) sharing the full cards' uniform groups, then the volumes.
   * No columns: keyed rows are sent only while no render casts them (_ensureKeyedCasters).
   * @returns {boolean} whether it drew
   */
  _drawKeyed(gpu, stampN) {
    const shaders = this.worker._engineShaders;
    const entities = this.worker.entitiesBatch;
    const casters = this.worker.gpuCasterBatch;
    if (!entities || !entities.keyed || !casters) return false;
    if (this.keyedMesh === null) {
      let program;
      if (this.worker._useWebGpu) {
        if (!shaders?.shadowWgsl) return false;
        const source = lampMapWgsl(spriteIndexedWgsl(shaders.shadowWgsl, { shadow: true, casterRows: true, light: true }));
        program = { gpuProgram: sunShadowGpuProgram(GpuProgram, source, 'mainFragLamp', 'lamp-map-keyed', { lampTiles: true, statics: true }) };
      } else {
        if (!shaders?.shadowVert || !shaders?.sunMapFrag) return false;
        const vertex = lampMapVertex(spriteIndexedVertex(shaders.shadowVert, { shadow: true, casterRows: true, light: true }));
        program = { glProgram: glProgramFrom(PIXI.GlProgram, vertex, lampMapFragment(shaders.sunMapFrag), 'lamp-map-keyed') };
      }
      const r = casters.shadowShader.resources;
      const keyedShader = (uniforms) => entities.makeKeyedRowsShader(program, {
        uTexture: r.uTexture,
        uSampler: r.uSampler,
        uTexLut: r.uTexLut,
        uLampTiles: this.tileSource,
        uniforms,
      });
      const shader = keyedShader(this.uniforms);
      const shaderCeil = keyedShader(this.uniformsCeil);
      if (shader === null || shaderCeil === null) return false;
      const state = mapDepthState();
      const geometry = this._keyedStripFor(casters.keyedCasterGeometry(true));
      this.keyedMesh = new PIXI.Mesh({ geometry, shader, state, label: 'lamp-map-keyed' });
      this.keyedMeshCeil = new PIXI.Mesh({ geometry, shader: shaderCeil, state, label: 'lamp-map-keyed-ceiling' });
      this.keyedMesh.blendMode = 'none';
      this.keyedMeshCeil.blendMode = 'none';
      this.keyedHost = new PIXI.Container();
      this.keyedHost.addChild(this.keyedMesh);
      this.keyedHost.addChild(this.keyedMeshCeil);
    }
    const rows = casters.commitKeyedCasterRows(gpu.stamp, stampN, GPU_KEYED_STAMP_FLOATS, gpu.stampLightIdx);
    if (rows === null) return false;
    const keep = rows.instanceCount | 0;
    const strip = this._keyedStripFor(rows);
    strip.instanceCount = rows.instanceCount;
    this.keyedMesh.geometry = strip;
    this.keyedMeshCeil.geometry = strip;
    for (let half = 0; half < 2; half++) {
      const group = half === 0 ? this.uniforms : this.uniformsCeil;
      const u = group.uniforms;
      u.uTileWorld[0] = this.tilesPerRow;
      u.uTileWorld[1] = this.worker._lampTileSize;
      u.uTileWorld[2] = half;
      u.uSunK[3] = this.worker._heightScaleY > 0 ? this.worker._heightScaleY : 1;
      u.uGroundInvScaleY = this.worker._groundInvScaleY || 1;
      group.update();
    }
    const rtOpts = this.worker._rtRenderOpts;
    rtOpts.container = this.keyedHost;
    rtOpts.target = this.worker.lighting.lampMapRT;
    rtOpts.clear = true;
    rtOpts.clearColor = this.worker._clearTransparent;
    this.worker._submitRender(rtOpts);
    this.worker._gpuPassesThisFrame++;
    // The keyed rows that cast columns towards their lamp, as their own instances (E-379's, over keyed rows).
    const lampColumns = this.worker.assets.atlasMapsSource !== null ? this.worker.shadowMaps._keyedColumnsHost(keep, this.worker.shadowMaps._keyedColumnsFor('lamp', casters), 1) : null;
    if (lampColumns !== null) {
      rtOpts.container = lampColumns;
      rtOpts.clear = false;
      this.worker._submitRender(rtOpts);
      this.worker._gpuPassesThisFrame++;
    }
    this._drawVolumes(rtOpts);
    this.mapClear = false;
    return true;
  }

  /** E-395: the lamps' cards' strip (lampCardStrip) over a keyed stamp rows' ring geometry, made once for each. */
  _keyedStripFor(rows) {
    let strip = this.keyedStrips.get(rows);
    if (strip === undefined) {
      const attributes = { aQuad: { buffer: this.stripBuffer, format: 'float32x2', stride: 8, offset: 0 } };
      for (const [name, a] of Object.entries(rows.attributes)) {
        if (name === 'aQuad') continue;
        attributes[name] = { buffer: a.buffer, format: a.format, stride: a.stride, offset: a.offset, instance: true };
      }
      strip = new PIXI.Geometry({ attributes, indexBuffer: this.stripIndex });
      this.keyedStrips.set(rows, strip);
    }
    return strip;
  }

  /**
   * OL-5: the lamps' map in a frame whose lamps have tiles and no stamp row: cleared, and the volumes drawn into it as
   * draw draws them after its cards. Without it a street of houses with nobody near its lamps cast no lamp
   * shadow at all: the map was drawn only in a frame with a sprite caster in some lamp's reach.
   * @returns {boolean} whether it drew
   */
  drawVolumes(gpu) {
    if (!this.worker.shadowMaps._volumesCast() || !this._ensureMap(gpu)) return false;
    if (this.tileSource === null) this._uploadTiles();
    const rtOpts = this.worker._rtRenderOpts;
    rtOpts.container = this.worker._rtEmptyContainer;
    rtOpts.target = this.worker.lighting.lampMapRT;
    rtOpts.clear = true;
    rtOpts.clearColor = this.worker._clearTransparent;
    this.worker._submitRender(rtOpts);
    this.worker._gpuPassesThisFrame++;
    this._drawVolumes(rtOpts);
    this.mapClear = false;
    return true;
  }

  /**
   * DX-LAMPPANO: the cards' geometry: the strip (aQuad: lampCardStrip) per vertex, and the sprite batch's instance
   * attributes (this frame's stamp rows) per instance, as the columns' slots read them.
   */
  _cardGeometry(batch) {
    const attributes = { aQuad: { buffer: this.stripBuffer, format: 'float32x2', stride: 8, offset: 0 } };
    for (const [name, a] of Object.entries(batch.mesh.geometry.attributes)) {
      if (name === 'aQuad') continue;
      attributes[name] = { buffer: a.buffer, format: a.format, stride: a.stride, offset: a.offset, instance: true };
    }
    return new PIXI.Geometry({ attributes, indexBuffer: this.stripIndex });
  }

  /**
   * DX-SHADOW3D (F7): each sun-projected volumes' layer drawn into the lamps' map, every tile in use in one draw (E-389):
   * the batch's vertices and indices with an instance a tile (E-453; volumeShadowMap.js volumeLampVertex /
   * volumeLampWgsl), each vertex landing on the floor along its tile's lamp's ray (the tiles' texture holds the lamps and
   * their owners), its height out, the highest kept by the depth test. A mesh past an edge of a tile is left out in its
   * vertices, and one of the tile's lamp's own entity. Last frame's records, as the sun map's volumes. A mesh a tile drew
   * the same: about 47 draws and as many uniform syncs a frame in Predator ?light3d=1.
   *
   * E-508 (lighting.lampMapCache): a lamp still for a few frames, under volumes that held too, is drawn into the cache
   * once (_paintCache) and copied into its tile each frame (_copyCache), after the cards and the columns as the
   * volumes were; the others draw as before. The draws take their tiles from lists in the tiles' texture's row 2
   * (lampVolumeCache.js), written here, after the map's layout is this frame's, and sent again.
   */
  _drawVolumes(rtOpts) {
    const shaders = this.worker._engineShaders;
    const tiles = this.tileCount | 0;
    if (tiles <= 0 || this.tileSource === null) return;
    if (!(this.worker._useWebGpu ? shaders?.meshUvFill : shaders?.meshUvFillVert)) return;
    VOLUME_LAMP_SCALES[0] = 1 / (this.worker._heightScaleY > 0 ? this.worker._heightScaleY : 1);
    VOLUME_LAMP_SCALES[1] = this.worker._groundInvScaleY || 1;
    // This frame's volumes' layers, in order; E-508: whether they, their records or their scales moved (the epoch).
    const active = this.volumeActive;
    let count = 0;
    let indices = 0;
    let moved = false;
    for (let i = 0; i < this.worker.customLayers.list.length; i++) {
      const cl = this.worker.customLayers.list[i];
      const batch = cl.sunProjected ? cl.uvFillBatch : null;
      // instanceCount 1: the batch has triangles (MeshUvFillBatch.upload).
      if (batch === null || (batch.geometry.instanceCount | 0) <= 0) continue;
      let entry = null;
      for (let k = 0; k < this.volumeEntries.length; k++) {
        if (this.volumeEntries[k].batch === batch) entry = this.volumeEntries[k];
      }
      if (entry === null) {
        entry = this._volumeEntry(batch);
        this.volumeEntries.push(entry);
      }
      if (count >= active.length) active.push(entry);
      if (active[count] !== entry) {
        active[count] = entry;
        moved = true;
      }
      count++;
      indices += batch.indexCount;
      if (entry.version !== batch.version) {
        entry.version = batch.version;
        moved = true;
      }
    }
    if (count !== this.volumeActiveCount) {
      this.volumeActiveCount = count;
      moved = true;
    }
    if (count === 0) return;
    const scales = this.volumeScales;
    if (scales[0] !== VOLUME_LAMP_SCALES[0] || scales[1] !== VOLUME_LAMP_SCALES[1]) {
      scales[0] = VOLUME_LAMP_SCALES[0];
      scales[1] = VOLUME_LAMP_SCALES[1];
      moved = true;
    }
    if (moved) this.volumesEpoch = (this.volumesEpoch + 1) | 0;
    const data = this.tileData;
    const width = data.length / (4 * LAMP_TILE_ROWS);
    const perRow = this.tilesPerRow;
    let direct = tiles;
    let cached = 0;
    let paint = false;
    // E-508: only volumes heavy enough for their lamps' tiles (lampCachePays): a copy writes every texel of the half.
    const pays = lampCachePays(indices, this.worker._lampTileSize);
    if (this.worker._lampCacheOn && pays && this._ensureCache(this.lights | 0, this.worker._lampTileSize)) {
      const plan = planLampVolumeCache(
        this.cache, this.tileIds, data, width, tiles, perRow, this.cacheSlots, this.cachePerRow,
        this.volumesEpoch,
      );
      direct = plan.direct;
      cached = plan.cached;
      paint = plan.paint;
    } else {
      writeDirectLampList(data, width, tiles, perRow);
    }
    this._uploadTiles();
    rtOpts.clear = false;
    if (direct > 0) {
      for (let k = 0; k < count; k++) {
        const entry = active[k];
        this._drawVolumeMesh(entry.batch, entry.mesh, entry.host, entry.geometry, direct, 0, rtOpts);
      }
    }
    if (paint) this._paintCache(active, count, cached, direct, rtOpts);
    if (cached > 0) this._copyCache(cached, direct, rtOpts);
  }

  /** One volumes' mesh into the target in rtOpts: `instances` entries of the draws' list from `listStart`. */
  _drawVolumeMesh(batch, mesh, host, geometry, instances, listStart, rtOpts) {
    geometry.instanceCount = instances;
    if (mesh.geometry !== geometry) mesh.geometry = geometry;
    this.worker.shadowMaps._syncVolumeResources(mesh.shader, batch);
    const group = mesh.shader.resources.sunShadow;
    const u = group.uniforms;
    if (writeVolumeLampTerms(u.uSunShadow, u.uLampVolume, listStart, this.tilesPerRow, this.worker._lampTileSize, VOLUME_LAMP_SCALES)) {
      group.update();
    }
    rtOpts.container = host;
    this.worker._submitRender(rtOpts);
    this.worker._gpuPassesThisFrame++;
  }

  /**
   * E-508: the cache painted again, whole: each volumes' layer drawn for the `cached` lamps of the list (from
   * `listStart`), each into its slot, the texel and its depth's bits (VOLUME_LAMP_CACHE_FRAGMENT), the first clearing it.
   */
  _paintCache(active, count, cached, listStart, rtOpts) {
    const map = rtOpts.target;
    rtOpts.target = this.cacheTarget;
    for (let k = 0; k < count; k++) {
      const entry = active[k];
      rtOpts.clear = k === 0;
      this._drawVolumeMesh(entry.batch, entry.paintMesh, entry.paintHost, entry.paintGeometry, cached, listStart, rtOpts);
    }
    rtOpts.clear = false;
    rtOpts.target = map;
  }

  /**
   * E-508: the cached lamps' slots copied into their tiles (`cached` entries of the list from `listStart`), each texel a
   * volume drew with the depth it drew at, so the map's depth test keeps what drawing the volumes there would have.
   */
  _copyCache(cached, listStart, rtOpts) {
    const copy = this._cacheCopyMesh();
    copy.geometry.instanceCount = cached;
    const v = copy.group.uniforms.uLampVolume;
    if (v[0] !== listStart || v[1] !== this.tilesPerRow || v[2] !== this.worker._lampTileSize) {
      v[0] = listStart;
      v[1] = this.tilesPerRow;
      v[2] = this.worker._lampTileSize;
      v[3] = 0;
      copy.group.update();
    }
    rtOpts.container = copy.host;
    this.worker._submitRender(rtOpts);
    this.worker._gpuPassesThisFrame++;
  }

  /**
   * E-508: the cache's target, `slots` floor halves of `size` texels (lampCacheLayout), two colours (the texels, their
   * depths' bits) and a depth buffer; made again when the slots or their size change (the epoch moves: nothing in it
   * holds). False where it cannot be made (no RenderTarget class: the volumes then draw directly).
   */
  _ensureCache(slots, size) {
    if (this.cacheTarget !== null && this.cacheSlots === slots && this.cacheSize === size) return true;
    const RenderTargetClass = this.worker.pixiApp?.renderer?.view?.renderTarget?.constructor;
    if (slots <= 0 || typeof RenderTargetClass !== 'function') return false;
    const layout = lampCacheLayout(slots, size, 4096);
    const opts = { width: layout.width, height: layout.height, scaleMode: 'nearest' };
    const color = PIXI.RenderTexture.create(opts);
    const depth = PIXI.RenderTexture.create(opts);
    const target = new RenderTargetClass({ colorTextures: [color, depth], label: 'weed-lamp-volume-cache' });
    if (typeof target.ensureDepthStencilTexture !== 'function') {
      color.destroy(true);
      depth.destroy(true);
      this.worker._lampCacheOn = false;
      return false;
    }
    target.ensureDepthStencilTexture();
    const oldColor = this.cacheColor;
    const oldDepth = this.cacheDepth;
    this._releaseCacheTarget();
    this.cacheTarget = target;
    this.cacheColor = color;
    this.cacheDepth = depth;
    // The copy lets go of the old textures before they go (Pixi warns of a source destroyed while bound).
    if (this.cacheCopy !== null) {
      const res = this.cacheCopy.mesh.shader.resources;
      res.uCacheColor = color.source;
      res.uCacheDepth = depth.source;
    }
    if (oldColor) oldColor.destroy(true);
    if (oldDepth) oldDepth.destroy(true);
    this.cacheSlots = slots;
    this.cacheSize = size;
    this.cachePerRow = layout.perRow;
    this.volumesEpoch = (this.volumesEpoch + 1) | 0;
    return true;
  }

  /** E-508: the cache's target's GPU side, through the render target system's records (_releaseGbufTarget says why). */
  _releaseCacheTarget() {
    const target = this.cacheTarget;
    if (target === null) return;
    this.cacheTarget = null;
    const system = this.worker.pixiApp?.renderer?.renderTarget;
    const gpuTargets = system ? system._gpuRenderTargetHash : null;
    const gpu = gpuTargets ? gpuTargets[target.uid] : null;
    if (gpu && system.adaptor && typeof system.adaptor.destroyGpuRenderTarget === 'function') {
      gpuTargets[target.uid] = null;
      system.adaptor.destroyGpuRenderTarget(gpu);
    }
    if (system && system._renderSurfaceToRenderTargetHash) system._renderSurfaceToRenderTargetHash.delete(target);
    if (typeof target.destroy === 'function') target.destroy();
  }

  /** E-508: the cache's copy's program as a Shader's options (volumeShadowMap.js LAMP_CACHE_COPY_*). */
  cacheCopyProgram() {
    if (this.worker._useWebGpu) return { gpuProgram: lampCacheCopyGpuProgram(GpuProgram, 'lamp-map-volume-copy') };
    return {
      glProgram: PIXI.GlProgram.from({
        vertex: LAMP_CACHE_COPY_VERTEX,
        fragment: LAMP_CACHE_COPY_FRAGMENT,
        name: 'lamp-map-volume-copy',
      }),
    };
  }

  /**
   * E-508: the copy's mesh (made once): a quad an instance (a cached lamp), its program (volumeShadowMap.js
   * LAMP_CACHE_COPY_*), the tiles' texture, the cache's two colours and its terms (lampCopy: uLampVolume), the depth test
   * and write of the map's other draws.
   */
  _cacheCopyMesh() {
    if (this.cacheCopy !== null) return this.cacheCopy;
    const program = this.cacheCopyProgram();
    const quad = new Buffer({ data: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), usage: BufferUsage.VERTEX, label: 'lamp-cache-quad' });
    const geometry = new PIXI.Geometry({
      attributes: { aPosition: { buffer: quad, format: 'float32x2', stride: 8, offset: 0 } },
      indexBuffer: new Uint16Array([0, 1, 2, 0, 2, 3]),
    });
    geometry.instanceCount = 0;
    const shader = new PIXI.Shader({
      ...program,
      resources: {
        uLampTiles: this.tileSource,
        uCacheColor: this.cacheColor.source,
        uCacheDepth: this.cacheDepth.source,
        lampCopy: { uLampVolume: { value: new Float32Array(4), type: 'vec4<f32>' } },
      },
    });
    const mesh = new PIXI.Mesh({ geometry, shader, state: mapDepthState(), label: 'lamp-map-volume-copy' });
    mesh.blendMode = 'none';
    const host = new PIXI.Container();
    host.addChild(mesh);
    this.cacheCopy = { mesh, host, geometry, group: shader.resources.lampCopy };
    return this.cacheCopy;
  }

  /**
   * E-389, E-453: the lamps' map volumes' geometry: the batch's vertex attributes and its index buffer (the same buffers:
   * what the batch's last upload sent), drawn with an instance an entry of the draw's list (E-508). Two a batch, the
   * direct draw's and the cache's paint's: the frame sets each one's instanceCount.
   */
  _volumeGeometry(batch) {
    const attributes = {};
    for (const [name, a] of Object.entries(batch.geometry.attributes)) {
      attributes[name] = { buffer: a.buffer, format: a.format, stride: a.stride, offset: a.offset };
    }
    const geometry = new PIXI.Geometry({ attributes, indexBuffer: batch.indexBuffer });
    geometry.instanceCount = 0;
    return geometry;
  }

  /**
   * DX-SHADOW3D (F7): a volumes' batch's entry in the lamps' map: one mesh, its own terms (sunShadow: uSunShadow, then
   * uLampVolume, the WGSL struct's order), in its own host, over its geometry (_volumeGeometry). E-508: and its twin
   * for the cache's paint (its program writes two colours), and the batch's version the cache last saw.
   */
  _volumeEntry(batch) {
    const host = new PIXI.Container();
    const geometry = this._volumeGeometry(batch);
    const paintHost = new PIXI.Container();
    const paintGeometry = this._volumeGeometry(batch);
    return {
      batch,
      host,
      mesh: this._volumeMesh(batch, host, geometry, false),
      geometry,
      paintHost,
      paintMesh: this._volumeMesh(batch, paintHost, paintGeometry, true),
      paintGeometry,
      version: -1,
    };
  }

  /**
   * DX-SHADOW3D (F7): the mesh over a volumes' batch in the lamps' map, with its terms, in `host`; E-508: `cache`, the
   * cache's paint's (two colours). The programs and state are made once.
   */
  _volumeMesh(batch, host, geometry, cache) {
    this.makeVolumePrograms();
    const r = batch.shader.resources;
    const shader = new PIXI.Shader({
      ...(cache ? this.volumeCacheProgram : this.volumeProgram),
      resources: {
        uTexture: r.uTexture,
        uSampler: r.uSampler,
        uTexLut: r.uTexLut,
        uPoseTable: r.uPoseTable,
        uLampTiles: this.tileSource,
        // No tile in use until the frame writes this mesh's terms (writeVolumeLampTerms).
        sunShadow: {
          uSunShadow: { value: new Float32Array(4), type: 'vec4<f32>' },
          uLampVolume: { value: new Float32Array(4), type: 'vec4<f32>' },
        },
      },
    });
    const label = cache ? 'lamp-map-volume-cache' : 'lamp-map-volumes';
    const mesh = new PIXI.Mesh({ geometry, shader, state: this.volumeState, label });
    // A depth test keeps the highest point and its entity; a mesh's blend mode holds only as a child (the sun map's host
    // says why).
    mesh.blendMode = 'none';
    host.addChild(mesh);
    return mesh;
  }

  /** DX-SHADOW3D (F7), E-508: the lamps' map volumes' programs (direct, and the cache's paint) and their state, made once. */
  makeVolumePrograms() {
    if (this.volumeProgram === null) {
      const shaders = this.worker._engineShaders;
      this.volumeProgram = this.worker._useWebGpu
        ? {
            gpuProgram: volumeMapGpuProgram(GpuProgram, volumeLampWgsl(shaders.meshUvFill), 'mainFragLamp', 'lamp-map-volumes', {
              lampTiles: true,
            }),
          }
        : {
            glProgram: PIXI.GlProgram.from({
              vertex: volumeLampVertex(shaders.meshUvFillVert),
              fragment: VOLUME_LAMP_FRAGMENT,
              name: 'lamp-map-volumes',
            }),
          };
      this.volumeCacheProgram = this.worker._useWebGpu
        ? {
            gpuProgram: volumeMapGpuProgram(GpuProgram, volumeLampWgsl(shaders.meshUvFill), 'mainFragLampCache', 'lamp-map-volume-cache', {
              lampTiles: true,
            }),
          }
        : {
            glProgram: PIXI.GlProgram.from({
              vertex: volumeLampVertex(shaders.meshUvFillVert),
              fragment: VOLUME_LAMP_CACHE_FRAGMENT,
              name: 'lamp-map-volume-cache',
            }),
          };
      this.volumeState = mapDepthState();
    }
  }

  /** DX-SHADOW3D (F7): a frame with no stamp rows clears the lamps' map (once). */
  clearIfEmpty() {
    if (!this.worker.lighting.lampMapRT || this.mapClear === true) return;
    const rtOpts = this.worker._rtRenderOpts;
    rtOpts.container = this.worker._rtEmptyContainer;
    rtOpts.target = this.worker.lighting.lampMapRT;
    rtOpts.clear = true;
    rtOpts.clearColor = this.worker._clearTransparent;
    this.worker._submitRender(rtOpts);
    this.mapClear = true;
  }
}
