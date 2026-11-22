/**
 * N-256 PW-8: the renderer's 3D shadow maps, moved out of pixiWorker.js as they were (DX-SHADOW3D and after). The sun's
 * map (lighting.sunShadows 'map'), its keyed rows, the volumes drawn into it and the solids' columns; the lamps' map
 * (lighting.lampShadows 'map'), its tiles, keyed strips, card and volume programs and the still lamps' cache (E-508);
 * the shadows' layer's sprite system and the GPU casters' passes (DX-GPUSHADOWS), keyed or not. The light pass binds
 * the maps' targets, which stay the worker's with the lighting state (sunMapRT, lampMapRT, the tile size and fades).
 *
 * Until the renderer's other subsystems move (N-256), what this class reads of the worker (its renderer, backend,
 * camera, config, lighting state, batches, queues, shaders, assets and custom layers) goes through `this.worker`.
 */

import { LightEmitter } from '../../components/lightEmitter.js';
import { Transform } from '../../components/transform.js';
import { Layer } from '../../core/layer.js';
import { Sun } from '../../core/sun.js';
import { LIGHTING_DEFAULTS } from '../../util/configDefaults.js';
import { debugWorkerLog } from '../../util/debugLog.js';
import {
  Buffer,
  BufferUsage,
  Container,
  Geometry,
  GlProgram,
  GpuProgram,
  Matrix,
  Mesh,
  RenderTexture,
  Shader,
  Sprite,
  State,
  TextureSource,
} from '../../vendor/pixi.min.js';
import {
  GPU_CASTER_FLOATS,
  GPU_CASTER_LIGHT_FLOAT,
  GPU_FLAG_CASTER_OWN,
  GPU_FLAG_KEYED_CASTERS,
  GPU_HDR_COOKIE,
  GPU_HDR_FLAGS,
  GPU_HDR_STAMP,
  GPU_HDR_STAMP_LIGHTS,
  GPU_HDR_SUN,
  GPU_KEYED_CASTER_FLOATS,
  GPU_KEYED_STAMP_FLOATS,
  GPU_SPRITE_FLOATS,
} from '../gpuQueueLayout.js';
import { rtPixelSize } from '../gpuShadowCasters.js';
import { INSTANCED_SPRITE_FLOATS, InstancedSpriteBatch, TEX_LUT_FLOATS } from '../instancedSpriteBatch.js';
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
import { layerIsVisible } from '../pixi/layerHelpers.js';
import { spriteIndexedVertex, spriteIndexedWgsl } from '../spriteIndexed.js';
import {
  SUN_MAP_COLUMNS,
  SUN_MAP_MARGIN_MAX,
  SUN_MAP_ZMAX,
  VOLUME_MAP_FRAGMENT,
  compactColumnRows,
  compactKeyedColumnRows,
  sunMapColumnGrid,
  sunMapColumnIndex,
  sunMapColumnsVertex,
  sunMapColumnsWgsl,
  sunMapMargins,
  sunMapTerms,
  sunMapVertex,
  sunMapWgsl,
  volumeMapVertex,
} from '../sunShadowMap.js';
import {
  LAMP_CACHE_COPY_FRAGMENT,
  LAMP_CACHE_COPY_VERTEX,
  VOLUME_LAMP_CACHE_FRAGMENT,
  VOLUME_LAMP_FRAGMENT,
  lampCacheCopyGpuProgram,
  volumeLampVertex,
  volumeLampWgsl,
  volumeMapGpuProgram,
  volumeMapWgsl,
  writeVolumeLampTerms,
} from '../volumeShadowMap.js';
import { glProgramFrom } from '../webgl/glProgram.js';
import { pickInstancedSpriteFragmentGlsl } from '../webgl/instancedSpriteGlsl.js';
import { sunShadowGpuProgram } from '../webgpu/instancedSpriteWgsl.js';
import { writeRgba32Float } from '../webgpu/pinGpuTexture.js';

// The Pixi classes the moved bodies name as PIXI.X, as pixiWorker.js's namespace does.
const PIXI = Object.freeze({ Container, Geometry, GlProgram, Mesh, RenderTexture, Shader, Sprite, State, TextureSource });

/**
 * DX-GBUF: the shadow maps' programs' state (sunShadowMap.frag.glsl): no blending, a depth test (less) and its writes, so
 * each texel keeps its highest caster point, whose depth is 1 - height / ZMAX, with that caster's entity id.
 */
function mapDepthState() {
  const state = new State();
  state.blendMode = 'none';
  state.depthTest = true;
  state.depthMask = true;
  state.culling = false;
  return state;
}

/** DX-LAMPPANO: how many of the stamp batch's geometries keep a lamp card strip of their own (its ring's slots, then some). */
const LAMP_STRIP_SOURCES = 8;

/** DX-SHADOW3D (F7): the volumes' lamp terms' scales, 1 / heightScaleY and 1 / groundScaleY (writeVolumeLampTerms). */
const VOLUME_LAMP_SCALES = new Float64Array(2);

/** The sun's and the lamps' shadow maps and the casters' passes, for one renderer worker. */
export class PixiShadowMaps {
  /** @param {object} worker the PixiRenderer that owns this (its renderer, camera, lighting state and batches) */
  constructor(worker) {
    this.worker = worker;
    // E-191: the sun's shadow pass over the entity batch's keyed instances (made on the first shadow pass that can use
    // it; null where it cannot be), and whether that was tried.
    this.keyedSunMesh = null;
    this.keyedSunTried = false;
    // E-211: whether the last sun pass would have drawn those instances (it had no keyed caster rows from pre-render),
    // so the keyed pack writes their shadow terms for the next one.
    this.keyedSunWanted = false;
    // E-191 step 2: the shadow passes over pre-render's keyed caster rows (the sun's, the stamps'), made with the keyed
    // sun pass; whether that was tried; and whether a frame of such rows was refused for want of them (said once).
    this.keyedSunRowsMesh = null;
    this.keyedStampRowsMesh = null;
    this.keyedCastersTried = false;
    // DX-SHADOW3D (F6): the volumes' map programs, one a volumes' batch (made on first use).
    this.volumeMapMeshes = [];
    // World px to the sun map's texels, (world - camera) · screenScale as its cards land, for the volumes (written when
    // it changes: a Matrix's fields are tagged, each double written a heap number).
    this.volumeMapTransform = new Matrix();
    // DX-SHADOW3D (F7): the volumes in the lamps' map: { batch, host, mesh, geometry: the batch's vertices and indices,
    // drawn with an instance a tile in use (E-389, E-453) } a volumes' batch, and their program's options and state (made
    // on first use).
    this.volumeLampEntries = [];
    this.volumeLampProgram = null;
    this.volumeLampState = null;
    this.volumeLampCacheProgram = null;
    this.lampCache = createLampVolumeCache();
    this.lampCacheTarget = null;
    this.lampCacheColor = null;
    this.lampCacheDepth = null;
    this.lampCacheSlots = 0;
    this.lampCacheSize = 0;
    this.lampCachePerRow = 1;
    this.lampCacheCopy = null;
    this.lampVolumesEpoch = 0;
    this.lampVolumeScales = new Float64Array(2);
    // This frame's volumes' entries in order (_drawVolumesInLampMap), and how many.
    this.volumeLampActive = [];
    this.volumeLampActiveCount = 0;
    /** N-196: this frame's widest casting lamp's reach (floor px; a double from the start). */
    this.lampMaxReach = 0.5;
    this.lampTilesPerRow = 1;
    this.lampMapLights = 0;
    this.lampMapMesh = null;
    // E-395: the lamps' map over keyed stamp rows (WebGL): its two halves' meshes and host, and a strip a ring geometry.
    this.lampMapKeyedMesh = null;
    this.lampMapKeyedMeshCeil = null;
    this.lampMapKeyedHost = null;
    this.lampKeyedStrips = new Map();
    /** DX-LAMPPANO: the cards drawn into the ceiling's half (their own uniforms: uTileWorld.z 1). */
    this.lampMapMeshCeil = null;
    this.lampMapHost = null;
    this.lampMapColumns = null;
    this.lampMapUniforms = null;
    this.lampMapUniformsCeil = null;
    /** DX-LAMPPANO: the cards' strip (lampCardStrip) and its geometry over the batch's instance attributes. */
    this.lampStripBuffer = null;
    this.lampStripIndex = new Uint16Array(0);
    this.lampStripGeometry = null;
    this.lampStripSource = null;
    /** The strip's geometry for each geometry of the batch's ring it was drawn over (made once each, a few at most). */
    this.lampStripBySource = new Map();
    this.lampMapClear = false;
    this.lampMapDrew = false;
    // Each tile's lamp (floor point, height, reach) as RGBA32F, a texel a tile, and below it (row 1) its owner (E-389);
    // entity -> tile; last frame's lamps.
    // E-508: a third row, the volumes' draws' lists (lampVolumeCache.js).
    this.lampTileData = new Float32Array(4 * LAMP_TILE_ROWS);
    this.lampTileSource = null;
    this.lampTileIds = new Uint32Array(1);
    this.lampTileCount = 0;
    this.sunMapMesh = null;
    // E-395: the sun's map over keyed caster rows, and its host; the columns over keyed rows (_keyedColumnsFor).
    this.sunMapKeyedMesh = null;
    this.sunMapKeyedHost = null;
    // The map's card mesh inside a container: a mesh drawn as the render's root takes the root's blend mode (normal), not
    // its own; as a child it draws with max.
    this.sunMapHost = null;
    this.sunMapColumns = null; // { shader, grid, meshes: one a caster geometry } (sunMapColumnsVertex)
    // E-395: the columns passes over keyed caster rows, made on first use (_keyedColumnsFor, which picks one by name).
    this.sunMapKeyedColumns = null;
    this.lampMapKeyedColumns = null;
    // DX-SHADOW3D: layer shadows in a scene with height maps (WebGL): cards that skip mapped frames, and the columns of
    // the mapped ones on the shadows' layer (max blending). { cards, columns } once made (_drawSunSolids).
    this.sunSolids = null;
    this.sunMapUniforms = null;
    this.sunMapTerms = new Float32Array(4);
    this.sunMapNeed = new Float64Array(4);
    this.sunMapTallestPx = 0;
    this.sunMapCamX = 0.5;
    this.sunMapCamY = 0.5;
    this.sunMapDrew = false;
    this.sunMapClear = false;
    this.shadowUpdateInterval = 1;
    this.shadowUpdateTick = 0;
    this.gpuSunDrew = false;
  }

  createShadowSpriteSystem() {
    const lightingConfig = this.worker.config.lighting || {};
    this.worker.shadowResolution = lightingConfig.shadowResolution ?? LIGHTING_DEFAULTS.shadowResolution;
    this.shadowUpdateInterval = lightingConfig.shadowUpdateInterval ?? LIGHTING_DEFAULTS.shadowUpdateInterval ?? 1;
    this.shadowUpdateTick = 0;
    if (lightingConfig.maxLights !== undefined) this.worker.maxLights = lightingConfig.maxLights;
    if (lightingConfig.maxShadowCastingLights !== undefined) {
      this.worker.maxShadowCastingLights = lightingConfig.maxShadowCastingLights;
    }

    this.worker.shadowRT = PIXI.RenderTexture.create({
      width: rtPixelSize(this.worker.canvasWidth, this.worker.shadowResolution),
      height: rtPixelSize(this.worker.canvasHeight, this.worker.shadowResolution),
    });

    const gpuCaps = this.worker.gpuQueueBuffers && this.worker.gpuQueueBuffers[0] ? this.worker.gpuQueueBuffers[0].caps : null;
    const cookieCap = gpuCaps ? Math.max(1, gpuCaps.maxCookie | 0) : Math.max(1, this.worker.maxLights | 0);
    const casterCap = gpuCaps
      ? Math.max(1, gpuCaps.maxSun | 0, gpuCaps.maxStamp | 0)
      : Math.max(1, this.worker.renderQueueMaxItems | 0);
    this.worker.shadowBatch = new InstancedSpriteBatch({
      capacity: cookieCap,
      label: 'shadows-instanced',
      atlasSource: this.worker.assets.resolveAtlasSource(),
      lutSource: this.worker.assets.texLutSource,
      depthTest: false,
      depthMask: false,
      useWebGpu: this.worker._useWebGpu,
      shaders: this.worker._engineShaders,
      arena: this.worker._batchArena(cookieCap * INSTANCED_SPRITE_FLOATS),
    });
    this.worker.gpuCasterBatch = new InstancedSpriteBatch({
      capacity: casterCap,
      label: 'gpu-casters',
      atlasSource: this.worker.assets.resolveAtlasSource(),
      lutSource: this.worker.assets.texLutSource,
      depthTest: false,
      depthMask: false,
      useWebGpu: this.worker._useWebGpu,
      shaders: this.worker._engineShaders,
      shadowCast: true,
      arena: this.worker._batchArena(casterCap * GPU_CASTER_FLOATS),
    });
    if (this.worker.gpuCasterBatch.shadowShader && this.worker.gpuCasterBatch.mesh) {
      this.worker.gpuCasterBatch.mesh.shader = this.worker.gpuCasterBatch.shadowShader;
      // E-494: its sprite program is never drawn (the batch draws casters only): not linked ahead, unless another batch's
      // is the same program (GlProgram.from).
      this.worker._leaveOutOfLinksAhead(this.worker.gpuCasterBatch.shader, [this.worker.shadowBatch.shader]);
    }

    this.worker.shadowDisplaySprite = new PIXI.Sprite(this.worker.shadowRT);
    this.worker.shadowDisplaySprite.anchor.set(0, 0);
    this.worker.shadowDisplaySprite.position.set(0, 0);
    this.worker.shadowDisplaySprite.scale.set(
      this.worker.canvasWidth / this.worker.shadowRT.width,
      this.worker.canvasHeight / this.worker.shadowRT.height
    );
    this.worker.lighting.bindLightingShadowMap();
    this.worker._registerLayerDisplayObject('castedShadows', this.worker.shadowDisplaySprite);
    this.worker.pixiApp.stage.addChild(this.worker.shadowDisplaySprite);

    debugWorkerLog(
      `PIXI WORKER: Shadow instanced RT (${this.worker.shadowRT.width}x${this.worker.shadowRT.height}, casters ${casterCap})`
    );
  }

  /**
   * Create the RenderTexture-based shadow system:
   * 1. Create shadowRT (RenderTexture) - cleared transparent each frame
   * 2. Create shadowBatch - instanced Mesh (per-light soft cookies + black shadows)
   * 3. Create shadowDisplaySprite - displays shadowRT with multiply blend
   *
   * Rendering order per frame (SoA already interleaved per light):
   * - Clear shadowRT to transparent (not opaque black — that fills the multiply layer)
   * - Draw light cookies then that light's shadows (multi-light attenuation)
   * - shadowDisplaySprite (multiply) darkens the scene where RT is dark
   */
  updateShadowSprites() {
    if (!this.worker.shadowSpritesEnabled) return;
    if (!this.worker.shadowBatch || !this.worker.shadowRT) return;
    if (!layerIsVisible(Layer.castedShadows?.id)) {
      this._setKeyedSunStream(false);
      this._clearShadowMapsWhileHidden();
      return;
    }
    const interval = this.shadowUpdateInterval | 0;
    const skip = interval > 1 && (this.shadowUpdateTick % interval) !== 0;
    this.shadowUpdateTick++;
    if (!skip) {
      this._drawGpuCasterShadows();
    }
    // E-211: the next frame's keyed pack writes the instances' shadow terms only when that frame's sun pass runs and
    // would draw them.
    const nextSkip = interval > 1 && (this.shadowUpdateTick % interval) !== 0;
    this._setKeyedSunStream(this.keyedSunWanted && !nextSkip);
  }

  /**
   * DBG-1: the casted-shadows layer hidden means no shadows. In map mode the light pass samples the sun's and the lamps'
   * maps, and only the shadow pass draws or clears them: left alone they would stand on screen, frozen. They are cleared
   * once, and the tick restarts so the first frame shown again draws them whatever shadowUpdateInterval is.
   */
  _clearShadowMapsWhileHidden() {
    this.shadowUpdateTick = 0;
    if (this.worker._sunMapOn) {
      this.sunMapDrew = false;
      this._clearSunMapIfEmpty();
    }
    if (this.worker._lampMapOn) {
      this.lampMapDrew = false;
      this._clearLampMapIfEmpty();
    }
  }

  /** E-211: whether the entity batch's next keyed packs write its instances' shadow terms (once it has them). */
  _setKeyedSunStream(on) {
    const b = this.worker.entitiesBatch;
    if (b && b.keyedShadows) b.setKeyedShadowStream(on);
  }

  _drawGpuCasterShadows() {
    this.keyedSunWanted = false;
    this.gpuSunDrew = false;
    this.worker._gpuPassesThisFrame = 0;
    this.worker._gpuCastersThisFrame = 0;
    this.worker._gpuShadowLightsThisFrame = 0;
    const batch = this.worker.gpuCasterBatch;
    const mesh = batch && batch.mesh;
    const shader = batch && batch.shadowShader;
    if (!shader || !mesh || !this.worker.shadowRT) return;
    const group = shader.resources && shader.resources.uniforms;
    const u = group && group.uniforms;
    if (!u || !u.uCam || !u.uSun || !u.uLight) return;

    this._ensureKeyedCasters(shader);
    const gpu = this.worker._gpuQueueRead;
    // DBG-1: the sun and stamp rows are the entities' (pre-render takes them from the render queue), so a hidden entities
    // layer casts nothing, and its cookies (they only lighten what casters drew) go with them. Volumes cast on their own.
    const castersShown = !!(gpu && gpu.header) && layerIsVisible(Layer.entitiesId);
    const sunN = castersShown ? (gpu.header[GPU_HDR_SUN] | 0) : 0;
    const stampN = castersShown ? (gpu.header[GPU_HDR_STAMP] | 0) : 0;
    const cookieN = castersShown ? (gpu.header[GPU_HDR_COOKIE] | 0) : 0;
    // E-191 step 2: pre-render's sun and stamp rows are keyed caster rows (a pose, a key, the shadow terms; a stamp's
    // light) when it found Pixi's statics recent.
    const keyedRows = gpu && gpu.header ? ((gpu.header[GPU_HDR_FLAGS] | 0) & GPU_FLAG_KEYED_CASTERS) !== 0 : false;
    // N-188: this frame's rows carry casters' own ways: they are drawn, not the entity batch's keyed instances.
    const ownRows = gpu && gpu.header ? ((gpu.header[GPU_HDR_FLAGS] | 0) & GPU_FLAG_CASTER_OWN) !== 0 : false;
    this.worker._gpuCastersThisFrame = sunN;
    this.worker._gpuShadowLightsThisFrame = cookieN;

    const zoom = this.worker._renderZoom || 1;
    const res = this.worker.lighting.shadowPixelScale();
    u.uCam[0] = this.worker._renderCameraX;
    u.uCam[1] = this.worker._renderCameraY;
    u.uCam[2] = zoom * res;
    const sunOn = Sun.isInitialized && Sun.enabled && Sun.intensity > 0.1;
    if (sunOn) {
      u.uSun[0] = Sun.shadowDirY;
      u.uSun[1] = -Sun.shadowDirX;
      u.uSun[2] = Sun.shadowLengthRatio;
      u.uSun[3] = Sun.shadowOpacity;
      // DX-SHADOW3D: the sun's card, in both shadow modes: each picture point lands along the sun's ray (no longer than
      // shadowMaxLengthRatio per px of height), its columns across the sun.
      this.worker.lighting.writeFaceSun();
      const t = sunMapTerms(this.worker.lighting.faceSun, this.sunMapTerms, Sun.shadowMaxLengthRatio);
      u.uSunK[0] = t[0];
      u.uSunK[1] = t[1];
      u.uSunK[3] = this.worker._heightScaleY > 0 ? this.worker._heightScaleY : 1;
      u.uSunPerp[0] = t[2];
      u.uSunPerp[1] = t[3];
    } else {
      u.uSun[3] = 0;
    }
    u.uGroundInvScaleY = this.worker._groundInvScaleY || 1;
    u.uLight[0] = 0;
    u.uLight[1] = 0;
    u.uLight[2] = 0;
    u.uLight[3] = 0;
    u.uPointScale = 0;
    if (mesh.shader !== shader) mesh.shader = shader;
    mesh.position.set(0, 0);
    mesh.scale.set(1, 1);
    const rtOpts = this.worker._rtRenderOpts;
    rtOpts.target = this.worker.shadowRT;
    rtOpts.clearColor = this.worker._clearTransparent;

    batch.setTargetSpace(false, 0, 0, 1);
    this.sunMapDrew = false;
    if (this.worker._sunMapOn) {
      // DX-SHADOW3D: the sun's rows go to its shadow map, not to the shadows' layer.
      if (u.uSun[3] > 0 && (sunN > 0 || this._volumesCast()) && this._drawSunMap(batch, gpu, sunN, zoom * res, keyedRows)) {
        this.sunMapDrew = true;
      }
      this._clearSunMapIfEmpty();
    } else if (u.uSun[3] > 0 && sunN > 0 && !keyedRows && this.sunSolidsOn()) {
      // DX-SHADOW3D: a scene with height maps: what has one casts its solid's columns, the rest its card (full rows).
      this.worker._commitPackedBatch(batch, gpu.sun, sunN, GPU_CASTER_FLOATS);
      this._drawSunSolids(batch, group);
    } else if (u.uSun[3] > 0 && sunN > 0) {
      // E-211: pre-render's keyed sun rows when it wrote them (it packs them for the stamps in any case): 28 bytes a
      // caster, read in order, where the instances cost the keyed pack 12 bytes a sprite gathered from three more
      // queue columns and 12 more written. Else (E-191) the entity batch's own instances, when this frame's pack wrote
      // their shadow terms (a sprite that casts none has no height); else pre-render's full sun rows.
      this.keyedSunWanted = !keyedRows && !ownRows;
      const keyedSun = keyedRows || ownRows ? null : this._keyedSunFor(shader);
      if (keyedRows) {
        const rows = this.worker._keyedRowsMesh(this.keyedSunRowsMesh, gpu.sun, sunN, GPU_KEYED_CASTER_FLOATS);
        if (rows !== null) this._drawGpuCasterPass(rows, group, true);
      } else if (keyedSun !== null) {
        this._drawGpuCasterPass(keyedSun, group, true);
      } else {
        this.worker._commitPackedBatch(batch, gpu.sun, sunN, GPU_CASTER_FLOATS);
        this._drawGpuCasterPass(mesh, group, true);
      }
    }

    const sunI = sunOn ? Sun.intensity : 0;
    let pointScale = 0.33 * (1 - sunI * 0.9);
    if (pointScale < 0.2) pointScale = 0.2;
    u.uPointScale = pointScale;
    u.uGroundInvScaleY = this.worker._groundInvScaleY || 1;

    if (cookieN > 0 && this.worker.shadowBatch && gpu.cookie) {
      const screenScale = zoom * res;
      this.worker.shadowBatch.setTargetSpace(true, this.worker._renderCameraX, this.worker._renderCameraY, screenScale);
      if (this.worker._commitPackedBatch(this.worker.shadowBatch, gpu.cookie, cookieN, GPU_SPRITE_FLOATS)) {
        rtOpts.container = this.worker.shadowBatch.mesh;
        rtOpts.target = this.worker.shadowRT;
        rtOpts.clear = !this.gpuSunDrew;
        rtOpts.clearColor = this.worker._clearTransparent;
        this.worker._submitRender(rtOpts);
        this.worker._gpuPassesThisFrame++;
        this.gpuSunDrew = true;
      }
    }

    this.lampMapDrew = false;
    if (stampN > 0 && this.worker._lampMapOn) {
      // DX-SHADOW3D (F7): each lamp's casters into its tile of the lamps' map; the light pass takes each lamp out alone.
      // E-395: keyed stamp rows too (WebGL).
      this.lampMapDrew = this._drawLampMap(batch, gpu, stampN, keyedRows);
    } else if (stampN > 0) {
      u.uLight[0] = 0;
      u.uLight[1] = 0;
      u.uLight[2] = 0;
      u.uLight[3] = 0;
      if (keyedRows) {
        const rows = this.worker._keyedRowsMesh(this.keyedStampRowsMesh, gpu.stamp, stampN, GPU_KEYED_STAMP_FLOATS);
        if (rows !== null) this._drawGpuCasterPass(rows, group, !this.gpuSunDrew);
      } else {
        this.worker._commitPackedBatch(batch, gpu.stamp, stampN, GPU_CASTER_FLOATS);
        this._drawGpuCasterPass(mesh, group, !this.gpuSunDrew);
      }
    } else if (stampN <= 0 && this.worker._lampMapOn && (this.lampTileCount | 0) > 0) {
      // OL-5: lamps with tiles and no stamp row (no sprite caster in any lamp's reach): the volumes alone.
      this.lampMapDrew = this._drawLampMapVolumes(gpu);
    }

    if (this.worker._lampMapOn && !this.lampMapDrew) this._clearLampMapIfEmpty();

    if (!this.gpuSunDrew) {
      rtOpts.container = this.worker._rtEmptyContainer;
      rtOpts.clear = true;
      this.worker._submitRender(rtOpts);
    }
  }

  _drawGpuCasterPass(mesh, group, needClear) {
    if ((mesh.geometry.instanceCount | 0) <= 0) return false;
    const rtOpts = this.worker._rtRenderOpts;
    rtOpts.container = mesh;
    rtOpts.target = this.worker.shadowRT;
    rtOpts.clear = needClear;
    this.worker._syncUniformGroup(group);
    this.worker._submitRender(rtOpts);
    this.worker._gpuPassesThisFrame++;
    this.gpuSunDrew = true;
    return true;
  }

  /**
   * E-191: the sun pass's mesh over the entity batch's keyed instances of this frame, or null (no keyed frame this
   * frame, WebGPU, or no shadow stream). Made on first use: the shadow program reading the statics by key, the caster
   * shader's resources and uniform group, the caster batch's state.
   */
  _keyedSunFor(sunShader) {
    // Those instances are the sprites': a ShadowCaster's own texture is only in pre-render's rows.
    // DX-SHADOW3D: a directional caster's sun frame rides in pre-render's rows (full or keyed, plan §17.2); these
    // instances have no room for it.
    // N-188: casters' own ways (a frame, a kind) and the keyed paths' diagnostic switch ride in pre-render's rows (the
    // frame's GPU_FLAG_CASTER_OWN, which the caller reads).
    if (this.worker.config?.lighting?.keyedCasters === false || this.worker.config?.lighting?.directionalCasters === true) return null;
    const b = this.worker.entitiesBatch;
    if (!this.keyedSunTried) {
      this.keyedSunTried = true;
      const casters = this.worker.gpuCasterBatch;
      if (b && b.keyed && casters && casters.mesh && b.enableKeyedShadows()) {
        const shader = b.makeKeyedSunShader(sunShader);
        if (shader) {
          this.keyedSunMesh = new PIXI.Mesh({
            geometry: b.keyedShadowGeometry,
            shader,
            state: casters.mesh.state,
            label: 'keyed-sun-casters',
          });
        }
      }
    }
    if (this.keyedSunMesh === null || !b || !b.keyedShadowReady) return null;
    this.keyedSunMesh.geometry = b.keyedShadowGeometry;
    return this.keyedSunMesh;
  }

  /**
   * E-191 step 2: the shadow passes over pre-render's keyed caster rows, made once: the sun rows' and the stamp rows'
   * programs (the entity batch's statics by key) on the caster batch's geometries for such rows. Once both are made the
   * entity batch's keyed uploads tell pre-render (its header's LIVE word), which then writes such rows.
   */
  _ensureKeyedCasters(sunShader) {
    // DX-SHADOW3D: the sun's map and the renders' solids read pre-render's full rows (their columns need a frame's
    // instance whole); a directional caster's sun frame rides in the keyed rows too (plan §17.2).
    // E-395: the maps draw keyed rows too (_drawSunMap, _drawLampMap), and the renders' columns over them, picked with the
    // entity batch's copy of the slots' statics (enableStaticsMirror) where the atlas has height maps.
    if (this.keyedCastersTried) return;
    this.keyedCastersTried = true;
    const b = this.worker.entitiesBatch;
    const casters = this.worker.gpuCasterBatch;
    if (!b || !b.keyed || !casters || !casters.mesh) return;
    if (this.sunSolidsOn() && !b.enableStaticsMirror()) return;
    const sun = b.makeKeyedCasterShader(sunShader, false);
    const stamp = b.makeKeyedCasterShader(sunShader, true);
    if (sun === null || stamp === null) return;
    const state = casters.mesh.state;
    this.keyedSunRowsMesh = new PIXI.Mesh({ geometry: casters.keyedCasterGeometry(false), shader: sun, state, label: 'keyed-sun-rows' });
    this.keyedStampRowsMesh = new PIXI.Mesh({ geometry: casters.keyedCasterGeometry(true), shader: stamp, state, label: 'keyed-stamp-rows' });
    b.keyedCasters = true;
  }

  /**
   * N-317: the sun map reaches past the shadows' layer by the margins this frame's sun needs (sunMapMargins: the atlas's
   * tallest frame, at most SUN_MAP_ZMAX px of height, landing by the sun's terms), so a pixel near the screen's edge finds
   * its ray's landing in it. The map is made again only when a margin needs more than it has, or has more than twice what
   * it needs and 64 texels besides (each made with a quarter more, rounded up to 16 texels). Sets the camera its passes
   * draw from (moved by the top-left margins) and the light pass's uSunMapRect (the screen's uv into the map).
   */
  _fitSunMap(screenScale) {
    const w = this.worker.shadowRT.width;
    const h = this.worker.shadowRT.height;
    const hs = this.worker._heightScaleY > 0 ? this.worker._heightScaleY : 1;
    const s = screenScale > 0 ? screenScale : 1;
    const tallest = Math.min(SUN_MAP_ZMAX, this.sunMapTallestPx / hs);
    const need = sunMapMargins(this.sunMapTerms, tallest, hs, this.worker._groundScaleY || 1, s, this.sunMapNeed);
    // At most SUN_MAP_MARGIN_MAX of the screen's side each (a low sun throws a tall frame's ray far).
    const capX = w * SUN_MAP_MARGIN_MAX;
    const capY = h * SUN_MAP_MARGIN_MAX;
    if (need[0] > capX) need[0] = capX;
    if (need[2] > capX) need[2] = capX;
    if (need[1] > capY) need[1] = capY;
    if (need[3] > capY) need[3] = capY;
    const m = this.worker._sunMapMargins;
    let refit = this.worker.sunMapRT === null;
    for (let i = 0; i < 4; i++) {
      if (need[i] > m[i] || m[i] > 2 * need[i] + 64) refit = true;
    }
    if (refit) {
      for (let i = 0; i < 4; i++) {
        const cap = Math.ceil((i & 1 ? capY : capX) / 16) * 16;
        const want = need[i] > 0 ? Math.ceil((need[i] * 1.25) / 16) * 16 : 0;
        m[i] = want < cap ? want : cap;
      }
      this.createSunMap(w + m[0] + m[2], h + m[1] + m[3]);
    }
    const W = w + m[0] + m[2];
    const H = h + m[1] + m[3];
    const r = this.worker.lighting.sunMapRect;
    r[0] = w / W;
    r[1] = h / H;
    r[2] = m[0] / W;
    r[3] = m[1] / H;
    this.sunMapCamX = this.worker._renderCameraX - m[0] / s;
    this.sunMapCamY = this.worker._renderCameraY - m[1] / s;
  }

  /** DX-SHADOW3D: the sun's shadow map, the size of the shadows' layer and N-317's margins, bound to the light pass. */
  createSunMap(width, height) {
    if (this.worker.sunMapRT) this.worker.sunMapRT.destroy(true);
    this.worker.sunMapRT = PIXI.RenderTexture.create({ width, height, scaleMode: 'nearest' });
    // DX-GBUF: its programs keep the highest caster point by a depth test (sunShadowMap.frag.glsl).
    this.worker._ensureTargetDepth(this.worker.sunMapRT);
    const res = this.worker.lighting.lightingShader?.resources;
    if (res) res.uSunMap = this.worker.sunMapRT.source;
  }

  /**
   * DX-SHADOW3D: this frame's sun rows drawn into the sun's map (max blending): the caster batch's geometry with the map's
   * program (instancedSpriteShadow.vert.glsl turned by sunMapVertex), made on first use.
   * @returns {boolean} whether it drew
   */
  _drawSunMap(batch, gpu, sunN, screenScale, keyedRows = false) {
    const shaders = this.worker._engineShaders;
    if (!this.worker.shadowRT || !(this.worker._useWebGpu ? shaders?.shadowWgsl : shaders?.shadowVert && shaders?.sunMapFrag)) return false;
    // Made here (the shadow layer is created before the lighting config is read), to the margins the sun asks for now.
    this.worker.lighting.writeFaceSun();
    sunMapTerms(this.worker.lighting.faceSun, this.sunMapTerms, Sun.shadowMaxLengthRatio);
    this._fitSunMap(screenScale);
    if (this.sunMapMesh === null) {
      const r = batch.shadowShader.resources;
      const uniforms = {
        uTileWorld: { value: new Float32Array([0, 0, 0, 0]), type: 'vec4<f32>' },
        uSun: { value: new Float32Array(4), type: 'vec4<f32>' },
        uLight: { value: new Float32Array(4), type: 'vec4<f32>' },
        uCam: { value: new Float32Array(4), type: 'vec4<f32>' },
        uPointScale: { value: 0, type: 'f32' },
        uGroundInvScaleY: { value: 1, type: 'f32' },
        uSunK: { value: new Float32Array(4), type: 'vec4<f32>' },
        uSunPerp: { value: new Float32Array(4), type: 'vec4<f32>' },
      };
      const shader = new PIXI.Shader({
        ...this.sunShadowProgram('map'),
        // No uMaps: the map's cards program does not read the twin page (its WGSL does not declare it, and Pixi warned).
        resources: { uTexture: r.uTexture, uSampler: r.uSampler, uTexLut: r.uTexLut, uniforms },
      });
      // Pixi made the group from the object.
      this.sunMapUniforms = shader.resources.uniforms;
      const state = mapDepthState();
      this.sunMapMesh = new PIXI.Mesh({ geometry: batch.mesh.geometry, shader, state, label: 'sun-map' });
      // DX-GBUF: a depth test keeps the highest caster point and its entity (sunShadowMap.frag.glsl), no blending. A mesh's
      // blend mode is its own only as a child (as the root it draws normal).
      this.sunMapMesh.blendMode = 'none';
      this.sunMapHost = new PIXI.Container();
      this.sunMapHost.addChild(this.sunMapMesh);
      // Casters with height maps: their columns, over the same instances (one geometry a caster geometry).
      this.sunMapColumns = {
        shader: new PIXI.Shader({
          ...this.sunShadowProgram('mapColumns'),
          // Named one by one: a shader's resources are not plain properties to spread.
          resources: {
            uTexture: r.uTexture,
            uSampler: r.uSampler,
            uTexLut: r.uTexLut,
            uMaps: this.worker.assets.atlasMapsSource ?? this.worker.lighting.emptyMapsSource(),
            uMapsLut: this.worker.assets.mapsTableSourceOrEmpty(),
            uFoot: this.worker.assets.footSourceOrEmpty(),
            uniforms: this.sunMapUniforms,
          },
        }),
        grid: new Buffer({ data: sunMapColumnGrid(), usage: BufferUsage.VERTEX }),
        index: sunMapColumnIndex(SUN_MAP_COLUMNS),
        state,
        blendMode: 'none',
        rows: new Float32Array(64 * GPU_CASTER_FLOATS),
        blocks: new Float32Array(64 * 4),
        slots: [],
        ring: 0,
        label: 'sun-map-columns',
      };
    }
    // N-190: with no sprite caster's row this frame the volumes still cast (a scene of boxes alone): the cards' and the
    // columns' passes are left out, the map is cleared by the first of what draws.
    // E-395: keyed rows (7 floats a caster, the statics by key) through the keyed program; full rows as before.
    const keyedMesh = keyedRows ? this._sunMapKeyedMeshFor(batch) : null;
    if (keyedRows && keyedMesh === null) return false;
    let rows = 0;
    if (keyedMesh !== null) {
      const geometry = sunN > 0 ? this.worker.gpuCasterBatch.commitKeyedCasterRows(gpu.sun, sunN, GPU_KEYED_CASTER_FLOATS) : null;
      if (geometry !== null) {
        keyedMesh.geometry = geometry;
        rows = geometry.instanceCount | 0;
      }
    } else {
      rows = sunN > 0 ? this.worker._commitPackedBatch(batch, gpu.sun, sunN, GPU_CASTER_FLOATS) : 0;
    }
    if (rows <= 0 && !this._volumesCast()) return false;
    const mesh = this.sunMapMesh;
    if (keyedMesh === null) mesh.geometry = batch.mesh.geometry;
    const u = this.sunMapUniforms.uniforms;
    // N-317: from the camera moved by the map's top-left margin (_fitSunMap), so the screen sits inside the map.
    u.uCam[0] = this.sunMapCamX;
    u.uCam[1] = this.sunMapCamY;
    u.uCam[2] = screenScale;
    u.uSun[3] = 1;
    u.uGroundInvScaleY = this.worker._groundInvScaleY || 1;
    u.uSunK[0] = this.sunMapTerms[0];
    u.uSunK[1] = this.sunMapTerms[1];
    u.uSunK[3] = this.worker._heightScaleY > 0 ? this.worker._heightScaleY : 1;
    u.uSunPerp[0] = this.sunMapTerms[2];
    u.uSunPerp[1] = this.sunMapTerms[3];
    this.sunMapUniforms.update();
    const k = this.worker.lighting.sunMapK;
    k[0] = this.sunMapTerms[0];
    k[1] = this.sunMapTerms[1];
    k[2] = this.worker._groundScaleY || 1;
    // How much of the sun a shadow takes out: Sun.shadowAlpha alone. shadowOpacity also scales it by the sun's intensity
    // (the light pass's sun term is already scaled by it: a low sun's shadows were faint twice over) and lightens a long
    // shadow (a 2D trick: here a shadow's length does not thin it). At 16 h in the light bench that left 13 % of darkness.
    k[3] = Math.max(0, Math.min(1, Sun.shadowAlpha));
    const rtOpts = this.worker._rtRenderOpts;
    rtOpts.container = rows > 0 ? (keyedMesh !== null ? this.sunMapKeyedHost : this.sunMapHost) : this.worker._rtEmptyContainer;
    rtOpts.target = this.worker.sunMapRT;
    rtOpts.clear = true;
    rtOpts.clearColor = this.worker._clearTransparent;
    this.worker._submitRender(rtOpts);
    // E-379: the rows that cast columns, as their own instances.
    const sunColumns = rows <= 0 || this.worker.assets.atlasMapsSource === null
      ? null
      : keyedMesh !== null
        ? this._keyedColumnsHost(rows, this._keyedColumnsFor('sun', batch), 0)
        : this._columnsHost(batch, rows, this.sunMapColumns, 0);
    if (sunColumns !== null) {
      rtOpts.container = sunColumns;
      rtOpts.clear = false;
      this.worker._submitRender(rtOpts);
      this.worker._gpuPassesThisFrame++;
    }
    this._drawVolumesInSunMap(rtOpts, screenScale);
    rtOpts.target = this.worker.shadowRT;
    this.worker._gpuPassesThisFrame++;
    return true;
  }

  /**
   * E-395: the sun map's mesh over keyed caster rows (WebGL), made on first use: sunMapVertex over spriteIndexedVertex's
   * keyed rows (the statics by key from the entity batch's texture; the caster's entity from its key, casterEntityId), the
   * map's fragment program, uniforms and depth state. Null where the entity batch keeps no keyed frames.
   */
  _sunMapKeyedMeshFor(batch) {
    if (this.sunMapKeyedMesh !== null) return this.sunMapKeyedMesh;
    const shaders = this.worker._engineShaders;
    const entities = this.worker.entitiesBatch;
    if (!entities || !entities.keyed) return null;
    let program;
    if (this.worker._useWebGpu) {
      if (!shaders?.shadowWgsl) return null;
      const source = sunMapWgsl(spriteIndexedWgsl(shaders.shadowWgsl, { shadow: true, casterRows: true }), { heights: true });
      program = { gpuProgram: sunShadowGpuProgram(GpuProgram, source, 'mainFragMap', 'sun-map-keyed', { statics: true }) };
    } else {
      if (!shaders?.shadowVert || !shaders?.sunMapFrag) return null;
      const vertex = sunMapVertex(spriteIndexedVertex(shaders.shadowVert, { shadow: true, casterRows: true }), { heights: true });
      program = { glProgram: glProgramFrom(PIXI.GlProgram, vertex, shaders.sunMapFrag, 'sun-map-keyed') };
    }
    const r = batch.shadowShader.resources;
    const shader = entities.makeKeyedRowsShader(program, {
      uTexture: r.uTexture,
      uSampler: r.uSampler,
      uTexLut: r.uTexLut,
      uniforms: this.sunMapUniforms,
    });
    if (shader === null) return null;
    const mesh = new PIXI.Mesh({ geometry: this.worker.gpuCasterBatch.keyedCasterGeometry(false), shader, state: mapDepthState(), label: 'sun-map-keyed' });
    mesh.blendMode = 'none';
    this.sunMapKeyedHost = new PIXI.Container();
    this.sunMapKeyedHost.addChild(mesh);
    this.sunMapKeyedMesh = mesh;
    return mesh;
  }

  /** DX-SHADOW3D: a frame with no sun rows clears the sun's map (once). */
  _clearSunMapIfEmpty() {
    if (this.sunMapDrew || !this.worker.sunMapRT || this.sunMapClear === true) {
      if (this.sunMapDrew) this.sunMapClear = false;
      return;
    }
    const rtOpts = this.worker._rtRenderOpts;
    rtOpts.container = this.worker._rtEmptyContainer;
    rtOpts.target = this.worker.sunMapRT;
    rtOpts.clear = true;
    rtOpts.clearColor = this.worker._clearTransparent;
    this.worker._submitRender(rtOpts);
    rtOpts.target = this.worker.shadowRT;
    this.sunMapClear = true;
  }

  /**
   * DX-SHADOW3D: a sun shadow pass's program as a Shader's options: 'map' (the sun map's cards: heights), 'mapColumns'
   * (a render's columns into the map), 'cards' (the layer shadows' cards, a render's frames skipped) or 'columns' (a
   * render's solid on the shadows' layer). GLSL on WebGL (sunMapVertex / sunMapColumnsVertex), WGSL on WebGPU
   * (sunMapWgsl / sunMapColumnsWgsl).
   * @param {'map'|'mapColumns'|'cards'|'columns'} kind
   */
  sunShadowProgram(kind) {
    const shaders = this.worker._engineShaders;
    const heights = kind === 'map' || kind === 'mapColumns';
    const columns = kind === 'mapColumns' || kind === 'columns';
    const name = kind === 'map' ? 'sun-map' : kind === 'mapColumns' ? 'sun-map-columns' : kind === 'cards' ? 'sun-cards' : 'sun-columns';
    if (this.worker._useWebGpu) {
      const source = columns
        ? sunMapColumnsWgsl(shaders.shadowWgsl, SUN_MAP_COLUMNS, { heights })
        : sunMapWgsl(shaders.shadowWgsl, { heights });
      return { gpuProgram: sunShadowGpuProgram(GpuProgram, source, heights ? 'mainFragMap' : 'mainFrag', name, { maps: columns }) };
    }
    const vertex = columns
      ? sunMapColumnsVertex(shaders.shadowVert, SUN_MAP_COLUMNS, { heights })
      : sunMapVertex(shaders.shadowVert, { heights });
    const fragment = heights ? shaders.sunMapFrag : pickInstancedSpriteFragmentGlsl(true, shaders);
    return { glProgram: glProgramFrom(PIXI.GlProgram, vertex, fragment, name) };
  }

  /** DX-SHADOW3D: whether the layer shadows cast solids: the atlas has height maps (and the backend's shadow source). */
  sunSolidsOn() {
    return this.worker.assets.atlasMapsSource !== null && Boolean(this.worker._useWebGpu ? this.worker._engineShaders?.shadowWgsl : this.worker._engineShaders?.shadowVert);
  }

  /**
   * DX-SHADOW3D: the sun's layer shadows in a scene with height maps, as the light bench cast them: a frame with a height
   * map casts its solid (the columns of sunMapColumnsVertex, max blending, so overlapping columns are one shadow), every
   * other frame its card. Both read the committed full rows and the sun pass's own uniforms.
   */
  _drawSunSolids(batch, group) {
    if (this.sunSolids === null) {
      const r = batch.shadowShader.resources;
      // The cards read no twin page (uMaps): only the columns get it, with the footprints.
      const resources = () => ({ uTexture: r.uTexture, uSampler: r.uSampler, uTexLut: r.uTexLut, uniforms: group });
      const state = new PIXI.State();
      state.blend = true;
      state.blendMode = 'max';
      state.depthTest = false;
      state.depthMask = false;
      state.culling = false;
      this.sunSolids = {
        cards: new PIXI.Mesh({ geometry: batch.mesh.geometry, shader: new PIXI.Shader({ ...this.sunShadowProgram('cards'), resources: resources() }), state: batch.mesh.state, label: 'sun-cards' }),
        columns: {
          shader: new PIXI.Shader({
            ...this.sunShadowProgram('columns'),
            resources: {
              ...resources(),
              uMaps: this.worker.assets.atlasMapsSource ?? this.worker.lighting.emptyMapsSource(),
              uMapsLut: this.worker.assets.mapsTableSourceOrEmpty(),
              uFoot: this.worker.assets.footSourceOrEmpty(),
            },
          }),
          grid: new Buffer({ data: sunMapColumnGrid(), usage: BufferUsage.VERTEX }),
          index: sunMapColumnIndex(SUN_MAP_COLUMNS),
          state,
          rows: new Float32Array(64 * GPU_CASTER_FLOATS),
          blocks: new Float32Array(64 * 4),
          slots: [],
          ring: 0,
          label: 'sun-columns',
        },
      };
    }
    const cards = this.sunSolids.cards;
    cards.geometry = batch.mesh.geometry;
    this._drawGpuCasterPass(cards, group, true);
    // E-379: the rows that cast columns, as their own instances.
    const columns = this._columnsHost(batch, batch.mesh.geometry.instanceCount | 0, this.sunSolids.columns, 0);
    if (columns === null) return;
    const rtOpts = this.worker._rtRenderOpts;
    rtOpts.container = columns;
    rtOpts.target = this.worker.shadowRT;
    rtOpts.clear = false;
    this.worker._syncUniformGroup(group);
    this.worker._submitRender(rtOpts);
    this.worker._gpuPassesThisFrame++;
  }

  /** N-190: whether a sun-projected volumes' layer has a volume this frame (they cast into the maps without sprite rows). */
  _volumesCast() {
    for (let i = 0; i < this.worker.customLayers.list.length; i++) {
      const cl = this.worker.customLayers.list[i];
      const batch = cl.sunProjected ? cl.uvFillBatch : null;
      if (batch && (batch.geometry.instanceCount | 0) > 0) return true;
    }
    return false;
  }

  /** DX-SHADOW3D: the sun map's volumes' program as a Shader's options (GlProgram.from: one program for every layer). */
  sunMapVolumeProgram() {
    const shaders = this.worker._engineShaders;
    if (this.worker._useWebGpu) {
      return { gpuProgram: volumeMapGpuProgram(GpuProgram, volumeMapWgsl(shaders.meshUvFill), 'mainFragMap', 'sun-map-volumes') };
    }
    return {
      glProgram: PIXI.GlProgram.from({
        vertex: volumeMapVertex(shaders.meshUvFillVert),
        fragment: VOLUME_MAP_FRAGMENT,
        name: 'sun-map-volumes',
      }),
    };
  }

  _drawVolumesInSunMap(rtOpts, screenScale) {
    const shaders = this.worker._engineShaders;
    if (!(this.worker._useWebGpu ? shaders?.meshUvFill : shaders?.meshUvFillVert)) return;
    const t = this.sunMapTerms;
    const hs = this.worker._heightScaleY > 0 ? this.worker._heightScaleY : 1;
    const g = this.worker._groundScaleY || 1;
    for (let i = 0; i < this.worker.customLayers.list.length; i++) {
      const cl = this.worker.customLayers.list[i];
      const batch = cl.sunProjected ? cl.uvFillBatch : null;
      if (!batch || (batch.geometry.instanceCount | 0) <= 0) continue;
      let entry = null;
      for (let k = 0; k < this.volumeMapMeshes.length; k++) {
        if (this.volumeMapMeshes[k].batch === batch) entry = this.volumeMapMeshes[k];
      }
      if (entry === null) {
        const r = batch.shader.resources;
        const terms = new Float32Array(4);
        const shader = new PIXI.Shader({
          ...this.sunMapVolumeProgram(),
          resources: {
            uTexture: r.uTexture,
            uSampler: r.uSampler,
            uTexLut: r.uTexLut,
            uPoseTable: r.uPoseTable,
            sunShadow: { uSunShadow: { value: terms, type: 'vec4<f32>' } },
          },
        });
        const state = mapDepthState();
        const mesh = new PIXI.Mesh({ geometry: batch.geometry, shader, state, label: 'sun-map-volumes' });
        mesh.blendMode = 'none';
        const host = new PIXI.Container();
        host.addChild(mesh);
        entry = { batch, mesh, host, terms };
        this.volumeMapMeshes.push(entry);
      }
      if (entry.mesh.geometry !== batch.geometry) entry.mesh.geometry = batch.geometry;
      this._syncVolumeResources(entry.mesh.shader, batch);
      const v = entry.terms;
      // A vertex h screen px high is h / heightScaleY px of height: it lands (kx, ky) further per px of height, the
      // floor's y drawn groundScaleY tall.
      v[0] = -t[0] / hs;
      v[1] = (-t[1] * g) / hs;
      v[2] = 1;
      v[3] = 1 / hs;
      entry.mesh.shader.resources.sunShadow.update();
      rtOpts.container = entry.host;
      rtOpts.clear = false;
      rtOpts.transform = this._writeVolumeMapTransform(screenScale, this.sunMapCamX, this.sunMapCamY);
      this.worker._submitRender(rtOpts);
      rtOpts.transform = null;
      this.worker._gpuPassesThisFrame++;
    }
  }

  /**
   * DX-SHADOW3D: a volumes' map program's textures as its batch's are now (the atlas, the LUT and the pose table can be
   * replaced after the program was made).
   */
  _syncVolumeResources(shader, batch) {
    const r = batch.shader.resources;
    const res = shader.resources;
    if (res.uTexture !== r.uTexture) res.uTexture = r.uTexture;
    if (res.uSampler !== r.uSampler) res.uSampler = r.uSampler;
    if (res.uTexLut !== r.uTexLut) res.uTexLut = r.uTexLut;
    if (res.uPoseTable !== r.uPoseTable) res.uPoseTable = r.uPoseTable;
  }

  /** DX-SHADOW3D (F6): world px to the sun map's texels, (world - camera) · screenScale (sunMapVertex's uCam), no turn. */
  _writeVolumeMapTransform(screenScale, cameraX, cameraY) {
    const mx = this.volumeMapTransform;
    const z = screenScale > 0 ? screenScale : 1;
    const tx = -cameraX * z;
    const ty = -cameraY * z;
    if (mx.a !== z) mx.a = z;
    if (mx.b !== 0) mx.b = 0;
    if (mx.c !== 0) mx.c = 0;
    if (mx.d !== z) mx.d = z;
    if (mx.tx !== tx) mx.tx = tx;
    if (mx.ty !== ty) mx.ty = ty;
    return mx;
  }

  /**
   * DX-SHADOW3D (F7): this frame's lamps with a tile in the lamps' map, read before the light data is packed: pre-render's
   * stamp lights (the GPU queue's stampLightIds, a stamp row's stampLightIdx counts them), each one's tile its index. The
   * light pack tags their first row (_lampTileOf); the tiles' texture holds each lamp's floor point, height and reach
   * (lampShadowMap.js writeLampTile), which the map's programs read.
   */
  readLampTiles() {
    const gpu = this.worker._gpuQueueRead;
    const ids = gpu && gpu.stampLightIds ? gpu.stampLightIds : null;
    let n = ids && gpu.header ? Math.min(gpu.header[GPU_HDR_STAMP_LIGHTS] | 0, ids.length) : 0;
    // OL-5: pre-render names the casting lamps in a frame with no stamp row too. They take tiles then only when volumes
    // are there to draw into them: every pixel of a lamp reads its tile, and an empty one is read for nothing.
    if (n > 0 && (gpu.header[GPU_HDR_STAMP] | 0) <= 0 && !this._volumesCast()) n = 0;
    const entities = Transform.x ? Transform.x.length : 0;
    if (this.worker.lighting.lampTileOf.length !== entities) this.worker.lighting.lampTileOf = new Int16Array(entities).fill(-1);
    if (this.worker.lighting.lampFadeOf.length !== entities) this.worker.lighting.lampFadeOf = new Float32Array(entities).fill(1);
    const of = this.worker.lighting.lampTileOf;
    const fadeOf = this.worker.lighting.lampFadeOf;
    // N-212: pre-render's fades beside the ids (a queue without them: none fade).
    const fades = gpu && gpu.stampLightFade && gpu.stampLightFade.length >= n ? gpu.stampLightFade : null;
    const last = this.lampTileIds;
    for (let i = 0; i < this.lampTileCount; i++) {
      const id = last[i];
      if (id < of.length) {
        of[id] = -1;
        fadeOf[id] = 1;
      }
    }
    const cap = Math.max(1, ids ? ids.length : 1);
    if (this.lampTileIds.length < cap) this.lampTileIds = new Uint32Array(cap);
    if (this.lampTileData.length < cap * 4 * LAMP_TILE_ROWS) this.lampTileData = new Float32Array(cap * 4 * LAMP_TILE_ROWS);
    const data = this.lampTileData;
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
      this.lampTileIds[t] = id;
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
    this.lampMaxReach = maxReach;
    const stale = Math.max(n, this.lampTileCount);
    data.fill(0, n * 4, stale * 4);
    for (let t = n; t < stale; t++) writeLampTileOwner(data, width, t, -1);
    this.lampTileCount = n;
    this._uploadLampTiles();
  }

  /**
   * DX-SHADOW3D (F7): the tiles' texture (a texel a tile: its lamp in row 0, its owner in row 1), made on first use,
   * written each frame.
   */
  _uploadLampTiles() {
    const width = Math.max(1, this.lampTileData.length / (4 * LAMP_TILE_ROWS));
    if (this.lampTileSource === null || this.lampTileSource.width !== width) {
      const old = this.lampTileSource;
      this.lampTileSource = PIXI.TextureSource.from({
        resource: this.lampTileData,
        width,
        height: LAMP_TILE_ROWS,
        format: 'rgba32float',
        scaleMode: 'nearest',
        addressMode: 'clamp-to-edge',
        autoGenerateMipmaps: false,
      });
      this.lampTileSource.uploadMethodId = this.worker._useWebGpu ? 'external' : 'unknown';
      // Never unloaded by Pixi's texture GC while the programs keep it bound.
      this.lampTileSource.autoGarbageCollect = false;
      // Every program that binds it moves to the new one before the old one is destroyed.
      this._pointLampTilePrograms();
      if (old) old.destroy();
    }
    if (this.worker._useWebGpu) {
      const renderer = this.worker.pixiApp?.renderer;
      if (renderer?.gpu?.device) writeRgba32Float(renderer, this.lampTileSource, this.lampTileData, width, LAMP_TILE_ROWS, 'weed-lamp-tiles');
      return;
    }
    this.worker._uploadRgba32FloatGl(this.lampTileSource, this.lampTileData, width, LAMP_TILE_ROWS);
  }

  /**
   * DX-SHADOW3D (F7): every program that binds the tiles' lamps (uLampTiles) on the current source: the lamps' map's cards
   * and columns, and each volumes' layer's mesh.
   */
  _pointLampTilePrograms() {
    const source = this.lampTileSource;
    const shaders = [
      this.lampMapMesh && this.lampMapMesh.shader,
      this.lampMapMeshCeil && this.lampMapMeshCeil.shader,
      this.lampMapColumns && this.lampMapColumns.shader,
      this.lampMapColumns && this.lampMapColumns.shaderCeil,
    ];
    for (let i = 0; i < this.volumeLampEntries.length; i++) {
      shaders.push(this.volumeLampEntries[i].mesh.shader, this.volumeLampEntries[i].paintMesh.shader);
    }
    if (this.lampCacheCopy !== null) shaders.push(this.lampCacheCopy.mesh.shader);
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
  _ensureLampMap(gpu) {
    const most = Math.max(1, (gpu && gpu.caps && gpu.caps.maxStampLights) | 0);
    let lights = most;
    let size = this.worker._lampTileSize;
    if (this.worker._lampTileAuto) {
      // N-196: a tile for each lamp casting now, rounded up to a power of two (the map is made again only when that
      // count or the tile's size changes), each as fine as the widest lamp's reach and the shadows' resolution ask.
      lights = 1;
      while (lights < this.lampTileCount && lights < most) lights *= 2;
      if (lights > most) lights = most;
      // DX-PIXELSHADOW: with pixel-art lighting a texel a floor px (twice the resolution), so a lamp's shadow steps on the
      // art's pixels rather than on pairs of them, as far as the map's room allows.
      size = autoLampTileSize(this.lampMaxReach, this.worker.shadowResolution * (this.worker._pixelArtLight ? 2 : 1), lights);
    }
    if (this.worker.lighting.lampMapRT !== null && this.lampMapLights === lights && this.worker._lampTileSize === size) return true;
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
    this.lampMapLights = lights;
    this.lampTilesPerRow = layout.perRow;
    const a = this.worker.lighting.lampAtlas;
    a[0] = layout.perRow;
    a[1] = layout.size;
    a[2] = layout.width;
    a[3] = layout.height;
    this.lampMapClear = false;
    return true;
  }

  /**
   * DX-SHADOW3D (F7): a lamps' map program as a Shader's options: the cards (lampMapVertex: the casters facing their lamp)
   * or a render's columns (lampMapColumnsVertex), GLSL on WebGL and WGSL on WebGPU.
   * @param {boolean} columns
   */
  lampMapProgram(columns) {
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
  _drawLampMap(batch, gpu, stampN, keyedRows = false) {
    const shaders = this.worker._engineShaders;
    if (!(this.worker._useWebGpu ? shaders?.shadowWgsl : shaders?.shadowVert && shaders?.sunMapFrag)) return false;
    if (!gpu.stampLightIdx || !this._ensureLampMap(gpu)) return false;
    if (this.lampTileSource === null) this._uploadLampTiles();
    if (this.lampMapMesh === null) {
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
        ...this.lampMapProgram(false),
        resources: { uTexture: r.uTexture, uSampler: r.uSampler, uTexLut: r.uTexLut, uLampTiles: this.lampTileSource, uniforms },
      });
      const shader = cardShader(lampUniforms());
      const shaderCeil = cardShader(lampUniforms());
      this.lampMapUniforms = shader.resources.uniforms;
      this.lampMapUniformsCeil = shaderCeil.resources.uniforms;
      const state = mapDepthState();
      // DX-LAMPPANO: the cards on a strip of three rows (lampCardStrip) over the stamp rows' instance attributes.
      const strip = lampCardStrip();
      this.lampStripBuffer = new Buffer({ data: strip.vertices, usage: BufferUsage.VERTEX, label: 'lamp-card-strip' });
      this.lampStripIndex = strip.indices;
      this.lampStripGeometry = this._lampCardGeometry(batch);
      this.lampStripSource = batch.mesh.geometry;
      this.lampStripBySource.set(this.lampStripSource, this.lampStripGeometry);
      this.lampMapMesh = new PIXI.Mesh({ geometry: this.lampStripGeometry, shader, state, label: 'lamp-map' });
      this.lampMapMeshCeil = new PIXI.Mesh({ geometry: this.lampStripGeometry, shader: shaderCeil, state, label: 'lamp-map-ceiling' });
      // A depth test keeps the highest caster point and its entity; a mesh's blend mode holds only as a child (the sun
      // map's host says why). Both halves in one render: they write apart.
      this.lampMapMesh.blendMode = 'none';
      this.lampMapMeshCeil.blendMode = 'none';
      this.lampMapHost = new PIXI.Container();
      this.lampMapHost.addChild(this.lampMapMesh);
      this.lampMapHost.addChild(this.lampMapMeshCeil);
      const columnShader = (uniforms) => new PIXI.Shader({
        ...this.lampMapProgram(true),
        resources: {
          uTexture: r.uTexture,
          uSampler: r.uSampler,
          uTexLut: r.uTexLut,
          uMaps: this.worker.assets.atlasMapsSource ?? this.worker.lighting.emptyMapsSource(),
          uMapsLut: this.worker.assets.mapsTableSourceOrEmpty(),
          uFoot: this.worker.assets.footSourceOrEmpty(),
          uLampTiles: this.lampTileSource,
          uniforms,
        },
      });
      this.lampMapColumns = {
        shader: columnShader(this.lampMapUniforms),
        shaderCeil: columnShader(this.lampMapUniformsCeil),
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
    if (keyedRows) return this._drawLampMapKeyed(gpu, stampN);
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
    if (this.lampStripSource !== source) {
      // The batch draws from a ring of geometries, a slot each frame: a strip over each, made once. Made again whenever
      // the slot changed, it was a geometry a frame (96 KB/s of Pixi's garbage in Predator ?light3d=1). A batch that grew
      // makes new ones: past a few, the strips go and are made again.
      let strip = this.lampStripBySource.get(source);
      if (strip === undefined) {
        if (this.lampStripBySource.size >= LAMP_STRIP_SOURCES) {
          for (const g of this.lampStripBySource.values()) g.destroy();
          this.lampStripBySource.clear();
        }
        strip = this._lampCardGeometry(batch);
        this.lampStripBySource.set(source, strip);
      }
      this.lampStripGeometry = strip;
      this.lampStripSource = source;
      this.lampMapMesh.geometry = strip;
      this.lampMapMeshCeil.geometry = strip;
    }
    this.lampStripGeometry.instanceCount = keep;
    for (let half = 0; half < 2; half++) {
      const group = half === 0 ? this.lampMapUniforms : this.lampMapUniformsCeil;
      const u = group.uniforms;
      u.uTileWorld[0] = this.lampTilesPerRow;
      u.uTileWorld[1] = this.worker._lampTileSize;
      u.uTileWorld[2] = half;
      u.uSunK[3] = this.worker._heightScaleY > 0 ? this.worker._heightScaleY : 1;
      u.uGroundInvScaleY = this.worker._groundInvScaleY || 1;
      group.update();
    }
    const rtOpts = this.worker._rtRenderOpts;
    rtOpts.container = this.lampMapHost;
    rtOpts.target = this.worker.lighting.lampMapRT;
    rtOpts.clear = true;
    rtOpts.clearColor = this.worker._clearTransparent;
    this.worker._submitRender(rtOpts);
    this.worker._gpuPassesThisFrame++;
    // E-379: the rows that cast columns towards their lamp, as their own instances.
    const lampColumns = this.worker.assets.atlasMapsSource !== null ? this._columnsHost(batch, keep, this.lampMapColumns, 1) : null;
    if (lampColumns !== null) {
      rtOpts.container = lampColumns;
      rtOpts.clear = false;
      this.worker._submitRender(rtOpts);
      this.worker._gpuPassesThisFrame++;
    }
    this._drawVolumesInLampMap(rtOpts);
    rtOpts.target = this.worker.shadowRT;
    this.lampMapClear = false;
    return true;
  }

  /**
   * E-395: _drawLampMap for keyed stamp rows (WebGL): their light's z the tile + 1 (commitKeyedCasterRows), the cards'
   * strip over the caster batch's keyed ring geometry (one a ring slot, made once), the two halves' keyed programs
   * (lampMapVertex over spriteIndexedVertex's keyed stamp rows) sharing the full cards' uniform groups, then the volumes.
   * No columns: keyed rows are sent only while no render casts them (_ensureKeyedCasters).
   * @returns {boolean} whether it drew
   */
  _drawLampMapKeyed(gpu, stampN) {
    const shaders = this.worker._engineShaders;
    const entities = this.worker.entitiesBatch;
    const casters = this.worker.gpuCasterBatch;
    if (!entities || !entities.keyed || !casters) return false;
    if (this.lampMapKeyedMesh === null) {
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
        uLampTiles: this.lampTileSource,
        uniforms,
      });
      const shader = keyedShader(this.lampMapUniforms);
      const shaderCeil = keyedShader(this.lampMapUniformsCeil);
      if (shader === null || shaderCeil === null) return false;
      const state = mapDepthState();
      const geometry = this._lampKeyedStripFor(casters.keyedCasterGeometry(true));
      this.lampMapKeyedMesh = new PIXI.Mesh({ geometry, shader, state, label: 'lamp-map-keyed' });
      this.lampMapKeyedMeshCeil = new PIXI.Mesh({ geometry, shader: shaderCeil, state, label: 'lamp-map-keyed-ceiling' });
      this.lampMapKeyedMesh.blendMode = 'none';
      this.lampMapKeyedMeshCeil.blendMode = 'none';
      this.lampMapKeyedHost = new PIXI.Container();
      this.lampMapKeyedHost.addChild(this.lampMapKeyedMesh);
      this.lampMapKeyedHost.addChild(this.lampMapKeyedMeshCeil);
    }
    const rows = casters.commitKeyedCasterRows(gpu.stamp, stampN, GPU_KEYED_STAMP_FLOATS, gpu.stampLightIdx);
    if (rows === null) return false;
    const keep = rows.instanceCount | 0;
    const strip = this._lampKeyedStripFor(rows);
    strip.instanceCount = rows.instanceCount;
    this.lampMapKeyedMesh.geometry = strip;
    this.lampMapKeyedMeshCeil.geometry = strip;
    for (let half = 0; half < 2; half++) {
      const group = half === 0 ? this.lampMapUniforms : this.lampMapUniformsCeil;
      const u = group.uniforms;
      u.uTileWorld[0] = this.lampTilesPerRow;
      u.uTileWorld[1] = this.worker._lampTileSize;
      u.uTileWorld[2] = half;
      u.uSunK[3] = this.worker._heightScaleY > 0 ? this.worker._heightScaleY : 1;
      u.uGroundInvScaleY = this.worker._groundInvScaleY || 1;
      group.update();
    }
    const rtOpts = this.worker._rtRenderOpts;
    rtOpts.container = this.lampMapKeyedHost;
    rtOpts.target = this.worker.lighting.lampMapRT;
    rtOpts.clear = true;
    rtOpts.clearColor = this.worker._clearTransparent;
    this.worker._submitRender(rtOpts);
    this.worker._gpuPassesThisFrame++;
    // The keyed rows that cast columns towards their lamp, as their own instances (E-379's, over keyed rows).
    const lampColumns = this.worker.assets.atlasMapsSource !== null ? this._keyedColumnsHost(keep, this._keyedColumnsFor('lamp', casters), 1) : null;
    if (lampColumns !== null) {
      rtOpts.container = lampColumns;
      rtOpts.clear = false;
      this.worker._submitRender(rtOpts);
      this.worker._gpuPassesThisFrame++;
    }
    this._drawVolumesInLampMap(rtOpts);
    rtOpts.target = this.worker.shadowRT;
    this.lampMapClear = false;
    return true;
  }

  /** E-395: the lamps' cards' strip (lampCardStrip) over a keyed stamp rows' ring geometry, made once for each. */
  _lampKeyedStripFor(rows) {
    let strip = this.lampKeyedStrips.get(rows);
    if (strip === undefined) {
      const attributes = { aQuad: { buffer: this.lampStripBuffer, format: 'float32x2', stride: 8, offset: 0 } };
      for (const [name, a] of Object.entries(rows.attributes)) {
        if (name === 'aQuad') continue;
        attributes[name] = { buffer: a.buffer, format: a.format, stride: a.stride, offset: a.offset, instance: true };
      }
      strip = new PIXI.Geometry({ attributes, indexBuffer: this.lampStripIndex });
      this.lampKeyedStrips.set(rows, strip);
    }
    return strip;
  }

  /**
   * OL-5: the lamps' map in a frame whose lamps have tiles and no stamp row: cleared, and the volumes drawn into it as
   * _drawLampMap draws them after its cards. Without it a street of houses with nobody near its lamps cast no lamp
   * shadow at all: the map was drawn only in a frame with a sprite caster in some lamp's reach.
   * @returns {boolean} whether it drew
   */
  _drawLampMapVolumes(gpu) {
    if (!this._volumesCast() || !this._ensureLampMap(gpu)) return false;
    if (this.lampTileSource === null) this._uploadLampTiles();
    const rtOpts = this.worker._rtRenderOpts;
    rtOpts.container = this.worker._rtEmptyContainer;
    rtOpts.target = this.worker.lighting.lampMapRT;
    rtOpts.clear = true;
    rtOpts.clearColor = this.worker._clearTransparent;
    this.worker._submitRender(rtOpts);
    this.worker._gpuPassesThisFrame++;
    this._drawVolumesInLampMap(rtOpts);
    rtOpts.target = this.worker.shadowRT;
    this.lampMapClear = false;
    return true;
  }

  /**
   * DX-LAMPPANO: the cards' geometry: the strip (aQuad: lampCardStrip) per vertex, and the sprite batch's instance
   * attributes (this frame's stamp rows) per instance, as the columns' slots read them.
   */
  _lampCardGeometry(batch) {
    const attributes = { aQuad: { buffer: this.lampStripBuffer, format: 'float32x2', stride: 8, offset: 0 } };
    for (const [name, a] of Object.entries(batch.mesh.geometry.attributes)) {
      if (name === 'aQuad') continue;
      attributes[name] = { buffer: a.buffer, format: a.format, stride: a.stride, offset: a.offset, instance: true };
    }
    return new PIXI.Geometry({ attributes, indexBuffer: this.lampStripIndex });
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
   * once (_paintLampCache) and copied into its tile each frame (_copyLampCache), after the cards and the columns as the
   * volumes were; the others draw as before. The draws take their tiles from lists in the tiles' texture's row 2
   * (lampVolumeCache.js), written here, after the map's layout is this frame's, and sent again.
   */
  _drawVolumesInLampMap(rtOpts) {
    const shaders = this.worker._engineShaders;
    const tiles = this.lampTileCount | 0;
    if (tiles <= 0 || this.lampTileSource === null) return;
    if (!(this.worker._useWebGpu ? shaders?.meshUvFill : shaders?.meshUvFillVert)) return;
    VOLUME_LAMP_SCALES[0] = 1 / (this.worker._heightScaleY > 0 ? this.worker._heightScaleY : 1);
    VOLUME_LAMP_SCALES[1] = this.worker._groundInvScaleY || 1;
    // This frame's volumes' layers, in order; E-508: whether they, their records or their scales moved (the epoch).
    const active = this.volumeLampActive;
    let count = 0;
    let indices = 0;
    let moved = false;
    for (let i = 0; i < this.worker.customLayers.list.length; i++) {
      const cl = this.worker.customLayers.list[i];
      const batch = cl.sunProjected ? cl.uvFillBatch : null;
      // instanceCount 1: the batch has triangles (MeshUvFillBatch.upload).
      if (batch === null || (batch.geometry.instanceCount | 0) <= 0) continue;
      let entry = null;
      for (let k = 0; k < this.volumeLampEntries.length; k++) {
        if (this.volumeLampEntries[k].batch === batch) entry = this.volumeLampEntries[k];
      }
      if (entry === null) {
        entry = this._volumeLampEntry(batch);
        this.volumeLampEntries.push(entry);
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
    if (count !== this.volumeLampActiveCount) {
      this.volumeLampActiveCount = count;
      moved = true;
    }
    if (count === 0) return;
    const scales = this.lampVolumeScales;
    if (scales[0] !== VOLUME_LAMP_SCALES[0] || scales[1] !== VOLUME_LAMP_SCALES[1]) {
      scales[0] = VOLUME_LAMP_SCALES[0];
      scales[1] = VOLUME_LAMP_SCALES[1];
      moved = true;
    }
    if (moved) this.lampVolumesEpoch = (this.lampVolumesEpoch + 1) | 0;
    const data = this.lampTileData;
    const width = data.length / (4 * LAMP_TILE_ROWS);
    const perRow = this.lampTilesPerRow;
    let direct = tiles;
    let cached = 0;
    let paint = false;
    // E-508: only volumes heavy enough for their lamps' tiles (lampCachePays): a copy writes every texel of the half.
    const pays = lampCachePays(indices, this.worker._lampTileSize);
    if (this.worker._lampCacheOn && pays && this._ensureLampCache(this.lampMapLights | 0, this.worker._lampTileSize)) {
      const plan = planLampVolumeCache(
        this.lampCache, this.lampTileIds, data, width, tiles, perRow, this.lampCacheSlots, this.lampCachePerRow,
        this.lampVolumesEpoch,
      );
      direct = plan.direct;
      cached = plan.cached;
      paint = plan.paint;
    } else {
      writeDirectLampList(data, width, tiles, perRow);
    }
    this._uploadLampTiles();
    rtOpts.clear = false;
    if (direct > 0) {
      for (let k = 0; k < count; k++) {
        const entry = active[k];
        this._drawVolumeLampMesh(entry.batch, entry.mesh, entry.host, entry.geometry, direct, 0, rtOpts);
      }
    }
    if (paint) this._paintLampCache(active, count, cached, direct, rtOpts);
    if (cached > 0) this._copyLampCache(cached, direct, rtOpts);
  }

  /** One volumes' mesh into the target in rtOpts: `instances` entries of the draws' list from `listStart`. */
  _drawVolumeLampMesh(batch, mesh, host, geometry, instances, listStart, rtOpts) {
    geometry.instanceCount = instances;
    if (mesh.geometry !== geometry) mesh.geometry = geometry;
    this._syncVolumeResources(mesh.shader, batch);
    const group = mesh.shader.resources.sunShadow;
    const u = group.uniforms;
    if (writeVolumeLampTerms(u.uSunShadow, u.uLampVolume, listStart, this.lampTilesPerRow, this.worker._lampTileSize, VOLUME_LAMP_SCALES)) {
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
  _paintLampCache(active, count, cached, listStart, rtOpts) {
    const map = rtOpts.target;
    rtOpts.target = this.lampCacheTarget;
    for (let k = 0; k < count; k++) {
      const entry = active[k];
      rtOpts.clear = k === 0;
      this._drawVolumeLampMesh(entry.batch, entry.paintMesh, entry.paintHost, entry.paintGeometry, cached, listStart, rtOpts);
    }
    rtOpts.clear = false;
    rtOpts.target = map;
  }

  /**
   * E-508: the cached lamps' slots copied into their tiles (`cached` entries of the list from `listStart`), each texel a
   * volume drew with the depth it drew at, so the map's depth test keeps what drawing the volumes there would have.
   */
  _copyLampCache(cached, listStart, rtOpts) {
    const copy = this._lampCacheCopyMesh();
    copy.geometry.instanceCount = cached;
    const v = copy.group.uniforms.uLampVolume;
    if (v[0] !== listStart || v[1] !== this.lampTilesPerRow || v[2] !== this.worker._lampTileSize) {
      v[0] = listStart;
      v[1] = this.lampTilesPerRow;
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
  _ensureLampCache(slots, size) {
    if (this.lampCacheTarget !== null && this.lampCacheSlots === slots && this.lampCacheSize === size) return true;
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
    const oldColor = this.lampCacheColor;
    const oldDepth = this.lampCacheDepth;
    this._releaseLampCacheTarget();
    this.lampCacheTarget = target;
    this.lampCacheColor = color;
    this.lampCacheDepth = depth;
    // The copy lets go of the old textures before they go (Pixi warns of a source destroyed while bound).
    if (this.lampCacheCopy !== null) {
      const res = this.lampCacheCopy.mesh.shader.resources;
      res.uCacheColor = color.source;
      res.uCacheDepth = depth.source;
    }
    if (oldColor) oldColor.destroy(true);
    if (oldDepth) oldDepth.destroy(true);
    this.lampCacheSlots = slots;
    this.lampCacheSize = size;
    this.lampCachePerRow = layout.perRow;
    this.lampVolumesEpoch = (this.lampVolumesEpoch + 1) | 0;
    return true;
  }

  /** E-508: the cache's target's GPU side, through the render target system's records (_releaseGbufTarget says why). */
  _releaseLampCacheTarget() {
    const target = this.lampCacheTarget;
    if (target === null) return;
    this.lampCacheTarget = null;
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
  lampCacheCopyProgram() {
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
  _lampCacheCopyMesh() {
    if (this.lampCacheCopy !== null) return this.lampCacheCopy;
    const program = this.lampCacheCopyProgram();
    const quad = new Buffer({ data: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), usage: BufferUsage.VERTEX, label: 'lamp-cache-quad' });
    const geometry = new PIXI.Geometry({
      attributes: { aPosition: { buffer: quad, format: 'float32x2', stride: 8, offset: 0 } },
      indexBuffer: new Uint16Array([0, 1, 2, 0, 2, 3]),
    });
    geometry.instanceCount = 0;
    const shader = new PIXI.Shader({
      ...program,
      resources: {
        uLampTiles: this.lampTileSource,
        uCacheColor: this.lampCacheColor.source,
        uCacheDepth: this.lampCacheDepth.source,
        lampCopy: { uLampVolume: { value: new Float32Array(4), type: 'vec4<f32>' } },
      },
    });
    const mesh = new PIXI.Mesh({ geometry, shader, state: mapDepthState(), label: 'lamp-map-volume-copy' });
    mesh.blendMode = 'none';
    const host = new PIXI.Container();
    host.addChild(mesh);
    this.lampCacheCopy = { mesh, host, geometry, group: shader.resources.lampCopy };
    return this.lampCacheCopy;
  }

  /**
   * E-389, E-453: the lamps' map volumes' geometry: the batch's vertex attributes and its index buffer (the same buffers:
   * what the batch's last upload sent), drawn with an instance an entry of the draw's list (E-508). Two a batch, the
   * direct draw's and the cache's paint's: the frame sets each one's instanceCount.
   */
  _volumeLampGeometry(batch) {
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
   * uLampVolume, the WGSL struct's order), in its own host, over its geometry (_volumeLampGeometry). E-508: and its twin
   * for the cache's paint (its program writes two colours), and the batch's version the cache last saw.
   */
  _volumeLampEntry(batch) {
    const host = new PIXI.Container();
    const geometry = this._volumeLampGeometry(batch);
    const paintHost = new PIXI.Container();
    const paintGeometry = this._volumeLampGeometry(batch);
    return {
      batch,
      host,
      mesh: this._volumeLampMesh(batch, host, geometry, false),
      geometry,
      paintHost,
      paintMesh: this._volumeLampMesh(batch, paintHost, paintGeometry, true),
      paintGeometry,
      version: -1,
    };
  }

  /**
   * DX-SHADOW3D (F7): the mesh over a volumes' batch in the lamps' map, with its terms, in `host`; E-508: `cache`, the
   * cache's paint's (two colours). The programs and state are made once.
   */
  _volumeLampMesh(batch, host, geometry, cache) {
    this.makeVolumeLampPrograms();
    const r = batch.shader.resources;
    const shader = new PIXI.Shader({
      ...(cache ? this.volumeLampCacheProgram : this.volumeLampProgram),
      resources: {
        uTexture: r.uTexture,
        uSampler: r.uSampler,
        uTexLut: r.uTexLut,
        uPoseTable: r.uPoseTable,
        uLampTiles: this.lampTileSource,
        // No tile in use until the frame writes this mesh's terms (writeVolumeLampTerms).
        sunShadow: {
          uSunShadow: { value: new Float32Array(4), type: 'vec4<f32>' },
          uLampVolume: { value: new Float32Array(4), type: 'vec4<f32>' },
        },
      },
    });
    const label = cache ? 'lamp-map-volume-cache' : 'lamp-map-volumes';
    const mesh = new PIXI.Mesh({ geometry, shader, state: this.volumeLampState, label });
    // A depth test keeps the highest point and its entity; a mesh's blend mode holds only as a child (the sun map's host
    // says why).
    mesh.blendMode = 'none';
    host.addChild(mesh);
    return mesh;
  }

  /** DX-SHADOW3D (F7), E-508: the lamps' map volumes' programs (direct, and the cache's paint) and their state, made once. */
  makeVolumeLampPrograms() {
    if (this.volumeLampProgram === null) {
      const shaders = this.worker._engineShaders;
      this.volumeLampProgram = this.worker._useWebGpu
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
      this.volumeLampCacheProgram = this.worker._useWebGpu
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
      this.volumeLampState = mapDepthState();
    }
  }

  /** DX-SHADOW3D (F7): a frame with no stamp rows clears the lamps' map (once). */
  _clearLampMapIfEmpty() {
    if (!this.worker.lighting.lampMapRT || this.lampMapClear === true) return;
    const rtOpts = this.worker._rtRenderOpts;
    rtOpts.container = this.worker._rtEmptyContainer;
    rtOpts.target = this.worker.lighting.lampMapRT;
    rtOpts.clear = true;
    rtOpts.clearColor = this.worker._clearTransparent;
    this.worker._submitRender(rtOpts);
    rtOpts.target = this.worker.shadowRT;
    this.lampMapClear = true;
  }

  /**
   * E-395: a columns pass over keyed caster rows (`kind` 'sun': the sun's map, 'lamp': the lamps' map), made on first use
   * and kept: the columns programs composed over spriteIndexed's keyed rows (statics by key) on either backend, the full
   * columns' resources and uniform groups, grid and state, and the caster batch's keyed geometry as the rows' layout.
   * Null where the entity batch keeps no keyed frames or the full pass is not made yet.
   */
  _keyedColumnsFor(kind, batch) {
    const key = kind === 'sun' ? 'sunMapKeyedColumns' : 'lampMapKeyedColumns';
    if (this[key] !== null) return this[key];
    const full = kind === 'sun' ? this.sunMapColumns : this.lampMapColumns;
    const entities = this.worker.entitiesBatch;
    const shaders = this.worker._engineShaders;
    if (!full || !entities || !entities.keyed) return null;
    const lamp = kind === 'lamp';
    const name = lamp ? 'lamp-map-columns-keyed' : 'sun-map-columns-keyed';
    let program;
    if (this.worker._useWebGpu) {
      if (!shaders?.shadowWgsl) return null;
      const keyed = spriteIndexedWgsl(shaders.shadowWgsl, { shadow: true, casterRows: true, light: lamp });
      const source = lamp ? lampMapColumnsWgsl(keyed) : sunMapColumnsWgsl(keyed, SUN_MAP_COLUMNS, { heights: true });
      program = { gpuProgram: sunShadowGpuProgram(GpuProgram, source, lamp ? 'mainFragLamp' : 'mainFragMap', name, { maps: true, lampTiles: lamp, statics: true }) };
    } else {
      if (!shaders?.shadowVert || !shaders?.sunMapFrag) return null;
      const keyed = spriteIndexedVertex(shaders.shadowVert, { shadow: true, casterRows: true, light: lamp });
      const vertex = lamp ? lampMapColumnsVertex(keyed) : sunMapColumnsVertex(keyed, SUN_MAP_COLUMNS, { heights: true });
      program = { glProgram: glProgramFrom(PIXI.GlProgram, vertex, lamp ? lampMapFragment(shaders.sunMapFrag) : shaders.sunMapFrag, name) };
    }
    const r = batch.shadowShader.resources;
    const resources = (uniforms) => ({
      uTexture: r.uTexture,
      uSampler: r.uSampler,
      uTexLut: r.uTexLut,
      uMaps: this.worker.assets.atlasMapsSource ?? this.worker.lighting.emptyMapsSource(),
      uMapsLut: this.worker.assets.mapsTableSourceOrEmpty(),
      uFoot: this.worker.assets.footSourceOrEmpty(),
      ...(lamp ? { uLampTiles: this.lampTileSource } : {}),
      uniforms,
    });
    const shader = entities.makeKeyedRowsShader(program, resources(lamp ? this.lampMapUniforms : this.sunMapUniforms));
    const shaderCeil = lamp ? entities.makeKeyedRowsShader(program, resources(this.lampMapUniformsCeil)) : null;
    if (shader === null || (lamp && shaderCeil === null)) return null;
    const floats = lamp ? GPU_KEYED_STAMP_FLOATS : GPU_KEYED_CASTER_FLOATS;
    this[key] = {
      shader,
      ...(lamp ? { shaderCeil } : {}),
      grid: full.grid,
      index: full.index,
      state: full.state,
      blendMode: 'none',
      rows: new Float32Array(64 * floats),
      blocks: new Float32Array(64 * 4),
      slots: [],
      ring: 0,
      label: name,
      floats,
      layout: this.worker.gpuCasterBatch.keyedCasterGeometry(lamp),
    };
    return this[key];
  }

  /**
   * E-395: _columnsHost over this frame's keyed rows (in the caster batch's data, committed by commitKeyedCasterRows): the
   * rows whose frame casts columns, picked with the entity batch's copy of the slots' statics (compactKeyedColumnRows).
   */
  _keyedColumnsHost(rows, columns, light) {
    const lut = this.worker.assets.texLut;
    const statics = this.worker.entitiesBatch ? this.worker.entitiesBatch.staticsMirror : null;
    const src = this.worker.gpuCasterBatch ? this.worker.gpuCasterBatch.data : null;
    if (columns === null || !lut || !statics || !src || rows <= 0) return null;
    const F = columns.floats;
    let n = compactKeyedColumnRows(src, rows, F, statics, lut, TEX_LUT_FLOATS, light, columns.rows, columns.blocks);
    if (n > columns.blocks.length / 4) {
      let cap = Math.max(64, columns.blocks.length / 4);
      while (cap < n) cap *= 2;
      columns.rows = new Float32Array(cap * F);
      columns.blocks = new Float32Array(cap * 4);
      for (const slot of columns.slots) slot.dispose();
      columns.slots = [];
      n = compactKeyedColumnRows(src, rows, F, statics, lut, TEX_LUT_FLOATS, light, columns.rows, columns.blocks);
    }
    if (n <= 0) return null;
    if (columns.slots.length === 0) {
      for (let k = 0; k < 2; k++) columns.slots.push(this._columnsSlot(this.worker.gpuCasterBatch, columns, k));
    }
    const slot = columns.slots[columns.ring];
    columns.ring ^= 1;
    slot.rowBuffer.update(n * F * 4);
    slot.blockBuffer.update(n * 16);
    slot.mesh.geometry.instanceCount = n;
    return slot.host;
  }

  /**
   * E-379: a columns pass's container over its own instances: of the batch's first `rows` caster rows, the ones that cast
   * columns for `light` (0 the sun, 1 the lamps), a large render as blocks of the grid (sunShadowMap.js
   * compactColumnRows). The programs ran their grid for every caster row and threw away the rows that cast none (2 000
   * cards beside 20 renders: 5.1 ms of the sun map's columns against 0.1). The instances go up into two ring slots, as the
   * batch's do; null when no row casts columns.
   */
  _columnsHost(batch, rows, columns, light) {
    const lut = this.worker.assets.texLut;
    const src = batch.data;
    if (!lut || !src || rows <= 0) return null;
    const F = GPU_CASTER_FLOATS;
    let n = compactColumnRows(src, rows, F, lut, TEX_LUT_FLOATS, light, columns.rows, columns.blocks);
    if (n > columns.blocks.length / 4) {
      let cap = Math.max(64, columns.blocks.length / 4);
      while (cap < n) cap *= 2;
      columns.rows = new Float32Array(cap * F);
      columns.blocks = new Float32Array(cap * 4);
      for (const slot of columns.slots) slot.dispose();
      columns.slots = [];
      n = compactColumnRows(src, rows, F, lut, TEX_LUT_FLOATS, light, columns.rows, columns.blocks);
    }
    if (n <= 0) return null;
    if (columns.slots.length === 0) {
      for (let k = 0; k < 2; k++) columns.slots.push(this._columnsSlot(batch, columns, k));
    }
    const slot = columns.slots[columns.ring];
    columns.ring ^= 1;
    slot.rowBuffer.update(n * F * 4);
    slot.blockBuffer.update(n * 16);
    slot.mesh.geometry.instanceCount = n;
    return slot.host;
  }

  /**
   * E-379: one ring slot of a columns pass: buffers over the pass's instance arrays (the batch's row layout, and aBlock)
   * and the mesh over them and the grid.
   */
  _columnsSlot(batch, columns, k) {
    const usage = BufferUsage.VERTEX | BufferUsage.COPY_DST;
    const rowBuffer = new Buffer({ data: columns.rows, usage, label: `${columns.label}-rows-${k}` });
    const blockBuffer = new Buffer({ data: columns.blocks, usage, label: `${columns.label}-blocks-${k}` });
    const attributes = {
      aCell: { buffer: columns.grid, format: 'float32x4', stride: 16, offset: 0 },
      aBlock: { buffer: blockBuffer, format: 'float32x4', stride: 16, offset: 0, instance: true },
    };
    // E-395: the rows' layout is the batch's own, or the keyed rows' (a keyed columns pass names it).
    for (const [name, a] of Object.entries((columns.layout || batch.mesh.geometry).attributes)) {
      if (name === 'aQuad') continue;
      attributes[name] = { buffer: rowBuffer, format: a.format, stride: a.stride, offset: a.offset, instance: true };
    }
    const geometry = new PIXI.Geometry({ attributes, indexBuffer: columns.index });
    const mesh = new PIXI.Mesh({ geometry, shader: columns.shader, state: columns.state, label: columns.label });
    // Max blending (the layer shadows' solids), so overlapping columns are one shadow; the maps' columns keep their
    // highest by a depth test instead (columns.blendMode 'none'). A mesh's own blend mode holds only as a child.
    mesh.blendMode = columns.blendMode || 'max';
    const host = new PIXI.Container();
    host.addChild(mesh);
    // DX-LAMPPANO: the lamps' columns into the ceiling's half too, the same rows in the same render.
    if (columns.shaderCeil) {
      const ceil = new PIXI.Mesh({ geometry, shader: columns.shaderCeil, state: columns.state, label: `${columns.label}-ceiling` });
      ceil.blendMode = columns.blendMode || 'max';
      host.addChild(ceil);
    }
    return {
      rowBuffer,
      blockBuffer,
      mesh,
      host,
      dispose() {
        host.destroy({ children: true });
        geometry.destroy();
        rowBuffer.destroy();
        blockBuffer.destroy();
      },
    };
  }

  /**
   * DX-SHADOW3D: every program that binds the footprints (uFoot) on the current source: the layer shadows' columns, the
   * sun map's and the lamps' map's (their layouts name binding 7 whether or not their WGSL reads it).
   */
  pointFootPrograms() {
    const source = this.worker.assets.footSource;
    const holders = [this.sunSolids && this.sunSolids.columns, this.sunMapColumns, this.lampMapColumns];
    for (let i = 0; i < holders.length; i++) {
      const c = holders[i];
      if (c && c.shader && c.shader.resources.uFoot !== source) c.shader.resources.uFoot = source;
      if (c && c.shaderCeil && c.shaderCeil.resources.uFoot !== source) c.shaderCeil.resources.uFoot = source;
    }
  }

  /** E-496: every program that binds the maps table (uMapsLut) on the current source: the columns', the entities'. */
  pointMapsTablePrograms() {
    const source = this.worker.assets.mapsTableSource;
    const holders = [this.sunSolids && this.sunSolids.columns, this.sunMapColumns, this.lampMapColumns];
    for (let i = 0; i < holders.length; i++) {
      const c = holders[i];
      if (c && c.shader && c.shader.resources.uMapsLut !== undefined) c.shader.resources.uMapsLut = source;
      if (c && c.shaderCeil && c.shaderCeil.resources.uMapsLut !== undefined) c.shaderCeil.resources.uMapsLut = source;
    }
    if (this.worker.entitiesBatch) this.worker.entitiesBatch.setMapsTable(source);
  }
}
