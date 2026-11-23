/**
 * N-256 PW-6 (with PW-9's second half): the renderer's light pass, moved out of pixiWorker.js as it was. The lights
 * this frame shows (computeVisibleLights) and their data texture and screen tiles; the light pass itself
 * (createLightingSystem, updateLighting, renderLightingToTexture) and the targets and meshes it draws into and with;
 * the LiquidFun and particle light splats; the walls' rows (lighting.walls); the face map and the G-buffer targets it
 * reads (DX-FACES, DX-GBUF); the unshaded composite (DX-UNSHADED); the light edges (DX-LIGHTEDGES). The shadow maps'
 * outputs it binds (the lamps' map target, its tiles and fades, the sun's terms) are its fields; the shadow maps
 * (shadowMaps.js) write them through the holder.
 *
 * The lighting's settings stay the worker's (lightingEnabled, the maps' modes, the faces' switches, the scales, the
 * shadow samples and tile size): initialize's _initLighting step reads them from the config, and the shadow maps and
 * the entity batch read them too. Until the renderer's other subsystems move (N-256), what this class reads of the
 * worker goes through `this.worker`.
 */

import { Collider } from '../../components/collider.js';
import { LightEmitter } from '../../components/lightEmitter.js';
import { ParticleComponent } from '../../components/particleComponent.js';
import { SpriteRenderer } from '../../components/spriteRenderer.js';
import { Transform } from '../../components/transform.js';
import { DecorationPool } from '../../core/decorationPool.js';
import { Layer } from '../../core/layer.js';
import { LiquidFun } from '../../core/liquidFun.js';
import { Query } from '../../core/query.js';
import { Sun } from '../../core/sun.js';
import {
  PARTICLE_DEFAULTS,
  lampShadowAlphaOf,
  lightBehindWallsOf,
  normalShadingOf,
  resolveZenithalMaxHeight,
} from '../../util/configDefaults.js';
import { debugWorkerLog } from '../../util/debugLog.js';
import {
  LIGHT_DATA_TEX_HEIGHT,
  clearUnusedLightDataTexels,
  extractRGBNormalizedMut,
  lightDataTextureFloatCount,
} from '../../util/utils.js';
import { viewWorldBounds } from '../../util/viewBounds.js';
import {
  Buffer,
  BufferUsage,
  Geometry,
  GlProgram,
  GpuProgram,
  Matrix,
  Mesh,
  Rectangle,
  RenderTexture,
  Shader,
  Sprite,
  State,
  Texture,
  TextureSource,
} from '../../vendor/pixi.min.js';
import { lightingSource } from '../faceMap.js';
import { gbufEntityId } from '../gbufWord.js';
import { rtPixelScale, rtPixelSize } from '../gpuShadowCasters.js';
import { lightEdgesHost, lightEdgesQuad, rgbOnlyHost, unshadedEdgesHost } from '../lightEdges.js';
import {
  LightTiles,
  TILE_CAM_COS,
  TILE_CAM_FULL_H,
  TILE_CAM_FULL_W,
  TILE_CAM_GROUND_INV_Y,
  TILE_CAM_SIN,
  TILE_CAM_SNAP,
  TILE_CAM_X,
  TILE_CAM_Y,
  TILE_CAM_ZOOM,
  binLightTiles,
  layoutLightTiles,
  lightTilesGpuProgram,
  uploadLightTilesGl,
  uploadLightTilesGpu,
  writeLightTileUniforms,
} from '../lightTiles.js';
import { LF_SPLAT_STRIDE, LiquidFunDensitySplat } from '../liquidFunDensitySplat.js';
import { packParticleLights } from '../particleLightSplat.js';
import { layerIsVisible } from '../pixi/layerHelpers.js';
import {
  UNSHADED_COMPOSITE_FRAG,
  UNSHADED_COMPOSITE_VERT,
  unshadedCompositeGpuProgram,
  unshadedQuadPositions,
} from '../unshadedComposite.js';
import { WALL_VERT0, wallRowsLayout } from '../visibility/lampWallRow.js';
import { pinGpuTexture, writeRgba32Float } from '../webgpu/pinGpuTexture.js';
import { lightingGpuProgram } from '../webgpu/pixiMeshWgsl.js';

// The Pixi classes the moved bodies name as PIXI.X, as pixiWorker.js's namespace does.
const PIXI = Object.freeze({ Geometry, GlProgram, Mesh, Rectangle, RenderTexture, Shader, Sprite, State, Texture, TextureSource });

const QUERY_LIGHT_EMITTER = [LightEmitter];

// OPTIMIZED: Pre-defined comparator function for light sorting (avoids closure allocation per frame)
function sortPrefixByDistSq(arr, count) {
  const n = count | 0;
  for (let i = 1; i < n; i++) {
    const item = arr[i];
    const dist = item.distSq;
    let j = i - 1;
    while (j >= 0 && arr[j].distSq > dist) {
      arr[j + 1] = arr[j];
      j--;
    }
    arr[j + 1] = item;
  }
}

/** The light pass, its inputs and its targets, for one renderer worker. */
export class PixiLighting {
  /** @param {object} worker the PixiRenderer that owns this (its renderer, camera, lighting settings and batches) */
  constructor(worker) {
    this.worker = worker;
    this.lightingMesh = null; // PIXI.Mesh with lighting shader
    this.lightingShader = null; // Shader instance for updating uniforms
    this.nightRGB = new Float32Array(3); // Sun.nightLightRGB, once a frame
    this.lightingRT = null; // RenderTexture for low-res lighting
    this.faceRT = null; // DX-FACES: the face map (src/render/faceMap.js)
    // DX-GBUF (plan §6.4): the G-buffer's entity ids map (faceMap.js FACE_IDS_SELF), the face map's size, where the light pass
    // reads ids: self-shadow, or a shadow map (a caster's own shadow never paints its own sprite).
    this.faceIdsRT = null;
    this.faceIdsOn = false;
    this.gbufTarget = null;
    // N-274: whether the G-buffer's target has its depth attachment (the batch's gbufDepthOn when it was made).
    this.gbufTargetDepth = false;
    // DX-UNSHADED (was DX-EMISSIVE v2, plan §6.9, F10): two colours a pixel. Where the entities carry their words, the
    // unshaded pass draws their unshaded pixels into a target the canvas's size (unshadedRT) and the unshaded layer adds them
    // over the lighting layer where the light is short of them (unshadedComposite.js); a pass a frame while a sheet
    // (meta.unshaded) or a sprite is unshaded.
    this.unshadedOn = false;
    // DX-UNSHADED: spriteRenderer.unshaded was set in a scene that draws no G-buffer, and that was said.
    this.unshadedWarned = false;
    this.unshadedRT = null;
    this.unshadedComposite = null;
    this.unshadedQuad = new Float32Array(8);
    this.unshadedQuadBuffer = null;
    this.unshadedRtLayer = { resolution: 1 };
    this.unshadedRtTransform = new Matrix();
    this.lampMapRT = null;
    this.lampTileOf = new Int16Array(0);
    /** N-212: each lamp's map shadow fade at the cut, by entity (1 inside it), read with its tile (_readLampTiles). */
    this.lampFadeOf = new Float32Array(0);
    // lighting.lampShadowAlpha: how much of a lamp's light its shadows take out (a double from the start: it holds a
    // fraction; set when the light pass is made).
    this.lampShadowAlpha = NaN;
    // The light pass's uLampAtlas: tiles a row, a tile's texels, the atlas's width and height.
    this.lampAtlas = new Float32Array([1, 256, 256, 256]);
    // E-551: each lamp tile's rect as one number (lampShadowMap.js lampRectCode), by tile: the tag the light pass reads.
    this.lampRectCodes = new Float64Array(0);
    this.sunMapK = new Float32Array(4);
    this.sunMapRect = new Float32Array([1, 1, 0, 0]);
    this.noMapsSource = null; // DX-MAPS: its stand-in when none has (_emptyMapsSource)
    this.faceLight = new Float32Array(4);
    this.faceSun = new Float32Array(4); // towards the sun, once a frame
    this.normalShade = new Float32Array(4);
    this.faceRtLayer = { resolution: 1 }; // _writeCameraRtTransform's layer for the face map
    this.faceRtTransform = new Matrix();
    this.faceCamera = new Float64Array(4).fill(NaN); // the camera _faceRtTransform was written for
    // N-272: the face map is drawn a texel inside its edges, so its edge ring stays empty (cleared): the light pass's
    // self-shadow march, which samples with clamp-to-edge, reads nothing past the screen instead of the wall at its edge.
    this.faceRtFrame = new PIXI.Rectangle(1, 1, 1, 1);
    this.lightingDisplaySprite = null; // Sprite to display the lightingRT on stage
    // DX-LIGHTEDGES (lightEdges.js): the light shown without crossing the floor's edges, where the entities write depth:
    // its host in the lighting layer's place (the sprite above then stays off the stage), the unshaded layer's two
    // halves, and the canvas quad they share.
    this.lightEdgesOn = false;
    this.lightEdges = null;
    this.unshadedEdges = null;
    this.lightEdgesQuad = new Float32Array(8);
    this.lightEdgesQuadBuffer = null;
    this.lightEdgesGeometry = null;
    this.lightDataFloats = null; // Float32Array RGBA32F payload (maxLights x 2)
    this.lightDataSource = null; // BufferImageSource uploading _lightDataFloats
    /** E-511: the lights the light data texture held at its last upload (-1: none yet, upload it whole). */
    this.lightDataLive = -1;
    this.lightTiles = new LightTiles();
    this.lightTilesSource = null;
    this.lightTilesUnit = 0;
    this.lightTilesMade = false;
    this.lfLightSplat = null;
    // Pre-computed visible lights (computed once per frame, used by updateLighting shader)
    this.visibleLightsAll = [];
    this.visibleLightsAllCount = 0;
    /** viewWorldBounds scratch for the light cull. */
    this.lightViewBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    this.lfLightOpts = {
      zoom: 1,
      cameraX: 0,
      cameraY: 0,
      cameraRot: 0,
      resolution: 1,
      canvasW: 0,
      canvasH: 0,
    };
    this.particleLightSplat = null;
    this.particleLightOpts = {
      zoom: 1,
      cameraX: 0,
      cameraY: 0,
      cameraRot: 0,
      resolution: 1,
      canvasW: 0,
      canvasH: 0,
      zenithalMaxHeight: PARTICLE_DEFAULTS.zenithalMaxHeight,
      zenithalAlphaFade: 0,
      layerVisible: null,
      layerAlpha: null,
      max: 256,
    };
    this.particleLightViews = {
      active: null,
      lightSqrt: null,
      x: null,
      y: null,
      z: null,
      alpha: null,
      tint: null,
      flat: null,
      viewMode: null,
      renderOnly: null,
      layerMask: null,
    };
    // OPTIMIZED: Preallocated RGB object to avoid allocation per light per frame
    this.rgbResult = { r: 0, g: 0, b: 0 };
    // DX-SPOT: each visible light's coneCos as this frame read it, once (the logic worker may write the column meanwhile).
    // Grown, never per frame.
    this.lightConeCosSeen = new Float32Array(0);
    // OL-4: the walls' rows the light pass reads (pre-render's, lampWallRow.js): the pair of shared buffers, a row's floats
    // and texels, this worker's copy of the rows and its texture, each lamp's row this frame (by entity, row + 1; 0: none)
    // and the lamps given one last frame (to clear them).
    this.wallRowsOn = false;
    this.wallRowBuffers = [null, null];
    this.wallRowFloats = 0;
    this.wallRowTexels = 0;
    this.wallRowsData = new Float32Array(0);
    this.wallRowsSource = null;
    this.wallRowOf = new Int16Array(0);
    this.wallRowLamps = new Int32Array(0);
    this.wallRowLampCount = 0;
    this.wallRowsWarned = false;
    // OL-10: where a rows' header holds the frame's signature, the signature of the rows last sent up, and the frames
    // whose rows were those again (nothing copied, nothing uploaded).
    this.wallSignatureAt = 0;
    this.wallSentLo = 0;
    this.wallSentHi = 0;
    this.wallRowsSkipped = 0;
    // lighting.wallDepth and lighting.lightBehindWalls, in the light pass's uWalls (x, y).
    this.wallTerms = new Float32Array(4);
    // NaN: a double, and falsy until the first viewport, like the missing field was.
    this.lightingPixelScale = NaN;
    this.visibleLightsData = null; // _initLighting binds the visible lights' ids (a Uint16Array view), when lighting is on
  }

  createLightingSystem() {
    this.lampShadowAlpha = lampShadowAlphaOf(this.worker.config.lighting);
    const geometry = new PIXI.Geometry({
      attributes: {
        aPosition: [-1, -1, 1, -1, 1, 1, -1, 1],
      },
      indexBuffer: [0, 1, 2, 0, 2, 3],
    });

    const maxLights = this.worker.maxLights;

    this.lightDataFloats = new Float32Array(lightDataTextureFloatCount(maxLights));
    this.lightDataLive = -1;
    this.lightDataSource = PIXI.TextureSource.from({
      resource: this.lightDataFloats,
      width: maxLights,
      height: LIGHT_DATA_TEX_HEIGHT,
      format: 'rgba32float',
      scaleMode: 'nearest',
      addressMode: 'clamp-to-edge',
      autoGenerateMipmaps: false,
    });
    this.lightDataSource.uploadMethodId = this.worker._useWebGpu ? 'external' : 'unknown';

    const lightingResources = {
      uLightData: this.lightDataSource,
      uniforms: {
        uCameraPos: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
        uZoom: { value: 1.0, type: 'f32' },
        uViewport: {
          value: new Float32Array([this.worker.canvasWidth, this.worker.canvasHeight]),
          type: 'vec2<f32>',
        },
        uFullCanvasSize: {
          value: new Float32Array([this.worker.canvasWidth, this.worker.canvasHeight]),
          type: 'vec2<f32>',
        },
        uCameraRot: { value: new Float32Array([1, 0]), type: 'vec2<f32>' },
        uInvResolution: { value: 1.0 / this.worker.lightingResolution, type: 'f32' },
        uBaseAmbient: { value: this.worker.baseAmbient, type: 'f32' },
        uSunIntensity: { value: 0, type: 'f32' },
        uSunR: { value: 1.0, type: 'f32' },
        uSunG: { value: 1.0, type: 'f32' },
        uSunB: { value: 1.0, type: 'f32' },
        uFlipY: { value: 0, type: 'f32' },
        uGroundInvScaleY: { value: this.worker._groundInvScaleY || 1, type: 'f32' },
        uNightR: { value: 0, type: 'f32' },
        uNightG: { value: 0, type: 'f32' },
        uNightB: { value: 0, type: 'f32' },
        // DX-SPOT: the first uConeCount lights are cones (their third row); the shader loops them apart. A float: on
        // WebGPU Pixi writes an i32 uniform with a float's bits.
        uConeCount: { value: 0, type: 'f32' },
        // E-205: the lights by tile (lightTiles.js); updateLighting lays the grid out at the pass's size.
        uTileGrid: { value: new Float32Array(4), type: 'vec4<f32>' },
        uTileWords: { value: new Float32Array(4), type: 'vec4<f32>' },
      },
    };

    const facesOn = this.worker._facesOn;
    if (facesOn) {
      // DX-BARRIOS: no wrap or gain any more; the sun's direct share follows Sun.skyLight (_writeFaceSun, each frame).
      const faceLight = this.faceLight;
      // OL-4: 0 where the camera shows no height (straight down, or from the side): a pixel's height then moves it nowhere
      // on the screen. 1 only where the camera has not been read.
      faceLight[0] = this.worker._heightScaleY >= 0 ? this.worker._heightScaleY : 1;
      faceLight[1] = 0;
      faceLight[2] = 0;
      faceLight[3] = 1 - Sun.skyLight;
      lightingResources.uniforms.uFaceLight = { value: faceLight, type: 'vec4<f32>' };
      lightingResources.uniforms.uFaceSun = { value: this.faceSun, type: 'vec4<f32>' };
      // OL-6 (lighting.normalShading): what a sprite's own normals take from the sun and from each lamp, less the
      // amount subtracted, times the strength. After uFaceSun, as the WGSL's struct has it.
      const shading = normalShadingOf(this.worker.config.lighting);
      const normalShade = this.normalShade;
      normalShade[0] = shading.sun.strength;
      normalShade[1] = shading.sun.subtract;
      normalShade[2] = shading.lamps.strength;
      normalShade[3] = shading.lamps.subtract;
      lightingResources.uniforms.uNormalShade = { value: normalShade, type: 'vec4<f32>' };
      lightingResources.uFaceMap = PIXI.Texture.EMPTY.source;
    }
    if (this.worker._sunMapOn) {
      lightingResources.uniforms.uSunMapK = { value: this.sunMapK, type: 'vec4<f32>' };
      // N-317: right after uSunMapK, as the WGSL struct has it.
      lightingResources.uniforms.uSunMapRect = { value: this.sunMapRect, type: 'vec4<f32>' };
      lightingResources.uSunMap = PIXI.Texture.EMPTY.source;
    }
    if (this.worker._selfShadowOn && facesOn) {
      // A step of 4 floor px, 6 steps, 3 px of bias (plus a quarter of the distance): src/shaders/lightingBasic.frag.glsl.
      lightingResources.uniforms.uSelfShadow = { value: new Float32Array([4, 6, 3, 0]), type: 'vec4<f32>' };
    }
    if (this.worker._lampMapOn) {
      // DX-SHADOW3D (F7): the lamps' map and its layout (lampMap.js _ensureMap binds the atlas once it is made).
      lightingResources.uniforms.uLampAtlas = { value: this.lampAtlas, type: 'vec4<f32>' };
      lightingResources.uLampMap = this.lampMapRT ? this.lampMapRT.source : PIXI.Texture.EMPTY.source;
    }
    // DX-GBUF: the entity ids map, where the entities carry their words and something reads ids (self-shadow, a map).
    this.faceIdsOn = facesOn && !!this.worker.entitiesBatch?.gbuf
      && (this.worker._selfShadowOn || this.worker._sunMapOn || this.worker._lampMapOn || this.wallRowsOn);
    if (this.faceIdsOn) lightingResources.uFaceIds = PIXI.Texture.EMPTY.source;
    // OL-4: the walls' rows, where the pass knows whose each pixel is (a wall's own pixels stay lit beyond its edge).
    const wallsOn = this.wallRowsOn && this.faceIdsOn;
    if (wallsOn) lightingResources.uWallRows = this.wallRowsSource;
    else if (this.wallRowsOn && !this.wallRowsWarned) {
      this.wallRowsWarned = true;
      console.warn('WeedJS: lighting.walls is on but the entities carry no G-buffer words, so the walls stop no light');
    }
    {
      // E-205: the lights by tile (lightTiles.js): updateLighting lays the grid out at the pass's size and fills the
      // texture before the pass draws.
      this.lightTiles.cam[TILE_CAM_SNAP] = this.worker._pixelArtLight ? 0.5 : 0;
      this.lightTilesSource = PIXI.TextureSource.from({
        resource: new Uint32Array(1),
        width: 1,
        height: 1,
        format: 'r32uint',
        scaleMode: 'nearest',
        addressMode: 'clamp-to-edge',
        autoGenerateMipmaps: false,
        label: 'weed-light-tiles',
      });
      this.lightTilesSource.uploadMethodId = this.worker._useWebGpu ? 'external' : 'unknown';
      const gl = this.worker._useWebGpu ? null : this.worker.pixiApp?.renderer?.gl;
      this.lightTilesUnit = gl ? gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) - 1 : 0;
      lightingResources.uLightTiles = this.lightTilesSource;
    }
    if (wallsOn) {
      // OL-4: after every other uniform (the WGSL struct's order): how deep the light enters a wall (lighting.wallDepth)
      // and how much of a lamp's light a wall's shadow keeps (lighting.lightBehindWalls).
      const depth = Number(this.worker.config?.lighting?.wallDepth);
      this.wallTerms[0] = depth > 0 && Number.isFinite(depth) ? depth : 0;
      this.wallTerms[1] = lightBehindWallsOf(this.worker.config?.lighting);
      lightingResources.uniforms.uWalls = { value: this.wallTerms, type: 'vec4<f32>' };
    }
    // DX-LIGHTEDGES: the light at a share of the canvas over entities that write depth (pixel depth) is shown without
    // crossing the floor's edges; lighting.lightEdges false stretches it as a plain texture.
    this.lightEdgesOn = this.worker.lightingResolution < 1 && !!this.worker.entitiesBatch?.pixelDepthOn
      && this.worker.config?.lighting?.lightEdges !== false;
    const lightingSrc = lightingSource(this.worker._engineShaders?.lightingFrag || '', {
      faces: facesOn,
      sunMap: this.worker._sunMapOn,
      selfShadow: this.worker._selfShadowOn,
      lampMap: this.worker._lampMapOn,
      ids: this.faceIdsOn,
      pixelArt: this.worker._pixelArtLight,
      edges: this.lightEdgesOn,
      // N-277: half a step of noise on the light, against the 8-bit target's rings (off by default: on an Intel iGPU it
      // cost 4 % of the drawn frames).
      dither: this.worker.config?.lighting?.dither === true,
      walls: wallsOn,
      shadowSamples: this.worker._shadowSamples,
    }).replace(
      /MAX_LIGHTS/g,
      String(this.worker.maxLights | 0 || 64)
    );
    if (this.worker._useWebGpu) {
      if (!lightingSrc) {
        throw new Error('WeedJS: Failed to compile look shader "lighting_basic" for layer "LIGHTING" on WebGPU: lighting_basic.wgsl is missing.');
      }
      const makeProgram = (Gp) => lightingGpuProgram(
        Gp, lightingSrc, 'lighting-basic', facesOn, this.worker._sunMapOn, this.worker._lampMapOn, this.faceIdsOn, wallsOn,
      );
      // E-205: the tiles' texture at binding 8 of the pass's group.
      const gpuProgram = lightTilesGpuProgram(GpuProgram, makeProgram);
      this.lightingShader = new PIXI.Shader({ gpuProgram, resources: lightingResources });
    } else {
      if (!lightingSrc) {
        throw new Error('WeedJS: Failed to compile look shader "lighting_basic" for layer "LIGHTING" on WebGL: lighting_basic.frag.glsl is missing.');
      }
      const glProgram = new PIXI.GlProgram({
        vertex: `
  in vec2 aPosition;
  void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
  }
  `,
        fragment: lightingSrc,
        name: 'lighting-basic',
      });
      this.lightingShader = new PIXI.Shader({ glProgram, resources: lightingResources });
    }

    this.lightingMesh = new PIXI.Mesh({
      geometry,
      shader: this.lightingShader,
    });

    // DX-UNSHADED: where the entities carry their words, a sprite may be unshaded (its sheet or spriteRenderer.unshaded):
    // the G-buffer's passes leave unshaded pixels to the unshaded pass, and the unshaded layer reads the light's target.
    const unshadedShaders = this.worker._useWebGpu ? !!this.worker._engineShaders?.sprite : !!this.worker._engineShaders?.spriteVert;
    this.unshadedOn = !!this.worker.entitiesBatch?.gbuf && unshadedShaders;
    if (this.worker.entitiesBatch) this.worker.entitiesBatch.unshadedOn = this.unshadedOn;
    // Low-res lighting, liquid field splats, or particle lights need an RT target.
    const needRt = this.worker.lightingResolution < 1.0 || this.worker.liquidFunMaxCount > 0 || this.worker._particleLightsEnabled || facesOn
      || this.unshadedOn;
    if (needRt) {
      const lw = rtPixelSize(this.worker.canvasWidth, this.worker.lightingResolution);
      const lh = rtPixelSize(this.worker.canvasHeight, this.worker.lightingResolution);
      this.lightingRT = PIXI.RenderTexture.create({ width: lw, height: lh });
      if (facesOn) this.createFaceMap(lw, lh);
      this.lightingDisplaySprite = new PIXI.Sprite(this.lightingRT);
      this.lightingDisplaySprite.anchor.set(0, 0); // Ensure top-left anchor
      this.lightingDisplaySprite.position.set(0, 0); // Position at top-left of screen
      this.lightingDisplaySprite.scale.set(this.worker.canvasWidth / lw, this.worker.canvasHeight / lh);
      if (this.lightEdgesOn) {
        this._createLightEdges();
      } else {
        this.worker._registerLayerDisplayObject('lighting', this.lightingDisplaySprite);
        this.worker.pixiApp.stage.addChild(this.lightingDisplaySprite);
      }
      this.applyLightingViewport(this.worker.canvasWidth, this.worker.canvasHeight);
      if (this.unshadedOn) this._createUnshadedLayer();

      debugWorkerLog(
        `PIXI WORKER: Lighting RenderTexture created (${this.lightingRT.width}x${this.lightingRT.height})`
      );
    } else {
      this.worker._registerLayerDisplayObject('lighting', this.lightingMesh);
      this.worker.pixiApp.stage.addChild(this.lightingMesh);
    }
  }

  updateLighting() {
    if (!this.worker.lightingEnabled || !this.lightingShader) return;
    // DX-SHADOW3D (F7): which lamps have a tile in the lamps' map this frame, before their texels are packed.
    if (this.worker._lampMapOn) this.worker.lampMap.readTiles();

    const uniformGroup = this.lightingShader.resources.uniforms;

    // The floor's foreshortening: the shader scales the fragment's world y by this once, the lights' y here.
    const groundInvY = this.worker._groundInvScaleY || 1;

    const zoom = this.worker._renderZoom;
    const cameraX = this.worker._renderCameraX;
    const cameraY = this.worker._renderCameraY;

    // Update camera uniforms (vec2 types)
    this._stampLightCamera(uniformGroup.uniforms, cameraX, cameraY, zoom);
    this.applyLightingViewport(this.worker.canvasWidth, this.worker.canvasHeight);

    const lightData = this.lightDataFloats;
    const maxLights = this.worker.maxLights;

    // Use pre-computed visible lights (computed in computeVisibleLights())
    const visibleLights = this.visibleLightsAll;
    const countToRender = Math.min(this.visibleLightsAllCount, maxLights);

    const rgb = this.rgbResult; // the sun's colour, once a frame
    const vr = Collider.visualRange;
    const row1 = maxLights * 4;
    const row2 = maxLights * 8;
    // DX-SPOT: the cone lights take the first slots, so the shader loops them apart and a point light pays nothing; with
    // no cone in view the slots are the visible order, as before.
    const lightConeCos = LightEmitter.coneCos;
    // Each light's coneCos, read once: the count and the slots must agree, or a light the logic worker turns into a cone
    // in between takes a slot twice and leaves one with last frame's light.
    if (this.lightConeCosSeen.length < countToRender) this.lightConeCosSeen = new Float32Array(Math.max(countToRender, maxLights | 0));
    const coneCosSeen = this.lightConeCosSeen;
    let coneCount = 0;
    for (let i = 0; i < countToRender; i++) {
      const seen = lightConeCos[visibleLights[i].entityId];
      coneCosSeen[i] = seen;
      if (seen > -1) coneCount++;
    }
    // OL-4: which lamp has which row of the walls' texture this frame, before the pack tags them.
    if (this.wallRowsOn) this.readWallRows();
    // E-311: the per-light pack in its own method (see _packLightData).
    this.packLightData(countToRender, visibleLights, coneCosSeen, coneCount, lightData, row1, row2, groundInvY, vr);

    // E-511: the columns that changed since the last upload, the lights now and last frame's (now cleared); the whole
    // texture after it is made (_lightDataLive -1). The barrio uploaded its 1024 columns (64 KB) a frame for a few dozen.
    const lastLive = this.lightDataLive;
    const columns = lastLive < 0 || lastLive > maxLights ? maxLights : Math.max(countToRender, lastLive);
    clearUnusedLightDataTexels(lightData, maxLights, countToRender, columns);

    if (this.lightDataSource && this._uploadLightDataTexture(columns)) {
      this.lightDataLive = countToRender;
    }

    uniformGroup.uniforms.uConeCount = coneCount;

    // E-205: the frame's lights by tile, for the camera stamped above.
    if (this.lightTilesSource !== null) this._updateLightTiles(uniformGroup.uniforms, countToRender);

    // ========================================
    // SUN UNIFORMS
    // ========================================
    // Sun provides global ambient light that varies with time of day
    // E-311: in its own method, as the per-light pack.
    this._writeSunUniforms(uniformGroup.uniforms, rgb);

    if (typeof uniformGroup.update === 'function') uniformGroup.update();
  }

  renderLightingToTexture() {
    const started = this.worker.collectDetailedStats ? performance.now() : 0;
    if (!this.unshadedOn && !this.unshadedWarned && (this.worker.frameNumber & 127) === 0 && SpriteRenderer.unshadedUsers() > 0) {
      // DX-UNSHADED: a sprite asks to be unshaded where nothing carries its words: said once, with what turns them on.
      this.unshadedWarned = true;
      console.warn(
        'WeedJS: spriteRenderer.unshaded is set, but this scene draws no G-buffer, so nothing is unshaded: set ' +
          'config.lighting.unshaded = true (maps, an unshaded sheet or a shadow map turn it on too).',
      );
    }
    if (this.lightingRT && this.lightingMesh && layerIsVisible(Layer.lighting?.id)) {
      if (this.faceRT !== null) this._renderFaceMap();
      const renderOptions = this.worker._rtRenderOpts;
      renderOptions.transform = null;
      renderOptions.container = this.lightingMesh;
      renderOptions.target = this.lightingRT;
      renderOptions.clear = true;
      renderOptions.clearColor = this.worker._clearTransparent;
      this.worker._submitRender(renderOptions);
      this._renderLiquidFunLightingField();
      this._renderParticleLightingField();
      if (this.unshadedOn) this._renderUnshaded();
    } else if (this.unshadedComposite !== null && this.unshadedComposite.visible) {
      // DBG-1: the unshaded pixels go with the lighting layer: hidden, it would keep adding the last frame's.
      this.unshadedComposite.visible = false;
    }
    if (started) this.worker.lightsTimeThisFrame += performance.now() - started;
  }

  drawFrameLights() {
    const started = this.worker.collectDetailedStats ? performance.now() : 0;
    this.computeVisibleLights();
    this.updateLighting();
    if (started) this.worker.lightsTimeThisFrame = performance.now() - started;
  }

  /**
   * Pre-compute visible lights once per frame.
   * updateLighting() uses this data for shader uniforms.
   * Avoids duplicate queryActiveEntities, culling, and sorting.
   */
  computeVisibleLights() {
    // Early return if lighting is disabled (LightEmitter arrays not initialized)
    if (!LightEmitter.active) return;

    const worldX = Transform.x;
    const worldY = Transform.y;
    const lightEnabled = LightEmitter.active;
    const lightRadius = LightEmitter.radius;
    const offsetX = LightEmitter.offsetX;
    const offsetY = LightEmitter.offsetY;
    const rotC = Transform.rotC;
    const rotS = Transform.rotS;

    const zoom = this.worker._renderZoom;
    const cameraX = this.worker._renderCameraX;
    const cameraY = this.worker._renderCameraY;

    // Viewport box for culling; a rotated camera grows it to cover the turned view
    const viewWidth = this.worker.canvasWidth / zoom;
    const viewHeight = this.worker.canvasHeight / zoom;
    const view = viewWorldBounds(
      zoom, cameraX, cameraY, this.worker.canvasWidth, this.worker.canvasHeight, this.worker._renderCameraRot || 0, this.lightViewBounds
    );
    const viewLeft = view.minX;
    const viewTop = view.minY;
    const viewRight = view.maxX;
    const viewBottom = view.maxY;

    // Viewport center for sorting by distance (only needed if candidates exceed maxLights)
    const maxLights = this.worker.maxLights | 0;
    const useSharedBuffer = !!this.visibleLightsData;
    const lightCount = useSharedBuffer ? this.visibleLightsData[0] : 0;
    const lightEntities = useSharedBuffer ? null : Query.queryActiveEntities(QUERY_LIGHT_EMITTER);
    const iterCount = useSharedBuffer ? lightCount : (lightEntities ? lightEntities.length : 0);

    const needDistSort = iterCount > maxLights;
    const viewCenterX = needDistSort ? cameraX + viewWidth * 0.5 : 0;
    const viewCenterY = needDistSort ? cameraY + viewHeight * 0.5 : 0;

    // Reset pool
    this.visibleLightsAllCount = 0;

    for (let idx = 0; idx < iterCount; idx++) {
      const i = useSharedBuffer ? this.visibleLightsData[1 + idx] : lightEntities[idx];
      if (!lightEnabled[i]) continue;
      if (!(lightRadius[i] > 0)) continue;

      // World-space light position from Transform SAB, same source as
      // updateLighting and the shadow maps use.
      const ox = offsetX[i];
      const oy = offsetY[i];
      const x = worldX[i] + ox * rotC[i] - oy * rotS[i];
      const yForLight = worldY[i] + ox * rotS[i] + oy * rotC[i];

      // Viewport culling by the light's reach
      const influenceRadius = lightRadius[i];

      if (
        x + influenceRadius < viewLeft ||
        x - influenceRadius > viewRight ||
        yForLight + influenceRadius < viewTop ||
        yForLight - influenceRadius > viewBottom
      ) {
        continue;
      }

      // Add to "all lights" pool (for shader uniforms)
      const allIdx = this.visibleLightsAllCount++;
      let entry = this.visibleLightsAll[allIdx];
      if (!entry) {
        entry = this.visibleLightsAll[allIdx] = { entityId: 0, distSq: 0 };
      }
      entry.entityId = i;
      if (needDistSort) {
        const dx = x - viewCenterX;
        const dy = yForLight - viewCenterY;
        entry.distSq = dx * dx + dy * dy;
      }
    }

    if (this.visibleLightsAllCount > maxLights) {
      sortPrefixByDistSq(this.visibleLightsAll, this.visibleLightsAllCount);
    }
  }

  /**
   * E-311. updateLighting's per-light pack: each visible light's texels (packLightDataTexel's layout, E-109), the cone
   * lights first. In its own method because inside updateLighting (1 395 bytecode bytes, 21 functions inlined)
   * TurboFan left a double boxed per light per frame (Predator crowd 1.5: 54.5 KB/s, a sixth of Pixi's allocation);
   * compiled alone the loop allocates nothing.
   */
  packLightData(countToRender, visibleLights, coneCosSeen, coneCount, lightData, row1, row2, groundInvY, vr) {
    // DX-SHADOW3D (F7): a lamp with a tile in the lamps' map: its first row's w carries -(tile + 1).
    const tileOf = this.lampTileOf;
    // E-551: the tag carries the tile's rect in the atlas (lampRectCode), not its index.
    const rectCodes = this.lampRectCodes;
    // N-212: and its fourth row's x its map shadow's fade at the cut (1 for any other light).
    const fadeOf = this.lampFadeOf;
    // lighting.lampShadowAlpha (1 before the light pass is made).
    const shadowAlpha = this.lampShadowAlpha >= 0 ? this.lampShadowAlpha : 1;
    const row3 = row2 + row2 - row1;
    const ids = this.faceIdsOn;
    // OL-4: each lamp's row of the walls' texture, + 1 (0: nothing stops it), in its fourth row's z.
    const wallRowOf = this.wallRowOf;
    const worldX = Transform.x;
    const worldY = Transform.y;
    const lightColor = LightEmitter.color;
    const lightRadius = LightEmitter.radius;
    const lightBrightness = LightEmitter.brightness;
    const lightElevation = LightEmitter.elevation;
    const offsetX = LightEmitter.offsetX;
    const offsetY = LightEmitter.offsetY;
    const rotC = Transform.rotC;
    const rotS = Transform.rotS;
    const lightConeInvSpan = LightEmitter.coneInvSpan;
    const lightDirC = LightEmitter.dirC;
    const lightDirS = LightEmitter.dirS;
    // E-510: how far each light's shadows reach (0: its radius).
    const lightShadowRange = LightEmitter.shadowRange;
    let coneSlot = 0;
    let pointSlot = coneCount;
    for (let i = 0; i < countToRender; i++) {
      const entityIndex = visibleLights[i].entityId;
      const color = lightColor[entityIndex];
      const range = vr ? (vr[entityIndex] || 0) : 0;
      const coneCos = coneCosSeen[i];
      const isCone = coneCos > -1;
      const slot = isCone ? coneSlot++ : pointSlot++;

      // A source h above the floor: I / (I + h² + d²) = k * I' / (I' + d²) with I' = I + h², k = I / I'.
      // So the shader keeps one formula: it gets I' and the colour scaled by k (and by the brightness).
      // I = (radius / 10)², divided so a whole radius gives I exactly.
      const rad = lightRadius[entityIndex];
      let intensity = (rad * rad) / 100;
      let colorScale = lightBrightness[entityIndex];
      const h = lightElevation[entityIndex];
      if (h > 0) {
        const raised = intensity + h * h;
        colorScale = (intensity / raised) * colorScale;
        intensity = raised;
      }

      // packLightDataTexel's layout, written here (E-109): where TurboFan left that call out, each of its seven
      // doubles was a heap number per light per frame. World coordinates (the shader converts screen to world),
      // the light raised by its height, y in floor units (times 1 / groundScaleY).
      const i0 = slot * 4;
      const ox = offsetX[entityIndex];
      const oy = offsetY[entityIndex];
      lightData[i0] = worldX[entityIndex] + ox * rotC[entityIndex] - oy * rotS[entityIndex];
      lightData[i0 + 1] = (worldY[entityIndex] + ox * rotS[entityIndex] + oy * rotC[entityIndex]) * groundInvY;
      lightData[i0 + 2] = intensity;
      lightData[i0 + 3] = range * range;
      const i3 = row3 + i0;
      lightData[i3] = 1;
      lightData[i3 + 1] = 0;
      lightData[i3 + 2] = entityIndex < wallRowOf.length ? wallRowOf[entityIndex] : 0;
      lightData[i3 + 3] = 0;
      if (entityIndex < tileOf.length) {
        const tile = tileOf[entityIndex];
        if (tile >= 0 && h > 0 && tile < rectCodes.length) {
          lightData[i0 + 3] = -(rectCodes[tile] + 1);
          // DX-GBUF: with the ids map, its entity's id in the fourth row's w, so a pixel of its own entity does not shade
          // from it (lightingBasic lampOwner). N-189: it rode in the tag, -(tile + 1 + 256 · id), which held 256 tiles.
          if (ids) lightData[i3 + 3] = gbufEntityId(entityIndex);
          // N-212: its fade at the cut, times lighting.lampShadowAlpha: how much of its light its shadows take out.
          lightData[i3] = (entityIndex < fadeOf.length ? fadeOf[entityIndex] : 1) * shadowAlpha;
          // E-510: how far its shadows reach, the span of its tile: its shadowRange where that is under its radius
          // (positive: its shadows fade out over the last fifth), minus its radius otherwise (E-409: the light pass reads
          // it instead of taking 10 sqrt(I' - h²) at every pixel).
          const shadowRange = lightShadowRange[entityIndex];
          lightData[i3 + 1] = shadowRange > 0 && shadowRange < rad ? shadowRange : -rad;
        }
      }
      const i1 = row1 + i0;
      lightData[i1] = (((color >> 16) & 0xff) / 255) * colorScale;
      lightData[i1 + 1] = (((color >> 8) & 0xff) / 255) * colorScale;
      lightData[i1 + 2] = ((color & 0xff) / 255) * colorScale;
      lightData[i1 + 3] = h; // DX-FACES: a face needs the source's height itself
      if (isCone) {
        // The cone's direction: the entity's facing turns the light's own (dirC, dirS); on the floor, y over
        // groundScaleY, unit length. Then the cosine of the half aperture and 1 / the soft edge's width.
        const dc = lightDirC[entityIndex];
        const ds = lightDirS[entityIndex];
        const rc = rotC[entityIndex];
        const rs = rotS[entityIndex];
        const wx = rc * dc - rs * ds;
        const wy = (rs * dc + rc * ds) * groundInvY;
        const len = Math.sqrt(wx * wx + wy * wy);
        const i2 = row2 + i0;
        lightData[i2] = len > 0 ? wx / len : 1;
        lightData[i2 + 1] = len > 0 ? wy / len : 0;
        lightData[i2 + 2] = coneCos;
        lightData[i2 + 3] = lightConeInvSpan[entityIndex];
      }
    }

  }

  /**
   * Pack path mutates _lightDataFloats in place. Pin RGBA32F GPUTexture (no RENDER_ATTACHMENT).
   */
  _uploadLightDataTexture(columns = this.worker.maxLights) {
    const source = this.lightDataSource;
    const data = this.lightDataFloats;
    if (!source || !data) return false;
    if (this.worker._useWebGpu) {
      const renderer = this.worker.pixiApp?.renderer;
      if (!renderer?.gpu?.device) return false;
      writeRgba32Float(
        renderer,
        source,
        data,
        this.worker.maxLights,
        LIGHT_DATA_TEX_HEIGHT,
        'weed-light-data',
        columns,
      );
      return true;
    }
    this.worker._uploadRgba32FloatGl(source, data, this.worker.maxLights, LIGHT_DATA_TEX_HEIGHT, columns);
    return true;
  }

  /**
   * E-205: the packed lights binned into the light pass's tiles (lightTiles.js) for the camera, viewport and floor scale the
   * pass reads this frame (its uniforms, float32 as the GPU gets them), the bands in use sent up and the grid's uniforms
   * written. The grid follows the pass's size (a resize lays it out again and makes the texture anew).
   */
  _updateLightTiles(u, count) {
    const t = this.lightTiles;
    const rowAlign = this.worker._useWebGpu ? 64 : 1;
    const tile = this.worker._lightCullingTileSize;
    if (layoutLightTiles(t, u.uViewport[0] | 0, u.uViewport[1] | 0, this.worker.maxLights | 0, rowAlign, tile)) {
      this.lightTilesMade = false;
    }
    const cam = t.cam;
    cam[TILE_CAM_ZOOM] = Math.fround(u.uZoom);
    cam[TILE_CAM_X] = u.uCameraPos[0];
    cam[TILE_CAM_Y] = u.uCameraPos[1];
    cam[TILE_CAM_COS] = u.uCameraRot[0];
    cam[TILE_CAM_SIN] = u.uCameraRot[1];
    cam[TILE_CAM_FULL_W] = u.uFullCanvasSize[0];
    cam[TILE_CAM_FULL_H] = u.uFullCanvasSize[1];
    cam[TILE_CAM_GROUND_INV_Y] = Math.fround(u.uGroundInvScaleY);
    binLightTiles(t, this.lightDataFloats, this.worker.maxLights | 0, count);
    const renderer = this.worker.pixiApp?.renderer;
    if (this.worker._useWebGpu) {
      uploadLightTilesGpu(renderer, this.lightTilesSource, t, pinGpuTexture);
    } else {
      if (uploadLightTilesGl(renderer, this.lightTilesSource, t, this.lightTilesUnit, !this.lightTilesMade)) {
        this.lightTilesMade = true;
      }
    }
    writeLightTileUniforms(t, u.uTileGrid, u.uTileWords);
  }

  /**
   * E-311. updateLighting's sun and night uniforms. In its own method for the reason _packLightData is: inside
   * updateLighting TurboFan boxed more of these doubles (12 KB/s with the pack already out, about 3 alone).
   */
  _writeSunUniforms(uniforms, rgb) {
    if (Sun.isInitialized && Sun.enabled) {
      const sunIntensity = Sun.intensity;
      const sunColor = Sun.color;

      uniforms.uSunIntensity = sunIntensity;

      // Extract sun color RGB
      extractRGBNormalizedMut(sunColor, rgb);
      if (this.faceRT !== null) this.writeFaceSun();
      uniforms.uSunR = rgb.r;
      uniforms.uSunG = rgb.g;
      uniforms.uSunB = rgb.b;

      // Night light: its own term, so Sun.intensity (shadows, game logic) never hears of it
      const night = this.nightRGB;
      Sun.nightLightRGB(night);
      uniforms.uNightR = night[0];
      uniforms.uNightG = night[1];
      uniforms.uNightB = night[2];
    } else {
      // Sun disabled - no sun contribution
      uniforms.uSunIntensity = 0;
      uniforms.uNightR = 0;
      uniforms.uNightG = 0;
      uniforms.uNightB = 0;
    }

  }

  /** DX-FACES: towards the sun in the floor's space, from the shadows' direction on the screen and its elevation. */
  writeFaceSun() {
    const a = (Sun.elevation * Math.PI) / 180;
    const sinE = Math.sin(a);
    const cosE = Math.cos(a);
    const dirX = Sun.shadowDirX;
    const dirY = Sun.shadowDirY / (this.worker._groundScaleY || 1);
    const len = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
    const sun = this.faceSun;
    sun[0] = (-dirX / len) * cosE;
    sun[1] = (-dirY / len) * cosE;
    sun[2] = sinE;
    sun[3] = 1 / (sinE > 0.25 ? sinE : 0.25);
    // DX-BARRIOS: the sun's share that follows where a face looks; the rest is its sky (Sun.skyLight), on every face.
    this.faceLight[3] = 1 - Sun.skyLight;
  }

  _stampLightCamera(uniforms, cameraX, cameraY, zoom) {
    uniforms.uCameraPos[0] = cameraX;
    uniforms.uCameraPos[1] = cameraY;
    uniforms.uZoom = zoom;
    const rc = uniforms.uCameraRot;
    if (!rc) return;
    const rot = this.worker._renderCameraRot || 0;
    rc[0] = Math.cos(rot);
    rc[1] = Math.sin(rot);
  }

  /**
   * DX-BARRIOS: the light pass made again (faces turned on after it was made): what createLightingSystem put on the stage
   * and in its targets goes, unbound first (as a resize unbinds), and it makes them again, now with the face map.
   */
  _rebuildLightPass() {
    if (!this.lightingMesh) return;
    const empty = PIXI.Texture.EMPTY.source;
    const res = this.lightingShader?.resources;
    if (res) {
      if (res.uFaceMap) res.uFaceMap = empty;
      if (res.uFaceIds) res.uFaceIds = empty;
    }
    if (this.unshadedComposite !== null) {
      this.unbindUnshadedLayer();
      this.unshadedComposite.removeFromParent();
      this.unshadedComposite = null;
    }
    this._releaseLightEdges();
    this.releaseGbufTarget();
    if (this.lightingDisplaySprite) {
      this.lightingDisplaySprite.removeFromParent();
      this.lightingDisplaySprite.destroy();
      this.lightingDisplaySprite = null;
    } else {
      this.lightingMesh.removeFromParent();
    }
    for (const rt of [this.faceRT, this.faceIdsRT, this.unshadedRT, this.lightingRT]) if (rt) rt.destroy(true);
    this.faceRT = null;
    this.faceIdsRT = null;
    this.unshadedRT = null;
    this.lightingRT = null;
    this.lightingMesh = null;
    this.createLightingSystem();
    this.worker.pixiApp?.stage?.sortChildren();
  }

  /**
   * uViewport is the real framebuffer (gl_FragCoord). Display scale is canvas/RT
   * so a nominal 0.5 and 0.25 still land on the same screen pixel.
   */
  applyLightingViewport(canvasW, canvasH) {
    const u = this.lightingShader && this.lightingShader.resources.uniforms.uniforms;
    const rt = this.lightingRT;
    const vw = rt ? rt.width : canvasW;
    const vh = rt ? rt.height : canvasH;
    this.lightingPixelScale = rtPixelScale(canvasW, vw);
    if (!u) return;
    u.uViewport[0] = vw;
    u.uViewport[1] = vh;
    u.uFullCanvasSize[0] = canvasW;
    u.uFullCanvasSize[1] = canvasH;
    u.uInvResolution = canvasW > 0 && vw > 0 ? canvasW / vw : 1;
    // Canvas WebGL: gl_FragCoord.y is the bottom. Pixi entities are top-left.
    // An RT sprite samples the texture flipped, so that path stays unflipped.
    u.uFlipY = !rt && !this.worker._useWebGpu ? 1 : 0;
  }

  /** The shadow maps' texels per canvas px: the canvas at lighting.shadowResolution, rounded to whole texels. */
  shadowPixelScale() {
    return rtPixelScale(this.worker.canvasWidth, rtPixelSize(this.worker.canvasWidth, this.worker.shadowResolution));
  }


  /**
   * An additive light splat (LiquidFun lit groups, particle lights), or null
   * when the light-splat shaders are missing.
   */
  _createLightSplat(capacity, label) {
    const shaders = this.worker._useWebGpu
      ? { lfSplat: this.worker._engineShaders.lfLightSplat }
      : {
        lfSplatVert: this.worker._engineShaders.lfLightSplatVert,
        lfSplatFrag: this.worker._engineShaders.lfLightSplatFrag,
      };
    if (this.worker._useWebGpu && !shaders.lfSplat) return null;
    if (!this.worker._useWebGpu && (!shaders.lfSplatVert || !shaders.lfSplatFrag)) return null;
    const splat = new LiquidFunDensitySplat({
      capacity,
      label,
      blendMode: 'add',
      useWebGpu: this.worker._useWebGpu,
      shaders,
      shaderResources: {
        uniforms: {
          uInvScreenScale: { value: 1.0, type: 'f32' },
          uGroundAxes: { value: new Float32Array([1, 0, 0, 1]), type: 'vec4<f32>' },
        },
      },
    });
    splat.mesh.blendMode = 'add';
    // DX-LIGHTEDGES: in RGB alone, so the light target's alpha keeps the light pass's floor mark.
    splat.lightHost = rgbOnlyHost(splat.mesh, this.worker._useWebGpu);
    return splat;
  }

  /** Draw a packed light splat into the lighting RT. */
  _drawLightSplat(splat, resolution) {
    const screenScale = (this.worker._renderZoom || 1) * (resolution || 1);
    const u = splat.shader?.resources?.uniforms?.uniforms;
    if (u) {
      u.uInvScreenScale = screenScale > 0 ? 1 / screenScale : 0;
      // The splat is packed on screen: world x is (cos, sin) there and world y (-sin, cos), y foreshortened.
      const axes = u.uGroundAxes;
      if (axes) {
        const rot = this.worker._renderCameraRot || 0;
        const c = rot ? Math.cos(rot) : 1;
        const s = rot ? Math.sin(rot) : 0;
        const g = this.worker._groundScaleY || 1;
        axes[0] = c;
        axes[1] = s;
        axes[2] = -s * g;
        axes[3] = c * g;
      }
    }
    const rtOpts = this.worker._rtRenderOptsNoClear;
    rtOpts.container = splat.lightHost !== null ? splat.lightHost : splat.mesh;
    rtOpts.target = this.lightingRT;
    this.worker._submitRender(rtOpts);
  }

  createLiquidFunLightSplat(lfMax) {
    const cap = lfMax | 0;
    if (cap <= 0) return;
    this.lfLightSplat = this._createLightSplat(cap, 'lf-light-splat');
  }

  createParticleLightSplat(maxLights) {
    const cap = maxLights | 0;
    if (cap <= 0 || !this.worker._particleLightsEnabled) return;
    this.particleLightSplat = this._createLightSplat(cap, 'particle-light-splat');
  }

  _renderLiquidFunLightingField() {
    const splat = this.lfLightSplat;
    if (!splat || !this.lightingRT) return;
    const views = LiquidFun.getViews();
    const groups = LiquidFun.getGroupViews();
    const o = this.lfLightOpts;
    o.zoom = this.worker._renderZoom;
    o.cameraX = this.worker._renderCameraX;
    o.cameraY = this.worker._renderCameraY;
    o.cameraRot = this.worker._renderCameraRot || 0;
    o.resolution = this.lightingPixelScale || this.worker.lightingResolution;
    o.canvasW = this.worker.canvasWidth;
    o.canvasH = this.worker.canvasHeight;
    const packed = splat.uploadLitGroups(views, groups, o);
    if (packed <= 0) return;
    this._drawLightSplat(splat, o.resolution);
  }

  _renderParticleLightingField() {
    const splat = this.particleLightSplat;
    if (!splat || !this.lightingRT) return;
    const active = this.worker._takeActiveParticles();
    const lightSqrt = ParticleComponent.lightSqrt;
    if (!active || !(active[0] > 0) || !lightSqrt) return;
    const o = this.particleLightOpts;
    o.zoom = this.worker._renderZoom;
    o.cameraX = this.worker._renderCameraX;
    o.cameraY = this.worker._renderCameraY;
    o.cameraRot = this.worker._renderCameraRot || 0;
    o.resolution = this.lightingPixelScale || this.worker.lightingResolution;
    o.canvasW = this.worker.canvasWidth;
    o.canvasH = this.worker.canvasHeight;
    const pcfg = this.worker.config && this.worker.config.particle;
    o.zenithalMaxHeight = resolveZenithalMaxHeight(pcfg);
    o.zenithalAlphaFade = pcfg && pcfg.zenithalAlphaFade > 0 ? pcfg.zenithalAlphaFade : 0;
    o.layerVisible = Layer._visible;
    o.layerAlpha = Layer._alpha;
    o.max = this.worker._particleLightMax;
    const views = this.particleLightViews;
    views.active = active;
    views.lightSqrt = lightSqrt;
    views.x = ParticleComponent.x;
    views.y = ParticleComponent.y;
    views.z = ParticleComponent.z;
    views.alpha = ParticleComponent.alpha;
    views.tint = ParticleComponent.tint;
    views.flat = ParticleComponent.flat;
    views.viewMode = ParticleComponent.viewMode;
    views.renderOnly = ParticleComponent.renderOnly;
    views.layerMask = ParticleComponent.layerMask;
    const packed = packParticleLights(splat.data, splat.dataU32, splat.capacity, views, o);
    if (packed <= 0) {
      splat.geometry.instanceCount = 0;
      splat.mesh.visible = false;
      return;
    }
    splat.buffer.update(packed * LF_SPLAT_STRIDE);
    splat.geometry.instanceCount = packed;
    splat.mesh.visible = true;
    this._drawLightSplat(splat, o.resolution);
  }

  /**
   * OL-4: the walls' rows pre-render published for this frame (lampWallRow.js: a row a lamp with walls in its reach) and
   * their texture. Rows a frame does not use are left as they were: no lamp's tag points at them.
   * @param {{ maxLights: number, maxPolygonVertices: number, rowsA: SharedArrayBuffer, rowsB: SharedArrayBuffer }} vp
   */
  initWallRows(vp) {
    const layout = wallRowsLayout(vp.maxLights, vp.maxPolygonVertices);
    const sabs = [vp.rowsA, vp.rowsB];
    for (let b = 0; b < 2; b++) {
      this.wallRowBuffers[b] = {
        header: new Int32Array(sabs[b], 0, layout.headerInts),
        f32: new Float32Array(sabs[b], layout.rowsByte, layout.lights * layout.rowFloats),
        // OL-13: each row as views of 512, 1024, 2048 ... floats (a row's width at most), made the first time a row of
        // that length is read: a row is copied out with one set() of the shortest that holds it.
        views: [],
      };
    }
    this.wallSignatureAt = layout.signatureAt;
    this.wallSentLo = 0;
    this.wallSentHi = 0;
    this.wallRowFloats = layout.rowFloats;
    this.wallRowTexels = layout.rowTexels;
    this.wallRowsData = new Float32Array(layout.lights * layout.rowFloats);
    this.wallRowLamps = new Int32Array(layout.lights);
    this.wallRowLampCount = 0;
    this.wallRowsSource = PIXI.TextureSource.from({
      resource: this.wallRowsData,
      width: layout.rowTexels,
      height: layout.lights,
      format: 'rgba32float',
      scaleMode: 'nearest',
      addressMode: 'clamp-to-edge',
      autoGenerateMipmaps: false,
      label: 'weed-wall-rows',
    });
    this.wallRowsSource.uploadMethodId = this.worker._useWebGpu ? 'external' : 'unknown';
    this.wallRowsOn = true;
  }

  /**
   * OL-4: this frame's rows: which lamp has which (for _packLightData's tags), and the rows in use copied and sent up.
   */
  readWallRows() {
    const syncFrame = this.worker.renderQueueSync ? Atomics.load(this.worker.renderQueueSync, 0) : 0;
    const buf = this.wallRowBuffers[syncFrame > 0 ? (syncFrame - 1) & 1 : 0];
    if (buf === null) return;
    const entities = Transform.x ? Transform.x.length : 0;
    // OL-10: pre-render signs a frame's rows (its lamps in order, each row's inputs). The same signature as the rows
    // last sent up: the same lamps hold the same rows, the texture has them and the lamps' tags stand. A second word
    // of 0 is no signature (a lamp moved, or lighting.wallCache is off).
    const sigLo = buf.header[this.wallSignatureAt];
    const sigHi = buf.header[this.wallSignatureAt + 1];
    if (sigHi !== 0 && sigLo === this.wallSentLo && sigHi === this.wallSentHi && this.wallRowOf.length === entities) {
      this.wallRowsSkipped++;
      return;
    }
    this.wallSentLo = sigLo;
    this.wallSentHi = sigHi;
    if (this.wallRowOf.length !== entities) this.wallRowOf = new Int16Array(entities);
    const rowOf = this.wallRowOf;
    const lamps = this.wallRowLamps;
    for (let i = 0; i < this.wallRowLampCount; i++) {
      const lamp = lamps[i];
      if (lamp >= 0 && lamp < entities) rowOf[lamp] = 0;
    }
    const header = buf.header;
    let count = header[0];
    if (count > lamps.length) count = lamps.length;
    if (count < 0) count = 0;
    const rowFloats = this.wallRowFloats;
    const src = buf.f32;
    const dst = this.wallRowsData;
    const views = buf.views || (buf.views = []);
    // The widest row in use, in texels: the upload sends that many columns of each row, not the row's whole width (a
    // row is as wide as lighting.maxPolygonVertices allows, a polygon usually a tenth of it).
    let usedTexels = 1;
    for (let r = 0; r < count; r++) {
      const lamp = header[1 + r];
      lamps[r] = lamp;
      if (lamp >= 0 && lamp < entities) rowOf[lamp] = r + 1;
      // The row's floats in use: its header, its directions and its vertices with the closing one.
      const o = r * rowFloats;
      const n = src[o] | 0;
      const used = n >= 3 ? 4 * (WALL_VERT0 + n + 1) : 4;
      // OL-13: one set() from a view of the row, the shortest of 512, 1024 ... floats that holds what is in use (a
      // float at a time it was 0.5 ms a frame for 720 rows, the lamps moving).
      let c = 0;
      let len = 512;
      while (len < used) {
        len *= 2;
        c++;
      }
      if (len > rowFloats) len = rowFloats;
      let ofLength = views[c];
      if (ofLength === undefined) ofLength = views[c] = [];
      let view = ofLength[r];
      if (view === undefined) view = ofLength[r] = new Float32Array(src.buffer, src.byteOffset + o * 4, len);
      dst.set(view, o);
      if (used > 4 * usedTexels) usedTexels = used >> 2;
    }
    this.wallRowLampCount = count;
    if (count === 0) return;
    const source = this.wallRowsSource;
    const width = this.wallRowTexels;
    const height = lamps.length;
    if (this.worker._useWebGpu) {
      const renderer = this.worker.pixiApp?.renderer;
      if (renderer?.gpu?.device) writeRgba32Float(renderer, source, dst, width, height, 'weed-wall-rows', usedTexels, count);
    } else {
      this.worker._uploadRgba32FloatGl(source, dst, width, height, usedTexels, count);
    }
  }

  /** DX-FACES: the face map's texture, nearest (its texels are codes), at the light pass's size. */
  createFaceMap(width, height) {
    this.faceRT = PIXI.RenderTexture.create({ width, height, scaleMode: 'nearest' });
    // N-272: the area drawn, a texel inside each edge (the pass's transform is moved a texel to match).
    this.faceRtFrame.width = Math.max(1, this.faceRT.width - 2);
    this.faceRtFrame.height = Math.max(1, this.faceRT.height - 2);
    this.faceRtLayer.resolution = this.worker.lightingResolution;
    this.faceCamera[0] = NaN; // a turned camera's transform holds the canvas's size
    const res = this.lightingShader?.resources;
    if (res) res.uFaceMap = this.faceRT.source;
    // DX-GBUF: the entity ids map, the face map's size and layout.
    if (this.faceIdsOn) {
      this.faceIdsRT = PIXI.RenderTexture.create({ width, height, scaleMode: 'nearest' });
      if (res) res.uFaceIds = this.faceIdsRT.source;
    }
  }

  /**
   * DX-FACEDEPTH: whether the entities' depth reads faces: once a decoration carries a normal (DecorationPool.facesInUse).
   */
  faceDepthWanted() {
    return DecorationPool.facesInUse();
  }

  /**
   * DX-BARRIOS: faces have no switch. Once a decoration carries a normal (DecorationPool.facesInUse: normally the first frame,
   * as a scene's create() spawns them): the entities' depth reads faces (DX-FACEDEPTH; an oblique scene without a map sheet
   * turns pixel depth on for them), and a lit scene's light pass, made again, reads the face map. Once.
   */
  useFaces() {
    this.worker._facesUsed = true;
    const batch = this.worker.entitiesBatch;
    if (batch) {
      if (batch.pixelDepthOn) batch.setDepthFaces(true);
      else if (this.worker._pixelDepthWanted()) batch.enablePixelDepth(this.worker.assets.atlasMapsSource ?? this.emptyMapsSource(), true);
      this.worker._placeDepthMeshes();
    }
    if (this.worker.lightingEnabled && this.worker._facesWatch && !this.worker._facesOn) {
      this.worker._facesOn = true;
      this._rebuildLightPass();
    }
  }

  /**
   * DX-FACES: what each pixel of this frame is, in painter order, for the light pass. DX-GBUF: and, with the ids map, what
   * entity covers it, in a pass of its own over the same instances (lighting.gbuffer 'pass').
   */
  _renderFaceMap() {
    const batch = this.worker.entitiesBatch;
    const maps = this.worker.assets.atlasMapsSource ?? this.emptyMapsSource();
    const mesh = batch !== null ? batch.faceMesh(this.worker._heightScaleY, this.worker._groundScaleY || 1, maps) : null;
    const opts = this.worker._rtRenderOpts;
    opts.container = mesh !== null && batch.mesh.visible ? mesh : this.worker._rtEmptyContainer;
    opts.target = this.faceRT;
    opts.clear = true;
    opts.clearColor = this.worker._clearTransparent;
    // Once a frame this stays in the baseline tiers, where every double it works out is a heap number: a still camera
    // works out none.
    const seen = this.faceCamera;
    const rot = this.worker._renderCameraRot || 0;
    if (seen[0] !== this.worker._renderCameraX || seen[1] !== this.worker._renderCameraY || seen[2] !== this.worker._renderZoom || seen[3] !== rot) {
      seen[0] = this.worker._renderCameraX;
      seen[1] = this.worker._renderCameraY;
      seen[2] = this.worker._renderZoom;
      seen[3] = rot;
      const mx = this.worker._writeCameraRtTransform(this.faceRtTransform, this.faceRtLayer);
      // N-272: the frame's projection starts at its corner (1, 1): a texel back, each pixel lands where it did.
      mx.tx -= 1;
      mx.ty -= 1;
    }
    opts.transform = this.faceRtTransform;
    // N-272: drawn inside the edge ring (the clear still clears the whole target, the ring with it).
    opts.frame = this.faceRtFrame;
    const mrt = this.worker._gbufMrt && this.faceIdsRT !== null ? this.ensureGbufTarget() : null;
    if (mrt !== null) {
      // DX-GBUF (lighting.gbuffer 'mrt'): both targets in this one pass.
      const both = batch !== null ? batch.gbufMesh(this.worker._heightScaleY, this.worker._groundScaleY || 1, maps) : null;
      opts.container = both !== null && batch.mesh.visible ? both : this.worker._rtEmptyContainer;
      opts.target = mrt;
      this.worker._submitRender(opts);
      opts.transform = null;
      opts.frame = null;
      return;
    }
    this.worker._submitRender(opts);
    if (this.faceIdsRT !== null) {
      const ids = batch !== null ? batch.idsMesh(this.worker._heightScaleY, this.worker._groundScaleY || 1, maps) : null;
      opts.container = ids !== null && batch.mesh.visible ? ids : this.worker._rtEmptyContainer;
      opts.target = this.faceIdsRT;
      this.worker._submitRender(opts);
      this.worker._gpuPassesThisFrame++;
    }
    opts.transform = null;
    opts.frame = null;
  }

  /** DX-MAPS: a 1 × 1 twin page that says "no map", for the faces' pass when no sheet has maps. */
  emptyMapsSource() {
    if (this.noMapsSource === null) {
      this.noMapsSource = PIXI.TextureSource.from({
        resource: new Uint8Array(4),
        width: 1,
        height: 1,
        format: 'rgba8unorm',
        scaleMode: 'nearest',
        addressMode: 'clamp-to-edge',
        autoGenerateMipmaps: false,
        alphaMode: 'no-premultiply-alpha',
      });
    }
    return this.noMapsSource;
  }

  /**
   * DX-GBUF (lighting.gbuffer 'mrt'): the render target whose colour targets are the face map and the entity ids map (Pixi's
   * RenderTarget, its class the canvas's target's: the bundle exports none), for the G-buffer's one pass; null where it
   * cannot be made (the passes then draw a target each).
   */
  ensureGbufTarget() {
    // N-274: with pixel depth the one pass tests and writes depth: a target with a depth attachment, made again if that changed.
    const depth = !!this.worker.entitiesBatch?.gbufDepthOn;
    if (this.gbufTarget !== null && this.gbufTargetDepth === depth) return this.gbufTarget;
    if (this.gbufTarget !== null) this.releaseGbufTarget();
    const RenderTargetClass = this.worker.pixiApp?.renderer?.view?.renderTarget?.constructor;
    if (typeof RenderTargetClass !== 'function' || this.faceRT === null || this.faceIdsRT === null) {
      this.worker._gbufMrt = false;
      return null;
    }
    this.gbufTarget = new RenderTargetClass({
      colorTextures: [this.faceRT, this.faceIdsRT], depthStencilTexture: depth, label: 'weed-gbuffer',
    });
    this.gbufTargetDepth = depth;
    return this.gbufTarget;
  }

  /**
   * DX-GBUF: the G-buffer's one-pass target goes before its textures do (a resize remakes them): its GPU side through the
   * render target system's records (Pixi releases a texture's own target when the texture goes, not one made of several).
   */
  releaseGbufTarget() {
    const target = this.gbufTarget;
    if (target === null) return;
    this.gbufTarget = null;
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

  _createUnshadedLayer() {
    const width = this.worker.canvasWidth;
    const height = this.worker.canvasHeight;
    // DBG-3: it fades with the lighting layer (syncLayerAlphaFromSharedState), from the alpha that layer has now.
    const lightingId = Layer.lighting?.id;
    const alpha = lightingId !== undefined && Layer._alpha ? Layer._alpha[lightingId] : 1;
    this.unshadedRT = PIXI.RenderTexture.create({ width, height });
    if (this.lightEdges !== null) {
      // DX-LIGHTEDGES: the two halves over the light host's stencil marks, drawn right after it (same zIndex, added later).
      this.unshadedEdges = unshadedEdgesHost(this.worker._lightEdgesEnv(), this.lightEdgesGeometry, this.lightingRT.source, this.unshadedRT.source);
      const host = this.unshadedEdges.host;
      host.visible = false;
      host.alpha = alpha;
      host.zIndex = this.lightEdges.host.zIndex;
      this.unshadedComposite = host;
      this.worker.pixiApp.stage.addChild(host);
      this.worker.pixiApp.stage.sortChildren();
      return;
    }
    unshadedQuadPositions(this.unshadedQuad, width, height);
    this.unshadedQuadBuffer = new Buffer({ data: this.unshadedQuad, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    const geometry = new PIXI.Geometry({
      attributes: {
        aPosition: { buffer: this.unshadedQuadBuffer, format: 'float32x2', stride: 8, offset: 0 },
        aUV: [0, 0, 1, 0, 1, 1, 0, 1],
      },
      indexBuffer: [0, 1, 2, 0, 2, 3],
    });
    const glow = this.unshadedRT.source;
    const light = this.lightingRT.source;
    const shader = this.worker._useWebGpu
      ? new PIXI.Shader({
          gpuProgram: unshadedCompositeGpuProgram(GpuProgram),
          resources: { uUnshaded: glow, uUnshadedSampler: glow.style, uLight: light, uLightSampler: light.style },
        })
      : new PIXI.Shader({
          glProgram: PIXI.GlProgram.from({ vertex: UNSHADED_COMPOSITE_VERT, fragment: UNSHADED_COMPOSITE_FRAG, name: 'weed-glow' }),
          resources: { uUnshaded: glow, uLight: light },
        });
    const state = new PIXI.State();
    state.blendMode = 'add';
    state.depthTest = false;
    state.depthMask = false;
    state.culling = false;
    const mesh = new PIXI.Mesh({ geometry, shader, state, label: 'weed-glow' });
    mesh.blendMode = 'add';
    mesh.cullable = false;
    mesh.visible = false;
    mesh.alpha = alpha;
    mesh.zIndex = this.lightingDisplaySprite ? this.lightingDisplaySprite.zIndex : 0;
    this.unshadedComposite = mesh;
    this.worker.pixiApp.stage.addChild(mesh);
    this.worker.pixiApp.stage.sortChildren();
  }

  /** DX-UNSHADED: the unshaded layer's targets as the light's and the unshaded's are now (a resize remakes them). */
  bindUnshadedLayer() {
    const mesh = this.unshadedComposite;
    if (mesh === null || this.unshadedRT === null || this.lightingRT === null) return;
    if (this.unshadedEdges !== null) {
      this.bindLightEdges(this.lightingRT.source, this.unshadedRT.source);
      return;
    }
    const res = mesh.shader.resources;
    const glow = this.unshadedRT.source;
    const light = this.lightingRT.source;
    if (res.uUnshaded !== glow) res.uUnshaded = glow;
    if (res.uLight !== light) res.uLight = light;
    if (this.worker._useWebGpu) {
      if (res.uUnshadedSampler !== glow.style) res.uUnshadedSampler = glow.style;
      if (res.uLightSampler !== light.style) res.uLightSampler = light.style;
    }
  }

  unbindUnshadedLayer() {
    const mesh = this.unshadedComposite;
    if (mesh === null) return;
    if (this.unshadedEdges !== null) {
      const empty = PIXI.Texture.EMPTY.source;
      this.bindLightEdges(empty, empty);
      return;
    }
    const res = mesh.shader.resources;
    const empty = PIXI.Texture.EMPTY.source;
    if (res.uUnshaded !== empty) res.uUnshaded = empty;
    if (res.uLight !== empty) res.uLight = empty;
    if (this.worker._useWebGpu) {
      if (res.uUnshadedSampler !== empty.style) res.uUnshadedSampler = empty.style;
      if (res.uLightSampler !== empty.style) res.uLightSampler = empty.style;
    }
  }

  /**
   * DX-UNSHADED: this frame's unshaded pixels, while a sheet or a sprite is unshaded: the entities again into the unshaded
   * target (the canvas's size, as they land on it), and the unshaded layer shown with the lighting layer; else hidden.
   */
  _renderUnshaded() {
    const mesh = this.unshadedComposite;
    if (mesh === null || this.unshadedRT === null) return;
    const on = (this.worker.assets.atlasUnshaded || SpriteRenderer.unshadedUsers() > 0) && layerIsVisible(Layer.lighting?.id);
    if (!on) {
      if (mesh.visible) mesh.visible = false;
      return;
    }
    const batch = this.worker.entitiesBatch;
    const maps = this.worker.assets.atlasMapsSource ?? this.emptyMapsSource();
    // E-457: the unshaded mask (an unshaded word or sheet), then the unshaded pass drawn where it marked
    // (InstancedSpriteBatch.unshadedPass).
    const pass = batch !== null && batch.mesh.visible ? batch.unshadedPass(this.worker._heightScaleY, this.worker._groundScaleY || 1, maps) : null;
    const opts = this.worker._rtRenderOpts;
    opts.container = pass !== null ? pass : this.worker._rtEmptyContainer;
    opts.target = this.unshadedRT;
    opts.clear = true;
    opts.clearColor = this.worker._clearTransparent;
    opts.transform = this.worker._writeCameraRtTransform(this.unshadedRtTransform, this.unshadedRtLayer);
    this.worker._submitRender(opts);
    opts.transform = null;
    this.worker._gpuPassesThisFrame++;
    const display = this._lightingDisplay();
    if (display && mesh.zIndex !== display.zIndex) mesh.zIndex = display.zIndex;
    if (!mesh.visible) mesh.visible = true;
  }

  /** DX-LIGHTEDGES: the light's host (lightEdges.js) over the canvas quad, in the lighting layer's place. */
  _createLightEdges() {
    unshadedQuadPositions(this.lightEdgesQuad, this.worker.canvasWidth, this.worker.canvasHeight);
    this.lightEdgesQuadBuffer = new Buffer({ data: this.lightEdgesQuad, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    this.lightEdgesGeometry = lightEdgesQuad(this.lightEdgesQuadBuffer);
    this.lightEdges = lightEdgesHost(this.worker._lightEdgesEnv(), this.lightEdgesGeometry, this.lightingRT.source);
    this.worker._registerLayerDisplayObject('lighting', this.lightEdges.host);
    this.setLightEdgesBlend(Layer.get('lighting')?.blendMode ?? 'multiply');
    this.worker.pixiApp.stage.addChild(this.lightEdges.host);
  }

  /** The lighting layer's blend on the edges' two light meshes (multiply unless game code or the debug UI chose another). */
  setLightEdgesBlend(blend) {
    if (this.lightEdges === null) return;
    const meshes = this.lightEdges.meshes;
    for (let i = 0; i < meshes.length; i++) {
      if (meshes[i].blendMode !== blend) meshes[i].blendMode = blend;
    }
  }

  /** DX-LIGHTEDGES: the lighting layer's display: the edges' host, or the stretched sprite. */
  _lightingDisplay() {
    return this.lightEdges !== null ? this.lightEdges.host : this.lightingDisplaySprite;
  }

  /**
   * DX-LIGHTEDGES: every mesh of the edges' hosts on `light` (and the unshaded halves on `unshaded`): EMPTY before a
   * resize replaces the targets (_replaceRT destroys the bind groups still listening on the old ones), the new ones after.
   */
  bindLightEdges(light, unshaded) {
    if (this.lightEdges !== null) {
      const meshes = this.lightEdges.meshes;
      for (let i = 0; i < meshes.length; i++) {
        const res = meshes[i].shader.resources;
        if (res.uLight !== light) res.uLight = light;
      }
    }
    if (this.unshadedEdges !== null) {
      const meshes = this.unshadedEdges.meshes;
      for (let i = 0; i < meshes.length; i++) {
        const res = meshes[i].shader.resources;
        if (res.uLight !== light) res.uLight = light;
        if (res.uUnshaded !== unshaded) res.uUnshaded = unshaded;
        if (this.worker._useWebGpu && res.uUnshadedSampler !== unshaded.style) res.uUnshadedSampler = unshaded.style;
      }
    }
  }

  /** DX-LIGHTEDGES: the hosts off the stage and destroyed (a light pass made again, or a teardown). */
  _releaseLightEdges() {
    const empty = PIXI.Texture.EMPTY.source;
    this.bindLightEdges(empty, empty);
    if (this.lightEdges !== null) {
      this.lightEdges.host.removeFromParent();
      this.lightEdges.host.destroy({ children: true });
      this.lightEdges = null;
    }
    this.unshadedEdges = null;
  }
}
