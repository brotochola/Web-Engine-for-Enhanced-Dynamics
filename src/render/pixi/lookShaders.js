/**
 * N-256: the look shaders, moved out of customLayers.js as they were. A layer's look is a fragment over what the layer
 * drew (or, for a SCREEN layer, over the finished frame): the program made from the game's GLSL or WGSL with the engine's
 * prelude, its uniforms from the layer's declared ones, the full-screen mesh that draws it, and the swap a game asks for
 * (Layer.setShader), which tears the old pass down and builds the new.
 *
 * The layers themselves (their records, targets and passes) stay in customLayers.js, reached through
 * `this.worker.customLayers`; the rest of the renderer through `this.worker`.
 */

import { Layer } from '../../core/layer.js';
import { GlProgram, GpuProgram, Mesh, Shader, Sprite, State, Texture, TextureSource } from '../../vendor/pixi.min.js';
import { assertLookShaderCompatible, errorCompileFailed } from '../rendererBackend.js';
import { isWgslSource, lookGpuProgram } from '../webgpu/pixiMeshWgsl.js';
import { findWgslUseBeforeDeclare, prependLookPrelude } from '../webgpu/wgslPrelude.js';

// The Pixi classes the moved bodies name as PIXI.X, as pixiWorker.js's namespace does.
const PIXI = Object.freeze({ Sprite, Texture });

/** The custom layers' look shaders: made, swapped and unbound, for one renderer worker. */
export class PixiLookShaders {
  /** @param {object} worker the PixiRenderer that owns this (its renderer and custom layers) */
  constructor(worker) {
    this.worker = worker;
  }

  buildUniformDefs(layerId, uniformMap, uniformTypes) {
    const uniformDefs = {};
    if (!uniformMap) return uniformDefs;
    const floats = Layer._uniformFloats[layerId];
    for (const [uName, entry] of Object.entries(uniformMap)) {
      const uType = uniformTypes?.[uName] || 'f32';
      if (entry.size === 1) {
        uniformDefs[uName] = { value: floats ? floats[entry.offset] : 0, type: uType };
      } else {
        const arr = new Float32Array(entry.size);
        if (floats) {
          for (let k = 0; k < entry.size; k++) arr[k] = floats[entry.offset + k];
        }
        uniformDefs[uName] = { value: arr, type: uType };
      }
    }
    return uniformDefs;
  }

  /**
   * @param {TextureSource|null} [sceneSource] DX-POST: a SCREEN pass that reads uScene (the frame before the first pass)
   */
  create(fragmentSource, textureSource, uniformDefs, name, layerName, sceneSource = null) {
    const asset = name || 'look';
    const layer = layerName || name || 'look';
    const backend = this.worker._useWebGpu ? 'webgpu' : 'webgl';
    assertLookShaderCompatible({
      backend,
      layerName: layer,
      asset,
      path: asset,
      source: fragmentSource,
    });
    const backendLabel = this.worker._useWebGpu ? 'WebGPU' : 'WebGL';
    try {
      if (this.worker._useWebGpu) {
        // Engine prelude generates GlobalUniforms/LocalUniforms/CustomUniforms/
        // VertexOut + group(2) bindings from the layer uniform map.
        let wgslSource = fragmentSource;
        if (isWgslSource(wgslSource)) {
          const layerObj = Layer.get(layer);
          const lid = layerObj ? layerObj.id : -1;
          wgslSource = prependLookPrelude(
            wgslSource,
            Layer._uniformMaps[lid] || null,
            Layer._metadata?.layers?.[lid]?.uniformTypes || null,
            { scene: sceneSource !== null }
          );
        }
        const earlyLook = findWgslUseBeforeDeclare(wgslSource);
        if (earlyLook.length) {
          throw new Error(
            earlyLook.map((e) => `'${e.name}' used before declaration (line ${e.line})`).join('; ')
          );
        }
        const gpuProgram = lookGpuProgram(
          GpuProgram,
          wgslSource,
          asset,
          this.worker._engineShaders.lookVert,
          sceneSource !== null
        );
        return new Shader({
          gpuProgram,
          resources: sceneSource !== null
            ? { customUniforms: uniformDefs, uTexture: textureSource, uSampler: textureSource.style, uScene: sceneSource }
            : { customUniforms: uniformDefs, uTexture: textureSource, uSampler: textureSource.style },
        });
      }
      const lookVert = this.worker._engineShaders.lookVert;
      if (!lookVert) {
        throw new Error(
          'WeedJS: Fullscreen look vertex shader was not loaded before look program creation.'
        );
      }
      const glProgram = GlProgram.from({
        vertex: lookVert,
        fragment: fragmentSource,
        name: asset,
      });
      return new Shader({
        glProgram,
        resources: sceneSource !== null
          ? { customUniforms: uniformDefs, uTexture: textureSource, uScene: sceneSource }
          : { customUniforms: uniformDefs, uTexture: textureSource },
      });
    } catch (err) {
      throw errorCompileFailed('look', asset, layer, backendLabel, err);
    }
  }

  makeMesh(shader, flipV) {
    const state = new State();
    state.blend = true;
    state.depthTest = false;
    state.depthMask = false;
    state.culling = false;
    const mesh = new Mesh({
      geometry: this.worker._createLayerFullscreenGeometry(!!flipV),
      shader,
      state,
    });
    mesh.eventMode = 'none';
    mesh.cullable = false;
    return mesh;
  }

  unbindTexture(shader) {
    const res = shader?.resources;
    if (!res) return;
    const empty = PIXI.Texture.EMPTY;
    if (res.uTexture) res.uTexture = empty.source;
    if (res.uSampler) res.uSampler = empty.source.style;
  }

  /**
   * Live-swap custom layer fragment, or bypass post-process (shader=null).
   * Bypass keeps density RT at layer resolution and shows raw accumulation —
   * avoids dumping tens of thousands of sprites onto the full-res stage.
   */
  setLayerShader(layerName, fragmentSource, shaderName) {
    const layerObj = Layer.get(layerName);
    if (!layerObj || layerObj.builtIn) return;
    const cl = this.worker.customLayers.byId[layerObj.id];
    if (!cl || (!cl.batch && !cl.splatBatch && !cl.compute && !cl.fillBatch)) return;

    const meta = Layer._metadata?.layers?.[layerObj.id];
    if (meta) {
      meta.shaderName = shaderName || null;
      meta.shaderFragment = fragmentSource || null;
    }

    const resolution = cl.resolution || 1.0;

    // (none): keep density RT, skip fullscreen frag, show raw cl.rt
    if (!fragmentSource) {
      if (!cl.compute && !cl.rt) this.worker.customLayers._ensureDensityRT(cl);
      this._destroyPostProcess(cl);
      cl.shaderBypass = true;
      if (cl.fillBatch && cl.rt && !cl.displaySprite) {
        cl.displaySprite = new PIXI.Sprite(cl.rt);
        cl.displaySprite.anchor.set(0, 0);
        cl.displaySprite.position.set(0, 0);
        cl.displaySprite.scale.set(1.0 / resolution);
        this.worker.pixiApp.stage.addChild(cl.displaySprite);
      } else if (cl.displaySprite && cl.rt) {
        cl.displaySprite.texture = cl.rt;
        cl.displaySprite.scale.set(1.0 / resolution);
        if (!cl.displaySprite.parent) this.worker.pixiApp.stage.addChild(cl.displaySprite);
      }
      this.worker._registerLayerDisplayObject(layerName, cl.displaySprite);
      this.worker.pixiApp.stage.sortChildren();
      this.worker._syncLayerRefsFromRuntime();
      return;
    }

    cl.shaderBypass = false;
    if (!cl.compute) this.worker.customLayers._ensureDensityRT(cl);
    this._destroyPostProcess(cl);

    if (meta) meta.hasShader = true;
    if (Layer._hasShader) Layer._hasShader[layerObj.id] = 1;

    const uniformMap = meta?.uniformMap || null;
    const uniformTypes = meta?.uniformTypes || null;
    cl.uniformEntries = uniformMap ? Object.entries(uniformMap) : null;
    const uniformDefs = this.buildUniformDefs(cl.layerId, uniformMap, uniformTypes);

    try {
      const lookSource = cl.lookSource || cl.rt.source;
      cl.shader = this.create(fragmentSource, lookSource, uniformDefs, shaderName || 'look', layerName);
      cl.uniformStore = cl.shader.resources?.customUniforms?.uniforms || null;
      cl.shaderMesh = this.makeMesh(cl.shader, !!cl.fillBatch && this.worker.meshLayers.lookFlipV());
    } catch (err) {
      if (err && typeof err.message === 'string' && err.message.startsWith('WeedJS:')) throw err;
      throw errorCompileFailed('look', shaderName || 'look', layerName, this.worker._useWebGpu ? 'WebGPU' : 'WebGL', err);
    }

    if (cl.fillBatch && cl.rtOut) {
      cl.meshLook = true;
      cl.shaderMesh.geometry = this.worker._createLayerFullscreenGeometry(false);
      cl.displaySprite.texture = cl.rtOut; // (none) left it on cl.rt
      cl.displaySprite.visible = true;
      this.worker._registerLayerDisplayObject(layerName, cl.displaySprite);
    } else if (cl.fillBatch) {
      cl.meshLook = true;
      if (cl.displaySprite) {
        cl.displaySprite.visible = false;
        if (cl.displaySprite.parent) cl.displaySprite.parent.removeChild(cl.displaySprite);
      }
      if (!cl.shaderMesh.parent) this.worker.pixiApp.stage.addChild(cl.shaderMesh);
      this.worker._registerLayerDisplayObject(layerName, cl.shaderMesh, false);
      if (this.worker.meshLayers.lookMustCompose(cl)) this.worker.meshLayers.ensureLookComposite(cl);
    } else {
      cl.displaySprite.texture = cl.rtOut;
      cl.displaySprite.scale.set(1.0 / resolution);
      this.worker._registerLayerDisplayObject(layerName, cl.displaySprite);
    }
    this.worker.pixiApp.stage.sortChildren();
    this.worker._syncLayerRefsFromRuntime();

    if (Layer._uniformDirty?.[cl.layerId]) {
      Atomics.store(Layer._uniformDirty[cl.layerId], 0, 1);
    }
  }

  _destroyPostProcess(cl) {
    if (!cl) return;
    if (cl.shaderMesh) {
      cl.shaderMesh.destroy(true);
      cl.shaderMesh = null;
    }
    cl.shader = null;
    cl.uniformStore = null;
  }
}
