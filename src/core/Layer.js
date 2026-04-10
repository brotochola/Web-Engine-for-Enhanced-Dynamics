// Layer.js - Rendering layer system for custom shader pipelines and backgrounds
// Static class with facade instances, backed by SharedArrayBuffer
//
// ARCHITECTURE:
// - Built-in layers (BACKGROUND, DECALS, etc.) registered by engine at init
// - Custom layers defined in scene config.layers
// - Each Layer instance is a lightweight facade over SAB arrays (like GameObject)
// - Layer.water.setUniform('uThreshold', 0.4) works from any thread
// - Background ownership: Layer.BACKGROUND.setTilemapBackground(...)
//   replaces the old Scene.setTilemapBackground() API
//
// LAYER ROUTING:
// - Any renderable type (entity, particle, decoration, bullet, light glow)
//   can target any custom layer via a layerId field on its component
// - Entities: SpriteRenderer.layerId
// - Particles: ParticleComponent.layerId
// - Decorations: DecorationComponent.layerId
// - Bullets: BulletComponent.layerId
// - Light glows: LightEmitter.layerIdOfGlowSprite (falls back to SpriteRenderer.layerId)
// - layerId=0 means default ENTITIES queue (zero overhead for the common case)
//
// THREAD SAFETY:
// - Config arrays written once at init (read-only after), except alpha
//   which is mutable from any worker via Atomics dirty flag
// - Uniform arrays use Atomics dirty flag for safe cross-worker writes
// - _postToRenderer is a main-thread-only callback (not cross-worker)

import { LAYER_DEFAULTS } from './ConfigDefaults.js';

export class Layer {
    static MAX_LAYERS = 16;
    static ENTITIES_ID = -1; // Set during init when ENTITIES is registered
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

    // Per-layer uniform SABs (only for layers with shaders)
    static _uniformSABs = [];     // SharedArrayBuffer[] indexed by layer id
    static _uniformFloats = [];   // Float32Array[] indexed by layer id
    static _uniformDirty = [];    // Int32Array[1][] indexed by layer id
    static _uniformMaps = [];     // { name: { offset, size } }[] indexed by layer id

    // Blend mode ID -> PixiJS string. Indices match BLEND_MODES enum in ConfigDefaults.js.
    static _BLEND_MODE_STRINGS = [
        'normal', 'inherit', 'add', 'multiply', 'screen', 'darken', 'lighten', 'erase',
        'color-dodge', 'color-burn', 'linear-burn', 'linear-dodge', 'linear-light',
        'hard-light', 'soft-light', 'pin-light', 'difference', 'exclusion', 'overlay',
        'saturation', 'color', 'luminosity', 'normal-npm', 'add-npm', 'screen-npm',
        'none', 'subtract', 'divide', 'vivid-light', 'hard-mix', 'negation', 'min', 'max',
    ];

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
    static _backgroundReadyResolvers = new Map();
    static _nextBackgroundRequestId = 1;

    constructor(id, name) {
        this.id = id;
        this.name = name;
        this._layerType = 'world';
    }

    // ========================================
    // FACADE GETTERS / SETTERS (read from static SAB arrays via this.id)
    // ========================================

    get zIndex() { return Layer._zIndex[this.id]; }
    get resolution() { return Layer._resolution[this.id]; }
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
    get layerType() { return this._layerType; }

    // ========================================
    // UNIFORM ACCESS (cross-worker safe via SAB + Atomics)
    // ========================================

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
    // BACKGROUND CONTROL (instance methods)
    // ========================================

    /**
     * Set a static background on this layer (simple Sprite, does not tile)
     * @param {string} textureId - ID of texture in assets.textures
     */
    setStaticBackground(textureId) {
        if (!Layer._postToRenderer) {
            console.warn('Layer: renderer not connected');
            return;
        }
        Layer._postBackgroundCommand({
            msg: 'setBackground',
            type: 'static',
            layerId: this.id,
            textureId,
        });
    }

    /**
     * Set a tiling background on this layer (TilingSprite - repeats pattern)
     * @param {string} textureId - ID of texture in assets.textures
     * @param {number} [tileScale=1] - Scale of tiles
     */
    setTilingBackground(textureId, tileScale = 1) {
        if (!Layer._postToRenderer) {
            console.warn('Layer: renderer not connected');
            return;
        }
        Layer._postBackgroundCommand({
            msg: 'setBackground',
            type: 'tiling',
            layerId: this.id,
            textureId,
            tileScale,
        });
    }

    /**
     * Set a tilemap background on this layer (@pixi/tilemap - varied tiles from Tiled editor)
     * @param {string} tilemapId - ID of tilemap in assets.tilemaps
     * @param {object} [options={}] - Options: { layers: [...], scale: 1 }
     * @returns {Promise<void>} Resolves when tilemap is built and warm-up render is complete
     */
    setTilemapBackground(tilemapId, options = {}) {
        if (!Layer._postToRenderer) {
            console.warn('Layer: renderer not connected');
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            Layer._postBackgroundCommand({
                msg: 'setBackground',
                type: 'tilemap',
                layerId: this.id,
                tilemapId,
                options,
            }, resolve);
        });
    }

    /**
     * Remove the current background from this layer
     */
    clearBackground() {
        if (!Layer._postToRenderer) {
            console.warn('Layer: renderer not connected');
            return;
        }
        Layer._postBackgroundCommand({
            msg: 'setBackground',
            type: 'none',
            layerId: this.id,
        });
    }

    // ========================================
    // BUILT-IN LAYER SHORTCUTS
    // ========================================

    /** @returns {Layer} */ static get BACKGROUND()    { return this._byName['BACKGROUND']; }
    /** @returns {Layer} */ static get DECALS()        { return this._byName['DECALS']; }
    /** @returns {Layer} */ static get CASTED_SHADOWS() { return this._byName['CASTED_SHADOWS']; }
    /** @returns {Layer} */ static get ENTITIES()      { return this._byName['ENTITIES']; }
    /** @returns {Layer} */ static get LIGHTING()      { return this._byName['LIGHTING']; }

    // ========================================
    // STATIC API
    // ========================================

    static get(name) { return this._byName[name] || null; }
    static getById(id) { return this._byId[id] || null; }
    static getAll() {
        if (this._allCacheCount !== this.count) {
            this._allCache = this._byId.filter(Boolean);
            this._allCacheCount = this.count;
        }
        return this._allCache;
    }

    static getId(name) {
        const layer = this._byName[name];
        return layer ? layer.id : -1;
    }

    static getName(id) {
        const layer = this._byId[id];
        return layer ? layer.name : null;
    }

    static getCustomLayers() {
        return this._byId.filter(l => l && this._hasRenderQueue[l.id] === 1 && l.id !== this.ENTITIES_ID);
    }

    static _createBackgroundRequestId() {
        const id = this._nextBackgroundRequestId;
        this._nextBackgroundRequestId =
            this._nextBackgroundRequestId >= 0x7fffffff ? 1 : this._nextBackgroundRequestId + 1;
        return id;
    }

    static _postBackgroundCommand(payload, resolve = null) {
        const requestId = this._createBackgroundRequestId();
        if (resolve) {
            this._backgroundReadyResolvers.set(requestId, resolve);
        }
        this._postToRenderer({ ...payload, requestId });
        return requestId;
    }

    /**
     * Resolve the pending background-ready promise for a specific request.
     * Called by Scene on `backgroundReady` from the renderer worker.
     */
    static resolveBackgroundReady(layerId, requestId) {
        if (requestId == null) return;
        const resolve = this._backgroundReadyResolvers.get(requestId);
        if (!resolve) return;
        this._backgroundReadyResolvers.delete(requestId);
        resolve();
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
        return Math.ceil(size / 4) * 4; // final align
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
        this._defaultYSorting = !!defaultYSorting;

        // Allocate config SAB
        this._configSAB = new SharedArrayBuffer(this._getConfigSABSize());
        this._createConfigViews(this._configSAB);

        // Register built-in layers (BACKGROUND, DECALS, CASTED_SHADOWS, ENTITIES, LIGHTING)
        for (const [name, config] of Object.entries(builtInLayers)) {
            const layer = this._register(name, {
                ...config,
                _builtIn: true,
                _layerType: config.layerType || this._deriveLayerType(name, true, !!config.shader),
            });
            if (name === 'ENTITIES') {
                this.ENTITIES_ID = layer.id;
                this._hasRenderQueue[layer.id] = 1;
            }
        }

        // Register custom layers from scene config
        for (const [name, config] of Object.entries(layersConfig)) {
            const layer = this._register(name, {
                ...config,
                _builtIn: false,
                _layerType: config.layerType || this._deriveLayerType(name, false, !!config.shader),
            });
            this._hasRenderQueue[layer.id] = 1;

            if (config.shader && config.shader.uniforms) {
                this._allocateUniformSAB(layer.id, config.shader.uniforms);
            }
        }

        this.initialized = true;
        this._buildMetadata(layersConfig, builtInLayers);
        return this;
    }

    static _deriveLayerType(name, builtIn = false, hasShader = false) {
        if (builtIn) {
            if (name === 'BACKGROUND') return 'background';
            if (name === 'DECALS') return 'decals';
            if (name === 'CASTED_SHADOWS') return 'shadows';
            if (name === 'ENTITIES') return 'world';
            if (name === 'LIGHTING') return 'lighting';
        }
        return hasShader ? 'screenRT' : 'world';
    }

    static _register(name, config = {}) {
        if (this.count >= this.MAX_LAYERS) {
            console.error(`Layer: MAX_LAYERS (${this.MAX_LAYERS}) exceeded, cannot register "${name}"`);
            return null;
        }

        const id = this.count++;
        const layer = new Layer(id, name);
        layer._builtIn = !!config._builtIn;
        layer._layerType = config._layerType || this._deriveLayerType(name, layer._builtIn, !!config.shader);

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

    static _allocateUniformSAB(layerId, uniformsConfig) {
        const map = {};
        let floatCount = 0;

        for (const [name, def] of Object.entries(uniformsConfig)) {
            const size = this._getUniformSize(def.type);
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
            entitiesId: this.ENTITIES_ID,
            layers: new Array(this.count),
        };

        for (let i = 0; i < this.count; i++) {
            const layer = this._byId[i];
            const name = layer.name;
            const isBuiltIn = !!layer._builtIn;
            const config = isBuiltIn
                ? (builtInLayers[name] || {})
                : (layersConfig[name] || {});

            const meta = {
                id: layer.id,
                name,
                builtIn: isBuiltIn,
                layerType: layer._layerType,
                zIndex: this._zIndex[i],
                blendMode: this._BLEND_MODE_STRINGS[this._blendModeId[i]] || 'normal',
                containerBlendMode: this._BLEND_MODE_STRINGS[this._containerBlendId[i]] || 'normal',
                hasShader: this._hasShader[i] === 1,
                ySorting: this._ySorting[i] === 1,
                resolution: this._resolution[i],
                alpha: this._alpha[i],
                hasRenderQueue: this._hasRenderQueue[i] === 1,
                maxItems: isBuiltIn ? 0 : (config.maxItems || 5000),
                uniformMap: this._uniformMaps[layer.id] || null,
                shaderFragment: config.shader?.fragment || null,
                shaderName: null,
                dynamicResolution: config.dynamicResolution || null,
                uniformTypes: null,
            };

            if (config.shader?.uniforms) {
                const uniformTypes = {};
                for (const [uName, uDef] of Object.entries(config.shader.uniforms)) {
                    uniformTypes[uName] = uDef.type || 'f32';
                }
                meta.uniformTypes = uniformTypes;
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
        this._uniformMaps = [];

        // Create typed views over the shared config SAB
        this._configSAB = data.configSAB;
        this._createConfigViews(this._configSAB);

        // Reconstruct registry from metadata
        const meta = data.metadata;
        this.count = meta.count;
        this.ENTITIES_ID = meta.entitiesId;

        for (let i = 0; i < meta.count; i++) {
            const layerMeta = meta.layers[i];
            if (!layerMeta) continue;
            const layer = new Layer(i, layerMeta.name);
            layer._builtIn = !!layerMeta.builtIn;
            layer._layerType = layerMeta.layerType || 'world';
            this._byName[layerMeta.name] = layer;
            this._byId[i] = layer;
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

        this.initialized = true;
    }

    // ========================================
    // RESET (scene cleanup)
    // ========================================

    static reset() {
        for (const resolve of this._backgroundReadyResolvers.values()) {
            resolve();
        }
        this._backgroundReadyResolvers.clear();

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
        this.ENTITIES_ID = -1;
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
        this._uniformSABs = [];
        this._uniformFloats = [];
        this._uniformDirty = [];
        this._uniformMaps = [];
        this._metadata = null;
        this._allCache = [];
        this._allCacheCount = -1;
        this._postToRenderer = null;
        this._nextBackgroundRequestId = 1;
    }
}
