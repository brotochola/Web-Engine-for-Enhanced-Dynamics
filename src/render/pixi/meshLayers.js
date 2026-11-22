/**
 * N-256 PW-4: the renderer's MESH layers, moved out of pixiWorker.js as they were. The mesh memory (meshMemory.js) the
 * layers' batches live in and its corner kernel; a layer's UV fill batch, its corner and UV rewrites and their vertex
 * and UV generators; the pose source a compute layer reads; a layer drawn into its own target; and the look composite
 * a MESH layer with a look draws through.
 *
 * updateCustomLayers (still the worker's, PW-3) calls these each frame, a call a mesh layer: no loop here reads the
 * worker. Until the renderer's other subsystems move (N-256), what this class reads of the worker (its renderer,
 * backend, camera, canvas, shaders, assets and its render helpers) goes through `this.worker`.
 */

import { Layer } from '../../core/layer.js';
import { MeshGeometry } from '../../core/meshGeometry.js';
import { meshLayerCapacities } from '../../util/meshMemory.js';
import { Container, Mesh, RenderTexture, Sprite } from '../../vendor/pixi.min.js';
import { MESH_UV_VERT_FLOATS, packMeshUvVerts, packedMeshUvIndices } from '../colliderFillBatch.js';
import {
  bindMeshCorners,
  rewriteCornersWasm,
  rewriteVertsWasm,
  rewrittenFirstIndex,
  rewrittenFirstRow,
  rewrittenPastIndex,
  rewrittenPastRow,
} from '../meshCornersClient.js';
import { MeshUvFillBatch } from '../meshUvFillBatch.js';
import { writeRgba32Float } from '../webgpu/pinGpuTexture.js';

// The Pixi classes the moved bodies name as PIXI.X, as pixiWorker.js's namespace does.
const PIXI = Object.freeze({ RenderTexture, Sprite });

/** An instanced mesh with no instance this frame (the worker hides it, and a target draws nothing for it). */
export function emptyInstancedMesh(obj) {
  return !!(obj && obj.geometry && (obj.geometry.instanceCount | 0) === 0);
}

/** The MESH layers' batches, kernels and composite, for one renderer worker. */
export class PixiMeshLayers {
  /** @param {object} worker the PixiRenderer that owns this (its renderer, camera, layers and assets) */
  constructor(worker) {
    this.worker = worker;
    this.cornerFirstRow = 0; // the rows the last corner rewrite wrote: [first, past)
    this.cornerPastRow = 0;
    this.cornerFirstIndex = 0; // E-453: the UV batch's indices the last vertex rewrite wrote: [first, past)
    this.cornerPastIndex = 0;
    this.rtRoot = new Container();
    this.rtRoot.eventMode = 'none';
    this.rtRoot.cullable = false;
    // E-76 W11: the mesh memory (meshMemory.js) the MESH layers' batches live in, and the corner kernel.
    this.memoryBuffer = null;
    this.memoryLayout = null;
    this.cornersWasm = null;
  }

  /**
   * E-76 W11. The mesh memory the main thread made (meshMemory.js) and the corner kernel on it: with a MESH layer
   * MeshGeometry and every MESH layer's batches live there. Without one there is no memory and nothing to rewrite.
   */
  async bindMemory(data) {
    this.memoryBuffer = null;
    this.memoryLayout = null;
    this.cornersWasm = null;
    const mg = data.meshGeom;
    const memory = mg?.memory || null;
    const layout = mg?.layout || null;
    if (!memory || !layout) return;
    if (mg.data !== memory.buffer || MeshGeometry.vertOffset?.buffer !== memory.buffer) {
      throw new Error('meshCorners: MeshGeometry is not bound on the mesh memory');
    }
    if ((layout.entities | 0) !== (this.worker.globalEntityCount | 0)) {
      throw new Error(`meshCorners: the mesh memory holds ${layout.entities} entities, the scene ${this.worker.globalEntityCount}`);
    }
    this.memoryBuffer = memory.buffer;
    this.memoryLayout = layout;
    this.cornersWasm = await bindMeshCorners(memory, layout.tableByte, {
      vertOffset: MeshGeometry.vertOffset,
      vertCount: MeshGeometry.vertCount,
      indexOffset: MeshGeometry.indexOffset,
      indexCount: MeshGeometry.indexCount,
      vertexX: MeshGeometry.vertexX,
      vertexY: MeshGeometry.vertexY,
      uvU: MeshGeometry.uvU,
      uvV: MeshGeometry.uvV,
      indices: MeshGeometry.indices,
    });
  }

  /**
   * E-76 W11. The mesh memory's regions for MESH layer `layerId`, when the main thread sized them as this
   * worker sizes the layer's batches (meshLayerCapacities); else null, which initializeCustomLayers refuses.
   */
  layerRegion(layerId, caps) {
    const layout = this.memoryLayout;
    if (!layout || !this.memoryBuffer) return null;
    const layers = layout.layers || [];
    for (let i = 0; i < layers.length; i++) {
      const r = layers[i];
      if (r.layerId !== layerId) continue;
      return r.fillRows === caps.fill && r.uvVerts === caps.uvVerts && r.uvIndices === caps.uvIndices ? r : null;
    }
    return null;
  }

  ensureUvBatch(cl) {
    if (cl.uvFillBatch) return cl.uvFillBatch;
    const cap = cl.uvVertCapacity | 0;
    const indexCap = cl.uvIndexCapacity | 0;
    if (cap <= 0 || indexCap < 3) return null;
    // E-76 W11, E-453: the vertex records, their entities, the indices and the span table in the mesh memory when the
    // layer has its regions there.
    const region = cl.meshRegion;
    const buf = this.memoryBuffer;
    const there = !!(region && buf && region.uvVerts === cap && region.uvIndices === indexCap);
    const entities = there ? this.memoryLayout.entities | 0 : this.worker.globalEntityCount | 0;
    const renderer = this.worker.pixiApp?.renderer;
    const batch = new MeshUvFillBatch({
      bufferSystem: renderer?.buffer ?? null,
      geometrySystem: renderer?.geometry ?? null,
      capacity: cap,
      indexCapacity: indexCap,
      entities,
      label: `mesh-uv-${cl.layerId}`,
      useWebGpu: this.worker._useWebGpu,
      shaders: this.worker._engineShaders,
      atlasSource: this.worker.assets.resolveAtlasSource(),
      lutSource: this.worker.assets.texLutSource,
      data: there ? new Float32Array(buf, region.uvVertsByte, cap * MESH_UV_VERT_FLOATS) : null,
      vertexEntity: there ? new Uint32Array(buf, region.uvVertEntityByte, cap) : null,
      indices: there ? new Uint32Array(buf, region.uvIndicesByte, indexCap) : null,
      indexSpan: there ? new Uint32Array(buf, region.uvIndexSpanByte, entities * 2) : null,
    });
    batch.mesh.blendMode = cl.fillBatch?.mesh?.blendMode || cl.containerBlend || 'normal';
    cl.uvFillBatch = batch;
    if (cl.volumeFloor) batch.setVolumes();
    if (!cl.rt && !cl.meshLook) {
      const fill = cl.fillBatch?.mesh;
      if (fill?.parent) fill.parent.addChild(batch.mesh);
      else this.worker.pixiApp.stage.addChild(batch.mesh);
      if (fill) {
        batch.mesh.x = fill.x;
        batch.mesh.y = fill.y;
        batch.mesh.scale.set(fill.scale.x, fill.scale.y);
        batch.mesh.zIndex = fill.zIndex;
        batch.mesh.alpha = fill.alpha;
      }
    }
    return batch;
  }

  /**
   * World verts + camera on a reused Container. Pixi 8 ignores Mesh x/y/scale
   * when that Mesh is the RT render root.
   */
  uploadPoseSource(batch, label) {
    const src = batch?._poseSource;
    const pose = batch?.poseTable;
    if (!src || !pose) return;
    if (this.worker._useWebGpu) {
      const renderer = this.worker.pixiApp?.renderer;
      if (renderer) {
        writeRgba32Float(renderer, src, pose, batch._poseWidth, batch._poseHeight, label);
      }
    } else {
      this.worker._uploadRgba32FloatGl(src, pose, batch._poseWidth, batch._poseHeight);
    }
  }

  /**
   * E-76 W11. A MESH layer's instance list and generation copies, in its regions of the mesh memory (the UV batch holds
   * its records' entities itself, E-453).
   */
  bindSkipRegions(skip, r) {
    const buf = this.memoryBuffer;
    const n = this.memoryLayout.entities | 0;
    skip.instanceEntity = new Uint32Array(buf, r.fillEntityByte, r.fillRows);
    skip.lastVertGen = new Uint32Array(buf, r.lastVertGenByte, n);
    skip.frameVertGen = new Uint32Array(buf, r.frameVertGenByte, n);
    skip.lastUvGen = new Uint32Array(buf, r.lastUvGenByte, n);
    skip.frameUvGen = new Uint32Array(buf, r.frameUvGenByte, n);
  }

  /**
   * E-76 W11. The corner rewrite of a MESH layer's batch, through the corner kernel (meshCornersClient.js). Only
   * moved vertex generations call it, and those exist only with MeshGeometry, hence with the mesh memory and the kernel.
   */
  rewriteCorners(out, count, entityOfInstance, views, stride, lastVertGen, genNow, lastUvGen, uvGenNow) {
    const b = this.cornersWasm;
    if (b === null) throw new Error('meshCorners: a corner rewrite without the mesh memory');
    const result = rewriteCornersWasm(b, out, count, entityOfInstance, views, stride, lastVertGen, genNow, lastUvGen, uvGenNow);
    this.cornerFirstRow = result > 0 ? rewrittenFirstRow(b) : 0;
    this.cornerPastRow = result > 0 ? rewrittenPastRow(b) : 0;
    return result;
  }

  /**
   * E-453. The UV batch's vertex rewrite, through the corner kernel (rewriteVertsWasm): the records and indices it wrote
   * into _cornerFirstRow.._cornerPastRow and _cornerFirstIndex.._cornerPastIndex.
   */
  rewriteUvVerts(batch, count, views, lastVertGen, genNow, lastUvGen, uvGenNow) {
    const b = this.cornersWasm;
    if (b === null) throw new Error('meshCorners: a vertex rewrite without the mesh memory');
    const result = rewriteVertsWasm(b, batch, count, views, lastVertGen, genNow, lastUvGen, uvGenNow);
    const done = result > 0;
    this.cornerFirstRow = done ? rewrittenFirstRow(b) : 0;
    this.cornerPastRow = done ? rewrittenPastRow(b) : 0;
    this.cornerFirstIndex = done ? rewrittenFirstIndex(b) : 0;
    this.cornerPastIndex = done ? rewrittenPastIndex(b) : 0;
    return result;
  }

  ensureVertGenScratch(skip, views) {
    const n = views.entityCount | 0;
    if (!skip.lastVertGen || skip.lastVertGen.length < n) {
      const next = new Uint32Array(n);
      if (skip.lastVertGen) next.set(skip.lastVertGen);
      skip.lastVertGen = next;
    }
  }

  /**
   * Copy the live vertex generations before any vertex is read this frame.
   * Writers store the vertices, then bump the generation. Recording a copy
   * taken after the reads could mark a write that landed in between as seen,
   * with its vertices never drawn; from this copy, such a write still differs
   * next frame and is redrawn.
   * @returns {Uint32Array|null}
   */
  captureVertGen(skip, views) {
    const g = views.meshVertGen;
    if (!g) return null;
    const n = views.entityCount | 0;
    if (!skip.frameVertGen || skip.frameVertGen.length < n) skip.frameVertGen = new Uint32Array(n);
    const dst = skip.frameVertGen;
    if (g.length === n && dst.length === n) {
      dst.set(g);
    } else {
      dst.set(g.subarray(0, n));
    }
    return dst;
  }

  /** Record the generations captured this frame as drawn. */
  commitVertGen(skip, views) {
    if (!skip.frameVertGen || !views.meshVertGen) return;
    this.ensureVertGenScratch(skip, views);
    skip.lastVertGen.set(skip.frameVertGen.subarray(0, skip.lastVertGen.length));
  }

  /**
   * E-118. Copy the live UV generations right after the vertex generations, before any vertex or UV is
   * read this frame, for the reason _captureVertGen gives. The rewrite also redraws a run whose UV
   * generation moved alone, so a capture that caught one of a write's two bumps and not the other draws
   * the write the next frame.
   * @returns {Uint32Array|null}
   */
  captureUvGen(skip, views) {
    const g = views.meshUvGen;
    if (!g) return null;
    const n = views.entityCount | 0;
    if (skip.lastUvGen.length < n) {
      const next = new Uint32Array(n);
      next.set(skip.lastUvGen);
      skip.lastUvGen = next;
    }
    if (skip.frameUvGen.length < n) skip.frameUvGen = new Uint32Array(n);
    const dst = skip.frameUvGen;
    if (g.length === n && dst.length === n) {
      dst.set(g);
    } else {
      dst.set(g.subarray(0, n));
    }
    return dst;
  }

  /** E-118. Record the UV generations captured this frame as drawn. */
  commitUvGen(skip, views) {
    if (!views.meshUvGen) return;
    const last = skip.lastUvGen;
    last.set(skip.frameUvGen.subarray(0, last.length));
  }

  /**
   * E-453: the layer's UV meshes, each mesh's vertices once and its triangles as indices of them (packMeshUvVerts):
   * cl.uvPrevCount the records, cl.uvIndexCount the indices drawn.
   */
  packUvLayer(cl, views, skip) {
    if (!views.layerHasVertexUv) {
      if (cl.uvFillBatch) {
        cl.uvFillBatch.upload(0, 0);
        skip.uvLocalsReady = false;
        cl.uvPrevCount = 0;
        cl.uvIndexCount = 0;
      }
      return;
    }
    const batch = this.ensureUvBatch(cl);
    if (!batch) return;
    const packed = packMeshUvVerts(batch, cl.layerId, views);
    skip.uvLocalsReady = packed > 0;
    cl.uvPrevCount = packed;
    cl.uvIndexCount = batch.upload(packed, packedMeshUvIndices());
    if (packed > 0) {
      batch.uploadPoseTable(batch.vertexEntity, packed, views, skip.prevPose);
      this.uploadPoseSource(batch, 'mesh-uv-pose');
    }
  }

  renderFillToRt(cl, fillMesh) {
    const z = this.worker._renderZoom * (cl.resolution || 1);
    const mx = this.worker._meshRtTransform;
    const rot = this.worker._renderCameraRot || 0;
    if (!rot) {
      mx.set(z, 0, 0, z, -this.worker._renderCameraX * z, -this.worker._renderCameraY * z);
    } else {
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      const a = z * c;
      const b = z * s;
      const cc = -z * s;
      const d = z * c;
      const focusX = this.worker._renderCameraX + (this.worker.canvasWidth || 0) / (2 * (this.worker._renderZoom || 1));
      const focusY = this.worker._renderCameraY + (this.worker.canvasHeight || 0) / (2 * (this.worker._renderZoom || 1));
      const screenCx = (this.worker.canvasWidth || 0) * (cl.resolution || 1) * 0.5;
      const screenCy = (this.worker.canvasHeight || 0) * (cl.resolution || 1) * 0.5;
      mx.set(a, b, cc, d, screenCx - a * focusX - cc * focusY, screenCy - b * focusX - d * focusY);
    }
    const root = this.rtRoot;
    const uvMesh = cl.uvFillBatch?.mesh || null;
    root.removeChildren();
    root.addChild(fillMesh);
    if (uvMesh) root.addChild(uvMesh);
    fillMesh.x = 0;
    fillMesh.y = 0;
    if (fillMesh.scale.x !== 1 || fillMesh.scale.y !== 1) fillMesh.scale.set(1);
    if (uvMesh) {
      uvMesh.x = 0;
      uvMesh.y = 0;
      if (uvMesh.scale.x !== 1 || uvMesh.scale.y !== 1) uvMesh.scale.set(1);
    }
    root.x = 0;
    root.y = 0;
    if (root.scale.x !== 1 || root.scale.y !== 1) root.scale.set(1);
    const fillEmpty = emptyInstancedMesh(fillMesh);
    const uvEmpty = !uvMesh || emptyInstancedMesh(uvMesh);
    const rtOpts = this.worker._rtRenderOpts;
    rtOpts.container = fillEmpty && uvEmpty
      ? this.worker._rtEmptyContainer
      : root;
    rtOpts.target = cl.rt;
    rtOpts.clear = true;
    rtOpts.clearColor = this.worker._clearTransparent;
    rtOpts.transform = mx;
    this.worker._submitRender(rtOpts);
    rtOpts.transform = null;
  }

  /** A MESH layer whose look cannot go straight to the stage: its alpha, or the sun's on it, has to apply. */
  lookMustCompose(cl) {
    return Layer._alpha[cl.layerId] !== 1 || !!Layer._metadata?.layers?.[cl.layerId]?.alphaBySun;
  }

  /**
   * A look on a MESH layer draws to the screen directly from a user shader, which cannot hear the layer's alpha. A
   * layer that needs one goes through rtOut and a Sprite instead, as sprite look layers always do, and composes once.
   */
  ensureLookComposite(cl) {
    if (!cl || !cl.meshLook || cl.rtOut || !cl.shaderMesh) return;
    const resolution = cl.resolution || 1.0;
    cl.rtOut = PIXI.RenderTexture.create({ width: this.worker.canvasWidth * resolution, height: this.worker.canvasHeight * resolution });
    this.worker._applyCustomLayerScaleMode(cl);
    // Look-to-rtOut + Sprite already flips V (_createLayerFullscreenGeometry).
    cl.shaderMesh.geometry = this.worker._createLayerFullscreenGeometry(false);
    if (cl.shaderMesh.parent) cl.shaderMesh.parent.removeChild(cl.shaderMesh);
    if (cl.displaySprite) {
      cl.displaySprite.texture = cl.rtOut;
      cl.displaySprite.visible = true;
    } else {
      cl.displaySprite = new PIXI.Sprite(cl.rtOut);
      cl.displaySprite.anchor.set(0, 0);
      cl.displaySprite.position.set(0, 0);
    }
    cl.displaySprite.scale.set(1.0 / resolution);
    if (!cl.displaySprite.parent) this.worker.pixiApp.stage.addChild(cl.displaySprite);
    this.worker._registerLayerDisplayObject(Layer.getName(cl.layerId), cl.displaySprite);
    this.worker.pixiApp.stage.sortChildren();
    this.worker._syncLayerRefsFromRuntime();
  }

  lookFlipV() {
    // WebGL RT is top-origin; look-on-stage needs V flip.
    // WebGPU RT origin matches NDC — the same flip inverts terrain.
    return !this.worker._useWebGpu;
  }
}
