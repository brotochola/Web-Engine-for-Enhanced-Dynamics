












Create a `MEMORY_MODEL.md` or a centralized comment block in Scene.js documenting the ownership table.

 JSDoc `@typedef`,







### 2.6 — Tick Decimation Has Overhead Even When Not Used

```332:344:src/workers/logic_worker.js
          let tickInterval = 1;
          if (GameObject.nextTick) {
            tickInterval = obj.constructor.tickInterval || 1;
            if (tickInterval > 1) {
              if (--GameObject.nextTick[entityIndex] > 0) {
                this.checkScreenVisibility(entityIndex, obj);
                continue;
              }
              GameObject.nextTick[entityIndex] = tickInterval;
            }
          }
```

For entities with `tickInterval = 1` (the default — most entities), the code still:
1. Checks `if (GameObject.nextTick)` — true if any entity uses tick decimation
2. Reads `obj.constructor.tickInterval` — prototype chain lookup
3. Checks `if (tickInterval > 1)` — false, falls through

That's 3 checks per entity per frame just to discover "no decimation." For thousands of entities, this adds up.

**Better:** Separate entities into two lists at initialization time — decimated and non-decimated. Process them with separate loops. Or store the tickInterval in a typed array indexed by entityIndex to avoid the prototype chain lookup.

---

## 3. CACHE LOCALITY & DATA ACCESS





### 3.3 — `checkScreenVisibility` Called for Every Entity

```360:360:src/workers/logic_worker.js
          this.checkScreenVisibility(entityIndex, obj);
```

Also called for decimated entities that skip tick (line 338). This function:
1. Reads `SpriteRenderer.isItOnScreen[entityIndex]` — typed array access (cheap)
2. Reads `this.previousScreenVisibility[entityIndex]` — typed array access (cheap)
3. Compares them for transition detection
4. Writes `this.previousScreenVisibility[entityIndex]` — typed array write

The function call overhead (`checkScreenVisibility` as a method) is probably the most expensive part. V8 should inline this if the function is monomorphic and hot, but inlining into the hot loop directly would guarantee it.

---



-----------------


- lo de line of sight y ray.cast es re poco optimo, al menos
no deberiamos hacerlo todo el tiepmo en los soldados





-decorations con container!
-constraints en el physics
-limitar aceleration en GameObject, en addAcceleration (asi lo hace el logic y no el physics)


4.testear EntityClass.tickAll vs instance.tick()
6-re ver todos los momentos q se usa postMessage
7-poolsize variable, automatico.. no tener limite para la cantidad de gameobjects de tipo tal
8-const { x, y } = Transform.getValues();


GameObject.spawn (deberia juntar y mandar en batch, en lugar de mandar mensajes uno por uno)







--------------


-map maker: agregar pasto y faroles, y autos, y tachos de basura
-en el autotiler agarrar por layer




-------------
Lighting:
----------------------


al computar sombras: tomar en cuenta la pos del shadowcaster, no de la luz



--------
Debugger:
---------

-clase Debug con cosas tipo:
	Debug.highlightCell(cellID)
	Debug.drawText(entity.x, entity.y, fsm.state)



-------------------
QUERY SYSTEM:
--------------------



-----
FSM
------






---------------------
 GAME ENGINE:
-----------------------




- TWEENS - GSAP

-VEC2, VEC3



-generar mas chaboncitos






------------------------------------------------------------------------------------------------
      GAME OBJECTS:
------------------------------------------------------------------------------------------------


-no usar this.propiedadComunDeOOP=1.. estos valores pueden cambiar entre workers, si hay mas de un
logic_worker..


-getAllPropertiesFromAllComponents(): para asi poder clonar
-this.constructor.spawnCloneFromInstance(this)
-this.constructor.spawnCloneFromEntity(this.index)




-Tener un Prey.tickAll, en lugar de this.tick() ?
TENER AMBOS! y se puede desde tickall llamar a sistemas, q tmb son metodos estaticos.














-------------------------------------------------------------------------------------------------
    --- SCENES ----
------------------------------------------------------------------------------------------------

-eventEmitter
-tags: se crean los tags, se le pone uno o mas tags a las entidades,










------------------------------------------------------------------------------------------------
--- SPATIAL WORKER: ---
------------------------------------------------------------------------------------------------

-q vuelva a escribir distSq

------------------------------------------------------------------------------------------------
--- NAV WORKER: ---
------------------------------------------------------------------------------------------------







------------------------------------------------------------------------------------------------
--- LOGIC WORKERs: ---
------------------------------------------------------------------------------------------------




------------------------------------------------------------------------------------------------
--- PHYSICS WORKER: ---
------------------------------------------------------------------------------------------------





------------------------------------------------------------------------------------------------
--- PIXI-WORKER: ---
------------------------------------------------------------------------------------------------







------------------------------------
---- Particle Worker
------------------------------------


bouncing/sliding !



----------------------------
--- GAME OBJECT
----------------------------

* cuando spawneamos cosas q no sea colisionando con otras