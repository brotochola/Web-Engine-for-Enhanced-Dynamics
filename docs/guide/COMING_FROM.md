# Coming from Unity, Godot or Phaser

WeedJS uses ideas you already know (entities, components, scenes, physics callbacks), but it runs your game on several threads at once. That one difference explains most of what looks unfamiliar. This page shows where your code runs, then maps the names you know to the WeedJS ones. To start a project, run `npm create weed-game my-game`. For a first game, see [FIRST_GAME.md](./FIRST_GAME.md).

## Where your code runs

| Thread | What runs there | Your code |
| --- | --- | --- |
| Main thread (the page) | The `Scene` class, the DOM, input listeners | `preload`, `create`, `createNewGame`, `update`, `scene.on(…)`, the HTML HUD |
| Logic workers (1…N) | Every entity's `tick` and callbacks | your `GameObject` subclasses |
| Physics worker | Box2D (WebAssembly) | none; you push bodies with forces and impulses |
| Spatial, particle, pre-render, render workers | Neighbors, particles, sprite queues, drawing | none |

What follows from that:

- **State lives in components, not in plain fields.** A `GameObject` has a copy on each logic worker, so `this.hp = 3` is not shared between them and a save does not keep it. Declare the data on a component (`static ARRAY_SCHEMA = { hp: Float32Array }`) and use `this.health.hp`, or `Health.hp[index]` for another entity. That memory is shared by every thread, and saves keep it.
- **Entities are referred to by index.** Collision callbacks and messages give you a number. Ask about it with `GameObject.is(other, Enemy)` and `GameObject.hasComponent(other, Shield)`, and read its data from component arrays (`Transform.x[other]`). An index is reused once its entity despawns, so do not keep one across frames as if it were the same entity.
- **Entities cannot touch the page.** Use `this.emit('died', data)` and `scene.on('died', fn)`.
- **The workers load your scene file too.** It reads the engine from the global `WEED` (`const { Scene, GameObject } = WEED;`) instead of importing it. Put page-only code (the DOM, starting the engine) in the page or in scene methods, not at the top of the file.
- **Pools are fixed.** `static entities = [[Enemy, 500]]` reserves 500 enemies up front, and spawning takes one from the pool. Spawning into a full pool returns `null`, and warns once.

## The same things, by name

| You want | Unity | Godot | Phaser | WeedJS |
| --- | --- | --- | --- | --- |
| A game object | `GameObject` + `MonoBehaviour` | `Node2D` script | `Sprite` / custom class | `class Enemy extends GameObject` with `static components = […]` |
| A prefab | Prefab | `PackedScene` | a config object | the class itself, plus a spawn config |
| Create one | `Instantiate` | `instance()` + `add_child` | `this.add.sprite` | `Enemy.spawn({ x, y })`, the same call in the scene and in entities |
| Destroy it | `Destroy` | `queue_free` | `destroy()` | `this.despawn()`; another one: `Enemy.despawn(index)` |
| Per-object data | fields, `[SerializeField]` | `@export var` | properties | component fields: `static ARRAY_SCHEMA = { hp: Float32Array }`, then `this.health.hp` |
| Get a component | `GetComponent<T>()` | `get_node` | — | `this.rigidBody`, `this.health` (camelCase class name) |
| Does it have one? | `TryGetComponent` | `has_node` | — | `this.hasComponent(Shield)`, `GameObject.hasComponent(other, Shield)` |
| What is that object? | `CompareTag`, `is` | `is_in_group`, `is` | `instanceof` | `this.is(Coin)`, `GameObject.is(other, Coin)` (subclasses count) |
| Setup | `Awake` / `Start` | `_ready` | `create` | `onSpawned(spawnConfig)`, on every spawn from the pool |
| Every frame | `Update` | `_process` | `update` | `tick(dtRatio, deltaTime)` |
| Physics step | `FixedUpdate` | `_physics_process` | — | Box2D steps on its own thread. A force applied in `tick` holds until the next `tick` |
| Collision | `OnCollisionEnter2D` | `body_entered` | collide callback | `onCollisionEnter(otherIndex)`; the class lists `CollisionListener` |
| Trigger / sensor | `OnTriggerEnter2D` | `Area2D.body_entered` | overlap | `Collider.isTrigger = 1`, then the same `onCollisionEnter` |
| Collision layers | layers + matrix | layers / masks | categories | `collisionLayer`, `collisionMask`, `collisionGroupIndex` |
| Push a body | `AddForce(…, ForceMode.X)` | `apply_central_force` / `apply_impulse` | `applyForce` | `addAcceleration`, `applyForce`, `addVelocity`, `applyImpulse` ([PHYSICS.md](./PHYSICS.md#moving-bodies)) |
| Set velocity | `rb.velocity =` | `linear_velocity =` | `setVelocity` | `this.setVelocity(vx, vy)` |
| Raycast | `Physics2D.Raycast` | `RayCast2D` / `intersect_ray` | — | `Box2d.castRayClosest` (bodies), `Ray.cast` / `Ray.castWithInfo` (spatial grid) |
| Area query | `OverlapCircle` | `intersect_shape` | `overlapCirc` | `Box2d.overlapCircle`, `Box2d.queryAABB` |
| Neighbors | — | — | — | `this.neighborCount`, `this.getNeighbor(i)` (precomputed by the spatial workers) |
| Messages between objects | `SendMessage`, events | signals | events | `this.sendTo(other, 'hit', 10)` → `onMessage(name, from, a, b, c, d)`; names in the scene's `static messages` |
| Tell the UI | events | signals | events | `this.emit('died', data)` → `scene.on('died', fn)` |
| Delays and timers | coroutines, `Invoke` | `Timer`, `await` | `time.delayedCall` | `Tween.to(…, { delay, onComplete: 'name' })`, or a counter in a component field |
| Tweens | DOTween | `Tween` | `this.tweens.add` | `Tween.to(index, props, ms, ease, { delay, repeat, yoyo, onComplete })` |
| Sprite animation | Animator | `AnimationPlayer` | `anims.play` | `setSpritesheet('hero')`, `setAnimation('run', loop)`, `setAnimationSpeed(0.25)`, `onAnimationEnd(name)` |
| Flip | `flipX` | `flip_h` | `setFlipX` | `this.flipX = true`, `this.setFlip(x, y)` |
| Size | `transform.localScale` | `scale` | `setDisplaySize` | `this.setDisplaySize(w, h)`, `this.setScale(sx, sy)`; `this.collider.fitToSprite()` |
| Load a level | `SceneManager.LoadScene` | `change_scene_to` | `this.scene.start(key, data)` | `game.loadScene(url, { data })`; the scene gets `create(data)` |
| Keep data across levels | `DontDestroyOnLoad` | autoload | registry | `loadScene(url, { data })`, or plain JS module state on the main thread |
| Save the game | your serializer | `ConfigFile` | `localStorage` | `static serializable = true` + `scene.saveGame(slot)`; scene state in `onSaveGame()` ([SAVE_GAME.md](./SAVE_GAME.md)) |
| Slow motion / pause | `Time.timeScale` | `Engine.time_scale` | `timeScale` | `Time.scale = 0.25`; `game.pause()` freezes everything |
| Input | `Input.GetKey` | `Input.is_key_pressed` | `keyboard` | `Keyboard.isDown('w')`, `Keyboard.isPressed`, `Mouse`, `Gamepad` (work in every worker) |
| Camera | Cinemachine | `Camera2D` | `cameras.main` | `Camera.follow` / `followEntity`, `setDeadzone`, `shake`, `setZoom` |
| UI / text | Canvas, TMP | `Control`, `Label` | `add.text` | HTML elements over the canvas |
| Log | `Debug.Log` | `print` | `console.log` | `console.log`: it works in workers too |
| Errors | Console | Debugger | console | The worker keeps running. The error is printed once with the entity's class, index and the hook that threw. Debug builds list errors in a corner panel |

## Things that surprise people

- **Tag components gate callbacks.** `onCollisionEnter` runs only for classes that list `CollisionListener` (`onScreenEnter` needs `CameraInOutListener`, `onJointBreak` needs `JointBreakListener`). The scene warns at load when a hook has no tag.
- **An empty `tick() {}` still counts.** The logic worker visits every entity of the type each frame. Leave `tick` out of entities that do nothing per frame.
- **Animation speed is frames per 1/60 s.** A spawn plays at `0.2` (12 fps); `setAnimationSpeed(fps / 60)` changes it, and `0` holds the current frame.
- **Animations advance while drawn.** An off-screen animation waits, and so does its `onAnimationEnd`.
- **Forces hold until the next `tick`.** `addAcceleration` and `applyForce` are for pushes that last; a jump or a hit is `addVelocity` or `applyImpulse`, applied once.
- **Units are pixels and seconds.** Velocity is px/s, acceleration px/s². Mass comes from the collider area unless you set `this.rigidBody.mass`.
- **The page needs two headers** for `SharedArrayBuffer`. `npm run dev` sends them; for hosting see [DEPLOY.md](./DEPLOY.md).
