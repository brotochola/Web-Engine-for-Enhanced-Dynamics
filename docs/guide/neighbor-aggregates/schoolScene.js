// A school of fish and the sharks that hunt it, steered by neighbour aggregates (SPATIAL_HASHING.md, "Neighbour
// aggregates"): each fish and each shark reads one row of NeighborAggregates a tick, not each of its neighbours.
// Run it: npm run dev, then http://localhost:8000/docs/guide/neighbor-aggregates/
// Built-in textures only (_whiteCircle): no assets to download.

// No import: the page imported the engine, which defines WEED here and in every worker.
const { Scene, GameObject, RigidBody, Collider, SpriteRenderer, Transform, NeighborAggregates, Camera } = WEED;

const WORLD_W = 2400;
const WORLD_H = 1600;
const FISH = 3000;
const SHARKS = 6;

/** Steer back in near the world's edges (px from the edge, and px/s² at the edge). */
function edgePush(x, y, margin, strength, out) {
  out[0] = x < margin ? strength : x > WORLD_W - margin ? -strength : 0;
  out[1] = y < margin ? strength : y > WORLD_H - margin ? -strength : 0;
}
const EDGE = new Float64Array(2);

class Fish extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer];

  // What the spatial workers sum for each fish, with its neighbour list. A getter, because Shark is declared below
  // (the scene reads it once it has registered every type).
  static get neighborAggregates() {
    return {
      separation: { radius: 20, falloff: 'linear', ofType: Fish }, // too close: push apart
      cohesion: { minDistance: 20, velocity: true, ofType: Fish }, // the rest of the school: its centre and heading
      nearest: { ofType: Shark, count: 1 }, // the shark to flee
    };
  }

  onSpawned({ x, y, vx, vy }) {
    this.x = x;
    this.y = y;
    this.setSprite('_whiteCircle');
    this.setDisplaySize(6);
    this.setTint(0x80deea);
    // No body to collide with: a fish only needs its neighbours, the fish within 60 px.
    this.collider.active = false;
    this.collider.visualRange = 60;
    this.rigidBody.vx = vx;
    this.rigidBody.vy = vy;
    this.rigidBody.linearDamping = 0.5;
    this.setFixedRotation(true);
  }

  tick() {
    const i = this.index;
    const A = NeighborAggregates;
    const x = Transform.x[i];
    const y = Transform.y[i];
    // Separation: already a sum of pushes, each over its distance squared.
    let ax = A.separationX[i] * 3000;
    let ay = A.separationY[i] * 3000;
    if (A.cohesionCount[i] > 0) {
      // Cohesion and alignment: towards the school's centre, and to its average velocity.
      ax += (A.centroidX[i] - x) * 2 + (A.averageVelocityX[i] - RigidBody.vx[i]) * 1.5;
      ay += (A.centroidY[i] - y) * 2 + (A.averageVelocityY[i] - RigidBody.vy[i]) * 1.5;
    }
    if (A.nearestCount[i] > 0) {
      // Flee the nearest shark, harder the closer it is (its distance as the spatial worker saw it).
      const shark = A.nearestIndex[A.nearestOffset(i)];
      const d2 = A.nearestDistanceSq[A.nearestOffset(i)] + 100;
      ax += ((x - Transform.x[shark]) / d2) * 60000;
      ay += ((y - Transform.y[shark]) / d2) * 60000;
    }
    edgePush(x, y, 80, 400, EDGE);
    this.addAcceleration(ax + EDGE[0], ay + EDGE[1]);
  }
}

class Shark extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer];
  // A shark only wants the nearest fish.
  static neighborAggregates = { nearest: { ofType: Fish, count: 1 } };

  onSpawned({ x, y }) {
    this.x = x;
    this.y = y;
    this.setSprite('_whiteCircle');
    this.setDisplaySize(22);
    this.setTint(0xef5350);
    this.collider.active = false;
    this.collider.visualRange = 250;
    this.rigidBody.linearDamping = 1.5;
    this.setFixedRotation(true);
  }

  tick() {
    const i = this.index;
    const A = NeighborAggregates;
    const x = Transform.x[i];
    const y = Transform.y[i];
    let ax = 0;
    let ay = 0;
    if (A.nearestCount[i] > 0) {
      // Chase the nearest fish (its position now, not when the list was made).
      const fish = A.nearestIndex[A.nearestOffset(i)];
      const dx = Transform.x[fish] - x;
      const dy = Transform.y[fish] - y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      ax = (dx / d) * 500;
      ay = (dy / d) * 500;
    }
    edgePush(x, y, 120, 600, EDGE);
    this.addAcceleration(ax + EDGE[0], ay + EDGE[1]);
  }
}

export class SchoolScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    // The whole school spawns on the first frame: a few physics commands a fish, past the command ring's default room.
    physics: { gravity: { x: 0, y: 0 }, sleeping: false, commandRingCapacity: 32768 },
    spatial: { cellSize: 32, maxNeighbors: 64 },
    renderer: { backend: 'webgl' },
    lighting: { enabled: false },
  };

  static entities = [
    [Fish, FISH],
    [Shark, SHARKS],
  ];

  create() {
    Camera.centerOn(WORLD_W / 2, WORLD_H / 2);
  }

  createNewGame() {
    for (let k = 0; k < FISH; k++) {
      Fish.spawn({
        x: 100 + this.rng() * (WORLD_W - 200),
        y: 100 + this.rng() * (WORLD_H - 200),
        vx: (this.rng() - 0.5) * 120,
        vy: (this.rng() - 0.5) * 120,
      });
    }
    for (let k = 0; k < SHARKS; k++) Shark.spawn({ x: this.rng() * WORLD_W, y: this.rng() * WORLD_H });
  }
}
