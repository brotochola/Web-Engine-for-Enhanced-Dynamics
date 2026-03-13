// GameEngine.js - Lightweight scene orchestrator
// Manages canvas, scene lifecycle, and debug UI

import { DebugUI } from './DebugUI.js';
import { printLogo } from './utils.js';

class GameEngine {
  static states = {
    TRANSITIONING: 0,
    READY: 1,
  };

  constructor(config = {}) {
    this.autoResize = config.autoResize || false;

    if (this.autoResize) {
      this.canvasWidth = window.innerWidth;
      this.canvasHeight = window.innerHeight;
    } else {
      this.canvasWidth = config.canvasWidth || window.innerWidth;
      this.canvasHeight = config.canvasHeight || window.innerHeight;
    }

    this.canvas = null;
    this.currentScene = null;

    // State management
    this.state = GameEngine.states.READY;
    this.transitionCooldown = config.transitionCooldown || 100; // ms

    // Debug UI (created if debug: true)
    this.debugEnabled = config.debug || false;
    this.debugUI = null;

    if (this.debugEnabled) {
      this.debugUI = new DebugUI({
        updateInterval: config.debugUpdateInterval || 100,
        defaultOpen: config.debugDefaultOpen || null,
      });
    }

    // Create canvas immediately
    this._createCanvas();

    // Auto-resize: track window size changes
    if (this.autoResize) {
      this._resizeDebounceTimer = null;
      this._onWindowResize = () => {
        clearTimeout(this._resizeDebounceTimer);
        this._resizeDebounceTimer = setTimeout(() => {
          this.resize(window.innerWidth, window.innerHeight);
        }, 150);
      };
      window.addEventListener('resize', this._onWindowResize);
    }

    printLogo();
  }

  _createCanvas() {
    this.canvas = document.createElement('canvas');
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
        `⚠️ Scene transition already in progress. Ignoring request to load ${SceneClass.name}`
      );
      return false;
    }

    // Set state to transitioning
    this.state = GameEngine.states.TRANSITIONING;

    try {
      // Detach debug UI from current scene
      if (this.debugUI && this.currentScene) {
        this.debugUI.detach();
      }

      // Destroy current scene
      if (this.currentScene) {
        console.log(`📤 Unloading scene: ${this.currentScene.constructor.name}`);
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

      // Engine owns canvas dimensions — inject into scene config before init
      // so workers receive the correct values during initialization
      this.currentScene.config.canvasWidth = this.canvasWidth;
      this.currentScene.config.canvasHeight = this.canvasHeight;

      await this.currentScene.init();

      // Attach debug UI to new scene
      if (this.debugUI) {
        this.debugUI.attach(this, this.currentScene);
      }

      // Add cooldown period before allowing next transition
      await new Promise((resolve) => setTimeout(resolve, this.transitionCooldown));

      // Scene loaded successfully
      this.state = GameEngine.states.READY;
      return true;
    } catch (error) {
      console.error('❌ Error loading scene:', error);
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

  spawnEntity(EntityClassOrName, data) {
    if (this.currentScene) {
      this.currentScene.spawnEntity(EntityClassOrName, data);
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

  // Getters for common scene properties
  get debug() {
    return this.currentScene?.debugFlags;
  }

  get debugFlags() {
    return this.currentScene?.debugFlags;
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

  /**
   * Resize the canvas and propagate to the active scene + all workers
   * @param {number} width - New canvas width in pixels
   * @param {number} height - New canvas height in pixels
   */
  resize(width, height) {
    this.canvasWidth = width;
    this.canvasHeight = height;

    // Update the CSS display size (the actual pixel buffer is owned by the OffscreenCanvas in the worker)
    if (this.canvas) {
      this.canvas.style.width = width + 'px';
      this.canvas.style.height = height + 'px';
    }

    if (this.currentScene) {
      this.currentScene.resize(width, height);
    }
  }

  // Cleanup
  async destroy() {
    this.state = GameEngine.states.TRANSITIONING;

    if (this._onWindowResize) {
      window.removeEventListener('resize', this._onWindowResize);
      clearTimeout(this._resizeDebounceTimer);
    }

    // Destroy debug UI
    if (this.debugUI) {
      this.debugUI.destroy();
      this.debugUI = null;
    }

    if (this.currentScene) {
      await this.currentScene.destroy();
      this.currentScene = null;
    }

    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }

    this.state = GameEngine.states.READY;
    console.log('🔴 GameEngine destroyed');
  }
}

// ES6 module export
export { GameEngine };
