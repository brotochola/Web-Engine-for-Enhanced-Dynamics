// The mesh memory (E-76 W11): MeshGeometry's block at byte 0 of one shared WebAssembly.Memory, and after it
// Pixi's mesh batches with their instance lists and generation copies (wasmMemoryMap.js meshMemoryRegions),
// so the corner kernel (meshCorners.wasm) rewrites the rows where Pixi uploads them from the meshes where
// logic workers wrote them. The main thread makes it before any worker starts. Every worker binds
// MeshGeometry on its buffer as it bound the plain SharedArrayBuffer; Pixi views a MESH layer's batches at
// the layout's offsets when their capacities are the ones it computes itself (meshLayerCapacities).

import { LAYER_KIND, MAX_POLYGON_VERTICES } from './configDefaults.js';
import { meshMemoryRegions } from './wasmMemoryMap.js';

// The module's import accepts up to 8192 pages (512 MB): wasm/modules.json maxMemoryPages.
const WASM_MAX_PAGES = 8192;

/**
 * The batch capacities Pixi gives every MESH layer (pixiWorker initializeCustomLayers): fixtures or one
 * primary shape per entity, each convex at most MAX_POLYGON_VERTICES - 2 fans, plus the explicit meshes'
 * fans and indexed triangles; the UV batch holds the explicit ones only.
 * @returns {{ fill: number, uv: number }} rows
 */
export function meshLayerCapacities(maxFixtures, entities, maxMeshVerts, maxMeshIndices) {
  const colliderCap = Math.max(maxFixtures | 0, entities | 0) * (MAX_POLYGON_VERTICES - 2);
  const verts = maxMeshVerts | 0;
  const fanCap = verts > 2 ? verts - 2 : 0;
  const indexCap = ((maxMeshIndices | 0) / 3) | 0;
  const explicitCap = fanCap + indexCap;
  return { fill: Math.max(1, colliderCap + explicitCap), uv: explicitCap };
}

/** The MESH layers Pixi gives batches to (initializeCustomLayers), in the order of the layer metadata. */
export function meshLayerIds(metadata) {
  const ids = [];
  const layers = metadata?.layers || [];
  for (let i = 0; i < layers.length; i++) {
    const meta = layers[i];
    if (!meta || meta.builtIn || meta.id === metadata.entitiesId) continue;
    if (meta.kind === LAYER_KIND.MESH) ids.push(meta.id);
  }
  return ids;
}

/**
 * The mesh memory for `layerIds`, each with the capacities `caps`, or null when there is no MESH layer
 * (nothing for the kernel to rewrite) or the memory would not fit the module's import.
 * @param {number} geometryBytes MeshGeometry.getBufferSize(maxVerts, maxIndices, entities)
 * @param {number} entities
 * @param {number[]} layerIds meshLayerIds(Layer metadata)
 * @param {{ fill: number, uv: number }} caps meshLayerCapacities(...)
 * @returns {null | { memory: WebAssembly.Memory, buffer: SharedArrayBuffer, layout: Record<string, any> }}
 */
export function createMeshMemory(geometryBytes, entities, layerIds, caps) {
  if (!layerIds || layerIds.length === 0) return null;
  const fill = caps.fill | 0;
  const uv = caps.uv | 0;
  const map = meshMemoryRegions(geometryBytes | 0, entities | 0, layerIds.map(() => ({ fillRows: fill, uvRows: uv })));
  if (map.pages > WASM_MAX_PAGES) return null;
  const r = map.regions;
  try {
    const memory = new WebAssembly.Memory({ initial: map.pages, maximum: map.pages, shared: true });
    return {
      memory,
      buffer: memory.buffer,
      // Plain numbers, so the layout posts to workers as it is.
      layout: {
        entities: entities | 0,
        geometryBytes: geometryBytes | 0,
        tableByte: r.meshCornerTable.byte,
        layers: layerIds.map((layerId, k) => ({
          layerId,
          fillRows: fill,
          uvRows: uv,
          fillRowsByte: r[`meshFillRows${k}`].byte,
          uvRowsByte: r[`meshUvRows${k}`].byte,
          fillEntityByte: r[`meshFillEntity${k}`].byte,
          uvEntityByte: r[`meshUvEntity${k}`].byte,
          lastVertGenByte: r[`meshLastVertGen${k}`].byte,
          frameVertGenByte: r[`meshFrameVertGen${k}`].byte,
          lastUvGenByte: r[`meshLastUvGen${k}`].byte,
          frameUvGenByte: r[`meshFrameUvGen${k}`].byte,
        })),
      },
    };
  } catch {
    return null;
  }
}
