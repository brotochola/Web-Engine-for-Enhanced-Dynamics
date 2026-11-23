/**
 * N-256 PW-8: the renderer's 3D shadow maps, moved out of pixiWorker.js as they were (DX-SHADOW3D and after), the one way
 * shadows are drawn (E-531). The sun's map, its keyed rows, the volumes drawn into it and the solids' columns; the
 * lamps' map (lampMap.js), its tiles, keyed strips, card and volume programs and the still lamps' cache (E-508); the GPU
 * casters' batch whose rows both draw (DX-GPUSHADOWS), keyed or not. The light pass binds the maps' targets, which stay
 * the worker's with the lighting state (sunMapRT, lampMapRT, the tile size and fades).
 *
 * Until the renderer's other subsystems move (N-256), what this class reads of the worker (its renderer, backend,
 * camera, config, lighting state, batches, queues, shaders, assets and custom layers) goes through `this.worker`.
 */

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
  State,
} from '../../vendor/pixi.min.js';
import {
  GPU_CASTER_FLOATS,
  GPU_FLAG_KEYED_CASTERS,
  GPU_HDR_FLAGS,
  GPU_HDR_STAMP,
  GPU_HDR_SUN,
  GPU_KEYED_CASTER_FLOATS,
  GPU_KEYED_STAMP_FLOATS,
} from '../gpuQueueLayout.js';
import { rtPixelSize } from '../gpuShadowCasters.js';
import { InstancedSpriteBatch, TEX_LUT_FLOATS } from '../instancedSpriteBatch.js';
import { lampMapColumnsVertex, lampMapColumnsWgsl, lampMapFragment } from '../lampShadowMap.js';
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
import { volumeMapGpuProgram, volumeMapWgsl } from '../volumeShadowMap.js';
import { glProgramFrom } from '../webgl/glProgram.js';
import { sunShadowGpuProgram } from '../webgpu/instancedSpriteWgsl.js';

// The Pixi classes the moved bodies name as PIXI.X, as pixiWorker.js's namespace does.
const PIXI = Object.freeze({ Container, Geometry, GlProgram, Mesh, RenderTexture, Shader });

/**
 * DX-GBUF: the shadow maps' programs' state (sunShadowMap.frag.glsl): no blending, a depth test (less) and its writes, so
 * each texel keeps its highest caster point, whose depth is 1 - height / ZMAX, with that caster's entity id.
 */
export function mapDepthState() {
  const state = new State();
  state.blendMode = 'none';
  state.depthTest = true;
  state.depthMask = true;
  state.culling = false;
  return state;
}

/** The sun's and the lamps' shadow maps and the casters' passes, for one renderer worker. */
export class PixiShadowMaps {
  /** @param {object} worker the PixiRenderer that owns this (its renderer, camera, lighting state and batches) */
  constructor(worker) {
    this.worker = worker;
    // E-191 step 2: whether the maps' use of pre-render's keyed caster rows was settled (_ensureKeyedCasters).
    this.keyedCastersTried = false;
    // DX-SHADOW3D (F6): the volumes' map programs, one a volumes' batch (made on first use).
    this.volumeMapMeshes = [];
    // World px to the sun map's texels, (world - camera) · screenScale as its cards land, for the volumes (written when
    // it changes: a Matrix's fields are tagged, each double written a heap number).
    this.volumeMapTransform = new Matrix();
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
  }

  /**
   * E-531: the shadows' state, made once with shadows on: lighting's shadow keys and the casters' batch, whose geometries
   * the sun's and the lamps' maps draw (pre-render's sun and stamp rows, full or keyed).
   */
  create() {
    const lightingConfig = this.worker.config.lighting || {};
    this.worker.shadowResolution = lightingConfig.shadowResolution ?? LIGHTING_DEFAULTS.shadowResolution;
    this.shadowUpdateInterval = lightingConfig.shadowUpdateInterval ?? LIGHTING_DEFAULTS.shadowUpdateInterval ?? 1;
    this.shadowUpdateTick = 0;
    if (lightingConfig.maxLights !== undefined) this.worker.maxLights = lightingConfig.maxLights;
    if (lightingConfig.maxShadowCastingLights !== undefined) {
      this.worker.maxShadowCastingLights = lightingConfig.maxShadowCastingLights;
    }

    const gpuCaps = this.worker.gpuQueueBuffers && this.worker.gpuQueueBuffers[0] ? this.worker.gpuQueueBuffers[0].caps : null;
    const casterCap = gpuCaps
      ? Math.max(1, gpuCaps.maxSun | 0, gpuCaps.maxStamp | 0)
      : Math.max(1, this.worker.renderQueueMaxItems | 0);
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
      this.worker._leaveOutOfLinksAhead(this.worker.gpuCasterBatch.shader, [this.worker.entitiesBatch?.shader, this.worker.entitiesGlowBatch?.shader]);
    }
    debugWorkerLog(`PIXI WORKER: shadow maps' casters (${casterCap})`);
  }

  /** The screen's size in the sun map's texels before N-317's margins: the canvas at lighting.shadowResolution. */
  viewWidth() {
    return rtPixelSize(this.worker.canvasWidth, this.worker.shadowResolution);
  }

  viewHeight() {
    return rtPixelSize(this.worker.canvasHeight, this.worker.shadowResolution);
  }

  /**
   * A frame's shadows: the sun's and the lamps' maps drawn from pre-render's rows (every lighting.shadowUpdateInterval
   * frames), or cleared once while the casted-shadows layer is hidden.
   */
  update() {
    if (!this.worker.shadowsEnabled) return;
    if (!layerIsVisible(Layer.castedShadows?.id)) {
      this._clearShadowMapsWhileHidden();
      return;
    }
    const interval = this.shadowUpdateInterval | 0;
    const skip = interval > 1 && (this.shadowUpdateTick % interval) !== 0;
    this.shadowUpdateTick++;
    if (!skip) this._drawMaps();
  }

  /**
   * DBG-1: the casted-shadows layer hidden means no shadows. The light pass samples the sun's and the lamps' maps, and
   * only the shadow pass draws or clears them: left alone they would stand on screen, frozen. They are cleared once, and
   * the tick restarts so the first frame shown again draws them whatever shadowUpdateInterval is.
   */
  _clearShadowMapsWhileHidden() {
    this.shadowUpdateTick = 0;
    if (this.worker._sunMapOn) {
      this.sunMapDrew = false;
      this._clearSunMapIfEmpty();
    }
    if (this.worker._lampMapOn) {
      this.worker.lampMap.mapDrew = false;
      this.worker.lampMap.clearIfEmpty();
    }
  }

  /** The sun's rows into its map, the stamps' into the lamps' tiles, the volumes into both. */
  _drawMaps() {
    this.worker._gpuPassesThisFrame = 0;
    this.worker._gpuCastersThisFrame = 0;
    this.worker._gpuShadowLightsThisFrame = 0;
    const batch = this.worker.gpuCasterBatch;
    const mesh = batch && batch.mesh;
    const shader = batch && batch.shadowShader;
    if (!shader || !mesh) return;

    this._ensureKeyedCasters();
    const gpu = this.worker._gpuQueueRead;
    // DBG-1: the sun and stamp rows are the entities' (pre-render takes them from the render queue), so a hidden entities
    // layer casts nothing. Volumes cast on their own.
    const castersShown = !!(gpu && gpu.header) && layerIsVisible(Layer.entitiesId);
    const sunN = castersShown ? (gpu.header[GPU_HDR_SUN] | 0) : 0;
    const stampN = castersShown ? (gpu.header[GPU_HDR_STAMP] | 0) : 0;
    // E-191 step 2: pre-render's sun and stamp rows are keyed caster rows (a pose, a key, the shadow terms; a stamp's
    // light) when it found Pixi's statics recent.
    const keyedRows = gpu && gpu.header ? ((gpu.header[GPU_HDR_FLAGS] | 0) & GPU_FLAG_KEYED_CASTERS) !== 0 : false;
    this.worker._gpuCastersThisFrame = sunN;

    const screenScale = (this.worker._renderZoom || 1) * this.worker.lighting.shadowPixelScale();
    const sunOn = Sun.isInitialized && Sun.enabled && Sun.intensity > 0.1 && Sun.shadowOpacity > 0;
    batch.setTargetSpace(false, 0, 0, 1);
    this.sunMapDrew = false;
    if (this.worker._sunMapOn) {
      if (sunOn && (sunN > 0 || this._volumesCast()) && this._drawSunMap(batch, gpu, sunN, screenScale, keyedRows)) {
        this.sunMapDrew = true;
      }
      this._clearSunMapIfEmpty();
    }

    const lampMap = this.worker.lampMap;
    lampMap.mapDrew = false;
    if (this.worker._lampMapOn) {
      if (stampN > 0) {
        // DX-SHADOW3D (F7): each lamp's casters into its tile of the lamps' map; the light pass takes each lamp out alone.
        // E-395: keyed stamp rows too.
        lampMap.mapDrew = lampMap.draw(batch, gpu, stampN, keyedRows);
      } else if ((lampMap.tileCount | 0) > 0) {
        // OL-5: lamps with tiles and no stamp row (no sprite caster in any lamp's reach): the volumes alone.
        lampMap.mapDrew = lampMap.drawVolumes(gpu);
      }
      if (!lampMap.mapDrew) lampMap.clearIfEmpty();
      this.worker._gpuShadowLightsThisFrame = lampMap.tileCount | 0;
    }
  }

  /**
   * E-191 step 2: once, whether the maps draw pre-render's keyed caster rows. With the entity batch's keyed frames (and,
   * where the atlas has height maps, its copy of the slots' statics, which the columns over keyed rows pick their rows
   * by: enableStaticsMirror), the entity batch's keyed uploads tell pre-render (its header's LIVE word), which then
   * writes such rows; the maps' keyed programs (_drawSunMap, lampMap.js draw) read them.
   */
  _ensureKeyedCasters() {
    if (this.keyedCastersTried) return;
    this.keyedCastersTried = true;
    const b = this.worker.entitiesBatch;
    const casters = this.worker.gpuCasterBatch;
    if (!b || !b.keyed || !casters || !casters.mesh) return;
    if (this.worker.assets.atlasMapsSource !== null && !b.enableStaticsMirror()) return;
    b.keyedCasters = true;
  }

  /**
   * N-317: the sun map reaches past the screen by the margins this frame's sun needs (sunMapMargins: the atlas's
   * tallest frame, at most SUN_MAP_ZMAX px of height, landing by the sun's terms), so a pixel near the screen's edge finds
   * its ray's landing in it. The map is made again only when a margin needs more than it has, or has more than twice what
   * it needs and 64 texels besides (each made with a quarter more, rounded up to 16 texels). Sets the camera its passes
   * draw from (moved by the top-left margins) and the light pass's uSunMapRect (the screen's uv into the map).
   */
  _fitSunMap(screenScale) {
    const w = this.viewWidth();
    const h = this.viewHeight();
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

  /** DX-SHADOW3D: the sun's shadow map, the screen at lighting.shadowResolution and N-317's margins, bound to the light pass. */
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
    if (!(this.worker._useWebGpu ? shaders?.shadowWgsl : shaders?.shadowVert && shaders?.sunMapFrag)) return false;
    // Made here, to the margins the sun asks for now.
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
    this.sunMapClear = true;
  }

  /**
   * DX-SHADOW3D: a sun map pass's program as a Shader's options: 'map' (the map's cards, with their heights) or
   * 'mapColumns' (a render's columns into the map). GLSL on WebGL (sunMapVertex / sunMapColumnsVertex), WGSL on WebGPU
   * (sunMapWgsl / sunMapColumnsWgsl).
   * @param {'map'|'mapColumns'} kind
   */
  sunShadowProgram(kind) {
    const shaders = this.worker._engineShaders;
    const columns = kind === 'mapColumns';
    const name = columns ? 'sun-map-columns' : 'sun-map';
    if (this.worker._useWebGpu) {
      const source = columns ? sunMapColumnsWgsl(shaders.shadowWgsl, SUN_MAP_COLUMNS) : sunMapWgsl(shaders.shadowWgsl);
      return { gpuProgram: sunShadowGpuProgram(GpuProgram, source, 'mainFragMap', name, { maps: columns }) };
    }
    const vertex = columns ? sunMapColumnsVertex(shaders.shadowVert, SUN_MAP_COLUMNS) : sunMapVertex(shaders.shadowVert);
    return { glProgram: glProgramFrom(PIXI.GlProgram, vertex, shaders.sunMapFrag, name) };
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
   * E-395: a columns pass over keyed caster rows (`kind` 'sun': the sun's map, 'lamp': the lamps' map), made on first use
   * and kept: the columns programs composed over spriteIndexed's keyed rows (statics by key) on either backend, the full
   * columns' resources and uniform groups, grid and state, and the caster batch's keyed geometry as the rows' layout.
   * Null where the entity batch keeps no keyed frames or the full pass is not made yet.
   */
  _keyedColumnsFor(kind, batch) {
    const key = kind === 'sun' ? 'sunMapKeyedColumns' : 'lampMapKeyedColumns';
    if (this[key] !== null) return this[key];
    const full = kind === 'sun' ? this.sunMapColumns : this.worker.lampMap.columns;
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
      ...(lamp ? { uLampTiles: this.worker.lampMap.tileSource } : {}),
      uniforms,
    });
    const shader = entities.makeKeyedRowsShader(program, resources(lamp ? this.worker.lampMap.uniforms : this.sunMapUniforms));
    const shaderCeil = lamp ? entities.makeKeyedRowsShader(program, resources(this.worker.lampMap.uniformsCeil)) : null;
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
   * DX-SHADOW3D: every program that binds the footprints (uFoot) on the current source: the sun map's columns and the
   * lamps' map's (their layouts name binding 7 whether or not their WGSL reads it).
   */
  pointFootPrograms() {
    const source = this.worker.assets.footSource;
    const holders = [this.sunMapColumns, this.worker.lampMap.columns];
    for (let i = 0; i < holders.length; i++) {
      const c = holders[i];
      if (c && c.shader && c.shader.resources.uFoot !== source) c.shader.resources.uFoot = source;
      if (c && c.shaderCeil && c.shaderCeil.resources.uFoot !== source) c.shaderCeil.resources.uFoot = source;
    }
  }

  /** E-496: every program that binds the maps table (uMapsLut) on the current source: the columns', the entities'. */
  pointMapsTablePrograms() {
    const source = this.worker.assets.mapsTableSource;
    const holders = [this.sunMapColumns, this.worker.lampMap.columns];
    for (let i = 0; i < holders.length; i++) {
      const c = holders[i];
      if (c && c.shader && c.shader.resources.uMapsLut !== undefined) c.shader.resources.uMapsLut = source;
      if (c && c.shaderCeil && c.shaderCeil.resources.uMapsLut !== undefined) c.shaderCeil.resources.uMapsLut = source;
    }
    if (this.worker.entitiesBatch) this.worker.entitiesBatch.setMapsTable(source);
  }
}
