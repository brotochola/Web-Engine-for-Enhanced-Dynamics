# Scene files: levels as data

A scene has two parts:

- **The scene class** (code): its settings (`static config`), its pools (`static entities`), its message names, and its rules: `preload`, `create`, `createNewGame`, `update`, the `scene.on` listeners.
- **A scene file** (`*.scene.json`, data): which entities a level places, where, and with what settings.

Levels that share their rules share one class, and each level is a file. The platformer demo is one `PlatformerGameScene` with two levels, [`levels/1-1.scene.json`](../../demos/platformerGameScene/levels/1-1.scene.json) and [`levels/1-2.scene.json`](../../demos/platformerGameScene/levels/1-2.scene.json); a goal at the end of each loads the other. Scene files are plain JSON, laid out to be edited by hand and read in a diff.

## What goes where

| In the scene file | In the scene class |
| --- | --- |
| What a designer places and moves: platforms, walls, goals, doors, trees | What every level shares: settings, pools, layers, shaders, the lights `create()` sets up |
| The settings that differ between placed entities: a platform's size, which door a lever opens | What follows from the game being played: the player, the score, enemies spawned by rules |

Rule of thumb: **if you would drag it in an editor, it goes in the file; if it is the same in every level, or it depends on the state of the game, it stays in code.**

## A scene file

```json
{
  "format": 1,
  "script": "../platformerGameScene.js",
  "export": "PlatformerGameScene",
  "entities": [
    { "name": "Ground", "class": "Platform", "x": 600, "y": 2050, "config": { "width": 1200, "height": 60 } },
    { "name": "Step", "class": "Platform", "x": 400, "y": 1900 },
    { "name": "Goal1", "class": "Goal", "x": 1100, "y": 1940, "config": { "next": "1-2.scene.json" } }
  ]
}
```

- `format`: the layout's version, 1.
- `script`: the scene's module, relative to the file. `export`: the scene class it exports; leave it out when the module exports one scene class.
- `entities`, in the order they spawn:
  - `name`: unique in the file. The scene finds the entity by it (`getByName`), and other entities refer to it by it.
  - `class`: an entity class in the scene's `static entities`. An entity of a class that is not there is skipped, with a warning.
  - `x`, `y`: where it spawns.
  - `config`: the spawn params that differ from the class's defaults (next section). Leave it out when none do.

Keys the format does not know are allowed and kept. One entity per line, with its keys in this order, keeps a moved platform a one-line diff.

### Loading one

```js
await game.loadScene('/demos/platformerGameScene/levels/1-1.scene.json', { data: { levelsDone: 0 } });
```

The file's `script` and `export` name the scene class, and the scene runs:

```text
preload(data)
the file's entities spawn       file order, except that an entity another one refers to comes first
create(data)                    getByName finds the file's entities
createNewGame(data)             or the save being loaded
```

A scene class can name its first level, relative to its module, so that loading the class or its module places that level:

```js
// demos/platformerGameScene/platformerGameScene.js
  static entities = [
    [BluePlatformerPlayer, 1],
    [Platform, 64],
    [Goal, 4],
  ];

  // Loaded by this module (benches, old links), the scene places what its first level file does.
  static defaultSceneFile = './levels/1-1.scene.json';
```

Pools are the class's, so size them for its biggest level. A file that places more entities of a class than its pool holds warns, naming the count to raise.

## Spawn params: what a level sets per entity

A class declares, once, the config its `onSpawned` reads: a default for each key, and a range for numbers. The engine fills in what a file or a `spawn()` call leaves out, and an editor can build its fields from the same declaration. Unity's `[SerializeField, Range]` and Godot's `@export_range` do the same.

```js
// demos/platformerGameScene/gameObjects/platform.js
export class Platform extends GameObject {
  static components = [Collider, SpriteRenderer, ShadowCaster, RigidBody];
  // …
  static spawnParams = {
    width: { value: 220, min: 8, max: 4000, step: 1 },
    height: { value: 36, min: 8, max: 1000, step: 1 },
    tint: { value: 0x495870, type: 'color' },
    alpha: { value: 1, min: 0, max: 1, step: 0.05 },
  };

  onSpawned(params) {
  // …
    const width = params.width;
    const height = params.height;
  // …
    this.setTint(params.tint);
    this.setAlpha(params.alpha);
```

`onSpawned` gets every declared key, plus `x` and `y`, and needs no `params.width ?? 220` of its own. `Platform.spawn({ x: 100, y: 200, width: 400 })` in code and `{ "class": "Platform", "x": 100, "y": 200, "config": { "width": 400 } }` in a file make the same platform. A class without `spawnParams` works as before: its `onSpawned` gets the caller's config as it is.

### Kinds

| Kind | Declared as | `onSpawned` gets | Fields besides `value`, `label` and `tip` |
| --- | --- | --- | --- |
| number | `{ value: 220, min: 8, max: 4000, step: 1 }` | a number | `min`, `max`, `step` |
| color | `{ value: 0xffcc33, type: 'color' }` | a number from 0x000000 to 0xffffff | |
| enum | `{ value: 0, type: 'enum', options: { Loop: 0, PingPong: 1 } }` | one of the options' numbers | `options` |
| bool | `{ value: false }` | `true` or `false` | |
| string | `{ value: '' }` | a string | |
| sprite | `{ value: '_white', type: 'sprite' }` | a texture's name, for `setSprite` | |
| animation | `{ value: 'run', type: 'animation' }` | an animation's name, for `setAnimation` | |
| entity | `{ value: null, type: 'entity', class: 'Door' }` | that entity, or `null` | `class` |
| points | `{ value: null, type: 'points' }` | x, y pairs in a `Float64Array` | |

A number, boolean or string `value` implies its kind; the others need a `type`. Any entry can have a `label` and a `tip` for the editor. A declaration with a mistake (an unknown field such as `valeu`, a default outside its `min` and `max`, a kind that does not exist) throws when the scene registers the class, naming the class and the key. A subclass that adds params spreads its parent's: `static spawnParams = { ...Platform.spawnParams, speed: { value: 2 } };`.

An entity param refers to another entity of the file by its name, and a points param is an array:

```js
class GuardState extends Component {
  static ARRAY_SCHEMA = { speed: Float32Array, mode: Uint8Array, door: Int32Array };
}

class Guard extends GameObject {
  static components = [GuardState];
  static spawnParams = {
    route: { value: null, type: 'points', tip: 'The x, y pairs the guard walks, in order' },
    mode: { value: 0, type: 'enum', options: { Loop: 0, PingPong: 1 } },
    speed: { value: 120, min: 0, max: 600, step: 10, label: 'Speed (px/s)' },
    door: { value: null, type: 'entity', class: 'Door', tip: 'The door this guard opens' },
  };

  onSpawned(params) {
    this.guardState.speed = params.speed;
    this.guardState.mode = params.mode;
    this.guardState.door = params.door ? params.door.index : -1;
  }
}
```

```json
{ "name": "Guard1", "class": "Guard", "x": 300, "y": 900, "config": { "route": [300, 900, 700, 900], "door": "Door1" } },
{ "name": "Door1", "class": "Door", "x": 800, "y": 900 }
```

The file spawns `Door1` before `Guard1`, because `Guard1` refers to it, and `onSpawned` gets the door entity. It keeps the door's index, which every thread can read, not the entity object, which is only that worker's. Two entities that refer to each other in a loop are warned about, and one of them gets `null`. In code, an entity param takes an entity or its index: `Guard.spawn({ x, y, door: door1 })`.

### The params object is the engine's

`onSpawned` gets an object the engine reuses: the next spawn of the class overwrites it. Read it during `onSpawned`, and copy what the entity needs into components:

```js
onSpawned(params) {
  this.collider.width = params.width; // copied: stays
  this.settings = params; // kept: the next spawn of the class changes it
}
```

- `x` and `y` always come. `layer`, `layers`, `active` and `forceProcessOnLogicWorker` are not params: the engine reads them from the config itself, and a class cannot declare them. A file's `"config": { "layer": "front" }` puts the entity on that layer, after `onSpawned`.
- Debug builds warn once per class and key when a config has a key nothing reads (`widht` for `width`), or a value of the wrong kind (a string for a number): `WeedJS: Platform.spawn(): "widht" is not in Platform.spawnParams, and nothing else reads it`.
- A points param given a plain array in code is copied into a `Float64Array` on every spawn; pass a `Float64Array`. A file's arrays are converted once, when it loads.

## Finding what the file placed: getByName

```js
create() {
  const goal = this.getByName('Goal1'); // that Goal, or null
}
```

On the page, from `create()` on. It returns `null` when the running file has no such name, or when that entity has despawned: its pool slot may hold another entity by then, and a name never points at the wrong one. Entities refer to each other through entity params instead.

## Joints between placed entities

A file can join its entities with physics joints, by name, in a `joints` section after its entities:

```json
"joints": [
  { "type": "revolute", "a": "Door1", "b": "Wall1", "anchorA": [-40, 0], "anchorB": [20, 0], "enableLimit": true, "lowerAngle": -1.5, "upperAngle": 0 },
  { "name": "Rope", "type": "distance", "a": "Lamp1", "b": "Ceiling", "anchorA": [0, -16], "enableSpring": true, "hertz": 3 }
]
```

- `type`: one of the four joints `Joint` makes (`Joint.addRevolute` and the others).
- `a`, `b`: the names of two entities of the file.
- `anchorA`, `anchorB`: where the joint holds each entity, in pixels from its position and turning with it (`Joint`'s local anchors). Left out, `[0, 0]`: the entity's position.
- The type's settings, under `Joint`'s own names; the ones left out take `Joint`'s defaults. Angles are radians.
- `forceThreshold`, `torqueThreshold`: the force or torque that breaks the joint (a `JointBreakListener` hears it). Left out, it never breaks.
- `name`: optional, unique among the joints.

| Type | What it does | Settings |
| --- | --- | --- |
| `distance` | Keeps the two anchors at a distance, or springs toward it | `length`, `enableSpring`, `hertz`, `dampingRatio` |
| `revolute` | A hinge: the anchors stay together, the entities turn | `enableLimit`, `lowerAngle`, `upperAngle`, `enableMotor`, `motorSpeed`, `maxMotorTorque` |
| `prismatic` | A slider along `axisAngle`, without turning | `axisAngle`, `enableLimit`, `lowerTranslation`, `upperTranslation`, `enableMotor`, `motorSpeed`, `maxMotorForce` |
| `weld` | Holds the two together, stiffly or springily | `linearHertz`, `angularHertz`, `linearDampingRatio`, `angularDampingRatio` |

A distance joint without `length` keeps its anchors as far apart as the file places them. The scene makes the joints once the file's entities have spawned, before `create()`, so the joints are there for it; a joint waits until both bodies exist. A joint naming an entity that is not there (a typo, a class the scene lacks, a full pool) is skipped, and one warning names the file and every joint skipped. The scene's `config.physics.maxJoints` must hold them. In the editor, the inspector of a placed entity lists the joints that name it, adds and removes them, and Alt+drag on a joint's handle in the view moves that anchor; renaming an entity renames it in its joints, and deleting it deletes its joints (undo brings them back).

## Decorations

Grass, rocks, flowers: what a level scatters by the thousand, drawn and swayed but never ticked (`Decoration`). The scene class declares the kinds a file can place, and what all decorations of a kind share:

```js
static decorations = {
  Grass: { texture: ['grass1', 'grass2', 'grass3'], scale: { min: 0.2, max: 0.3 }, anchorY: 1, sway: true },
  Rock: { texture: 'rock', scale: 0.5 },
};
```

Each kind is a `Decoration.spawn` config, where `texture` may list several textures, `scale` sets both axes, and `scale`, `rotation`, `alpha` and `tint` may be ranges (`{ min, max }`). The file's `decorations` section holds, per kind, one array per value with one entry per decoration, not one object per decoration:

```json
"decorations": [
  {
    "class": "Grass",
    "x": [120, 136, 152],
    "y": [400, 400, 416],
    "frame": [0, 2, 1],
    "scale": [0.25, 0.3, 0.22]
  }
]
```

- `class`: a kind of the scene's `static decorations`, one record per kind.
- `x`, `y`: where each decoration is.
- Optional, as long as `x`: `frame` (which of the kind's textures, from 0), `scale`, `rotation` (radians), `alpha`, `tint`. An array left out takes the kind's value; a range the file has no values for is drawn per decoration with the scene's random numbers, so it changes from load to load.

The scene spawns each record with one `Decoration.spawnMany`, whose values may be arrays like these (`Decoration.spawnMany({ x: [10, 50], y: [40, 42], texture: 'rock' })`), and needs `config.decoration.maxDecorations` to hold them. A kind the scene does not declare, a texture the atlas lacks, or a full pool warns once, naming the file. In the editor, the palette's Decorations section paints them: choose a kind, drag to fill the brush's circle up to its density (Shift+drag erases); each stroke is one undo.

## Changing level

An entity cannot load a scene: its code runs on a logic worker, and `loadScene` on the page. In the platformer, the goal tells the scene, and the scene loads the level the goal names:

```js
// demos/platformerGameScene/gameObjects/goal.js
  static spawnParams = {
    next: { value: '', label: 'Next level', tip: 'The scene file to load, relative to this one' },
  // …
  onCollisionEnter(other) {
    if (GameObject.is(other, BluePlatformerPlayer)) this.emit('goalReached');
  }
```

```js
// demos/platformerGameScene/platformerGameScene.js
    this.on('goalReached', (_data, goalIndex) => this.goToNextLevel(goalIndex));
  // …
  goToNextLevel(goalIndex) {
    if (this.game.isTransitioning) return;
    const goal = this.sceneFile?.entities.find((e) => e.class === 'Goal' && this.getByName(e.name)?.index === goalIndex);
    const next = goal?.config?.next;
    if (!next) return;
    const levelsDone = (this.data?.levelsDone ?? 0) + 1;
    this.game.loadScene(new URL(next, this.sceneFileUrl).href, { data: { levelsDone } });
  }
```

`scene.sceneFile` is the running file as loaded, and `scene.sceneFileUrl` its address, so `next` is read relative to the level it is in. A second touch while the next level loads is ignored (`game.isTransitioning`).

### data: what goes from one level to the next

`loadScene(url, { data })` hands `data` to the next scene as `this.data`, and as the argument of `preload`, `create` and `createNewGame`. It carries what outlives a level: the score, the lives, the levels done. A save does not keep it (`scene.loadGame` passes the running scene's), so what a save needs goes in `onSaveGame()` ([SAVE_GAME.md](./SAVE_GAME.md#scene-state-outside-entities-onsavegame)).

### The fast swap

Loading a level of the scene class that is already running swaps its content and keeps the rest: the workers, the shared memory, the texture atlas and the physics WebAssembly stay, and only the entities and the scene's state change. A full load builds all of those again.

A load is full when a scene was running and one of these holds; the console says which: `[WeedJS] loadScene: full load (LiquidFun is on)`.

| A full load when | The console says |
| --- | --- |
| The level's scene class is another class | `BossScene is not the running PlatformerGameScene` |
| `config.manualStep` is on | `config.manualStep: tests step the frames` |
| LiquidFun is on | `LiquidFun is on` |
| A layer has textures or buffers for code to fill (`updateTexture`, `updateBuffer`) | `a layer takes texture or buffer uploads` |
| The scene changed a layer's scenery while it ran (`setStatic`, `setCover`, `setTiling`, `setTilemap`, `clear`) | `the scene is dirty: layer "ground" changed its scenery (setTilemap)` |

`loadScene(url, { fullLoad: true })` asks for a full load, and the console says nothing.

### What a level change clears

A swap and a full load start the next level from the same state:

- Every entity of every class despawns (`onDespawned` runs), and so do joints, tweens, chain points, bullets, particles, decorations, decals and grabs.
- The camera, the sun and the physics settings go back to the scene's config, `Time.scale` to 1. Sounds stop.
- The layers' alpha, visibility and shader uniforms go back to what they were when the scene started; shared resources are zeroed; the nav grid is walkable again.
- The scene's `on` listeners and the file's names are dropped; `create()` adds its listeners again.

A fast swap keeps what a full load makes again:

- **The scene object.** A field its constructor set keeps the value the last level left. Set per-level fields in `preload()` or `create()`.
- **The modules in every worker.** A full load starts new workers, which run your scene's module and the entities' modules again from the top; a fast swap keeps them running. A variable at the top of those modules (`let coinsTaken = 0;`), or a class's static field, is back at its first value in the workers after a full load and keeps the last level's value after a swap, so a level would play differently depending on how it was loaded. Keep game state in components, in `data`, or in fields `create()` sets. (The page runs each module once, so there such a variable always keeps its value: the page's own script, which the workers do not load, is a fine place for state that outlives levels.)
- **The pooled entity objects.** A plain field an entity set in one level is still on its object when the pool hands it out in the next, as with any spawn from a pool: `onSpawned` sets every field the entity reads.

## Saves and hot reload

- A save made in a level loaded from a scene file records the file. Loading the save loads that level (a fast swap when its class is running), and the restored entities keep their names ([SAVE_GAME.md](./SAVE_GAME.md#api)).
- With `hotReload: true` and `npm run dev`, saving the running level's file loads it again, with the same `data`: a fast swap when the scene can take one, so the change shows at once ([SAVE_GAME.md](./SAVE_GAME.md#hot-reload-debug)).

## Limits of format 1

- A fast swap needs the running scene's class. A level of another class loads fully.
- Colors are numbers: `0xffcc33` is `16763955` in a file.
- An entity param, and a joint, names an entity of the same file.
- A decoration's kind is one the scene class declares; its textures are in the scene's atlas.
