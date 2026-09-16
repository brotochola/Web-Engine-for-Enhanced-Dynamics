# Diario de la campaña de una noche

Noche del 15 al 16 de septiembre de 2026. Objetivo: 10 horas, colchón 11. Árbol keep (HASH + P2 + P6 + higiene + colisión + contadores) versus `main` `0695a8d` más los mismos contadores de carga.

Este archivo es el diario **humano** de esta noche. El runner escribe [`tests/results/scoreboard/report.md`](../tests/results/scoreboard/report.md). El índice de hipótesis es [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md). El mapa de features es [`INVENTARIO_FEATURES.md`](./INVENTARIO_FEATURES.md).

Protocolo: primaria = `STEP_MS` (o ops/s del kernel). Keep de velocidad si la primaria es al menos 3% más barata y la carga queda en ±5% con cv menor a 50%. FPS a 60 Hz no cuenta. Predator artístico no entra. No se afirma “WeedJS perfecta”.

## Reloj

Arranque: 15 de septiembre de 2026, ~21:25 hora de Argentina.

Comandos previstos:

```bash
pnpm bench:scoreboard --vs 0695a8d --only box2d,emit,steadyCombat --headed-only box2d,steadyCombat
pnpm bench:scoreboard --vs 0695a8d --headed-only box2d,visPoly,steadyCombat --skip-node
```

Máquina: Chromium headed visible, sin suspender, sin minimizar esas ventanas.

---

## Bloque 0 — Flag `--headed-only`

**Qué se hizo.** En [`tests/bench/measureLib.mjs`](../tests/bench/measureLib.mjs): `sceneWantsHeaded`, `--headed-only id,id`. `--headless` sigue ganando. En [`tests/bench/runScoreboard.mjs`](../tests/bench/runScoreboard.mjs) la cache de escena usa el headed **efectivo** (`scene.key|0|smoke` o `scene.key|1|smoke`), no `scene.headed` del catálogo. Tests en `workloadCountsAlways.test.js`.

**Setup.** Sin bench de producto todavía.

**Números.** No aplica.

**Veredicto.** El runner ya no abre compute ni zenithal si se pasa `--headed-only box2d,visPoly,steadyCombat`.

## Bloque A — Inventario

**Qué se hizo.** [`docs/INVENTARIO_FEATURES.md`](./INVENTARIO_FEATURES.md): glosario, mapa de las 21 filas, nota box2d smoke vs confirm, QueryAABB burst descartada. Punteros en HOW_WE_MEASURE, FEATURE_BENCHMARKS, docs/README. Corrección en FEATURE_HYP_PROGRAM (burst no shipped).

**Setup.** Solo documentación.

**Números.** No aplica.

**Veredicto.** Expectativa de producto: mapa por fila, no campeón global.

**Siguiente.** Tilemap.

## Bloque B — Tilemap medible

**Qué se hizo.** [`tests/bench/stressScenes/tilemapStressScene.js`](../tests/bench/stressScenes/tilemapStressScene.js): semilla `0x711e`, 64 queriers × 64 `getTileId` por tick, mapa 64×64. Catálogo: `scene` + `primary: logic0_STEP_MS` + `load: ENTITIES_PROCESSED`.

**Setup.** Tests Node: `engineFeatureCatalog.test.js` y `--headed-only` en `workloadCountsAlways.test.js`.

**Números.** `pnpm test:node`: 437 pass, 0 fail (incluye `tilemap has a seeded stress scene` y `--headed-only forces headed only`).

**Veredicto.** La fila tilemap ya no es NA por falta de escena. Aún no hay números de estrés vs `0695a8d` (van en el bloque D).

**Siguiente.** Bloque C, keep como paquete.

## Bloque C — Keep como paquete (cerrado)

**Qué se hizo.** No Predator. No `runProductConfirm`.

```bash
pnpm bench:scoreboard --vs 0695a8d --only box2d,emit,steadyCombat --headed-only box2d,steadyCombat
```

Copia durable: [`tests/results/scoreboard/keep-bundle/report.md`](../tests/results/scoreboard/keep-bundle/report.md) (el tablero D va a reescribir `report.md`).

**Setup.** `test:node` 437/437. Lockstep visual **falló**: `spawn timeout: 0 need 9004` en Balls (0 cuerpos). El runner siguió las filas de velocidad. Headed 5 × 25000/18000 ms en Balls y combate estable. Emit estrés 2 × 8 s / 10 s. Baseline `0695a8d` + contadores. `src/` restaurado (git status de `src/` limpio).

**Números.**

- **emit KEPT.** Kernel 7073 → 7966 ops/s (**+12.6%**). `particle_STEP_MS` 0.277 → 0.273 ms (−1.2%, empate de escena). `ACTIVE_PARTICLES` 2114 / 2112 (−0.1%).
- **box2d TIE.** `physics_STEP_MS` 6.893 → 7.067 ms (**+2.5%**, dentro de 3%). `BODY_COUNT` 9004 / 9004. cv física 1.9% / 2.6%. Esto **no anula** el confirm anterior de cinco corridas (−5.2%). Al lado, `logic0_STEP_MS` 0.339 → 0.474 ms (+39.6%): no es primaria de esta fila, se anota.
- **steadyCombat KEPT.** `logic0_STEP_MS` 0.328 → 0.249 ms (**−24.1%**). Partículas 0.411 → 0.421 (+2.5%). Espacial 0.100 → 0.100 (+0.7%). `BODY_COUNT` 204/204. `ACTIVE_PARTICLES` 4023/4025 (+0.1%, cv bajo). Carga OK.

**Veredicto.** El paquete keep es campeón de emit (kernel) y de combate estable (logic0). Balls física empata esta sentada. No se afirma “más rápido que main”: lockstep falló. El JSON de producto dice que la velocidad no cuenta.

**Siguiente.** Bloque D: resto del catálogo, `--skip-node --skip-lockstep`, `--headed-only visPoly`. No se re-miden emit/box2d/steadyCombat (la cache es por proceso; se excluyen con `--only` para no gastar otras ~20 min headed ni pisar estos números).

## Bloque D — Resto del catálogo (cerrado)

```bash
pnpm bench:scoreboard --vs 0695a8d --headed-only visPoly --skip-node --skip-lockstep --only ray,rayVsBox2d,decals,integrate,spatial,liquidfun,liquidfunCouple,liquidfunQuery,queryAabb,nav,visPoly,tilemap,queryPublish,preRender,compute,decorations,bullets,spawn
```

Informe: [`tests/results/scoreboard/catalog-rest/report.md`](../tests/results/scoreboard/catalog-rest/report.md). ~36 min. `src/` restaurado al terminar el runner.

**Setup.** Estrés 2 × 8 s / 10 s. visPoly headed 5 × 25 s / 18 s. compute y zenithal **sin** ventana. Stats detalladas off. `VISIBILITY_MS` salió 0.

**Números (mapa).** Carga OK salvo preRender (`BODY_COUNT` 0: la escena de cola no spawnea cuerpos; el kernel +9.3% no cuenta). spawn FAIL: el kernel Treiber reventó en el baseline `0695a8d` (la escena sí corrió, logic0 −4.2%).

| Fila | Veredicto | Primaria | Nota |
|------|-----------|----------|------|
| ray | WORSE | kernel +3.4%; logic0 +4.4% | `ray.js` no cambió vs main; logic0 ruido o keep de lógica |
| rayVsBox2d | WORSE | kernel −6.4%; physics +5.8% | |
| decals | WORSE | particle +4.7% | |
| integrate | WORSE | kernel −4.4% | |
| spatial | TIE | spatialMax −2.1% | |
| liquidfun | TIE | physics −0.3%; kernel −1.7% | |
| liquidfunCouple | WORSE | kernel +9.2% ms (más caro) | escena física +0.7% |
| liquidfunQuery | WORSE | physics +9.3%; logic0 −40.5% | una primaria peor mata la fila |
| queryAabb | WORSE | physics 0.132 → 2.718 ms (**+1964.9%**) | burst AABB **todavía estaba** en el keep; logic0 −98.5% (el costo se fue a física) |
| nav | WORSE | kernel −10.8% | el microbench **copia** Dijkstra; no importa `src/`. Escena logic0 +2.9% |
| visPoly | WORSE | kernel −28.4%; preRender −1.2% | `angularSweep.js` **no** cambió vs main: kernel inestable. `VISIBILITY_MS` = 0 |
| tilemap | WORSE | kernel −5.1%; logic0 −1.1% | escena nueva cierra carga (64 entidades). Kernel `tileMap.js` no cambió vs main |
| queryPublish | KEPT | logic0 0.353 → 0.339 (−4.1%) | |
| preRender | FAIL | BODY_COUNT 0 | no es una regresión de cull |
| compute | WORSE | kernel −34.4%; pixi +4.8% | `computeLayer.js` no cambió vs main |
| decorations | WORSE | kernel −56.2%; pixi +5.4% | `decorationSpatial.js` no cambió vs main |
| bullets | TIE | particle +1.6% | cache de `rayStress` |
| spawn | FAIL | kernel BASE falló | escena logic0 −4.2% no cuenta |

**Veredicto.** No se afirma mejor WeedJS. El hallazgo accionable: el burst de QueryAABB seguía en `serviceQueryAabb` aunque el aislamiento lo había **descartado**. Kernels WORSE en módulos que no están en el diff vs `0695a8d` son ruido, no campeón peor.

**Siguiente.** Revertir el burst. Remedir solo queryAabb. visPoly con `--detailed-stats` (hay margen). Nav: dos hipótesis en el Dijkstra de producción.

## Burst AABB revertido (higiene del keep)

**Qué se hizo.** `serviceQueryAabb` en [`src/box2d/weedjsPost.js`](../src/box2d/weedjsPost.js) otra vez llama solo `servicePendingQuery` (uno a uno). El burst era leftover: el aislamiento AABB lo **descartó** (+835%) y el paquete keep no debía incluirlo.

```bash
pnpm bench:scoreboard --vs 0695a8d --only queryAabb --skip-node --skip-lockstep --skip-kernels
```

**Setup.** Estrés 2 × 8 s / 10 s, headless.

**Números.** Física 0.130 → 0.127 ms (**−2.5%**, TIE). `BODY_COUNT` 201/201. logic0 ~16.57 / 16.61 ms (el costo volvió a lógica, como en main). Informe: [`tests/results/scoreboard/queryaabb-after-burst-revert/report.md`](../tests/results/scoreboard/queryaabb-after-burst-revert/report.md).

**Veredicto.** TIE. El +1964% era el burst, no Box2D WASM. Keep set ahora coincide con “sin AABB”.

## visPoly con stats detalladas (cerrado)

```bash
pnpm bench:scoreboard --vs 0695a8d --only visPoly --headed-only visPoly --skip-node --skip-lockstep --detailed-stats
```

Informe: [`tests/results/scoreboard/vispoly-detailed/report.md`](../tests/results/scoreboard/vispoly-detailed/report.md).

**Setup.** Headed 5 × 25 s / 18 s. Sub-timers encendidos.

**Números.** `VISIBILITY_MS` ahora existe: 0.071 → 0.070 ms (−1.2%). `preRender_STEP_MS` 0.129 → 0.125 ms (**−3.3%**, keep de escena). Kernel 106449 → 98185 ops/s (−7.8%). `BODY_COUNT` 56/56.

**Veredicto.** Fila WORSE por el kernel. `angularSweep.js` no cambió vs main: ese kernel es ruido. Con stats detalladas el barrido angular es empate y el pre-render es un poco más barato. No se reabre VP (cache descartada).

## Bloque E — Nav (cerrado)

Dos hipótesis contra el árbol actual. Escena `NavStressScene`, headless 2 × 8 s / 10 s. Primaria `particle_STEP_MS`. Informe: [`tests/results/nav-hyps/report.md`](../tests/results/nav-hyps/report.md).

**N1_floor.** `Math.floor(cell / gridWidth)` → `| 0`. TIE: partículas 2.217 → 2.183 ms (−1.5%). **No mergeado.**

**N2_gridHeight.** Local `gridHeight` en `computeFlowfield`. KEPT: partículas 2.263 → 2.143 ms (**−5.3%**), logic0 −2.1%, carga OK. n=2 cribado. **Mergeado** en `src/workers/particleWorker.js`.

**Veredicto.** N2 es el campeón actual de esa fila contra el código de esta noche, no contra main. No se afirma Nav más barato que `0695a8d` (el tablero D era WORSE de kernel copia).

## Mapa al cerrar la noche

No se afirma WeedJS perfecta. No se afirma más rápida que main (lockstep falló; muchas filas WORSE/FAIL).

Keep como paquete (headed 5 corridas): emit KEPT, box2d TIE, steadyCombat KEPT. Burst AABB sacado: queryAabb TIE vs main. N2 Nav mergeado (cribado n=2). Diario: este archivo. Scoreboards: `tests/results/scoreboard/keep-bundle/`, `catalog-rest/`, `queryaabb-after-burst-revert/`, `vispoly-detailed/`.

`src/` queda con: keep original + revert burst AABB + N2 gridHeight.

---



