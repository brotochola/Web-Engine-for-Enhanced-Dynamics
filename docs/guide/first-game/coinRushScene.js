// Coin Rush — the game docs/guide/FIRST_GAME.md builds, step by step.
// Run it: npm run dev, then http://localhost:8000/docs/guide/first-game/
// Built-in textures only (_white, _whiteCircle): no assets to download.

// No import: the page imported the engine, which defines WEED here and in every worker.
const { Scene, GameObject, Component, RigidBody, Collider, SpriteRenderer, CollisionListener } = WEED;
const { Keyboard, Camera, Tween, Transform, ShapeType, PARTICLE_EASE } = WEED;

const WORLD_W = 1600;
const WORLD_H = 1000;

// --- Data lives in components: every worker sees it, saves keep it ---------

class Health extends Component {
  static ARRAY_SCHEMA = { hp: Float32Array };
}

// --- Entities -----------------------------------------------------------------

class Wall extends GameObject {
  static components = [Collider, SpriteRenderer];

  onSpawned({ x, y, w, h }) {
    this.x = x;
    this.y = y;
    this.setSprite('_white');
    this.setDisplaySize(w, h);
    this.setTint(0x37474f);
    this.collider.fitToSprite(); // a box the size of the sprite
  }
}

class Player extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer, CollisionListener, Health];
  static serializable = true;

  onSpawned({ x = WORLD_W / 2, y = WORLD_H / 2 } = {}) {
    this.x = x;
    this.y = y;
    this.setSprite('_whiteCircle');
    this.setDisplaySize(40);
    this.setTint(0x4fc3f7);
    this.collider.shapeType = ShapeType.Circle;
    this.collider.fitToSprite(0.9); // a slightly forgiving hitbox
    this.rigidBody.linearDamping = 4;
    this.setFixedRotation(true);
    this.health.hp = 3;
  }

  tick() {
    const ax = (Keyboard.isDown('d') ? 1 : 0) - (Keyboard.isDown('a') ? 1 : 0);
    const ay = (Keyboard.isDown('s') ? 1 : 0) - (Keyboard.isDown('w') ? 1 : 0);
    this.addAcceleration(ax * 2400, ay * 2400); // every tick while a key is held
  }

  onCollisionEnter(other) {
    if (GameObject.is(other, Coin)) this.sendTo(other, 'collect');
  }

  onMessage(name, from, amount) {
    if (name !== 'hit' || this.health.hp <= 0) return;
    this.health.hp -= amount;
    this.emit('hp', { hp: this.health.hp });
    if (this.health.hp <= 0) {
      this.emit('died');
      this.despawn();
    }
  }
}

class Coin extends GameObject {
  static components = [Collider, SpriteRenderer];
  static serializable = true;

  onSpawned({ x, y }) {
    this.x = x;
    this.y = y;
    this.setSprite('_whiteCircle');
    this.setDisplaySize(18);
    this.setTint(0xffd54f);
    this.collider.shapeType = ShapeType.Circle;
    this.collider.fitToSprite();
    this.collider.isTrigger = 1; // a sensor: reported, not solid
    // Pulse forever: grow, shrink, grow…
    Tween.to(this.index, { scaleX: this.scaleX * 1.3, scaleY: this.scaleY * 1.3 }, 450, PARTICLE_EASE.QUAD_INOUT, {
      repeat: -1,
      yoyo: true,
    });
  }

  onMessage(name) {
    if (name === 'collect' && this.collider.active) {
      this.collider.active = 0; // no second pickup while it fades
      this.emit('coin');
      Tween.cancel(this.index);
      Tween.to(this.index, { alpha: 0 }, 200, PARTICLE_EASE.QUAD_OUT, { onComplete: 'gone' });
    } else if (name === 'gone') {
      this.despawn();
    }
  }
}

class Slime extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer, CollisionListener];
  static serializable = true;

  onSpawned({ x, y }) {
    this.x = x;
    this.y = y;
    this.setSprite('_white');
    this.setDisplaySize(30, 30);
    this.setTint(0x81c784);
    this.collider.fitToSprite();
    this.rigidBody.linearDamping = 2;
  }

  tick() {
    const player = Player.getFirstActiveIndex();
    if (player !== null) this.accelerateTowards(Transform.x[player], Transform.y[player], 500);
  }

  onCollisionEnter(other) {
    if (!GameObject.is(other, Player)) return;
    this.sendTo(other, 'hit', 1);
    // Bounce back: one kick, heavier slimes would move less.
    const dx = this.x - Transform.x[other];
    const dy = this.y - Transform.y[other];
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    this.applyImpulse((dx / len) * 600 * this.rigidBody.mass, (dy / len) * 600 * this.rigidBody.mass);
  }
}

// --- The scene ------------------------------------------------------------------

export class CoinRushScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    physics: { gravity: { x: 0, y: 0 } },
    renderer: { backend: 'webgl' },
    lighting: { enabled: false },
  };

  static messages = ['hit', 'collect', 'gone'];
  static entities = [
    [Player, 1],
    [Coin, 64],
    [Slime, 24],
    [Wall, 4],
  ];

  onLoadProgress(done, total, stage) {
    hud('loading', done < total ? `Loading… ${Math.round((100 * done) / total)} % (${stage})` : '');
  }

  create(data) {
    this.level = data?.level ?? 1;
    this.score = data?.score ?? 0;
    this.coinsLeft = 0;
    this.dead = false;
    this.on('coin', () => {
      this.score++;
      this.coinsLeft--;
      this.showScore();
      if (this.coinsLeft === 0) this.next({ level: this.level + 1, score: this.score });
    });
    this.on('hp', ({ hp }) => {
      hud('hp', `HP ${hp}`);
      Camera.shake(10, 160);
    });
    this.on('died', () => {
      this.dead = true;
      hud('msg', 'Game over: press R');
    });
    const t = 20;
    Wall.spawn({ x: WORLD_W / 2, y: t / 2, w: WORLD_W, h: t });
    Wall.spawn({ x: WORLD_W / 2, y: WORLD_H - t / 2, w: WORLD_W, h: t });
    Wall.spawn({ x: t / 2, y: WORLD_H / 2, w: t, h: WORLD_H });
    Wall.spawn({ x: WORLD_W - t / 2, y: WORLD_H / 2, w: t, h: WORLD_H });
    hud('msg', `Level ${this.level}: WASD`);
    hud('hp', 'HP 3');
  }

  createNewGame() {
    Player.spawn({ x: WORLD_W / 2, y: WORLD_H / 2 });
    const coins = 8 + this.level * 4;
    for (let i = 0; i < coins; i++) {
      Coin.spawn({ x: 80 + this.rng() * (WORLD_W - 160), y: 80 + this.rng() * (WORLD_H - 160) });
    }
    for (let i = 0; i < this.level * 2; i++) {
      Slime.spawn({ x: 100 + this.rng() * (WORLD_W - 200), y: this.rng() < 0.5 ? 100 : WORLD_H - 100 });
    }
    this.coinsLeft = coins;
    this.showScore();
  }

  // Scene state outside entities: saved with them, back in onLoadGame.
  onSaveGame() {
    return { level: this.level, score: this.score, coinsLeft: this.coinsLeft };
  }

  onLoadGame(payload) {
    Object.assign(this, payload.custom ?? {});
    this.showScore();
  }

  update() {
    const player = Player.getFirstActiveIndex();
    if (player !== null) Camera.follow(Transform.x[player], Transform.y[player], 0.12);
    if (this.dead && this.keyboard.r) this.next({ level: 1, score: 0 });
  }

  showScore() {
    hud('score', `Score ${this.score} · coins left ${this.coinsLeft}`);
  }

  next(data) {
    if (this._leaving) return;
    this._leaving = true;
    this.game.loadScene(import.meta.url, { data });
  }
}

/** A tiny HTML HUD: one line per key, top-left. UI is plain HTML. */
function hud(key, text) {
  if (typeof document === 'undefined') return;
  let box = document.getElementById('coin-rush-hud');
  if (!box) {
    box = document.createElement('div');
    box.id = 'coin-rush-hud';
    box.style.cssText = 'position:fixed;left:12px;top:12px;z-index:5;color:#fff;font:16px/1.5 system-ui,sans-serif;text-shadow:0 1px 2px #000;pointer-events:none';
    document.body.appendChild(box);
  }
  let line = box.querySelector(`[data-k="${key}"]`);
  if (!line) {
    line = document.createElement('div');
    line.dataset.k = key;
    box.appendChild(line);
  }
  line.textContent = text;
}
