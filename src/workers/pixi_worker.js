self.postMessage({
  msg: 'log',
  message: 'js loaded',
  when: Date.now(),
});

// webgpu_worker.js - Pure WebGPU renderer with GPU-side culling and sorting
// Uses compute shaders for visibility culling and Y-sorting

import { Transform } from '../components/Transform.js';
import { SpriteRenderer } from '../components/SpriteRenderer.js';
import { ParticleComponent } from '../components/ParticleComponent.js';
import { DecorationComponent } from '../components/DecorationComponent.js';
import { DecorationPool } from '../core/DecorationPool.js';
import { SpriteSheetRegistry } from '../core/SpriteSheetRegistry.js';
import { AbstractWorker } from './AbstractWorker.js';

import { RENDERER_STATS, createStatsWriter } from './workers-utils.js';
import { sortByY } from '../core/utils.js';

// ============================================================================
// SHADER CODE - RENDER PIPELINE
// ============================================================================

const RENDER_SHADER = /* wgsl */`
  struct Uniforms {
    cameraX: f32,
    cameraY: f32,
    zoom: f32,
    viewportWidth: f32,
    viewportHeight: f32,
    atlasWidth: f32,
    atlasHeight: f32,
    instanceCount: u32,
  }

  struct UVRect {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
  }

  // Packed instance data to stay within 8 storage buffer limit
  // Layout per instance (16 floats = 64 bytes, aligned):
  //   vec4: posX, posY, rotation, scaleX
  //   vec4: scaleY, anchorX, anchorY, uvId (as f32 bitcast)
  //   vec4: tintR, tintG, tintB, alpha
  struct InstanceData {
    posXY_rot_scaleX: vec4<f32>,    // x, y, rotation, scaleX
    scaleY_anchor_uvId: vec4<f32>,  // scaleY, anchorX, anchorY, uvId (bitcast)
    tint_alpha: vec4<f32>,          // tintR, tintG, tintB, alpha
  }

  @group(0) @binding(0) var<uniform> uniforms: Uniforms;
  @group(0) @binding(1) var textureSampler: sampler;
  @group(0) @binding(2) var atlasTexture: texture_2d<f32>;
  @group(0) @binding(3) var<storage, read> uvTable: array<UVRect>;

  // Single instance buffer (instead of 12 separate ones)
  @group(1) @binding(0) var<storage, read> instances: array<InstanceData>;

  struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) tint: vec4<f32>,
  }

  const quadPositions = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 1.0)
  );

  @vertex
  fn vertexMain(
    @builtin(vertex_index) vertexIndex: u32,
    @builtin(instance_index) instanceIndex: u32
  ) -> VertexOutput {
    let inst = instances[instanceIndex];

    // Unpack instance data
    let worldX = inst.posXY_rot_scaleX.x;
    let worldY = inst.posXY_rot_scaleX.y;
    let rot = inst.posXY_rot_scaleX.z;
    let sX = inst.posXY_rot_scaleX.w;
    let sY = inst.scaleY_anchor_uvId.x;
    let aX = inst.scaleY_anchor_uvId.y;
    let aY = inst.scaleY_anchor_uvId.z;
    let uvIdx = bitcast<u32>(inst.scaleY_anchor_uvId.w);

    // Get UV from lookup table
    let uv = uvTable[uvIdx];

    let quadPos = quadPositions[vertexIndex];

    // Sprite size from UV dimensions
    let spriteWidth = uv.w;
    let spriteHeight = uv.h;

    // Apply anchor
    var localPos = quadPos - vec2<f32>(aX, aY);
    localPos.x *= spriteWidth * sX;
    localPos.y *= spriteHeight * sY;

    // Apply rotation
    let cosR = cos(rot);
    let sinR = sin(rot);
    let rotatedPos = vec2<f32>(
      localPos.x * cosR - localPos.y * sinR,
      localPos.x * sinR + localPos.y * cosR
    );

    // World to screen
    let worldPos = vec2<f32>(worldX, worldY) + rotatedPos;
    let screenX = (worldPos.x - uniforms.cameraX) * uniforms.zoom;
    let screenY = (worldPos.y - uniforms.cameraY) * uniforms.zoom;

    // To NDC
    let ndcX = (screenX / uniforms.viewportWidth) * 2.0 - 1.0;
    let ndcY = 1.0 - (screenY / uniforms.viewportHeight) * 2.0;

    // UV coordinates
    let texU = (uv.x + quadPos.x * uv.w) / uniforms.atlasWidth;
    let texV = (uv.y + quadPos.y * uv.h) / uniforms.atlasHeight;

    var output: VertexOutput;
    output.position = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
    output.uv = vec2<f32>(texU, texV);
    output.tint = inst.tint_alpha;

    return output;
  }

  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let texColor = textureSample(atlasTexture, textureSampler, input.uv);
    let tintedColor = vec4<f32>(
      texColor.r * input.tint.r,
      texColor.g * input.tint.g,
      texColor.b * input.tint.b,
      texColor.a * input.tint.a
    );

    if (tintedColor.a < 0.01) {
      discard;
    }

    return tintedColor;
  }
`;

// ============================================================================
// WEBGPU RENDERER CLASS
// ============================================================================

class WebGPURenderer extends AbstractWorker {
  queryConfig = [SpriteRenderer];

  constructor(selfRef) {
    super(selfRef);

    // WebGPU core
    this.device = null;
    this.context = null;
    this.presentationFormat = null;

    // Pipeline
    this.renderPipeline = null;

    // Uniform buffer
    this.uniformBuffer = null;

    // Atlas
    this.atlasTexture = null;
    this.atlasSampler = null;
    this.atlasWidth = 0;
    this.atlasHeight = 0;

    // UV lookup table (GPU buffer)
    this.uvTableBuffer = null;
    this.uvCount = 0;
    this.uvNameToId = new Map(); // frameName -> uvId

    // Instance data buffers (raw data, uploaded once per type change)
    this.maxInstances = 0;
    this.instanceBuffers = null;

    // Compute shader buffers
    this.sortedIndicesBuffer = null;
    this.sortKeysBuffer = null;
    this.visibleCountBuffer = null;
    this.visibleCountStagingBuffer = null; // For reading back count

    // Bind groups
    this.uniformBindGroup = null;
    this.instanceBindGroup = null;

    // CPU-side arrays for uploading
    this.cpuArrays = null;

    // Dimensions
    this.canvasWidth = 0;
    this.canvasHeight = 0;

    // Camera interpolation
    this._renderCameraX = 0;
    this._renderCameraY = 0;
    this._renderZoom = 1.0;
    this._cameraInitialized = false;

    // Animation tracking
    this.currentFrameIndex = null;
    this.frameAccumulator = null;

    // Config
    this.ySorting = true;
    this.interpolation = true;
    this.physicsWorkerIndex = 1;

    // Stats
    this.visibleCount = 0;
    this.drawCallCount = 0;

    // Particle/decoration counts
    this.maxParticles = 0;
    this.maxDecorations = 0;

    // Y-sort pool (reused each frame)
    this._sortPool = [];
    this._sortPoolSize = 0;
  }

  async initializeWebGPU(canvas) {
    if (!navigator.gpu) {
      throw new Error('WebGPU not supported');
    }

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');

    this.device = await adapter.requestDevice();
    this.device.lost.then((info) => this.reportError('WebGPU Device Lost', new Error(info.message)));

    this.context = canvas.getContext('webgpu');
    this.presentationFormat = navigator.gpu.getPreferredCanvasFormat();

    this.context.configure({
      device: this.device,
      format: this.presentationFormat,
      alphaMode: 'premultiplied',
    });

    console.log('WEBGPU RENDERER: Device initialized');
  }

  async createPipeline() {
    const renderModule = this.device.createShaderModule({
      code: RENDER_SHADER,
      label: 'RenderShader'
    });

    // Check for shader compilation errors
    const compilationInfo = await renderModule.getCompilationInfo();
    if (compilationInfo.messages.length > 0) {
      for (const msg of compilationInfo.messages) {
        const type = msg.type; // 'error', 'warning', or 'info'
        const line = msg.lineNum;
        const col = msg.linePos;
        const text = msg.message;
        console.error(`WGSL ${type} at line ${line}:${col}: ${text}`);
      }
      const hasErrors = compilationInfo.messages.some(m => m.type === 'error');
      if (hasErrors) {
        throw new Error('Shader compilation failed - see console for details');
      }
    }

    this.renderPipeline = this.device.createRenderPipeline({
      label: 'MainRenderPipeline',
      layout: 'auto',
      vertex: { module: renderModule, entryPoint: 'vertexMain' },
      fragment: {
        module: renderModule,
        entryPoint: 'fragmentMain',
        targets: [{
          format: this.presentationFormat,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });

    console.log('WEBGPU RENDERER: Pipeline created');
  }

  createBuffers(maxInstances) {
    this.maxInstances = maxInstances;
    const dev = this.device;

    // Uniform buffer
    this.uniformBuffer = dev.createBuffer({
      label: 'UniformBuffer',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    // Packed instance data: 12 floats per instance (3 vec4s = 48 bytes)
    // Padded to 16-byte alignment (48 is already 16-aligned)
    this.INSTANCE_STRIDE = 12; // floats per instance
    this.INSTANCE_BYTE_STRIDE = this.INSTANCE_STRIDE * 4; // 48 bytes

    this.instanceBuffer = dev.createBuffer({
      label: 'InstanceDataBuffer',
      size: maxInstances * this.INSTANCE_BYTE_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // CPU-side packed array for uploading
    this.cpuInstanceData = new Float32Array(maxInstances * this.INSTANCE_STRIDE);
    // View for writing uvId as u32
    this.cpuInstanceDataU32 = new Uint32Array(this.cpuInstanceData.buffer);

    console.log(`WEBGPU RENDERER: Buffers created (max: ${maxInstances}, ${this.INSTANCE_BYTE_STRIDE} bytes/instance)`);
  }

  async uploadAtlasTexture(imageBitmap) {
    this.atlasWidth = imageBitmap.width;
    this.atlasHeight = imageBitmap.height;

    this.atlasTexture = this.device.createTexture({
      size: [imageBitmap.width, imageBitmap.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.device.queue.copyExternalImageToTexture(
      { source: imageBitmap },
      { texture: this.atlasTexture },
      [imageBitmap.width, imageBitmap.height]
    );

    this.atlasSampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    console.log(`WEBGPU RENDERER: Atlas uploaded (${imageBitmap.width}x${imageBitmap.height})`);
  }

  buildUVTable(spritesheetData, proxySheets) {
    if (!spritesheetData.bigAtlas) return;

    const json = spritesheetData.bigAtlas.json;
    const frames = Object.entries(json.frames);

    // Build UV table array
    const uvData = new Float32Array(frames.length * 4);
    let uvId = 0;

    for (const [frameName, frameData] of frames) {
      const frame = frameData.frame;
      this.uvNameToId.set(frameName, uvId);

      uvData[uvId * 4 + 0] = frame.x;
      uvData[uvId * 4 + 1] = frame.y;
      uvData[uvId * 4 + 2] = frame.w;
      uvData[uvId * 4 + 3] = frame.h;

      uvId++;
    }

    this.uvCount = uvId;

    // Create GPU buffer
    this.uvTableBuffer = this.device.createBuffer({
      size: uvData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.uvTableBuffer, 0, uvData);

    console.log(`WEBGPU RENDERER: UV table built (${this.uvCount} entries)`);

    // Register proxy sheets
    if (proxySheets) {
      for (const [proxyName, proxyData] of Object.entries(proxySheets)) {
        SpriteSheetRegistry.registerProxy(proxyName, proxyData);
      }
      console.log(`WEBGPU RENDERER: ${Object.keys(proxySheets).length} proxy sheets registered`);
    }
  }

  createBindGroups() {
    // Uniform bind group (group 0)
    this.uniformBindGroup = this.device.createBindGroup({
      label: 'UniformBindGroup',
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.atlasSampler },
        { binding: 2, resource: this.atlasTexture.createView() },
        { binding: 3, resource: { buffer: this.uvTableBuffer } },
      ],
    });

    // Instance bind group (group 1) - single packed buffer
    this.instanceBindGroup = this.device.createBindGroup({
      label: 'InstanceBindGroup',
      layout: this.renderPipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: { buffer: this.instanceBuffer } },
      ],
    });

    console.log('WEBGPU RENDERER: Bind groups created');
  }

  getUVId(frameName) {
    return this.uvNameToId.get(frameName) ?? 0;
  }

  getEntityFrameName(entityIndex) {
    const spritesheetId = SpriteRenderer.spritesheetId[entityIndex];
    const animState = SpriteRenderer.animationState[entityIndex];
    const frameIdx = this.currentFrameIndex?.[entityIndex] || 0;

    const sheetName = SpriteSheetRegistry.getSpritesheetName(spritesheetId);
    if (!sheetName) return '_white';

    const animName = SpriteSheetRegistry.getAnimationName(sheetName, animState);
    if (!animName) return '_white';

    const bigAtlas = SpriteSheetRegistry.spritesheets.get('bigAtlas');
    const sheet = SpriteSheetRegistry.spritesheets.get(sheetName);

    let prefixedAnimName = animName;
    if (sheet?.isProxy) {
      prefixedAnimName = `${sheetName}_${animName}`;
    }

    const animData = bigAtlas?.animations?.[prefixedAnimName];
    if (animData?.frames?.length > 0) {
      return animData.frames[frameIdx % animData.frames.length];
    }

    return animName;
  }

  tintToRGB(tint) {
    const b = ((tint >> 16) & 0xFF) / 255;
    const g = ((tint >> 8) & 0xFF) / 255;
    const r = (tint & 0xFF) / 255;
    return { r, g, b };
  }

  /**
   * Collect all instance data into CPU arrays with Y-sorting
   */
  collectInstanceData(deltaSeconds) {
    // Reset sort pool
    this._sortPoolSize = 0;

    // Collect entities into sort pool
    const entities = this.queryActiveEntities(this.queryConfig);
    for (const entityIdx of entities) {
      if (!Transform.active[entityIdx]) continue;
      if (!SpriteRenderer.renderVisible[entityIdx]) continue;
      if (!SpriteRenderer.isItOnScreen[entityIdx]) continue;

      // Advance animation
      if (SpriteRenderer.isAnimated[entityIdx]) {
        this.advanceAnimation(entityIdx, deltaSeconds);
      }

      const poolIdx = this._sortPoolSize++;
      if (!this._sortPool[poolIdx]) {
        this._sortPool[poolIdx] = { type: 'entity', idx: 0, y: 0 };
      }
      this._sortPool[poolIdx].type = 'entity';
      this._sortPool[poolIdx].idx = entityIdx;
      this._sortPool[poolIdx].y = Transform.y[entityIdx];
    }

    // Collect particles into sort pool
    for (let i = 0; i < this.maxParticles; i++) {
      if (!ParticleComponent.active[i]) continue;
      if (!ParticleComponent.isItOnScreen[i]) continue;

      const poolIdx = this._sortPoolSize++;
      if (!this._sortPool[poolIdx]) {
        this._sortPool[poolIdx] = { type: 'particle', idx: 0, y: 0 };
      }
      this._sortPool[poolIdx].type = 'particle';
      this._sortPool[poolIdx].idx = i;
      this._sortPool[poolIdx].y = ParticleComponent.y[i];
    }

    // Collect decorations into sort pool
    for (let i = 0; i < this.maxDecorations; i++) {
      if (!DecorationComponent.active[i]) continue;
      if (!DecorationComponent.isItOnScreen[i]) continue;

      const poolIdx = this._sortPoolSize++;
      if (!this._sortPool[poolIdx]) {
        this._sortPool[poolIdx] = { type: 'decoration', idx: 0, y: 0 };
      }
      this._sortPool[poolIdx].type = 'decoration';
      this._sortPool[poolIdx].idx = i;
      this._sortPool[poolIdx].y = DecorationComponent.y[i];
    }

    // Y-sort if enabled
    if (this.ySorting && this._sortPoolSize > 1) {
      this._sortPool.length = this._sortPoolSize;
      this._sortPool.sort(sortByY);
    }

    // Write sorted data to packed CPU array
    // Layout: [posX, posY, rotation, scaleX, scaleY, anchorX, anchorY, uvId, tintR, tintG, tintB, alpha]
    const data = this.cpuInstanceData;
    const dataU32 = this.cpuInstanceDataU32;
    const stride = this.INSTANCE_STRIDE;

    for (let i = 0; i < this._sortPoolSize; i++) {
      const item = this._sortPool[i];
      const base = i * stride;

      if (item.type === 'entity') {
        const idx = item.idx;
        const frameName = this.getEntityFrameName(idx);
        const rgb = this.tintToRGB(SpriteRenderer.tint[idx]);

        // vec4: posX, posY, rotation, scaleX
        data[base + 0] = Transform.x[idx];
        data[base + 1] = Transform.y[idx];
        data[base + 2] = Transform.rotation[idx];
        data[base + 3] = SpriteRenderer.scaleX[idx];
        // vec4: scaleY, anchorX, anchorY, uvId (as bitcast f32)
        data[base + 4] = SpriteRenderer.scaleY[idx];
        data[base + 5] = SpriteRenderer.anchorX[idx];
        data[base + 6] = SpriteRenderer.anchorY[idx];
        dataU32[base + 7] = this.getUVId(frameName); // Store as u32, shader bitcasts
        // vec4: tintR, tintG, tintB, alpha
        data[base + 8] = rgb.r;
        data[base + 9] = rgb.g;
        data[base + 10] = rgb.b;
        data[base + 11] = SpriteRenderer.alpha[idx];
      } else if (item.type === 'particle') {
        const idx = item.idx;
        const tid = ParticleComponent.textureId[idx];
        let frameName = '_white';
        if (tid >= 0) {
          const name = SpriteSheetRegistry.getAnimationName('bigAtlas', tid);
          if (name) frameName = name;
        }
        const rgb = this.tintToRGB(ParticleComponent.tint[idx]);

        data[base + 0] = ParticleComponent.x[idx];
        data[base + 1] = ParticleComponent.y[idx] + ParticleComponent.z[idx];
        data[base + 2] = ParticleComponent.rotation[idx];
        data[base + 3] = ParticleComponent.flipX[idx] ? -ParticleComponent.scaleX[idx] : ParticleComponent.scaleX[idx];
        data[base + 4] = ParticleComponent.flipY[idx] ? -ParticleComponent.scaleY[idx] : ParticleComponent.scaleY[idx];
        data[base + 5] = 0.5;
        data[base + 6] = 0.5;
        dataU32[base + 7] = this.getUVId(frameName);
        data[base + 8] = rgb.r;
        data[base + 9] = rgb.g;
        data[base + 10] = rgb.b;
        data[base + 11] = ParticleComponent.alpha[idx];
      } else if (item.type === 'decoration') {
        const idx = item.idx;
        const tid = DecorationComponent.textureId[idx];
        let frameName = '_white';
        if (tid >= 0) {
          const name = SpriteSheetRegistry.getAnimationName('bigAtlas', tid);
          if (name) frameName = name;
        }
        const rgb = this.tintToRGB(DecorationComponent.tint[idx]);

        data[base + 0] = DecorationComponent.x[idx] + DecorationComponent.offsetX[idx];
        data[base + 1] = DecorationComponent.y[idx] + DecorationComponent.offsetY[idx];
        data[base + 2] = DecorationComponent.rotation[idx];
        data[base + 3] = DecorationComponent.scaleX[idx];
        data[base + 4] = DecorationComponent.scaleY[idx];
        data[base + 5] = DecorationComponent.anchorX[idx];
        data[base + 6] = DecorationComponent.anchorY[idx];
        dataU32[base + 7] = this.getUVId(frameName);
        data[base + 8] = rgb.r;
        data[base + 9] = rgb.g;
        data[base + 10] = rgb.b;
        data[base + 11] = DecorationComponent.alpha[idx];
      }
    }

    return this._sortPoolSize;
  }

  advanceAnimation(entityIndex, deltaSeconds) {
    if (!this.frameAccumulator) return;

    this.frameAccumulator[entityIndex] += deltaSeconds;
    const speed = SpriteRenderer.animationSpeed[entityIndex] || 1;
    const frameDuration = 1 / (speed * 60);

    if (this.frameAccumulator[entityIndex] >= frameDuration) {
      this.frameAccumulator[entityIndex] -= frameDuration;

      const spritesheetId = SpriteRenderer.spritesheetId[entityIndex];
      const animState = SpriteRenderer.animationState[entityIndex];
      const sheetName = SpriteSheetRegistry.getSpritesheetName(spritesheetId);
      const animName = SpriteSheetRegistry.getAnimationName(sheetName, animState);

      let frameCount = 1;
      const bigAtlas = SpriteSheetRegistry.spritesheets.get('bigAtlas');
      const sheet = SpriteSheetRegistry.spritesheets.get(sheetName);
      let prefixedName = animName;
      if (sheet?.isProxy) prefixedName = `${sheetName}_${animName}`;

      if (bigAtlas?.animations?.[prefixedName]?.frames) {
        frameCount = bigAtlas.animations[prefixedName].frames.length;
      }

      const shouldLoop = SpriteRenderer.loop[entityIndex] === 1;
      const currentFrame = this.currentFrameIndex[entityIndex];

      if (shouldLoop || currentFrame < frameCount - 1) {
        this.currentFrameIndex[entityIndex] = (currentFrame + 1) % frameCount;
      }
    }
  }

  update(deltaTime, dtRatio, resuming) {
    // Camera interpolation
    let interpolationAlpha = 1.0;
    if (this.interpolation && this.frameRateData) {
      const physicsFPS = this.frameRateData[this.physicsWorkerIndex] || 60;
      if (physicsFPS > 0 && this.currentFPS > physicsFPS) {
        interpolationAlpha = Math.min(1.0, physicsFPS / this.currentFPS);
      }
    }

    const targetZoom = this.cameraData[0];
    const targetCamX = this.cameraData[1];
    const targetCamY = this.cameraData[2];

    if (!this._cameraInitialized) {
      this._renderCameraX = targetCamX;
      this._renderCameraY = targetCamY;
      this._renderZoom = targetZoom;
      this._cameraInitialized = true;
    } else {
      this._renderCameraX += (targetCamX - this._renderCameraX) * interpolationAlpha;
      this._renderCameraY += (targetCamY - this._renderCameraY) * interpolationAlpha;
      this._renderZoom += (targetZoom - this._renderZoom) * interpolationAlpha;
    }

    // Collect instance data (includes Y-sorting on CPU)
    const deltaSeconds = deltaTime / 1000;
    const totalCount = this.collectInstanceData(deltaSeconds);

    if (totalCount === 0) {
      this.renderEmpty();
      return;
    }

    // Upload data to GPU
    this.uploadInstanceData(totalCount);

    // Render (single instanced draw call)
    this.render(totalCount);
  }

  uploadInstanceData(count) {
    // Upload packed instance data in a single call
    const byteSize = count * this.INSTANCE_BYTE_STRIDE;
    this.device.queue.writeBuffer(
      this.instanceBuffer,
      0,
      this.cpuInstanceData.buffer,
      0,
      byteSize
    );
  }

  render(instanceCount) {
    // Safety check - don't render with invalid pipeline
    if (!this.renderPipeline || !this.uniformBindGroup || !this.instanceBindGroup) {
      console.warn('WEBGPU RENDERER: Cannot render - pipeline or bind groups not ready');
      return;
    }

    const dev = this.device;

    // Update render uniforms
    const uniforms = new Float32Array([
      this._renderCameraX,
      this._renderCameraY,
      this._renderZoom,
      this.canvasWidth,
      this.canvasHeight,
      this.atlasWidth,
      this.atlasHeight,
    ]);
    dev.queue.writeBuffer(this.uniformBuffer, 0, uniforms);
    dev.queue.writeBuffer(this.uniformBuffer, 28, new Uint32Array([instanceCount]));

    const commandEncoder = dev.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();

    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.1, g: 0.1, b: 0.15, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });

    renderPass.setPipeline(this.renderPipeline);
    renderPass.setBindGroup(0, this.uniformBindGroup);
    renderPass.setBindGroup(1, this.instanceBindGroup);
    renderPass.draw(6, instanceCount);
    renderPass.end();

    dev.queue.submit([commandEncoder.finish()]);
    this.drawCallCount = 1;
    this.visibleCount = instanceCount;
  }

  renderEmpty() {
    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();

    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.1, g: 0.1, b: 0.15, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    renderPass.end();

    this.device.queue.submit([commandEncoder.finish()]);
    this.drawCallCount = 0;
  }

  reportFPS() {
    if (this.stats) {
      this.stats[RENDERER_STATS.FPS] = this.currentFPS;
      this.stats[RENDERER_STATS.DRAW_CALLS] = this.drawCallCount;
      this.stats[RENDERER_STATS.VISIBLE_SPRITES] = this.visibleCount;
      this.stats[RENDERER_STATS.SPRITES_CREATED] = this.maxInstances;
      this.stats[RENDERER_STATS.VISIBLE_ENTITIES] = this.visibleCount; // Approximate
      this.stats[RENDERER_STATS.ACTIVE_DECORATIONS] = DecorationPool.activeCount?.[0] || 0;
    }
  }

  handleResize(data) {
    this.canvasWidth = data.width;
    this.canvasHeight = data.height;

    if (this.context && this.device) {
      this.context.configure({
        device: this.device,
        format: this.presentationFormat,
        alphaMode: 'premultiplied',
      });
    }
  }

  handleCustomMessage(data) {
    if (data.msg === 'resize') {
      this.handleResize(data);
    }
  }

  async initialize(data) {
    console.log('WEBGPU RENDERER: Initializing with compute shaders...');

    if (data.buffers.rendererStats) {
      this.stats = createStatsWriter(data.buffers.rendererStats, RENDERER_STATS);
    }

    this.canvasWidth = data.config.canvasWidth;
    this.canvasHeight = data.config.canvasHeight;

    await this.initializeWebGPU(data.view);
    await this.createPipeline();

    if (data.spritesheetMetadata) {
      SpriteSheetRegistry.deserialize(data.spritesheetMetadata);
    }

    // Calculate max instances
    this.maxParticles = data.maxParticles || 0;
    this.maxDecorations = data.maxDecorations || 0;
    const maxInstances = this.globalEntityCount + this.maxParticles + this.maxDecorations;

    this.createBuffers(maxInstances);

    // Upload atlas and build UV table
    if (data.spritesheets?.bigAtlas?.imageBitmap) {
      await this.uploadAtlasTexture(data.spritesheets.bigAtlas.imageBitmap);
    }
    this.buildUVTable(data.spritesheets, data.bigAtlasProxySheets);

    this.createBindGroups();

    // Animation tracking
    this.currentFrameIndex = new Uint16Array(this.globalEntityCount);
    this.frameAccumulator = new Float32Array(this.globalEntityCount);

    // Config
    const rendererConfig = data.config.renderer || {};
    this.ySorting = rendererConfig.ySorting !== false;
    this.interpolation = rendererConfig.interpolation !== false;

    // Check for noLimitFPS in renderer config (AbstractWorker checks 'webgpurenderer' key, not 'renderer')
    if (rendererConfig.noLimitFPS === true) {
      this.noLimitFPS = true;
      console.log('WEBGPU RENDERER: Running in unlimited FPS mode');
    }

    console.log('WEBGPU RENDERER: Initialized');
    console.log(`  Max instances: ${maxInstances}`);
    console.log(`  Y-sorting: ${this.ySorting} (GPU bitonic sort)`);
    console.log(`  Compute shaders: cull + sort`);
  }
}

self.webgpuRenderer = new WebGPURenderer(self);
