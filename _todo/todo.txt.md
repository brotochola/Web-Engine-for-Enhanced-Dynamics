-animatedSpriteRenderer
-SpriteRenderer
-bg por layer
-particulas y decorations en layer

-collision filter o mask (q no todo colisione con todo)

-particleEmitter.emitIsometric()
-particleEmitter.emit2d()

-TileMap.getTex(x,y)

-LightEmitter (llamarlo PointLight2d)

-cameraInOutListener
-collisionListener
-CircleCollider
-RectCollider
-RectanguloqueGiraCoillider

---

---

## -- spritesheet registry ---

---

---

JSDoc `@typedef`,

---

-decorations con container!

-limitar aceleration en GameObject, en addAcceleration (asi lo hace el logic y no el physics)

4.testear EntityClass.tickAll vs instance.tick()

7-poolsize variable, automatico.. no tener limite para la cantidad de gameobjects de tipo tal

8-const { x, y } = Transform.getValues();

---

-map maker: agregar pasto y faroles, y autos, y tachos de basura

- flowfield en caminos

---

## Lighting:

---

## Debugger:

-clase Debug con cosas tipo:
Debug.highlightCell(cellID)
Debug.drawText(entity.x, entity.y, fsm.state)

---

## QUERY SYSTEM:

---

## FSM

---

## GAME ENGINE:

- TWEENS - GSAP

-VEC2, VEC3

-generar mas chaboncitos

---

      GAME OBJECTS:

---

-getAllPropertiesFromAllComponents(): para asi poder clonar
-this.constructor.spawnCloneFromInstance(this)
-this.constructor.spawnCloneFromEntity(this.index)

-Tener un Prey.tickAll, en lugar de this.tick() ?
TENER AMBOS! y se puede desde tickall llamar a sistemas, q tmb son metodos estaticos.

---

    --- SCENES ----

---

-eventEmitter
-tags: se crean los tags, se le pone uno o mas tags a las entidades,

---

## -- sonido ---

---

## --- SPATIAL WORKER: ---

---

## --- NAV WORKER: ---

---

## --- LOGIC WORKERs: ---

---

## --- PHYSICS WORKER: ---

---

## --- PIXI-WORKER: ---

---

## ---- Particle Worker

bouncing/sliding !

---

## --- GAME OBJECT

- cuando spawneamos cosas q no sea colisionando con otras
