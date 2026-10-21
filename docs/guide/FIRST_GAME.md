# Your first game: Coin Rush

A small, complete game in about fifteen minutes: move a ball with WASD, collect coins, avoid the slimes that chase you, and go up a level when the coins run out. It uses the engine's built-in textures, so there is nothing to download.

The finished code is [`first-game/coinRushScene.js`](./first-game/coinRushScene.js). Every snippet below comes from that file. To play it, run `npm run dev` in this repository and open `http://localhost:8000/docs/guide/first-game/`.

If you know Unity, Godot or Phaser, keep [COMING_FROM.md](./COMING_FROM.md) open beside this page.

## 1. A page and an engine

```html
<script type="module">
  import WEED from '@weed.js/engine/debug'; // the repo examples use '/src/index.js'

  const game = new WEED.GameEngine({ debug: true, hotReload: true });
  await game.loadScene(new URL('./coinRushScene.js', import.meta.url).href, { data: { level: 1 } });
</script>
```

- The page must be served with the two isolation headers (`npm run dev` sends them; for hosting see [DEPLOY.md](./DEPLOY.md)).
- `debug: true` gives the debug panel and clearer warnings; ship the production build later.
- `loadScene` takes the URL of the scene module (workers import the same file) and `data` for the scene.
- `hotReload: true`: with `npm run dev`, saving a file reloads the game where you were.

## 2. The scene

A scene declares its settings, how many of each entity it may hold, and the message names its entities send each other.

```js
export class CoinRushScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    physics: { gravity: { x: 0, y: 0 } }, // top-down
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
}
```

Entities are **pooled**: `[Coin, 64]` reserves 64 coins up front, and spawning takes one from the pool. Nothing is allocated while the game runs. A spawn into a full pool returns `null` and warns once.

## 3. The player

```js
class Player extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer, CollisionListener, Health];

  onSpawned({ x = WORLD_W / 2, y = WORLD_H / 2 } = {}) {
    this.x = x;
    this.y = y;
    this.setSprite('_whiteCircle');
    this.setDisplaySize(40);           // world px, whatever the texture size
    this.setTint(0x4fc3f7);
    this.collider.shapeType = ShapeType.Circle;
    this.collider.fitToSprite(0.9);    // a slightly forgiving hitbox
    this.rigidBody.linearDamping = 4;
    this.setFixedRotation(true);
    this.health.hp = 3;
  }
}
```

- `static components` is fixed per class. Each component becomes a property in camelCase: `this.rigidBody`, `this.health`.
- `onSpawned` runs on **every** spawn from the pool, so set everything the entity needs there; a reused slot must not keep the previous life's values.

## 4. Data lives in components

```js
class Health extends Component {
  static ARRAY_SCHEMA = { hp: Float32Array };
}
```

Your code runs on several worker threads. A plain field like `this.hp = 3` exists only in the copy of the object on one thread, and a save does not keep it. Component fields live in shared memory: every thread sees them, and saves keep them. Read and write them as `this.health.hp`, or as `Health.hp[index]` for another entity.

## 5. Moving

```js
tick() {
  const ax = (Keyboard.isDown('d') ? 1 : 0) - (Keyboard.isDown('a') ? 1 : 0);
  const ay = (Keyboard.isDown('s') ? 1 : 0) - (Keyboard.isDown('w') ? 1 : 0);
  this.addAcceleration(ax * 2400, ay * 2400); // every tick while a key is held
}
```

`tick` runs every frame on a logic worker. `addAcceleration` pushes for this tick (px/s²) and Box2D integrates it; with `linearDamping` the ball slows down when you let go. The four ways to push a body are in [PHYSICS.md](./PHYSICS.md#moving-bodies).

## 6. Walls

```js
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
```

A `Collider` without a `RigidBody` is a static body: it blocks, but never moves. The scene spawns the four walls in `create()`, which runs for a new game and for a loaded save alike.

## 7. Coins: sensors, messages and `is`

```js
class Coin extends GameObject {
  static components = [Collider, SpriteRenderer];

  onSpawned({ x, y }) {
    // …sprite and circle collider…
    this.collider.isTrigger = 1; // a sensor: reported, not solid
  }
}

// in Player
onCollisionEnter(other) {
  if (this.is(other, Coin)) this.sendTo(other, 'collect');
}
```

- `onCollisionEnter` only runs for types that list `CollisionListener` (the scene warns at load if you forget it). `other` is the other entity's **index**.
- `this.is(other, Coin)` asks what it is (subclasses count).
- `sendTo(other, 'collect')` delivers `onMessage('collect', …)` on the coin, next frame, on the thread that owns the coin. Names come from the scene's `static messages`, and the payload is up to four numbers.

## 8. Tweens: a pulse and a fade

```js
// in Coin.onSpawned: pulse forever
Tween.to(this.index, { scaleX: this.scaleX * 1.3, scaleY: this.scaleY * 1.3 }, 450, 'quad.inout', {
  repeat: -1,
  yoyo: true,
});

// in Coin
onMessage(name) {
  if (name === 'collect' && this.collider.active) {
    this.collider.active = 0; // no second pickup while it fades
    this.emit('coin');
    Tween.cancel(this.index);
    Tween.to(this.index, { alpha: 0 }, 200, 'quad.out', { onComplete: 'gone' });
  } else if (name === 'gone') {
    this.despawn();
  }
}
```

`onComplete: 'gone'` sends the coin the message `gone` when the fade ends. A despawn cancels an entity's tweens, so a recycled coin never inherits a fade.

## 9. Slimes

```js
class Slime extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer, CollisionListener];

  tick() {
    const player = Player.getFirstActiveIndex();
    if (player !== null) this.accelerateTowards(Transform.x[player], Transform.y[player], 500);
  }

  onCollisionEnter(other) {
    if (!this.is(other, Player)) return;
    this.sendTo(other, 'hit', 1);
    const dx = this.x - Transform.x[other];
    const dy = this.y - Transform.y[other];
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    this.applyImpulse((dx / len) * 600 * this.rigidBody.mass, (dy / len) * 600 * this.rigidBody.mass);
  }
}
```

`applyImpulse` is one kick on the next physics step; several in one frame add up. `Transform.x[other]` reads another entity's position straight from shared memory.

## 10. The HUD is HTML

```js
// in Player.onMessage
this.emit('hp', { hp: this.health.hp });

// in the scene's create()
this.on('hp', ({ hp }) => {
  hud('hp', `HP ${hp}`);
  Camera.shake(10, 160);
});
```

Entities run on workers, which cannot touch the page. `this.emit(name, data)` posts to the main thread, where `scene.on(name, fn)` gets it. The HUD is a few `<div>`s (see `hud()` at the end of the file). Use `emit` for events, not for something that changes every frame.

## 11. Levels and restarting

```js
create(data) {
  this.level = data?.level ?? 1;
  this.score = data?.score ?? 0;
  this.on('coin', () => {
    this.score++;
    this.coinsLeft--;
    if (this.coinsLeft === 0) this.next({ level: this.level + 1, score: this.score });
  });
}

next(data) {
  this.game.loadScene(import.meta.url, { data });
}
```

`loadScene(url, { data })` hands the next scene its parameters, as `create(data)` and `this.data`. The scene's `update()` runs on the main thread every frame; this one makes the camera follow the player and restarts on R after a game over.

## 12. Saving

```js
static serializable = true; // on Player, Coin and Slime

onSaveGame() {
  return { level: this.level, score: this.score, coinsLeft: this.coinsLeft };
}

onLoadGame(payload) {
  Object.assign(this, payload.custom ?? {});
}
```

`await scene.saveGame('slot1')` keeps every serializable entity's components, and `onSaveGame` adds what the scene holds itself. `scene.loadGame('slot1')` remounts the scene: `create()` runs, then the entities come back, then `onLoadGame(payload)`. Details: [SAVE_GAME.md](./SAVE_GAME.md).

## 13. A loading line

```js
onLoadProgress(done, total, stage) {
  hud('loading', done < total ? `Loading… ${Math.round((100 * done) / total)} % (${stage})` : '');
}
```

The scene reports each boot step (assets, workers, world). The last one, `world`, comes right before the first frame.

## Where next

- [COMING_FROM.md](./COMING_FROM.md): Unity, Godot and Phaser names for what you just used.
- [bible_of_weed_js.md](./bible_of_weed_js.md): the full scene, entity and layer reference.
- [PHYSICS.md](./PHYSICS.md): bodies, forces, joints, queries.
- [DEPLOY.md](./DEPLOY.md): putting the game online.
