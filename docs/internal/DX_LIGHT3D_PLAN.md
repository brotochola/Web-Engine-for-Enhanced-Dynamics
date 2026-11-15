# DX-LIGHT3D: sprites con direcciones, mapas de altura y normales, y sombras por pixel

Plan escrito el 2026-11-14 contra `main` en `d1158cc` (versión 0.14.0), después de probar todo esto en el
"Banco de luz y sombras" (la webapp chica donde iteramos la API). Es un plan para que el dueño decida y para que
las sesiones de código lo ejecuten fase por fase. Se está construyendo en la rama `dx/light3d`: lo hecho está en §16 y en el
«Cómo quedó (rama)» de cada fase; el estado y lo que falta, en §17.3.

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

**Cómo quedó (rama):**

- `src/core/spriteDirections.js` arma la tabla de cada sheet en el hilo principal al instalar el atlas (`assets` →
  json → animaciones `<nombre>_<dirección>`, que es lo que tienen los LPC: no hay que declarar nada). Formas: nombres,
  grados, `{ anim, flipX }`, `mirrorX: true` (rellena el costado espejado: los autos) y la forma `count`/`anims`.
  **La forma `frames` (un cuadro por dirección) no está:** el cuadro lo elige el kernel de emisión del pre-render, no la
  lógica; queda para cuando un sheet la pida.
- **La resolución corre en la lógica, no en el pre-render** (cambio contra §6.3): así hay un solo escritor de
  `animationState` entre los hilos que lo escriben (la lógica), `direction` está al día en el mismo tick que lo pidió, y
  `onDirectionChanged` (gancho nuevo) corre donde corre el juego. Se resuelve en los setters y en una pasada después de los
  ticks, repartida como los ticks. El pre-render la leerá para las sombras (F6/F7) desde la misma tabla.
- `facing` está en radianes del mundo (la pantalla). Un juego con el piso acortado que quiere elegir por el rumbo en el
  piso escribe `facing = atan2(vy / floorScaleY, vx)` (los peatones de Buenos Aires). Cuando la cámara de F1 sea oblicua
  por defecto en más escenas, se puede agregar `facingFrom: 'floorVelocity'`.
- Velocidad sin atan2: mientras el rumbo sigue dentro de su dirección (producto punto contra cos² de medio hueco más medio
  margen), no se calcula el ángulo. Kernel: 26 ns por entidad con 4 direcciones, 46 con 32 (R-1052).
- Migraron: autos y peatones de Buenos Aires (se van `frame()`, la tabla de rumbos y el selector de octantes),
  la gente de Predator (FSM con nombres sin dirección; disparar y pegar miran al blanco), el jugador y la persona de
  carScene. Capturas de Predator iguales a ojo; Buenos Aires se mueve (no hay captura byte a byte posible).

### F3. Mapas (DX-MAPS)

- `heightMap` / `normalMap` en assets, la página gemela, normales deducidas, corrección de contornos, tabla de
  sombra por cuadro, guardado en el bigAtlas preempaquetado.
- Herramienta `weed maps` (puede ir en paralelo): relieve para LPC y árboles, alturas y normales de renders 3D, el json
  con `directions`, y la corrección de contornos al exportar.

**Hecho cuando** los mapas cargan alineados (test de alineación por cuadro), el tiempo de carga de Predator no sube más
de lo que mide `atlasPackMicrobench` para las páginas nuevas, y nada cambia en pantalla.

**Cómo quedó (rama):** `heightMap` (rg16 en 1/64 px, o `{ png, gray }`) y `normalMap` (RGB, espacio de cámara, y
arriba) en `assets.spritesheets`; `src/render/spriteMaps.js` (octaédrica, lectura, corrección de contornos, Sobel,
texeles gemelos) y `SpriteSheetRegistry._paintMapsPage`, que lee cada sheet una vez y escribe cada cuadro en su
rectángulo de la página gemela; la página viaja como ImageBitmap de datos y queda en `atlasMapsSource`. Test de
alineación por cuadro con un canvas en memoria (`tests/node/spriteMaps.test.js`). Arte de prueba: `makeShapes.mjs`
traza una esfera, un pilar y un cajón con su altura y sus normales (modelo de lo que escribe un exportador).
**Falta:** la tabla de sombra por cuadro (va con F6, que es quien la usa), los mapas en el bigAtlas preempaquetado, la
herramienta `weed maps`, y medir la carga de Predator (no tiene mapas todavía: no paga nada).

### F4. G-buffer y luz con normales (DX-GBUF)

- La pasada del G-buffer (generalizando la del face map) y la pasada de luz diferida, todavía sin sombras nuevas.
- Normales `auto/map/height/flat`, `surface`, fuerza automática según el ambiente. DX-FACES pasa a ser un caso del
  G-buffer.
- Prueba de MRT contra segunda pasada en el microbench de GPU.

**Hecho cuando** `normalLightCheck` (§8) da menos de 3/255 contra su fórmula en los dos backends, `faceLightCheck`
sigue pasando, y `spriteMapsStressScene` queda dentro del presupuesto que se fije con los números de F0.

**Cómo quedó (rama), primera versión:** el G-buffer es el face map generalizado, como decía §6.4: donde un sprite no
es cara, el fragmento lee la página gemela con el UV del color (`texelFetch`, sin filtro), gira la normal del espacio de
cámara al del piso con el pitch de la cámara y escribe esa normal y la altura del pixel. La pasada de luz ya iluminaba
así un pixel como un punto en 3D: no cambió. Una escena con mapas prende la pasada sola. `spriteMapsStressScene`
(`?maps=0|height|normal|both`) se ve con relieve en WebGL (captura); `faceLightScene` captura byte a byte igual que
antes con caras y sin ellas. **Falta:** `normals` y `surface` en `SpriteRenderer` (el cartón parado para sprites sin
mapa), el id de entidad en el buffer (lo pide la autosombra), probar MRT, el microbench de GPU, y WebGPU: el código WGSL
está, pero en esta VM el backend WebGPU falla en cualquier escena (`createBuffer`), así que no se pudo ver.

**Después (2026-11-14):** en una GPU real, toda escena con mapas fallaba en WebGPU: la pasada de caras lee la página
gemela en el binding 5 del grupo 2, que los layouts explícitos de los programas de sprites no tenían ("Binding doesn't
exist"). Arreglado (6601e884): el banco anda en WebGPU.

### F5. Profundidad que corrige al pintor (DX-DEPTH)

**Hecho cuando** `depthSortCheck` (§8) da la visibilidad esperada en cada posición del personaje alrededor de la mesa
girada y del granero, los bordes semitransparentes capturan igual que con el pintor solo donde no hay heightmap,
`painterMoveStressScene` y `painterSortStressScene` no empeoran, y la mezcla con partículas GPU (`gpuYSortProbeScene`)
no cambia.

**Cómo quedó (rama), primera versión (2026-11-15, 72d38271, R-1061):** el pintor sigue igual (orden por el pie, una sola
pasada con mezcla). Con cámara oblicua y una página de mapas, los programas de color del lote de entidades (el común, el
indexado y el que lee por fila) escriben como profundidad el lugar de cada pixel en el piso y la prueban (`less`): un pixel
con heightmap, a su altura, `(y_pantalla + heightScaleY·z) / floorScaleY`; cualquier otro, el pie de su sprite; el orden
del pintor desempata (`src/render/pixelDepth.js`). Se prende sola con cámara oblicua y algún sheet con mapas;
`renderer.pixelDepth` `true` o `false` la fuerza (`true` igual necesita un sheet con mapas). Un pixel emisivo se ubica en el
pie de su sprite. En el banco a las 16 h cambian 388 px contra el commit anterior, todos donde la cerca se cruza con la
otra cerca y con la mesa, que ahora tapa la punta de la cerca que tiene delante. **Cambio contra §6.5:** todo pixel
dibujado escribe profundidad, también los bordes semitransparentes (en una sola pasada no hay máscara por pixel).
**Falta:** WebGPU (ahí ordena solo el pintor), que escriban solo los opacos, las franjas de zIndex, `depthSortCheck`,
`depthSortStressScene`, los cortes del lote con partículas GPU (`sortWithEntities`) y medir lo que cuesta escribir la
profundidad desde el shader (apaga el descarte temprano).

### F6. Sombras del sol (DX-SHADOW3D, parte 1)

- Mapa del sol con siluetas (cuadro que ve el sol, base medida), cajas, cascos y heightmaps; cache de lo quieto.
- Visibilidad del sol en la pasada de luz, solo el sol por separado. `castedShadows` vacía en modo 3D.

**Hecho cuando** `shadowOutlineCheck` (§8) da los contornos a menos de 1.5 px de la fórmula, la sombra de un árbol cae
sobre un auto siguiendo su techo (captura de referencia aprobada por el dueño), y `sunShadowMapStressScene` y Predator
de día quedan dentro de lo fijado.

**Cómo quedó (rama), primera versión:** `lighting.sunShadows: 'map'` (por defecto `'sprite'`, sin cambios). El mapa
está en los términos del piso (`src/render/sunShadowMap.js`): cada texel guarda la altura del punto caster más alto cuyo
rayo de sol cae ahí, y está dispuesto en pantalla como la capa de sombras de sprites, así la pasada de luz lo muestrea
con las mismas coordenadas. Se dibuja con mezcla `max` desde las filas de sol del pre-render (el vertex shader de las
sombras de sprites con su última parte convertida en puntos de caída). Cada caster es un cartón parado en su pie que
mira al sol; si el sheet tiene heightmap, la profundidad sale del mapa (el cartón solo sombreaba la tapa del cajón). La
pasada de luz busca el punto de caída de cada pixel con su altura (caras y sprites con mapas) y saca solo el término del
sol. Captura en WebGL: sombras en el piso, sin acné en las tapas; `faceLightScene` y `lightGalleryScene` iguales byte a
byte. **Falta:** WebGPU (avisa y queda en `'sprite'`), los caminos con clave (E-191/E-211: en modo mapa se usan las
filas completas), la base medida (tabla de F3), cajas y cascos de
`VolumeShadowCaster` en el mapa, la cache de lo quieto, `shadowOutlineCheck`, `sunShadowMapStressScene` propia y la
aprobación del dueño con la captura del árbol sobre el auto.

**Después (2026-11-14 y 15, R-1053, R-1065):**

- §17.1: el cartón parado en su base medida y proyectado a lo largo del sol, en los dos modos; los renders con heightmap
  tiran su sólido (R-1053).
- §17.2: las filas con clave llevan el cuadro que ve el sol (d5dc4ef6): E-211 vuelve con casters direccionales.
- WebGPU: el mapa del sol, los sólidos y la autosombra (496587e7). En el banco, modo mapa, WebGPU contra WebGL: 6 149 px
  distintos, delta máximo 2.
- Un render que tira su sólido conserva el cuadro de la cámara, no el que ve el sol (265207b5): la sombra de la cerca era
  la de una cerca girada un cuarto; ahora es una banda a lo largo de ella (27 947 px cambian en el banco).
- Cada sheet dice cómo tira la sombra del sol (d352144b): `meta.shadowCast.sun` (o `meta.light3d.cast.sun`, como lo
  escribe el conversor del banco) en `'sprite'` le da a sus renders el cartón en vez del sólido (la vaca, los autos). Con
  huellas en el json (`meta.footprints`), `lighting.footprintSolids` barre cada celda hacia el norte a su altura hasta el
  borde de la huella, como el banco; queda apagado porque al granero le faltan las paredes en la sombra.
- Sombras más oscuras: el mapa saca `Sun.shadowAlpha` del sol (ac57e08d), no `Sun.shadowOpacity`, que lo volvía a escalar
  por la intensidad y aclaraba las sombras largas (a las 16 h el banco sacaba 13 % de la luz del piso). El banco usa
  `shadowAlpha` 0.7 y `shadowStretchAlphaFactor` 0 en los dos modos (6f074f2f), como el prototipo. El dueño las aprobó.
- Volúmenes en el mapa (600a434a, WebGL): las cajas, niveles y cascos de `VolumeShadowCaster` se dibujan otra vez en el
  mapa del sol, con su altura y mezcla max; en modo mapa su capa no se dibuja. **En WebGPU, en modo mapa, los volúmenes no
  tiran nada todavía** (la capa se esconde y esa pasada es solo GLSL).
- Rendimiento en Predator: el cuadro del sol de una tabla uniforme (d869b31a; pre-render −22.5 %, R-1055); los cuadros
  del sol en orden de entidades, por una función de módulo (8018aa0a; neutro, R-1060).

**Falta todavía:** la cache de lo quieto, el WGSL de los volúmenes en el mapa, la opacidad del caster en el mapa,
`footprintSolids` (el bug), las filas con clave en modo mapa (usa las completas), el costo de las columnas en escenas
grandes, `shadowOutlineCheck`, `sunShadowMapStressScene` y la captura del árbol sobre el auto para el dueño.

### F7. Sombras de los faroles (DX-SHADOW3D, parte 2)

- Prototipo A contra B en `lampShadowStressScene`; el dueño decide con los números.
- La opción elegida, con siluetas que miran a cada farol, la propia entidad ignorada y los presupuestos de hoy.

**Hecho cuando** un auto bajo un farol de 150 px tira una sombra corta y bajo uno de 40 px una larga (contra la fórmula
de DX-VOLLIGHTS), dos faroles se iluminan uno la sombra del otro, y Predator de noche queda dentro de lo fijado.

**Cómo quedó (rama), primera versión (2026-11-15, df3555b0, R-1065):** ni A ni B: una **opción C**, la idea del mapa del
sol llevada a una luz puntual. `lighting.lampShadows: 'map'` (por defecto `'sprite'`, las estampas de siempre). Un punto
(x, y, z) bajo un farol que está en el punto L del piso y a la altura E cae en el piso en L + ((x, y) − L) · E / (E − z),
con el estiramiento topeado en 8. Cada farol tiene un mosaico cuadrado (su radio alrededor, en el piso) en un atlas
(`src/render/lampShadowMap.js`) que guarda el punto caster más alto que cae en cada texel (mezcla max); un punto está en la
sombra de ese farol si donde cae su propio rayo hay algo más alto. Un mosaico por luz de estampa (las
`maxShadowCastingLights` con `castShadows` más cercanas a la cámara), de `lighting.lampShadowTile` texeles de lado (256;
de 32 a 1024); los casters son las filas de estampa del pre-render tal como están (`maxShadowsPerLight`, `shadowRange`).
En la pasada de luz, el aporte de cada farol con mosaico (piso y caras, conos y puntuales) se multiplica por su visibilidad
(cinco muestras en su mosaico): cada farol se saca por separado y dos faroles se iluminan uno la sombra del otro. Lo que
está a la altura del farol o más arriba no le tira sombra, y un farol con `elevation` 0 no tira ninguna. GLSL y WGSL.

- Las siluetas de un farol usan el cuadro que ve ese farol (5074f12a; un cartón fijo conserva su cuadro de frente), y un
  farol no se tapa con su propia entidad (918da75b: sus filas de estampa pierden la altura), en los dos modos. Las dos
  cosas también en las filas con clave (f764d0ac).
- La autosombra hacia cada farol con mosaico (F8, 7ac0817b).
- Escena dueña: `lampShadowStressScene` (72cee65d: `?lampShadows=map|sprite`, `?lamps=` 48, `?walkers=` 2000), sin medir.

**Falta:** medir en esa escena el mapa contra las estampas, la prueba contra la fórmula (faroles de 150 y 40 px; dos
faroles), Predator de noche, los volúmenes para los faroles (`setBox` / `addLevel` / `setHull` de F9, cierra
DX-VOLLIGHTS), la opacidad del caster en el mapa y las filas con clave en modo mapa (se usan las completas).

### F8. Autosombra (DX-SELFSHADOW)

**Hecho cuando** el auto y la cama del banco no muestran damero (captura aprobada), y `selfShadowStressScene` mide el
costo por pixel con 1, 2 y 4 rayos para elegir.

**Cómo quedó (rama), primera versión:** `lighting.selfShadow: true`. En la pasada de luz, un pixel con cara o con
heightmap da pasos hacia el sol sobre las alturas del face map (espacio de pantalla, como el relieve del banco); si una
superficie sube por encima del rayo, se saca el término directo del sol. Contra los puntitos: el primer paso salta los
vecinos del pixel, el sesgo crece con la distancia y la prueba se apaga cerca del terminador. En las formas de prueba
quedan unos pocos puntos en el terminador de la esfera (455 px en la captura). Faltan los faroles, WebGPU y el id de
entidad.

**Después (2026-11-15, R-1062):** WebGPU (496587e7) y los faroles (7ac0817b): con `lampShadows: 'map'` y `selfShadow`,
una cara o un sprite con mapas da pasos hacia cada farol que tiene mosaico, como hacia el sol (`selfShadowToward`, sin
pasarse del alcance), donde la luz de ese farol todavía cuenta (coseno mayor que 0.05). GLSL y WGSL. **Falta:** el id de
entidad (hoy cuenta las alturas de todo lo que está alrededor), medir 1, 2 y 4 rayos en `selfShadowStressScene`, y la
aprobación del auto y la cama sin damero.

### F9. `ShadowCaster` único (DX-CASTER)

- La API de §5.5, `.sun` / `.lamps`, valores por defecto por asset, `opacity`, `setWall`.
- `VolumeShadowCaster` y `LightOccluder` salen; Sun Street, Headlights, Buenos Aires y Predator migran.
- `lighting.raycasted` sale (venía de F1): `camera.pitch` 90 o 0 eligen el barrido de `setWall`.

**Hecho cuando** cada demo migrada captura igual (o mejor, con film y aprobación) y la tabla "what you want, what you
write" de la guía está reescrita.

**Cómo quedó (rama), primera parte (2026-11-15, fd5b866a, c07b5800, R-1064):** `shadowCaster.setSprite({ orient })`,
`setHeightMap()` y `clear()` valen para todas las luces; `shadowCaster.sun.*` y `shadowCaster.lamps.*`, para un tipo de luz
solo; gana el último. `opacity` (0 a 1, 1 al nacer) y `type` (se lee). Columnas nuevas `sunKind`, `lampKind` (`CAST_KIND`:
0 lo del sheet, 1 su cartón, 2 su sólido, 6 nada), `orient` y `opacity`; `CAST_KIND` se exporta (`src/index.js`, los
tipos).

- El pre-render revisa los casters cada 30 cuadros (`casterKindsInUse`). Cuando alguno pide lo suyo (un tipo, un cartón
  fijo, una opacidad menor que 1), las filas del sol pasan a ser completas y cada una lleva el código de su caster,
  −(código + 1), en su número de profundidad, que ningún programa de sombra lee; las estampas lo copian.
- La cabecera de los shaders de sombra lo decodifica, así que todo programa hecho con ellos lo tiene: las sombras de
  sprites saltean un NONE y escalan por la opacidad; los cartones y columnas del sol y de los faroles (GLSL y WGSL) tiran lo
  que pide el caster, y lo del sheet si no pide nada.
- `orient: 'fixed'` (c07b5800): el cartón queda a lo largo del objeto, por su ancla, muestra el objeto de frente (el cuadro
  de la tabla que mira a la cámara) y cada punto cae a lo largo de la luz, como la cerca del banco. El eje (el facing girado
  un cuarto) va en el código del caster en 64 pasos. Las cercas del banco lo usan.

**Cambios contra §5.5:** `opacity` todavía no entra en los mapas (sol y faroles), solo en las sombras de sprites; `type`
lee lo pedido para el sol, y sin pedir nada (AUTO) lee `'sprite'` aunque el sheet tire su sólido. **Falta (otra sesión lo
está terminando):** `setBox` / `addLevel` / `setHull` / `setWall`, `selfShadow`, `baseRadius`,
`setSprite({ frame, anchorX, anchorY, heightScale })`; después, migrar las demos, sacar `VolumeShadowCaster`,
`LightOccluder` y `raycasted`, y `CAST_KIND` en el WEED de los workers (`src/workers/workerWeed.js`, si no
`workerWeed.test.js` falla).

### F10. Emisivos y sombras parciales (DX-EMISSIVE)

- Los dos colores por pixel, `spriteRenderer.emissive`.
- Opcional: siluetas que sacan luz según su alpha (humo, borde de copas).

**Cómo quedó (rama), v1 (2026-11-15, 165f0ff3, R-1063):** `assets.spritesheets.<nombre>.emissive: true` (o
`meta.emissive` en su json) le da al sheet una página gemela cuyos pixeles opacos llevan el código emisivo donde iría la
normal (los bytes 0 y 255, que ninguna normal octaédrica alcanza; `emissiveTexels` en `spriteMaps.js`, que conserva las
alturas si las hay). La pasada de caras (GLSL y WGSL) escribe ese pixel como (1/255, 0) en el face map, en el orden del
pintor, y la pasada de luz le da luz plena: una fogata o una ventana encendida conserva su color de noche, y quien pasa
por delante la tapa. La profundidad por pixel lo ubica en el pie de su sprite. **Cambio contra §6.9:** no hay dos colores
por pixel; el pixel recibe luz plena y nada más (ningún brillo pasa de 1), y va por sheet, no por entidad. **Falta (v2):**
MRT y los dos colores (`color_con_luz × luz + brillo_propio`), `spriteRenderer.emissive`, `emissiveStressScene` y
`emissiveCheck`, y las sombras parciales.

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
| F1 `camera` | hecho | af40188 | `raycasted` pasa a F9; `frameChainWait` (presupuesto de reloj) falla a veces en esta máquina de 2 núcleos, también en la base |
| F2 `DirectionalSprite` | hecho (falta el ABAB del dueño) | 4bf4d21 … f439060 | resolución en la lógica, no en el pre-render; forma `frames` pendiente; R-1052: empate contra el selector a mano en esta VM |
| F3 mapas | en parte | 7d12c25, f4faf77, b2bf7c2, 4ee050f | página gemela y test de alineación; base de cada cuadro (elipse de una sola vista, apoyo de los renders) en la tabla de texturas (`frameBase.js`); faltan bake, `weed maps` (la tubería del banco web usaba Blender: `weed-mapas.zip`, fuera del repo) y medir la carga |
| F4 G-buffer | primera versión, WebGPU andando | f376849, 6601e884 | face map generalizado; en WebGPU la pasada de caras no validaba (binding 5 fuera del layout): arreglado y visto en GPU real; faltan `normals`/`surface`, id de entidad, MRT, microbench de GPU |
| F5 profundidad | primera versión, WebGL | 72d38271 | `renderer.pixelDepth`, sola con cámara oblicua y mapas (R-1061); todo pixel dibujado escribe; faltan WebGPU, solo los opacos, franjas de zIndex, `depthSortCheck` |
| F6 sombras del sol | §17.1 y §17.2 hechos; sombras más oscuras aprobadas | a323a1d, bb18952, 2222a32, 43f3d11, b8b4a24, 31319d4, 658fdd5, 952929f, d5dc4ef6, 496587e7, 265207b5, ac57e08d, d352144b, 600a434a | 17.1 (R-1053); filas con clave con el cuadro del sol (17.2); WebGPU del mapa y de los sólidos; el mapa saca `Sun.shadowAlpha`; cada sheet dice cómo tira (`meta.shadowCast`); volúmenes en el mapa (WebGL); `footprintSolids` apagado (bug); faltan cache, WGSL de los volúmenes, opacidad en el mapa, `shadowOutlineCheck` (R-1065) |
| F7 sombras de los faroles | primera versión (opción C) | df3555b0, 5074f12a, 918da75b, f764d0ac | `lighting.lampShadows: 'map'`, un mosaico por farol (`lampShadowTile`); cuadro que ve cada farol; sin su propia entidad; WebGL y WebGPU; `lampShadowStressScene` (72cee65d) sin medir (R-1065) |
| F8 autosombra | primera versión, sol y faroles | 2d1eb1e, d1de9e5, 496587e7, 7ac0817b | `lighting.selfShadow`, WebGL y WebGPU; hacia los faroles con `lampShadows: 'map'` (R-1062); falta el id de entidad |
| F9 `ShadowCaster` único | primera parte | fd5b866a, c07b5800 | `setSprite({ orient })`, `setHeightMap`, `clear`, `.sun` / `.lamps`, `opacity`, `type`, `CAST_KIND` (R-1064); la segunda parte (volúmenes, `setWall`, `selfShadow`, `baseRadius`, `frame`) la termina otra sesión |
| F10 emisivos | v1 | 165f0ff3 | `emissive` por sheet: luz plena en la pasada de luz (R-1063); faltan MRT y los dos colores (v2) |
| F11 vitrina | primera versión | 248fd7e, 3cbb60a, c656266 | `demos/lightBenchScene`: la granja del banco web (Quaternius en 32 direcciones, autos MinZinn, LPC, árboles, con sus mapas), persona con WASD, faroles, mapa del sol, autosombra, teclas para comparar; `?only`, `?lamps`, `?still`, `?zoom` para capturas; después `?fullRows`, `?lampMap=0`, `?sweep=1`, cada asset dice cómo tira (`meta.light3d.cast`), luz y sombras a la resolución del canvas |
| Rendimiento (Predator crowd 2.5) | la rama contra `main`: neutra por la regla, más cara de verdad | d869b31a, 0dfbc28c, 281c699a, 8018aa0a | R-1054 a R-1060: primer gate, regresión (lógica +25 %, pre-render +54 %); el cuadro del sol de una tabla uniforme (pre-render −22.5 %); doce lugares rápidos de componentes (lógica −13.6 %); segundo gate: lógica 5.85 → 6.65 ms, pre-render 5.89 → 7.34 ms, bases bajo el piso de 6 ms; el costo viene de la gente de Predator con `DirectionalSprite` |

## 17. Próximos pasos (para la sesión que sigue)

Lo que el dueño marcó mirando el banco de luz (`demos/lightBenchScene`) el 2026-11-14, en el orden en que va. **No probar
con la escena ni con el proyecto de Buenos Aires** (se actualizan después de estos cambios): se mira en el banco de luz y
en las stress scenes.

### 17.1 Sombras del sol como en el banco (las dos maneras)

**Hecho (2026-11-14, R-1053; falta la aprobación del dueño con las capturas):** la base sale de la tabla de texturas
(`frameBase.js`: la fila más baja opaca, la elipse de pies o tronco de lo que tiene una sola vista, el apoyo más bajo de
los renders, que es el más cercano a la luz porque el cuadro es la vista desde ella); el cartón cae a lo largo del sol con
la elevación real (tope `shadowMaxLengthRatio`) y sus columnas van a la derecha de quien mira desde el sol, en WebGL y
WebGPU. Cambio sobre el texto de abajo: un render con heightmap (8 direcciones o más) tira su sólido (columnas) también
en modo `'sprite'`, y lo de una sola vista (personas, árboles) su cartón aunque tenga mapas, en los dos modos: como el
banco, porque el cartón de un render toma las filas del techo como altura (el granero tiraba sombra de 530 px de alto,
mide 228) y el sólido de un árbol tapa la luz bajo la copa. Las columnas en modo `'sprite'` son WebGL por ahora.
Encontrado en el camino: Pixi dibuja con mezcla normal una malla que es la raíz del render, así que el `max` del mapa
del sol no se aplicaba (arreglado con un contenedor); el WGSL de la pasada de caras con mapas (`mainFragFace`,
`@group(2) @binding(5)`) no valida en WebGPU (ya estaba antes: va con 17.3); las sombras del modo mapa salen suaves.

**Después (2026-11-15):** el dueño casi no veía las sombras: a las 16 h el mapa sacaba 13 % de la luz del piso, y las del
prototipo eran unas 60 % más oscuras que el piso al sol. El mapa saca ahora `Sun.shadowAlpha` del sol (ac57e08d) y el
banco usa `shadowAlpha` 0.7 y `shadowStretchAlphaFactor` 0 (6f074f2f); el dueño aprobó las sombras más oscuras. Las
columnas del modo `'sprite'` y el mapa andan también en WebGPU (496587e7), y la pasada de caras con mapas valida
(6601e884). Las sombras suaves del modo mapa eran la resolución: el banco pasó la luz y las sombras al tamaño del canvas
(0ccf07b9; su costo va a la fase de medición).

Hoy la sombra de un cubo no se parece a la del banco. Faltan dos cosas que el banco tenía:

- **La base.** El cartón de la silueta tiene que pararse en la fila más baja opaca del cuadro, no en el ancla del sprite
  (en las formas, el ancla está en el medio de la huella y la sombra sale corrida). Esa fila ya está en la tabla de
  texturas: el fondo del recorte, `aInstTrim.y + aInstTrim.w` en px del cuadro (`instancedSpriteShadow.vert.glsl`, y la
  tabla de `instancedSpriteBatch.js`, `writeLutSlot`; con `assets.trimImages` apagado, el fondo del cuadro). En el
  shader, con `local = (content - anchor * size) * scale`:
  `baseY = (trimBottom - anchor.y * size.y) * scale.y`, `z = max(baseY - local.y, 0) / heightScaleY * height`, el pie del
  cartón en el piso en `(xy.x, (xy.y + baseY) / floorScaleY)`, y cae en `pie + local.x * perp - z * k`. Es lo que ya hace
  la tarjeta del modo mapa (`sunMapVertex` en `src/render/sunShadowMap.js`) salvo que hoy toma el pie en el ancla.
  Después: para lo que tiene huella, el apoyo más cercano a la luz (la tabla de sombra por cuadro de F3: alcance de los
  pixeles del heightmap cerca del piso hacia 16 direcciones), como `baseSupport` en el banco.
- **La proyección en modo `'sprite'`.** La rama del sol de `instancedSpriteShadow.vert.glsl` (la que no es de farol)
  todavía espeja y estira el dibujo en pantalla (`sy = -abs(scale.y) * height * uSun.z` y la rotación por la dirección
  de la sombra). Tiene que ser el mismo cartón proyectado sobre el piso que el modo mapa, escrito como alfa en la capa de
  sombras: uniformes `uSunK` / `uSunPerp` en los del sol de `InstancedSpriteBatch` (`sunUniforms`), que `pixiWorker`
  escribe en `_drawGpuCasterShadows` desde `_writeFaceSun` y `sunMapTerms`. Las variantes con clave e indexadas
  (`spriteIndexedVertex(..., { shadow })`) reescriben solo atributos de la cabecera: la cola nueva pasa por ellas. Las
  filas de farol (estampas) quedan como están hasta F7. Hacer también `instancedSpriteShadow.wgsl` (WebGPU).
- Cambia cómo se ven las sombras del sol de todas las escenas en modo `'sprite'` (Predator, Sun Street): capturas antes
  y después, y aprobación del dueño.

### 17.2 Filas con clave que traen el cuadro de la sombra (no perder la optimización)

**Hecho (2026-11-14, d5dc4ef6):** el cuarto número de la fila con clave (era un cero) lleva el cuadro que ve la luz,
±(textureId + 1) con el signo como espejo; el pre-render lo escribe después del barrido (`_applyKeyedSunFrames`), las
estampas lo copian con la fila y los shaders con clave (GLSL y WGSL) lo usan. Filas con clave contra completas
(`?fullRows=1` del banco): idénticas byte por byte, con faroles y sin, WebGL y WebGPU. `lighting.directionalCasters`
queda solo para E-191 (las instancias del lote no tienen lugar para otro cuadro). **El gate de la rama contra `main`
dio regresión** (Predator crowd 2.5, `--full-rev`, 4 pares): lógica 6.00 → 7.47 ms (+25 %), pre-render 6.13 → 9.43 ms
(+54 %). Perfil de CPU: el cuadro del sol de 38 000 personas (atan2 + `pickDirection` por caster, 30 % del pre-render),
`DirectionalSprite.resolve` (0.6 ms de cada worker de lógica) y el getter lento de `SpriteRenderer` (`requires` lo
agregaba al final de la lista, fuera de los 8 lugares rápidos). Arreglos: el cuadro del sol de una tabla uniforme es la
dirección dibujada más el giro del sol en pasos (d869b31a), y lo requerido va justo antes de lo que lo pide.

**Después (2026-11-14 y 15, Predator crowd 2.5, 4 pares cada sesión; límites de detección del A/A: lógica ±13.4 %,
pre-render ±8.7 %):**

| Cambio | Commit | Resultado | Registro |
| --- | --- | --- | --- |
| El cuadro del sol de una tabla uniforme | d869b31a | pre-render 9.34 → 7.21 ms (−22.5 %, 4/4): se queda | R-1055 |
| Lo requerido justo antes de lo que lo pide, solo | 0dfbc28c | lógica 6.81 → 7.53 ms (+7.8 %, 4/4 peor, dentro del límite): neutro; la gente tiene 11 componentes y el FSM quedó noveno | R-1056 |
| Doce lugares rápidos de componentes, no ocho | 281c699a | lógica 7.39 → 6.43 ms (−13.6 %, 4/4): se queda | R-1057 |
| Los cuadros del sol en orden de entidades, como método del worker | (no entró) | pre-render 7.31 → 9.70 ms (+31 %): regresión (el método quedaba en Maglev) | R-1059 |
| Lo mismo como función de módulo | 8018aa0a | pre-render 7.51 → 7.76 ms (+1.8 %): neutro; mismos cuadros byte a byte | R-1060 |

Segundo gate de la rama contra `main` (R-1058): lógica 5.85 → 6.65 ms, pre-render 5.89 → 7.34 ms, 4/4 peor cada uno;
las dos bases quedan bajo el piso de 6 ms, así que por la regla es neutro, pero el costo es real y viene de la gente de
Predator con `DirectionalSprite`. `lighting.directionalCasters` sigue solo para E-191.

`b8b4a24` apagó los caminos con clave (E-191 / E-211) cuando una clase tiene `DirectionalSprite` y `ShadowCaster`
(`lighting.directionalCasters`), porque leen el cuadro del propio sprite. Eso no se queda así: el motor tiene que seguir
igual de optimizado.

- E-211 (filas con clave del pre-render, `packKeyedCastersScanWasm` en `wasm/gpuPack.c`, `GPU_KEYED_CASTER_FLOATS`):
  agregar a la fila un id de textura de sombra (0 = el del sprite). El pre-render lo escribe para los direccionales con
  la misma cuenta que `_applySunFrames` (`preRenderWorker.js`: dirección vista desde el sol, misma vuelta del ciclo,
  espejo); el shader de sombras con clave (`makeKeyedCasterShader`, `makeKeyedSunShader` en `instancedSpriteBatch.js`)
  usa ese id cuando no es 0. Medir la fila nueva con `gpuPackMicrobench` (o el kernel del pack que corresponda).
- E-191 (instancias del lote de entidades, `_keyedSunFor`): no tiene dónde llevar otro cuadro; con casters
  direccionales, usar E-211.
- Después, sacar `lighting.directionalCasters` y sus dos chequeos (`_keyedCastersLive`, `_keyedSunFor` /
  `_ensureKeyedCasters`), y pasar el gate de Predator contra `main`.

### 17.3 Estado (2026-11-15) y lo que falta

**Hecho en la rama:** F1; F2 (falta el ABAB del dueño); F3 en parte (página gemela, base de cada cuadro); F4 primera
versión, WebGL y WebGPU; F5 primera versión, WebGL; F6 con §17.1 y §17.2, WebGPU, volúmenes en el mapa (WebGL), cada sheet
dice cómo tira, sombras más oscuras aprobadas por el dueño; F7 primera versión (opción C), WebGL y WebGPU, con el cuadro
que ve cada farol y sin su propia entidad; F8 hacia el sol y los faroles, WebGL y WebGPU; F9 primera parte; F10 v1; F11
primera versión (el banco). El detalle, en el «Cómo quedó» de cada fase y en el registro (R-1053 a R-1065).

**Hecho después, en la primera ronda de agentes (2026-11-15, mergeado en la rama, sin probar todavía salvo lo dicho):**

- WebGPU: la profundidad por pixel (F5), los volúmenes en el mapa del sol y en el de los faroles, la textura de huellas
  (2d8ef7aa). El error de `uFoot` en WebGPU (el programa de columnas de los faroles nombraba el binding 7 en su layout
  sin declararlo en su WGSL, c99e57b0) y un test que compara cada layout con su WGSL (cabf1291). El banco a las 16 h da
  la misma imagen en los dos backends; a las 22 h cambian 380 px, por 6/255 como mucho.
- F9, segunda parte (ed4c34e5): `setBox` / `addLevel` / `setHull` (por `VolumeShadowCaster`), `setWall` (por
  `LightOccluder`), `setSprite({ frame, scaleX, scaleY, anchorX, anchorY, heightScale, orient })`, columnas
  `baseRadius` y `selfShadow`; `CAST_KIND` en el WEED de los workers (9a36ef3a).
- F3 (fcfd0a59): los mapas en el bigAtlas preempaquetado y `npm run maps` (`scripts/bakeBigAtlas.mjs`,
  `scripts/weedMaps.mjs`).
- `footprintSolids`: el granero perdía las paredes porque la página gemela se corrompía al leerla de un canvas
  premultiplicado (06eaca56); prendido por defecto.
- Filas con clave: los cuadros que ve cada farol y la propia entidad. Claves de config `lampShadowTile` y
  `pixelDepth` con valor por defecto.

**Falta:** lo de la segunda ronda (§17.4); la fase de medición: las stress scenes, el microbench de GPU y las pruebas
contra fórmula que hace esa ronda, `lampShadowStressScene` (mapa contra estampas), Predator con `?light3d=1` de día y
de noche en los dos backends, el ABAB de `directionalSpriteStressScene` del dueño (`?mode=hand|ds`), lo que cuestan la
luz y las sombras a la resolución del canvas en el banco, y el scoreboard (la rama contra `main` sigue más cara en
Predator, R-1058); después, la optimización. **Aprobaciones del dueño:** la captura del árbol sobre el auto (F6), el auto
y la cama sin damero (F8), la profundidad del banco (F5).

### 17.4 Segunda ronda de agentes (2026-11-15)

La regla del dueño: un plan, la implementación en paralelo, y después se prueba y se mide todo. Cada agente trabaja en su
worktree (`D:/xampp/htdocs/weed-par-*`) y su rama, con sus archivos y ningún otro; sin tests, capturas ni mediciones
(solo `node --check`), un commit por cambio, sin push. Lo que necesite de un archivo ajeno lo anota en su informe.

| Agente (rama) | Qué hace | Sus archivos |
| --- | --- | --- |
| R (`dx/par-render`) | F4: `normals` / `surface` en `SpriteRenderer`, el id de entidad en el G-buffer (autosombra, la propia entidad), MRT como alternativa a la segunda pasada; F10 v2: dos colores por pixel, `spriteRenderer.emissive`; `selfShadow` y `baseRadius` del caster en el render; la opacidad del caster en los mapas; F5: solo los opacos escriben profundidad, franjas de zIndex, cortes con partículas GPU | `src/workers/pixiWorker.js`, `src/workers/preRenderWorker.js`, `src/render/**`, `src/shaders/**`, `src/components/spriteRenderer.js`, `src/core/spriteSheetRegistry.js` |
| B (`dx/par-caster2`) | F9: `VolumeShadowCaster` y `LightOccluder` dejan la API pública (una clase lista solo `ShadowCaster`); `lighting.raycasted` sale (`camera.pitch` 90 o 0); `type` con AUTO dice lo que tira el sheet; las demos, las stress scenes existentes y la guía migradas (Buenos Aires al final: solo el cambio de API, sin probarla) | `src/components/{shadowCaster,volumeShadowCaster,lightOccluder,meshRenderer}.js`, `src/core/{scene,gameObject}.js`, la config, `src/index.js`, `types/weed.d.ts`, `src/workers/workerWeed.js`, `demos/**` menos Predator y el banco, `tests/bench/stressScenes/**` existentes, `docs/guide/**` |
| C1 (`dx/par-stress`) | Las stress scenes de §10 que faltan: `sunShadowMapStressScene`, `selfShadowStressScene`, `depthSortStressScene`, `emissiveStressScene`, con sus filas en `engineFeatureCatalog.mjs` | archivos nuevos en `tests/bench/stressScenes/`, `tests/bench/engineFeatureCatalog.mjs` |
| C2 (`dx/par-checks`) | El microbench de GPU (§9.3) y las pruebas contra fórmula de §8.2 | archivos nuevos en `tests/bench/` |
| D (`dx/par-showcase`) | Predator migrado y con `?light3d=1` (F11); el banco como vitrina (§11) | `demos/predatorScene/**`, `demos/lightBenchScene/**`, `tools/fromLightBench.mjs` |

Quedan para la optimización, después de medir: la cache de lo quieto (F6), el costo de las columnas en escenas grandes,
los códigos por caster en las filas con clave (hoy fuerzan filas completas) y el cuadro de la sombra en las instancias del
lote (E-191).

### 17.5 Cómo quedó la segunda ronda (2026-11-15, mañana)

Las cinco ramas están mergeadas en `dx/light3d` (sin push): C1 (9989e648), C2 (df7fcb2d), B (b8da4adc), D (e5a64592)
y R (f4e187e0). Ninguna corrió tests; los corrí al juntarlas: `test:node` 2721/2721, `test:demos` 101/101, `check:types`.

- **R:** `SpriteRenderer.normals` / `surface` / `emissive` (columna `gbufFlags`), el id de entidad en un segundo destino
  RGBA8 del G-buffer, `lighting.gbuffer: 'pass' | 'mrt'`, emisivos v2 (dos colores, capa de brillo), `baseRadius` y
  `selfShadow` del caster en el render, la opacidad del caster en los mapas, y F5 v2 (solo los opacos escriben profundidad,
  pasada de bordes, franjas de zIndex). Los mapas guardan su caster más alto con prueba de profundidad y su id, y un pixel
  no recibe la sombra de su propia entidad: arregla N-181 (la casa pintada por su propia sombra en modo mapa).
- **B:** `VolumeShadowCaster` y `LightOccluder` son internos (`ShadowCaster` escribe sus columnas); los volúmenes piden
  `lighting.maxVolumes` (sin él, nada: ni capa ni arena); `lighting.raycasted` sale de `camera.pitch` 90 o 0; `type` con
  AUTO lee `castsSolid`; `setTexture` / `heightMultiplier` / `anchorOffset` pasan a `setSprite`; demos, stress scenes y guía
  migradas (Buenos Aires solo el cambio de API, sin correrla). Queda `lighting.shadowTextures` (lo leen pre-render y Pixi).
- **C1:** `sunShadowMap`, `selfShadow`, `depthSort` y `emissive` StressScene con sus filas del catálogo. **C2:** el
  microbench de GPU (`gpuPassBench.mjs`) y las seis pruebas contra fórmula. **D:** Predator con un solo `ShadowCaster` y
  `?light3d=1`; el banco como vitrina (panel por elemento, código, luces).

**Lo que encontró la fase de pruebas hasta ahora:** N-183 (la autosombra de R en las caras que no ve la luz ennegrecía las
paredes del granero; arreglado en 8698ed16), N-184 (aviso de `aInstGbuf` en WebGL; 9681e069), la clave
`lighting.maxVolumes` en las escenas que tiran volúmenes (Predator light3d, C1, C2), el aviso del bigAtlas de más de 4096
(salía siempre que una escena lo pedía). Las 21 escenas migradas por B: las quietas dan iguales byte a byte; las que se mueven,
igual que un A/A. El banco a las 16 y 22 h en los dos backends: mismos números en WebGL y WebGPU.

**Rendimiento ya medido:** E-364 (la dirección de un tipo escalonado se resuelve en sus cuadros de tick): lógica −32,4 % en
`directionalSpriteStressScene` (R-1119). Anotadas para medir: E-363, E-365 a E-370 (§E del EXECUTION_PLAN).

### 17.6 La fase de pruebas y medición (2026-11-15, mediodía)

**El microbench de GPU medía mal en WebGL (N-193):** `gl.finish()` de Chrome es un flush; un pase medido después de otro
salía con el tiempo del primero. Ahora espera con una lectura de un píxel (26e860e0). E-366 y E-367 eran eso (rechazadas).

**Lo que se ganó, en el bench de GPU (GTX 1650) y en su escena:**

| Cambio | Pase (WebGL / WebGPU) | Escena |
| --- | --- | --- |
| E-365: GLSL ES 3.0 (ANGLE aplanaba los cortes) y la autosombra de un farol solo dentro de su radio | selfShadow 3,33 → 1,61 / 3,54 → 1,60 ms | selfShadowStressScene 32 faroles 41,8 → 60 fps |
| E-374: la profundidad de los mapas sale del vértice (el fragmento la escribía y apagaba el early-Z) | sunMap 1,04 → 0,67 / 1,03 → 0,53; columnas 1,85 → 0,71 / 1,77 → 0,53 ms | sin cambio visible a 60 fps |
| E-375: la columna de un caster se corta donde su rayo sale del tile del farol | lampMap 4,11 → 1,45 / 4,17 → 1,40 ms | a 60 fps las dos (pre-render manda) |
| E-376: la grilla de columnas indexada (4 vértices por celda, no 6) | columnas −12 a −19 % | sunShadowMapStressScene 15 000 columnas 17,2 → 23,8 fps |
| E-377: `lighting.gbuffer: 'mrt'` por defecto (un pase con dos destinos) | 0,80 → 0,51 / 0,75 → 0,52 ms a resolución 0,5 | misma imagen, 3 → 2 pases |

**Bugs:** N-180 (los setters del sol no movían las sombras; dd640931), N-186 (los contadores de zIndex y brillo tras
restaurar una partida; 88bb89e9), N-192 en parte (el piso tomaba el sesgo de los mapas: toda sombra quedaba 4 |k| px
despegada de su base; c8963250, contornos 2,6–3,5 → 1,4–1,6 px). N-187 corregido: con conteos distintos las palabras del
G-buffer van en cero (con animaciones de Adobe, siempre).

**Sin regresiones contra main** en las 16 filas del catálogo que no usan lo nuevo (R-1132): las dos señales (spotLights,
spawnStorm) eran deriva y no aparecieron en pares ABAB.

**Queda abierto:** E-373 (light3d 11 % más caro en WebGL que en WebGPU), E-378 (la profundidad por pixel +30 % / +90 % en el
pase de color), E-371 / E-372 (el milisegundo de los cuadros de sombra direccionales en el pre-render de Predator), N-185,
N-187 (Adobe), N-188, N-189 y el resto de N-192 (un 1,5 px uniforme, las columnas del cajón, la escalera del tope).

### 17.7 El banco contra el prototipo, y los autos y la gente estándar (2026-11-15, tarde)

El dueño probó el banco y comparó con su prototipo ("Banco de luz y sombras", artifact RcVVdz6bEo7GiErDNGZSKK). Para
compararlos bien, los archivos del prototipo se bajaron y corrieron al lado del banco con el mismo sol (el azimut del
prototipo es 180 − `Sun.angle` del engine, que dice hacia dónde caen las sombras) y las mismas cosas giradas igual.

| Qué | Causa | Arreglo |
| --- | --- | --- |
| Silueta de autos, mesa y granero girada | N-197: una hoja que por defecto tira su sólido dejaba a la silueta con el cuadro de la cámara | El cuadro de cada luz se decide por caster (e90de4dc) |
| Sombra de silueta de la pickup y el colectivo desfasada | N-200: los autos elegían cuadros por los pasos nominales del pack (7,5°); el dibujo no está a esos ángulos | Direcciones por el ángulo medido de cada cuadro, como el prototipo (b48a15f2) |
| Sombra de farol pixelada | N-196: tile fijo de 256 texels para 2 × alcance | `lampShadowTile: 'auto'` por alcance y resolución (cf3e8ff1) |
| Escalones en la sombra del granero | La grilla fija de 24 × 24 columnas (celdas de 18 px) | E-379: bloques de grilla para los renders grandes (celdas de 6 px) (ef2e71e0) |
| Alturas de mapas a escala 1 en un sprite escalado | N-194 | La altura del mapa por `|scale y|` en luz, profundidad y mapas de sombra (67e33035) |
| Banco borroso al lado del prototipo | Atlas con filtro lineal y autos a 2× | `atlasScaleMode: 'nearest'` en el banco (3cf5c1bf) |
| Caja y casco sin volumen | N-198: sin `maxVolumes` | 64 volúmenes de 24 vértices (3cf5c1bf) |
| Muebles un cuarto de vuelta girados | N-201: el banco usaba la convención de los autos para todo | 90° − giro para los props (0adb3656) |

**E-379, de paso:** el pase de columnas corría su grilla para cada fila de caster y descartaba en el shader las que no
tiran columnas (personas, árboles). gpuPassBench: 20 renders, 0,096 ms; los mismos entre 2 000 siluetas, 5,107 ms con la
misma imagen. Ahora cada pase recibe solo sus filas. Falta medirlo en una escena (Predator `?light3d=1`).

**Explicados sin bug:** el farol frío no tira sombras (`castShadows` apagado); la auto-sombra funciona y es sutil
(ventanas, puertas); el aljibe "raro" estaba metido dentro del granero y la profundidad por pixel dibuja la intersección
(N-199). N-195 se cerró: era N-197.

**Autos y gente estándar (DX-STDSPRITES):** `demos/img/autos` con los 54 vehículos del pack de Buenos Aires y sus mapas
(nm-core, la herramienta de Claude web, en `demos/tools`), y civil1..7 y poli con sus mapas. El banco, sus escenas de
prueba, carScene, littleCity, la calle de día y la de noche usan esos; se borraron `demos/img/cars` y las copias del banco.

**Queda abierto:** medir E-379, N-194 (un varying más) y N-196 en escena; N-188 (retirar `lighting.shadowTextures` con
una marca por cuadro del pre-render); E-371/E-372/E-373/E-378, N-185, N-187, N-189 y el resto de N-192.

### 17.8 La noche en el banco, y el mapa panorámico de los faroles (2026-11-15, noche)

El dueño miró el banco de noche y de día y fue tirando lo que veía. Hecho:

| Qué | Causa | Arreglo |
| --- | --- | --- |
| El auto blanco y la vaca, con mapa de altura para los faroles, tiraban la sombra de sí mismos girados (90° el auto) | N-203: las filas de los faroles tomaban el cuadro que ve el farol salvo en hojas que tiran sólido con el sol; un auto tira cartón con el sol y columnas con los faroles | El cuadro de cada luz por caster, como decide el pase de columnas (d2b8c392) |
| Las sombras de un farol no se apagaban en su alcance: corrían oscuras hasta el borde cuadrado de su mosaico | N-204: la caída I / (I + d²) nunca llega a cero | La luz termina en su radio: × (1 − (d / radio)⁴)², como Unreal y Godot y como el prototipo (c6880f7e; light3d +5,6 % WebGL, E-380 para recuperarlo) |
| La sombra del árbol atravesaba el granero hasta su pared de atrás | N-208: el mapa del sol guarda el caster más alto de cada rayo y un pixel salta el de su propia entidad | Una cara a la que no llega el sol no toma sombras de otros (3baefdbc) |
| La silueta de la cerca no era paralela a la cerca | N-209: el eje del cartón fijo salía del facing (15°) y el dibujo es el cuadro más cercano (11,25°) | El eje sale de la dirección dibujada (65c4a83d) |
| Las sombras suaves al lado de las del prototipo, nítidas sobre los pixeles del dibujo | La pasada de luz sombrea por pixel de pantalla y promedia cinco muestras | `lighting.pixelArt` (DX-PIXELSHADOW, 8e58d474), prendido en el banco |

Explicados sin bug: la casita y la mesa con silueta bajo un farol alto salen iguales que en el prototipo (N-205); el cartón de
un render es más ancho y más alto que la cosa (N-207, se arregla con lo de abajo). Abierto: N-206 (el gate de Predator con
crowd 2,5 que dibujó menos filas en tres corridas).

**El mapa panorámico de los faroles (DX-LAMPPANO, aprobado por el dueño).** El mapa de hoy (F7, opción C) proyecta cada
punto caster sobre el piso desde el farol; un punto más alto que el farol no tiene adónde caer (cuenta como iluminado: bajo un
farol de 20 px la sombra de la cerca no trepa por la pared del granero), y uno cerca de la altura del farol cae en el
infinito (el estiramiento topeado en 8 hace los escalones de N-192). El diseño:

- **Dos mitades por farol.** El mosaico de cada farol pasa a 2S × S texeles: la mitad izquierda (piso) para lo que está más
  bajo que el farol, como hoy; la derecha (techo) es la misma mitad para el mundo reflejado en la altura del farol: un punto
  a altura z > E se dibuja a z' = 2E − z. Las dos mitades guardan la altura (reflejada) más alta de cada caída, y un punto
  receptor hace la misma prueba (lo guardado > su altura, reflejada si está arriba del farol, más el sesgo).
- **Hasta el horizonte, sin tope.** La caída v = (p − L) · E / (E − z), R = |v|: dentro del alcance lineal hasta 0,8 del
  radio del medio mosaico (la resolución de hoy, 20 % menos), y de ahí al borde el resto del mundo, 0,8 + 0,2 (1 − alcance / R):
  el horizonte en el borde. Sin el tope de 8.
- **Cartones y columnas en tres filas.** La fila de la base, la de donde su caída cruza el alcance y la de la punta: la banda
  de adentro es exacta (proyectiva, como hoy) y la de afuera aproximada (sólo la usan las paredes cerca de la altura del farol).
  El cartón deja de ser el quad del lote: una tira de 6 vértices que comparte los atributos de las filas, como las columnas.
  Con eso, N-207: el alto del cartón de un render a su altura de mapa y su ancho a su huella.
- **Volúmenes**, en la mitad del piso con la caída comprimida (la del techo después).
- **La pasada de luz** elige la mitad por la altura del punto y lee con la misma caída comprimida.
- **Medir:** gpuPassBench lampMap y light3d antes y después, lampShadowStressScene, y capturas: la cerca contra la pared del
  granero bajo un farol de 20 px, un cajón bajo un farol más bajo que él (N-192), la vaca y el auto de N-203.

**Más tarde esa noche:** la sombra de la persona sobre la pared bajo un farol bajo (el sesgo a lo largo del rayo, 4f5451c7;
el mapa guarda el lugar a lo largo del rayo, N-211, 437d81f3), la persona de espaldas al sol dentro de la sombra del
granero (N-208 sólo para volúmenes cerrados y el sesgo de 2 px para un pixel con id, N-210, 6083e8be). N-207 queda como
está por pedido del dueño (el cartón por el ancla arreglaba una cara pero cambiaba la sombra de todos los autos).

### 17.9 Plan de optimización y mediciones (2026-11-15, noche)

El dueño dio por bueno lo visual ("está todo bien ahora, dejemos todo así") y pidió seguir con la optimización de las luces
y estas mediciones: (1) DirectionalSprite en MySoldier y Civilian contra main; (2) DirectionalSprite en carScene y
littleCity contra main; (3) cuánto cuestan las sombras en Predator ahora contra main; (4) burningBoxes, que es de costado;
(5) stress scenes nuevas que comparen contra main y sirvan para los traces, para ver qué de lo nuevo se puede optimizar.

**Fase 0, que la medida sea confiable.** N-206 primero: en el gate de Predator con crowd 2,5 el lado nuevo dibujó 5 a 30 %
de las filas en tres de cuatro corridas, y physics +49 %. Correr la rama y main mirando por corrida los soldados vivos, el
zoom de la cámara y las filas: si en la rama mueren los soldados, algo de la rama toca el juego (bug); si es azar, el gate
se mide con la cámara fija (el `?zoom=` de Predator), para que la carga no dependa de la partida. Antes de cada sitting:
corriente alterna y ningún otro Chrome de benchmarks.

**Fase 1, lo que la rama le cobra a todos** (contra main, sin la luz nueva; ABAB con worktrees, 4 + 4 pares, ventana
visible):

| Escena | Qué mira | Workers |
| --- | --- | --- |
| Predator crowd 2,5 (cámara fija) | DirectionalSprite en la gente (1); las sombras de siempre, estampas (3) | logic, pre-render, Pixi |
| carScene, littleCity | DirectionalSprite en los autos (2) | logic, pre-render |
| burningBoxes | una escena de costado, luz raycasted (4) | Pixi, pre-render |
| filas del catálogo con luz (spotLights, flashlight, lightGallery) | la luz que termina en su radio (N-204), los sesgos | Pixi |

**Fase 2, cuánto cuesta cada parte nueva**, prendida y apagada en su escena (la rama sola), y en la GPU con gpuPassBench:

- Predator `?light3d=1` de día y de noche contra Predator sin light3d (3).
- Las stress scenes de la segunda ronda (sunShadowMap, selfShadow, depthSort, emissive), lampShadowStressScene (el
  panorámico, piso y techo) y directionalSpriteStressScene (`?mode=hand|ds`).
- Nuevas (5): (a) "luz 3D completa", la misma población en main y en la rama (en main sombras de sprite y luz plana; en la
  rama lo mismo, con switches a mapas, G-buffer, autosombra, profundidad por pixel): la diferencia es lo que cuesta lo nuevo;
  (b) "faroles a escala", de 48 a 128 faroles con mapa sobre miles de casters (el panorámico y la elección de cuadros por
  farol); (c) "renders con columnas", cientos de renders con mapas de altura bajo el sol y los faroles (las columnas, E-379).

**Fase 3, deep traces** en las escenas que más cuestan: CPU por función, deopts (`--log-deopt`), heap
(heapSampleWorkers), contadores PMC (WPR) y la GPU por pase. Cada hallazgo, una fila del registro.

**Fase 4, optimizar** por costo por qué tan común es: las candidatas anotadas (E-363, E-370 a E-372, E-373, E-378, E-380,
E-381, la caché de lo quieto de F6, los códigos por caster en las filas con clave, E-191) y lo que salga de las fases 1 a 3.
