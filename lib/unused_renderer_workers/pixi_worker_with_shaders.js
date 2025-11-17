// pixi_worker.js - GPU-Optimized Rendering Worker using gl.POINTS
// Ultra-high performance particle renderer: 100k+ entities at 60 FPS
// 1 vertex per entity instead of 4 (quad), all transformations in GPU shader

importScripts("config.js");
importScripts("gameObject.js");
importScripts("pixi4webworkers.js");

let FRAMENUM = 0;
let app;
let width, height, canvasWidth, canvasHeight, resolution, view;
let inputData;
let cameraData;
let entityCount = 0;
let lastTime = performance.now();
let fps = 0;
let pause = true;

// GPU Particle System
let particleSystem = null;
let particleGeometry = null;
let particleShader = null;

// Vertex Shader - Processes each particle (1 vertex per entity)
const vertexShader = `
precision highp float;

attribute vec2 aPosition;      // World position (x, y)
attribute float aRotation;     // Rotation in radians
attribute float aScale;        // Scale factor
attribute vec4 aColor;         // RGBA tint (0-1 range)
attribute float aAlpha;        // Alpha transparency
attribute float aFrame;        // Texture frame/atlas index

uniform mat3 projectionMatrix; // Pixi projection matrix
uniform vec2 uResolution;      // Screen resolution
uniform float uBaseSize;       // Base particle size in pixels
uniform float uZoom;           // Camera zoom
uniform vec2 uCameraPos;       // Camera position (x, y)

varying vec2 vUv;
varying vec4 vColor;
varying float vRotation;

void main() {
    // Apply camera transformation (zoom + pan)
    // First subtract camera position, then multiply by zoom
    vec2 worldPos = aPosition;
    vec2 viewPos = (worldPos - uCameraPos) * uZoom;
    
    // Apply Pixi projection to clip space
    gl_Position = vec4((projectionMatrix * vec3(viewPos, 1.0)).xy, 0.0, 1.0);
    
    // Set point size (scaled by entity scale and camera zoom)
    gl_PointSize = uBaseSize * aScale * uZoom;
    
    // Pass data to fragment shader
    vUv = vec2(0.5, 0.5); // Will be overridden by gl_PointCoord
    vColor = aColor * aAlpha; // Pre-multiply alpha
    vRotation = aRotation;
}
`;

// Fragment Shader - Renders each particle as a textured point sprite
const fragmentShader = `
precision highp float;

varying vec2 vUv;
varying vec4 vColor;
varying float vRotation;

uniform sampler2D uTexture;
uniform float uTime;

void main() {
    // gl_PointCoord gives UV coordinates (0,0 to 1,1) for the point sprite
    vec2 uv = gl_PointCoord;
    
    // Apply rotation to UV coordinates (rotate around center)
    if (vRotation != 0.0) {
        vec2 centered = uv - 0.5;
        float s = sin(vRotation);
        float c = cos(vRotation);
        mat2 rotMatrix = mat2(c, -s, s, c);
        uv = rotMatrix * centered + 0.5;
    }
    
    // Sample texture
    vec4 texColor = texture2D(uTexture, uv);
    
    // Apply tint and alpha
    vec4 finalColor = texColor * vColor;
    
    // Discard fully transparent pixels (improves performance)
    if (finalColor.a < 0.01) {
        discard;
    }
    
    gl_FragColor = finalColor;
}
`;

// GPU Particle Mesh - Custom Pixi Mesh using point sprites
class GPUParticleMesh extends PIXI.Mesh {
  constructor(texture, entityCount) {
    // Create geometry with point topology
    const geometry = new PIXI.Geometry();

    // Allocate buffers for all particle attributes
    // Each particle = 1 vertex with multiple attributes
    const positionData = new Float32Array(entityCount * 2); // x, y
    const rotationData = new Float32Array(entityCount); // rotation
    const scaleData = new Float32Array(entityCount); // scale
    const colorData = new Float32Array(entityCount * 4); // r, g, b, a
    const alphaData = new Float32Array(entityCount); // alpha
    const frameData = new Float32Array(entityCount); // frame index

    // Add attributes to geometry
    geometry.addAttribute("aPosition", positionData, 2); // 2 components (x, y)
    geometry.addAttribute("aRotation", rotationData, 1); // 1 component
    geometry.addAttribute("aScale", scaleData, 1); // 1 component
    geometry.addAttribute("aColor", colorData, 4); // 4 components (rgba)
    geometry.addAttribute("aAlpha", alphaData, 1); // 1 component
    geometry.addAttribute("aFrame", frameData, 1); // 1 component

    // Create custom shader
    const shader = PIXI.Shader.from(vertexShader, fragmentShader, {
      uTexture: texture,
      uResolution: [canvasWidth, canvasHeight],
      uBaseSize: 64.0, // Base size in pixels
      uZoom: 1.0,
      uCameraPos: [0.0, 0.0],
      uTime: 0.0,
    });

    super(geometry, shader, null, PIXI.DRAW_MODES.POINTS);

    this.entityCount = entityCount;

    // Store buffer references for fast updates
    this.positionBuffer = geometry.getBuffer("aPosition");
    this.rotationBuffer = geometry.getBuffer("aRotation");
    this.scaleBuffer = geometry.getBuffer("aScale");
    this.colorBuffer = geometry.getBuffer("aColor");
    this.alphaBuffer = geometry.getBuffer("aAlpha");
    this.frameBuffer = geometry.getBuffer("aFrame");

    // Keep references to data arrays
    this.positions = positionData;
    this.rotations = rotationData;
    this.scales = scaleData;
    this.colors = colorData;
    this.alphas = alphaData;
    this.frames = frameData;

    // Enable GL state for point sprites
    this.state.depthTest = false;
    this.state.blend = true;

    console.log(
      `GPU Particle System: Created buffers for ${entityCount} particles`
    );
  }

  // Ultra-fast update: copy GameObject arrays directly to GPU buffers
  updateFromGameObjects() {
    const goX = GameObject.x;
    const goY = GameObject.y;
    const goRotation = GameObject.rotation;
    const goScale = GameObject.scale;

    // Direct memory copy - extremely fast!
    for (let i = 0; i < this.entityCount; i++) {
      const i2 = i * 2;
      const i4 = i * 4;

      // Position
      this.positions[i2] = goX[i];
      this.positions[i2 + 1] = goY[i];

      // Rotation
      this.rotations[i] = goRotation[i];

      // Scale
      this.scales[i] = goScale[i];

      // Color (white tint, can be customized per entity later)
      this.colors[i4] = 1.0; // R
      this.colors[i4 + 1] = 1.0; // G
      this.colors[i4 + 2] = 1.0; // B
      this.colors[i4 + 3] = 1.0; // A

      // Alpha
      this.alphas[i] = 1.0;

      // Frame (for sprite sheet animation, currently 0)
      this.frames[i] = 0.0;
    }

    // Mark buffers as dirty to upload to GPU
    this.positionBuffer.update();
    this.rotationBuffer.update();
    this.scaleBuffer.update();
    this.colorBuffer.update();
    this.alphaBuffer.update();
    this.frameBuffer.update();
  }

  // Update camera transform
  updateCamera(zoom, cameraX, cameraY) {
    // Update camera uniforms - much simpler!
    this.shader.uniforms.uZoom = zoom;
    this.shader.uniforms.uCameraPos = [cameraX, cameraY];
  }
}

function gameLoop(resuming = false) {
  if (pause) return;
  FRAMENUM++;
  const now = performance.now();
  const deltaTime = now - lastTime;
  lastTime = now;
  fps = 1000 / deltaTime;

  // Read camera state from shared buffer
  const zoom = cameraData[0];
  const cameraX = cameraData[1];
  const cameraY = cameraData[2];

  // Update particle system with camera
  if (particleSystem) {
    particleSystem.updateCamera(zoom, cameraX, cameraY);

    // Copy GameObject data to GPU buffers
    // This is the ONLY CPU work per frame!
    particleSystem.updateFromGameObjects();
  }

  // Update time uniform for shader effects (optional)
  if (particleSystem) {
    particleSystem.shader.uniforms.uTime = now * 0.001;
  }

  // Log FPS every 30 frames
  if (FRAMENUM % 30 === 0) {
    self.postMessage({ msg: "fps", fps: fps.toFixed(2) });
  }
}

async function initPIXI(data) {
  pause = false;
  console.log(
    "🚀 GPU PARTICLE RENDERER: Initializing ultra-high performance mode"
  );

  entityCount = data.entityCount;

  // Initialize GameObject arrays
  GameObject.initializeArrays(data.gameObjectBuffer, entityCount);

  inputData = new Int32Array(data.inputBuffer);
  cameraData = new Float32Array(data.cameraBuffer);

  width = data.width;
  height = data.height;
  canvasWidth = data.canvasWidth;
  canvasHeight = data.canvasHeight;
  resolution = data.resolution;
  view = data.view;

  // Create PIXI application
  app = new PIXI.Application({
    width: canvasWidth,
    height: canvasHeight,
    resolution,
    view,
    backgroundColor: 0x000000,
    antialias: false,
    powerPreference: "high-performance",
    // Enable WebGL optimizations
    forceCanvas: false,
  });

  // Load texture
  const texture = await PIXI.Assets.load(
    "https://brotochola.github.io/render_from_webworkers_and_multithreading/1.png"
  );

  // Create GPU particle system - ONE DRAW CALL for all entities!
  particleSystem = new GPUParticleMesh(texture, entityCount);
  app.stage.addChild(particleSystem);

  console.log(`✨ GPU PARTICLE RENDERER: Ready!`);
  console.log(`   → ${entityCount} entities`);
  console.log(`   → ${entityCount} vertices (1 per entity)`);
  console.log(`   → 1 draw call total`);
  console.log(`   → 4x fewer vertices than quad-based rendering`);

  // Start render loop
  app.ticker.add(gameLoop);
}

self.onmessage = (e) => {
  if (e.data.msg === "init") {
    pause = false;
    initPIXI(e.data);
  }
  if (e.data.msg === "pause") {
    pause = true;
  }
  if (e.data.msg === "resume") {
    pause = false;
    gameLoop(true);
  }
};
