/**
 * The `WEED` that workers hand to scene and entity scripts.
 *
 * Workers evaluate the scene file to find its entity classes, so every name an
 * entity may use at runtime is here. Main-thread-only names (GameEngine, saves,
 * the atlas inspector) are not. Bundled workers do not carry the main-thread
 * Scene: `class MyScene extends Scene` extends the empty stand-in below, and
 * the worker only reads its statics (`entities`, `sharedResources`).
 */
import { VERSION } from '../version.js';
import { GameObject, Keyboard, SceneBridge } from '../core/gameObject.js';
import { Component } from '../core/component.js';
import { FSM } from '../core/fsm.js';
import { FSMState } from '../core/fsmState.js';
import { DebugFlags, DEBUG_FLAGS, DEBUG_SELECTED_ENTITY_OFFSET } from '../core/debug/debugFlags.js';
import { DebugDraw } from '../core/debug/debugDraw.js';
import { Mouse } from '../core/mouse.js';
import { Gamepad } from '../core/gamepad.js';
import { Camera } from '../core/camera.js';
import { Time } from '../core/timeScale.js';
import { Tween } from '../core/tween.js';
import { Noise2D } from '../core/noise2D.js';
import { Ray } from '../core/ray.js';
import { NavGrid } from '../core/navGrid.js';
import { Grid } from '../core/grid.js';
import { Sun } from '../core/sun.js';
import { Layer } from '../core/layer.js';
import { TileMap } from '../core/tileMap.js';
import { SpriteSheetRegistry } from '../core/spriteSheetRegistry.js';
import { AdobeAnimRegistry } from '../core/adobeAnimRegistry.js';
import { SoundManager } from '../core/soundManager.js';
import {
  mixSeed,
  seededRandom,
  collisionPairKey,
  containerRadius,
  distanceSq2D,
  getDirectionFromAngle,
  getDirectionFromVector,
  getDirection8FromVector,
  mixTint,
  randomColor,
  rng,
  layerMask,
  normalizeAngle,
  dot2,
  randomUnitCS,
} from '../util/utils.js';
import { Transform } from '../components/transform.js';
import { RigidBody } from '../components/rigidBody.js';
import { Collider } from '../components/collider.js';
import { SpriteRenderer } from '../components/spriteRenderer.js';
import { MeshRenderer } from '../components/meshRenderer.js';
import { AdobeAnimComponent } from '../components/adobeAnimComponent.js';
import { ParticleComponent } from '../components/particleComponent.js';
import { DecorationComponent } from '../components/decorationComponent.js';
import { LightEmitter } from '../components/lightEmitter.js';
import { ShadowCaster } from '../components/shadowCaster.js';
import {
  LightOccluder,
  LIGHT_OCCLUDER_MASK_COLLIDER,
  LIGHT_OCCLUDER_MASK_SPRITE,
} from '../components/lightOccluder.js';
import { FlashComponent } from '../components/flashComponent.js';
import { CameraInOutListener } from '../components/cameraInOutListener.js';
import { CollisionListener } from '../components/collisionListener.js';
import { JointBreakListener } from '../components/jointBreakListener.js';
import { Grab } from '../components/grab.js';
import { ParticleEmitter, DECAL_STAMPS_BLEND_MODE } from '../core/particleEmitter.js';
import { LiquidFun, LIQUIDFUN_FLAGS, LIQUIDFUN_GROUP_FLAGS } from '../core/liquidFun.js';
import { Box2d } from '../core/box2d.js';
import { Decal } from '../core/decal.js';
import {
  DECORATION_Y_SORT_SCALE,
  DECORATION_INNER_Z_MIN,
  DECORATION_INNER_Z_MAX,
  ENTITY_GLOW_SORT_BIAS,
  DECORATION_NO_PARENT,
  decorationNoParent,
  SWAY_OFF,
  SWAY_LOOP,
  SWAY_LOOP_SKEW,
  SWAY_IMPULSE,
  DecorationPool,
} from '../core/decorationPool.js';
import { Decoration } from '../core/decoration.js';
import { DecorationSpatial } from '../core/decorationSpatial.js';
import { BulletPool } from '../core/bulletPool.js';
import { BulletComponent } from '../components/bulletComponent.js';
import { Joint } from '../core/joint.js';
import { ColliderFixture } from '../core/colliderFixture.js';
import { SharedAtomicPool } from '../core/sharedAtomicPool.js';
import { SharedResource, SharedResourceMailbox } from '../core/sharedResource.js';
// Networking: the pure helpers only (Network itself is main-thread WebRTC).
import {
  NET_CHANNEL,
  NET_MSG,
  netNow,
  generateRoomCode,
  normalizeRoomCode,
  formatRoomCode,
} from '../core/network/netProtocol.js';
import {
  writePoseSnapshot,
  readPoseSnapshot,
  poseSnapshotBytes,
  isNewerTick,
} from '../core/network/poseSnapshot.js';
import { Flash } from '../core/flash.js';
import { Query } from '../core/query.js';
import {
  ShapeType,
  MAX_POLYGON_VERTICES,
  Box2dBodyType,
  STATE_CHANNELS,
  BLEND_MODES,
  LAYER_DENSITY_SOURCE,
  LAYER_COMPUTE_SOURCE,
  LAYER_FEEDER_KIND,
  LAYER_KIND,
  LAYER_SUBSCRIBE_KIND,
  COMPUTE_FLAG_STATIC,
  LAYER_SPLAT_FALLOFF,
  LAYER_SCALE_MODE,
  SPRITE_TILE_MODE,
  DEFAULT_LAYERS,
  CAMERA_TYPES,
  PARTICLE_EASE,
} from '../util/configDefaults.js';
import {
  FORCE_PROCESS_ON_LOGIC_WORKER_NONE,
  resolveForceProcessOnLogicWorker,
  logicWorkerThatShouldTick,
} from '../util/logicOwner.js';

/** Stand-in for the main-thread Scene: workers only read a scene class's statics. */
class Scene {}

const enums = Object.freeze({
  ShapeType,
  MAX_POLYGON_VERTICES,
  Box2dBodyType,
  STATE_CHANNELS,
  BLEND_MODES,
  LAYER_DENSITY_SOURCE,
  LAYER_COMPUTE_SOURCE,
  LAYER_FEEDER_KIND,
  LAYER_KIND,
  LAYER_SUBSCRIBE_KIND,
  COMPUTE_FLAG_STATIC,
  LAYER_SPLAT_FALLOFF,
  LAYER_SCALE_MODE,
  SPRITE_TILE_MODE,
  DEFAULT_LAYERS,
  CAMERA_TYPES,
  PARTICLE_EASE,
  DECAL_STAMPS_BLEND_MODE,
  DEBUG_FLAGS,
  DEBUG_SELECTED_ENTITY_OFFSET,
});

export const WORKER_WEED = Object.freeze({
  ...enums,
  DECORATION_Y_SORT_SCALE,
  DECORATION_INNER_Z_MIN,
  DECORATION_INNER_Z_MAX,
  ENTITY_GLOW_SORT_BIAS,
  DECORATION_NO_PARENT,
  decorationNoParent,
  Scene,
  GameObject,
  Component,
  FSM,
  FSMState,
  DebugFlags,
  DebugUI: DebugDraw, // workers draw through DebugDraw; DebugUI.drawLine(...) still works
  DebugDraw,
  Mouse,
  Gamepad,
  Camera,
  Time,
  Tween,
  Noise2D,
  Ray,
  NavGrid,
  Grid,
  Sun,
  Layer,
  TileMap,
  Keyboard,
  SceneBridge,
  SpriteSheetRegistry,
  AdobeAnimRegistry,
  SoundManager,
  Transform,
  RigidBody,
  Collider,
  SpriteRenderer,
  MeshRenderer,
  AdobeAnimComponent,
  ParticleComponent,
  LightEmitter,
  ShadowCaster,
  LightOccluder,
  LIGHT_OCCLUDER_MASK_COLLIDER,
  LIGHT_OCCLUDER_MASK_SPRITE,
  FlashComponent,
  CameraInOutListener,
  CollisionListener,
  JointBreakListener,
  Grab,
  ParticleEmitter,
  LiquidFun,
  LIQUIDFUN_FLAGS,
  LIQUIDFUN_GROUP_FLAGS,
  Box2d,
  Decal,
  Query,
  Decoration,
  DecorationComponent,
  DecorationSpatial,
  DecorationPool,
  SWAY_OFF,
  SWAY_LOOP,
  SWAY_LOOP_SKEW,
  SWAY_IMPULSE,
  BulletPool,
  BulletComponent,
  Joint,
  ColliderFixture,
  SharedAtomicPool,
  SharedResource,
  SharedResourceMailbox,
  NET_CHANNEL,
  NET_MSG,
  netNow,
  generateRoomCode,
  normalizeRoomCode,
  formatRoomCode,
  writePoseSnapshot,
  readPoseSnapshot,
  poseSnapshotBytes,
  isNewerTick,
  Flash,
  FORCE_PROCESS_ON_LOGIC_WORKER_NONE,
  resolveForceProcessOnLogicWorker,
  logicWorkerThatShouldTick,
  mixSeed,
  seededRandom,
  collisionPairKey,
  containerRadius,
  distanceSq2D,
  getDirectionFromAngle,
  getDirectionFromVector,
  getDirection8FromVector,
  mixTint,
  randomColor,
  rng,
  layerMask,
  normalizeAngle,
  dot2,
  randomUnitCS,
  enums,
  VERSION,
});
