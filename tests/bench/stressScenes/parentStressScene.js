import WEED from '/src/index.js';
import { mulberry32 } from '../benchMath.js';

const { Scene, Camera, GameObject, Component, RigidBody, Collider, SpriteRenderer, Transform, enums } = WEED;
const { ShapeType } = enums;

/**
 * DX-PARENTBENCH: Transform.parent under load. PARENTS bodies drift and spin inside four walls (no gravity, no
 * friction, full bounce), each with CHILDREN sprites around it on a ring, turned with it.
 *
 * `?link=1` (the default): the children are linked (transform.parent, localX, localY, localRotation): physics writes
 * their pose after its step, pre-render composes them from their parent's drawn pose. `?link=0`: the same children,
 * unlinked, and each parent's tick moves its own from logic (what a game wrote before DX-PARENT): the comparison.
 * `?children=0`: the parents alone, the floor both read against.
 *
 * Knobs: `?parents=` (default 3000), `?children=` (default 4, at most 8), `?speed=` px/s (default 120), `?spin=` rad/s
 * (default 2), `?ring=` px (default 22), `?zoom=` (default 0.5: most of the world on the screen, so pre-render draws the
 * children it composes). Owner workers: physics (link=1) or logic (link=0), and pre-render.
 */
function query(key) {
  return WEED.params?.get(key) ?? null;
}

function queryNumber(key, fallback) {
  const raw = query(key);
  const n = raw === null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const PARENTS = Math.max(1, Math.floor(queryNumber('parents', 3000)));
const CHILDREN = Math.min(8, Math.max(0, Math.floor(queryNumber('children', 4))));
const LINK = query('link') !== '0';
const SPEED = queryNumber('speed', 120);
const SPIN = queryNumber('spin', 2);
const RING = queryNumber('ring', 22);
const ZOOM = queryNumber('zoom', 0.5);
const WORLD_W = 4000;
const WORLD_H = 3000;
const WALL = 400;
const SEED = 0x9a7e;

export const stressSceneConfig = {
  requested: { parents: PARENTS, children: CHILDREN, link: LINK ? 1 : 0, speed: SPEED, spin: SPIN, zoom: ZOOM },
};

/** A child's place on its parent's ring: CHILDREN of them evenly round it, each turned to face outwards. */
function ringX(k) {
  return Math.cos((k / Math.max(1, CHILDREN)) * Math.PI * 2) * RING;
}
function ringY(k) {
  return Math.sin((k / Math.max(1, CHILDREN)) * Math.PI * 2) * RING;
}
function ringTurn(k) {
  return (k / Math.max(1, CHILDREN)) * Math.PI * 2;
}

/** With ?link=0, each parent's children (entity index + 1; 0 none), which its tick moves. */
class OwnChildren extends Component {
  static ARRAY_SCHEMA = {
    child0: Int32Array, child1: Int32Array, child2: Int32Array, child3: Int32Array,
    child4: Int32Array, child5: Int32Array, child6: Int32Array, child7: Int32Array,
  };
}
const CHILD_COLUMNS = ['child0', 'child1', 'child2', 'child3', 'child4', 'child5', 'child6', 'child7'];

class Wall extends GameObject {
  static components = [RigidBody, Collider];

  onSpawned(config = {}) {
    this.collider.shapeType = ShapeType.Box;
    this.collider.width = config.width;
    this.collider.height = config.height;
    this.collider.radius = 0;
    this.collider.friction = 0;
    this.collider.restitution = 1;
    this.collider.visualRange = 0;
    this.rigidBody.static = 1;
  }
}

class Spinner extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer, OwnChildren];

  onSpawned(config = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 10;
    this.collider.friction = 0;
    this.collider.restitution = 1;
    this.collider.visualRange = 0;
    this.rigidBody.linearDamping = 0;
    this.rigidBody.angularDamping = 0;
    this.setSprite('box');
    this.setScale(0.2);
    this.setVelocity(config.vx ?? 0, config.vy ?? 0);
    this.angularVelocity = config.spin ?? 0;
  }

  /** ?link=0: its children moved from logic, as a game did before DX-PARENT. */
  tick() {
    if (LINK) return;
    const index = this.index;
    const c = Math.cos(this.rotation);
    const s = Math.sin(this.rotation);
    const x = this.x;
    const y = this.y;
    for (let k = 0; k < CHILDREN; k++) {
      const child = OwnChildren[CHILD_COLUMNS[k]][index] - 1;
      if (child < 0) continue;
      const lx = ringX(k);
      const ly = ringY(k);
      Transform.x[child] = x + c * lx - s * ly;
      Transform.y[child] = y + s * lx + c * ly;
      Transform.rotation[child] = this.rotation + ringTurn(k);
    }
  }
}

class Rider extends GameObject {
  static components = [SpriteRenderer];

  onSpawned() {
    this.setSprite('box');
    this.setScale(0.1);
  }
}

export class ParentStressScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: SEED,
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 1, noLimitFPS: false, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    lighting: { enabled: false },
  };

  static assets = { textures: { box: '/demos/img/box_100_100.png' } };

  static entities = [
    [Wall, 4],
    [Spinner, PARENTS],
    [Rider, Math.max(1, PARENTS * CHILDREN)],
  ];

  create() {
    const rng = mulberry32(SEED);
    Wall.spawn({ x: WORLD_W / 2, y: -WALL / 2, width: WORLD_W + 2 * WALL, height: WALL });
    Wall.spawn({ x: WORLD_W / 2, y: WORLD_H + WALL / 2, width: WORLD_W + 2 * WALL, height: WALL });
    Wall.spawn({ x: -WALL / 2, y: WORLD_H / 2, width: WALL, height: WORLD_H });
    Wall.spawn({ x: WORLD_W + WALL / 2, y: WORLD_H / 2, width: WALL, height: WORLD_H });
    for (let p = 0; p < PARENTS; p++) {
      const angle = rng() * Math.PI * 2;
      const parent = Spinner.spawn({
        x: 60 + rng() * (WORLD_W - 120),
        y: 60 + rng() * (WORLD_H - 120),
        vx: Math.cos(angle) * SPEED,
        vy: Math.sin(angle) * SPEED,
        spin: (rng() * 2 - 1) * SPIN,
      });
      if (!parent) break;
      for (let k = 0; k < CHILDREN; k++) {
        const child = LINK
          ? Rider.spawn({ x: parent.x, y: parent.y, parent: parent.index, localX: ringX(k), localY: ringY(k), localRotation: ringTurn(k) })
          : Rider.spawn({ x: parent.x + ringX(k), y: parent.y + ringY(k) });
        if (!LINK && child) OwnChildren[CHILD_COLUMNS[k]][parent.index] = child.index + 1;
      }
    }
    Camera.setZoom(ZOOM);
    Camera.centerOn(WORLD_W / 2, WORLD_H / 2);
  }
}
