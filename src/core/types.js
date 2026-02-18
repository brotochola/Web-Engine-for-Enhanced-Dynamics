/**
 * @fileoverview JSDoc type definitions for WEED.js game engine
 * This file contains typedefs for all major types used throughout the engine.
 *
 * @example
 * // Using a typedef in function documentation:
 * // /**
 * //  * @param {WEED.types.SpawnConfig} config - Spawn configuration
 * //  * @returns {WEED.types.EntityInstance}
 * //  *\/
 * // function spawnEntity(config) { ... }
 */

import { GameObject } from "./gameObject";

// ============================================================================
// NAMESPACE
// ============================================================================

/**
 * @namespace WEED.types
 * Type definitions for WEED.js game engine
 */

// ============================================================================
// COMPONENT PROPERTY TYPES
// ============================================================================

/**
 * Transform component properties
 * @typedef {Object} WEED.types.TransformProperties
 * @property {number} active - Entity active state (0 = inactive, 1 = active)
 * @property {number} entityType - Entity type ID (auto-assigned during registration)
 * @property {number} x - World X position
 * @property {number} y - World Y position
 * @property {number} rotation - Rotation in radians
 */

/**
 * RigidBody component properties
 * @typedef {Object} WEED.types.RigidBodyProperties
 * @property {number} active - Component active state (0 = inactive, 1 = active)
 * @property {number} static - Static flag (0 = dynamic, 1 = static)
 * @property {number} vx - Velocity X
 * @property {number} vy - Velocity Y
 * @property {number} ax - Acceleration X
 * @property {number} ay - Acceleration Y
 * @property {number} px - Previous X position (for Verlet integration)
 * @property {number} py - Previous Y position (for Verlet integration)
 * @property {number} angularVelocity - Angular velocity in radians/frame
 * @property {number} angularAccel - Angular acceleration in radians/frame²
 * @property {number} mass - Mass (auto-computed from collider)
 * @property {number} invMass - Inverse mass (0 for static entities)
 * @property {number} inertia - Moment of inertia
 * @property {number} invInertia - Inverse moment of inertia
 * @property {number} drag - Linear drag coefficient
 * @property {number} angularDrag - Angular drag coefficient
 * @property {number} maxVel - Maximum velocity
 * @property {number} maxAcc - Maximum acceleration
 * @property {number} minSpeed - Minimum speed threshold
 * @property {number} friction - Friction coefficient
 * @property {number} velocityAngle - Velocity direction angle in radians
 * @property {number} speed - Current speed magnitude
 * @property {number} collisionCount - Number of collisions this frame
 * @property {number} sleeping - Sleeping state (0 = awake, 1 = sleeping)
 * @property {number} stillnessTime - Time entity has been still (in frames)
 */

/**
 * Collider component properties
 * @typedef {Object} WEED.types.ColliderProperties
 * @property {number} active - Component active state (0 = inactive, 1 = active)
 * @property {number} shapeType - Shape type (0=Circle, 1=Box, 2=Polygon)
 * @property {number} offsetX - Collider offset X from entity position
 * @property {number} offsetY - Collider offset Y from entity position
 * @property {number} radius - Circle radius (for Circle shape)
 * @property {number} width - Box width (for Box shape)
 * @property {number} height - Box height (for Box shape)
 * @property {number} isTrigger - Trigger mode (0 = normal, 1 = trigger only)
 * @property {number} restitution - Bounciness (0-1)
 * @property {number} collisionLayer - Collision layer bitmask
 * @property {number} collisionMask - Collision mask bitmask
 * @property {number} aabbMinX - AABB minimum X (cached)
 * @property {number} aabbMinY - AABB minimum Y (cached)
 * @property {number} aabbMaxX - AABB maximum X (cached)
 * @property {number} aabbMaxY - AABB maximum Y (cached)
 * @property {number} visualRange - Perception range for spatial queries
 */

/**
 * SpriteRenderer component properties
 * @typedef {Object} WEED.types.SpriteRendererProperties
 * @property {number} active - Component active state (0 = inactive, 1 = active)
 * @property {number} isAnimated - Animation flag (0 = static, 1 = animated)
 * @property {number} spritesheetId - Spritesheet ID (index into sprite registry)
 * @property {number} animationState - Current animation index (0-255)
 * @property {number} animationFrame - Current frame within animation
 * @property {number} animationSpeed - Playback speed multiplier (1.0 = normal)
 * @property {number} loop - Loop flag (0 = no loop, 1 = loop)
 * @property {number} tint - Color tint (0xFFFFFF = white/normal)
 * @property {number} baseTint - Original color (preserved for lighting)
 * @property {number} alpha - Transparency (0-1)
 * @property {number} scaleX - X scale
 * @property {number} scaleY - Y scale
 * @property {number} anchorX - X anchor point (0-1)
 * @property {number} anchorY - Y anchor point (0-1)
 * @property {number} zOffset - Z offset for depth sorting
 * @property {number} blendMode - Blend mode (0=normal, 1=add, 2=multiply, etc.)
 * @property {number} renderVisible - Override visibility flag
 * @property {number} isItOnScreen - Screen culling flag (0 = off screen, 1 = on screen)
 * @property {number} renderDirty - Dirty flag (1 = needs update this frame)
 * @property {number} screenX - Screen X position (cached)
 * @property {number} screenY - Screen Y position (cached)
 */

/**
 * LightEmitter component properties
 * @typedef {Object} WEED.types.LightEmitterProperties
 * @property {number} active - Component active state (0 = inactive, 1 = active)
 * @property {number} lightColor - Light color (0xRRGGBB, stored as BGR)
 * @property {number} lightIntensity - Light intensity
 * @property {number} sqrtLightIntensity - Cached sqrt(intensity) for performance
 * @property {number} height - Light height above ground
 * @property {number} glowHeightOffset - Glow sprite height offset
 * @property {number} hasGlowSprite - Glow sprite flag (0 = no glow, 1 = render glow)
 */

/**
 * ShadowCaster component properties
 * @typedef {Object} WEED.types.ShadowCasterProperties
 * @property {number} active - Component active state (0 = inactive, 1 = active)
 * @property {number} heightMultiplier - Shadow length multiplier (0=no shadow, 1=normal, 2=2x longer)
 * @property {number} x - World X position (shadow sprite only)
 * @property {number} y - World Y position (shadow sprite only)
 * @property {number} rotation - Rotation in radians (shadow sprite only)
 * @property {number} scaleX - Width scale (shadow sprite only)
 * @property {number} scaleY - Length scale (shadow sprite only)
 * @property {number} alpha - Opacity (shadow sprite only)
 * @property {number} entityIdx - Entity index that owns this shadow
 * @property {number} lightIdx - Light entity index that casts this shadow
 * @property {number} anchorOffsetX - Shadow anchor offset X (0-1)
 * @property {number} anchorOffsetY - Shadow anchor offset Y (0-1)
 */

/**
 * ParticleComponent properties
 * @typedef {Object} WEED.types.ParticleComponentProperties
 * @property {number} active - Particle active state (0 = inactive, 1 = active)
 * @property {number} x - World X position
 * @property {number} y - World Y position
 * @property {number} z - Height for 3D effect (z < 0 = above ground)
 * @property {number} vx - Velocity X
 * @property {number} vy - Velocity Y
 * @property {number} vz - Velocity Z (positive = falling down)
 * @property {number} lifespan - Total lifetime in milliseconds (max ~65 seconds)
 * @property {number} currentLife - Time alive so far in milliseconds
 * @property {number} gravity - Per-particle gravity strength
 * @property {number} scaleX - Horizontal scale
 * @property {number} scaleY - Vertical scale
 * @property {number} alpha - Opacity (0-1)
 * @property {number} tint - Color tint (0xRRGGBB, modified by lighting)
 * @property {number} baseTint - Original color (preserved for lighting)
 * @property {number} textureId - Index into texture atlas
 * @property {number} rotation - Rotation in radians
 * @property {number} flipX - Flip horizontally (0 = normal, 1 = flip)
 * @property {number} flipY - Flip vertically (0 = normal, 1 = flip)
 * @property {number} fadeOnTheFloor - Time in ms to fade out when on floor (0 = no fade)
 * @property {number} timeOnFloor - Time particle has been on floor
 * @property {number} initialAlpha - Alpha when particle hit the floor
 * @property {number} stayOnTheFloor - Decal stamp flag (0 = normal, 1 = stamp decal on floor hit)
 * @property {number} despawnOnGroundContact - Despawn on ground contact (0 = normal, 1 = despawn)
 * @property {number} tweenToAlpha0 - Alpha tween flag (0 = no tween, 1 = fade to 0 over lifespan)
 * @property {number} isItOnScreen - Screen culling flag (0 = off screen, 1 = on screen)
 * @property {number} blendMode - Decal blend mode (0 = normal, 1 = multiply)
 */

/**
 * DecorationComponent properties
 * @typedef {Object} WEED.types.DecorationComponentProperties
 * @property {number} active - Decoration active state (0 = inactive, 1 = active)
 * @property {number} x - World X position
 * @property {number} y - World Y position
 * @property {number} offsetX - Offset X for depth sorting
 * @property {number} offsetY - Offset Y for depth sorting
 * @property {number} textureId - Index into texture atlas (bigAtlas animation index)
 * @property {number} scaleX - Scale X
 * @property {number} scaleY - Scale Y
 * @property {number} baseRotation - Base rotation in radians
 * @property {number} rotation - Current rotation in radians (sway animation adds to this)
 * @property {number} alpha - Opacity (0-1)
 * @property {number} tint - Color tint (0xRRGGBB)
 * @property {number} anchorX - Anchor X (0-1, default 0.5)
 * @property {number} anchorY - Anchor Y (0-1, default 0.5)
 * @property {number} isItOnScreen - Screen culling flag (0 = off screen, 1 = on screen)
 * @property {number} sway - Sway animation flag (0 = no sway, 1 = sway enabled)
 * @property {number} swayAmplitude - Rotation amplitude in radians
 * @property {number} swayFrequency - Speed multiplier (1.0 = normal)
 */

/**
 * FlashComponent properties
 * @typedef {Object} WEED.types.FlashComponentProperties
 * @property {number} active - Flash active state (0 = inactive, 1 = active)
 * @property {number} lifespan - Total lifetime in milliseconds
 * @property {number} currentLife - Time alive so far in milliseconds
 * @property {number} initialIntensity - Starting light intensity (decays to 0)
 */

/**
 * FSM component properties
 * @typedef {Object} WEED.types.FSMProperties
 * @property {number} state - Current state index (0-255 states max)
 * @property {number} time - Time in current state (milliseconds)
 * @property {number} nextState - Pending state transition (-1 = none)
 */

// ============================================================================
// CONFIG TYPES
// ============================================================================

/**
 * Scene configuration
 * @typedef {Object} WEED.types.SceneConfig
 * @property {Object} gravity - Gravity vector
 * @property {number} gravity.x - Gravity X component
 * @property {number} gravity.y - Gravity Y component
 * @property {number} worldWidth - World width in pixels
 * @property {number} worldHeight - World height in pixels
 * @property {number} canvasWidth - Canvas width in pixels
 * @property {number} canvasHeight - Canvas height in pixels
 * @property {number} [seed] - Random seed
 * @property {WEED.types.PhysicsConfig} [physics] - Physics configuration
 * @property {WEED.types.SpatialConfig} [spatial] - Spatial hashing configuration
 * @property {WEED.types.ParticleConfig} [particle] - Particle system configuration
 * @property {WEED.types.DecorationConfig} [decoration] - Decoration system configuration
 * @property {WEED.types.LogicConfig} [logic] - Logic worker configuration
 * @property {WEED.types.RendererConfig} [renderer] - Renderer configuration
 * @property {WEED.types.PreRenderConfig} [preRender] - Pre-render configuration
 * @property {WEED.types.LightingConfig} [lighting] - Lighting configuration
 * @property {WEED.types.NavigationConfig} [navigation] - Navigation configuration
 * @property {WEED.types.AssetsConfig} [assets] - Assets configuration
 */

/**
 * Physics configuration
 * @typedef {Object} WEED.types.PhysicsConfig
 * @property {number} subStepCount - Number of physics substeps per frame
 * @property {number} boundaryElasticity - Boundary collision elasticity (0-1)
 * @property {number} collisionResponseStrength - Collision response strength (0-1)
 * @property {number} verletDamping - Verlet integration damping factor
 * @property {number} minSpeedForRotation - Minimum speed required for rotation
 * @property {number} maxCollisionPairs - Maximum collision pairs per frame
 * @property {number} maxConstraints - Maximum distance constraints (0 = disabled)
 * @property {Object} gravity - Gravity vector
 * @property {number} gravity.x - Gravity X component
 * @property {number} gravity.y - Gravity Y component
 * @property {number} sleepThreshold - Speed threshold below which entity is considered still
 * @property {number} wakeUpThreshold - Speed threshold above which entity is considered moving
 * @property {number} sleepDuration - Frames of stillness required before sleeping
 */

/**
 * Spatial hashing configuration
 * @typedef {Object} WEED.types.SpatialConfig
 * @property {number} cellSize - Grid cell size in world units
 * @property {number} maxNeighbors - Maximum neighbors per entity
 * @property {number} maxEntitiesPerCell - Maximum entities per grid cell
 * @property {number} numberOfSpatialWorkers - Number of parallel spatial workers
 * @property {number} rowsPerBlock - Rows per block for spatial worker distribution
 * @property {boolean} noLimitFPS - Disable FPS limiting for spatial workers
 * @property {number} collisionCandidateSearchMargin - Extra distance for collision candidate search
 */

/**
 * Particle system configuration
 * @typedef {Object} WEED.types.ParticleConfig
 * @property {number} maxParticles - Maximum number of particles (0 = unlimited)
 * @property {boolean} noLimitFPS - Disable FPS limiting for particle worker
 * @property {boolean} decals - Enable decal stamping system
 * @property {number} decalsTileSize - Decal tile size in pixels
 * @property {number} decalsResolution - Decal resolution multiplier (0-1)
 */

/**
 * Decoration system configuration
 * @typedef {Object} WEED.types.DecorationConfig
 * @property {number} maxDecorations - Maximum number of static decorations (0 = unlimited)
 */

/**
 * Logic worker configuration
 * @typedef {Object} WEED.types.LogicConfig
 * @property {number} numberOfLogicWorkers - Number of logic workers
 * @property {boolean} staggeredUpdates - Enable tick decimation (entities tick every N frames)
 * @property {boolean} noLimitFPS - Disable FPS limiting for logic workers
 */

/**
 * Renderer configuration
 * @typedef {Object} WEED.types.RendererConfig
 * @property {boolean} noLimitFPS - Disable FPS limiting for renderer
 * @property {boolean} ySorting - Enable Y-axis sorting for depth
 * @property {boolean} interpolation - Smooth rendering when renderer FPS > physics FPS
 * @property {number} cullingRatio - Culling ratio for off-screen entities
 * @property {number} startFadingDecorationsAtZoom - Zoom level where decorations start fading
 * @property {number} hideDecorationsAtZoom - Zoom level where decorations are completely hidden
 * @property {number} maxVisibleRenderables - Maximum items in render queue per frame
 */

/**
 * Pre-render configuration
 * @typedef {Object} WEED.types.PreRenderConfig
 * @property {boolean} noLimitFPS - Run visibility/render queue as fast as possible
 */

/**
 * Sun/directional light configuration
 * @typedef {Object} WEED.types.SunConfig
 * @property {boolean} enabled - Enable sun lighting
 * @property {number} angle - Sun angle in degrees (0=East, 90=South, 180=West, 270=North)
 * @property {number} elevation - Elevation above horizon in degrees (0=horizon, 90=overhead)
 * @property {number} intensity - Light intensity (0-1)
 * @property {number} color - Sun color (0xRRGGBB)
 * @property {number} shadowAlpha - Base darkness of sun-cast shadows (0-1)
 * @property {number} startHour - Starting hour for day cycle (0-24)
 * @property {number} shadowAngleOffset - Hemisphere offset (π for southern, 0 for northern)
 * @property {number} shadowMinLengthRatio - Shadow length multiplier at zenith (shortest)
 * @property {number} shadowMaxLengthRatio - Shadow length multiplier at horizon (longest)
 * @property {number} shadowStretchAlphaFactor - Alpha fade when shadows stretch (0-1)
 * @property {WEED.types.DayCycleConfig} dayCycle - Day cycle configuration
 */

/**
 * Day cycle configuration
 * @typedef {Object} WEED.types.DayCycleConfig
 * @property {boolean} enabled - Enable automatic day cycle
 * @property {number} speed - Time multiplier (1 = real time, 60 = 1 minute = 1 hour)
 * @property {number} dayDurationMinutes - Real minutes for full day (1440 = 24 real hours)
 */

/**
 * Lighting configuration
 * @typedef {Object} WEED.types.LightingConfig
 * @property {boolean} enabled - Enable lighting system
 * @property {number} baseAmbient - Minimum ambient light (night/indoor) (0-1)
 * @property {number} maxLights - Maximum number of lights
 * @property {boolean} shadowsEnabled - Enable shadow casting
 * @property {number} maxShadowCastingLights - Maximum shadow-casting lights
 * @property {number} maxShadowsPerLight - Maximum shadows per light
 * @property {number} maxShadowsPerEntity - Maximum shadows per entity (0 = unlimited)
 * @property {number} maxShadowSprites - Maximum shadow sprites
 * @property {number} maxFlashes - Maximum flash effects (0 = unlimited)
 * @property {number} resolution - Lighting resolution multiplier (0-1)
 * @property {number} shadowResolution - Shadow resolution multiplier (0-1)
 * @property {WEED.types.SunConfig} sun - Sun configuration
 */

/**
 * Navigation configuration
 * @typedef {Object} WEED.types.NavigationConfig
 * @property {boolean} enabled - Enable navigation system
 * @property {number} cellSize - Pixels per navigation cell
 * @property {number} maxFlowfields - Number of distinct flowfield targets to cache
 * @property {number} maxPaths - Number of A* paths to cache
 * @property {number} maxPathLength - Maximum cells per path
 * @property {boolean} noLimitFPS - Run navigation as fast as possible
 */

/**
 * Assets configuration
 * @typedef {Object} WEED.types.AssetsConfig
 * @property {number} maxAtlasWidth - Maximum atlas width in pixels (GPU texture limit)
 * @property {number} maxAtlasHeight - Maximum atlas height in pixels (GPU texture limit)
 * @property {boolean} trimImages - Trim transparent pixels from images
 * @property {number} trimAlphaThreshold - Alpha threshold for trimming
 * @property {number} atlasPadding - Padding between packed sprites
 */

// ============================================================================
// ENTITY TYPES
// ============================================================================

/**
 * Spawn configuration for entities - allows any additional properties for custom initialization
 * @typedef {Object} WEED.types.SpawnConfig
 * @property {number} [x] - Initial X position
 * @property {number} [y] - Initial Y position
 * @property {number} [rotation] - Initial rotation in radians
 * @property {number} [vx] - Initial velocity X
 * @property {number} [vy] - Initial velocity Y
 * @property {Object} [config] - Custom configuration object (passed to entity)
 * @property {*} [*] - Additional custom properties allowed (e.g., radius, scale, etc.)
 */

/**
 * Entity instance reference (returned from spawn)
 * In worker contexts, this is always a GameObject instance with full methods.
 * In main thread, this may be just {index: number} for async messaging.
 * @typedef {GameObject|{index: number}} WEED.types.EntityInstance
 * @property {number} index - Entity index in component arrays
 * @property {function(): void} [despawn] - Despawn method (available on GameObject instances)
 */

/**
 * Entity class metadata
 * @typedef {Object} WEED.types.EntityClassMetadata
 * @property {number} startIndex - Starting index in arrays for this entity type
 * @property {number} poolSize - Allocated count for this entity type
 * @property {Array<Function>} components - Array of component classes this entity uses
 * @property {number} tickInterval - Tick decimation interval (1 = every frame)
 * @property {number} entityType - Entity type ID (auto-assigned during registration)
 * @property {string} scriptUrl - Script URL for worker loading
 */

// ============================================================================
// WORKER MESSAGE TYPES
// ============================================================================

/**
 * Worker initialization message
 * @typedef {Object} WEED.types.WorkerInitMessage
 * @property {string} msg - Message type ("init")
 * @property {WEED.types.SceneConfig} config - Scene configuration
 * @property {number} seed - Random seed
 * @property {Object} workerPorts - Worker communication ports
 * @property {number} frameRateIndex - Frame rate buffer index for this worker
 * @property {SharedArrayBuffer[]} [buffers] - SharedArrayBuffers for components
 * @property {Object} [textures] - Loaded textures (renderer only)
 * @property {Object} [spritesheets] - Loaded spritesheets (renderer only)
 * @property {Object} [tilemaps] - Loaded tilemaps (renderer only)
 * @property {Object} [bigAtlasProxySheets] - Big atlas proxy sheets (renderer only)
 * @property {OffscreenCanvas} [view] - Offscreen canvas (renderer only)
 */

/**
 * Worker spawn message
 * @typedef {Object} WEED.types.WorkerSpawnMessage
 * @property {string} msg - Message type ("spawn")
 * @property {string} className - Entity class name
 * @property {WEED.types.SpawnConfig} spawnConfig - Spawn configuration
 * @property {number} [entityIndex] - Pre-assigned entity index
 */

/**
 * Worker despawn message
 * @typedef {Object} WEED.types.WorkerDespawnMessage
 * @property {string} msg - Message type ("despawn")
 * @property {number} entityIndex - Entity index to despawn
 */

/**
 * Worker control message
 * @typedef {Object} WEED.types.WorkerControlMessage
 * @property {string} msg - Message type ("start" | "pause" | "resume")
 */

/**
 * Navigation request message (flowfield)
 * @typedef {Object} WEED.types.NavigationFlowfieldRequest
 * @property {string} type - Message type ("REQUEST_FLOWFIELD")
 * @property {number} targetCell - Target cell index for flowfield
 */

/**
 * Navigation request message (path)
 * @typedef {Object} WEED.types.NavigationPathRequest
 * @property {string} type - Message type ("REQUEST_PATH")
 * @property {number} fromCell - Starting cell index
 * @property {number} toCell - Destination cell index
 */

/**
 * Navigation rebuild message
 * @typedef {Object} WEED.types.NavigationRebuildMessage
 * @property {string} type - Message type ("REBUILD" | "REBUILD_FROM_INDICES")
 * @property {Array<number>} [staticEntities] - Static entity indices (for REBUILD)
 * @property {Array<number>} [entityIndices] - Entity indices (for REBUILD_FROM_INDICES)
 */

// ============================================================================
// FSM TYPES
// ============================================================================

/**
 * FSM state class definition
 * @typedef {Object} WEED.types.FSMState
 * @property {number} stateIndex - State index (auto-assigned)
 * @property {string} stateName - State name (auto-assigned)
 * @property {Function} fsm - Reference to parent FSM class
 * @property {Function} [onEnter] - Called when entering this state
 * @property {Function} [onExit] - Called when exiting this state
 * @property {Function} [onUpdate] - Called each frame while in this state
 */

/**
 * FSM class definition
 * @typedef {Object} WEED.types.FSMClass
 * @property {boolean} isFSM - FSM marker flag
 * @property {Object<string, Function>} states - Map of state names to state classes
 * @property {Function} initial - Initial state class
 * @property {Array<Function>} _stateArray - Array of state classes indexed by state number
 * @property {Array<string>} _stateNames - Array of state names indexed by state number
 * @property {Map<string, number>} _stateNameToIndex - Map of state name to state index
 */

// ============================================================================
// QUERY SYSTEM TYPES
// ============================================================================

/**
 * Query result containing entity indices
 * @typedef {Object} WEED.types.QueryResult
 * @property {Array<number>} indices - Array of entity indices matching query
 * @property {number} count - Number of matching entities
 */

// ============================================================================
// MEMORY LAYOUT TYPES
// ============================================================================

/**
 * Neighbor data structure
 * Layout: [count, entityIdx0, entityIdx1, ...]
 * @typedef {Uint16Array} WEED.types.NeighborData
 */

/**
 * Active entities data structure
 * Layout: [count, entityIdx0, entityIdx1, ...]
 * @typedef {Uint16Array} WEED.types.ActiveEntitiesData
 */

/**
 * Camera data structure
 * Layout: [zoom, x, y]
 * @typedef {Float32Array} WEED.types.CameraData
 */

// ============================================================================
// PARTICLE EMITTER TYPES
// ============================================================================

/**
 * Particle emitter configuration
 * @typedef {Object} WEED.types.ParticleEmitterConfig
 * @property {string} textureName - Texture name for particles
 * @property {number} [spawnRate] - Particles per second
 * @property {number} [minLifespan] - Minimum particle lifespan in ms
 * @property {number} [maxLifespan] - Maximum particle lifespan in ms
 * @property {Object} [velocity] - Velocity configuration
 * @property {number} [velocity.minX] - Minimum velocity X
 * @property {number} [velocity.maxX] - Maximum velocity X
 * @property {number} [velocity.minY] - Minimum velocity Y
 * @property {number} [velocity.maxY] - Maximum velocity Y
 * @property {Object} [scale] - Scale configuration
 * @property {number} [scale.min] - Minimum scale
 * @property {number} [scale.max] - Maximum scale
 * @property {number} [tint] - Particle color tint (0xRRGGBB)
 * @property {number} [gravity] - Gravity strength for particles
 */

// ============================================================================
// CONSTRAINT TYPES
// ============================================================================

/**
 * Distance constraint configuration
 * @typedef {Object} WEED.types.ConstraintConfig
 * @property {number} entityA - First entity index
 * @property {number} entityB - Second entity index
 * @property {number} distance - Target distance between entities
 * @property {number} [stiffness] - Constraint stiffness (0-1)
 * @property {number} [damping] - Constraint damping (0-1)
 */

// ============================================================================
// RAY CASTING TYPES
// ============================================================================

/**
 * Ray cast result
 * @typedef {Object} WEED.types.RayCastResult
 * @property {boolean} hit - Whether ray hit something
 * @property {number} [entityIndex] - Hit entity index (if hit)
 * @property {number} [distance] - Distance to hit point (if hit)
 * @property {number} [x] - Hit point X coordinate (if hit)
 * @property {number} [y] - Hit point Y coordinate (if hit)
 */

// ============================================================================
// NAVIGATION TYPES
// ============================================================================

/**
 * Flowfield data
 * @typedef {Object} WEED.types.FlowfieldData
 * @property {number} targetCell - Target cell index
 * @property {Float32Array} directions - Direction vectors for each cell
 * @property {number} lastUsed - Last frame this flowfield was used (LRU)
 */

/**
 * Path data
 * @typedef {Object} WEED.types.PathData
 * @property {number} fromCell - Starting cell index
 * @property {number} toCell - Destination cell index
 * @property {Array<number>} cells - Array of cell indices forming the path
 * @property {number} lastUsed - Last frame this path was used (LRU)
 */

// ============================================================================
// GAMEOBJECT TYPES
// ============================================================================

/**
 * Entity class (constructor function for GameObject subclasses)
 * @typedef {Function} WEED.types.EntityClass
 * @property {number} startIndex - Starting index in arrays for this entity type
 * @property {number} poolSize - Allocated count for this entity type
 * @property {number} endIndex - Ending index in arrays (startIndex + poolSize)
 * @property {Array<Function>} components - Array of component classes this entity uses
 * @property {number} tickInterval - Tick decimation interval (1 = every frame)
 * @property {number} entityType - Entity type ID (auto-assigned during registration)
 * @property {Uint16Array|null} neighborData - Neighbor data buffer from spatial worker
 * @property {WEED.types.ActiveEntitiesData|null} activeEntitiesData - Active entities list
 * @property {Uint8Array|null} nextTick - Tick decimation countdown buffer
 * @property {WEED.types.CameraData|null} cameraData - Camera data buffer
 * @property {number} globalEntityCount - Total number of entities
 * @property {Array<GameObject>} instances - Array of entity instances
 * @property {Uint16Array|null} _activeList - Per-type active list (SAB-backed)
 * @property {Uint16Array|null} freeList - Free list for object pooling (SAB-backed)
 * @property {Int32Array|null} freeListTop - Free list top pointer (SAB-backed)
 * @property {Object<string, Function>} _componentClassMap - Component class map
 * @property {Function} get - Get entity instance by index
 * @property {Function} spawn - Spawn entity from pool
 * @property {Function} despawnAll - Despawn all entities of this type
 * @property {Function} getPoolStats - Get pool statistics
 * @property {Function} getAllActive - Get all active entity indices
 * @property {Function} getAllActiveInstances - Get all active entity instances
 * @property {Function} getFirstActiveIndex - Get first active entity index
 * @property {Function} getFirstActiveInstance - Get first active entity instance
 */

/**
 * Component class (constructor function for Component subclasses)
 * @typedef {Function} WEED.types.ComponentClass
 * @property {boolean} [isFSM] - Whether this component is an FSM
 * @property {Function} [initializeEntity] - Initialize entity with this component
 */

/**
 * Pool statistics
 * @typedef {Object} WEED.types.PoolStats
 * @property {number} total - Total pool size
 * @property {number} active - Number of active entities
 * @property {number} available - Number of available slots
 */

/**
 * Worker context (logic worker, particle worker, etc.)
 * @typedef {Object} WEED.types.WorkerContext
 * @property {Object<string, Uint16Array>} _queryResultViews - Query result views
 * @property {Array<Object>} _precomputedQueries - Precomputed queries
 * @property {Object<number, Object>} _queryEntityMetadata - Query entity metadata
 * @property {Map<number, number>} currentCollisions - Current collisions map
 * @property {Function} queueSpawnListUpdate - Queue spawn list update
 * @property {Function} queueDespawnListUpdate - Queue despawn list update
 */

/**
 * Component class map
 * @typedef {Object<string, WEED.types.ComponentClass>} WEED.types.ComponentClassMap
 */

/**
 * Free list array (SAB-backed)
 * @typedef {Uint16Array} WEED.types.FreeList
 */

/**
 * Active list array (SAB-backed)
 * Layout: [count, entityIdx0, entityIdx1, ...]
 * @typedef {Uint16Array} WEED.types.ActiveList
 */

/**
 * Component cache object
 * @typedef {Object<string, Object>} WEED.types.ComponentCache
 */

/**
 * Has components object (flags for which components entity has)
 * @typedef {Object<string, boolean>} WEED.types.HasComponents
 */

/**
 * Neighbor offset (for spatial queries)
 * @typedef {number} WEED.types.NeighborOffset
 */

/**
 * Query system data
 * @typedef {Object} WEED.types.QuerySystemData
 * @property {Object<string, Uint16Array>} _queryResultViews - Query result views
 * @property {Array<Object>} _precomputedQueries - Precomputed queries
 * @property {Object<number, Object>} _queryEntityMetadata - Query entity metadata
 */

/**
 * Query definition
 * @typedef {Object} WEED.types.QueryDefinition
 * @property {number} queryMask - Component mask for query
 */

/**
 * Entity metadata for queries
 * @typedef {Object} WEED.types.QueryEntityMetadata
 * @property {number} componentMask - Component mask for entity type
 */

// ============================================================================
// EXPORT FOR JSDOC REFERENCE
// ============================================================================

// This file is for JSDoc type definitions only - no runtime code
// Types are referenced using @type, @param, @returns annotations:
// @param {WEED.types.SpawnConfig} config
// @returns {WEED.types.EntityInstance}
