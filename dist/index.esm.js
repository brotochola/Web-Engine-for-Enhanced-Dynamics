// GameObject.ts - Base class for all game entities with static shared arrays
// Provides transform, physics, and perception components via Structure of Arrays
/**
 * Base class for all game entities using Structure of Arrays pattern
 * All entity data is stored in SharedArrayBuffers for efficient multi-threaded access
 */
class GameObject {
    /**
     * Initialize static arrays from SharedArrayBuffer
     * Called by GameEngine and by each worker
     *
     * This is a generic method that works for both GameObject and all subclasses
     * by using 'this' which refers to the class it's called on.
     *
     * @param buffer - The shared memory
     * @param count - Total number of entities
     * @param neighborBuffer - Optional neighbor data buffer
     * @param distanceBuffer - Optional distance data buffer
     */
    static initializeArrays(buffer, count, neighborBuffer = null, distanceBuffer = null) {
        this.sharedBuffer = buffer;
        this.entityCount = count;
        let offset = 0;
        // Create typed array views for each property defined in schema
        // 'this' refers to the class this method is called on (GameObject, subclass, etc.)
        for (const [name, type] of Object.entries(this.ARRAY_SCHEMA)) {
            const bytesPerElement = type.BYTES_PER_ELEMENT;
            // Ensure proper alignment for this typed array
            const remainder = offset % bytesPerElement;
            if (remainder !== 0) {
                offset += bytesPerElement - remainder;
            }
            this[name] = new type(buffer, offset, count);
            offset += count * bytesPerElement;
        }
        // Initialize neighbor data if provided (only for GameObject)
        if (neighborBuffer && this === GameObject) {
            this.neighborData = new Int32Array(neighborBuffer);
        }
        // Initialize distance data if provided (only for GameObject)
        if (distanceBuffer && this === GameObject) {
            this.distanceData = new Float32Array(distanceBuffer);
        }
    }
    /**
     * Calculate total buffer size needed
     * @param count - Number of entities
     * @returns Buffer size in bytes
     */
    static getBufferSize(count) {
        let offset = 0;
        for (const type of Object.values(this.ARRAY_SCHEMA)) {
            const bytesPerElement = type.BYTES_PER_ELEMENT;
            // Add alignment padding
            const remainder = offset % bytesPerElement;
            if (remainder !== 0) {
                offset += bytesPerElement - remainder;
            }
            offset += count * bytesPerElement;
        }
        return offset;
    }
    /**
     * Constructor - stores the index and initializes instance
     * Subclasses should initialize their values in their constructors
     * @param index - Position in shared arrays
     * @param config - Configuration object from GameEngine
     * @param logicWorker - Reference to logic worker (if running in worker)
     */
    constructor(index, config = {}, logicWorker = null) {
        this.neighborCount = 0;
        this.neighbors = null;
        this.neighborDistances = null;
        this.index = index;
        this.config = config; // Store config for instance access
        this.logicWorker = logicWorker;
        GameObject.active[index] = 1; // Set active in shared array (1 = true, 0 = false)
        // Take the entity type from the class
        GameObject.entityType[index] = this.constructor.entityTypeId;
        GameObject.instances.push(this);
        this.constructor.instances.push(this);
        // Neighbor properties (updated each frame before tick)
        this.neighborCount = 0;
        this.neighbors = null; // Will be a TypedArray subarray
        this.neighborDistances = null; // Will be a TypedArray subarray of squared distances
    }
    /**
     * LIFECYCLE: Called when entity is first created (one-time initialization)
     * Override in subclasses for setup that should only happen once
     */
    start() {
        // Override in subclasses
    }
    /**
     * LIFECYCLE: Called when entity becomes active (spawned from pool)
     * Override in subclasses to reset/initialize state for reuse
     */
    awake() {
        // Override in subclasses
    }
    /**
     * LIFECYCLE: Called when entity becomes inactive (returned to pool)
     * Override in subclasses for cleanup, saving state, etc.
     */
    sleep() {
        // Override in subclasses
    }
    /**
     * Despawn this entity (return it to the inactive pool)
     * This is the proper way to deactivate an entity
     */
    despawn() {
        // Prevent double-despawn which corrupts the free list
        if (GameObject.active[this.index] === 0)
            return;
        GameObject.active[this.index] = 0;
        // Return to free list if exists (O(1))
        const EntityClass = this.constructor;
        if (EntityClass.freeList) {
            EntityClass.freeList[++EntityClass.freeListTop] = this.index;
        }
        // Call lifecycle callback
        if (this.sleep) {
            this.sleep();
        }
    }
    /**
     * Update neighbor references for this entity
     * Called by logic worker before tick() each frame
     *
     * @param neighborData - Precomputed neighbors from spatial worker
     * @param distanceData - Precomputed squared distances from spatial worker
     */
    updateNeighbors(neighborData, distanceData = null) {
        // Handle both nested (main thread) and flat (worker) config structures
        const maxNeighbors = this.config.spatial?.maxNeighbors || this.config.maxNeighbors || 100;
        if (!neighborData || !maxNeighbors) {
            this.neighborCount = 0;
            this.neighbors = null;
            this.neighborDistances = null;
            return;
        }
        // Parse neighbor data buffer: [count, id1, id2, ..., id_MAX]
        const offset = this.index * (1 + maxNeighbors);
        this.neighborCount = neighborData[offset];
        this.neighbors = neighborData.subarray(offset + 1, offset + 1 + this.neighborCount);
        // Parse distance data buffer (same structure as neighborData)
        if (distanceData) {
            this.neighborDistances = distanceData.subarray(offset + 1, offset + 1 + this.neighborCount);
        }
        else {
            this.neighborDistances = null;
        }
    }
    /**
     * Main update method - called every frame by logic worker
     * Override this in subclasses to define entity behavior
     *
     * Note: this.neighbors and this.neighborCount are updated before this is called
     *
     * @param dtRatio - Delta time ratio (1.0 = 16.67ms frame)
     * @param inputData - Mouse and keyboard input
     */
    tick(dtRatio, inputData) {
        // Override in subclasses
    }
    /**
     * Unity-style collision callback: Called on the first frame when this entity collides with another
     * Override in subclasses to handle collision start events
     *
     * @param otherIndex - Index of the other entity in collision
     */
    onCollisionEnter(otherIndex) {
        // Override in subclasses
    }
    /**
     * Unity-style collision callback: Called every frame while this entity is colliding with another
     * Override in subclasses to handle continuous collision
     *
     * @param otherIndex - Index of the other entity in collision
     */
    onCollisionStay(otherIndex) {
        // Override in subclasses
    }
    /**
     * Unity-style collision callback: Called on the first frame when this entity stops colliding with another
     * Override in subclasses to handle collision end events
     *
     * @param otherIndex - Index of the other entity that was in collision
     */
    onCollisionExit(otherIndex) {
        // Override in subclasses
    }
    /**
     * Helper method to dynamically create getters/setters from ARRAY_SCHEMA
     * This is called in static initialization blocks by GameObject and all subclasses
     *
     * @param targetClass - The class to create properties for
     */
    static _createSchemaProperties(targetClass) {
        Object.entries(targetClass.ARRAY_SCHEMA).forEach(([name, type]) => {
            Object.defineProperty(targetClass.prototype, name, {
                get() {
                    return targetClass[name][this.index];
                },
                // Special handling for Uint8Array to convert boolean to 0/1
                set(value) {
                    targetClass[name][this.index] =
                        type === Uint8Array ? (value ? 1 : 0) : value;
                },
                enumerable: true,
                configurable: true,
            });
            // Special handling for x and y to also update px and py (Verlet integration)
            Object.defineProperty(targetClass.prototype, 'x', {
                get() {
                    return targetClass.x[this.index];
                },
                set(value) {
                    targetClass.x[this.index] = value;
                    targetClass.px[this.index] = value;
                },
                enumerable: true,
                configurable: true,
            });
            Object.defineProperty(targetClass.prototype, 'y', {
                get() {
                    return targetClass.y[this.index];
                },
                set(value) {
                    targetClass.y[this.index] = value;
                    targetClass.py[this.index] = value;
                },
                enumerable: true,
                configurable: true,
            });
        });
    }
    /**
     * SPAWNING SYSTEM: Initialize free list for O(1) spawning
     * Must be called after registration and before any spawning
     * @param EntityClass - The entity class to initialize
     */
    static initializeFreeList(EntityClass) {
        const count = EntityClass.totalCount;
        const startIndex = EntityClass.startIndex;
        // Create free list stack
        EntityClass.freeList = new Int32Array(count);
        EntityClass.freeListTop = count - 1;
        // Fill with all indices (initially all are free)
        // We fill in reverse order so that we pop from the beginning first (optional)
        for (let i = 0; i < count; i++) {
            EntityClass.freeList[i] = startIndex + i;
        }
    }
    /**
     * SPAWNING SYSTEM: Spawn an entity from the pool (activate an inactive entity)
     *
     * @param EntityClass - The entity class to spawn (e.g., Prey, Predator)
     * @param spawnConfig - Initial configuration (position, velocity, etc.)
     * @returns The spawned entity instance, or null if pool exhausted
     *
     * @example
     * const prey = GameObject.spawn(Prey, { x: 500, y: 300, vx: 2, vy: -1 });
     */
    static spawn(EntityClass, spawnConfig = {}) {
        // Validate EntityClass has required metadata
        if (EntityClass.startIndex === undefined ||
            EntityClass.totalCount === undefined) {
            console.error(`Cannot spawn ${EntityClass.name}: missing startIndex/totalCount metadata. Was it registered with GameEngine?`);
            return null;
        }
        // Initialize free list if not exists (lazy init)
        if (!EntityClass.freeList) {
            GameObject.initializeFreeList(EntityClass);
        }
        // Check if pool is exhausted
        if (EntityClass.freeListTop < 0) {
            console.warn(`No inactive ${EntityClass.name} available in pool! All ${EntityClass.totalCount} entities are active.`);
            return null;
        }
        // Pop index from free list (O(1))
        const i = EntityClass.freeList[EntityClass.freeListTop--];
        // Get the instance (already created during initialization)
        const instance = EntityClass.instances[i - EntityClass.startIndex];
        if (!instance) {
            console.error(`No instance found at index ${i} for ${EntityClass.name}`);
            return null;
        }
        instance.ax = 0;
        instance.ay = 0;
        instance.vx = 0;
        instance.vy = 0;
        instance.speed = 0;
        instance.velocityAngle = 0;
        instance.x = 0;
        instance.y = 0;
        instance.px = 0;
        instance.py = 0;
        instance.rotation = 0;
        // Check if setTint and setAlpha exist (for RenderableGameObject subclasses)
        if ('setTint' in instance && typeof instance.setTint === 'function') {
            instance.setTint(0xffffff); // White when healthy
        }
        if ('setAlpha' in instance && typeof instance.setAlpha === 'function') {
            instance.setAlpha(1.0); // Fully visible
        }
        // IMPORTANT: Apply spawn config BEFORE activating to prevent race condition
        // If entity is active, it can start ticking immediately on next frame
        Object.keys(spawnConfig).forEach((key) => {
            if (instance[key] !== undefined) {
                instance[key] = spawnConfig[key];
            }
        });
        // Initialize previous positions for Verlet integration
        // Set px/py based on current velocity to give initial momentum
        instance.px = instance.x - instance.vx;
        instance.py = instance.y - instance.vy;
        // Call lifecycle method BEFORE activating
        if (instance.awake) {
            instance.awake();
        }
        // NOW activate the entity (after config and awake are done)
        GameObject.active[i] = 1;
        return instance;
    }
    /**
     * SPAWNING SYSTEM: Get pool statistics for an entity class
     *
     * @param EntityClass - The entity class to check
     * @returns { total, active, available }
     *
     * @example
     * const stats = GameObject.getPoolStats(Prey);
     * console.log(`Prey: ${stats.active}/${stats.total} active, ${stats.available} available`);
     */
    static getPoolStats(EntityClass) {
        if (EntityClass.startIndex === undefined ||
            EntityClass.totalCount === undefined) {
            return { total: 0, active: 0, available: 0 };
        }
        // If free list exists, use it for O(1) stats
        if (EntityClass.freeList) {
            const available = EntityClass.freeListTop + 1;
            return {
                total: EntityClass.totalCount,
                active: EntityClass.totalCount - available,
                available: available,
            };
        }
        // Fallback to linear search if free list not initialized
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
    /**
     * SPAWNING SYSTEM: Despawn all entities of a specific type
     *
     * @param EntityClass - The entity class to despawn
     * @returns Number of entities despawned
     */
    static despawnAll(EntityClass) {
        if (EntityClass.startIndex === undefined ||
            EntityClass.totalCount === undefined) {
            return 0;
        }
        const startIndex = EntityClass.startIndex;
        const endIndex = startIndex + EntityClass.totalCount;
        let despawnedCount = 0;
        // Iterate all entities to find active ones
        // We could optimize this by tracking active entities, but despawnAll is rare
        for (let i = startIndex; i < endIndex; i++) {
            if (GameObject.active[i]) {
                const instance = EntityClass.instances[i - startIndex];
                if (instance && instance.despawn) {
                    instance.despawn();
                    despawnedCount++;
                }
                else {
                    // Manual despawn if instance missing (shouldn't happen)
                    GameObject.active[i] = 0;
                    // Return to free list if exists
                    if (EntityClass.freeList) {
                        EntityClass.freeList[++EntityClass.freeListTop] = i;
                    }
                    despawnedCount++;
                }
            }
        }
        return despawnedCount;
    }
}
// Shared memory buffer
GameObject.sharedBuffer = null;
GameObject.entityCount = 0;
// Entity class metadata (for spawning system)
GameObject.startIndex = 0; // Starting index in arrays for this entity type
GameObject.totalCount = 0; // Total allocated entities of this type
GameObject.entityTypeId = 0; // Numeric type identifier for this class
// Array schema - defines all shared arrays and their types
// Order matters! Arrays are laid out in this exact order in memory
// Properties are created dynamically in initializeArrays()
GameObject.ARRAY_SCHEMA = {
    // Transform
    x: Float32Array,
    y: Float32Array,
    vx: Float32Array,
    vy: Float32Array,
    ax: Float32Array,
    ay: Float32Array,
    rotation: Float32Array,
    velocityAngle: Float32Array,
    speed: Float32Array,
    // Verlet Integration (for alternative physics mode)
    px: Float32Array, // Previous X position
    py: Float32Array, // Previous Y position
    // Physics
    maxVel: Float32Array,
    maxAcc: Float32Array,
    minSpeed: Float32Array,
    friction: Float32Array,
    radius: Float32Array,
    collisionCount: Uint8Array, // Number of collisions this frame (for Verlet mode)
    // Perception
    visualRange: Float32Array,
    // State
    active: Uint8Array,
    entityType: Uint8Array, // 0=Boid, 1=Prey, 2=Predator
    isItOnScreen: Uint8Array,
};
// Neighbor data (from spatial worker)
GameObject.neighborData = null;
GameObject.distanceData = null; // Squared distances for each neighbor
GameObject.instances = [];
// Spawning system
GameObject.freeList = null;
GameObject.freeListTop = -1;
// Static initialization block - dynamically create getters/setters from ARRAY_SCHEMA
(() => {
    GameObject._createSchemaProperties(GameObject);
})();

// RenderableGameObject.ts - Game object with rendering properties
// Extends GameObject to add visual/animation state for rendering
/**
 * Extended game object with rendering capabilities
 * Adds visual properties for sprites, animations, and effects
 */
class RenderableGameObject extends GameObject {
    /**
     * Validate spriteConfig format
     * @param EntityClass - The class to validate
     * @returns Validation result with error message if invalid
     */
    static validateSpriteConfig(EntityClass) {
        const config = EntityClass.spriteConfig;
        const className = EntityClass.name;
        // Skip validation for RenderableGameObject itself (base class)
        if (EntityClass === RenderableGameObject) {
            return { valid: true, error: null };
        }
        // Must have spriteConfig
        if (!config) {
            return {
                valid: false,
                error: `${className} extends RenderableGameObject but has no spriteConfig defined!`,
            };
        }
        // Must have type field
        if (!config.type) {
            return {
                valid: false,
                error: `${className}.spriteConfig missing 'type' field! Use type: 'static' or 'animated'`,
            };
        }
        // Validate static sprite config
        if (config.type === 'static') {
            if (!config.textureName) {
                return {
                    valid: false,
                    error: `${className}.spriteConfig type is 'static' but missing 'textureName' field!`,
                };
            }
        }
        // Validate animated sprite config
        if (config.type === 'animated') {
            if (!config.spritesheet) {
                return {
                    valid: false,
                    error: `${className}.spriteConfig type is 'animated' but missing 'spritesheet' field!`,
                };
            }
            if (!config.defaultAnimation) {
                return {
                    valid: false,
                    error: `${className}.spriteConfig type is 'animated' but missing 'defaultAnimation' field!`,
                };
            }
            if (!config.animStates) {
                return {
                    valid: false,
                    error: `${className}.spriteConfig type is 'animated' but missing 'animStates' field! Use animStates instead of animations.`,
                };
            }
        }
        return { valid: true, error: null };
    }
    /**
     * Constructor - initializes rendering properties
     */
    constructor(index, config = {}, logicWorker = null) {
        super(index, config, logicWorker);
        const i = index;
        const spriteConfig = this.constructor.spriteConfig;
        // Initialize rendering properties with defaults
        RenderableGameObject.animationState[i] = 0;
        RenderableGameObject.animationFrame[i] = 0;
        RenderableGameObject.animationSpeed[i] = spriteConfig?.animationSpeed || 0.2;
        RenderableGameObject.tint[i] = 0xffffff; // White (no tint)
        RenderableGameObject.alpha[i] = 1.0; // Fully opaque
        RenderableGameObject.flipX[i] = 0;
        RenderableGameObject.flipY[i] = 0;
        RenderableGameObject.scaleX[i] = 1.0;
        RenderableGameObject.scaleY[i] = 1.0;
        RenderableGameObject.spriteVariant[i] = 0;
        RenderableGameObject.zOffset[i] = 0;
        RenderableGameObject.blendMode[i] = 0; // Normal blend mode
        RenderableGameObject.renderVisible[i] = 1; // Visible by default
        RenderableGameObject.renderDirty[i] = 1; // Mark as dirty initially (needs first render)
    }
    /**
     * Mark this entity's visual properties as dirty (needs rendering update)
     * Call this after changing any visual properties to trigger a render update
     */
    markDirty() {
        RenderableGameObject.renderDirty[this.index] = 1;
    }
    /**
     * Helper setters that automatically mark entity as dirty when visual properties change
     * These provide a convenient API for changing common visual properties
     */
    setAnimationState(state) {
        if (RenderableGameObject.animationState[this.index] !== state) {
            RenderableGameObject.animationState[this.index] = state;
            this.markDirty();
        }
    }
    setAnimationSpeed(speed) {
        if (RenderableGameObject.animationSpeed[this.index] !== speed) {
            RenderableGameObject.animationSpeed[this.index] = speed;
            this.markDirty();
        }
    }
    setTint(tint) {
        if (RenderableGameObject.tint[this.index] !== tint) {
            RenderableGameObject.tint[this.index] = tint;
            this.markDirty();
        }
    }
    setAlpha(alpha) {
        if (RenderableGameObject.alpha[this.index] !== alpha) {
            RenderableGameObject.alpha[this.index] = alpha;
            this.markDirty();
        }
    }
    setFlip(flipX, flipY) {
        let changed = false;
        if (RenderableGameObject.flipX[this.index] !== (flipX ? 1 : 0)) {
            RenderableGameObject.flipX[this.index] = flipX ? 1 : 0;
            changed = true;
        }
        if (flipY !== undefined &&
            RenderableGameObject.flipY[this.index] !== (flipY ? 1 : 0)) {
            RenderableGameObject.flipY[this.index] = flipY ? 1 : 0;
            changed = true;
        }
        if (changed)
            this.markDirty();
    }
    setScale(scaleX, scaleY) {
        let changed = false;
        if (RenderableGameObject.scaleX[this.index] !== scaleX) {
            RenderableGameObject.scaleX[this.index] = scaleX;
            changed = true;
        }
        if (scaleY !== undefined &&
            RenderableGameObject.scaleY[this.index] !== scaleY) {
            RenderableGameObject.scaleY[this.index] = scaleY;
            changed = true;
        }
        if (changed)
            this.markDirty();
    }
    setVisible(visible) {
        if (RenderableGameObject.renderVisible[this.index] !== (visible ? 1 : 0)) {
            RenderableGameObject.renderVisible[this.index] = visible ? 1 : 0;
            this.markDirty();
        }
    }
    /**
     * Helper method to send sprite property changes to renderer
     * For rare/complex changes that can't be done via SharedArrayBuffer
     * Uses direct MessagePort communication for better performance
     * @param prop - Property path (e.g., "tint", "scale.x")
     * @param value - Value to set
     */
    setSpriteProp(prop, value) {
        if (this.logicWorker) {
            this.logicWorker.sendDataToWorker('renderer', {
                cmd: 'setProp',
                entityId: this.index,
                prop: prop,
                value: value,
            });
        }
    }
    /**
     * Helper method to call sprite methods
     * Uses direct MessagePort communication for better performance
     * @param method - Method name
     * @param args - Method arguments
     */
    callSpriteMethod(method, args = []) {
        if (this.logicWorker) {
            this.logicWorker.sendDataToWorker('renderer', {
                cmd: 'callMethod',
                entityId: this.index,
                method: method,
                args: args,
            });
        }
    }
    /**
     * Helper method to batch multiple sprite updates
     * Uses direct MessagePort communication for better performance
     * @param updates - Object with 'set' and/or 'call' properties
     */
    updateSprite(updates) {
        if (this.logicWorker) {
            this.logicWorker.sendDataToWorker('renderer', {
                cmd: 'batchUpdate',
                entityId: this.index,
                ...updates,
            });
        }
    }
}
RenderableGameObject.instances = []; // Instance tracking for this class
// Define rendering-specific properties schema
RenderableGameObject.ARRAY_SCHEMA = {
    ...GameObject.ARRAY_SCHEMA,
    // Animation control
    animationState: Uint8Array, // Current animation index (0-255)
    animationFrame: Uint16Array, // Manual frame control if needed
    animationSpeed: Float32Array, // Playback speed multiplier (1.0 = normal)
    // Visual effects
    tint: Uint32Array, // Color tint (0xFFFFFF = white/normal)
    alpha: Float32Array, // Transparency (0-1)
    // Sprite modifications
    flipX: Uint8Array, // Flip horizontally
    flipY: Uint8Array, // Flip vertically
    scaleX: Float32Array, // Separate X scale
    scaleY: Float32Array, // Separate Y scale
    // Rendering options
    spriteVariant: Uint8Array, // Texture/sprite variant (for different skins)
    zOffset: Float32Array, // Z-index offset (for layering)
    blendMode: Uint8Array, // Blend mode (0=normal, 1=add, 2=multiply, etc.)
    // Visibility
    renderVisible: Uint8Array, // Override visibility (separate from culling)
    // Performance optimization - dirty flag
    renderDirty: Uint8Array, // 1 = visual properties changed, needs update this frame
};
/**
 * Sprite configuration - MUST be overridden in subclasses
 * Defines what texture or spritesheet this entity uses for rendering
 *
 * For static sprites:
 *   static spriteConfig = { type: 'static', textureName: 'bunny' }
 *
 * For animated sprites:
 *   static spriteConfig = {
 *     type: 'animated',
 *     spritesheet: 'person',
 *     defaultAnimation: 'idle',
 *     animationSpeed: 0.15,
 *     animStates: { 0: { name: 'idle', label: 'IDLE' }, ... }
 *   }
 */
RenderableGameObject.spriteConfig = null; // Must be overridden in subclasses
// Static initialization block - create getters/setters for RenderableGameObject's ARRAY_SCHEMA
(() => {
    GameObject._createSchemaProperties(RenderableGameObject);
})();

// GameEngine.ts - Centralized game initialization and state management
// Handles workers, SharedArrayBuffers, class registration, and input management
/**
 * Main Game Engine class
 * Orchestrates workers, manages SharedArrayBuffers, and handles game state
 */
class GameEngine {
    constructor(config, imageUrls = {}) {
        this.log = [];
        this.keyboard = {};
        this.mouse = null;
        this.pendingPhysicsUpdates = [];
        this.totalWorkers = 4;
        // Canvas
        this.canvas = null;
        // Entity registration
        this.registeredClasses = [];
        this.gameObjects = [];
        this.totalEntityCount = 0;
        this.loadedTextures = null;
        this.loadedSpritesheets = {};
        this.updateRate = 1000 / 60; // 60 fps
        this.imageUrls = imageUrls;
        this.state = {
            pause: false,
        };
        // Apply default physics settings if not provided
        this.config = {
            gravity: { x: 0, y: 0 },
            ...config,
        };
        this.config.physics = {
            subStepCount: 4,
            boundaryElasticity: 0.8,
            collisionResponseStrength: 0.5,
            verletDamping: 0.995,
            minSpeedForRotation: 0.1,
            ...(config.physics || {}),
        };
        this.config.physics.gravity = this.config.physics.gravity ||
            this.config.gravity || { x: 0, y: 0 };
        this.config.gravity = this.config.physics.gravity;
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
        this.physics = new Proxy(this.config.physics, {
            get(target, prop) {
                return target[prop];
            },
            set(target, prop, value) {
                target[prop] = value;
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
    registerEntityClass(EntityClass, count, scriptPath = null) {
        // Auto-detect and register parent classes (if not already registered)
        this._autoRegisterParentClasses(EntityClass);
        // Validate spriteConfig for entities that extend RenderableGameObject
        if (typeof RenderableGameObject !== 'undefined' &&
            EntityClass.prototype instanceof RenderableGameObject &&
            count > 0) {
            // Only validate if instances will be created
            const validation = RenderableGameObject.validateSpriteConfig(EntityClass);
            if (!validation.valid) {
                console.error(`❌ ${validation.error}`);
                console.error(`   Please define a proper spriteConfig in ${EntityClass.name}`);
                console.error(`   See SPRITE_CONFIG_GUIDE.md for examples`);
                throw new Error(validation.error);
            }
        }
        // Check if this class is already registered
        const existing = this.registeredClasses.find((r) => r.class === EntityClass);
        if (existing) {
            console.warn(`⚠️ ${EntityClass.name} is already registered. Skipping duplicate registration.`);
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
            EntityClass.sharedBuffer = null;
        }
        if (!EntityClass.hasOwnProperty('entityCount')) {
            EntityClass.entityCount = 0;
        }
        if (!EntityClass.hasOwnProperty('instances')) {
            EntityClass.instances = [];
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
    _autoRegisterParentClasses(EntityClass) {
        const parentChain = [];
        let current = EntityClass;
        // Walk up the prototype chain until we hit GameObject
        while (current && current !== GameObject) {
            parentChain.unshift(current); // Add to front (we want base classes first)
            current = Object.getPrototypeOf(current);
        }
        // Register each class in the chain (if not already registered)
        for (const ParentClass of parentChain) {
            const alreadyRegistered = this.registeredClasses.some((r) => r.class === ParentClass);
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
                    ParentClass.sharedBuffer = null;
                }
                if (!ParentClass.hasOwnProperty('entityCount')) {
                    ParentClass.entityCount = 0;
                }
                if (!ParentClass.hasOwnProperty('instances')) {
                    ParentClass.instances = [];
                }
                // Initialize schema properties for parent class
                if (ParentClass.ARRAY_SCHEMA && ParentClass !== GameObject) {
                    GameObject._createSchemaProperties(ParentClass);
                }
                console.log(`🔧 Auto-registered parent class ${ParentClass.name} (0 instances) for ${EntityClass.name}`);
            }
        }
    }
    /**
     * Initialize everything
     */
    async init() {
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
    createSharedBuffers() {
        // GameObject buffer (transform + physics + perception)
        const gameObjectBufferSize = GameObject.getBufferSize(this.totalEntityCount);
        this.buffers.gameObjectData = new SharedArrayBuffer(gameObjectBufferSize);
        // Neighbor data buffer
        const maxNeighbors = this.config.spatial?.maxNeighbors || this.config.maxNeighbors || 100;
        const NEIGHBOR_BUFFER_SIZE = this.totalEntityCount * (1 + maxNeighbors) * 4;
        this.buffers.neighborData = new SharedArrayBuffer(NEIGHBOR_BUFFER_SIZE);
        // Distance data buffer
        const DISTANCE_BUFFER_SIZE = this.totalEntityCount * (1 + maxNeighbors) * 4;
        this.buffers.distanceData = new SharedArrayBuffer(DISTANCE_BUFFER_SIZE);
        // Initialize GameObject with neighbor and distance buffers
        GameObject.initializeArrays(this.buffers.gameObjectData, this.totalEntityCount, this.buffers.neighborData, this.buffers.distanceData);
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
        const maxCollisionPairs = this.config.physics?.maxCollisionPairs ||
            this.config.maxCollisionPairs ||
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
        const worldCenterX = this.config.worldWidth / 2 - this.config.canvasWidth / 2;
        const worldCenterY = this.config.worldHeight / 2 - this.config.canvasHeight / 2;
        this.camera.x = worldCenterX;
        this.camera.y = worldCenterY;
        this.views.camera[1] = this.camera.x;
        this.views.camera[2] = this.camera.y;
    }
    /**
     * Pre-initialize entityType values to prevent race condition
     * @private
     */
    preInitializeEntityTypeArrays() {
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
    createCanvas() {
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.config.canvasWidth;
        this.canvas.height = this.config.canvasHeight;
        document.body.appendChild(this.canvas);
    }
    /**
     * Preload assets (textures and spritesheets)
     * @private
     */
    async preloadAssets(imageUrls, spritesheetConfigs = {}) {
        this.loadedTextures = {};
        this.loadedSpritesheets = {};
        console.log('📦 preloadAssets called with:', {
            imageUrls: imageUrls,
            imageUrlsKeys: Object.keys(imageUrls),
            spritesheetConfigsKeys: Object.keys(spritesheetConfigs),
        });
        // Load simple textures
        const textureEntries = Object.entries(imageUrls).filter(([name, url]) => {
            if (name === 'spritesheets')
                return false;
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
                await new Promise((resolve, reject) => {
                    img.onload = () => resolve();
                    img.onerror = () => reject();
                    img.src = url;
                });
                const imageBitmap = await createImageBitmap(img);
                this.loadedTextures[name] = imageBitmap;
                console.log(`✅ Loaded texture: ${name}`);
            }
            catch (error) {
                console.error(`❌ Failed to load texture ${name} from ${url}:`, error);
            }
        });
        // Load spritesheets
        console.log(`📦 Loading ${Object.keys(spritesheetConfigs).length} spritesheets...`);
        const spritesheetPromises = Object.entries(spritesheetConfigs).map(async ([name, config]) => {
            try {
                console.log(`  Loading spritesheet "${name}"...`);
                if (!config.json || !config.png) {
                    throw new Error('Invalid spritesheet config: missing json or png property');
                }
                const jsonResponse = await fetch(config.json);
                const jsonData = await jsonResponse.json();
                const img = new Image();
                img.crossOrigin = 'anonymous';
                await new Promise((resolve, reject) => {
                    img.onload = () => resolve();
                    img.onerror = () => reject();
                    img.src = config.png;
                });
                const imageBitmap = await createImageBitmap(img);
                this.loadedSpritesheets[name] = {
                    json: jsonData,
                    imageBitmap: imageBitmap,
                };
                console.log(`✅ Loaded spritesheet: ${name} with ${Object.keys(jsonData.animations || {}).length} animations`);
            }
            catch (error) {
                console.error(`❌ Failed to load spritesheet ${name}:`, error);
            }
        });
        await Promise.all([...texturePromises, ...spritesheetPromises]);
        console.log(`✅ Preloaded ${Object.keys(this.loadedTextures).length} textures and ${Object.keys(this.loadedSpritesheets).length} spritesheets`);
    }
    /**
     * Setup direct MessagePort communication between workers
     * @private
     */
    setupWorkerCommunication() {
        const connections = [
            { from: 'logic', to: 'renderer' },
            { from: 'physics', to: 'renderer' },
        ];
        const workerPorts = {};
        connections.forEach(({ from, to }) => {
            const channel = new MessageChannel();
            if (!workerPorts[from])
                workerPorts[from] = {};
            if (!workerPorts[to])
                workerPorts[to] = {};
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
    async createWorkers() {
        // Create workers with module type
        const cacheBust = `?v=${Date.now()}`;
        this.workers.spatial = new Worker(`/src/workers/spatial_worker.js${cacheBust}`, { type: 'module' });
        this.workers.logic = new Worker(`/src/workers/logic_worker.js${cacheBust}`, { type: 'module' });
        this.workers.physics = new Worker(`/src/workers/physics_worker.js${cacheBust}`, { type: 'module' });
        this.workers.renderer = new Worker(`/src/workers/pixi_worker.js${cacheBust}`, { type: 'module' });
        this.workers.spatial.name = 'spatial';
        this.workers.logic.name = 'logic';
        this.workers.physics.name = 'physics';
        this.workers.renderer.name = 'renderer';
        // Preload assets
        const spritesheetConfigs = (this.imageUrls.spritesheets || {});
        await this.preloadAssets(this.imageUrls, spritesheetConfigs);
        // Collect script paths
        const scriptsToLoad = [
            ...new Set(this.registeredClasses
                .map((r) => r.scriptPath)
                .filter((path) => path !== null && path !== undefined)
                .map((path) => {
                if (!path.startsWith('../') && !path.startsWith('http')) {
                    return `../${path}`;
                }
                return path;
            })),
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
        this.workers.spatial.postMessage(initData);
        this.workers.logic.postMessage({
            ...initData,
            workerPorts: workerPorts.logic,
        }, workerPorts.logic ? Object.values(workerPorts.logic) : []);
        this.workers.physics.postMessage({
            ...initData,
            workerPorts: workerPorts.physics,
        }, workerPorts.physics ? Object.values(workerPorts.physics) : []);
        // Initialize renderer with canvas and textures
        const offscreenCanvas = this.canvas.transferControlToOffscreen();
        const transferables = [
            offscreenCanvas,
            ...Object.values(this.loadedTextures),
            ...Object.values(this.loadedSpritesheets).map((sheet) => sheet.imageBitmap),
            ...(workerPorts.renderer ? Object.values(workerPorts.renderer) : []),
        ];
        this.workers.renderer.postMessage({
            ...initData,
            view: offscreenCanvas,
            textures: this.loadedTextures,
            spritesheets: this.loadedSpritesheets,
            workerPorts: workerPorts.renderer,
        }, transferables);
        // Setup message handlers
        for (const worker of Object.values(this.workers)) {
            if (worker) {
                worker.onmessage = (e) => {
                    this.handleMessageFromWorker(e);
                };
            }
        }
    }
    /**
     * Handle messages from workers
     * @private
     */
    handleMessageFromWorker(e) {
        const workerName = e.currentTarget.name;
        if (e.data.msg === 'fps') {
            this.updateFPS(workerName, e.data.fps);
        }
        else if (e.data.msg === 'log') {
            this.log.push({
                worker: workerName,
                message: e.data.message,
                when: e.data.when - GameEngine.now,
            });
        }
        else if (e.data.msg === 'workerReady') {
            this.handleWorkerReady(workerName);
        }
    }
    /**
     * Handle worker ready signal
     * @private
     */
    handleWorkerReady(workerName) {
        console.log(`✅ ${workerName} worker is ready`);
        this.workerReadyStates[workerName] = true;
        if (workerName === 'physics' && this.pendingPhysicsUpdates.length) {
            this.pendingPhysicsUpdates.forEach((update) => {
                this.workers.physics.postMessage({
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
        }
        else {
            const readyCount = Object.values(this.workerReadyStates).filter((r) => r).length;
            console.log(`   Waiting... (${readyCount}/${this.totalWorkers} workers ready)`);
        }
    }
    /**
     * Send start signal to all workers
     * @private
     */
    startAllWorkers() {
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
    updatePhysicsConfig(partialConfig = {}) {
        if (!partialConfig || typeof partialConfig !== 'object') {
            return;
        }
        Object.assign(this.config.physics, partialConfig);
        const updatePayload = { ...partialConfig };
        if (this.workers.physics &&
            this.workerReadyStates &&
            this.workerReadyStates.physics) {
            this.workers.physics.postMessage({
                msg: 'updatePhysicsConfig',
                config: updatePayload,
            });
        }
        else {
            this.pendingPhysicsUpdates.push(updatePayload);
        }
    }
    /**
     * Update FPS display
     * @private
     */
    updateFPS(id, fps) {
        const element = document.getElementById(id + 'FPS');
        if (element) {
            element.textContent = element.textContent.split(':')[0] + `: ${fps}`;
        }
    }
    /**
     * Update active units display
     */
    updateActiveUnits(count) {
        const element = document.getElementById('activeUnits');
        if (element) {
            element.textContent = `Active units: ${count} / ${this.totalEntityCount}`;
        }
    }
    /**
     * Update visible units display
     */
    updateVisibleUnits(count) {
        const element = document.getElementById('visibleUnits');
        if (element) {
            element.textContent = `Visible units: ${count} / ${this.totalEntityCount}`;
        }
    }
    /**
     * Setup all event listeners
     * @private
     */
    setupEventListeners() {
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
        this.canvas.addEventListener('mousemove', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const canvasX = e.clientX - rect.left;
            const canvasY = e.clientY - rect.top;
            this.mouse = {
                x: canvasX / this.camera.zoom + this.camera.x,
                y: canvasY / this.camera.zoom + this.camera.y,
            };
            this.updateInputBuffer();
        });
        this.canvas.addEventListener('mouseleave', () => {
            this.mouse = null;
            this.updateInputBuffer();
        });
        // Mouse wheel for zoom
        window.addEventListener('wheel', (e) => {
            e.preventDefault();
            const oldZoom = this.camera.zoom;
            const newZoom = Math.max(0.1, Math.min(5, oldZoom + -e.deltaY * 0.001));
            const centerX = this.config.canvasWidth / 2;
            const centerY = this.config.canvasHeight / 2;
            const worldCenterX = centerX / oldZoom + this.camera.x;
            const worldCenterY = centerY / oldZoom + this.camera.y;
            this.camera.x = worldCenterX - centerX / newZoom;
            this.camera.y = worldCenterY - centerY / newZoom;
            this.camera.zoom = newZoom;
            this.updateCameraBuffer();
        }, { passive: false });
    }
    /**
     * Update input buffer with current input state
     * @private
     */
    updateInputBuffer() {
        const input = this.views.input;
        if (this.mouse) {
            input[0] = this.mouse.x;
            input[1] = this.mouse.y;
            input[2] = 1; // Mouse present flag
        }
        else {
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
    updateCameraBuffer() {
        const cam = this.views.camera;
        cam[0] = this.camera.zoom;
        cam[1] = this.camera.x;
        cam[2] = this.camera.y;
    }
    /**
     * Start main game loop
     * @private
     */
    startMainLoop() {
        const loop = (currentTime) => {
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
    update(deltaTime) {
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
        this.updateVisibleUnits(Array.from(GameObject.isItOnScreen).filter((v) => !!v).length);
        this.updateActiveUnits(Array.from(GameObject.active).filter((v) => !!v).length);
    }
    /**
     * Cleanup and destroy engine
     */
    destroy() {
        Object.values(this.workers).forEach((worker) => {
            if (worker)
                worker.terminate();
        });
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
    }
    /**
     * Pause the game
     */
    pause() {
        this.state.pause = true;
        Object.values(this.workers).forEach((worker) => {
            if (worker)
                worker.postMessage({ msg: 'pause' });
        });
    }
    /**
     * Resume the game
     */
    resume() {
        this.state.pause = false;
        Object.values(this.workers).forEach((worker) => {
            if (worker)
                worker.postMessage({ msg: 'resume' });
        });
    }
    /**
     * Spawn an entity from the pool
     * @param className - Name of the entity class (e.g., 'Prey', 'Predator')
     * @param spawnConfig - Initial configuration (position, velocity, etc.)
     */
    spawnEntity(className, spawnConfig = {}) {
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
    despawnAllEntities(className) {
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
    getPoolStats(EntityClass) {
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
GameEngine.now = Date.now();

/**
 * Get parent classes in the inheritance chain
 * @param childClass - The class to get parents for
 * @returns Array of parent classes (excluding Object)
 */
function getParentClasses(childClass) {
    const parentClasses = [];
    let currentClass = childClass;
    // Loop until the prototype chain reaches null (beyond Object.prototype)
    while (currentClass && currentClass !== Object) {
        const parent = Object.getPrototypeOf(currentClass);
        if (parent && parent !== Object.prototype.constructor) {
            // Exclude the base Object constructor
            parentClasses.push(parent);
            currentClass = parent;
        }
        else {
            break; // Reached the top of the inheritance chain
        }
    }
    return parentClasses;
}

// Type definitions for the multithreaded game engine
// Shared interfaces and types used across the library
/**
 * Type guard for checking if a value is a typed array constructor
 */
function isTypedArrayConstructor(value) {
    return (value === Float32Array ||
        value === Float64Array ||
        value === Int32Array ||
        value === Uint32Array ||
        value === Int16Array ||
        value === Uint16Array ||
        value === Int8Array ||
        value === Uint8Array ||
        value === Uint8ClampedArray);
}

export { GameEngine, GameObject, RenderableGameObject, getParentClasses, isTypedArrayConstructor };
//# sourceMappingURL=index.esm.js.map
