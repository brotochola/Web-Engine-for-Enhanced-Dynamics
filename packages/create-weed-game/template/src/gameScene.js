// Your game. Save this file while `npm run dev` runs: the game reloads where you were.
// Guide: https://github.com/brotochola/Web-Engine-for-Enhanced-Dynamics/blob/main/docs/guide/FIRST_GAME.md

// No import: the page imported the engine, which defines WEED here and in every worker.
const { Scene, GameObject, RigidBody, Collider, SpriteRenderer } = WEED;
const { Keyboard, Camera, Transform, ShapeType } = WEED;

const WORLD_W = 1600;
const WORLD_H = 1000;

class Player extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer];
  static serializable = true; // saves and hot reload keep it

  // Runs on every spawn from the pool.
  onSpawned({ x, y }) {
    this.x = x;
    this.y = y;
    this.setSprite('_whiteCircle'); // built-in texture
    this.setDisplaySize(48);
    this.setTint(0x4fc3f7);
    this.collider.shapeType = ShapeType.Circle;
    this.collider.fitToSprite();
    this.rigidBody.linearDamping = 4;
    this.setFixedRotation(true);
  }

  // Every frame, on a worker thread.
  tick() {
    const ax = (Keyboard.isDown('d') ? 1 : 0) - (Keyboard.isDown('a') ? 1 : 0);
    const ay = (Keyboard.isDown('s') ? 1 : 0) - (Keyboard.isDown('w') ? 1 : 0);
    this.addAcceleration(ax * 2400, ay * 2400); // px/s², while the key is held

    if (Keyboard.isPressed('space') && (ax !== 0 || ay !== 0)) {
      const len = Math.sqrt(ax * ax + ay * ay);
      const kick = 900 * this.rigidBody.mass; // an impulse: mass × change of speed (px/s)
      this.applyImpulse((ax / len) * kick, (ay / len) * kick);
      this.emit('dash'); // to the scene, on the page
    }
  }
}

class Wall extends GameObject {
  static components = [Collider, SpriteRenderer]; // no RigidBody: a static body

  onSpawned({ x, y, w, h }) {
    this.x = x;
    this.y = y;
    this.setSprite('_white');
    this.setDisplaySize(w, h);
    this.setTint(0x37474f);
    this.collider.fitToSprite();
  }
}

export class GameScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    physics: { gravity: { x: 0, y: 0 } }, // top-down
    renderer: { backend: 'webgl' },
    lighting: { enabled: false },
  };

  // Pools: how many of each entity the scene can hold.
  static entities = [
    [Player, 1],
    [Wall, 4],
  ];

  onLoadProgress(done, total) {
    setText('loading', done < total ? `Loading… ${Math.round((100 * done) / total)} %` : '');
  }

  // Runs for a new game and for a loaded save (hot reload too). The scene runs on the page.
  create() {
    this.dashes = 0;
    this.on('dash', () => {
      this.dashes++;
      this.showHud();
    });
    const t = 20;
    this.spawnEntity(Wall, { x: WORLD_W / 2, y: t / 2, w: WORLD_W, h: t });
    this.spawnEntity(Wall, { x: WORLD_W / 2, y: WORLD_H - t / 2, w: WORLD_W, h: t });
    this.spawnEntity(Wall, { x: t / 2, y: WORLD_H / 2, w: t, h: WORLD_H });
    this.spawnEntity(Wall, { x: WORLD_W - t / 2, y: WORLD_H / 2, w: t, h: WORLD_H });
    this.showHud();
  }

  // Only for a new game: a loaded save brings the player back by itself.
  createNewGame() {
    this.spawnEntity(Player, { x: WORLD_W / 2, y: WORLD_H / 2 });
  }

  // Scene state outside entities, kept by saves and hot reload.
  onSaveGame() {
    return { dashes: this.dashes };
  }

  onLoadGame(payload) {
    this.dashes = payload.custom?.dashes ?? 0;
    this.showHud();
  }

  // Every frame, on the page.
  update() {
    const player = Player.getFirstActiveIndex();
    if (player !== null) Camera.follow(Transform.x[player], Transform.y[player], 0.12);
  }

  showHud() {
    setText('hud', `WASD to move, Space to dash · dashes: ${this.dashes}`);
  }
}

function setText(id, text) {
  const el = typeof document !== 'undefined' && document.getElementById(id);
  if (el) el.textContent = text;
}
