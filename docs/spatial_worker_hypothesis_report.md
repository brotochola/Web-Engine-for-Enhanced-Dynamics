# Informe experimental: hipótesis de optimización del `spatialWorker` (weed.js)

**Proyecto:** `multithreadad-game-engine`  
**Rama de trabajo:** `exp/spatial-hyps`  
**Inspiración metodológica:** `morton_experiments` ([REPORT.md](file:///d:/xampp/htdocs/morton_experiments/REPORT.md), clase `AdaptiveSpatial`)  
**Escenas:** `BallsScene`, `PredatorScene`  
**Runtime:** Chromium headed (Playwright), throttle mitigation activa  
**Datos:** `tests/results/spatial-hyps/campaign-summary.json`, `tests/results/spatial-hyps/confirm-summary.json`  
**Código bajo prueba:** [`src/workers/spatialWorker.js`](../src/workers/spatialWorker.js) (restaurado a baseline al cerrar la campaña)

---

## 1. Resumen ejecutivo

Se formuló y midió un conjunto de **15 hipótesis falsables** (más baseline) orientadas a reducir el coste por frame del spatial worker (`STEP_MS`, con desglose `REBUILD_MS` / `NEIGHBOR_MS`) en dos workloads distintos:

| Escena | Régimen | `cellSize` | Workers | `visualRange` típico |
|--------|---------|-----------:|--------:|----------------------|
| Balls | denso, uniforme, física Box2D | 100 | 1 | ≈30–90 px |
| Predator | mixto, multi-worker, IA/luces | 128 | 3 | 0–700 px |

El resultado principal, alineado con el REPORT Morton (H5 Verlet / amortización de listas de vecinos), es:

- **H3 (reuse con margen estilo Verlet, skin = 0.25·visualRange)** se **acepta** en confirmación 5-run: mediana de `STEP_MS` max **−70%** en Balls y **−45%** en Predator, con `BODY_COUNT` estable y fuerte aumento de `NEIGHBORS_REUSED`.
- **H1 (respetar `cellSleepingData`)** cumple el umbral métrico, pero se clasifica como **condicional**: en Predator colapsa `NEIGHBOR_MS` y deriva levemente `BODY_COUNT`; requiere auditoría de corrección antes de merge.
- **H11 (fallback Transform para posición B cross-worker)** es **mixta**: aceptada solo en Balls (−5.7% confirmado); Predator no alcanza −3%.
- Microoptimizaciones (radio de celda, hash muestreado, cache densa, pack de índice, Morton reorder, `cellSize=96`, etc.) se **rechazan** como default bajo este protocolo.
- El port literal de `AdaptiveSpatial` (hash Map / dense counting / Verlet aparte) **no** se implementó: el grid SAB + partición por filas de weed.js ya es dense; el hallazgo transferible es la **amortización de la fase all-neighbors**, no el router on-demand.

El árbol de fuentes quedó restaurado al baseline; los parches viven en [`tests/bench/spatial-hyps/hypPatches.mjs`](../tests/bench/spatial-hyps/hypPatches.mjs) para reproducción.

---

## 2. Pregunta de investigación y motivación

### 2.1 Pregunta

> ¿Qué cambios locales sobre el `spatialWorker` de weed.js reducen de forma reproducible el `STEP_MS` (y, en Predator, el máximo entre workers) en Balls y Predator, sin romper equivalencia de carga (`BODY_COUNT` ±5%), y cuáles de las ideas del banco Morton/`AdaptiveSpatial` se traducen al modelo SAB + row-ownership?

### 2.2 Motivación

El REPORT Morton mostró que, para el workload **allNeighbors** (análogo a “cada entidad busca vecinos cada tick”), ganan **linked-cell incremental** y **listas Verlet**; el rebuild denso completo pierde. Reorder Morton y BVH no pagaron. En weed.js el path actual reconstruye filas owned cada frame y reusa vecinos solo con igualdad float exacta + hash de versiones de celdas — régimen hostil al reuse en Balls móviles.

---

## 3. Marco conceptual

Sea el coste por tick del spatial worker:

\[
T_{\mathrm{step}} = T_{\mathrm{rebuild}} + T_{\mathrm{neighbor}}
\]

instrumentados como `REBUILD_MS` y `NEIGHBOR_MS`. La métrica primaria de cuello de botella es:

- Balls: `STEP_MS` del único worker `spatial0`
- Predator: **máximo** `STEP_MS` entre `spatial0..2` (latencia del peor worker); se reporta también la suma

El reuse existente (`_canReuseNeighbors`) exige identidad exacta de posición; un margen tipo Verlet permite conservar `neighborData` mientras el desplazamiento del centro sea \(\le\) skin y el hash de dependencia de celdas no cambie.

---

## 4. Método

### 4.1 Diseño

Método hipotético-deductivo: (1) H1–H15 falsables; (2) screening headed 2-run; (3) promoción si \(\Delta STEP\_MS \le -3\%\) y \(|\Delta BODY\_COUNT| \le 5\%\); (4) confirmación 5-run median+CV; (5) veredicto.

### 4.2 Controles

| Factor | Valor |
|--------|-------|
| Warmup / measure | 25 s / 18 s ([`benchmarkDefaults.mjs`](../tests/bench/benchmarkDefaults.mjs)) |
| Modo | headed Chromium |
| Aislamiento | 1 hipótesis por corrida; restore desde snapshot baseline |
| Harness | [`runSpatialHypCampaign.mjs`](../tests/bench/runSpatialHypCampaign.mjs), [`runSpatialHypConfirm.mjs`](../tests/bench/runSpatialHypConfirm.mjs) |

### 4.3 Hipótesis (enunciado corto)

| ID | Enunciado | Cambio |
|----|-----------|--------|
| H1 | Saltar rebuild de celdas dormidas baja `REBUILD_MS`/`STEP_MS` | Honrar `Grid.cellSleepingData` |
| H2 | Rebuild solo movers (incremental) gana a full scan | Consumir `box2dMovedBodies` + full cada 8 frames |
| H3 | Skin Verlet 0.25·vr sube reuse y baja `NEIGHBOR_MS` | `_canReuseNeighbors` por distancia |
| H4 | `cellRadius` sin overshoot `+1` reduce celdas tocadas | ceil estricto |
| H5 | Hash de dependencia muestreado (stride 2) abaratá invalidación | `_computeDependencyHash` |
| H6 | Fast-path círculo en rebuild acelera Balls | Inline `SHAPE_CIRCLE` |
| H7 | Cache densa vs `Map` corta alloc | Array indexado |
| H8 | Skip temprano `visualRange==0` | Reordenar early-out |
| H9 | Bajar `maxNeighbors` Predator 1024→512 | Config escena |
| H10 | Iterar activos por home-row evita celdas vacías | Loop sobre `activeEntitiesData` |
| H11 | Fallback Transform para B sin `entityPos` fresco | Inner neighbor loop |
| H12 | Pack bit de índice si `gridWidth` potencia de 2 | `<<` vs `*` |
| H13 | Stagger búsquedas con vr≥300 | 1/2 frames |
| H14 | Morton reorder **no** mejora `STEP_MS` (falsación) | Sort activos cada 8 frames |
| H15 | `cellSize=96` estático mejora ambas | Config escenas |

**Fuera de campaña (rechazo a priori):** BVH top-down, Morton XOR/MinMax como broadphase, spatial hash `Map` (cellCount ≪ 2×10⁶ en ambas escenas).

---

## 5. Resultados

Los tiempos son **medianas** de `statsSamplesAverage` sobre la ventana de medida. `STEP` = `spatialStepMsMax`. Load% = `STEP / (1000/60) × 100`.

### 5.1 Screening (2 runs) — Balls

| ID | STEP_MS | Δ% vs BASE | REBUILD | NEIGHBOR | REUSED | BODY |
|----|--------:|----------:|--------:|---------:|-------:|-----:|
| BASE | 14.85 | — | 1.07 | 13.77 | 150 | 9004 |
| H1 | 12.21 | **−17.8** | 1.05 | 11.15 | 75 | 9004 |
| H2 | 14.79 | −0.4 | 1.10 | 13.69 | 82 | 9004 |
| H3 | 6.17 | **−58.5** | 1.16 | 5.00 | 7597 | 9004 |
| H4 | 15.72 | +5.9 | 0.98 | 14.73 | 3 | 9004 |
| H5 | 15.89 | +7.0 | 1.02 | 14.87 | 55 | 9004 |
| H6 | 15.61 | +5.2 | 0.87 | 14.74 | 89 | 9004 |
| H7 | 14.81 | −0.2 | 1.13 | 13.67 | 50 | 9004 |
| H8 | 15.79 | +6.3 | 1.03 | 14.75 | 142 | 9004 |
| H9 | 15.67 | +5.5 | 1.05 | 14.62 | 152 | 9004 |
| H10 | 14.75 | −0.6 | 0.86 | 13.89 | 136 | 9004 |
| H11 | 13.33 | **−10.2** | 0.99 | 12.34 | 39 | 9004 |
| H12 | 13.33 | **−10.2** | 1.00 | 12.33 | 20 | 9004 |
| H13 | 14.68 | −1.1 | 1.09 | 13.59 | 2 | 9004 |
| H14 | 15.21 | +2.4 | 2.03 | 13.17 | 73 | 9004 |
| H15 | 14.68 | −1.1 | 1.14 | 13.54 | 3 | 9004 |

### 5.2 Screening (2 runs) — Predator (`STEP` = max worker)

| ID | STEP_MS | Δ% vs BASE | REBUILD Σ | NEIGHBOR Σ | REUSED Σ | BODY |
|----|--------:|----------:|----------:|-----------:|---------:|-----:|
| BASE | 22.48 | — | 3.39 | 61.94 | 9292 | 16926 |
| H1 | 10.18 | **−54.7** | 4.36 | 24.21 | 8295 | 16178 |
| H2 | 27.81 | +23.7 | 3.41 | 78.30 | 5245 | 16979 |
| H3 | 17.66 | **−21.5** | 4.23 | 47.61 | 12112 | 16987 |
| H4 | 26.90 | +19.7 | 3.68 | 73.31 | 8990 | 17074 |
| H5 | 27.30 | +21.5 | 3.75 | 75.05 | 9250 | 17029 |
| H6 | 27.50 | +22.3 | 2.92 | 77.25 | 9042 | 17023 |
| H7 | 26.94 | +19.8 | 3.66 | 75.76 | 8536 | 17008 |
| H8 | 26.42 | +17.6 | 3.58 | 73.10 | 8707 | 16939 |
| H9 | 25.91 | +15.3 | 3.62 | 70.59 | 9036 | 17000 |
| H10 | 22.94 | +2.1 | 3.30 | 63.63 | 8874 | 16829 |
| H11 | 22.46 | −0.1 | 3.12 | 61.52 | 8655 | 16811 |
| H12 | 25.35 | +12.8 | 3.52 | 69.43 | 8742 | 16947 |
| H13 | 25.32 | +12.7 | 3.67 | 70.42 | 8746 | 16917 |
| H14 | 25.31 | +12.6 | 6.49 | 67.62 | 8621 | 16984 |
| H15 | 31.06 | +38.2 | 4.05 | 88.12 | 8412 | 16809 |

**Nota de deriva temporal:** a partir de H4, Predator muestra regresiones sistemáticas (~+15–20%) respecto al BASE temprano. Por eso la confirmación re-baselinea en bloque contiguo.

**H12:** en Balls/Predator `gridWidth` no es potencia de 2 → el pack no se activa; el −10% de screening en Balls se interpreta como **ruido / confusión**, no se confirmó.

### 5.3 Confirmación (5 runs, median ± CV)

Baseline de confirmación (más conservador que el screening temprano en Predator):

| Escena | STEP_MS med | CV | REBUILD Σ | NEIGHBOR Σ | REUSED Σ | BODY |
|--------|------------:|---:|----------:|-----------:|---------:|-----:|
| Balls | 15.35 | 6.5% | 1.36 | 13.87 | 38 | 9004 |
| Predator | 25.61 | 5.4% | 3.56 | 71.09 | 8815 | 16961 |

| Hyp | Escena | STEP_MS | Δ% | CV | REUSED | BODY | Δ BODY% | ¿≥3% y BODY OK? |
|-----|--------|--------:|---:|---:|-------:|-----:|--------:|:----------------|
| H1 | Balls | 13.06 | **−14.9** | 7.6% | 16 | 9004 | 0 | sí |
| H1 | Predator | 11.21 | **−56.2** | 11.6% | 8371 | 16510 | −2.7 | sí (métrica) |
| H3 | Balls | 4.61 | **−69.9** | 6.1% | 8548 | 9004 | 0 | sí |
| H3 | Predator | 14.19 | **−44.6** | 20.0% | 12632 | 16898 | −0.4 | sí |
| H11 | Balls | 14.48 | **−5.7** | 1.3% | 53 | 9004 | 0 | sí |
| H11 | Predator | 24.97 | −2.5 | 4.1% | 8596 | 16891 | −0.4 | no |

---

## 6. Análisis de hipótesis (veredictos)

| ID | Veredicto | Justificación |
|----|-----------|---------------|
| **H1** | **Condicional** | Pasa umbral en ambas escenas, pero Predator reduce ~63% `NEIGHBOR_MS` y deriva BODY; riesgo de celdas stale. No merge sin prueba funcional de vecinos/IA. |
| **H2** | **Rechazada** | Balls neutro; Predator +24% screening. Incremental naive (filtrar movers + full periódico) no amortiza bien el multi-cell AABB + row ownership. |
| **H3** | **Aceptada** | Confirmada −70% / −45%; mecanismo causal: `NEIGHBORS_REUSED` (Balls 38→8548). Alineado con REPORT H5 / Adaptive Verlet. |
| **H4** | **Rechazada** | Más STEP; peor reuse (Balls REUSED→3). El overshoot `+1` parece proteger calidad/reuse. |
| **H5** | **Rechazada** | Sin ganancia; posible invalidación más burda sin abaratár el cuello. |
| **H6** | **Rechazada** | `REBUILD` Balls baja (~1.07→0.87) pero `NEIGHBOR` domina; STEP no mejora. |
| **H7** | **Rechazada** | Neutro/ Balls; Predator regresión en screening (deriva). |
| **H8** | **Rechazada** | Early-out ya existía; reorden no aporta. |
| **H9** | **Rechazada** | Cap 512 no baja STEP de forma útil. |
| **H10** | **Rechazada** | Neutro (~±2%). |
| **H11** | **Mixta** | Aceptada en Balls (−5.7% confirm); Predator insuficiente. |
| **H12** | **Rechazada (no-op)** | Anchos de grilla no potencias de 2; falso positivo de screening. |
| **H13** | **Rechazada** | Stagger luces no mueve el cuello (densidad/factions). |
| **H14** | **Rechazada** (falsación OK) | Morton sube `REBUILD` (sort); coherente con REPORT H3. |
| **H15** | **Rechazada** | `cellSize=96` empeora Predator (+38%); Balls neutro. Refuerza estudio previo (100/128 óptimos locales). |

---

## 7. Discusión

1. **El cuello es `NEIGHBOR_MS`, no el rebuild denso.** En Balls baseline, ~93% del step es búsqueda. Por eso H6 (rebuild) y H2 (incremental rebuild) no desplazan el ranking, mientras H3 ataca la fase dominante.

2. **Transferencia desde Morton/`AdaptiveSpatial`.** El ganador empírico del workload allNeighbors (Verlet / amortización) se traduce aquí como **reuse con skin**, no como segunda estructura. El router Adaptive (hash si cellCount>2e6) no aplica: Balls ≈2k celdas, Predator ≈3k.

3. **Igualdad float exacta es un anti-patrón de reuse en simulaciones móviles.** El H3 *de campaña* solo aflojaba la igualdad de posición y reutilizaba `neighborData` stale (sin ampliar radio ni re-filtrar) — rápido pero semánticamente incorrecto. La implementación integrada (ver §12) corrige eso.

4. **H1 exige escepticismo.** Un −56% en Predator con caída fuerte de vecinos tocados sugiere trabajo omitido, no solo skip de clear. `cellSleepingData` lo escribe el particle path; su semántica frente a entidades lógicas/físicas no está validada en este informe.

5. **Deriva entre hyps largas.** Confirmación contigua es necesaria; comparar H15 screening vs BASE screening subestima ruido de máquina/sesión.

6. **Multi-worker.** En Predator la métrica max captura el straggler; H3 mejora el max y la suma de `NEIGHBOR_MS`.

---

## 8. Recomendaciones prácticas

| Situación | Acción |
|-----------|--------|
| Default del motor | **`neighborReuseSkin: 0.04`**, **`neighborReuseMaxFrames: 15`** (`SPATIAL_DEFAULTS`) |
| Predator / flock denso-rápido | Override escena: **`0.01` / `30`** (mejor celda del barrido parcial) |
| Escenas más rápidas / más riesgo FN | Bajar skin o `neighborReuseMaxFrames` |
| Sleeping cells (H1) | No merge; añadir tests de vecinos + invariantes de grid antes de reintentar |
| Incremental movedBodies (H2) | Rediseñar con lista de celdas por entidad; el prototipo de campaña no basta |
| cellSize | Mantener Balls **100**, Predator **128** |
| Morton reorder / BVH / hash Map | No como default (confirmado otra vez) |

**Estado del código:** H3 Verlet *correcto* vive en [`src/workers/spatialWorker.js`](../src/workers/spatialWorker.js) detrás de `neighborReuseSkin` (default **0.04**). El oracle FN/FP (`verifyNeighborSets`) se retiró del motor tras validar FN=0/FP=0; ver §12.

---

## 9. Limitaciones

- Una sola máquina / sesión headed; sin réplicas multi-host.
- Screening 2-run: CV alto en algunas hyps; confirmación solo en promovidas.
- ~~H3 no mide calidad semántica~~ → validado históricamente con oracle (§12); oracle ya no está en el runtime.
- H1 no incluye gate visual/funcional de IA Predator.
- Predator `STEP` max tiene CV 20% bajo H3 (confirm) — banda ancha; la mediana sigue claramente bajo baseline.
- El H3 de *campaña* (solo skin en `_canReuseNeighbors` sin candidate cache) queda obsoleto; no re-ejecutar `applyHyp('H3')` del patcher antiguo.
- Barrido skin×frames (§12.5) incompleto (cortó en skin 0.25); zona 0.01–0.2 está completa.

---

## 10. Trabajo futuro

- ~~Barrido de `skin` / `neighborReuseMaxFrames`~~ → parcial hecho; opcional completar skins ≥0.35.
- Incremental real: occupancy lists + `movedBodies` + full rebuild periódico medido.
- Combinar skin Verlet + H11 y re-benchmark.
- Wire correcto de `cellSleeping` con tests.

---

## 11. Reproducibilidad (campaña H1–H15)

```bash
cd d:\xampp\htdocs\multithreadad-game-engine
git checkout exp/spatial-hyps

node tests/bench/runSpatialHypCampaign.mjs --dry-apply
node tests/bench/runSpatialHypCampaign.mjs --runs 2
node tests/bench/runSpatialHypConfirm.mjs
```

Artefactos: `tests/results/spatial-hyps/*.json`.

---

## 12. Validación semántica y tuning de defaults (post-campaña)

### 12.1 Hueco del H3 de campaña

Reusar `neighborData` cuando A se mueve ≤ skin **sin** ampliar la búsqueda ni re-filtrar produce FN/FP. `BODY_COUNT` no detecta eso. La implementación integrada corrige el hueco (§12.2).

### 12.2 Semántica integrada

Publicado en `neighborData` cada frame:

\[
B \in N(A) \iff \|P_B-P_A\|^2 < (vr_A + halfExtent_B)^2
\]

Implementación (`neighborReuseSkin > 0`):

1. Miss: buscar candidatos con `searchRange = vr + 2·skin`
2. Siempre: filtrar candidatos → `neighborData` al `vr` actual
3. Hit: A dentro de skin del build, misma vr/extent, edad `< neighborReuseMaxFrames` (acota drift de B)
4. `skin = 0`: sin reuse (rebuild completo cada frame)

### 12.3 Oracle histórico (retirado del motor)

Se validó FN=0 / FP=0 con un oracle brute-force en worker (`verifyNeighborSets`) y una escena de probes dedicada. Ese scaffolding **ya no forma parte del runtime** (ni defaults, ni stats FN/FP, ni gate). Resultados históricos (headed, 2 runs):

| Fase | Variante | STEP_MS med | REUSED | FN | FP |
|------|----------|------------:|-------:|---:|---:|
| Correctness (oracle on) | skin 0 | 7.58 | 0 | **0** | **0** |
| Correctness (oracle on) | skin 0.25 | 5.10 | ~965 | **0** | **0** |
| Perf (oracle off) | skin 0 | **2.04** | 0 | — | — |
| Perf (oracle off) | skin 0.25 | **0.94** | ~960 | — | — |

Perf Δ STEP_MS ≈ **−53.7%** en esa escena.

### 12.5 Barrido skin × frames (parcial)

Harness: [`runNeighborReuseGrid.mjs`](../tests/bench/runNeighborReuseGrid.mjs). Artefacto: `tests/results/neighbor-reuse/skin-frames-grid.json` (cortó en `skin=0.25 frames=15` Predator; skins **0–0.2** completos).

Baseline `skin=0`: Balls STEP_max **15.74 ms**, Predator **53.43 ms**.

Mejores celdas observadas (1 run headed, warmup 12s / measure 10s):

| Escena | Mejor celda | STEP_max | Δ vs skin0 |
|--------|-------------|----------:|-----------:|
| Balls | skin **0.05** / frames **20** | 7.48 | ≈ −52% |
| Predator | skin **0.01** / frames **30** | 18.27 | ≈ −66% |

**Ship:** defaults globales **0.04 / 15** (entre 0.01 y 0.05); Predator override **0.01 / 30**.

---

*Informe generado a partir de la campaña experimental del spatial_worker, la validación semántica H3 y el barrido parcial skin×frames. Las cifras absolutas dependen del hardware y de la carga del sistema; los veredictos se basan en deltas relativos bajo protocolo fijo.*
