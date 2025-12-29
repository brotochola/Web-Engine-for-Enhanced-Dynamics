// GameEngine.js - Lightweight scene orchestrator
// Manages canvas and scene lifecycle

class GameEngine {
  static states = {
    TRANSITIONING: 0,
    READY: 1,
  };
  constructor(canvasConfig = {}) {
    this.canvasWidth = canvasConfig.canvasWidth || window.innerWidth;
    this.canvasHeight = canvasConfig.canvasHeight || window.innerHeight;
    this.canvas = null;
    this.currentScene = null;

    // State management
    this.state = GameEngine.states.READY;
    this.transitionCooldown = canvasConfig.transitionCooldown || 100; // ms

    // Create canvas immediately
    this._createCanvas();
  }

  _createCanvas() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvasWidth;
    this.canvas.height = this.canvasHeight;
    document.body.appendChild(this.canvas);
  }

  /**
   * Load and initialize a new scene
   * Destroys the current scene if one exists
   * @param {Class} SceneClass - Scene class to instantiate
   * @returns {boolean} - true if scene change accepted, false if busy
   */
  async loadScene(SceneClass) {
    // Reject if already transitioning
    if (this.state === GameEngine.states.TRANSITIONING) {
      console.warn(
        `⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️ Scene transition already in progress. Ignoring request to load ${SceneClass.name}`
      );
      return false;
    }

    // Set state to transitioning
    this.state = GameEngine.states.TRANSITIONING;

    try {
      // Destroy current scene
      if (this.currentScene) {
        console.log(
          `📤 Unloading scene: ${this.currentScene.constructor.name}`
        );
        await this.currentScene.destroy();
        this.currentScene = null;

        // Remove and recreate canvas (required because transferControlToOffscreen can only be called once)
        if (this.canvas && this.canvas.parentNode) {
          this.canvas.parentNode.removeChild(this.canvas);
        }
        this._createCanvas();
      }

      // Create and initialize new scene
      console.log(`📥 Loading scene: ${SceneClass.name}`);
      this.currentScene = new SceneClass(this);

      // Merge canvas dimensions into scene config
      this.currentScene.config.canvasWidth = this.canvasWidth;
      this.currentScene.config.canvasHeight = this.canvasHeight;

      await this.currentScene.init();

      // Add cooldown period before allowing next transition
      await new Promise((resolve) =>
        setTimeout(resolve, this.transitionCooldown)
      );

      // Scene loaded successfully
      this.state = GameEngine.states.READY;
      return true;
    } catch (error) {
      console.error("❌ Error loading scene:", error);
      this.state = GameEngine.states.READY; // Reset state on error
      throw error;
    }
  }

  // Convenience methods that delegate to current scene
  pause() {
    if (this.currentScene) {
      this.currentScene.pause();
    }
  }

  resume() {
    if (this.currentScene) {
      this.currentScene.resume();
    }
  }

  spawnEntity(entityName, data) {
    if (this.currentScene) {
      this.currentScene.spawnEntity(entityName, data);
    }
  }

  despawnAllEntities(className) {
    if (this.currentScene) {
      this.currentScene.despawnAllEntities(className);
    }
  }

  getPoolStats(EntityClass) {
    if (this.currentScene) {
      return this.currentScene.getPoolStats(EntityClass);
    }
    return { total: 0, active: 0, available: 0 };
  }

  enableProfiling(enabled = true) {
    if (this.currentScene) {
      this.currentScene.enableProfiling(enabled);
    }
  }

  // Getters for common scene properties
  get debug() {
    return this.currentScene?.debug;
  }

  get mouse() {
    return this.currentScene?.mouse;
  }

  get camera() {
    return this.currentScene?.camera;
  }

  get config() {
    return this.currentScene?.config;
  }

  get rng() {
    return this.currentScene?.rng;
  }

  get workers() {
    return this.currentScene?.workers;
  }

  get numberOfLogicWorkers() {
    return this.currentScene?.numberOfLogicWorkers;
  }

  // State getters
  get isReady() {
    return this.state === GameEngine.states.READY;
  }

  get isTransitioning() {
    return this.state === GameEngine.states.TRANSITIONING;
  }

  // Cleanup
  async destroy() {
    this.state = GameEngine.states.TRANSITIONING;

    if (this.currentScene) {
      await this.currentScene.destroy();
      this.currentScene = null;
    }

    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }

    this.state = GameEngine.states.READY;
    console.log("🔴 GameEngine destroyed");
  }
}

// ES6 module export
export { GameEngine };
