# DX-LIGHT3D: sprites con direcciones, mapas de altura y normales, y sombras por pixel

Plan escrito el 2026-11-14 contra `main` en `d1158cc` (versión 0.14.0), después de probar todo esto en el
"Banco de luz y sombras" (la webapp chica donde iteramos la API). Es un plan para que el dueño decida y para que
las sesiones de código lo ejecuten fase por fase. Nada de esto está construido en el motor.

Filas propuestas para [REVIEW_PLAN.md](./REVIEW_PLAN.md): **DX-DIRSPRITE**, **DX-CAMERA**, **DX-MAPS**,
**DX-GBUF**, **DX-DEPTH**, **DX-SHADOW3D**, **DX-SELFSHADOW**, **DX-CASTER**, **DX-EMISSIVE**. Toma y cierra
diseños abiertos: [DX_NORMALS](./DX_NORMALS_DESIGN.md), [DX_SUNMASK](./DX_SUNMASK_DESIGN.md),
[DX_VOLLIGHTS](./DX_VOLLIGHTS_DESIGN.md) (fase 3 de [DX_VOLUME](./DX_VOLUME_DESIGN.md)), y generaliza lo que ya
existe de [DX-FACES](../../src/render/faceMap.js) y [DX-LIGHTAPI](./DX_LIGHTAPI_DESIGN.md).

---

## 0. En una página

**Qué se gana.** Un personaje LPC que camina con la animación `walk` sin que el juego arme `'walk_' + dirección`;
su sombra con el sol de costado es su perfil, no su frente. Un auto con heightmap recibe la sombra larga de las
ramas de un árbol siguiendo su techo y su capó. La luz de un farol ilumina la cara del auto que lo mira. La sombra del
sol no apaga los faroles. Un personaje que camina alrededor de una mesa girada 45° queda delante o detrás de cada
parte de la mesa, pixel por pixel.

**Lo que escribe un juego:**

```js
static config = { camera: { pitch: 47 }, lighting: { enabled: true, shadowsEnabled: true } };

static assets = { spritesheets: {
  civil7: { json: 'lpc/civil7.json', png: 'lpc/civil7.png', heightMap: 'lpc/civil7_h.png',
            directions: { walk: { up: 'walk_up', left: 'walk_left', down: 'walk_down', right: 'walk_right' } } },
}};

class Person extends GameObject {
  static components = [RigidBody, Collider, DirectionalSprite, ShadowCaster];
  onSpawned() {
    this.setSpritesheet('civil7');
    this.setAnimation('walk');
    this.directionalSprite.facingFrom = 'velocity';
  }
}
```

Nada más. La silueta de la sombra, la dirección que ve cada luz, la base de la sombra, las normales y la autosombra
salen de los datos del asset.

**Cómo, en cuatro piezas:**

1. **`DirectionalSprite`**: un componente que sabe hacia dónde mira la entidad y qué animación corresponde a
   cada dirección. Lo resuelve el pre-render.
2. **Páginas gemelas del atlas**: el heightmap y el normal map de cada sheet empaquetados con los mismos UV que el
   color.
3. **G-buffer**: la pasada de los sprites deja, por pixel, altura, normal e id de entidad. Es el face map de
   DX-FACES generalizado.
4. **Luz diferida con mapas de sombra**: un mapa de sombras por luz (el sol uno, cada farol el suyo), y una pasada
   de luz que ilumina cada pixel en su punto 3D con su normal, y saca la luz de cada fuente por separado.

**Qué cambia en el orden de dibujo:** el pintor de hoy (radix en WASM) se queda. La profundidad por pixel
**corrige** al pintor solo donde un objeto tiene heightmap; los bordes semitransparentes se siguen componiendo de
atrás hacia adelante, como un PNG.

**Regla de oro:** una escena que no declara `camera.pitch` oblicuo ni usa las piezas nuevas dibuja byte por byte lo
que dibuja hoy, en WebGL y en WebGPU.

---

## 1. Qué se leyó para escribir esto

- `CLAUDE.md`, `docs/internal/README.md`, `HOW_WE_MEASURE.md`, `FEATURE_BENCHMARKS.md`, `DEVLOG.md` (en particular
  "Sprites Should Composite Like a PNG", 22 de septiembre), el registro (`hypotheses.json`: las entradas de
  `useZBuffer`, CPU-only ySort, painter), y los diseños DX: LIGHTAPI, NORMALS, SUNMASK, VOLUME, VOLLIGHTS, POST,
  GUARDS.
- `docs/guide/bible_of_weed_js.md` (límites prácticos, capas, "Lights and shadows: what you want, what you write").
- Código: `src/components/` (SpriteRenderer, ShadowCaster, LightEmitter, LightOccluder, VolumeShadowCaster,
  MeshRenderer), `src/core/gameObject.js` (setSpritesheet, setAnimation, setSprite, flip, rotación),
  `src/core/spriteSheetRegistry.js` (bigAtlas, MaxRects, proxies), `src/core/layer.js`, `src/core/sun.js`,
  `src/util/configDefaults.js` (LIGHTING, SUN, RENDERER, LAYERS, ASSETS, CAMERA_TYPES),
  `src/workers/pixiWorker.js` (pasadas por cuadro, luz, face map, sombras, capas), `src/workers/preRenderWorker.js`
  (colecta, luces que tiran sombra, pack de casters, pintor), `src/render/` (instancedSpriteBatch, faceMap,
  gpuShadowCasters, shadowStampClient, spriteIndexed, renderQueueLayout), `src/shaders/` (instancedSprite*,
  instancedSpriteShadow, lightingBasic GLSL/WGSL, faceMap), `wasm/` (modules.json, shadowStamp.c,
  preRenderEmit.c, painterRadix.c), `tests/bench/` (las ~250 herramientas, stress scenes, compareCaptures,
  faceLightCheck, sunMeshParity, runPredatorAbab, engineFeatureCatalog) y `tests/node/` (520 archivos).
- Demos: `predatorScene` (config de luz, pools, personas y su `getDirectionFromVector`), `buenosAiresScene`
  (faces, VolumeShadowCaster, autos con un cuadro cada 7.5°, walkers), `sunStreetScene`, `headlightsScene`.

Física, audio, navegación, LiquidFun y guardado no se tocan con este plan; se leyó su estructura y nada más.

---

## 2. Qué hace WeedJS hoy y dónde se queda corto

### 2.1 Orden de dibujo

- El orden lo da un **pintor en CPU**: clave `round(y) * 128` (`DECORATION_Y_SORT_SCALE`), más el zIndex; radix
  con reinserción (`wasm/painterRadix.c`, `src/render/sortIndexByKey.js`). La profundidad que llega a la GPU es el
  índice del pintor (`BATCH_DEPTH.INDEX` en `instancedSpriteBatch.js`), o sea, no aporta información nueva.
- **Ya se probó un z-buffer y se sacó.** `useZBuffer` metía la clave del pintor en la profundidad: el centro opaco
  la escribía y el borde semitransparente se mezclaba en una segunda pasada que no la escribía; los bordes quedaban
  fuera de orden y aparecía un ribete (DEVLOG, 22 de septiembre). En PainterMove el pre-render se duplicaba
  (registro: "useZBuffer on PainterMove", "useZBuffer on Bunny", "CPU-only ySort").
- **Consecuencia:** un objeto se ordena por su pie. Una mesa girada, un granero, un auto largo en diagonal: el
  personaje queda entero delante o entero detrás.

### 2.2 Sprites y direcciones

- No hay noción de dirección. `SpriteRenderer` tiene `animationState` (Uint8: 256 animaciones por sheet),
  `spritesheetId` (Uint8) y, para autos, `inheritTransformRotation` + `spriteRotC/S` ("lets physics/collider angle
  diverge from pre-baked directional sprites").
- **Cada demo escribe su propio selector de dirección:**
  - `buenosAiresScene/cars.js` `frame()`: el cuadro más cercano al rumbo, con margen para no parpadear, y `flipX`
    para los cuadros espejados.
  - `buenosAiresScene/walkers.js`: la dirección desde la velocidad, con su propio umbral, y `WALK[...]` / `IDLE[...]`.
  - `predatorScene/gameObjects/person.js`: `getDirectionFromVector` y `DIRECTION_NAMES = ['up','left','down','right']`.
  - `predatorScene/gameObjects/player.js`: `` setAnimation(`${animPrefix}_${direction}`) ``.
- **Consecuencia:** el motor no puede elegir otra dirección para la sombra, porque no sabe cuál es cuál.

### 2.3 Luz

- `lightingBasic.frag.glsl` / `.wgsl`: una pasada de pantalla completa a `lighting.resolution` (0.25 por
  defecto). Cada pixel se trata como piso: `ambient + sol + noche + Σ luces`, recorriendo **todas** las luces visibles
  (hasta `maxLights`, que también es el tope del bucle `MAX_LIGHTS`; Predator usa 256). Se compone `MULTIPLY` en la capa `lighting` (zIndex 4): solo
  oscurece.
- `LightEmitter` ya tiene la API de DX-LIGHTAPI: `radius`, `brightness`, `color`, `elevation`, `glow`,
  `castShadows`, `shadowRange`, conos.
- **Consecuencia:** la luz no sabe hacia dónde mira la superficie (salvo DX-FACES) ni a qué altura está el pixel
  (la copa de un árbol al norte de un farol se ilumina como el piso más al norte).

### 2.4 Normales

- No hay normal maps de sprites. DX-NORMALS es un diseño no construido.
- **DX-FACES** sí existe: decoraciones con una normal por cara y una altura (`faceNormalX/Y/Z`, `faceHeight`),
  dibujadas otra vez en un **face map** (normal octaédrica + altura, RGBA8, a la resolución de la luz, en orden del
  pintor, `alpha ≥ 0.5`), que la pasada de luz lee (`_renderFaceMap`, `faceMap.js`, `faceMap.frag.glsl`). Es,
  en chico, el G-buffer que este plan necesita.

### 2.5 Sombras

| Herramienta | Qué hace | Límite |
| --- | --- | --- |
| `ShadowCaster` | El sprite redibujado en negro, rotado y estirado según el sol (`heightMultiplier`); con faroles, estirado lejos de la luz con caída (`instancedSpriteShadow.vert.glsl`, `shadowStamp.c`) | Usa el cuadro actual: un personaje que mira al sur tira su frente aunque el sol venga del este |
| `ShadowCaster.setTexture` | Otra silueta (necesita `lighting.shadowTextures`) | A mano, una por entidad |
| `VolumeShadowCaster` | Caja, niveles o casco, proyectados por el sol en la capa `volumeShadows` | Solo el sol (DX-VOLLIGHTS no construido) |
| `LightOccluder` + `raycasted` | Barrido 2D de huellas | Sirve en vista cenital o de costado, no oblicua; apaga las sombras de sprites (N-134) y las faces |

- Todas las sombras van a `castedShadows` (zIndex 2, MULTIPLY), **debajo** de las entidades: nunca caen sobre un
  sprite, no suben por una pared y no siguen la forma de nada.
- La sombra del sol multiplica también la luz de los faroles (DX-SUNMASK); dos sombras que se cruzan se suman.

### 2.6 Atlas

- Un `bigAtlas` empaquetado en el hilo principal con MaxRects (`createBigAtlas`). Los cuadros de spritesheets no se
  recortan; las imágenes sueltas sí. Una LUT de 3 texeles por cuadro (`uTexLut`: tamaño, UV, recorte).
- No hay páginas gemelas. DX-NORMALS anota que Conurbano ya espeja autos para no pasarse de cuadros: los mapas como
  cuadros nuevos no entran, como páginas con los mismos UV sí.

### 2.7 Proyección

Los datos de la cámara están repartidos y cada sistema tiene su número: `lighting.groundScaleY`,
`lighting.faces.heightScaleY`, `VolumeShadowCaster.floorScaleY`, `CAMERA_TYPES` (partículas) y `raycasted`.

### 2.8 Medir la GPU

El reloj de GPU se sacó (`DEBUG_DEFAULTS.collectGpuStats`: "wedges Chrome's GPU process, and WebGL timer queries come
back empty"). Hoy el costo de GPU se ve por los cuadros presentados (`--owner presented`) y por trazas de CPU. Este
plan necesita medir pasadas de GPU, así que agrega una herramienta (§9.3).

---

## 3. Qué hacen Godot y Unity

| Tema | Godot 4 | Unity URP 2D | Lo que tomamos |
| --- | --- | --- | --- |
| Luces | `PointLight2D`, `DirectionalLight2D`, ambiente con `CanvasModulate` | `Light2D` Global, Point, Freeform, Sprite | Ya tomado en DX-LIGHTAPI: brillo separado del alcance, sombras por luz |
| Normal maps | `CanvasTexture` junta diffuse, normal y especular. La luz tiene `height`, que **solo** cambia el sombreado con normales, no las sombras | El normal map es una *secondary texture* `_NormalMap` del sprite, muestreada con los mismos UV que el sprite | Páginas gemelas con los mismos UV, como Unity; la altura de la luz (`elevation`) como Godot, pero que también cuente para las sombras |
| Sombras | Solo de `LightOccluder2D` (polígonos; se pueden generar desde un `Sprite2D`). Filtro None, PCF5 o PCF13: la doc dice que None es lo más rápido y le va bien al pixel art. Las sombras direccionales son infinitamente largas; la doc sugiere un shader propio que lea el SDF 2D | `ShadowCaster2D`: forma desde el editor, el contorno del sprite, un collider o un Sprite Skin; opción de autosombra o sombra proyectada | Bordes duros por defecto (pixel art). Pero ni Godot ni Unity tienen alturas por pixel, sombras sobre sprites ni largo según la altura |
| Orden | `y_sort_enabled` por `CanvasItem`, por el origen | Sorting layers, order in layer, *Transparency Sort Mode* con eje propio (0,1,0 para vista desde arriba), Sorting Groups, punto de orden en el pivote | Nadie ordena por pixel en 2D. Nosotros sí, solo donde hay heightmap |
| Direcciones | `AnimationTree` con `BlendSpace2D`: se le pasa el vector de movimiento y elige `walk_up`, `walk_left`… | Animator con Blend Tree *2D Simple Directional* (parámetros horizontal y vertical) | La idea de "animación sin dirección + vector"; ninguno la conecta con las sombras |
| Sprites en 3D (estilo HD-2D) | — | — | La pasada de sombras se dibuja desde la luz, así que un shader que elige el cuadro por el ángulo de vista elige solo el cuadro que ve la luz. Lo hacemos explícito |

Fuentes al final (§15).

**Conclusión:** las dos herramientas 2D se quedan en el plano. Lo nuevo de WeedJS sería la altura por pixel (de un
heightmap o de un cartón parado), la silueta que ve cada luz, las sombras que caen sobre sprites y la luz de cada
fuente por separado. Todo eso existe en 3D; acá lo armamos para sprites.

---

## 4. Objetivos, no-objetivos y principios

**Objetivos**

1. `DirectionalSprite`: animaciones sin dirección, `facing`, y la dirección resuelta para dibujar y para cada luz.
2. Heightmaps y normal maps por sheet, declarados una vez en assets.
3. Luz por pixel con normales (mapa, deducida de la altura o plana) y fuerza automática según la luz ambiente.
4. Sombras por pixel del sol y de los faroles, sobre el piso **y sobre los sprites**, con la silueta que ve cada luz,
   la base medida y cada luz sacada por separado.
5. Autosombra para objetos con huella.
6. Profundidad por pixel que corrige al pintor donde hay heightmap.
7. `ShadowCaster` único (absorbe `VolumeShadowCaster` y `LightOccluder`), y `camera` en lugar de `raycasted`.
8. Emisivos (fuego) que se ordenan con las entidades y no se oscurecen.
9. Correr en WebGL y WebGPU, y en Predator.

**No-objetivos (por ahora):** sombras suaves con penumbra física, reflejos, luz rebotada, transparencias que
reciban sombra por capas, colisiones con altura.

**Principios**

- **API legible:** se entiende sin leer la doc. Ningún número mágico en la config que haya que recordar; la config
  describe la escena (la cámara), las decisiones viven en la entidad.
- **Los datos deciden:** lo que se puede saber del asset (tiene heightmap, tiene direcciones, tiene huella) no se le
  pregunta al desarrollador.
- **Apagado, idéntico:** todo lo nuevo apagado captura byte por byte como `main` (`compareCaptures --vs main`, ambos
  backends). Es la misma regla de DX-VOLUME y DX-LIGHTAPI.
- **Sin compatibilidad hacia atrás** (como acordó el dueño en DX-LIGHTAPI): cada demo, test y página de la guía pasa
  a la API nueva en el mismo trabajo. Conurbano es otro repo y migra en sus sesiones.
- **Reglas del motor:** sin `Math.hypot`, campos declarados en el constructor, dobles por entidad en arrays
  tipados, nada que aloque en un bucle caliente, una cosa por commit, la herramienta de medición en su propio commit
  antes de lo que mide.

---

## 5. La API

### 5.1 La cámara de la escena (DX-CAMERA)

```js
static config = {
  camera: { pitch: 47 },          // grados desde el horizonte: 90 cenital, 0 de costado
};
```

| Campo | Qué es | Por defecto |
| --- | --- | --- |
| `pitch` | Inclinación de la cámara desde el horizonte | sin definir (la escena de hoy) |
| `yaw` | Giro alrededor de la vertical (45 para isométrico de rombos) | `0` |
| `floorScaleY` | Cuánto se acorta el piso en pantalla | `sin(pitch)`, o `1` sin `pitch` |
| `heightScaleY` | Cuántos px de pantalla sube un px de altura | `cos(pitch)`, o `1` sin `pitch` |

- `floorScaleY` y `heightScaleY` existen porque el arte no siempre sigue la trigonometría: los LPC y los autos
  de Minzinn se dibujan con piso a 0.736 y altura a 0.752, que no son seno y coseno del mismo ángulo. Quien tiene ese
  arte los escribe; quien no, solo `pitch`.
- **El método de sombras sale de acá:** con `pitch` 90 o 0 la escena es plana (cenital o de costado) y se usa el
  barrido 2D de hoy (`setWall`, §5.5). Con cualquier otro valor la escena es oblicua y se usa el sistema 3D de este
  plan. `lighting.raycasted` desaparece.
- Reemplaza a `lighting.groundScaleY`, `lighting.faces.heightScaleY` y el valor por defecto de
  `VolumeShadowCaster.floorScaleY`. `CAMERA_TYPES` de las partículas se deriva de la cámara.
- Sin `camera`, todo es como hoy: piso sin acortar, alturas a 1 (lo que `lighting.faces` usaba por defecto), nada 3D.
  No es lo mismo que `pitch: 90`, que da alturas a 0: por eso el valor por defecto es "sin definir" (F1).

### 5.2 Los assets

```js
static assets = {
  spritesheets: {
    civil7: {
      json: 'lpc/civil7.json', png: 'lpc/civil7.png',
      heightMap: 'lpc/civil7_h.png',      // sin normalMap: las normales se deducen de la altura
      directions: {
        walk:  { up: 'walk_up',  left: 'walk_left',  down: 'walk_down',  right: 'walk_right' },
        idle:  { up: 'idle_up',  left: 'idle_left',  down: 'idle_down',  right: 'idle_right' },
        slash: { up: 'slash_up', left: 'slash_left', down: 'slash_down', right: 'slash_right' },
      },
    },
    gaucho: {                             // un solo costado, espejado
      json: 'gaucho.json', png: 'gaucho.png',
      directions: { walk: { down: 'walk_front', up: 'walk_back', right: 'walk_side',
                            left: { anim: 'walk_side', flipX: true } } },
    },
    hatch: {                              // 32 renders; directions viene en el json que escribe `weed maps`
      json: 'cars/hatch.json', png: 'cars/hatch.png',
      heightMap: 'cars/hatch_h.png', normalMap: 'cars/hatch_n.png',
    },
  },
  textures: { farol: { png: 'farol.png', heightMap: 'farol_h.png' } },   // forma de objeto nueva: hoy textures toma solo la URL
};
```

- **`heightMap` y `normalMap`** son imágenes gemelas: mismos cuadros, mismas posiciones. El heightmap guarda la
  altura en 16 bits (R·256 + G, en px·64; la escala va en el json del mapa si es otra). El normal map es el estándar
  RGB.
- **Si no hay normal map**, las normales se deducen de la altura al cargar. Si no hay ninguno, el sprite es plano
  para la luz: piso si está en una capa de piso, cartón parado si es una entidad (§5.4).
- **`directions`** mapea cada animación sin dirección a una animación por dirección:
  - nombres: `right`, `downRight`, `down`, `downLeft`, `left`, `upLeft`, `up`, `upRight` (0°, 45°…315°, en grados
    del mundo, 90° = sur, hacia la cámara);
  - o ángulos como claves (`{ 0: 'walk_e', 90: 'walk_s' }`);
  - o la forma compacta para renders: `{ count: 32, startAngle: 0, clockwise: true, frames: 'drive' }` (cada cuadro
    de la animación es una dirección) o `anims: 'drive_{i}'` (cada dirección es una animación);
  - `{ anim, flipX: true }` para espejar.
- `directions` también puede venir dentro del json del sheet (lo escribe el exportador); lo de `assets` pisa al json.

### 5.3 `DirectionalSprite` (DX-DIRSPRITE)

```js
class Person extends GameObject {
  static components = [RigidBody, Collider, DirectionalSprite, ShadowCaster];

  onSpawned() {
    this.setSpritesheet('civil7');
    this.setAnimation('walk');                         // sin dirección
    this.directionalSprite.facingFrom = 'velocity';    // mira hacia donde camina; quieto, guarda la última
  }

  tick() {
    if (this.directionalSprite.direction === 'left') { /* el golpe sale a la izquierda */ }
  }

  attack() { this.setAnimation('slash', false); }      // sale en la dirección en que mira
}

class Car extends GameObject {
  static components = [RigidBody, Collider, DirectionalSprite, ShadowCaster];
  onSpawned() {
    this.setSpritesheet('hatch');
    this.setAnimation('drive');
    this.directionalSprite.facingFrom = 'rotation';    // la rotación elige el cuadro; el sprite no gira
  }
}

guardia.directionalSprite.facing = Math.PI / 2;        // radianes del mundo, como rotation: mira al sur
guardia.directionalSprite.lookAt(jugador.x, jugador.y);
```

| Miembro | Tipo | Qué es |
| --- | --- | --- |
| `facing` | radianes | Hacia dónde mira, en el mundo (como `rotation` y `LightEmitter.direction`) |
| `facingFrom` | `'manual'` \| `'velocity'` \| `'rotation'` | De dónde sale `facing` cada cuadro |
| `direction` | string, solo lectura | La dirección elegida para dibujar (`'left'`, o `'12'` en renders) |
| `directionIndex` | entero, solo lectura | Lo mismo como número, para el código caliente |
| `turnMargin` | radianes | Margen para cambiar de dirección (anti-parpadeo); por defecto el 10 % del paso entre direcciones (9° con 4 direcciones) |
| `lookAt(x, y)` | método | `facing` hacia un punto |

Reglas:

- `Component.requires` trae `SpriteRenderer` (como `VolumeShadowCaster` trae `MeshRenderer`) y pone
  `inheritTransformRotation = 0`: el sprite no gira, cambia de cuadro.
- `setAnimation('walk')` en una entidad con `DirectionalSprite` guarda la animación sin dirección.
  `setAnimation('walk_left')` sigue funcionando: si el nombre es una animación concreta del sheet, se muestra tal cual
  y la entidad deja de resolver direcciones hasta el próximo nombre sin dirección.
- Al cambiar de dirección se conserva el cuadro del ciclo (el paso no se reinicia).
- Sin `directions` en el sheet, el componente avisa una vez (DX-GUARDS) y la entidad se dibuja como hoy.
- `velocity` lee `RigidBody` si la entidad lo tiene; si no, la diferencia de pose entre cuadros.

### 5.4 Lo que agrega `SpriteRenderer`

| Miembro | Valores | Por defecto | Para qué |
| --- | --- | --- | --- |
| `normals` | `'auto'`, `'map'`, `'height'`, `'flat'` | `'auto'` | `auto`: el normal map si el sheet lo tiene, si no la altura, si no plano. Los LPC quedan mejor con `height` aunque tengan mapa |
| `surface` | `'standing'`, `'floor'` | `'standing'` en entidades y decoraciones con huella; `'floor'` en capas de piso y calcomanías | Qué altura tiene un sprite **sin** heightmap: un cartón parado en su pie (la fila de abajo a altura 0, cada fila más arriba un poco más alta) o pegado al piso |
| `emissive` | boolean | `false` | Brilla solo: no lo oscurece la noche, se ordena con las entidades (§6.9) |

La fuerza de las normales según la luz ambiente es automática y no tiene perilla:
`k = luz de faroles / (faroles + ambiente + sol)` por pixel. De día el sprite se ve como está dibujado; de noche,
junto a un farol, se ven sus normales.

### 5.5 `ShadowCaster` único (DX-CASTER)

```js
this.shadowCaster.setSprite();                         // silueta: lo de siempre (por defecto)
this.shadowCaster.setSprite({ frame: 'arbol_sombra' }); // otra silueta (reemplaza a setTexture)
this.shadowCaster.setSprite({ orient: 'fixed' });       // cerca o pared: el cartón queda a lo largo del objeto
this.shadowCaster.setHeightMap();                       // cada pixel en su lugar 3D (necesita heightMap)
this.shadowCaster.setBox(176, 72, 104, { offsetY: -36 });  // de VolumeShadowCaster
this.shadowCaster.addLevel(CUERPO, 0, 13);
this.shadowCaster.setHull(puntos);
this.shadowCaster.setWall();                            // vista plana: corta la luz como LightOccluder
this.shadowCaster.clear();

this.shadowCaster.sun.setSprite();                      // solo para el sol
this.shadowCaster.lamps.setHeightMap();                 // solo para faroles y faros

this.shadowCaster.opacity = 0.6;                        // cuánta luz saca (era LightOccluder.block)
this.shadowCaster.selfShadow = true;                    // el objeto se tapa a sí mismo
this.shadowCaster.baseRadius = 6;                       // corrige la base medida (px)
this.shadowCaster.type;                                 // 'sprite' | 'heightMap' | 'box' | 'hull' | 'wall', se lee
```

- **Gana el último setter.** No hay `setType`.
- **`.sun` y `.lamps`** permiten una forma distinta por tipo de luz. Sin ellos, el setter vale para todas.
- **Valores por defecto según el asset** (sin escribir nada):

| El asset | Con el sol | Con faroles | `selfShadow` |
| --- | --- | --- | --- |
| Una sola vista (persona, árbol, poste) | silueta | silueta | no |
| Con huella (renders de N direcciones con heightmap: autos, muebles, vaca) | silueta | heightmap | sí |
| `setBox` / `setHull` | volumen | volumen | — |

  Con faroles arriba, el cartón de una silueta queda casi de canto; por eso lo que tiene huella usa su heightmap.
- **La base** de la silueta se mide sola (§6.2): en lo de una sola vista, el círculo del tronco o la elipse de los
  pies, y el piso bajo la base queda en sombra; en lo que tiene huella, el apoyo más cercano a la luz (las patas, las
  ruedas).
- **La dirección** de la silueta: si la entidad tiene `DirectionalSprite`, cada luz usa la dirección que ve
  (`facing` menos el ángulo hacia la luz), con el mismo cuadro del ciclo.

Migración:

| Hoy | Nuevo |
| --- | --- |
| `ShadowCaster` en components | igual: `setSprite()` es el valor por defecto |
| `shadowCaster.setTexture(n, opts)` / `clearTexture()` | `setSprite({ frame: n, ...opts })` / `setSprite()`; sale `lighting.shadowTextures` |
| `shadowCaster.heightMultiplier` | `setSprite({ heightScale })`; en 3D la altura sale de la cámara y no hace falta |
| `anchorOffsetX/Y` | `baseRadius`, y `setSprite({ anchorX, anchorY })` para casos raros |
| `VolumeShadowCaster.setBox/addLevel/setHull` | `shadowCaster.setBox/addLevel/setHull`; en 3D también tapa faroles (cierra DX-VOLLIGHTS) |
| `LightOccluder` (`maskMode`, `block`) | `shadowCaster.setWall({ shape: 'collider' \| 'sprite' })`, `opacity` |
| `lighting.raycasted: true` | `camera.pitch` 90 o 0 |

### 5.6 `LightEmitter`

No cambia la API (ya es la de DX-LIGHTAPI). Cambia el significado de un campo: en una escena oblicua,
**`elevation` es la altura real del foco** y entra en la geometría de la sombra (un auto bajo un farol a 150 px tira
una sombra corta; bajo uno a 40 px, una larga). `castShadows` y `shadowRange` siguen igual.

> Nota: en la charla se habló de `castsShadows`; el motor ya tiene `castShadows` (DX-LIGHTAPI A3, 741b616c). Se
> queda ese nombre.

### 5.7 Un ejemplo completo

```js
static config = { camera: { pitch: 47, floorScaleY: 0.736, heightScaleY: 0.752 },
                  lighting: { enabled: true, shadowsEnabled: true, baseAmbient: 0.05, sun: { enabled: true } } };

class Farol extends GameObject {
  static components = [SpriteRenderer, LightEmitter, ShadowCaster];
  onSpawned() {
    this.setSprite('farol');
    Object.assign(this.lightEmitter, { radius: 320, color: 0xffd59a, elevation: 90, glow: 0.5, glowOffsetY: -90 });
  }
}

class Cerca extends GameObject {
  static components = [SpriteRenderer, ShadowCaster];
  onSpawned() { this.setSprite('cerca'); this.shadowCaster.setSprite({ orient: 'fixed' }); }
}

class Fogata extends GameObject {
  static components = [SpriteRenderer, LightEmitter];
  onSpawned() {
    this.setSpritesheet('fuego'); this.setAnimation('arde');
    this.spriteRenderer.emissive = true;
    Object.assign(this.lightEmitter, { radius: 220, color: 0xff9944, elevation: 12 });
  }
}
```

---

## 6. Cómo funciona por dentro

### 6.1 Quién hace qué en cada cuadro

| Hilo | Hoy | Agrega |
| --- | --- | --- |
| Principal (carga) | Empaqueta el bigAtlas | Páginas gemelas; normales deducidas; tabla de sombra por cuadro; tabla de direcciones |
| Lógica | `tick`, `setAnimation` | Escribe `facing`, `facingFrom` y la animación sin dirección |
| Pre-render | Colecta, pintor, pack de sprites, luces que tiran sombra, pack de casters | Resuelve direcciones (kernel); elige para cada luz el cuadro de cada silueta; arma las filas de los mapas de sombra; clave de profundidad por fila |
| Pixi | Sprites, sombras estampadas, luz | G-buffer, mapas de sombra, pasada de luz diferida, autosombra, composición con emisivos |

Cada campo nuevo tiene un solo escritor: la lógica escribe lo que pide el juego, el pre-render lo que resuelve.

### 6.2 Carga: páginas gemelas y tablas

- **Una sola página gemela RGBA** por página del atlas, con los mismos rectángulos: altura de 16 bits en RG,
  normal octaédrica en BA. Una textura más en la GPU, no dos; los shaders muestrean el mismo UV. Si un sheet trae
  normal map, se codifica a octaédrica; si no, se deduce de la altura (Sobel) al cargar.
- **Corrección de contornos** al empaquetar (lo que encontramos en el banco): un pixel del borde con altura mezclada
  con el fondo (el contorno norte de un tablero, 9 px más bajo) toma la altura de la superficie que bordea: más bajo
  que todos sus vecinos opacos por 3 px, o con vacío arriba y la fila de abajo 3 px más alta.
- **Tabla de sombra por cuadro** (Float32, en memoria compartida y como textura):
  - base: fila más baja opaca, centro de la banda de apoyo, radio (pies o tronco);
  - apoyos de lo que tiene huella: el alcance hacia 16 direcciones de los pixeles del heightmap a menos de 1.5 px
    del piso (la pata o rueda más cercana a cada luz, por consulta, sin recorrer pixeles en el cuadro);
  - fila de apoyo para la vista desde cada dirección.
- **Tabla de direcciones**: (sheet, animación sin dirección, índice de dirección) → animación concreta y espejo.
- Todo eso se guarda en el bigAtlas preempaquetado (`assets.bigAtlas`), para que una escena grande no lo recalcule.
- **El tope de 256 animaciones por sheet** (`animationState` Uint8 y la tabla `proxyToGlobalAnim` del kernel de
  emisión, u8 × u8): 32 direcciones × 8 animaciones llega justo. La forma `frames` (un cuadro por dirección) lo
  evita para renders quietos. Si hace falta más, se decide en la fase 2 entre ensanchar a Uint16 (medir el kernel)
  o una tabla aparte para entidades direccionales.

### 6.3 Resolver la dirección (pre-render)

- Un kernel por cuadro sobre las entidades con `DirectionalSprite`: `facing` desde su fuente, índice de dirección con
  margen, animación concreta y espejo. Escribe `direction` y la animación que usa el kernel de emisión, que conserva
  el cuadro del ciclo al cambiar de dirección.
- Primero en JavaScript en la colecta; si la entidad direccional pesa en el perfil, a WASM (`preRenderCollect.c` o
  un kernel propio), decidido por el microbench (§9.2).
- **Para las sombras:** al armar las filas de cada luz, el pre-render calcula la dirección que ve esa luz y escribe el
  id de textura de esa fila. Es el mismo camino que ya usa `setTexture` para cambiar el cuadro de una fila de caster
  (`_applyShadowTextures`), sin la perilla `shadowTextures`.

### 6.4 La pasada de sprites y el G-buffer (DX-GBUF)

- **Qué guarda, por pixel:**

| Canal | Contenido |
| --- | --- |
| Altura (16 bits) | Del heightmap gemelo; o la del cartón parado (`surface: 'standing'`, de su fila y su pie); o 0 (`'floor'`) |
| Normal (octaédrica, 2 × 8 bits) | Del normal map, deducida de la altura, plana, o la de una cara de DX-FACES |
| Id de entidad (16 bits) | Para la autosombra y para que una luz no se tape con su propia entidad |
| Flags | Recibe luz con normales, autosombra prendida |

- **Primera versión: una segunda pasada**, generalizando la del face map: el mismo lote de instancias, el shader
  que lee la página gemela. Ya existe, ya respeta el pintor, ya maneja filas indexadas y con clave.
- **Candidata: MRT** (WebGL2 `drawBuffers`, WebGPU varios targets) para dibujar color y G-buffer en una sola pasada.
  DX-NORMALS anotó que el camino de RenderTexture de Pixi no se pensó para eso; se prueba en la fase 4 y se queda
  solo si gana en el microbench de GPU y en la escena dueña.
- **Resolución:** la de la pasada de luz. Para que una sombra de pixel art quede nítida hace falta un texel por pixel
  del mundo: a zoom 1, `lighting.resolution` 1; a zoom 2, 0.5. Se decide midiendo (§9.5), y puede ser automática
  según el zoom.
- **DX-FACES queda adentro:** una decoración con `faceNormal` escribe su normal y su altura en el G-buffer igual que
  hoy en el face map. El face map desaparece como pasada aparte.

### 6.5 Profundidad que corrige al pintor (DX-DEPTH)

- El pintor no cambia (radix en WASM, orden por pie, una sola pasada con mezcla).
- La profundidad deja de ser el índice del pintor y pasa a ser **la posición en el mundo**, en las mismas unidades de
  la clave: para un sprite sin heightmap, la de su pie (igual orden que el pintor); para uno con heightmap, la de
  cada pixel: `(y_pantalla + heightScaleY·z) / floorScaleY`.
- **Todos los pixeles comparan; solo los opacos escriben** (alpha ≥ 0.5). Un pixel opaco que el pintor dibujó tarde
  pero está detrás no se pinta; un borde semitransparente se mezcla sobre lo que haya, en el orden del pintor. Es la
  diferencia con el `useZBuffer` que falló: aquel escribía la misma clave que el pintor y mandaba los bordes a otra
  pasada; este escribe información nueva y deja los bordes en orden.
- **El zIndex gana:** la profundidad va dentro de la franja de cada zIndex (la idea de R-0169).
- Se prende sola en la capa de entidades cuando la cámara es oblicua y algún sheet tiene heightmap.
- **Casos a cuidar:** los cortes del lote para partículas GPU con `sortWithEntities` (`maxPainterSplits`), las filas
  con clave (E-177) e indexadas (E-162), las piezas de Adobe. Escribir profundidad desde el shader apaga el descarte
  temprano: se mide.

### 6.6 Sombras con mapas de sombra (DX-SHADOW3D)

En el banco, cada pixel recorría la lista entera de siluetas; con Predator (1000 árboles plantados y pools de
15 000 civiles y 10 000 soldados) eso no escala. Un mapa de sombras cuesta lo mismo con 10 entidades que con 10 000.

**El sol**

- Un mapa ortográfico desde el sol que cubre la vista más un margen del largo de la sombra más larga, con un texel
  por pixel del mundo a zoom 1.
- **Qué se dibuja en él:**
  - siluetas: un rectángulo parado en la base, que mira al sol, con el cuadro que ve el sol, descartando `alpha <
    0.5` y leído del atlas grande (sin copiar a otro atlas);
  - cajas y cascos: la geometría de `VolumeShadowCaster`, que ya está en la arena de mallas;
  - heightmaps: los pixeles del objeto en su lugar 3D más su extensión maciza hacia el norte hasta el borde de la
    huella (lo que hacía el campo de alturas del banco), con la limpieza contra los puntitos.
- **Cache:** lo quieto se dibuja una vez en un mapa propio, y cada cuadro solo se suma lo que se mueve. Con el ciclo
  de día, lo quieto se rehace cuando el sol se movió más de un umbral (se mide cuál).
- La luz por debajo de una mesa sale sola: el mapa es 3D. El truco de las dos capas del banco hacía falta solo porque
  el campo de alturas era 2.5D.

**Los faroles**

| Opción | Cómo | A favor | En contra |
| --- | --- | --- | --- |
| A. Un mapa por farol | 5 caras de un cubo (sin la de arriba) a baja resolución (por ejemplo 256²), todas en un atlas | Costo por pixel constante (una consulta por farol) | `5 × maxShadowCastingLights` dibujos por cuadro; Predator tiene 48 faroles con sombra |
| B. Rayos con lista por tile | El pre-render reparte las siluetas de cada farol en tiles de pantalla; cada pixel prueba solo las de su tile | Exacto, sin resolución que elegir | Costo por pixel variable; WebGL sin compute para repartir en GPU |

Se decide con un prototipo en `lampShadowStressScene` (§10). La recomendación inicial es A, porque el costo no
depende de la multitud y los dibujos son instancias baratas.

- Las siluetas de un farol miran al farol y usan la dirección que ve el farol.
- Un farol no se tapa con su propia entidad (los faros de un auto no se tapan con el auto).
- Siguen los presupuestos de hoy: `maxShadowCastingLights`, `maxShadowsPerLight`, `shadowRange`.

### 6.7 La pasada de luz nueva

Por cada pixel del G-buffer:

1. Punto 3D: x de pantalla; y del piso = `(y_pantalla + heightScaleY·z) / floorScaleY`; z del G-buffer.
2. Normal del G-buffer.
3. Luz = ambiente + noche + sol·N·L·visibilidad_sol + Σ farol·N·L·caída·visibilidad_farol, con la fuerza automática
   de las normales (§5.4).
4. Visibilidad = consulta al mapa de sombras de esa luz × autosombra (§6.8).

- **Cada luz se tapa por separado:** la sombra del sol saca solo el sol; un farol sigue iluminando esa sombra. Es lo
  que pedía DX-SUNMASK (`shadowMode: 'light'`), que acá sale de regalo.
- La capa `castedShadows` queda vacía en modo 3D; las sombras viven en la luz.
- Las cookies de los faroles (N-154) se revisan: con cada luz por separado, probablemente sobran.
- Sigue componiéndose MULTIPLY en zIndex 4, más el término emisivo (§6.9).

### 6.8 Autosombra (DX-SELFSHADOW)

- En pantalla, sobre el G-buffer: desde el punto 3D del pixel hacia la luz, en pasos de 1 px de pantalla, contando
  solo pixeles del mismo id. Tapa si el G-buffer está 2 px por encima del rayo en 3 pasos seguidos (lo que dejó sin
  damero el auto en el banco).
- 4 rayos por pixel, desde las esquinas: el borde queda en 4 tonos.
- Solo los pixeles con el flag de autosombra la pagan (autos y muebles por defecto).
- Variante opcional: contar también otras entidades cercanas da una sombra de contacto fina a resolución completa.

### 6.9 Emisivos (DX-EMISSIVE)

- Dos colores por pixel en la pasada de sprites, mezclados con el mismo alpha: el que recibe luz y el que brilla
  solo. Un sprite normal escribe su color en el primero y negro con su alpha en el segundo; uno emisivo, al revés.
- Final: `color_con_luz × luz + brillo_propio`. Lo de atrás de una llama se ve con su propia luz y la llama conserva
  su brillo; quien pasa por delante tapa las dos cosas en la proporción de su alpha.
- Un emisivo no escribe profundidad ni G-buffer.
- Necesita la misma pieza de MRT (o una pasada más); va después de la fase 4.

### 6.10 WebGL y WebGPU

- Cada shader nuevo en GLSL (ES 3.00, como `instancedSprite*`) y WGSL, con la misma prueba de compilación que ya
  existe para los sprites indexados (`spriteIndexedCompileCheck.mjs`).
- **Sondeo de capacidades en la fase 0** (en las máquinas del dueño): qué formatos se pueden usar como destino y
  mezclar en cada backend (R16F con mezcla MIN para mapas de sombra, o profundidad), si el RenderTexture de Pixi v8
  acepta adjuntar profundidad y varios colores, `EXT_color_buffer_float` en WebGL2.
- **Nada requiere compute:** WebGPU puede usarlo como optimización (por ejemplo repartir siluetas en tiles), siempre
  con el mismo resultado que el camino de WebGL.
- Las capturas de cada fase se comparan en los dos backends.

### 6.11 Escenas planas (`pitch` 90 o 0)

El barrido 2D de hoy, con `shadowCaster.setWall()` en lugar de `LightOccluder`. DirectionalSprite, los mapas y las
normales funcionan igual (una vista cenital también tiene normales); la sombra 3D no se usa.

---

## 7. Fases

Cada fase termina en algo que el dueño puede ver, puede quedarse ahí, y deja `main` en verde. Las herramientas de
medición van en su propio commit antes de lo que miden. Cada "hecho cuando" incluye: capturas apagado = `main` byte
por byte en los dos backends, `npm run test:node` verde, tipos (`check:types`) y superficie pública
(`bundlePublicSurface.test.js`) al día.

### F0. La regla (sin cambios en `src/`)

- Herramienta de **microbench de GPU** (§9.3).
- Esqueletos de las **stress scenes** (§10), escritas primero con la API de hoy donde se pueda, para tener el "antes".
- **Sondeo de capacidades** (§6.10) y su informe.
- Capturas y films de todas las demos con luz en `main`, WebGL y WebGPU.
- Knob `?light3d=0|1` en Predator y en `buenosAiresScene` (sin efecto todavía).
- Un A/A de la sesión (límite de detección de cada escena).

**Hecho cuando** el microbench de GPU mide una pasada conocida (la luz de hoy) con dispersión baja en las dos GPUs del
dueño, y cada stress scene llega al piso de 6 ms en su worker dueño con su knob (o anota su techo, como
`protocolCeiling`).

### F1. `camera` (DX-CAMERA)

- `config.camera` con `pitch`, `yaw`, `floorScaleY`, `heightScaleY`.
- `lighting.groundScaleY`, `faces.heightScaleY` y el `floorScaleY` por defecto leen de la cámara; las claves viejas
  salen y cada demo migra.
- `raycasted` sale: `pitch` 90 o 0 eligen el barrido.

**Hecho cuando** cada demo migrada captura igual que antes de migrar.

**Cómo quedó (rama):** `src/util/cameraView.js` resuelve la cámara una vez (`Scene._applyConfigDefaults`, con un aviso
por valor recortado o ignorado); `config.camera` queda resuelto (`pitch`, `yaw`, `floorScaleY`, `heightScaleY`,
`oblique`) y cada worker lee `cameraFloorScaleY(config)` / `resolveFaces(lighting, camera)`. `lighting.groundScaleY` y
`lighting.faces.heightScaleY` son claves retiradas: el aviso de claves desconocidas dice adónde se fueron. Las demos
(Predator, Buenos Aires, headlights) y las stress scenes de luz migraron; los knobs de URL (`?groundScaleY=`) siguen
igual y ahora escriben `camera.floorScaleY`, así que las capturas no cambian (los mismos números llegan a los mismos
shaders). **`raycasted` no sale todavía:** derivarlo de `pitch` cambiaría escenas cenitales que hoy no lo usan, y el
barrido que lo reemplaza (`setWall`) llega con el `ShadowCaster` único: pasa a F9.

### F2. `DirectionalSprite` (DX-DIRSPRITE)

- `directions` en assets y en el json; tabla de direcciones.
- El componente, `setAnimation` sin dirección, `facingFrom`, `lookAt`, margen, cuadro del ciclo conservado, espejo.
- Resolución en el pre-render (JavaScript primero).
- Migran: `buenosAiresScene/cars.js` (se va `frame()`), `walkers.js`, Predator (`person.js`, `player.js`,
  `civilian.js`, `mySoldier.js`).
- Sin sombras todavía.

**Hecho cuando** las demos migradas se ven igual (film lado a lado), el código de dirección de cada demo desaparece, y
`directionalSpriteStressScene` no empeora el pre-render más allá del límite de la sesión contra el selector hecho a mano
de las demos.

### F3. Mapas (DX-MAPS)

- `heightMap` / `normalMap` en assets, la página gemela, normales deducidas, corrección de contornos, tabla de
  sombra por cuadro, guardado en el bigAtlas preempaquetado.
- Herramienta `weed maps` (puede ir en paralelo): relieve para LPC y árboles, alturas y normales de renders 3D, el json
  con `directions`, y la corrección de contornos al exportar.

**Hecho cuando** los mapas cargan alineados (test de alineación por cuadro), el tiempo de carga de Predator no sube más
de lo que mide `atlasPackMicrobench` para las páginas nuevas, y nada cambia en pantalla.

### F4. G-buffer y luz con normales (DX-GBUF)

- La pasada del G-buffer (generalizando la del face map) y la pasada de luz diferida, todavía sin sombras nuevas.
- Normales `auto/map/height/flat`, `surface`, fuerza automática según el ambiente. DX-FACES pasa a ser un caso del
  G-buffer.
- Prueba de MRT contra segunda pasada en el microbench de GPU.

**Hecho cuando** `normalLightCheck` (§8) da menos de 3/255 contra su fórmula en los dos backends, `faceLightCheck`
sigue pasando, y `spriteMapsStressScene` queda dentro del presupuesto que se fije con los números de F0.

### F5. Profundidad que corrige al pintor (DX-DEPTH)

**Hecho cuando** `depthSortCheck` (§8) da la visibilidad esperada en cada posición del personaje alrededor de la mesa
girada y del granero, los bordes semitransparentes capturan igual que con el pintor solo donde no hay heightmap,
`painterMoveStressScene` y `painterSortStressScene` no empeoran, y la mezcla con partículas GPU (`gpuYSortProbeScene`)
no cambia.

### F6. Sombras del sol (DX-SHADOW3D, parte 1)

- Mapa del sol con siluetas (cuadro que ve el sol, base medida), cajas, cascos y heightmaps; cache de lo quieto.
- Visibilidad del sol en la pasada de luz, solo el sol por separado. `castedShadows` vacía en modo 3D.

**Hecho cuando** `shadowOutlineCheck` (§8) da los contornos a menos de 1.5 px de la fórmula, la sombra de un árbol cae
sobre un auto siguiendo su techo (captura de referencia aprobada por el dueño), y `sunShadowMapStressScene` y Predator
de día quedan dentro de lo fijado.

### F7. Sombras de los faroles (DX-SHADOW3D, parte 2)

- Prototipo A contra B en `lampShadowStressScene`; el dueño decide con los números.
- La opción elegida, con siluetas que miran a cada farol, la propia entidad ignorada y los presupuestos de hoy.

**Hecho cuando** un auto bajo un farol de 150 px tira una sombra corta y bajo uno de 40 px una larga (contra la fórmula
de DX-VOLLIGHTS), dos faroles se iluminan uno la sombra del otro, y Predator de noche queda dentro de lo fijado.

### F8. Autosombra (DX-SELFSHADOW)

**Hecho cuando** el auto y la cama del banco no muestran damero (captura aprobada), y `selfShadowStressScene` mide el
costo por pixel con 1, 2 y 4 rayos para elegir.

### F9. `ShadowCaster` único (DX-CASTER)

- La API de §5.5, `.sun` / `.lamps`, valores por defecto por asset, `opacity`, `setWall`.
- `VolumeShadowCaster` y `LightOccluder` salen; Sun Street, Headlights, Buenos Aires y Predator migran.
- `lighting.raycasted` sale (venía de F1): `camera.pitch` 90 o 0 eligen el barrido de `setWall`.

**Hecho cuando** cada demo migrada captura igual (o mejor, con film y aprobación) y la tabla "what you want, what you
write" de la guía está reescrita.

### F10. Emisivos y sombras parciales (DX-EMISSIVE)

- Los dos colores por pixel, `spriteRenderer.emissive`.
- Opcional: siluetas que sacan luz según su alpha (humo, borde de copas).

### F11. Vitrina, Predator y cierre

- `demos/lightBenchScene` (§11).
- Predator con todo prendido (personas con `DirectionalSprite`, árboles con silueta, casas con caja, faroles con
  sombra, fogatas emisivas).
- Guía (`bible_of_weed_js.md`), `types/weed.d.ts`, `src/index.js`, DEVLOG, registro.
- Scoreboard final y una sesión en 4 núcleos y en una GPU integrada (§9.7).

---

## 8. Tests

### 8.1 Node (`tests/node/`)

| Pieza | Qué prueba |
| --- | --- |
| Cámara | Derivación de `floorScaleY`/`heightScaleY`; elección de método por `pitch`; error claro con valores fuera de rango |
| Direcciones | Parseo de nombres, ángulos, forma compacta, espejo y json; ángulo → índice; margen (sin parpadeo en la diagonal); cuadro del ciclo conservado; `setAnimation` con nombre concreto; aviso sin `directions` |
| Velocidad y rotación | `facingFrom` con RigidBody, sin él, quieto (guarda la última) |
| Atlas | Páginas gemelas con los mismos rectángulos (también con recorte de imágenes sueltas); codificación de alturas y normales; Sobel contra una esfera conocida |
| Contornos | La corrección arregla el borde norte de la mesa y deja intactos la cara lateral, la base de una pata y una pared bajo un alero (los casos del banco) |
| Tabla de sombra | Base, centro y radio de un tronco y unos pies dibujados; apoyos de una vaca y un auto; alcance por dirección |
| ShadowCaster | Gana el último setter; `.sun`/`.lamps`; valores por defecto por asset; `type`; migraciones |
| Profundidad | La clave de un sprite sin heightmap ordena igual que el pintor; franjas de zIndex |
| Shaders | Compilan en GLSL y WGSL (patrón de `spriteIndexedCompileCheck.mjs`) |
| Forma de los workers | Los campos nuevos del pre-render y Pixi declarados en el constructor (`workerShape.test.js`) |
| Superficie pública | Exports y tipos (`bundlePublicSurface.test.js`, `check:types`) |

Pruebas de comportamiento sobre código real (`workerHarness.mjs` carga un worker en Node), no sobre el texto del
código.

### 8.2 Contra una fórmula, en el navegador (como `faceLightCheck` y `sunMeshParity`)

Cada una con una escena quieta que dibuja blanco, una fórmula escrita desde este diseño (no desde el shader), y una
tolerancia, en los dos backends:

- `normalLightCheck`: una esfera de heightmap bajo el sol y bajo un farol; cada pixel contra `N·L`.
- `shadowOutlineCheck`: cajas, un cartón y un heightmap con el sol en 8 direcciones y faroles a 3 alturas; el
  contorno contra la proyección analítica (1.5 px).
- `silhouetteDirectionCheck`: un personaje que mira al sur con el sol del este tira el cuadro de perfil; el ancho
  según la base vista desde la luz.
- `depthSortCheck`: el personaje en 12 posiciones alrededor de la mesa girada y del granero; qué pixeles quedan
  delante.
- `lampSeparationCheck`: la sombra del sol bajo un farol mantiene la luz del farol.
- `emissiveCheck`: lo que se ve a través de una llama al 50 % tiene su propia luz.

### 8.3 Capturas y films

- `compareCaptures --vs main` en cada demo con luz, WebGL y WebGPU: apagado, byte por byte.
- Cada cambio visual deliberado con su film lado a lado (`filmScene.mjs`) y la aprobación del dueño.
- `runLockstepVisual` en las escenas que ya lo usan.

---

## 9. Rendimiento: cómo nos aseguramos de que sea lo más rápido posible

### 9.1 Las reglas de siempre

Se sigue [HOW_WE_MEASURE.md](./HOW_WE_MEASURE.md) al pie de la letra: la capa más baja que ve el cambio (kernel →
escena dueña → Predator); ABAB con los dos lados en worktrees; primario el `STEP_MS − WAIT_MS` del worker dueño, o los
cuadros presentados cuando el costo es de GPU (`--owner presented`); 3 % y 75 % de los pares; un A/A por sesión; el
registro escrito el mismo día.

### 9.2 Kernels nuevos (Node, `tests/bench/*Microbench.mjs`)

| Kernel | Mide | Variantes |
| --- | --- | --- |
| `directionResolveMicrobench` | Resolver la dirección de N entidades (rotación, velocidad, manual, margen) | JS en la colecta contra WASM |
| `silhouetteFramePickMicrobench` | Elegir el cuadro que ve cada luz para cada silueta | Dentro del pack de casters contra un pase aparte |
| `heightNormalDeriveMicrobench` | Sobel y corrección de contornos al cargar | JS contra WASM; un sheet LPC y un render de 32 direcciones |
| `frameShadowInfoMicrobench` | Tabla de sombra por cuadro | Al cargar contra preempaquetado |
| `shadowMapRowsMicrobench` | Armar las filas de los mapas de sombra (sol y faroles) | Reusar `shadowStamp.c` contra un kernel nuevo |
| `atlasPackMicrobench` (existe) | El costo de las páginas gemelas | Con y sin gemelas |

Cada uno importa el código que se envía, chequea antes de medir y escribe ops/s con un checksum
(`microbenchHelpers.mjs`, `warmNormalCompile`); los WASM pasan por las variantes de flags, SIMD y float32.

### 9.3 Microbench de GPU (herramienta nueva, en F0)

El reloj de GPU dentro del motor colgaba Chrome, así que esto corre **fuera del motor**: una página que arma solo la
pasada que se mide, con las fuentes de los shaders de `src/shaders/`, y la dibuja K veces.

- WebGL: `gl.finish()` alrededor de los K dibujos; WebGPU: `device.queue.onSubmittedWorkDone()`.
- Corridas cortas; si algún backend vuelve a colgarse, se cae a la búsqueda de capacidad: dibujar la pasada N veces
  por cuadro hasta que los cuadros presentados bajen de 60.
- Parámetros: resolución, cantidad de luces, siluetas, pasos de autosombra, formato del destino, MRT o no.
- Pasadas medidas: G-buffer (segunda pasada y MRT), mapa del sol (N rectángulos), mapas de faroles (A y B), pasada de
  luz (0.25, 0.5 y 1 con 8, 32 y 256 luces), autosombra (1, 2 y 4 rayos), composición con emisivos.
- Se corre con ventana (la GPU real) en la GTX 1650 del dueño y en una integrada. Se reporta ms por pasada con su
  dispersión.

### 9.4 Escenas dueñas

Las de §10, sembradas y estables, un knob cada una, con su primario y sus claves de carga declaradas en
`engineFeatureCatalog.mjs` (una fila por pieza nueva), para que el scoreboard las corra.

### 9.5 Torneos: cada decisión de implementación se mide, no se adivina

Con `featureTournamentLib.mjs` o, mientras no haya sesiones de varios brazos, pares ABAB por perilla de un mismo
build (`--query-a/--query-b`):

| Decisión | Candidatas |
| --- | --- |
| G-buffer | Segunda pasada / MRT |
| Destino de los mapas de sombra | R16F con mezcla MIN / profundidad |
| Resolución de la luz | 0.25 / 0.5 / 1 / automática según el zoom |
| Sombras de faroles | A (mapa por farol) / B (rayos con lista por tile) |
| Resolución del mapa de un farol | 128 / 256 / 512 |
| Cache del sol | Rehacer lo quieto cada N grados de sol / cada cuadro |
| Páginas gemelas | Una RGBA (alto + normal) / dos |
| Dirección | JS / WASM |
| Autosombra | 1 / 2 / 4 rayos; tope de pasos |

Cada decisión queda en el registro con sus números y su límite de detección.

### 9.6 Predator

- **Apagado** (`?light3d=0`): compuerta de regresión de cada fase que toque su camino caliente (pre-render, Pixi, el
  pack de casters, la capa de entidades). Ningún worker 3 % peor, cuadros presentados iguales.
- **Prendido** (`?light3d=1`, de F6 en adelante): la escena con todo, de día y de noche (`?hour=`), WebGL y WebGPU.
  Los primarios son Pixi, pre-render y los cuadros presentados.
- Predator es guardia, no regla (8 a 13 % de ruido por worker): las decisiones finas se toman en las escenas dueñas.

### 9.7 Todo el motor

- `npm run bench:scoreboard --vs main` al cerrar cada fase.
- Basura: `heapSampleWorkers.mjs` en pre-render y Pixi (ningún sitio nuevo de KB/s).
- Desoptimizaciones: `--log-deopt --log-ic` + `summarizeV8Deopt.mjs` (ninguna nueva en régimen).
- `fieldTypeAudit.mjs` y `kernelTierAudit.mjs`.
- Una sesión en 4 núcleos y una con GPU integrada antes de cerrar F11.

### 9.8 Metas (a confirmar con los números de F0)

- Apagado: igual que hoy, en todos los workers y en los cuadros presentados.
- Prendido, Predator a 1080p en la GTX 1650: 60 cuadros presentados de día y de noche con 48 faroles con sombra. Si
  no llega, la fase dice cuánto falta y cuál de las decisiones de §9.5 se revisa.
- El costo por cuadro no crece con la cantidad de entidades en pantalla más allá del dibujo de los mapas de sombra;
  crece con la resolución y con las luces.

---

## 10. Escenas de stress (`tests/bench/stressScenes/`)

| Escena | Knobs | Primario | Para qué |
| --- | --- | --- | --- |
| `directionalSpriteStressScene` | `?n=`, `?dirs=4\|8\|32`, `?turnRate=`, `?facingFrom=` | pre-render | Resolver direcciones contra el selector hecho a mano |
| `spriteMapsStressScene` | `?n=`, `?maps=0\|height\|normal\|both`, `?lights=`, `?gbuffer=pass\|mrt`, `?res=` | presentados / Pixi | G-buffer y luz con normales |
| `depthSortStressScene` | `?tables=`, `?people=`, `?depth=0\|1` | presentados / Pixi | La profundidad que corrige al pintor |
| `sunShadowMapStressScene` | `?casters=`, `?kind=sprite\|height\|box`, `?mapRes=`, `?cache=0\|1`, `?dayCycle=` | presentados / Pixi / pre-render | El mapa del sol y su cache |
| `lampShadowStressScene` | `?lamps=`, `?castersPerLamp=`, `?mode=map\|tiles`, `?lampRes=` | presentados / Pixi / pre-render | La decisión A/B de los faroles |
| `selfShadowStressScene` | `?n=`, `?rays=1\|2\|4`, `?steps=` | presentados | El costo de la autosombra |
| `emissiveStressScene` | `?fires=`, `?people=` | presentados | Los dos colores por pixel |
| `light3dCaptureScene` | `?hour=`, `?backend=`, cada pieza por separado | — | Escena quieta para `compareCaptures` y las pruebas contra fórmula |

Todas sembradas, con `?backend=webgl|webgpu`, una carga estable y el piso de 6 ms alcanzable en su worker dueño.

---

## 11. La vitrina: `demos/lightBenchScene`

El "Banco de luz y sombras" llevado al motor, con la API real:

- **Elementos:** objetos de 32 direcciones (Quaternius), autos, un personaje LPC que se mueve con WASD, árboles,
  cercas, una vaca; agregar, mover, girar y borrar.
- **Luces:** el sol (dirección, altura, intensidad, ciclo) y faroles esféricos, cada uno con `castShadows`.
- **Panel global:** cámara (`pitch`, piso y altura), ambiente, orden (pintor o con profundidad), resolución de la luz,
  backend (recarga).
- **Panel del elemento elegido:** la sombra con el sol y con los faroles (silueta, heightmap, caja, casco, ninguna),
  orientación del cartón, autosombra, normales (`auto/map/height/flat`), base, emisivo.
- **Código de la entidad:** el panel muestra el código WeedJS de lo que está elegido, con la API de este plan.
- Explicaciones en cada control (como el banco) y las teclas de `buenosAiresScene` para comparar cosas prendidas y
  apagadas.
- Es también la escena de referencia de los films y las capturas aprobadas por el dueño.

---

## 12. Riesgos y límites conocidos

| Riesgo | Qué hacemos |
| --- | --- |
| El camino de RenderTexture de Pixi v8 no admite MRT o profundidad adjunta | El sondeo de F0 lo dice; la segunda pasada y R16F con mezcla MIN no lo necesitan |
| Ancho de banda en GPUs débiles (el G-buffer suma texturas) | La resolución de la luz por zoom; una sola página gemela; medir en una integrada |
| 256 animaciones por sheet con muchas direcciones | La forma `frames`; decidir en F2 si se ensancha |
| La memoria de la página gemela (una más por página del atlas) | Solo para sheets que declaran mapas; preempaquetado |
| Bordes semitransparentes donde el pintor se equivoca | Solo en objetos con heightmap; los emisivos y efectos en sus capas |
| Resolución del mapa del sol con zoom lejano | Densidad de texeles según el zoom, con tope |
| Heightmaps que solo ven la cara visible | La extensión maciza hacia el norte y la limpieza; las dos capas ya no hacen falta |
| `elevation` cambia de significado | La guía lo dice donde está la sombra 3D; las demos ponen la altura real del foco |
| Conurbano (otro repo) | Migra en sus sesiones, con un bundle nuevo en su `weed/` |

---

## 13. Decisiones para el dueño

| # | Pregunta | Recomendado |
| --- | --- | --- |
| 1 | `pitch` desde el horizonte (90 cenital) o desde la vertical | Desde el horizonte: es como lo define `faces.heightScaleY` hoy |
| 2 | `facing` en radianes o grados | Radianes, como `rotation` y `LightEmitter.direction`; `lookAt` evita la cuenta |
| 3 | `directions` explícito en assets o convención de nombres | Explícito, con el json del exportador como fuente |
| 4 | Sombras de faroles: A o B | Lo que digan los números de F7; A de entrada |
| 5 | MRT o segunda pasada para el G-buffer | Lo que digan los números de F4; segunda pasada de entrada |
| 6 | Resolución de la luz en modo 3D | Automática según el zoom, un texel por pixel del mundo, con tope |
| 7 | Las sombras estampadas de hoy como modo barato | Se quedan para escenas planas y para quien no declare cámara oblicua |
| 8 | Valores por defecto de `ShadowCaster` por asset (§5.5) | Sí |
| 9 | `heightMultiplier` y `anchorOffset` | Salen, reemplazados por la base medida y `baseRadius` |
| 10 | Orden de fases | F0 → F11 como está; `weed maps` en paralelo a F3 |

---

## 14. Del banco al motor

| En el banco | En el motor |
| --- | --- |
| Campo de alturas de dos capas + grilla gruesa + rayo | Mapas de sombra (3D, costo constante por pixel) |
| Lista de cartones recorrida por pixel | Siluetas dibujadas en el mapa de cada luz |
| `selfOcc` sobre el heightmap del propio sprite | Autosombra en pantalla sobre el G-buffer, por id |
| `gl_FragDepth` por pixel en todos los sprites | Profundidad que corrige al pintor, solo donde hay heightmap |
| Base medida en JS por cuadro | Tabla de sombra por cuadro, al cargar o preempaquetada |
| `frameSeenFrom` | `DirectionalSprite` + la tabla de direcciones del asset |
| Corrección de contornos y limpieza del campo | Corrección al empaquetar la página gemela y en `weed maps` |
| Fuerza de normales `k` por pixel | Igual, en la pasada de luz |

**Glosario.** *G-buffer*: geometry buffer; por pixel guarda dónde está en 3D, hacia dónde mira y de qué objeto es,
y la luz se calcula después. *Mapa de sombras*: la escena vista desde una luz, guardando la distancia a lo primero que
la luz ve; un pixel está en sombra si algo está más cerca de la luz que él. *Pintor*: dibujar de atrás hacia adelante
ordenando por una clave.

---

## 15. Fuentes

- Godot, 2D lights and shadows (altura de la luz solo para normales; filtros; sombras direccionales infinitas y el
  SDF; ocluders desde un Sprite2D): https://docs.godotengine.org/en/4.4/tutorials/2d/2d_lights_and_shadows.html ,
  https://docs.godotengine.org/en/stable/tutorials/2d/2d_lights_and_shadows.html
- Godot, Light2D (filtros PCF5/PCF13, `height`): https://godot.readthedocs.io/en/4.0/classes/class_light2d.html
- Godot, PointLight2D `height`: https://godot.readthedocs.io/en/4.1/classes/class_pointlight2d.html
- Godot, CanvasItem `y_sort_enabled`: https://docs.godotengine.org/de/4.3/classes/class_canvasitem.html
- Godot, AnimationTree y BlendSpace2D: https://docs.godotengine.org/en/4.2/tutorials/animation/animation_tree.html
- Unity, Shadow Caster 2D: https://docs.unity3d.com/Manual/urp/ShadowCaster2D.html ,
  https://docs.unity3d.com/6000.4/Documentation/Manual/urp/ShadowCaster2D.html
- Unity, normal maps como secondary textures: https://docs.unity3d.com/Manual/urp/SecondaryTextures.html ,
  https://docs.unity3d.com/6000.1/Documentation/Manual/urp/SecondaryTextures.html
- Unity, orden 2D y eje propio: https://docs.unity.com/en-us/engine/6000.6/manual/unity2d/sprite/sort-sprites/2d-renderer-sorting.md ,
  https://docs.unity3d.com/2021.3/Documentation/Manual/2DSorting.html
- Unity, Blend Tree 2D: https://docs.unity3d.com/Manual/BlendTree-2DBlending.html
- Sprites en 3D y la pasada de sombras desde la luz: https://discussions.unity.com/t/need-help-with-matrix-algebra-in-2d-billboard-shader/856626 ,
  https://forums.unrealengine.com/t/pom-material/13050/443 ,
  https://discussions.unity.com/t/how-do-games-like-octopath-traveler-handle-the-angle-of-shadows-and-is-this-even-possible-in-unity-urp/246459

---

## 16. Avance (rama `dx/light3d`)

Lo que está hecho en la rama, fase por fase, con su commit. Se actualiza con cada fase cerrada.

| Fase | Estado | Commits | Notas |
| --- | --- | --- | --- |
| Plan en el repo | hecho | e77f734 | este archivo, filas DX-* en REVIEW_PLAN |
| F1 `camera` | hecho | (este commit) | `raycasted` pasa a F9; `frameChainWait` (presupuesto de reloj) falla a veces en esta máquina de 2 núcleos, también en la base |
