6.2.26:












Create a `MEMORY_MODEL.md` or a centralized comment block in Scene.js documenting the ownership table.




There is zero TypeScript, JSDoc `@typedef`, or runtime validation on component array access. Accessing `Transform.x[entityId]` with an invalid `entityId` silently returns `undefined`, which becomes `NaN` and propagates through the entire physics system (hence all the defensive NaN checks in the Verlet integrator).











4. CORRECTNESS & ROBUSTNESS
4.1 — this.rowsPerBlock vs Local rowsPerBlock
In rebuildOwnedRows, the row ownership check uses this.rowsPerBlock:
spatial_worker.js
Lines 414-414
        const blockIndex = (row / this.rowsPerBlock) | 0;
But all other instance variables are hoisted to local consts at the top of the method (e.g., const gridWidth = this.gridWidth;). this.rowsPerBlock is accessed through this in a hot inner loop, which means the JIT must dereference the receiver object each iteration instead of using a register-cached local. This is inconsistent with the pattern used for everything else.
4.2 — entityPosX/Y Shared Buffer Written by Multiple Workers
spatial_worker.js
Lines 382-383
      entityPosX[i] = posX;      entityPosY[i] = posY;
All spatial workers compute and write the same position to the same shared buffer indices. This is functionally correct (idempotent write of the same value), but it creates false sharing on the CPU cache. When worker A writes entityPosX[42] and worker B writes entityPosX[43], if both are in the same 64-byte cache line, the cache line bounces between cores. With Float32 (4 bytes), 16 entities share a cache line. This could cause significant cache-line ping-pong with multiple spatial workers.
4.3 — maxCol Shadow in findNeighborsForOwnedEntities
spatial_worker.js
Lines 592-593
          let homeCol = (myX * invCellSize) | 0;          const maxCol = gridWidth - 1;
maxCol is declared as a const inside the innermost loop body, shadowing any potential outer maxCol. This is fine functionally, but it's recomputed (gridWidth - 1) for every entity. Should be hoisted outside the loop.
5. DEV EXPERIENCE


5.2 — Stats Counter Overhead
spatial_worker.js
Lines 541-541
          this.entitiesProcessedThisFrame++;
spatial_worker.js
Lines 633-633
              this.cellsCheckedThisFrame++;
spatial_worker.js
Lines 676-676
                      this.neighborsFoundThisFrame++;
These this.X++ increments go through property access in the innermost loops. Unlike the position buffers which are hoisted to locals, these counters are accessed via this every iteration. Should be hoisted to local variables and written back once after the loop.
5.3 — Grid.cellByteSize Accessed via Static Property in Hot Loop
spatial_worker.js
Lines 628-628
              const checkByteOffset = checkCellIndex * Grid.cellByteSize;
Grid.cellByteSize is a static property. In a hot inner loop, V8 must resolve Grid (a class reference) → look up cellByteSize (a static property on the class constructor object). This is accessed multiple times per entity per cell. The outer function hoists Grid._gridCounts and Grid._gridEntities to locals, but Grid.cellByteSize is not hoisted.
Same issue at line 512-513 in the outer loop. Should be: const cellByteSize = Grid.cellByteSize; at the top of the function.
6


--
Let me examine some key dependencies to fully understand the logic worker's hot paths.

[13 tools called]

Now I have the full picture. Here's my thorough analysis:

---

# Engineering Analysis: `logic_worker.js`

## 1. GC PRESSURE & OBJECT ALLOCATION





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



Segun la direccion de la velocidad ponerle un offset al pattern del spatial worker


re computar entidades activas en spawn y despawn!


decorations con container!


4.testear EntityClass.tickAll vs instance.tick()
6-re ver todos los momentos q se usa postMessage
7-poolsize variable, automatico.. no tener limite para la cantidad de gameobjects de tipo tal
8-const { x, y } = Transform.getValues();










--------------

-en el map maker, exportar por layers

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







----------------------------
--- GAME OBJECT
----------------------------

* cuando spawneamos cosas q no sea colisionando con otras