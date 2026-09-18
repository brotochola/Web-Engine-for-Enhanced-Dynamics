// Layer.js - Rendering layer system: ordered slots with a kind
// Static class with facade instances, backed by SharedArrayBuffer
//
// ARCHITECTURE:
// - Built-in pipeline layers (entities, decals, castedShadows, lighting)
// - Custom layers in scene config.layers (sprites, density, compute, mesh, or scenery)
// - Scenery kinds (cover / static / tiling / tilemap) are scene-owned — no default background
// - Each Layer instance is a lightweight facade over SAB arrays (like GameObject)
// - Layer.water.setUniform('uThreshold', 0.4) works from any thread
//
// LAYER ROUTING:
// - Renderables subscribe via layerMask (Uint16, bit = Layer.id). See Layer.resolveSubscriptions.
// - GameObject.setLayer / setLayers; emit/spawn `layer` / `layers`.
// - Each layer's config picks the pipeline (sprites, density splat, compute pack).
//
// THREAD SAFETY:
// - Config arrays written once at init (read-only after), except alpha
//   which is mutable from any worker via Atomics dirty flag
// - Uniform arrays use Atomics dirty flag for safe cross-worker writes
// - _postToRenderer is a main-thread-only callback (not cross-worker)

import {
    LAYER_DEFAULTS,
    LAYER_DENSITY_SOURCE,
    LAYER_SPLAT_FALLOFF,
    LAYER_SCALE_MODE,
    LAYER_COMPUTE_SOURCE,
    LAYER_FEEDER_KIND,
    LAYER_KIND,
    LAYER_SUBSCRIBE_KIND,
    COMPUTE_LAYER_DEFAULT_MAX_BODIES,
    COMPUTE_LAYER_DEFAULT_MAX_PARTICLES,
    isSceneryKind,
    isSkipSubscribeKind,
} from '../util/configDefaults.js';
import {
    normalizeCoverBackgroundOptions,
    normalizeWorldParallax,
} from '../render/coverBackground.js';

/**
 * Engine-reserved look uniforms, auto-declared on every custom shader layer
 * and fed every frame by applyEngineLookUniforms in pixi_worker. Scenes use
 * them in WGSL/GLSL without declaring them in config. Scene defs win on
 * name collision (only the scene's initial value is kept).
 */
export const RESERVED_LOOK_UNIFORMS = {
    uTime: { value: 0, type: 'f32' },
    uDt: { value: 0, type: 'f32' },
    uZoom: { value: 1, type: 'f32' },
    uCameraPos: { value: [0, 0], type: 'vec2<f32>' },
    uCanvasSize: { value: [0, 0], type: 'vec2<f32>' },
    uWorldSize: { value: [0, 0], type: 'vec2<f32>' },
    uViewSize: { value: [0, 0], type: 'vec2<f32>' },
    uTexSize: { value: [0, 0], type: 'vec2<f32>' },
};

/** @param {string} name */
export function isReservedLookUniform(name) {
    return name in RESERVED_LOOK_UNIFORMS;
}

/**
 * SAB float count of {@link RESERVED_LOOK_UNIFORMS} with the same vec2/vec4 pad
 * as {@link Layer._allocateUniformSAB}.
 */
export function reservedLookUniformFloatCount() {
    let floatCount = 0;
    const names = Object.keys(RESERVED_LOOK_UNIFORMS);
    for (let i = 0; i < names.length; i++) {
        const size = Layer._getUniformSize(RESERVED_LOOK_UNIFORMS[names[i]].type);
        if (size === 2) floatCount = (floatCount + 1) & ~1;
        else if (size >= 3) floatCount = (floatCount + 3) & ~3;
        floatCount += size;
    }
    return floatCount;
}

/** Panel hint keys carried into metadata (LayersPanel widgets). */
const UNIFORM_HINT_KEYS = ['min', 'max', 'step', 'label', 'tip', 'negate', 'widget'];

const LEGACY_FEED_NONE = 255;

function isAllCapsName(name) {
    return typeof name === 'string' && name.length > 1 && name === name.toUpperCase() && /[A-Z]/.test(name);
}

export class Layer {
    static MAX_LAYERS = 16;
    static entitiesId = -1; // Set during init when entities is registered
    static _defaultYSorting = true;

    // Registry
    static _byName = {};
    static _byId = [];
    static count = 0;
    static initialized = false;

    // Config SAB and typed views (shared, read-only after init)
    static _configSAB = null;
    static _zIndex = null;            // Float32Array[MAX_LAYERS]
    static _blendModeId = null;       // Uint8Array[MAX_LAYERS]
    static _hasShader = null;         // Uint8Array[MAX_LAYERS]
    static _ySorting = null;          // Uint8Array[MAX_LAYERS]
    static _resolution = null;        // Float32Array[MAX_LAYERS]
    static _alpha = null;             // Float32Array[MAX_LAYERS]  (mutable via Atomics)
    static _alphaDirty = null;        // Int32Array[MAX_LAYERS]   (dirty flag for alpha)
    static _containerBlendId = null;  // Uint8Array[MAX_LAYERS]
    static _available = null;         // Uint8Array[MAX_LAYERS]
    static _hasRenderQueue = null;    // Uint8Array[MAX_LAYERS]
    static _visible = null;           // Uint8Array[MAX_LAYERS]  (mutable via Atomics)
    static _feederKind = null;        // Uint8Array[MAX_LAYERS]  (LAYER_FEEDER_KIND)
    static _visibleDirty = null;      // Int32Array[MAX_LAYERS]  (dirty flag for visible)
    // Plain (non-SAB) per-realm cache: OR of `1<<id` for every id where hasSpriteQueue(id)
    // is true. Recomputed locally after _feederKind/_hasRenderQueue are known (init or
    // initializeFromBuffers) — lets collectRenderable bit-scan `mask & _spriteQueueBits`
    // instead of looping 0..MAX_LAYERS and calling hasSpriteQueue/isLiquidFunDensityLayer
    // per bit.
    static _spriteQueueBits = 0;

    /** Per-layer compute feeder lists (SAB) — Collider pool indices subscribed to a compute layer. */
    static _feedCountSAB = null;
    static _feedCount = null; // Int32Array[MAX_LAYERS]
    static _feedLock = null; // Int32Array[MAX_LAYERS] spinlocks (same SAB, second half)
    static _feedIndexSABs = [];
    static _feedIndices = [];
    static _feedMax = [];
    static _feedOverflowWarned = 0;

    /** Same shape as above, for ParticleComponent pool indices (density + compute-particle layers). */
    static _particleFeedCountSAB = null;
    static _particleFeedCount = null; // Int32Array[MAX_LAYERS]
    static _particleFeedLock = null; // Int32Array[MAX_LAYERS] spinlocks (same SAB, second half)
    static _particleFeedIndexSABs = [];
    static _particleFeedIndices = [];
    static _particleFeedMax = [];
    static _particleFeedOverflowWarned = 0;

    // Per-layer uniform SABs (only for layers with shaders)
    static _uniformSABs = [];     // SharedArrayBuffer[] indexed by layer id
    static _uniformFloats = [];   // Float32Array[] indexed by layer id
    static _uniformDirty = [];    // Int32Array[1][] indexed by layer id
    static _uniformMaps = [];     // { name: { offset, size } }[] indexed by layer id

    // Blend mode ID -> PixiJS string. Indices match BLEND_MODES enum in configDefaults.js.
    static _BLEND_MODE_STRINGS = [
        'normal', 'inherit', 'add', 'multiply', 'screen', 'darken', 'lighten', 'erase',
        'color-dodge', 'color-burn', 'linear-burn', 'linear-dodge', 'linear-light',
        'hard-light', 'soft-light', 'pin-light', 'difference', 'exclusion', 'overlay',
        'saturation', 'color', 'luminosity', 'normal-npm', 'add-npm', 'screen-npm',
        'none', 'subtract', 'divide', 'vivid-light', 'hard-mix', 'negation', 'min', 'max',
    ];

    // LAYER_SCALE_MODE id -> Pixi TextureSource.scaleMode string.
    static _SCALE_MODE_STRINGS = ['linear', 'nearest'];

    // Metadata for serialization to workers
    static _metadata = null;

    // Cached getAll() result (rebuilt on count change)
    static _allCache = [];
    static _allCacheCount = -1;

    /**
     * Communication bridge to renderer worker.
     * Set by Scene during init: Layer._postToRenderer = (msg) => worker.postMessage(msg)
     * Main-thread only -- workers do not use this.
     * @type {function|null}
     */
    static _postToRenderer = null;

    /**
     * Pending Promise resolvers for async background operations, keyed by request id.
     * This lets overlapping background changes resolve the correct Promise instead of
     * using one global slot.
     * @type {Map<number, function>}
     */
    static _contentReadyResolvers = new Map();
    static _nextContentRequestId = 1;

    constructor(id, name) {
        this.id = id;
        this.name = name;
        this._kind = LAYER_KIND.SPRITES;
        this._content = null;
    }

    // ========================================
    // FACADE GETTERS / SETTERS (read from static SAB arrays via this.id)
    // ========================================

    get zIndex() { return Layer._zIndex[this.id]; }
    get resolution() { return Layer._resolution[this.id]; }
    /** Pixi upsample filter for shader RTs ({@link LAYER_SCALE_MODE}). */
    get scaleMode() { return this._scaleMode ?? LAYER_SCALE_MODE.LINEAR; }
    /**
     * Layer opacity (0.0 = fully transparent, 1.0 = fully opaque).
     * Mutable from any worker — writes go through the config SAB and the
     * renderer picks up changes via an Atomics dirty flag each frame.
     * @example Layer.get("LIGHTING").alpha = 0.5;
     */
    get alpha() { return Layer._alpha[this.id]; }
    set alpha(v) {
        Layer._alpha[this.id] = v;
        Atomics.store(Layer._alphaDirty, this.id, 1);
    }
    /**
     * Stage visibility. Mutable from any worker — SAB + Atomics dirty, same as alpha.
     * Renderer skips pack/RT for hidden layers and applies `.visible` after uploads.
     */
    get visible() { return Layer._visible[this.id] === 1; }
    set visible(v) {
        Layer._visible[this.id] = v ? 1 : 0;
        Atomics.store(Layer._visibleDirty, this.id, 1);
    }
    get hasShader() { return Layer._hasShader[this.id] === 1; }
    get ySorting() { return Layer._ySorting[this.id] === 1; }
    get available() { return Layer._available[this.id] === 1; }
    /** Returns the blend mode as a human-readable string (for debug UI / logging). */
    get blendMode() { return Layer._BLEND_MODE_STRINGS[Layer._blendModeId[this.id]] || 'normal'; }
    /** Returns the blend mode numeric id. */
    get blendModeId() { return Layer._blendModeId[this.id]; }
    /** Returns the container blend mode as a human-readable string (for debug UI / logging). */
    get containerBlendMode() { return Layer._BLEND_MODE_STRINGS[Layer._containerBlendId[this.id]] || 'normal'; }
    /** Returns the container blend mode numeric id. */
    get containerBlendModeId() { return Layer._containerBlendId[this.id]; }
    get hasRenderQueue() { return Layer._hasRenderQueue[this.id] === 1; }
    get builtIn() { return this._builtIn; }
    get kind() { return this._kind; }
    /** {@link LAYER_DENSITY_SOURCE} value (`SPRITES` or `LIQUID_FUN`). */
    get densitySource() { return this._densitySource ?? LAYER_DENSITY_SOURCE.SPRITES; }
    /** {@link LAYER_COMPUTE_SOURCE} or null. */
    get computeSource() { return this._computeSource ?? null; }
    /** Compute pass list / module names (read-only mirror). */
    get compute() { return this._compute || null; }
    /** Splat kernel controls when densitySource is liquidFun (read-only mirror). */
    get splat() { return this._splat || null; }

    /**
     * Live-tune LiquidFun density splat radius (world px). Renderer picks up next frame.
     * @param {number} worldPx
     * @returns {this}
     */
    setSplatRadius(worldPx) {
        if (!(worldPx > 0)) return this;
        if (!this._splat) {
            this._splat = Layer._normalizeSplat({}, LAYER_DENSITY_SOURCE.LIQUID_FUN);
        }
        this._splat.radius = worldPx;
        const meta = Layer._metadata?.layers?.[this.id];
        if (meta) meta.splat = { ...this._splat };
        if (Layer._postToRenderer) {
            Layer._postToRenderer({
                msg: 'setLayerProps',
                layer: this.name,
                splatRadius: worldPx,
            });
        }
        return this;
    }

    // ========================================
    // UNIFORM ACCESS (cross-worker safe via SAB + Atomics)
    // ========================================

    /**
     * Write a shader uniform on this layer (any thread; dirty flag for pixi).
     * @param {string} name
     * @param {number|number[]} value
     * @returns {Layer}
     */
    setUniform(name, value) {
        const map = Layer._uniformMaps[this.id];
        if (!map) return this;
        const entry = map[name];
        if (!entry) return this;

        const floats = Layer._uniformFloats[this.id];
        if (typeof value === 'number') {
            floats[entry.offset] = value;
        } else if (Array.isArray(value)) {
            for (let i = 0; i < entry.size && i < value.length; i++) {
                floats[entry.offset + i] = value[i];
            }
        }
        Atomics.store(Layer._uniformDirty[this.id], 0, 1);
        return this;
    }

    /**
     * Read a shader uniform (number or subarray).
     * @param {string} name
     * @returns {number|Float32Array|undefined}
     */
    getUniform(name) {
        const map = Layer._uniformMaps[this.id];
        if (!map) return undefined;
        const entry = map[name];
        if (!entry) return undefined;

        const floats = Layer._uniformFloats[this.id];
        if (entry.size === 1) return floats[entry.offset];
        return floats.subarray(entry.offset, entry.offset + entry.size);
    }

    // ========================================
    // SCENERY CONTROL (instance methods)
    // ========================================

    /**
     * World-stretch sprite (does not tile).
     * @param {string} textureId
     * @param {{parallax?:number|{x?:number,y?:number}}|number} [opts]
     */
    setStatic(textureId, opts) {
        if (!Layer._canHostScenery(this)) return;
        if (!Layer._postToRenderer) {
            console.warn('Layer: renderer not connected');
            return;
        }
        const p = normalizeWorldParallax(typeof opts === 'number' ? opts : opts?.parallax);
        this._kind = LAYER_KIND.STATIC;
        Layer._postContentCommand({
            msg: 'setLayerContent',
            type: LAYER_KIND.STATIC,
            layerId: this.id,
            textureId,
            parallaxX: p.x,
            parallaxY: p.y,
        });
    }

    /**
     * Viewport-cover image (fills the canvas, optional pan/zoom parallax).
     * @param {string|{texture?:string,textureId?:string,parallax?:number|{x?:number,y?:number},margin?:number,zoomParallax?:number}} textureOrOpts
     */
    setCover(textureOrOpts) {
        if (!Layer._canHostScenery(this)) return;
        if (!Layer._postToRenderer) {
            console.warn('Layer: renderer not connected');
            return;
        }
        const opts = normalizeCoverBackgroundOptions(textureOrOpts);
        if (!opts.texture) {
            console.warn('Layer.setCover: texture is required');
            return;
        }
        this._kind = LAYER_KIND.COVER;
        Layer._postContentCommand({
            msg: 'setLayerContent',
            type: LAYER_KIND.COVER,
            layerId: this.id,
            textureId: opts.texture,
            parallaxX: opts.parallaxX,
            parallaxY: opts.parallaxY,
            margin: opts.margin,
            zoomParallax: opts.zoomParallax,
        });
    }

    /**
     * Repeating TilingSprite.
     * @param {string} textureId
     * @param {number|{tileScale?:number,parallax?:number|{x?:number,y?:number}}} [tileScaleOrOpts=1]
     */
    setTiling(textureId, tileScaleOrOpts = 1) {
        if (!Layer._canHostScenery(this)) return;
        if (!Layer._postToRenderer) {
            console.warn('Layer: renderer not connected');
            return;
        }
        const opts = typeof tileScaleOrOpts === 'object' && tileScaleOrOpts
            ? tileScaleOrOpts
            : { tileScale: tileScaleOrOpts };
        const tileScale = Number.isFinite(opts.tileScale) ? opts.tileScale : 1;
        const p = normalizeWorldParallax(opts.parallax);
        this._kind = LAYER_KIND.TILING;
        Layer._postContentCommand({
            msg: 'setLayerContent',
            type: LAYER_KIND.TILING,
            layerId: this.id,
            textureId,
            tileScale,
            parallaxX: p.x,
            parallaxY: p.y,
        });
    }

    /**
     * Tiled map (@pixi/tilemap). Resolves after build + warm-up render.
     * @param {string} tilemapId
     * @param {object} [options={}] scale, layers, parallax
     * @returns {Promise<void>}
     */
    setTilemap(tilemapId, options = {}) {
        if (!Layer._canHostScenery(this)) {
            return Promise.resolve();
        }
        if (!Layer._postToRenderer) {
            console.warn('Layer: renderer not connected');
            return Promise.resolve();
        }
        const p = normalizeWorldParallax(options.parallax);
        this._kind = LAYER_KIND.TILEMAP;
        return new Promise((resolve) => {
            Layer._postContentCommand({
                msg: 'setLayerContent',
                type: LAYER_KIND.TILEMAP,
                layerId: this.id,
                tilemapId,
                options,
                parallaxX: p.x,
                parallaxY: p.y,
            }, resolve);
        });
    }

    /** Remove scenery content from this layer. */
    clear() {
        if (!Layer._canHostScenery(this)) return;
        if (!Layer._postToRenderer) {
            console.warn('Layer: renderer not connected');
            return;
        }
        Layer._postContentCommand({
            msg: 'setLayerContent',
            type: 'none',
            layerId: this.id,
        });
    }

    // ========================================
    // BUILT-IN LAYER SHORTCUTS
    // ========================================

    /** @returns {Layer} */ static get decals() { return this._byName['decals']; }
    /** @returns {Layer} */ static get castedShadows() { return this._byName['castedShadows']; }
    /** @returns {Layer} */ static get entities() { return this._byName['entities']; }
    /** @returns {Layer} */ static get lighting() { return this._byName['lighting']; }

    // ========================================
    // STATIC API
    // ========================================

    /**
     * Layer facade by name, or null.
     * @param {string} name
     * @returns {Layer|null}
     */
    static get(name) { return this._byName[name] || null; }
    /**
     * Layer facade by id, or null.
     * @param {number} id
     * @returns {Layer|null}
     */
    static getById(id) { return this._byId[id] || null; }
    /**
     * All registered layers (built-in + custom).
     * @returns {Layer[]}
     */
    static getAll() {
        if (this._allCacheCount !== this.count) {
            this._allCache = this._byId.filter(Boolean);
            this._allCacheCount = this.count;
        }
        return this._allCache;
    }

    /**
     * Layer id for a name, or -1.
     * @param {string} name
     * @returns {number}
     */
    static getId(name) {
        const layer = this._byName[name];
        return layer ? layer.id : -1;
    }

    /**
     * Layer name for an id, or null.
     * @param {number} id
     * @returns {string|null}
     */
    static getName(id) {
        const layer = this._byId[id];
        return layer ? layer.name : null;
    }

    /**
     * Scene-defined custom layers (not pipeline builtins).
     * @returns {Layer[]}
     */
    static getCustomLayers() {
        return this._byId.filter((l) => l && !l._builtIn);
    }

    static _canHostScenery(layer) {
        if (!layer) return false;
        if (layer._builtIn) {
            console.warn(`Layer scenery APIs are not supported on pipeline layer "${layer.name}"`);
            return false;
        }
        if (isSceneryKind(layer._kind)) return true;
        if (
            layer._kind === LAYER_KIND.SPRITES
            && !layer.hasShader
            && (!this._hasRenderQueue || this._hasRenderQueue[layer.id] !== 1)
        ) {
            return true;
        }
        console.warn(
            `Layer scenery APIs are not supported on "${layer.name}" (kind ${layer._kind})`
        );
        return false;
    }

    static _createContentRequestId() {
        const id = this._nextContentRequestId;
        this._nextContentRequestId =
            this._nextContentRequestId >= 0x7fffffff ? 1 : this._nextContentRequestId + 1;
        return id;
    }

    static _postContentCommand(payload, resolve = null) {
        const requestId = this._createContentRequestId();
        if (resolve) {
            this._contentReadyResolvers.set(requestId, resolve);
        }
        this._postToRenderer({ ...payload, requestId });
        return requestId;
    }

    /**
     * Resolve the pending content-ready promise for a specific request.
     * Called by Scene on `layerContentReady` from the renderer worker.
     */
    static resolveLayerContentReady(layerId, requestId) {
        if (requestId == null) return;
        const resolve = this._contentReadyResolvers.get(requestId);
        if (!resolve) return;
        this._contentReadyResolvers.delete(requestId);
        resolve();
    }

    /**
     * Apply scenery declared in config.layers (cover / static / tiling / tilemap).
     * Called by Scene after workers are ready, before preload().
     * @returns {Promise<void>}
     */
    static async applyConfiguredContent() {
        const waits = [];
        for (let i = 0; i < this.count; i++) {
            const layer = this._byId[i];
            if (!layer || layer._builtIn || !isSceneryKind(layer._kind)) continue;
            const content = layer._content || {};
            const kind = layer._kind;
            if (kind === LAYER_KIND.COVER && content.texture) {
                layer.setCover({
                    texture: content.texture,
                    parallax: content.parallax,
                    margin: content.margin,
                    zoomParallax: content.zoomParallax,
                });
            } else if (kind === LAYER_KIND.STATIC && content.texture) {
                layer.setStatic(content.texture, { parallax: content.parallax });
            } else if (kind === LAYER_KIND.TILING && content.texture) {
                layer.setTiling(content.texture, {
                    tileScale: content.tileScale,
                    parallax: content.parallax,
                });
            } else if (kind === LAYER_KIND.TILEMAP && content.tilemap) {
                waits.push(layer.setTilemap(content.tilemap, {
                    scale: content.scale,
                    layers: content.layers,
                    parallax: content.parallax,
                }));
            }
        }
        if (waits.length) await Promise.all(waits);
    }

    // ========================================
    // CONFIG SAB LAYOUT
    // ========================================
    // All layer config packed into one SAB for efficient cross-worker sharing.
    // Layout:
    //   zIndex:          Float32[MAX_LAYERS]
    //   blendModeId:     Uint8[MAX_LAYERS]
    //   hasShader:       Uint8[MAX_LAYERS]
    //   ySorting:        Uint8[MAX_LAYERS]
    //   (align to 4)
    //   resolution:      Float32[MAX_LAYERS]
    //   alpha:           Float32[MAX_LAYERS]  (mutable after init)
    //   alphaDirty:      Int32[MAX_LAYERS]    (Atomics dirty flag)
    //   containerBlendId:Uint8[MAX_LAYERS]
    //   available:       Uint8[MAX_LAYERS]
    //   hasRenderQueue:  Uint8[MAX_LAYERS]
    //   visible:         Uint8[MAX_LAYERS]  (mutable after init)
    //   feederKind:      Uint8[MAX_LAYERS]  (LAYER_FEEDER_KIND)
    //   (align to 4)
    //   visibleDirty:    Int32[MAX_LAYERS]  (Atomics dirty flag)

    static _createConfigViews(sab) {
        let offset = 0;
        this._zIndex = new Float32Array(sab, offset, this.MAX_LAYERS);
        offset += this.MAX_LAYERS * 4;

        this._blendModeId = new Uint8Array(sab, offset, this.MAX_LAYERS);
        offset += this.MAX_LAYERS;

        this._hasShader = new Uint8Array(sab, offset, this.MAX_LAYERS);
        offset += this.MAX_LAYERS;

        this._ySorting = new Uint8Array(sab, offset, this.MAX_LAYERS);
        offset += this.MAX_LAYERS;

        // Align for Float32
        offset = Math.ceil(offset / 4) * 4;

        this._resolution = new Float32Array(sab, offset, this.MAX_LAYERS);
        offset += this.MAX_LAYERS * 4;

        this._alpha = new Float32Array(sab, offset, this.MAX_LAYERS);
        offset += this.MAX_LAYERS * 4;

        this._alphaDirty = new Int32Array(sab, offset, this.MAX_LAYERS);
        offset += this.MAX_LAYERS * 4;

        this._containerBlendId = new Uint8Array(sab, offset, this.MAX_LAYERS);
        offset += this.MAX_LAYERS;

        this._available = new Uint8Array(sab, offset, this.MAX_LAYERS);
        offset += this.MAX_LAYERS;

        this._hasRenderQueue = new Uint8Array(sab, offset, this.MAX_LAYERS);
        offset += this.MAX_LAYERS;

        this._visible = new Uint8Array(sab, offset, this.MAX_LAYERS);
        offset += this.MAX_LAYERS;

        this._feederKind = new Uint8Array(sab, offset, this.MAX_LAYERS);
        offset += this.MAX_LAYERS;

        offset = Math.ceil(offset / 4) * 4;
        this._visibleDirty = new Int32Array(sab, offset, this.MAX_LAYERS);
    }

    static _getConfigSABSize() {
        let size = 0;
        size += this.MAX_LAYERS * 4;  // zIndex Float32
        size += this.MAX_LAYERS;      // blendModeId Uint8
        size += this.MAX_LAYERS;      // hasShader Uint8
        size += this.MAX_LAYERS;      // ySorting Uint8
        size = Math.ceil(size / 4) * 4; // align
        size += this.MAX_LAYERS * 4;  // resolution Float32
        size += this.MAX_LAYERS * 4;  // alpha Float32
        size += this.MAX_LAYERS * 4;  // alphaDirty Int32
        size += this.MAX_LAYERS;      // containerBlendId Uint8
        size += this.MAX_LAYERS;      // available Uint8
        size += this.MAX_LAYERS;      // hasRenderQueue Uint8
        size += this.MAX_LAYERS;      // visible Uint8
        size += this.MAX_LAYERS;      // feederKind Uint8
        size = Math.ceil(size / 4) * 4;
        size += this.MAX_LAYERS * 4;  // visibleDirty Int32
        return size;
    }

    // ========================================
    // INITIALIZATION (main thread)
    // ========================================

    static initializeFromConfig(layersConfig = {}, builtInLayers = {}, defaultYSorting = true) {
        // Reset state
        this._byName = {};
        this._byId = [];
        this.count = 0;
        this._uniformSABs = [];
        this._uniformFloats = [];
        this._uniformDirty = [];
        this._uniformMaps = [];
        this._feedIndexSABs = [];
        this._feedIndices = [];
        this._feedMax = [];
        this._feedOverflowWarned = 0;
        this._particleFeedIndexSABs = [];
        this._particleFeedIndices = [];
        this._particleFeedMax = [];
        this._particleFeedOverflowWarned = 0;
        this._defaultYSorting = !!defaultYSorting;

        // Allocate config SAB
        this._configSAB = new SharedArrayBuffer(this._getConfigSABSize());
        this._createConfigViews(this._configSAB);
        this._bindFeedCountSAB(new SharedArrayBuffer(this.MAX_LAYERS * 8));
        this._bindParticleFeedCountSAB(new SharedArrayBuffer(this.MAX_LAYERS * 8));

        // Register built-in pipeline layers (decals, castedShadows, entities, lighting)
        for (const [name, config] of Object.entries(builtInLayers)) {
            const kind = config.kind || this._deriveKind(name, true, config);
            const layer = this._register(name, {
                ...config,
                _builtIn: true,
                _kind: kind,
            });
            if (!layer) continue;
            if (name === 'entities') {
                this.entitiesId = layer.id;
                this._hasRenderQueue[layer.id] = 1;
            }
        }

        // Register custom layers from scene config
        for (const [name, config] of Object.entries(layersConfig)) {
            const densitySource = Layer._normalizeDensitySource(config.shader);
            const compute = Layer._normalizeCompute(config.shader);
            const kind = this._deriveKind(name, false, config, densitySource, compute);
            const layer = this._register(name, {
                ...config,
                _builtIn: false,
                _kind: kind,
                _densitySource: densitySource,
                _compute: compute,
                _computeSource: compute
                    ? Layer._normalizeComputeSource(config.shader)
                    : null,
                _splat: densitySource === LAYER_DENSITY_SOURCE.LIQUID_FUN
                    ? Layer._normalizeSplat(config.shader, densitySource)
                    : null,
                _content: this._extractContent(config),
            });
            if (!layer) continue;
            // LF density, compute, and scenery skip the sprite render queue.
            this._hasRenderQueue[layer.id] = (
                densitySource === LAYER_DENSITY_SOURCE.LIQUID_FUN
                || compute
                || kind === LAYER_KIND.MESH
                || isSceneryKind(kind)
            ) ? 0 : 1;

            if (compute) {
                const maxBodies = Layer._normalizeMaxBodies(config.shader);
                const sab = new SharedArrayBuffer(maxBodies * 4);
                this._feedIndexSABs[layer.id] = sab;
                this._feedIndices[layer.id] = new Uint32Array(sab);
                this._feedMax[layer.id] = maxBodies;
            }

            // Density-splat layers and compute layers with maxParticles > 0 (e.g. a
            // BOX2D_BODIES compute layer that also packs LiquidFun/CPU particles for
            // its own heat/fuel pass) both need a dense ParticleComponent feed list.
            // `compute.maxParticles` already threads an explicit `shader.maxParticles`
            // through regardless of computeSource; density-only layers have no
            // `compute` block at all, so fall back to an explicit value or the shared
            // default cap.
            const explicitMaxParticles =
                Number.isFinite(config.shader?.maxParticles) && config.shader.maxParticles > 0
                    ? (config.shader.maxParticles | 0)
                    : 0;
            const needsParticleFeed =
                densitySource === LAYER_DENSITY_SOURCE.LIQUID_FUN || (compute && compute.maxParticles > 0);
            if (needsParticleFeed) {
                const maxParticles = compute && compute.maxParticles > 0
                    ? compute.maxParticles
                    : (explicitMaxParticles || COMPUTE_LAYER_DEFAULT_MAX_PARTICLES);
                const psab = new SharedArrayBuffer(maxParticles * 4);
                this._particleFeedIndexSABs[layer.id] = psab;
                this._particleFeedIndices[layer.id] = new Uint32Array(psab);
                this._particleFeedMax[layer.id] = maxParticles;
            }

            if (config.shader) {
                this._allocateUniformSAB(
                    layer.id,
                    this._mergeReservedLookUniforms(config.shader.uniforms)
                );
            }
        }

        this.initialized = true;
        for (let i = 0; i < this.count; i++) this._writeFeederKind(i);
        this._computeSpriteQueueBits();
        this._buildMetadata(layersConfig, builtInLayers);
        return this;
    }

    /**
     * @param {string} name
     * @param {boolean} builtIn
     * @param {object} config
     * @param {string} [densitySource]
     * @param {object|null} [compute]
     */
    static _deriveKind(name, builtIn, config = {}, densitySource = null, compute = null) {
        if (config.kind) return this._normalizeKind(config.kind, builtIn, name);
        if (builtIn) {
            if (name === 'decals') return LAYER_KIND.DECALS;
            if (name === 'castedShadows') return LAYER_KIND.SHADOWS;
            if (name === 'entities') return LAYER_KIND.SPRITES;
            if (name === 'lighting') return LAYER_KIND.LIGHTING;
            return LAYER_KIND.SPRITES;
        }
        if (compute) return LAYER_KIND.COMPUTE;
        if (densitySource === LAYER_DENSITY_SOURCE.LIQUID_FUN) return LAYER_KIND.DENSITY;
        return LAYER_KIND.SPRITES;
    }

    static _normalizeKind(raw, builtIn, name) {
        const kind = typeof raw === 'string' ? raw : '';
        if (kind === LAYER_KIND.COVER || kind === LAYER_KIND.STATIC
            || kind === LAYER_KIND.TILING || kind === LAYER_KIND.TILEMAP
            || kind === LAYER_KIND.SPRITES || kind === LAYER_KIND.DENSITY
            || kind === LAYER_KIND.COMPUTE || kind === LAYER_KIND.MESH
            || kind === LAYER_KIND.DECALS
            || kind === LAYER_KIND.SHADOWS || kind === LAYER_KIND.LIGHTING) {
            if (isSceneryKind(kind) && builtIn) {
                console.warn(`Layer: builtin "${name}" cannot use scenery kind "${kind}"`);
                return LAYER_KIND.SPRITES;
            }
            return kind;
        }
        console.warn(`Layer: unknown kind "${raw}" on "${name}", using sprites`);
        return LAYER_KIND.SPRITES;
    }

    static _extractContent(config = {}) {
        return {
            texture: typeof config.texture === 'string' ? config.texture
                : (typeof config.textureId === 'string' ? config.textureId : null),
            tilemap: typeof config.tilemap === 'string' ? config.tilemap : null,
            parallax: config.parallax,
            margin: config.margin,
            zoomParallax: config.zoomParallax,
            tileScale: config.tileScale,
            scale: config.scale,
            layers: config.layers,
        };
    }

    /** @param {object|null|undefined} shader */
    static _normalizeDensitySource(shader) {
        const src = shader?.densitySource;
        if (src === LAYER_DENSITY_SOURCE.LIQUID_FUN || src === 'liquidFun') {
            return LAYER_DENSITY_SOURCE.LIQUID_FUN;
        }
        return LAYER_DENSITY_SOURCE.SPRITES;
    }

    /**
     * @param {object|null|undefined} shader
     * @returns {null|{
     *   passes: Array<{entry:string, source?:string, layout?:string, iterate?:string|number, swap?:string[], workgroup?:number[], when?:string, dispatchFrom?:string}>,
     *   maxBodies: number,
     *   maxParticles: number,
     *   size: {scale:number, width?:number, height?:number},
     *   textures: Array<{name:string, format:string, pingPong:boolean, look:boolean}>,
     *   buffers: Array<{name:string, strideFloats:number, count:number}>,
     *   layouts: object|null,
     * }}
     */
    static _normalizeCompute(shader) {
        const raw = shader?.compute;
        if (!raw) return null;
        const size = Layer._normalizeComputeSize(typeof raw === 'object' ? raw.size : null);
        const maxBodies = Layer._normalizeMaxBodies(shader);
        const maxParticles = Layer._normalizeMaxParticles(shader);
        if (typeof raw === 'string') {
            return {
                passes: [{
                    entry: 'main',
                    source: raw,
                    layout: 'simple',
                    iterate: undefined,
                    swap: null,
                    workgroup: null,
                    when: null,
                    dispatchFrom: null,
                    dispatch: null,
                }],
                maxBodies,
                maxParticles,
                size,
                textures: [],
                buffers: [],
                layouts: null,
            };
        }
        const sourceName = typeof raw.source === 'string' ? raw.source : null;
        const passesIn = Array.isArray(raw.passes) && raw.passes.length
            ? raw.passes
            : [{ entry: 'main' }];
        const passes = [];
        for (let i = 0; i < passesIn.length; i++) {
            const p = passesIn[i] || {};
            const entry = typeof p.entry === 'string' ? p.entry : 'main';
            passes.push({
                entry,
                source: typeof p.source === 'string' ? p.source : sourceName,
                layout: typeof p.layout === 'string' ? p.layout : null,
                iterate: p.iterate,
                swap: Array.isArray(p.swap) ? p.swap.slice() : null,
                workgroup: Array.isArray(p.workgroup) ? p.workgroup.slice() : null,
                when: typeof p.when === 'string' ? p.when : null,
                dispatchFrom: typeof p.dispatchFrom === 'string' ? p.dispatchFrom : null,
                dispatch: Layer._normalizePassDispatch(p.dispatch),
            });
        }
        return {
            passes,
            maxBodies,
            maxParticles,
            size,
            textures: Layer._normalizeComputeTextures(raw.textures),
            buffers: Layer._normalizeComputeBuffers(raw.buffers),
            layouts: Layer._normalizeComputeLayouts(raw.layouts),
        };
    }

    /**
     * Storage texture pixel size. Zoom does not change this.
     * Default scale 1 = canvas pixels. Optional { scale } or { width, height }.
     * @param {number} canvasW
     * @param {number} canvasH
     * @param {{scale?:number, width?:number, height?:number}|null|undefined} size
     * @param {{ texW: number, texH: number }|null} [out]
     * @returns {{ texW: number, texH: number }}
     */
    static computeTextureExtent(canvasW, canvasH, size, out) {
        const dest = out || { texW: 8, texH: 8 };
        const s = size || {};
        const w = s.width | 0;
        const h = s.height | 0;
        if (w > 0 && h > 0) {
            dest.texW = Math.max(8, w);
            dest.texH = Math.max(8, h);
            return dest;
        }
        const scale = Number.isFinite(s.scale) && s.scale > 0 ? s.scale : 1;
        dest.texW = Math.max(8, Math.ceil(canvasW * scale) | 0);
        dest.texH = Math.max(8, Math.ceil(canvasH * scale) | 0);
        return dest;
    }

    /**
     * Density RT (`rt`) and look output (`rtOut`) follow the canvas.
     * Compute storage textures do not — they use {@link computeTextureExtent}.
     * Compute look layers have `rtOut` only (`rt` stays null).
     * @param {{rt?: unknown, rtOut?: unknown}|null|undefined} cl
     */
    static customLayerNeedsViewportResize(cl) {
        return !!(cl && (cl.rt || cl.rtOut));
    }

    /**
     * Look `uTexture` after viewport RT recreate.
     * Density layers sample `cl.rt`; compute layers keep the pinned pack (`lookSource`).
     * @param {{compute?: unknown, lookSource?: unknown, rt?: {source?: unknown}}|null|undefined} cl
     */
    static customLayerLookTexture(cl) {
        if (!cl) return null;
        if (cl.compute) return cl.lookSource || null;
        return cl.rt?.source || null;
    }

    /** @param {unknown} raw */
    static _normalizeComputeSize(raw) {
        const s = raw && typeof raw === 'object' ? raw : {};
        const out = { scale: 1 };
        if (Number.isFinite(s.scale) && s.scale > 0) out.scale = s.scale;
        const w = s.width | 0;
        const h = s.height | 0;
        if (w > 0 && h > 0) {
            out.width = w;
            out.height = h;
        }
        return out;
    }

    /** @param {unknown} raw */
    static _normalizeComputeTextures(raw) {
        if (!Array.isArray(raw)) return [];
        const out = [];
        for (let i = 0; i < raw.length; i++) {
            const p = raw[i];
            if (!p || typeof p.name !== 'string' || !p.name) continue;
            out.push({
                name: p.name,
                format: typeof p.format === 'string' ? p.format : 'rgba8unorm',
                pingPong: !!p.pingPong,
                look: !!p.look,
            });
        }
        return out;
    }

    /** @param {unknown} raw */
    static _normalizeComputeBuffers(raw) {
        if (!Array.isArray(raw)) return [];
        const out = [];
        for (let i = 0; i < raw.length; i++) {
            const b = raw[i];
            if (!b || typeof b.name !== 'string' || !b.name) continue;
            out.push({
                name: b.name,
                strideFloats: Math.max(1, b.strideFloats | 0),
                count: Math.max(1, b.count | 0),
            });
        }
        return out;
    }

    /** @param {unknown} raw */
    static _normalizeComputeLayouts(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const names = Object.keys(raw);
        if (!names.length) return null;
        const out = Object.create(null);
        for (let n = 0; n < names.length; n++) {
            const name = names[n];
            const groups = raw[name];
            if (!Array.isArray(groups)) continue;
            out[name] = groups.map((group) => {
                if (!Array.isArray(group)) return [];
                return group.map((e) => Layer._cloneLayoutEntry(e));
            });
        }
        return out;
    }

    /** @param {object|null|undefined} e */
    static _cloneLayoutEntry(e) {
        if (!e || typeof e !== 'object') return { binding: 0 };
        const out = { binding: e.binding | 0, resource: e.resource };
        if (typeof e.buffer === 'string') out.buffer = e.buffer;
        else if (e.buffer && typeof e.buffer === 'object') out.buffer = { ...e.buffer };
        if (e.storageTexture) out.storageTexture = { ...e.storageTexture };
        if (e.texture) out.texture = { ...e.texture };
        if (e.ping) out.ping = e.ping;
        return out;
    }

    /** Count + per-layer spinlock share one SAB (count at 0, lock at MAX_LAYERS*4). */
    static _bindFeedCountSAB(sab) {
        this._feedCountSAB = sab || null;
        this._feedCount = null;
        this._feedLock = null;
        if (!sab) return;
        this._feedCount = new Int32Array(sab, 0, this.MAX_LAYERS);
        if (sab.byteLength >= this.MAX_LAYERS * 8) {
            this._feedLock = new Int32Array(sab, this.MAX_LAYERS * 4, this.MAX_LAYERS);
        }
    }

    /** Same shape as {@link Layer._bindFeedCountSAB}, for the ParticleComponent feed lists. */
    static _bindParticleFeedCountSAB(sab) {
        this._particleFeedCountSAB = sab || null;
        this._particleFeedCount = null;
        this._particleFeedLock = null;
        if (!sab) return;
        this._particleFeedCount = new Int32Array(sab, 0, this.MAX_LAYERS);
        if (sab.byteLength >= this.MAX_LAYERS * 8) {
            this._particleFeedLock = new Int32Array(sab, this.MAX_LAYERS * 4, this.MAX_LAYERS);
        }
    }

    static _normalizeMaxBodies(shader) {
        const n = shader?.maxBodies;
        return Number.isFinite(n) && n > 0 ? (n | 0) : COMPUTE_LAYER_DEFAULT_MAX_BODIES;
    }

    static _normalizeMaxParticles(shader) {
        const n = shader?.maxParticles;
        if (Number.isFinite(n)) return Math.max(0, n | 0);
        const src = shader?.source;
        if (src === LAYER_COMPUTE_SOURCE.LIQUID_FUN || src === 'liquidFun') {
            return COMPUTE_LAYER_DEFAULT_MAX_PARTICLES;
        }
        return 0;
    }

    static _normalizeComputeSource(shader) {
        const src = shader?.source;
        if (src === LAYER_COMPUTE_SOURCE.LIQUID_FUN || src === 'liquidFun') {
            return LAYER_COMPUTE_SOURCE.LIQUID_FUN;
        }
        return LAYER_COMPUTE_SOURCE.BOX2D_BODIES;
    }

    /**
     * Generic workgroup counts (Unity Dispatch(x,y)). Not a lattice origin —
     * WebGPU has no dispatch offset; scene WGSL interprets gid.
     * @param {unknown} raw
     */
    static _normalizePassDispatch(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const x = raw.x;
        const y = raw.y;
        if (x == null && y == null) return null;
        return { x: x != null ? x : 0, y: y != null ? y : 0 };
    }

    static isComputeLayer(layerId) {
        const layer = this._byId[layerId | 0];
        return !!(layer && layer._compute);
    }

    /**
     * How this layer consumes subscribed particles/colliders.
     * @param {number} layerId
     * @returns {number} {@link LAYER_FEEDER_KIND}
     */
    static feederKind(layerId) {
        const id = layerId | 0;
        if (!this._feederKind || id < 0 || id >= this.MAX_LAYERS) return LAYER_FEEDER_KIND.NONE;
        return this._feederKind[id] | 0;
    }

    /** Cache {@link LAYER_FEEDER_KIND} after `_hasRenderQueue` is known. */
    static _writeFeederKind(id) {
        const layer = this._byId[id | 0];
        if (!layer || !this._feederKind) return;
        let kind = LAYER_FEEDER_KIND.BUILTIN;
        if (isSceneryKind(layer._kind)) kind = LAYER_FEEDER_KIND.NONE;
        else if (layer._kind === LAYER_KIND.MESH) kind = LAYER_FEEDER_KIND.MESH;
        else if (layer._compute) kind = LAYER_FEEDER_KIND.COMPUTE;
        else if (layer._densitySource === LAYER_DENSITY_SOURCE.LIQUID_FUN) kind = LAYER_FEEDER_KIND.DENSITY;
        else if (this._hasRenderQueue && this._hasRenderQueue[id] === 1) kind = LAYER_FEEDER_KIND.SPRITES;
        this._feederKind[id] = kind;
    }

    /** @param {number} id */
    static bit(id) {
        const i = id | 0;
        if (i < 0 || i >= this.MAX_LAYERS) return 0;
        return 1 << i;
    }

    /** entities bit after initializeFromConfig. 0 if not registered. */
    static entitiesMask() {
        const id = this.entitiesId | 0;
        return id >= 0 ? (1 << id) : 0;
    }

    /**
     * True when this layer bit should receive instanced sprites (not density/compute).
     * @param {number} layerId
     */
    static hasSpriteQueue(layerId) {
        const id = layerId | 0;
        if (id < 0 || id >= this.MAX_LAYERS) return false;
        if (this._hasRenderQueue && this._hasRenderQueue[id] === 1) return true;
        return id === this.entitiesId;
    }

    /**
     * Recompute {@link Layer._spriteQueueBits} from the current `_hasRenderQueue`/
     * `entitiesId`. Call once per realm after those are known (init or
     * initializeFromBuffers) — not SAB-shared, every worker computes its own copy
     * from the shared config it just bound.
     */
    static _computeSpriteQueueBits() {
        let bits = 0;
        for (let id = 0; id < this.count; id++) {
            if (this.hasSpriteQueue(id)) bits |= 1 << id;
        }
        this._spriteQueueBits = bits;
    }

    static _resolveOneSubscription(entry, kind) {
        let id = -1;
        if (typeof entry === 'number') {
            id = entry | 0;
            if (!this.getById(id)) {
                console.warn(`layer: id ${id} not found`);
                return -1;
            }
        } else {
            const name = String(entry);
            if (!name) return -1;
            id = this.getId(name);
            if (id === -1) {
                console.warn(`layer: Layer "${name}" not found`);
                return -1;
            }
        }
        const layer = this.getById(id);
        const name = layer ? layer.name : null;
        if (layer && isSkipSubscribeKind(layer._kind)) {
            console.warn(`layer: Layer "${name}" is not a subscription target`);
            return -1;
        }
        if (kind === LAYER_SUBSCRIBE_KIND.GAME_OBJECT && this.feederKind(id) === LAYER_FEEDER_KIND.DENSITY) {
            console.warn(
                `layer: Layer "${name}" is density (particles splat it); colliders are not splat`
            );
        }
        return id;
    }

    static _subscriptionList(opts) {
        if (!opts) return { omitted: true, list: null };
        if (opts.layers !== undefined) {
            const raw = opts.layers;
            const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
            return { omitted: false, list };
        }
        if (opts.layer !== undefined && opts.layer !== null) {
            return { omitted: false, list: [opts.layer] };
        }
        return { omitted: true, list: null };
    }

    /**
     * One-entry mask without allocating a list (GameObject.setLayer).
     * @param {string|number} entry
     * @param {number} [kind]
     * @returns {number} Uint16 mask
     */
    static resolveOne(entry, kind = LAYER_SUBSCRIBE_KIND.PARTICLE) {
        const id = this._resolveOneSubscription(entry, kind);
        if (id < 0) {
            return kind === LAYER_SUBSCRIBE_KIND.GAME_OBJECT ? this.entitiesMask() : 0;
        }
        let mask = this.bit(id);
        if (kind === LAYER_SUBSCRIBE_KIND.GAME_OBJECT && this.feederKind(id) !== LAYER_FEEDER_KIND.SPRITES) {
            mask |= this.entitiesMask();
        }
        return mask;
    }

    /**
     * Subscription bitmask from `layer` / `layers`.
     * @param {object|null|undefined} opts
     * @param {number} [kind]
     * @returns {number} Uint16 mask
     */
    static resolveSubscriptions(opts, kind = LAYER_SUBSCRIBE_KIND.PARTICLE) {
        const { omitted, list } = this._subscriptionList(opts);
        if (omitted) return this.entitiesMask();
        let mask = 0;
        let hasSpriteQueue = false;
        for (let i = 0; i < list.length; i++) {
            const id = this._resolveOneSubscription(list[i], kind);
            if (id < 0) continue;
            mask |= this.bit(id);
            if (this.feederKind(id) === LAYER_FEEDER_KIND.SPRITES) hasSpriteQueue = true;
        }
        if (kind === LAYER_SUBSCRIBE_KIND.GAME_OBJECT) {
            if (!hasSpriteQueue) mask |= this.entitiesMask();
            return mask;
        }
        return mask;
    }

    /**
     * Old saves stored u8 layerId + feedLayerId (255 = none).
     * layerId 0 means ENTITIES bit. Non-255 feed bits are OR'd in.
     * @param {Uint8Array|Uint16Array|null|undefined} layerField
     * @param {Uint8Array|null|undefined} feedLayerId
     * @returns {Uint16Array|null}
     */
    static maskFromLegacy(layerField, feedLayerId) {
        const n = Math.max(layerField?.length || 0, feedLayerId?.length || 0);
        if (!n) return layerField instanceof Uint16Array ? layerField : null;
        if (layerField instanceof Uint16Array && !feedLayerId) return layerField;
        const out = new Uint16Array(n);
        const entities = this.entitiesMask();
        if (layerField instanceof Uint16Array) {
            out.set(layerField.subarray(0, n));
        } else if (layerField) {
            const len = Math.min(n, layerField.length);
            for (let i = 0; i < len; i++) {
                const id = layerField[i] | 0;
                out[i] = id === 0 ? entities : (1 << id);
            }
        }
        if (feedLayerId) {
            const len = Math.min(n, feedLayerId.length);
            for (let i = 0; i < len; i++) {
                const fid = feedLayerId[i] | 0;
                if (fid !== LEGACY_FEED_NONE && fid >= 0 && fid < this.MAX_LAYERS) out[i] |= 1 << fid;
            }
        }
        return out;
    }

    /**
     * @param {object|null|undefined} shader
     * @param {string} densitySource
     */
    static _normalizeSplat(shader, densitySource) {
        if (densitySource !== LAYER_DENSITY_SOURCE.LIQUID_FUN) return null;
        const s = shader?.splat || {};
        let falloff = LAYER_SPLAT_FALLOFF.QUADRATIC;
        if (s.falloff === LAYER_SPLAT_FALLOFF.SMOOTHSTEP || s.falloff === 'smoothstep') {
            falloff = LAYER_SPLAT_FALLOFF.SMOOTHSTEP;
        } else if (s.falloff === LAYER_SPLAT_FALLOFF.GAUSSIAN || s.falloff === 'gaussian') {
            falloff = LAYER_SPLAT_FALLOFF.GAUSSIAN;
        }
        return {
            radius: Number.isFinite(s.radius) && s.radius > 0 ? s.radius : 48,
            falloff,
            useParticleTint: s.useParticleTint !== false,
            intensity: Number.isFinite(s.intensity) ? s.intensity : 1,
        };
    }

    /** True when layer uses HEAP pose splat (no type-7 sprite queue). */
    static isLiquidFunDensityLayer(layerId) {
        return this.feederKind(layerId) === LAYER_FEEDER_KIND.DENSITY;
    }

    /** @param {string|number|undefined|null} mode */
    static _normalizeScaleMode(mode) {
        return mode === LAYER_SCALE_MODE.NEAREST || mode === 'nearest'
            ? LAYER_SCALE_MODE.NEAREST
            : LAYER_SCALE_MODE.LINEAR;
    }

    /** Pixi TextureSource.scaleMode string for a {@link LAYER_SCALE_MODE} id. */
    static scaleModeString(mode) {
        return this._SCALE_MODE_STRINGS[mode === LAYER_SCALE_MODE.NEAREST ? LAYER_SCALE_MODE.NEAREST : LAYER_SCALE_MODE.LINEAR];
    }

    static _register(name, config = {}) {
        if (this.count >= this.MAX_LAYERS) {
            console.error(`Layer: MAX_LAYERS (${this.MAX_LAYERS}) exceeded, cannot register "${name}"`);
            return null;
        }

        if (isAllCapsName(name)) {
            console.warn(`Layer: "${name}" is ALL_CAPS; prefer camelCase (entities, sky, ground)`);
        }
        if (this._byName[name]) {
            console.error(`Layer: "${name}" already registered`);
            return null;
        }

        const id = this.count++;
        const layer = new Layer(id, name);
        layer._builtIn = !!config._builtIn;
        layer._kind = config._kind || this._deriveKind(name, layer._builtIn, config);
        layer._content = config._content || (isSceneryKind(layer._kind) ? this._extractContent(config) : null);
        layer._densitySource = config._densitySource ?? LAYER_DENSITY_SOURCE.SPRITES;
        layer._compute = config._compute || null;
        layer._computeSource = config._computeSource ?? null;
        layer._splat = config._splat || null;
        layer._scaleMode = Layer._normalizeScaleMode(
            config._scaleMode ?? config.scaleMode ?? LAYER_DEFAULTS.scaleMode
        );

        this._zIndex[id] = config.zIndex !== undefined ? config.zIndex : id;
        this._blendModeId[id] = config.blendMode ?? LAYER_DEFAULTS.blendMode;
        this._hasShader[id] = config.shader ? 1 : 0;
        this._ySorting[id] = config.ySorting !== undefined
            ? (config.ySorting ? 1 : 0)
            : (this._defaultYSorting ? 1 : 0);
        this._resolution[id] = config.resolution ?? LAYER_DEFAULTS.resolution;
        layer.alpha = config.alpha ?? LAYER_DEFAULTS.alpha;
        this._containerBlendId[id] = config.shader?.containerBlend ?? 0;
        this._available[id] = 1;
        this._visible[id] = 1;
        if (this._visibleDirty) this._visibleDirty[id] = 0;

        this._byName[name] = layer;
        this._byId[id] = layer;

        // Dynamic property access: Layer.water, Layer.lava, etc.
        // Built-in layers already have static getters; custom layers get assigned here.
        if (!layer._builtIn && !(name in this) && !name.startsWith('_')) {
            this[name] = layer;
        } else if (!layer._builtIn && name in this) {
            console.warn(`Layer: "${name}" collides with an existing Layer property. Use Layer.get('${name}') instead.`);
        }

        return layer;
    }

    // ========================================
    // UNIFORM SAB ALLOCATION (main thread)
    // ========================================

    /**
     * Reserved look uniforms first, then scene uniforms. Scene defs override
     * reserved ones on name collision (keeps scene initial value/type).
     */
    static _mergeReservedLookUniforms(uniforms) {
        const merged = {};
        for (const [name, def] of Object.entries(RESERVED_LOOK_UNIFORMS)) {
            merged[name] = def;
        }
        for (const [name, def] of Object.entries(uniforms || {})) {
            merged[name] = name in merged ? { ...merged[name], ...def } : def;
        }
        return merged;
    }

    static _allocateUniformSAB(layerId, uniformsConfig) {
        const map = {};
        let floatCount = 0;

        for (const [name, def] of Object.entries(uniformsConfig)) {
            const size = this._getUniformSize(def.type);
            // WGSL uniform address-space alignment (in floats): vec2 -> 2, vec3/vec4 -> 4.
            // Keeps SAB offsets identical to the engine-generated WGSL struct layout.
            if (size === 2) floatCount = (floatCount + 1) & ~1;
            else if (size >= 3) floatCount = (floatCount + 3) & ~3;
            map[name] = { offset: floatCount, size };
            floatCount += size;
        }

        // Layout: Float32[floatCount] + Int32[1] (dirty flag)
        const floatBytes = floatCount * 4;
        const dirtyOffset = Math.ceil(floatBytes / 4) * 4; // align dirty flag
        const totalBytes = dirtyOffset + 4;
        const sab = new SharedArrayBuffer(totalBytes);

        const floats = new Float32Array(sab, 0, floatCount);
        const dirty = new Int32Array(sab, dirtyOffset, 1);

        // Write initial values
        for (const [name, def] of Object.entries(uniformsConfig)) {
            const entry = map[name];
            if (typeof def.value === 'number') {
                floats[entry.offset] = def.value;
            } else if (Array.isArray(def.value)) {
                for (let i = 0; i < def.value.length && i < entry.size; i++) {
                    floats[entry.offset + i] = def.value[i];
                }
            }
        }

        this._uniformSABs[layerId] = sab;
        this._uniformFloats[layerId] = floats;
        this._uniformDirty[layerId] = dirty;
        this._uniformMaps[layerId] = map;

        Atomics.store(dirty, 0, 1);
    }

    static _getUniformSize(type) {
        if (!type) return 1;
        if (type === 'f32' || type === 'i32') return 1;
        if (type === 'vec2<f32>') return 2;
        if (type === 'vec3<f32>') return 3;
        if (type === 'vec4<f32>') return 4;
        return 1;
    }

    // ========================================
    // SERIALIZATION (main thread -> workers)
    // ========================================

    static _buildMetadata(layersConfig, builtInLayers) {
        this._metadata = {
            count: this.count,
            entitiesId: this.entitiesId,
            layers: new Array(this.count),
        };

        for (let i = 0; i < this.count; i++) {
            const layer = this._byId[i];
            const name = layer.name;
            const isBuiltIn = !!layer._builtIn;
            const config = isBuiltIn
                ? (builtInLayers[name] || {})
                : (layersConfig[name] || {});

            const densitySource = layer._densitySource ?? LAYER_DENSITY_SOURCE.SPRITES;
            const splat = layer._splat || (
                densitySource === LAYER_DENSITY_SOURCE.LIQUID_FUN
                    ? Layer._normalizeSplat(config.shader, densitySource)
                    : null
            );
            const meta = {
                id: layer.id,
                name,
                builtIn: isBuiltIn,
                kind: layer._kind,
                content: layer._content || null,
                zIndex: this._zIndex[i],
                blendMode: this._BLEND_MODE_STRINGS[this._blendModeId[i]] || 'normal',
                containerBlendMode: this._BLEND_MODE_STRINGS[this._containerBlendId[i]] || 'normal',
                hasShader: this._hasShader[i] === 1,
                ySorting: this._ySorting[i] === 1,
                resolution: this._resolution[i],
                scaleMode: layer._scaleMode ?? LAYER_SCALE_MODE.LINEAR,
                alpha: this._alpha[i],
                hasRenderQueue: this._hasRenderQueue[i] === 1,
                feederKind: this._feederKind[i] | 0,
                maxItems: isBuiltIn
                    || densitySource === LAYER_DENSITY_SOURCE.LIQUID_FUN
                    || layer._kind === LAYER_KIND.MESH
                    || isSceneryKind(layer._kind)
                    ? 0
                    : (config.maxItems || LAYER_DEFAULTS.maxItemsPerLayer),
                uniformMap: this._uniformMaps[layer.id] || null,
                shaderFragment: config.shader?.fragment || null,
                shaderName: null,
                dynamicResolution: config.dynamicResolution || null,
                uniformTypes: null,
                uniformHints: null,
                densitySource,
                splat,
                compute: layer._compute || null,
                computeSource: layer._computeSource ?? null,
                maxBodies: layer._compute?.maxBodies || 0,
                maxParticles: layer._compute?.maxParticles || 0,
            };

            if (config.shader) {
                const merged = isBuiltIn
                    ? config.shader.uniforms
                    : this._mergeReservedLookUniforms(config.shader.uniforms);
                if (merged) {
                    const uniformTypes = {};
                    const uniformHints = {};
                    for (const [uName, uDef] of Object.entries(merged)) {
                        uniformTypes[uName] = uDef.type || 'f32';
                        const hint = {};
                        for (const key of UNIFORM_HINT_KEYS) {
                            if (uDef[key] !== undefined) hint[key] = uDef[key];
                        }
                        if (Object.keys(hint).length) uniformHints[uName] = hint;
                    }
                    meta.uniformTypes = uniformTypes;
                    if (Object.keys(uniformHints).length) meta.uniformHints = uniformHints;
                }
            }

            this._metadata.layers[i] = meta;
        }
    }

    static getSerializableData() {
        const uniformSABs = {};
        for (let i = 0; i < this.count; i++) {
            if (this._uniformSABs[i]) {
                uniformSABs[i] = this._uniformSABs[i];
            }
        }

        return {
            configSAB: this._configSAB,
            uniformSABs,
            metadata: this._metadata,
            feedCountSAB: this._feedCountSAB,
            feedIndexSABs: this._feedIndexSABs,
            feedMax: this._feedMax,
            particleFeedCountSAB: this._particleFeedCountSAB,
            particleFeedIndexSABs: this._particleFeedIndexSABs,
            particleFeedMax: this._particleFeedMax,
        };
    }

    // ========================================
    // INITIALIZATION (workers)
    // ========================================

    static initializeFromBuffers(data) {
        if (!data || !data.configSAB) return;

        // Reset
        this._byName = {};
        this._byId = [];
        this._uniformSABs = [];
        this._uniformFloats = [];
        this._uniformDirty = [];
        this._feedIndexSABs = [];
        this._feedIndices = [];
        this._feedMax = [];
        this._feedOverflowWarned = 0;
        this._particleFeedIndexSABs = [];
        this._particleFeedIndices = [];
        this._particleFeedMax = [];
        this._particleFeedOverflowWarned = 0;

        // Create typed views over the shared config SAB
        this._configSAB = data.configSAB;
        this._createConfigViews(this._configSAB);

        // Reconstruct registry from metadata
        const meta = data.metadata;
        this.count = meta.count;
        this.entitiesId = meta.entitiesId;
        this._metadata = meta;

        for (let i = 0; i < meta.count; i++) {
            const layerMeta = meta.layers[i];
            if (!layerMeta) continue;
            const layer = new Layer(i, layerMeta.name);
            layer._builtIn = !!layerMeta.builtIn;
            layer._kind = layerMeta.kind || LAYER_KIND.SPRITES;
            layer._content = layerMeta.content || null;
            layer._densitySource = layerMeta.densitySource ?? LAYER_DENSITY_SOURCE.SPRITES;
            layer._compute = layerMeta.compute || null;
            layer._computeSource = layerMeta.computeSource ?? null;
            layer._splat = layerMeta.splat || null;
            layer._scaleMode = Layer._normalizeScaleMode(layerMeta.scaleMode);
            this._byName[layerMeta.name] = layer;
            this._byId[i] = layer;
            if (!layer._builtIn && !(layerMeta.name in this) && !layerMeta.name.startsWith('_')) {
                this[layerMeta.name] = layer;
            }
        }

        // Initialize uniform SAB views
        for (const [idStr, sab] of Object.entries(data.uniformSABs)) {
            const id = parseInt(idStr);
            const layerMeta = meta.layers[id];
            if (!layerMeta || !layerMeta.uniformMap) continue;

            const uMap = layerMeta.uniformMap;
            let floatCount = 0;
            for (const entry of Object.values(uMap)) {
                floatCount = Math.max(floatCount, entry.offset + entry.size);
            }

            const floatBytes = floatCount * 4;
            const dirtyOffset = Math.ceil(floatBytes / 4) * 4;

            this._uniformSABs[id] = sab;
            this._uniformFloats[id] = new Float32Array(sab, 0, floatCount);
            this._uniformDirty[id] = new Int32Array(sab, dirtyOffset, 1);
            this._uniformMaps[id] = uMap;
        }

        this._feedCountSAB = data.feedCountSAB || null;
        this._bindFeedCountSAB(this._feedCountSAB);
        this._feedIndexSABs = data.feedIndexSABs || [];
        this._feedMax = data.feedMax || [];
        this._feedIndices = [];
        for (let i = 0; i < this._feedIndexSABs.length; i++) {
            const sab = this._feedIndexSABs[i];
            if (sab) this._feedIndices[i] = new Uint32Array(sab);
        }

        this._particleFeedCountSAB = data.particleFeedCountSAB || null;
        this._bindParticleFeedCountSAB(this._particleFeedCountSAB);
        this._particleFeedIndexSABs = data.particleFeedIndexSABs || [];
        this._particleFeedMax = data.particleFeedMax || [];
        this._particleFeedIndices = [];
        for (let i = 0; i < this._particleFeedIndexSABs.length; i++) {
            const sab = this._particleFeedIndexSABs[i];
            if (sab) this._particleFeedIndices[i] = new Uint32Array(sab);
        }

        this.initialized = true;
        this._computeSpriteQueueBits();
    }

    // ========================================
    // RESET (scene cleanup)
    // ========================================

    static reset() {
        for (const resolve of this._contentReadyResolvers.values()) {
            resolve();
        }
        this._contentReadyResolvers.clear();

        // Remove dynamic custom layer properties from previous scene
        for (const name of Object.keys(this._byName)) {
            const layer = this._byName[name];
            if (layer && !layer._builtIn && this[name] === layer) {
                delete this[name];
            }
        }
        this._byName = {};
        this._byId = [];
        this.count = 0;
        this.initialized = false;
        this.entitiesId = -1;
        this._configSAB = null;
        this._zIndex = null;
        this._blendModeId = null;
        this._hasShader = null;
        this._ySorting = null;
        this._resolution = null;
        this._alpha = null;
        this._alphaDirty = null;
        this._containerBlendId = null;
        this._available = null;
        this._hasRenderQueue = null;
        this._visible = null;
        this._feederKind = null;
        this._visibleDirty = null;
        this._spriteQueueBits = 0;
        this._feedCountSAB = null;
        this._feedCount = null;
        this._feedLock = null;
        this._feedIndexSABs = [];
        this._feedIndices = [];
        this._feedMax = [];
        this._particleFeedCountSAB = null;
        this._particleFeedCount = null;
        this._particleFeedLock = null;
        this._particleFeedIndexSABs = [];
        this._particleFeedIndices = [];
        this._particleFeedMax = [];
        this._uniformSABs = [];
        this._uniformFloats = [];
        this._uniformDirty = [];
        this._uniformMaps = [];
        this._metadata = null;
        this._allCache = [];
        this._allCacheCount = -1;
        this._postToRenderer = null;
        this._nextContentRequestId = 1;
    }
}
