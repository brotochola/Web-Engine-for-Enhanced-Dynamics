// GameEngine.js - Lightweight scene orchestrator
// Manages canvas, scene lifecycle, input listeners, browser hardening, and debug UI

import { DebugUI } from './debug/debugUi.js';
import { Mouse } from './mouse.js';
import { SoundManager } from './soundManager.js';
import { Scene } from './scene.js';
import { printLogo } from '../util/utils.js';
import { debugWorkerLog } from '../util/debugLog.js';
import { DEBUG_DEFAULTS, ENGINE_DEFAULTS } from '../util/configDefaults.js';
import {
  ensureResourceTimingBuffer,
  inferSceneScriptUrl,
  isSceneClass,
  pickSceneClass,
  toAbsoluteScriptUrl,
} from '../util/sceneScript.js';

const PREVENT_DEFAULT_KEYS = new Set([
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'tab',
]);

class GameEngine {
  static states = {
    TRANSITIONING: 0,
    READY: 1,
  };

  constructor(config = {}) {
    this.autoResize = config.autoResize ?? ENGINE_DEFAULTS.autoResize;
    this.preventContextMenu = config.preventContextMenu ?? ENGINE_DEFAULTS.preventContextMenu;
    this.preventDefaultKeys = config.preventDefaultKeys ?? ENGINE_DEFAULTS.preventDefaultKeys;
    this.injectStyles = config.injectStyles ?? ENGINE_DEFAULTS.injectStyles;

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
    this.transitionCooldown = config.transitionCooldown ?? ENGINE_DEFAULTS.transitionCooldown;

    // Debug UI (created if debug: true). Distinct from Scene.config.debug object.
    this.debugEnabled = config.debug ?? ENGINE_DEFAULTS.debug;
    this.debugUI = null;

    if (this.debugEnabled) {
      this.debugUI = new DebugUI({
        updateInterval: config.debugUpdateInterval ?? DEBUG_DEFAULTS.updateInterval,
        defaultOpen: config.debugDefaultOpen ?? DEBUG_DEFAULTS.defaultOpen,
      });
    }

    // Browser environment hardening
    this._injectedStyle = null;
    if (this.injectStyles) this._injectBodyStyles();

    ensureResourceTimingBuffer();

    // Create canvas immediately
    this._createCanvas();

    // Input listeners (engine owns all listeners, forwards to currentScene)
    this._setupWindowListeners();

    // Auto-resize: track window size changes
    if (this.autoResize) {
      this._resizeDebounceTimer = null;
      this._onWindowResize = () => {
        clearTimeout(this._resizeDebounceTimer);
        this._resizeDebounceTimer = setTimeout(() => {
          this.resize(window.innerWidth, window.innerHeight);
        }, ENGINE_DEFAULTS.resizeDebounceMs);
      };
      window.addEventListener('resize', this._onWindowResize);
    }

    printLogo();
  }

  // ---------------------------------------------------------------------------
  // Browser environment hardening
  // ---------------------------------------------------------------------------

  _injectBodyStyles() {
    const style = document.createElement('style');
    style.textContent = `html, body { margin: 0; padding: 0; overflow: hidden; width: 100%; height: 100%; background: black; }`;
    document.head.appendChild(style);
    this._injectedStyle = style;
  }

  // ---------------------------------------------------------------------------
  // Canvas
  // ---------------------------------------------------------------------------

  _createCanvas() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvasWidth;
    this.canvas.height = this.canvasHeight;

    const s = this.canvas.style;
    s.display = 'block';
    s.position = 'fixed';
    s.top = '0';
    s.left = '0';
    s.touchAction = 'none';
    s.userSelect = 'none';
    s.webkitUserSelect = 'none';
    s.webkitTouchCallout = 'none';

    document.body.appendChild(this.canvas);

    this._setupCanvasListeners();
  }

  // ---------------------------------------------------------------------------
  // Input — window-level listeners (registered once, survive scene transitions)
  // ---------------------------------------------------------------------------

  _setupWindowListeners() {
    this._keydownHandler = (e) => {
      const key = e.key.toLowerCase();
      if (this.preventDefaultKeys && PREVENT_DEFAULT_KEYS.has(key)) {
        e.preventDefault();
      }
      if (this.debugEnabled && e.shiftKey && (key === 'h' || key === 'i' || key === 'k' || key === 'o' || key === 's')) {
        return;
      }
      this.currentScene?.onKeyDown(key);
    };

    this._keyupHandler = (e) => {
      this.currentScene?.onKeyUp(e.key.toLowerCase());
    };

    this._wheelHandler = (e) => {
      e.preventDefault();
      this.currentScene?.onWheel(e.deltaY);
    };

    window.addEventListener('keydown', this._keydownHandler);
    window.addEventListener('keyup', this._keyupHandler);
    window.addEventListener('wheel', this._wheelHandler, { passive: false });

    if (this.preventContextMenu) {
      this._contextmenuHandler = (e) => e.preventDefault();
      window.addEventListener('contextmenu', this._contextmenuHandler);
    }

    this._fullscreenchangeHandler = () => {
      if (this.autoResize) {
        this.resize(window.innerWidth, window.innerHeight);
      }
    };
    document.addEventListener('fullscreenchange', this._fullscreenchangeHandler);
  }

  // ---------------------------------------------------------------------------
  // Input — canvas-level listeners (re-attached each time canvas is recreated)
  // ---------------------------------------------------------------------------

  _setupCanvasListeners() {
    this.canvas.addEventListener('mousedown', (e) => {
      if (Mouse.isDebugToolActive) return;
      this.currentScene?.onMouseDown(e.button);
    });

    this.canvas.addEventListener('mouseup', (e) => {
      this.currentScene?.onMouseUp(e.button);
    });

    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.currentScene?.onMouseMove(e.clientX - rect.left, e.clientY - rect.top);
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.currentScene?.onMouseLeave();
    });
  }

  // ---------------------------------------------------------------------------
  // Fullscreen API
  // ---------------------------------------------------------------------------

  async requestFullscreen() {
    if (!document.fullscreenElement) {
      await document.body.requestFullscreen();
    }
  }

  exitFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    }
  }

  get isFullscreen() {
    return !!document.fullscreenElement;
  }

  /**
   * Load and initialize a new scene.
   * String: module URL (`/demos/predatorScene/predatorScene.js`). Engine import()s it
   * and workers load that same file (entity graph, no per-entity scriptUrl).
   * Class: same as today; engine infers the file from loaded JS when it can.
   * @param {string|Function} source
   * @param {{ restorePayload?: object, restoreSlot?: string, export?: string, scriptUrl?: string }} [options]
   * @returns {boolean} - true if scene change accepted, false if busy
   */
  async loadScene(source, options = {}) {
    const label = typeof source === 'string' ? source : source && source.name;
    if (this.state === GameEngine.states.TRANSITIONING) {
      console.warn(
        `⚠️ Scene transition already in progress. Ignoring request to load ${label}`
      );
      return false;
    }

    this.state = GameEngine.states.TRANSITIONING;

    try {
      const origin = typeof location !== 'undefined' ? location.origin : '';
      let SceneClass;
      let sceneScriptUrl = null;

      if (typeof source === 'string') {
        sceneScriptUrl = toAbsoluteScriptUrl(source, origin);
        const ns = await import(sceneScriptUrl);
        SceneClass = pickSceneClass(ns, options.export, Scene);
      } else if (typeof source === 'function') {
        SceneClass = source;
        if (options.scriptUrl) {
          sceneScriptUrl = toAbsoluteScriptUrl(options.scriptUrl, origin);
        } else if (SceneClass.scriptUrl) {
          sceneScriptUrl = toAbsoluteScriptUrl(SceneClass.scriptUrl, origin);
        } else {
          sceneScriptUrl = await inferSceneScriptUrl(SceneClass);
        }
      } else {
        throw new TypeError('loadScene expects a Scene class or module URL');
      }

      if (!isSceneClass(SceneClass, Scene) && SceneClass !== Scene) {
        throw new TypeError(`loadScene: ${SceneClass && SceneClass.name} is not a Scene`);
      }

      if (sceneScriptUrl && !SceneClass.scriptUrl) {
        SceneClass.scriptUrl = sceneScriptUrl;
      }

      let restorePayload = options.restorePayload || null;
      if (!restorePayload && options.restoreSlot) {
        const { SaveStore, decodeSave } = await import('./save/saveGame.js');
        const blob = await SaveStore.get(options.restoreSlot);
        if (!blob) throw new Error(`Save slot not found: ${options.restoreSlot}`);
        restorePayload = await decodeSave(blob);
      }

      // Detach debug UI from current scene
      if (this.debugUI && this.currentScene) {
        this.debugUI.detach();
      }

      // Destroy current scene
      if (this.currentScene) {
        debugWorkerLog(`📤 Unloading scene: ${this.currentScene.constructor.name}`);
        await this.currentScene.destroy();
        this.currentScene = null;

        // Remove and recreate canvas (required because transferControlToOffscreen can only be called once)
        if (this.canvas && this.canvas.parentNode) {
          this.canvas.parentNode.removeChild(this.canvas);
        }
        this._createCanvas();
      }

      // Create and initialize new scene
      debugWorkerLog(`📥 Loading scene: ${SceneClass.name}`);
      this.currentScene = new SceneClass(this);
      this.currentScene.sceneScriptUrl = sceneScriptUrl;
      if (restorePayload) {
        this.currentScene._restorePayload = restorePayload;
      }

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

    // Remove window-level input listeners
    window.removeEventListener('keydown', this._keydownHandler);
    window.removeEventListener('keyup', this._keyupHandler);
    window.removeEventListener('wheel', this._wheelHandler);
    if (this._contextmenuHandler) {
      window.removeEventListener('contextmenu', this._contextmenuHandler);
    }
    document.removeEventListener('fullscreenchange', this._fullscreenchangeHandler);

    // Remove injected styles
    if (this._injectedStyle && this._injectedStyle.parentNode) {
      this._injectedStyle.parentNode.removeChild(this._injectedStyle);
      this._injectedStyle = null;
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

    // Full audio teardown (scene switches keep the AudioContext alive on purpose;
    // engine destruction is the only place it should be closed)
    await SoundManager.dispose();

    // Canvas-level listeners die with the element
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }

    this.state = GameEngine.states.READY;
    debugWorkerLog('🔴 GameEngine destroyed');
  }
}

// ES6 module export
export { GameEngine };
