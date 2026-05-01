// TileMap.js - Tiled tilemap data with SharedArrayBuffer backing
// Static class with facade instances, backed by SharedArrayBuffer
//
// ARCHITECTURE:
// - Tilemaps loaded from scene config assets (Tiled JSON + tileset PNG)
// - Each TileMap instance is a lightweight facade over SAB-backed Int32Arrays
// - TileMap.myTilemap.sidewalk.getTileId(x, y) -- direct property access, zero lookups
// - TileMap.get('name') / tilemap.getLayer('name') -- dictionary fallback for dynamic names
// - TileMapLayer objects provide per-layer tile queries
//
// THREAD SAFETY:
// - Tile data arrays written once at init (read-only after)
// - All workers share the same SharedArrayBuffer memory -- zero duplication
// - No Atomics needed since data is immutable after initialization

const FLIPPED_H = 0x80000000;
const FLIPPED_V = 0x40000000;
const FLIPPED_D = 0x20000000;
const FLAG_MASK = ~(FLIPPED_H | FLIPPED_V | FLIPPED_D);

/**
 * A single tile layer within a TileMap.
 * Backed by an Int32Array view into a SharedArrayBuffer.
 */
class TileMapLayer {
    /**
     * @param {string} name
     * @param {Int32Array} data - View into SAB
     * @param {number} mapWidth - Map width in tiles
     * @param {number} mapHeight - Map height in tiles
     * @param {number} tileWidth - Tile width in pixels
     * @param {number} tileHeight - Tile height in pixels
     * @param {boolean} visible
     * @param {number} opacity - 0..1
     */
    constructor(name, data, mapWidth, mapHeight, tileWidth, tileHeight, visible, opacity) {
        this.name = name;
        this.data = data;
        this.mapWidth = mapWidth;
        this.mapHeight = mapHeight;
        this.tileWidth = tileWidth;
        this.tileHeight = tileHeight;
        this.visible = visible;
        this.opacity = opacity;
    }

    /**
     * Get tile GID at world pixel coordinates.
     * @param {number} worldX
     * @param {number} worldY
     * @returns {number} Raw tile GID (includes flip flags in top 3 bits). 0 = empty.
     */
    getTileId(worldX, worldY) {
        const tileX = (worldX / this.tileWidth) | 0;
        const tileY = (worldY / this.tileHeight) | 0;
        if (tileX < 0 || tileX >= this.mapWidth || tileY < 0 || tileY >= this.mapHeight) return 0;
        return this.data[tileY * this.mapWidth + tileX];
    }

    /**
     * Get tile GID at tile grid coordinates.
     * @param {number} tileX
     * @param {number} tileY
     * @returns {number} Raw tile GID. 0 = empty.
     */
    getTileIdAt(tileX, tileY) {
        if (tileX < 0 || tileX >= this.mapWidth || tileY < 0 || tileY >= this.mapHeight) return 0;
        return this.data[tileY * this.mapWidth + tileX];
    }

    /**
     * @param {number} worldX
     * @param {number} worldY
     * @returns {boolean}
     */
    hasTile(worldX, worldY) {
        return this.getTileId(worldX, worldY) !== 0;
    }

    /**
     * @param {number} tileX
     * @param {number} tileY
     * @returns {boolean}
     */
    hasTileAt(tileX, tileY) {
        return this.getTileIdAt(tileX, tileY) !== 0;
    }
}

/**
 * TileMap - SAB-backed tilemap data accessible from any thread.
 *
 * Static registry mirrors the Layer.js pattern:
 * - Main thread: `TileMap.initializeFromLoaded()` creates SABs from Tiled JSON
 * - Workers: `TileMap.initializeFromBuffers()` creates Int32Array views over shared SABs
 * - All threads: `TileMap.get('name')` returns the same logical tilemap, backed by shared memory
 */
export class TileMap {
    static _byName = {};
    static _byId = [];
    static count = 0;
    static initialized = false;
    static _sabs = [];
    static _metadata = null;

    /**
     * @param {number} id
     * @param {string} name
     * @param {number} mapWidth - Map width in tiles
     * @param {number} mapHeight - Map height in tiles
     * @param {number} tileWidth - Tile width in pixels
     * @param {number} tileHeight - Tile height in pixels
     * @param {Array<{firstgid:number, columns:number, tileWidth:number, tileHeight:number}>} tilesets
     */
    constructor(id, name, mapWidth, mapHeight, tileWidth, tileHeight, tilesets) {
        this.id = id;
        this.name = name;
        this.mapWidth = mapWidth;
        this.mapHeight = mapHeight;
        this.tileWidth = tileWidth;
        this.tileHeight = tileHeight;
        this.widthPx = mapWidth * tileWidth;
        this.heightPx = mapHeight * tileHeight;
        this.tilesets = tilesets;

        /** @type {TileMapLayer[]} */
        this._layers = [];
        /** @type {Object<string, TileMapLayer>} */
        this._layersByName = {};
        /** @type {string[]} */
        this._layerNames = [];

        // Pre-allocated result object for getAllTileIds() -- zero GC pressure
        // Populated with layer name keys after layers are added (_finalize)
        this._allTileIdsResult = null;
    }

    /**
     * Build pre-allocated result objects and assign direct layer property access.
     * Called once after all layers are registered.
     * After this, `tilemap.sidewalk` returns the TileMapLayer directly.
     * @private
     */
    _finalize() {
        const result = Object.create(null);
        for (let i = 0; i < this._layers.length; i++) {
            const layer = this._layers[i];
            result[layer.name] = 0;

            if (!(layer.name in this)) {
                this[layer.name] = layer;
            }
        }
        this._allTileIdsResult = result;
    }

    // ========================================
    // INSTANCE QUERY API
    // ========================================

    /**
     * @param {string} name - Layer name
     * @returns {TileMapLayer|null}
     */
    getLayer(name) {
        return this._layersByName[name] || null;
    }

    /** @returns {string[]} */
    getLayerNames() {
        return this._layerNames;
    }

    /** @returns {TileMapLayer[]} */
    getLayers() {
        return this._layers;
    }

    /**
     * Get tile GID at world coordinates, optionally from a specific layer.
     * Without layerName, returns the first non-zero GID scanning all layers.
     * @param {number} worldX
     * @param {number} worldY
     * @param {string} [layerName]
     * @returns {number} Tile GID. 0 = empty / out of bounds.
     */
    getTileId(worldX, worldY, layerName) {
        if (layerName !== undefined) {
            const layer = this._layersByName[layerName];
            return layer ? layer.getTileId(worldX, worldY) : 0;
        }
        for (let i = 0; i < this._layers.length; i++) {
            const gid = this._layers[i].getTileId(worldX, worldY);
            if (gid !== 0) return gid;
        }
        return 0;
    }

    /**
     * Get every layer's tile GID at world coordinates in one call.
     * Returns a pre-allocated object `{ layerName: gid, ... }` -- no allocation per call.
     * @param {number} worldX
     * @param {number} worldY
     * @returns {Object<string, number>} Reused object. Copy values if you need to store them.
     */
    getAllTileIds(worldX, worldY) {
        const tileX = (worldX / this.tileWidth) | 0;
        const tileY = (worldY / this.tileHeight) | 0;
        const oob = tileX < 0 || tileX >= this.mapWidth || tileY < 0 || tileY >= this.mapHeight;
        const idx = tileY * this.mapWidth + tileX;
        const result = this._allTileIdsResult;
        const layers = this._layers;
        for (let i = 0; i < layers.length; i++) {
            result[layers[i].name] = oob ? 0 : layers[i].data[idx];
        }
        return result;
    }

    /**
     * Convert world pixel coordinates to tile grid coordinates.
     * Writes into caller-owned output storage to avoid borrowed-object footguns.
     * @param {number} worldX
     * @param {number} worldY
     * @param {{tileX:number, tileY:number}} out
     * @returns {{tileX: number, tileY: number}} The same `out` object.
     */
    worldToTile(worldX, worldY, out) {
        out.tileX = (worldX / this.tileWidth) | 0;
        out.tileY = (worldY / this.tileHeight) | 0;
        return out;
    }

    /**
     * Convert tile grid coordinates to world pixel coordinates (center of tile).
     * Writes into caller-owned output storage to avoid borrowed-object footguns.
     * @param {number} tileX
     * @param {number} tileY
     * @param {{x:number, y:number}} out
     * @returns {{x: number, y: number}} The same `out` object.
     */
    tileToWorld(tileX, tileY, out) {
        out.x = tileX * this.tileWidth + this.tileWidth * 0.5;
        out.y = tileY * this.tileHeight + this.tileHeight * 0.5;
        return out;
    }

    // ========================================
    // COMPOSITE TILEMAP BUILDER (pixi worker)
    // ========================================

    /**
     * Populate a @pixi/tilemap CompositeTilemap from this TileMap's SAB data.
     * Called once during tilemap background setup in the pixi worker.
     * Handles tile flip flags and converts GIDs to tileset UV coordinates.
     * @param {*} compositeTilemap - A @pixi/tilemap CompositeTilemap instance
     * @param {Object} [options]
     * @param {string[]} [options.layers] - Layer names to render (null = all visible)
     */
    buildCompositeTilemap(compositeTilemap, options) {
        const { tileWidth, tileHeight, mapWidth, mapHeight, tilesets } = this;
        const tileset = tilesets[0];
        const tilesetColumns = tileset.columns;
        const firstGid = tileset.firstgid;
        const layers = this._layers;
        const layersFilter = options && options.layers;

        for (let li = 0; li < layers.length; li++) {
            const layer = layers[li];
            if (layersFilter && !layersFilter.includes(layer.name)) continue;
            if (!layer.visible) continue;

            const layerData = layer.data;
            const layerOpacity = layer.opacity;

            for (let y = 0; y < mapHeight; y++) {
                for (let x = 0; x < mapWidth; x++) {
                    let gid = layerData[y * mapWidth + x];
                    if (gid === 0) continue;

                    const fH = (gid & FLIPPED_H) !== 0;
                    const fV = (gid & FLIPPED_V) !== 0;
                    const fD = (gid & FLIPPED_D) !== 0;
                    gid = gid & FLAG_MASK;

                    const tileId = gid - firstGid;
                    if (tileId < 0) continue;

                    let rotation = 0;
                    if (fD) {
                        rotation = (fH && fV) ? 2 : fH ? 6 : fV ? 2 : 6;
                    } else if (fH && fV) {
                        rotation = 4;
                    } else if (fH) {
                        rotation = 12;
                    } else if (fV) {
                        rotation = 8;
                    }

                    compositeTilemap.tile(0, x * tileWidth, y * tileHeight, {
                        u: (tileId % tilesetColumns) * tileWidth,
                        v: ((tileId / tilesetColumns) | 0) * tileHeight,
                        tileWidth,
                        tileHeight,
                        rotate: rotation,
                        alpha: layerOpacity,
                    });
                }
            }
        }
    }

    // ========================================
    // STATIC API
    // ========================================

    /** @param {string} name @returns {TileMap|null} */
    static get(name) { return this._byName[name] || null; }

    /** @param {number} id @returns {TileMap|null} */
    static getById(id) { return this._byId[id] || null; }

    /** @returns {TileMap[]} */
    static getAll() { return this._byId.filter(Boolean); }

    /**
     * Register a tilemap in the static registry and assign it as a direct property
     * on the class for zero-lookup access (e.g. TileMap.myTilemap).
     * Skips property assignment if the name collides with an existing class member.
     * @param {TileMap} tilemap
     * @private
     */
    static _registerInstance(tilemap) {
        this._byName[tilemap.name] = tilemap;
        this._byId[tilemap.id] = tilemap;

        if (!(tilemap.name in this)) {
            this[tilemap.name] = tilemap;
        }
    }

    // ========================================
    // INITIALIZATION (main thread) - from loaded Tiled JSON
    // ========================================

    /**
     * Parse loaded tilemap data and create SAB-backed TileMap instances.
     * @param {Object<string, {data: Object, tilesetBitmap: ImageBitmap}>} loadedTilemaps
     */
    static initializeFromLoaded(loadedTilemaps) {
        this._byName = {};
        this._byId = [];
        this._sabs = [];
        this.count = 0;

        const metadataMap = {};

        for (const [tilemapId, loaded] of Object.entries(loadedTilemaps)) {
            const tiledData = loaded.data;
            const mapWidth = tiledData.width;
            const mapHeight = tiledData.height;
            const tileWidth = tiledData.tilewidth;
            const tileHeight = tiledData.tileheight;
            const tilesets = (tiledData.tilesets || []).map(ts => ({
                firstgid: ts.firstgid || 1,
                columns: ts.columns || 1,
                tileWidth: ts.tilewidth || tileWidth,
                tileHeight: ts.tileheight || tileHeight,
            }));

            const tileLayers = [];
            for (let i = 0; i < tiledData.layers.length; i++) {
                const layer = tiledData.layers[i];
                if (layer.type !== 'tilelayer') continue;
                if (!layer.data || layer.data.length === 0) continue;
                tileLayers.push(layer);
            }

            const tilesPerLayer = mapWidth * mapHeight;
            const sab = new SharedArrayBuffer(tileLayers.length * tilesPerLayer * 4);

            const id = this.count++;
            this._sabs[id] = sab;

            const tilemap = new TileMap(id, tilemapId, mapWidth, mapHeight, tileWidth, tileHeight, tilesets);

            const layerMetas = [];
            for (let li = 0; li < tileLayers.length; li++) {
                const layer = tileLayers[li];
                const view = new Int32Array(sab, li * tilesPerLayer * 4, tilesPerLayer);

                const src = layer.data;
                for (let i = 0; i < tilesPerLayer; i++) {
                    view[i] = src[i];
                }

                const vis = layer.visible !== false;
                const opa = layer.opacity !== undefined ? layer.opacity : 1;

                const tileLayer = new TileMapLayer(
                    layer.name, view, mapWidth, mapHeight, tileWidth, tileHeight, vis, opa,
                );

                tilemap._layers.push(tileLayer);
                tilemap._layersByName[layer.name] = tileLayer;
                tilemap._layerNames.push(layer.name);

                layerMetas.push({ name: layer.name, index: li, visible: vis, opacity: opa });
            }

            tilemap._finalize();
            this._registerInstance(tilemap);

            metadataMap[tilemapId] = {
                id, name: tilemapId,
                mapWidth, mapHeight, tileWidth, tileHeight,
                layers: layerMetas, tilesets,
            };
        }

        this._metadata = metadataMap;
        this.initialized = true;
    }

    // ========================================
    // SERIALIZATION (main thread -> workers)
    // ========================================

    /**
     * @returns {{sabs: Object<string, SharedArrayBuffer>, metadata: Object}|null}
     */
    static getSerializableData() {
        if (!this.initialized) return null;

        const sabs = {};
        for (let i = 0; i < this.count; i++) {
            const tilemap = this._byId[i];
            if (tilemap && this._sabs[i]) {
                sabs[tilemap.name] = this._sabs[i];
            }
        }

        return { sabs, metadata: this._metadata };
    }

    // ========================================
    // INITIALIZATION (workers) - from SABs + metadata
    // ========================================

    /**
     * Reconstruct TileMap instances from shared SABs + cloned metadata.
     * @param {{sabs: Object<string, SharedArrayBuffer>, metadata: Object}} data
     */
    static initializeFromBuffers(data) {
        if (!data || !data.metadata) return;

        this._byName = {};
        this._byId = [];
        this._sabs = [];
        this.count = 0;

        for (const [tilemapName, meta] of Object.entries(data.metadata)) {
            const sab = data.sabs[tilemapName];
            if (!sab) continue;

            const id = this.count++;
            this._sabs[id] = sab;

            const tilemap = new TileMap(
                id, meta.name,
                meta.mapWidth, meta.mapHeight,
                meta.tileWidth, meta.tileHeight,
                meta.tilesets,
            );

            const tilesPerLayer = meta.mapWidth * meta.mapHeight;

            for (let i = 0; i < meta.layers.length; i++) {
                const layerMeta = meta.layers[i];
                const view = new Int32Array(sab, layerMeta.index * tilesPerLayer * 4, tilesPerLayer);

                const tileLayer = new TileMapLayer(
                    layerMeta.name, view,
                    meta.mapWidth, meta.mapHeight,
                    meta.tileWidth, meta.tileHeight,
                    layerMeta.visible, layerMeta.opacity,
                );

                tilemap._layers.push(tileLayer);
                tilemap._layersByName[layerMeta.name] = tileLayer;
                tilemap._layerNames.push(layerMeta.name);
            }

            tilemap._finalize();
            this._registerInstance(tilemap);
        }

        this._metadata = data.metadata;
        this.initialized = true;
    }

    // ========================================
    // RESET (scene cleanup)
    // ========================================

    static reset() {
        for (const name of Object.keys(this._byName)) {
            if (this[name] === this._byName[name]) {
                delete this[name];
            }
        }
        this._byName = {};
        this._byId = [];
        this._sabs = [];
        this.count = 0;
        this.initialized = false;
        this._metadata = null;
    }
}
