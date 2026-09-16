# Inventario de features del motor WeedJS

Documento de **esta campaña** (noche del 15 al 16 de septiembre de 2026). Dice qué es cada fila del catálogo, qué ya se midió contra su propio código, qué queda fuera de esta noche, y cómo se compara cada feature consigo misma. No es un claim de “WeedJS perfecta” ni de “más rápida que main”.

Catálogo máquina: [`tests/bench/engineFeatureCatalog.mjs`](../tests/bench/engineFeatureCatalog.mjs). Protocolo: [`HOW_WE_MEASURE.md`](./HOW_WE_MEASURE.md). Memoria de hipótesis: [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md). Diario de esta noche: [`CAMPANA_NOCHE_RESULTADOS.md`](./CAMPANA_NOCHE_RESULTADOS.md).

## Glosario

- **Fila del catálogo.** Un subsistema caliente (rayos, emisión, Box2D, etc.) con kernel Node opcional, escena que **ejecuta** el código, métricas primarias y claves de carga.
- **Campeón actual de una fila.** El código que hoy está en `src/` para esa feature, medido contra un candidato (por ejemplo `main` `0695a8d` más los contadores de carga, o un parche de esa misma feature). Cada fila es su propio torneo. Una fila WORSE no “rompe Box2D”; dice que **esa** primaria fue al menos 3% más cara en esa corrida, con carga comparable.
- **Mapa por fila, no campeón global.** “Mejor WeedJS” exigiría que **todas** las filas fueran KEPT o empate y ninguna WORSE/FAIL. El smoke de cinco filas ya vio box2d y visPoly peores en una corrida corta. El veredicto de producto es un mapa, no un sí/no único.
- **Kernel.** Microbench Node, ops/s o ms, sin Chromium.
- **Escena de estrés.** Chromium, a menudo sin ventana, 2 corridas × 8 s de calentamiento / 10 s de medida, para cribado.
- **Gameplay headed.** Chromium con ventana visible, 5 corridas × 25 s / 18 s. No minimizar. No dormir el equipo.
- **Primaria.** Worker `STEP_MS` (o ops/s del kernel). FPS a 60 Hz no cuenta.
- **Carga.** Medianas de `BODY_COUNT`, `ACTIVE_PARTICLES`, etc. dentro de ±5% y coeficiente de variación menor a 50%. Si Balls tiene `BODY_COUNT` 0, la fila falla (el motor ya publica el contador). Predator artístico no es fila: el combate estable es `steadyCombatScene`.
- **Keep de velocidad.** Primaria al menos 3% más barata (o kernel +3% ops/s) **y** carga OK.
- **Keep de higiene/bugfix.** Se queda salvo que una primaria empeore 3%.
- **Contadores de carga.** Se publican con estadísticas detalladas apagadas. Los sub-timers (`BOX2D_MS`, `VISIBILITY_MS`, …) siguen detrás de `collectDetailedStats`.
- **`--headed-only`.** Solo las ids listadas abren ventana y usan 5×25/18. El resto, aunque el catálogo diga headed, corre como estrés. No usar un scoreboard sin flags (abriría cómputo y zenithal) ni `--headless` global (apagaria Balls / visPoly / combate).
- **`runProductConfirm`.** Sigue anclado a Balls + Predator. **No** se usa esta noche.

### Nota Box2D: smoke versus confirm de cinco corridas

El smoke n=1 del scoreboard midió Balls `physics_STEP_MS` 8.168 → 8.705 ms (**+6.6%**) con `BODY_COUNT` 9004/9004. Eso **no anula** el confirm headed de cinco corridas en [`tests/results/product-confirm/report.md`](../tests/results/product-confirm/report.md): física 6.911 → 6.554 ms (**−5.2%**), mismos 9004 cuerpos. No se tocó el WASM de Box2D. Una corrida de 4 s se mueve varios por ciento por ruido de máquina. Esta noche el bloque C vuelve a medir Balls con cinco corridas.

### QueryAABB burst: descartada

`FEATURE_HYP_PROGRAM.md` llegó a decir que el burst estaba “shipped”. **No.** Aislamiento AABB: física **+835%** en `QueryAabbStressScene`. No reintroducir `servicePendingQueryBurst`. El log vive en [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md).

### Qué no se reabre esta noche

AABB, TICK, VP, PACT, LIGHT, BULLET, ECB, stack completo, espacial H1–H15 (salvo Verlet/stagger ya en main), set rechazado de LiquidFun (incluido H29 SIMD). No usar `pnpm bench:particle:tournament` como verdad.

---

## Cómo se mide cada fila contra su campeón

1. Baseline: git `0695a8d` más el parche de contadores de carga (misma visibilidad de stats, velocidad de ese rev).
2. Tratamiento: árbol de trabajo (keep HASH + P2 + P6 + higiene + colisión + contadores).
3. Misma máquina, misma sentada, snapshot/restore de `src/`.
4. Comando de producto de esta noche (no Predator):

```bash
pnpm bench:scoreboard --vs 0695a8d --only box2d,emit,steadyCombat --headed-only box2d,steadyCombat
pnpm bench:scoreboard --vs 0695a8d --headed-only box2d,visPoly,steadyCombat --skip-node
```

---

## Las 21 filas

### ray — Grid Ray DDA

Módulo: `src/core/ray.js`. Kernel: `rayMicrobench.mjs`. Escena: `RayStressScene`. Primarias: `logic0_RAYCAST_MS`, `logic0_STEP_MS`. Carga: `logic0_RAYCAST_COUNT`.

**Ya medido.** Campeón de main: H6 (stamp en lugar de `Set`) + H1 (early-out top-N). Otras hipótesis de rayo rechazadas en [`RAY_HYPOTHESES.md`](./RAY_HYPOTHESES.md). Esta noche: kernel + estrés 2×8/10. Sin hipótesis nuevas de DDA.

**Cómo medir contra el campeón.** Scoreboard fila `ray`. El keep de esta rama no toca el DDA; se espera empate salvo ruido.

### rayVsBox2d — Rayo WeedJS versus Box2D ocupado

Módulo: `src/core/ray.js` (más `box2dCastRayClosest`). Kernel: `rayVsBox2dMicrobench.mjs`. Escena: `RayVsBox2dWeedBusyScene`. Primarias: `logic0_RAYCAST_MS`, `physics_STEP_MS`. Carga: `BODY_COUNT`.

**Ya medido** el contraste idle/busy (el DDA de lógica no debería subir cuando física satura; el rayo sync de Box2D sí). Esta noche: kernel + estrés. Sin hipótesis nuevas.

### decals — Sello de decales

Módulo: `src/util/decalStamp.js`. Kernel: `decalMicrobench.mjs`. Escena: `DecalStampStressScene`. Primaria: `particle_STEP_MS`. Carga: `PARTICLES_STAMPED`.

**Ya medido.** Campeón D2 (UV DDA) en main. D1/D3–D6 rechazadas. Esta noche: kernel + estrés. No reabrir el torneo histórico.

### emit — Emisión de partículas

Módulo: `src/core/particleEmitter.js`. Kernel: `particleEmitMicrobench.mjs`. Escena: `ParticleEmitStressScene`. Primaria: `particle_STEP_MS`. Carga: `ACTIVE_PARTICLES`.

**Ya medido.** En main: P4+P5. En esta rama, aislados: P2 (lista de campos, keep, kernel +7.2%) y P6 (pop de free-list, keep de **kernel** ~+27%, no venderlo como win de Predator). Smoke scoreboard: emit KEPT, kernel +23.4%, `particle_STEP_MS` −9.6%, carga OK. Bloque C de esta noche: kernel de emisión otra vez, n de producto no smoke.

**Cómo medir.** Fila `emit` en el scoreboard. P6 sigue siendo claim de kernel si el gameplay de partículas no cruza 3%.

### integrate — Integración de partículas

Módulo: `src/util/particleIntegrate.js`. Kernel: `particleIntegrateMicrobench.mjs`. Escena: `ParticleIntegrateStressScene`. Primaria: `particle_STEP_MS`. Carga: `ACTIVE_PARTICLES`.

**Ya medido** P4+P5 en main. PACT (expectedActive) **descartado** (carga +86%). Esta noche: kernel + estrés. Sin PACT.

### spatial — Vecinos espaciales

Módulo: `src/workers/spatialWorker.js`. Kernel: `spatialMicrobench.mjs`. Escena: `StationarySpatialScene`. Primaria: `spatialMax_STEP_MS`. Carga: `BODY_COUNT`, `NEIGHBORS_REUSED`.

**Ya medido.** En main: Verlet H3 + stagger. H1–H15 (salvo lo shipped) **descartadas**. En esta rama: HASH (quitar hash de dependencias) keep aislado, Predator spatial-max **−10.2%**. Smoke: spatial KEPT, `spatialMax_STEP_MS` −8.3%. Esta noche: kernel + estrés; el headed serio del keep es combate estable, no Predator.

### box2d — Paso de Box2D

Módulo: `src/box2d/weedjsPost.js`. Sin kernel Node (WASM). Escena: `BallsScene`, gameplay headed. Primaria: `physics_STEP_MS`. Carga: `BODY_COUNT`, `AWAKE_COUNT`.

**Ya medido.** Confirm 5 corridas: física −5.2%, 9004 cuerpos. Smoke n=1: WORSE +6.6% — ver nota arriba. El keep no cambia el WASM; higiene de `writePhysicsStats` en el `doStep` magro. Esta noche: headed 5×25/18 en el bloque C.

### liquidfun — Paso de partículas LiquidFun

Módulo: `src/box2d/weedjsPost.js` (WASM). Kernel: `liquidFunPassProfileMicrobench.mjs` (menos ms es mejor). Escena: `LiquidFunStressScene`. Primaria: `physics_STEP_MS`. Carga: `BODY_COUNT`.

**Ya medido** el set shipped y el rechazado (H29 SIMD +1.6% kernel, no retry). Fase C en C es otra noche. Esta noche: kernel (lento) + estrés 2×8/10. Sin headed.

### liquidfunCouple — Acoplamiento cuerpo–fluido

Módulo: `src/box2d/weedjsPost.js`. Kernel: `liquidFunBodyCoupleMicrobench.mjs`. Escena: `LiquidFunBodyCoupleStressScene`. Primaria: `physics_STEP_MS`. Carga: `BODY_COUNT`.

**Ya medido** H26 (reusar OverlapAABB entre sub-steps) shipped; H24/H25/H27/H28 rechazados. Esta noche: kernel + estrés.

### liquidfunQuery — Consultas LiquidFun

Módulo: `src/box2d/liquidFunQuery.js`. Sin kernel de ops. Escena: `LiquidFunQueryStressScene`. Primarias: `physics_STEP_MS`, `logic0_STEP_MS`. Carga: `BODY_COUNT`.

**Ya medido** el protocolo SAB. Esta noche: estrés. El burst de QueryAABB de **cuerpos** no aplica aquí.

### queryAabb — QueryAABB de Box2D (cuerpos)

Módulo: `src/box2d/box2dQueryAabb.js`. Escena: `QueryAabbStressScene`. Primaria: `physics_STEP_MS`. Carga: `BODY_COUNT`.

**Ya medido.** Burst **descartado** (+835%). Esta noche: estrés del camino uno-a-uno actual, no reintroducir burst.

### nav — NavGrid

Módulo: `src/core/navGrid.js`. Kernel: `navGridMicrobench.mjs`. Escena: `NavStressScene`. Primaria: `logic0_STEP_MS`. Carga: `ENTITIES_PROCESSED`.

**Hueco.** Hay kernel Dijkstra y escena de estrés; no hubo torneo serio de hipótesis nuevas en esta rama. TICK (cache de `tickFn`) **descartado** en Balls (+27%) — no reabrir. Esta noche: kernel + estrés en el tablero. El kernel del catálogo **copia** Dijkstra y no ve `src/`. Hipótesis N1 (`| 0` en cellY): TIE −1.5%, no mergeada. N2 (local `gridHeight` en `computeFlowfield`): KEPT −5.3% partículas en n=2, mergeada. No es un claim versus `0695a8d`.

### visPoly — Polígonos de visibilidad

Módulo: `src/render/visibility/angularSweep.js`. Kernel: `angularSweepMicrobench.mjs`. Escena: `VisPolyStressScene` (`raycasted: true`). Primarias: `preRender_STEP_MS`, `VISIBILITY_MS`. Carga: `BODY_COUNT`.

**Ya medido (cache VP).** VP **descartado** (`VISIBILITY_MS` +10.8%). Predator default deja `raycasted` apagado; por eso existe esta escena. Smoke n=1: WORSE (kernel −7.2%, pre-render +5.8%). Esta noche: headed 5×25/18. Si `VISIBILITY_MS` sale 0 (stats detalladas off), se juzga `preRender_STEP_MS`; reintento con stats detalladas solo si hay margen.

### tilemap — Consultas TileMap

Módulo: `src/core/tileMap.js`. Kernel: `tileMapMicrobench.mjs`. Escena **nueva**: `TilemapStressScene` (semilla fija, 64 entidades × 64 `getTileId` por tick). Primaria: `logic0_STEP_MS`. Carga: `ENTITIES_PROCESSED`.

**Hueco de escena** hasta esta noche (antes solo kernel). Sin hipótesis nuevas de tilemap más allá de enganchar la escena. Cómo medir: fila `tilemap` del scoreboard.

### queryPublish — Publicación QuerySystem

Módulo: `src/core/querySystem.js`. Kernel: `querySystemMicrobench.mjs`. Escena: `QueryChurnScene`. Primaria: `logic0_STEP_MS`. Carga: `ENTITIES_PROCESSED`.

Skip-publish si las listas no cambian ya está en logic0. `QUERY_PUBLISH_MS` solo con stats detalladas. Esta noche: kernel + estrés. Sin escena `queryCircle` a tasa fija.

### preRender — Cull y cola de pre-render

Módulo: `src/workers/preRenderWorker.js`. Kernel: `srFlagsMicrobench.mjs`. Escena: `RenderQueueStressScene`. Primaria: `preRender_STEP_MS`. Carga: `BODY_COUNT`.

Packed vs 7 columnas Uint8 ya se midió (cull gana en kernel; cola ruidosa). Esta noche: kernel + estrés. Sin hipótesis nuevas de cola.

### compute — Pack WebGPU

Módulo: `src/render/webgpu/computeLayer.js`. Kernel: `computePackMicrobench.mjs`. Escena: `ComputeStressScene` (el catálogo marca headed). Primaria: `pixi_STEP_MS`. Carga: `BODY_COUNT`.

Esta noche: kernel sí; escena **como estrés** (`--headed-only` no incluye `compute`). Arranque de GPU y carga dudosa. Headed 5×25/18 queda para otra noche.

### decorations — Espacial de decoraciones

Módulo: `src/core/decorationSpatial.js`. Kernel: `decorationSpatialMicrobench.mjs`. Escena: `ZenithalParticleTestScene` (catálogo headed). Primaria: `pixi_STEP_MS`. Carga: `BODY_COUNT`.

Esta noche: kernel sí; zenithal **como estrés**, no cinco corridas headed. Sin escena `queryCircle` a tasa fija.

### bullets — Tick de balas

Módulo: `src/util/bulletTick.js`. Kernel: `bulletTickMicrobench.mjs` (`cases.tickCrowded.opsPerSec`; también reporta `tickOpen` / hypot). Escena: `BulletStressScene` (pool 2048, paredes, spawn fijo). Primaria: `particle_STEP_MS`. Carga: `ACTIVE_BULLETS`.

Lista compacta de balas **descartada** (+1.9%). No reabrir. Speed cache al spawn: `len = speed * dt` + exclude escalar.

### spawn — Tormenta Treiber / spawn

Módulo: `src/util/atomicFreeList.js`. Kernel: `treiberMicrobench.mjs`. Escena: `SpawnStormScene`. Primaria: `logic0_STEP_MS`. Carga: `ENTITIES_PROCESSED`.

ECB (batch spawn/despawn) **descartado** (−2.8%). Esta noche: kernel + estrés.

### steadyCombat — Carga de combate estable

Módulo: `src/workers/particleWorker.js` (la fila es de carga, no de un algoritmo único). Sin kernel. Escena: `SteadyCombatScene` (semilla, emit constante). Primarias: `particle_STEP_MS`, `spatialMax_STEP_MS`, `logic0_STEP_MS`. Carga: `BODY_COUNT`, `ACTIVE_PARTICLES`.

Sustituye a Predator emergente para el scoreboard. Smoke: KEPT (partículas −17.8%, logic0 −19.4%, carga OK, n=1). Product confirm con Predator **no cerró** `ACTIVE_PARTICLES` (+8.8%, cv ~75–80%). Esta noche: headed 5×25/18 en el bloque C. Si no cierra carga, FAIL, no se inventa el delta.

---

## Paquete keep de esta rama

HASH + P2 + P6 + higiene (`debugLog`) + colisión (par key) + contadores de carga siempre encendidos + Nav N2. **No** PACT, LIGHT, AABB burst, TICK, VP, BULLET compact, ECB — stripped del árbol 2026-09-16 (antes el log mentía “reverted”).

Se mide **como paquete**, no cinco isolations headed. Remedida post-strip: emit/box2d KEPT; steadyCombat WORSE (spatial +3.5%). No se afirma producto más rápido que main.

## Fuera de estas 10–11 horas

Isolations HASH/P2/P6 con cinco corridas cada uno. Hipótesis nuevas en visibilidad, decoraciones, consultas, cola, tilemap más allá de la escena. Zenithal y WebGPU headed. Fase C LiquidFun en C. Firefox, móvil, CI headed. Bisecar el keep.
