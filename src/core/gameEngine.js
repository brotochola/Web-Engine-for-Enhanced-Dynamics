// GameEngine.js - Lightweight scene orchestrator
// Manages canvas, scene lifecycle, input listeners, browser hardening, and debug UI

import { DebugUI } from './debug/debugUi.js';
import { HotReload } from './debug/hotReload.js';
import { Mouse } from './mouse.js';
import { SoundManager } from './soundManager.js';
import { Scene } from './scene.js';
import { printLogo, usableCanvasSize } from '../util/utils.js';
import { debugWorkerLog } from '../util/debugLog.js';
import { DEBUG_DEFAULTS, ENGINE_DEFAULTS } from '../util/configDefaults.js';
import {
  defaultIsolationServiceWorker,
  ensureCrossOriginIsolation,
  showIsolationVeil,
} from '../util/crossOriginIsolation.js';
import {
  ensureResourceTimingBuffer,
  inferSceneScriptUrl,
  isSceneClass,
  pickSceneClass,
  nativeImport,
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
    // DX-SW. Before anything loads: a page the host did not isolate gets weed-sw.js and one
    // reload. loadScene waits for it. A black cover hides the page meanwhile, so what it draws
    // before the reload (a menu, the debug bar) does not flash; it comes off unless the page reloads.
    const serviceWorker = config.isolationServiceWorker ?? defaultIsolationServiceWorker();
    const unveil = typeof SharedArrayBuffer === 'undefined' && serviceWorker ? showIsolationVeil() : null;
    this._isolation = ensureCrossOriginIsolation({ serviceWorker }).then((result) => {
      if (unveil && result !== 'reloading') unveil();
      return result;
    });
    this.autoResize = config.autoResize ?? ENGINE_DEFAULTS.autoResize;
    this.preventContextMenu = config.preventContextMenu ?? ENGINE_DEFAULTS.preventContextMenu;
    this.preventDefaultKeys = config.preventDefaultKeys ?? ENGINE_DEFAULTS.preventDefaultKeys;
    this.injectStyles = config.injectStyles ?? ENGINE_DEFAULTS.injectStyles;
    this.presentWhenHidden = config.presentWhenHidden ?? ENGINE_DEFAULTS.presentWhenHidden;
    this._presenting = true;
    // Renderer reads this between GPU passes. postMessage cannot interrupt the current frame.
    // A plain buffer on a page without SharedArrayBuffer (not cross-origin isolated): the
    // constructor must not throw there, so Scene.init can say why the engine cannot start.
    const FlagBuffer = typeof SharedArrayBuffer === 'function' ? SharedArrayBuffer : ArrayBuffer;
    this._presentingFlag = new Int32Array(new FlagBuffer(4));
    Atomics.store(this._presentingFlag, 0, 1);
    this._hidePresentingTimer = null;
    this._abandoned = false;

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
      // Opt-in (hotReload: true), for pages served by npm run dev: reload on a file
      // change, keeping the running scene's state. Other servers would 404 the endpoint.
      if (config.hotReload === true) HotReload.start(this);
    }

    // Browser environment hardening
    this._injectedStyle = null;
    if (this.injectStyles) this._injectBodyStyles();

    ensureResourceTimingBuffer();

    // Create canvas immediately
    this._createCanvas();

    // Input listeners (engine owns them). Keys go to the scene. Pointer and wheel write Mouse.
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
      Mouse.addWheel(e.deltaY);
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

    this._onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') this._armHidePresenting();
      else this._onDocumentVisible();
    };
    this._onPageHide = (e) => this._handlePageHide(e);
    this._onPageShow = () => this._onDocumentVisible();
    document.addEventListener('visibilitychange', this._onVisibilityChange);
    window.addEventListener('pagehide', this._onPageHide);
    window.addEventListener('pageshow', this._onPageShow);
  }

  _armHidePresenting() {
    if (this.presentWhenHidden || this._abandoned) return;
    // Drop the SAB now so pixi can skip remaining submits. Do not post
    // presenting:false yet — F5 fires pagehide in this same turn, and
    // unconfigure() on a hot WebGPU queue hangs Chrome.
    if (this._presentingFlag) Atomics.store(this._presentingFlag, 0, 0);
    this._presenting = false;
    if (this._hidePresentingTimer != null) return;
    this._hidePresentingTimer = setTimeout(() => {
      this._hidePresentingTimer = null;
      if (this._abandoned) return;
      this._onDocumentHidden();
    }, 0);
  }

  _disarmHidePresenting() {
    if (this._hidePresentingTimer == null) return;
    clearTimeout(this._hidePresentingTimer);
    this._hidePresentingTimer = null;
  }

  _handlePageHide(event) {
    if (event && event.persisted) {
      this._disarmHidePresenting();
      this._onDocumentHidden();
      return;
    }
    this._abandonDocument();
  }

  _abandonDocument() {
    if (this._abandoned) return;
    this._abandoned = true;
    this._disarmHidePresenting();
    if (this._presentingFlag) Atomics.store(this._presentingFlag, 0, 0);
    this._presenting = false;
    const scene = this.currentScene;
    this.currentScene = null;
    scene?.killWorkers();
  }

  _onDocumentHidden() {
    if (this.presentWhenHidden || this._abandoned) return;
    this.setPresenting(false);
  }

  _onDocumentVisible() {
    if (this._abandoned) return;
    this._disarmHidePresenting();
    this.setPresenting(true);
  }

  get presenting() {
    return this._presenting;
  }

  setPresenting(on) {
    const next = !!on;
    if (this._presentingFlag) Atomics.store(this._presentingFlag, 0, next ? 1 : 0);
    if (next) this.rebindSurface();
    this._presenting = next;
    this.currentScene?.setPresenting(next);
  }

  rebindSurface() {
    this.currentScene?.rebindSurface();
  }

  // ---------------------------------------------------------------------------
  // Input — canvas-level listeners (re-attached each time canvas is recreated)
  // ---------------------------------------------------------------------------

  _setupCanvasListeners() {
    const camera = () => this.currentScene?.camera;
    this.canvas.addEventListener('pointerdown', (e) => Mouse.pointerDown(e, camera()));
    this.canvas.addEventListener('pointermove', (e) => Mouse.pointerMove(e, camera()));
    this.canvas.addEventListener('pointerup', (e) => Mouse.pointerUp(e, camera()));
    this.canvas.addEventListener('pointercancel', (e) => Mouse.pointerCancel(e, camera()));
    this.canvas.addEventListener('pointerleave', (e) => Mouse.pointerLeave(e));
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
   * @param {{ data?: unknown, onProgress?: (done: number, total: number, stage: string) => void, restorePayload?: object, restoreSlot?: string, export?: string, scriptUrl?: string }} [options]
   *   data: handed to the scene as scene.data and as the argument of preload / create /
   *   createNewGame (level number, a menu choice, …).
   *   onProgress(done, total, stage): the same calls as Scene.onLoadProgress, for a
   *   loading screen the caller owns.
   * @returns {boolean} - true if scene change accepted, false if busy
   */
  async loadScene(source, options = {}) {
    // The page is about to reload into an isolated one: nothing after this call should run.
    // 'failed' goes on, so Scene.init shows why the engine cannot start.
    if ((await this._isolation) === 'reloading') return new Promise(() => {});
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
        const ns = await nativeImport(sceneScriptUrl);
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

      // A hot reload of this very scene: restore what was running (once).
      let hotRestore = false;
      if (this.debugEnabled && !options.restorePayload && !options.restoreSlot) {
        const hot = HotReload.takeRestore(sceneScriptUrl);
        if (hot) {
          options = { ...options, data: options.data ?? hot.data };
          hotRestore = true;
        }
      }

      let restorePayload = options.restorePayload || null;
      if (hotRestore) {
        // null (gone, unreadable, another scene): start fresh, never fail the load
        restorePayload = await HotReload.readSlot(SceneClass.name);
        // onLoadGame sees it: every entity is back already, do not spawn them again.
        if (restorePayload) restorePayload.hotReload = true;
      } else if (!restorePayload && options.restoreSlot) {
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
      this.currentScene.data = options.data === undefined ? null : options.data;
      if (typeof options.onProgress === 'function') this.currentScene._onProgressOption = options.onProgress;
      if (restorePayload) {
        this.currentScene._restorePayload = restorePayload;
        this.currentScene._restoreAllTypes = hotRestore; // the hot save holds every entity
      }

      // Engine owns canvas dimensions — inject into scene config before init
      // so workers receive the correct values during initialization
      this.currentScene.config.canvasWidth = this.canvasWidth;
      this.currentScene.config.canvasHeight = this.canvasHeight;

      await this.currentScene.init();
      if (!this._presenting) this.currentScene.setPresenting(false);

      // Attach debug UI to new scene
      if (this.debugUI) {
        this.debugUI.attach(this, this.currentScene);
      }

      // Add cooldown period before allowing next transition
      await new Promise((resolve) => setTimeout(resolve, this.transitionCooldown));

      // Scene loaded successfully
      this.state = GameEngine.states.READY;
      if (hotRestore) HotReload.discardSlot();
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

  /** The static Mouse API while a scene is active. It read a scene.mouse that never existed, so it was always undefined (review D7). */
  get mouse() {
    return this.currentScene ? Mouse : undefined;
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
    if (!usableCanvasSize(width, height)) return;
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
    this._abandoned = true;
    this._disarmHidePresenting();
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
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    window.removeEventListener('pagehide', this._onPageHide);
    window.removeEventListener('pageshow', this._onPageShow);

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
