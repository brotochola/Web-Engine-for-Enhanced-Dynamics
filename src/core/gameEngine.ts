// GameEngine.ts - Centralized game initialization and state management
// Handles workers, SharedArrayBuffers, class registration, and input management

import { GameObject } from './gameObject.js';
import { RenderableGameObject } from './RenderableGameObject.js';
import type {
  GameConfig,
  EntityConfig,
  EntityClassInfo,
  TextureConfig,
} from '../types/index.js';

/**
 * Entity class  registration info
 */
interface EntityRegistration {
  class: typeof GameObject;
  count: number;
  startIndex: number;
  scriptPath: string | null;
}

/**
 * Worker ready states
 */
interface WorkerReadyStates {
  spatial: boolean;
  logic: boolean;
  physics: boolean;
  renderer: boolean;
}

/**
 * Worker instances
 */
interface Workers {
  spatial: Worker | null;
  logic: Worker | null;
  physics: Worker | null;
  renderer: Worker | null;
}

/**
 * Shared buffers
 */
interface Buffers {
  gameObjectData: SharedArrayBuffer | null;
  entityData: Map<string, SharedArrayBuffer>;
  neighborData: SharedArrayBuffer | null;
  distanceData: SharedArrayBuffer | null;
  collisionData: SharedArrayBuffer | null;
  inputData: SharedArrayBuffer | null;
  cameraData: SharedArrayBuffer | null;
}

/**
 * Typed array views
 */
interface Views {
  input: Int32Array | null;
  camera: Float32Array | null;
  collision: Int32Array | null;
}

/**
 * Camera state
 */
interface CameraState {
  zoom: number;
  x: number;
  y: number;
}

/**
 * Image URLs configuration
 */
interface ImageUrls {
  [key: string]: string | any;
  spritesheets?: SpritesheetConfigs;
}

/**
 * Spritesheet configurations
 */
interface SpritesheetConfigs {
  [name: string]: {
    json: string;
    png: string;
  };
}

/**
 * Loaded spritesheet data
 */
interface LoadedSpritesheet {
  json: any;
  imageBitmap: ImageBitmap;
}

/**
 * Main Game Engine class
 * Orchestrates workers, manages SharedArrayBuffers, and handles game state
 */
export class GameEngine {
  static now = Date.now();

  // Configuration
  config: GameConfig;
  
  // State
  state: { pause: boolean };
  log: Array<{ worker: string; message: string; when: number }> = [];
  keyboard: Record<string, boolean> = {};
  mouse: { x: number; y: number } | null = null;
  camera: CameraState;
  
  // Physics proxy
  physics: GameConfig['physics'];
  pendingPhysicsUpdates: Array<Partial<GameConfig['physics']>> = [];
  
  // Workers
  workers: Workers;
  workerReadyStates: WorkerReadyStates;
  totalWorkers: number = 4;
  
  // Buffers
  buffers: Buffers;
  views: Views;
  
  // Canvas
  canvas: HTMLCanvasElement | null = null;
  
  // Entity registration
  registeredClasses: EntityRegistration[] = [];
  gameObjects: GameObject[] = [];
  totalEntityCount: number = 0;
  
  // Assets
  imageUrls: ImageUrls;
  loadedTextures: Record<string, ImageBitmap> | null = null;
  loadedSpritesheets: Record<string, LoadedSpritesheet> = {};
  
  // Input mapping
  keyMap: Record<string, number>;
  
  // Frame timing
  lastFrameTime: number;
  updateRate: number = 1000 / 60; // 60 fps

  constructor(config: GameConfig, imageUrls: ImageUrls = {}) {
    this.imageUrls = imageUrls;
    this.state = {
      pause: false,
    };

    // Apply default physics settings if not provided
    this.config = {
      gravity: { x: 0, y: 0 },
      ...config,
    } as GameConfig;

    this.config.physics = {
      subStepCount: 4,
      boundaryElasticity: 0.8,
      collisionResponseStrength: 0.5,
      verletDamping: 0.995,
      minSpeedForRotation: 0.1,
      ...(config.physics || {}),
    } as any;

    this.config.physics!.gravity = this.config.physics!.gravity ||
      this.config.gravity || { x: 0, y: 0 };
    this.config.gravity = this.config.physics!.gravity;

    // Camera
    this.camera = {
      zoom: 1,
      x: 0, // Will be centered on world after init
      y: 0,
    };

    // Workers
    this.workers = {
      spatial: null,
      logic: null,
      physics: null,
      renderer: null,
    };

    // Physics proxy for reactive updates
    const engine = this;
    this.physics = new Proxy(this.config.physics!, {
      get(target, prop: string) {
        return (target as any)[prop];
      },
      set(target, prop: string, value) {
        (target as any)[prop] = value;
        engine.updatePhysicsConfig({ [prop]: value });
        return true;
      },
    });

    // Worker synchronization
    this.workerReadyStates = {
      spatial: false,
      logic: false,
      physics: false,
      renderer: false,
    };

    // Shared buffers
    this.buffers = {
      gameObjectData: null,
      entityData: new Map(),
      neighborData: null,
      distanceData: null,
      collisionData: null,
      inputData: null,
      cameraData: null,
    };

    // Typed array views
    this.views = {
      input: null,
      camera: null,
      collision: null,
    };

    // Key mapping for input buffer
    this.keyMap = {
      w: 0,
      a: 1,
      s: 2,
      d: 3,
      arrowup: 4,
      arrowdown: 5,
      arrowleft: 6,
      arrowright: 7,
      ' ': 8, // spacebar
      shift: 9,
      control: 10,
    };

    // Frame timing
    this.lastFrameTime = performance.now();
  }

  /**
   * Register an entity class (e.g., Boid, Enemy)
   * This calculates buffer sizes and tracks entity ranges
   * @param EntityClass - The class to register (must extend GameObject)
   * @param count - Number of entities of this type
   * @param scriptPath - Path to the script file (for worker loading)
   */
  registerEntityClass(
    EntityClass: typeof GameObject,
    count: number,
    scriptPath: string | null = null
  ): void {
    // Auto-detect and register parent classes (if not already registered)
    this._autoRegisterParentClasses(EntityClass);

    // Validate spriteConfig for entities that extend RenderableGameObject
    if (
      typeof RenderableGameObject !== 'undefined' &&
      EntityClass.prototype instanceof RenderableGameObject &&
      count > 0
    ) {
      // Only validate if instances will be created
      const validation = RenderableGameObject.validateSpriteConfig(
        EntityClass as typeof RenderableGameObject
      );
      if (!validation.valid) {
        console.error(`❌ ${validation.error}`);
        console.error(
          `   Please define a proper spriteConfig in ${EntityClass.name}`
        );
        console.error(`   See SPRITE_CONFIG_GUIDE.md for examples`);
        throw new Error(validation.error!);
      }
    }

    // Check if this class is already registered
    const existing = this.registeredClasses.find(
      (r) => r.class === EntityClass
    );
    if (existing) {
      console.warn(
        `⚠️ ${EntityClass.name} is already registered. Skipping duplicate registration.`
      );
      return;
    }

    const startIndex = this.totalEntityCount;

    this.registeredClasses.push({
      class: EntityClass,
      count: count,
      startIndex: startIndex,
      scriptPath: scriptPath,
    });

    this.totalEntityCount += count;

    // Auto-initialize required static properties
    if (!EntityClass.hasOwnProperty('sharedBuffer')) {
      (EntityClass as any).sharedBuffer = null;
    }
    if (!EntityClass.hasOwnProperty('entityCount')) {
      (EntityClass as any).entityCount = 0;
    }
    if (!EntityClass.hasOwnProperty('instances')) {
      (EntityClass as any).instances = [];
    }

    // Store spawning system metadata
    EntityClass.startIndex = startIndex;
    EntityClass.totalCount = count;

    // Automatically create schema properties
    if (EntityClass.ARRAY_SCHEMA && EntityClass !== GameObject) {
      GameObject._createSchemaProperties(EntityClass);
    }
  }

  /**
   * Auto-detect and register parent classes in the inheritance chain
   * @private
   */
  private _autoRegisterParentClasses(EntityClass: typeof GameObject): void {
    const parentChain: Array<typeof GameObject> = [];
    let current: any = EntityClass;

    // Walk up the prototype chain until we hit GameObject
    while (current && current !== GameObject) {
      parentChain.unshift(current); // Add to front (we want base classes first)
      current = Object.getPrototypeOf(current);
    }

    // Register each class in the chain (if not already registered)
    for (const ParentClass of parentChain) {
      const alreadyRegistered = this.registeredClasses.some(
        (r) => r.class === ParentClass
      );

      if (!alreadyRegistered && ParentClass !== EntityClass) {
        const startIndex = this.totalEntityCount;

        this.registeredClasses.push({
          class: ParentClass,
          count: 0,
          startIndex: startIndex,
          scriptPath: null,
        });

        // Initialize static properties for parent class
        if (!ParentClass.hasOwnProperty('sharedBuffer')) {
          (ParentClass as any).sharedBuffer = null;
        }
        if (!ParentClass.hasOwnProperty('entityCount')) {
          (ParentClass as any).entityCount = 0;
        }
        if (!ParentClass.hasOwnProperty('instances')) {
          (ParentClass as any).instances = [];
        }

        // Initialize schema properties for parent class
        if (ParentClass.ARRAY_SCHEMA && ParentClass !== GameObject) {
          GameObject._createSchemaProperties(ParentClass);
        }

        console.log(
          `🔧 Auto-registered parent class ${ParentClass.name} (0 instances) for ${EntityClass.name}`
        );
      }
    }
  }

  /**
   * Initialize everything
   */
  async init(): Promise<void> {
    // Check SharedArrayBuffer support
    if (typeof SharedArrayBuffer === 'undefined') {
      throw new Error('SharedArrayBuffer not available! Check CORS headers.');
    }

    // Create shared buffers
    this.createSharedBuffers();

    // Initialize canvas
    this.createCanvas();

    // Create workers
    await this.createWorkers();

    // Setup event listeners
    this.setupEventListeners();

    // Start main loop
    this.startMainLoop();

    // Update entity count display
    const numberBoidsElement = document.getElementById('numberBoids');
    if (numberBoidsElement) {
      numberBoidsElement.textContent = `Number of entities: ${this.totalEntityCount}`;
    }
  }

  /**
   * Create all SharedArrayBuffers
   */
  private createSharedBuffers(): void {
    // GameObject buffer (transform + physics + perception)
    const gameObjectBufferSize = GameObject.getBufferSize(
      this.totalEntityCount
    );
    this.buffers.gameObjectData = new SharedArrayBuffer(gameObjectBufferSize);

    // Neighbor data buffer
    const maxNeighbors =
      (this.config as any).spatial?.maxNeighbors || (this.config as any).maxNeighbors || 100;
    const NEIGHBOR_BUFFER_SIZE = this.totalEntityCount * (1 + maxNeighbors) * 4;
    this.buffers.neighborData = new SharedArrayBuffer(NEIGHBOR_BUFFER_SIZE);

    // Distance data buffer
    const DISTANCE_BUFFER_SIZE = this.totalEntityCount * (1 + maxNeighbors) * 4;
    this.buffers.distanceData = new SharedArrayBuffer(DISTANCE_BUFFER_SIZE);

    // Initialize GameObject with neighbor and distance buffers
    GameObject.initializeArrays(
      this.buffers.gameObjectData,
      this.totalEntityCount,
      this.buffers.neighborData,
      this.buffers.distanceData
    );

    this.preInitializeEntityTypeArrays();

    // Initialize subclass buffers
    for (const registration of this.registeredClasses) {
      const { class: EntityClass } = registration;

      if (EntityClass.getBufferSize && EntityClass.initializeArrays) {
        const bufferSize = EntityClass.getBufferSize(this.totalEntityCount);
        const buffer = new SharedArrayBuffer(bufferSize);

        this.buffers.entityData.set(EntityClass.name, buffer);
        EntityClass.initializeArrays(buffer, this.totalEntityCount);
      }
    }

    // Collision data buffer
    const maxCollisionPairs =
      (this.config.physics as any)?.maxCollisionPairs ||
      (this.config as any).maxCollisionPairs ||
      10000;
    const COLLISION_BUFFER_SIZE = (1 + maxCollisionPairs * 2) * 4;
    this.buffers.collisionData = new SharedArrayBuffer(COLLISION_BUFFER_SIZE);
    this.views.collision = new Int32Array(this.buffers.collisionData);
    this.views.collision[0] = 0; // Initialize pair count to 0

    // Input buffer
    const INPUT_BUFFER_SIZE = 32 * 4;
    this.buffers.inputData = new SharedArrayBuffer(INPUT_BUFFER_SIZE);
    this.views.input = new Int32Array(this.buffers.inputData);

    // Camera buffer
    const CAMERA_BUFFER_SIZE = 3 * 4;
    this.buffers.cameraData = new SharedArrayBuffer(CAMERA_BUFFER_SIZE);
    this.views.camera = new Float32Array(this.buffers.cameraData);

    // Initialize camera buffer
    this.views.camera[0] = this.camera.zoom;

    // Center camera on world
    const worldCenterX =
      this.config.worldWidth / 2 - this.config.canvasWidth! / 2;
    const worldCenterY =
      this.config.worldHeight / 2 - this.config.canvasHeight! / 2;
    this.camera.x = worldCenterX;
    this.camera.y = worldCenterY;

    this.views.camera[1] = this.camera.x;
    this.views.camera[2] = this.camera.y;
  }

  /**
   * Pre-initialize entityType values to prevent race condition
   * @private
   */
  private preInitializeEntityTypeArrays(): void {
    for (let i = 0; i < this.totalEntityCount; i++) {
      for (const registration of this.registeredClasses) {
        const { class: EntityClass, startIndex, count } = registration;
        if (i >= startIndex && i < startIndex + count) {
          GameObject.entityType[i] = EntityClass.entityTypeId;
          break;
        }
      }
    }
  }

  /**
   * Create canvas element
   * @private
   */
  private createCanvas(): void {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.config.canvasWidth!;
    this.canvas.height = this.config.canvasHeight!;
    document.body.appendChild(this.canvas);
  }

  /**
   * Preload assets (textures and spritesheets)
   * @private
   */
  private async preloadAssets(
    imageUrls: ImageUrls,
    spritesheetConfigs: SpritesheetConfigs = {}
  ): Promise<void> {
    this.loadedTextures = {};
    this.loadedSpritesheets = {};

    console.log('📦 preloadAssets called with:', {
      imageUrls: imageUrls,
      imageUrlsKeys: Object.keys(imageUrls),
      spritesheetConfigsKeys: Object.keys(spritesheetConfigs),
    });

    // Load simple textures
    const textureEntries = Object.entries(imageUrls).filter(([name, url]) => {
      if (name === 'spritesheets') return false;
      if (typeof url !== 'string') {
        console.warn(`⚠️ Skipping invalid texture "${name}": not a string URL`);
        return false;
      }
      return true;
    });

    console.log(`📦 Loading ${textureEntries.length} textures...`);

    const texturePromises = textureEntries.map(async ([name, url]) => {
      try {
        const img = new Image();
        img.crossOrigin = 'anonymous';

        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject();
          img.src = url as string;
        });

        const imageBitmap = await createImageBitmap(img);
        this.loadedTextures![name] = imageBitmap;

        console.log(`✅ Loaded texture: ${name}`);
      } catch (error) {
        console.error(`❌ Failed to load texture ${name} from ${url}:`, error);
      }
    });

    // Load spritesheets
    console.log(`📦 Loading ${Object.keys(spritesheetConfigs).length} spritesheets...`);

    const spritesheetPromises = Object.entries(spritesheetConfigs).map(
      async ([name, config]) => {
        try {
          console.log(`  Loading spritesheet "${name}"...`);

          if (!config.json || !config.png) {
            throw new Error('Invalid spritesheet config: missing json or png property');
          }

          const jsonResponse = await fetch(config.json);
          const jsonData = await jsonResponse.json();

          const img = new Image();
          img.crossOrigin = 'anonymous';

          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject();
            img.src = config.png;
          });

          const imageBitmap = await createImageBitmap(img);

          this.loadedSpritesheets[name] = {
            json: jsonData,
            imageBitmap: imageBitmap,
          };

          console.log(
            `✅ Loaded spritesheet: ${name} with ${
              Object.keys(jsonData.animations || {}).length
            } animations`
          );
        } catch (error) {
          console.error(`❌ Failed to load spritesheet ${name}:`, error);
        }
      }
    );

    await Promise.all([...texturePromises, ...spritesheetPromises]);

    console.log(
      `✅ Preloaded ${Object.keys(this.loadedTextures).length} textures and ${
        Object.keys(this.loadedSpritesheets).length
      } spritesheets`
    );
  }

  /**
   * Setup direct MessagePort communication between workers
   * @private
   */
  private setupWorkerCommunication(): Record<string, Record<string, MessagePort>> {
    const connections = [
      { from: 'logic', to: 'renderer' },
      { from: 'physics', to: 'renderer' },
    ];

    const workerPorts: Record<string, Record<string, MessagePort>> = {};

    connections.forEach(({ from, to }) => {
      const channel = new MessageChannel();

      if (!workerPorts[from]) workerPorts[from] = {};
      if (!workerPorts[to]) workerPorts[to] = {};

      workerPorts[from][to] = channel.port1;
      workerPorts[to][from] = channel.port2;
    });

    console.log('🔗 Worker communication channels established:', connections);
    return workerPorts;
  }

  /**
   * Create and initialize all workers
   * @private
   */
  private async createWorkers(): Promise<void> {
    // Create workers with module type
    const cacheBust = `?v=${Date.now()}`;
    this.workers.spatial = new Worker(`/src/workers/spatial_worker.js${cacheBust}`, { type: 'module' });
    this.workers.logic = new Worker(`/src/workers/logic_worker.js${cacheBust}`, { type: 'module' });
    this.workers.physics = new Worker(`/src/workers/physics_worker.js${cacheBust}`, { type: 'module' });
    this.workers.renderer = new Worker(`/src/workers/pixi_worker.js${cacheBust}`, { type: 'module' });

    (this.workers.spatial as any).name = 'spatial';
    (this.workers.logic as any).name = 'logic';
    (this.workers.physics as any).name = 'physics';
    (this.workers.renderer as any).name = 'renderer';

    // Preload assets
    const spritesheetConfigs = (this.imageUrls.spritesheets || {}) as SpritesheetConfigs;
    await this.preloadAssets(this.imageUrls, spritesheetConfigs);

    // Collect script paths
    const scriptsToLoad = [
      ...new Set(
        this.registeredClasses
          .map((r) => r.scriptPath)
          .filter((path): path is string => path !== null && path !== undefined)
          .map((path) => {
            if (!path.startsWith('../') && !path.startsWith('http')) {
              return `../${path}`;
            }
            return path;
          })
      ),
    ];

    console.log('📜 Game scripts to load in workers:', scriptsToLoad);

    // Setup worker communication
    const workerPorts = this.setupWorkerCommunication();

    // Create initialization data
    const initData = {
      msg: 'init',
      buffers: {
        ...this.buffers,
        entityData: Object.fromEntries(this.buffers.entityData),
      },
      entityCount: this.totalEntityCount,
      config: this.config,
      scriptsToLoad: scriptsToLoad,
      registeredClasses: this.registeredClasses.map((r) => ({
        name: r.class.name,
        count: r.count,
        startIndex: r.startIndex,
      })),
    };

    // Initialize workers
    this.workers.spatial!.postMessage(initData);

    this.workers.logic!.postMessage(
      {
        ...initData,
        workerPorts: workerPorts.logic,
      },
      workerPorts.logic ? Object.values(workerPorts.logic) : []
    );

    this.workers.physics!.postMessage(
      {
        ...initData,
        workerPorts: workerPorts.physics,
      },
      workerPorts.physics ? Object.values(workerPorts.physics) : []
    );

    // Initialize renderer with canvas and textures
    const offscreenCanvas = this.canvas!.transferControlToOffscreen();

    const transferables = [
      offscreenCanvas,
      ...Object.values(this.loadedTextures!),
      ...Object.values(this.loadedSpritesheets).map((sheet) => sheet.imageBitmap),
      ...(workerPorts.renderer ? Object.values(workerPorts.renderer) : []),
    ];

    this.workers.renderer!.postMessage(
      {
        ...initData,
        view: offscreenCanvas,
        textures: this.loadedTextures,
        spritesheets: this.loadedSpritesheets,
        workerPorts: workerPorts.renderer,
      },
      transferables
    );

    // Setup message handlers
    for (const worker of Object.values(this.workers)) {
      if (worker) {
        worker.onmessage = (e: MessageEvent) => {
          this.handleMessageFromWorker(e);
        };
      }
    }
  }

  /**
   * Handle messages from workers
   * @private
   */
  private handleMessageFromWorker(e: MessageEvent): void {
    const workerName = (e.currentTarget as any).name;

    if (e.data.msg === 'fps') {
      this.updateFPS(workerName, e.data.fps);
    } else if (e.data.msg === 'log') {
      this.log.push({
        worker: workerName,
        message: e.data.message,
        when: e.data.when - GameEngine.now,
      });
    } else if (e.data.msg === 'workerReady') {
      this.handleWorkerReady(workerName);
    }
  }

  /**
   * Handle worker ready signal
   * @private
   */
  private handleWorkerReady(workerName: keyof WorkerReadyStates): void {
    console.log(`✅ ${workerName} worker is ready`);
    this.workerReadyStates[workerName] = true;

    if (workerName === 'physics' && this.pendingPhysicsUpdates.length) {
      this.pendingPhysicsUpdates.forEach((update) => {
        this.workers.physics!.postMessage({
          msg: 'updatePhysicsConfig',
          config: update,
        });
      });
      this.pendingPhysicsUpdates = [];
    }

    // Check if all workers are ready
    const allReady = Object.values(this.workerReadyStates).every((ready) => ready);

    if (allReady) {
      console.log('🎮 All workers ready! Starting synchronized game loop...');
      this.startAllWorkers();
    } else {
      const readyCount = Object.values(this.workerReadyStates).filter((r) => r).length;
      console.log(`   Waiting... (${readyCount}/${this.totalWorkers} workers ready)`);
    }
  }

  /**
   * Send start signal to all workers
   * @private
   */
  private startAllWorkers(): void {
    console.log('📢 Broadcasting START to all workers');

    for (const worker of Object.values(this.workers)) {
      if (worker) {
        worker.postMessage({ msg: 'start' });
      }
    }

    console.log('✅ All workers started synchronously!');
  }

  /**
   * Update physics configuration
   */
  updatePhysicsConfig(partialConfig: Partial<GameConfig['physics']> = {}): void {
    if (!partialConfig || typeof partialConfig !== 'object') {
      return;
    }

    Object.assign(this.config.physics!, partialConfig);

    const updatePayload = { ...partialConfig };

    if (
      this.workers.physics &&
      this.workerReadyStates &&
      this.workerReadyStates.physics
    ) {
      this.workers.physics.postMessage({
        msg: 'updatePhysicsConfig',
        config: updatePayload,
      });
    } else {
      this.pendingPhysicsUpdates.push(updatePayload);
    }
  }

  /**
   * Update FPS display
   * @private
   */
  private updateFPS(id: string, fps: string): void {
    const element = document.getElementById(id + 'FPS');
    if (element) {
      element.textContent = element.textContent!.split(':')[0] + `: ${fps}`;
    }
  }

  /**
   * Update active units display
   */
  updateActiveUnits(count: number): void {
    const element = document.getElementById('activeUnits');
    if (element) {
      element.textContent = `Active units: ${count} / ${this.totalEntityCount}`;
    }
  }

  /**
   * Update visible units display
   */
  updateVisibleUnits(count: number): void {
    const element = document.getElementById('visibleUnits');
    if (element) {
      element.textContent = `Visible units: ${count} / ${this.totalEntityCount}`;
    }
  }

  /**
   * Setup all event listeners
   * @private
   */
  private setupEventListeners(): void {
    // Keyboard events
    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      this.keyboard[key] = true;
      this.updateInputBuffer();
    });

    window.addEventListener('keyup', (e) => {
      const key = e.key.toLowerCase();
      this.keyboard[key] = false;
      this.updateInputBuffer();
    });

    // Mouse events
    this.canvas!.addEventListener('mousemove', (e) => {
      const rect = this.canvas!.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;

      this.mouse = {
        x: canvasX / this.camera.zoom + this.camera.x,
        y: canvasY / this.camera.zoom + this.camera.y,
      };

      this.updateInputBuffer();
    });

    this.canvas!.addEventListener('mouseleave', () => {
      this.mouse = null;
      this.updateInputBuffer();
    });

    // Mouse wheel for zoom
    window.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();

        const oldZoom = this.camera.zoom;
        const newZoom = Math.max(0.1, Math.min(5, oldZoom + -e.deltaY * 0.001));

        const centerX = this.config.canvasWidth! / 2;
        const centerY = this.config.canvasHeight! / 2;

        const worldCenterX = centerX / oldZoom + this.camera.x;
        const worldCenterY = centerY / oldZoom + this.camera.y;

        this.camera.x = worldCenterX - centerX / newZoom;
        this.camera.y = worldCenterY - centerY / newZoom;
        this.camera.zoom = newZoom;

        this.updateCameraBuffer();
      },
      { passive: false }
    );
  }

  /**
   * Update input buffer with current input state
   * @private
   */
  private updateInputBuffer(): void {
    const input = this.views.input!;
    if (this.mouse) {
      input[0] = this.mouse.x;
      input[1] = this.mouse.y;
      input[2] = 1; // Mouse present flag
    } else {
      input[0] = 0;
      input[1] = 0;
      input[2] = 0; // Mouse NOT present
    }

    for (const [key, index] of Object.entries(this.keyMap)) {
      input[3 + index] = this.keyboard[key] ? 1 : 0;
    }
  }

  /**
   * Update camera buffer
   * @private
   */
  private updateCameraBuffer(): void {
    const cam = this.views.camera!;
    cam[0] = this.camera.zoom;
    cam[1] = this.camera.x;
    cam[2] = this.camera.y;
  }

  /**
   * Start main game loop
   * @private
   */
  private startMainLoop(): void {
    const loop = (currentTime: number) => {
      const deltaTime = currentTime - this.lastFrameTime;

      if (deltaTime >= this.updateRate) {
        this.update(deltaTime);
        this.lastFrameTime = currentTime;
      }

      requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);
  }

  /**
   * Main update function (60fps)
   * @private
   */
  private update(deltaTime: number): void {
    const dtRatio = deltaTime / 16.67;
    const moveSpeed = (-10 / this.camera.zoom) * dtRatio;

    if (this.keyboard.w || this.keyboard.arrowup) {
      this.camera.y += moveSpeed;
    }
    if (this.keyboard.s || this.keyboard.arrowdown) {
      this.camera.y -= moveSpeed;
    }
    if (this.keyboard.a || this.keyboard.arrowleft) {
      this.camera.x += moveSpeed;
    }
    if (this.keyboard.d || this.keyboard.arrowright) {
      this.camera.x -= moveSpeed;
    }

    this.updateCameraBuffer();

    this.updateVisibleUnits(
      Array.from(GameObject.isItOnScreen).filter((v) => !!v).length
    );
    this.updateActiveUnits(
      Array.from(GameObject.active).filter((v) => !!v).length
    );
  }

  /**
   * Cleanup and destroy engine
   */
  destroy(): void {
    Object.values(this.workers).forEach((worker) => {
      if (worker) worker.terminate();
    });

    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }

  /**
   * Pause the game
   */
  pause(): void {
    this.state.pause = true;
    Object.values(this.workers).forEach((worker) => {
      if (worker) worker.postMessage({ msg: 'pause' });
    });
  }

  /**
   * Resume the game
   */
  resume(): void {
    this.state.pause = false;
    Object.values(this.workers).forEach((worker) => {
      if (worker) worker.postMessage({ msg: 'resume' });
    });
  }

  /**
   * Spawn an entity from the pool
   * @param className - Name of the entity class (e.g., 'Prey', 'Predator')
   * @param spawnConfig - Initial configuration (position, velocity, etc.)
   */
  spawnEntity(className: string, spawnConfig: EntityConfig = {}): void {
    if (!this.workers.logic) {
      console.error('Logic worker not initialized');
      return;
    }

    this.workers.logic.postMessage({
      msg: 'spawn',
      className: className,
      spawnConfig: spawnConfig,
    });
  }

  /**
   * Despawn all entities of a specific type
   * @param className - Name of the entity class to despawn
   */
  despawnAllEntities(className: string): void {
    if (!this.workers.logic) {
      console.error('Logic worker not initialized');
      return;
    }

    this.workers.logic.postMessage({
      msg: 'despawnAll',
      className: className,
    });
  }

  /**
   * Get pool statistics for an entity class
   * @param EntityClass - The entity class to check
   * @returns Pool statistics
   */
  getPoolStats(EntityClass: typeof GameObject): {
    total: number;
    active: number;
    available: number;
  } {
    if (!EntityClass.startIndex || !EntityClass.totalCount) {
      return { total: 0, active: 0, available: 0 };
    }

    const startIndex = EntityClass.startIndex;
    const total = EntityClass.totalCount;
    let activeCount = 0;

    for (let i = startIndex; i < startIndex + total; i++) {
      if (GameObject.active[i]) {
        activeCount++;
      }
    }

    return {
      total: total,
      active: activeCount,
      available: total - activeCount,
    };
  }
}
