// Identifiers Terser must not rename. Class and component names are compared
// via .name (scene registration, save/load). Property names are not mangled.
export const MINIFY_RESERVED_NAMES = [
    // Core
    'WEED', 'GameEngine', 'Scene', 'GameObject', 'Component',
    'FSM', 'FSMState', 'DebugFlags', 'DebugUI', 'DebugDraw', 'Mouse', 'Camera',
    'Ray', 'NavGrid', 'Keyboard', 'SpriteSheetRegistry', 'BigAtlasInspector',
    // Components - CRITICAL: these names are used for identification
    'Transform', 'RigidBody', 'Collider', 'SpriteRenderer',
    'ParticleComponent', 'DecorationComponent', 'LightEmitter',
    'ShadowCaster', 'FlashComponent',
    // Systems
    'ParticleEmitter', 'DecorationPool', 'Flash', 'QuerySystem',
    'Box2d', 'Decal', 'Query', 'LiquidFun', 'Decoration',
    // Workers
    'AbstractWorker',
    // Enums
    'ShapeType',
];
