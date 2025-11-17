// lighting_worker.js - Calculates lighting contributions and object tints
// Uses lumens/d² formula to determine how much light each object receives

importScripts("config.js");
importScripts("gameObject.js");
importScripts("abstractLightSourceEntity.js");
importScripts("AbstractWorker.js");

// Lighting constants
const AMBIENT_LIGHT = 0.05; // Minimum brightness (5%)
const MAX_LIGHTS_TO_RENDER = 200; // Maximum lights sent to shader

/**
 * LightingWorker - Calculates lighting for all entities
 * Extends AbstractWorker for common worker functionality
 */
class LightingWorker extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);

    // Light source instances (references to entities that emit light)
    this.lightSources = [];
    this.lightSourceIndices = [];

    // Output data structures
    this.visibleLights = []; // Screen-space light data for shader
    this.objectTints = null; // Brightness value per entity (Float32Array)
  }

  /**
   * Initialize the lighting worker (implementation of AbstractWorker.initialize)
   */
  initialize(data) {
    console.log("LIGHTING WORKER: Initializing");

    // Initialize common buffers from AbstractWorker
    this.initializeCommonBuffers(data);

    // Initialize all entity arrays using standardized method
    const registeredClasses = data.registeredClasses || [];
    this.initializeEntityArrays(
      data.entityBuffers,
      registeredClasses,
      data.lightSourceIndices
    );

    // Store light source indices for fast iteration
    this.lightSourceIndices = data.lightSourceIndices || [];

    // Build mapping from GameObject index to light source index
    this.lightSourceIndexMap = new Map(data.lightSourceIndexMap || []);

    // Allocate tint buffer (one brightness value per entity)
    this.objectTints = new Float32Array(this.entityCount);

    // Initialize all tints to ambient light
    this.objectTints.fill(AMBIENT_LIGHT);

    console.log(
      `LIGHTING WORKER: Ready to process ${this.entityCount} entities`
    );

    // Start the lighting calculation loop
    this.startGameLoop();
  }

  /**
   * Calculate lighting each frame (implementation of AbstractWorker.update)
   */
  update(deltaTime, dtRatio, resuming) {
    // Step 1: Find visible lights and convert to screen space
    this.findVisibleLights();

    // Step 2: Send lighting data to main thread (which forwards to pixi_worker)
    this.sendLightingData();
  }

  /**
   * Find lights visible on screen and prepare data for shader
   * Converts world coordinates to screen coordinates
   */
  findVisibleLights() {
    this.visibleLights.length = 0; // Clear previous frame

    // Get camera data
    const zoom = this.cameraData[0];
    const cameraX = this.cameraData[1];
    const cameraY = this.cameraData[2];

    // Screen bounds in world coordinates (with margin for light radius)
    const margin = 500; // Extra margin for lights near screen edge
    const worldLeft = cameraX - margin;
    const worldRight = cameraX + CANVAS_WIDTH / zoom + margin;
    const worldTop = cameraY - margin;
    const worldBottom = cameraY + CANVAS_HEIGHT / zoom + margin;

    // Iterate through all light sources
    for (let i = 0; i < this.lightSourceIndices.length; i++) {
      if (this.visibleLights.length >= MAX_LIGHTS_TO_RENDER) break;

      const lightIndex = this.lightSourceIndices[i];

      // Skip inactive lights
      if (!GameObject.active[lightIndex]) continue;

      const worldX = GameObject.x[lightIndex];
      const worldY = GameObject.y[lightIndex];

      // Frustum culling - skip lights outside screen bounds
      if (
        worldX < worldLeft ||
        worldX > worldRight ||
        worldY < worldTop ||
        worldY > worldBottom
      ) {
        continue;
      }

      // Convert to screen coordinates
      const screenX = (worldX - cameraX) * zoom;
      const screenY = (worldY - cameraY) * zoom;

      // Get light source index (mapped from GameObject index)
      const lightSourceIndex = this.lightSourceIndexMap.get(lightIndex);
      if (lightSourceIndex === undefined) {
        console.error(
          `No light source index mapping found for GameObject index ${lightIndex}`
        );
        continue;
      }

      // Get light properties using light source index
      const lumens = AbstractLightSourceEntity.lumens[lightSourceIndex];
      const r = AbstractLightSourceEntity.colorR[lightSourceIndex] / 255;
      const g = AbstractLightSourceEntity.colorG[lightSourceIndex] / 255;
      const b = AbstractLightSourceEntity.colorB[lightSourceIndex] / 255;

      // Calculate effective radius - use simpler formula
      // Just use a fixed multiplier based on lumens
      const baseRadius = 100; // Base radius in pixels
      const radiusMultiplier = Math.sqrt(lumens / 100); // Scale with square root of lumens
      let screenRadius = baseRadius * radiusMultiplier * zoom;

      // Clamp radius to reasonable values (50-200 screen pixels)
      screenRadius = Math.max(50, Math.min(screenRadius, 200));

      // Store light data for shader
      this.visibleLights.push({
        screenX,
        screenY,
        screenRadius, // Now properly clamped
        r,
        g,
        b,
        lumens, // Keep for intensity calculation
      });
    }
  }

  /**
   * Send lighting data to main thread (forwarded to pixi_worker)
   */
  sendLightingData() {
    // Prepare light data array for shader (flat array format)
    // Format: [x1, y1, r1, g1, b1, radius1, intensity1, x2, y2, ...]
    const lightCount = this.visibleLights.length;
    const lightDataFlat = new Float32Array(lightCount * 7); // 7 values per light

    for (let i = 0; i < lightCount; i++) {
      const light = this.visibleLights[i];
      const offset = i * 7;
      lightDataFlat[offset + 0] = light.screenX;
      lightDataFlat[offset + 1] = light.screenY;
      lightDataFlat[offset + 2] = light.r;
      lightDataFlat[offset + 3] = light.g;
      lightDataFlat[offset + 4] = light.b;
      lightDataFlat[offset + 5] = light.screenRadius;
      lightDataFlat[offset + 6] = light.lumens / 100.0; // Normalize intensity
    }

    // Send to main thread (use 'self' not 'selfRef')
    self.postMessage(
      {
        msg: "lightingData",
        lightData: lightDataFlat,
        lightCount: lightCount,
        objectTints: this.objectTints,
      },
      [lightDataFlat.buffer] // Transfer ownership for performance
    );
  }
}

// Create singleton instance and setup message handler
const lightingWorker = new LightingWorker(self);
