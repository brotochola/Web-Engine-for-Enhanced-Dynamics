
------------------------------
IDEAS PARA JUEGOS:
-auto visto desde arriba, o topdown, formado por circulos con contraints, muchos autos, mucha gente


------------------------------






- no strings!, all constants


 JSDoc `@typedef`,







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




---------------------------------
-- sonido ---
----------------------------

- howler.js





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

Distance Constraints - Final Summary
Class: Constraint extends SharedAtomicPool
SAB Arrays:
Array	Type	Content
pairs	Uint32	(entityA << 16) \| entityB
restLength	Float32	Target distance
stiffness	Float32	0-1 strength
active	Uint8	Alive flag
API:
Constraint.add(a, b, dist, stiff) → idxConstraint.remove(idx)
Solving: Physics worker, position-based, in substep loop.
Thread-safe: Atomic free list from SharedAtomicPool.



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