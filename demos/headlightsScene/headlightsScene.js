// Headlights — the light API on one street at night: carScene's cars with cone headlights, round street lamps, and
// houses with geometry for their shadows, under raycasted lighting.
//
//   LightEmitter            radius, color, brightness, elevation, glow, glowOffsetY, offsetX, castShadows, shadowRange
//   cone lights             coneAngle, coneSoftness, direction: the cars' headlights (nightStreet.js, Car)
//   lighting.raycasted      lights are stopped by LightOccluders: the houses and the cars cut the beams
//   lighting.groundScaleY   the floor is drawn 0.7 as tall (carScene's pictures are), and so are pools and cones
//   VolumeShadowCaster      the houses and cars as volumes, for the sun's shadows by day (N)
//
// The panel's keys (C V F B K R G N) change one field of every headlight (or lamp) at a time; nothing else changes.
// The road, its meshes and the panel are Sun Street's: this scene is about the lights.
//
// URL: ?hour=22 (15 is day), ?cars=6, ?carSpeed=3, ?raycast=0 (basic lighting: sprite shadows instead of occluders),
// ?backend=webgpu.
// WASD or arrows pan, the wheel zooms, H hides the panel.

import WEED from '/src/index.js';
import { LAP, ROAD_CX, ROAD_CY, ROAD_WIDTH, WORLD_H, WORLD_W } from '../sunStreetScene/streetLayout.js';
import { RoadBand, RoadDashes } from '../sunStreetScene/gameObjects/streetMeshes.js';
import { SunPanel } from '../sunStreetScene/sunPanel.js';
import { Car, HEADLIGHT, House, LAMP, StreetLamp } from './nightStreet.js';

const { Scene, Camera, Keyboard, Sun, Transform, LAYER_KIND } = WEED;

const param = (key, fallback) => Number(WEED.params?.get(key) ?? fallback);
const CARS = Math.max(0, Math.floor(param('cars', 6)));
const RAYCAST = param('raycast', 1) === 1;
const BACKEND = WEED.params?.get('backend') === 'webgpu' ? 'webgpu' : 'webgl';

const NIGHT_HOUR = 22;
const DAY_HOUR = 15;
const START_HOUR = param('hour', NIGHT_HOUR);
const DEG = Math.PI / 180;

// What the panel's keys step through, the first value being the one each light spawns with.
const APERTURES = [HEADLIGHT.coneAngle, 30 * DEG, 100 * DEG];
const SOFTNESS = [HEADLIGHT.coneSoftness, 0, 1];
const BRIGHTNESS = [1, 0.4, 1.8];
const SHADOW_RANGES = [0, 150]; // 0 is the light's radius

const HOUSE_ROWS = [
  { y: 320, xs: [330, 630, 930, 1230, 1530] },
  { y: 680, xs: [480, 780, 1320] },
  { y: 1040, xs: [330, 630, 930, 1230, 1530] },
];
const LAMPS = [
  [555, 345], [855, 345], [1155, 345],
  [450, 852], [750, 852], [1050, 852], [1350, 852],
];
const CAR_SHEETS = ['red', 'yellow', 'blue', 'white', 'black', 'poli'];
const HOUSES = HOUSE_ROWS.reduce((sum, row) => sum + row.xs.length, 0);

export class HeadlightsScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: 11,
    spatial: { cellSize: 128, maxNeighbors: 128, noLimitFPS: false },
    logic: { noLimitFPS: false },
    physics: { noLimitFPS: false, gravity: { x: 0, y: 0 } },
    particle: { noLimitFPS: false, maxParticles: 0, decals: false },
    renderer: {
      backend: BACKEND,
      noLimitFPS: false,
      ySort: true,
      // The road's meshes (two bands and the dashes); the volumes of VolumeShadowCaster get their own share on top.
      maxMeshVerts: 2048,
      maxMeshIndices: 4096,
    },
    layers: {
      grass: { kind: LAYER_KIND.TILING, texture: 'grass', tileScale: 1, parallax: 1, zIndex: 0 },
      sidewalk: { kind: LAYER_KIND.MESH, zIndex: 0.45 },
      street: { kind: LAYER_KIND.MESH, zIndex: 0.5 },
    },
    lighting: {
      enabled: true,
      baseAmbient: 0.05,
      raycasted: RAYCAST,
      // carScene's cars are drawn with the floor 0.7 as tall: the pools and cones are foreshortened the same way.
      groundScaleY: 0.7,
      maxLights: 32, // 7 lamps and up to 25 cars in view
      shadowsEnabled: true, // the sun's shadows (VolumeShadowCaster), and the lamps' sprite shadows with ?raycast=0
      sun: {
        enabled: true,
        dayCycle: { enabled: false }, // the hour only moves with N (create sets it)
        shadowAlpha: 0.7,
        night: { intensity: 0.12, color: 0x4a6cff, from: 0.4, to: 0.1 }, // a blue night, so the street is not black
      },
    },
  };

  static assets = {
    textures: {
      grass: '/demos/img/bg.png',
      house1: '/demos/img/house1.png',
      house2: '/demos/img/house2.png',
      tallLight: '/demos/img/tallLight.png',
    },
    spritesheets: Object.fromEntries(
      CAR_SHEETS.map((name) => [`car_${name}`, { json: `/demos/img/cars/${name}.json`, png: `/demos/img/cars/${name}.png` }]),
    ),
  };

  static entities = [
    [RoadBand, 2],
    [RoadDashes, 1],
    [House, HOUSES],
    [StreetLamp, LAMPS.length],
    [Car, CARS],
  ];

  _panel = null;
  _night = START_HOUR >= 20 || START_HOUR < 6;
  _cone = true;
  _aperture = 0; // an index into APERTURES, as the others below
  _softness = 0;
  _brightness = 0;
  _castShadows = true;
  _shadowRange = 0;
  _lampGlow = true;
  _nextReadout = 0;

  create() {
    // With the day cycle off, the hour sets the sun's light, colour and shadows once, here.
    Sun.setTimeOfDay(START_HOUR);
    Camera.setFree(true, { panSpeed: 12 });
    Camera.setFreeTarget(WORLD_W * 0.5, WORLD_H * 0.5);
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
    Camera.setZoom(Math.min(innerWidth / WORLD_W, innerHeight / WORLD_H));

    this._panel = new SunPanel([
      { key: 'c', keyName: 'C', label: 'Cone', note: 'coneAngle: under 2π the light is a cone; 2π (the default) is round', press: () => this._toggleCone() },
      { key: 'v', keyName: 'V', label: 'Aperture', note: 'coneAngle is the whole aperture, half each side of the heading', press: () => this._nextAperture() },
      { key: 'f', keyName: 'F', label: 'Softness', note: 'coneSoftness: how much of each half fades; 0 is a hard edge', press: () => this._nextSoftness() },
      { key: 'b', keyName: 'B', label: 'Brightness', note: 'brightness scales the colour; the reach (radius) stays', press: () => this._nextBrightness() },
      { key: 'k', keyName: 'K', label: 'Cast shadows', note: 'castShadows: off, the beams pass the houses (and cost less)', press: () => this._toggleCastShadows() },
      { key: 'r', keyName: 'R', label: 'Shadow range', note: 'shadowRange: only occluders this close stop the beam (0: the radius)', press: () => this._nextShadowRange() },
      { key: 'g', keyName: 'G', label: 'Lamp glow', note: "glow: the halo's alpha on the bulb, glowOffsetY puts it up the post", press: () => this._toggleLampGlow() },
      { key: 'n', keyName: 'N', label: 'Hour', note: "Sun.setTimeOfDay: by day the houses' VolumeShadowCaster boxes cast the sun's shadows", press: () => this._toggleNight() },
    ]);
    this._showStates();
  }

  createNewGame() {
    RoadBand.spawn({ x: ROAD_CX, y: ROAD_CY, layer: 'sidewalk', width: ROAD_WIDTH + 36, tint: 0xb4b0a4 });
    RoadBand.spawn({ x: ROAD_CX, y: ROAD_CY, layer: 'street', width: ROAD_WIDTH, tint: 0x6a6c72 });
    RoadDashes.spawn({ x: ROAD_CX, y: ROAD_CY });

    let house = 0;
    for (const row of HOUSE_ROWS) {
      for (const x of row.xs) House.spawn({ x, y: row.y, texture: house++ % 2 === 0 ? 'house1' : 'house2' });
    }
    for (const [x, y] of LAMPS) StreetLamp.spawn({ x, y });
    for (let i = 0; i < CARS; i++) {
      Car.spawn({ x: ROAD_CX, y: ROAD_CY, sheet: `car_${CAR_SHEETS[i % CAR_SHEETS.length]}`, distance: (i / CARS) * LAP });
    }
  }

  update() {
    if (Keyboard.isPressed('c')) this._toggleCone();
    if (Keyboard.isPressed('v')) this._nextAperture();
    if (Keyboard.isPressed('f')) this._nextSoftness();
    if (Keyboard.isPressed('b')) this._nextBrightness();
    if (Keyboard.isPressed('k')) this._toggleCastShadows();
    if (Keyboard.isPressed('r')) this._nextShadowRange();
    if (Keyboard.isPressed('g')) this._toggleLampGlow();
    if (Keyboard.isPressed('n')) this._toggleNight();
    if (Keyboard.isPressed('h')) this._panel.toggle();

    const now = performance.now();
    if (now >= this._nextReadout) {
      this._nextReadout = now + 250;
      this._showReadout();
    }
  }

  async destroy() {
    this._panel?.remove();
    this._panel = null;
    await super.destroy();
  }

  // --- The panel: each key writes one field on every car's (or lamp's) LightEmitter. ---

  /** Runs `write(lightEmitter)` for every active entity of `type`. */
  _forEachLight(type, write) {
    for (const entity of type.instances) {
      if (Transform.active[entity.index]) write(entity.lightEmitter);
    }
  }

  _toggleCone() {
    this._cone = !this._cone;
    const angle = this._cone ? APERTURES[this._aperture] : Math.PI * 2;
    this._forEachLight(Car, (light) => {
      light.coneAngle = angle;
    });
    this._showStates();
  }

  _nextAperture() {
    this._aperture = (this._aperture + 1) % APERTURES.length;
    if (this._cone) {
      const angle = APERTURES[this._aperture];
      this._forEachLight(Car, (light) => {
        light.coneAngle = angle;
      });
    }
    this._showStates();
  }

  _nextSoftness() {
    this._softness = (this._softness + 1) % SOFTNESS.length;
    const softness = SOFTNESS[this._softness];
    this._forEachLight(Car, (light) => {
      light.coneSoftness = softness;
    });
    this._showStates();
  }

  _nextBrightness() {
    this._brightness = (this._brightness + 1) % BRIGHTNESS.length;
    const brightness = BRIGHTNESS[this._brightness];
    this._forEachLight(Car, (light) => {
      light.brightness = brightness;
    });
    this._showStates();
  }

  _toggleCastShadows() {
    this._castShadows = !this._castShadows;
    const cast = this._castShadows;
    this._forEachLight(Car, (light) => {
      light.castShadows = cast;
    });
    this._showStates();
  }

  _nextShadowRange() {
    this._shadowRange = (this._shadowRange + 1) % SHADOW_RANGES.length;
    const range = SHADOW_RANGES[this._shadowRange];
    this._forEachLight(Car, (light) => {
      light.shadowRange = range;
    });
    this._showStates();
  }

  _toggleLampGlow() {
    this._lampGlow = !this._lampGlow;
    const glow = this._lampGlow ? LAMP.glow : 0;
    this._forEachLight(StreetLamp, (light) => {
      light.glow = glow;
    });
    this._showStates();
  }

  _toggleNight() {
    this._night = !this._night;
    Sun.setTimeOfDay(this._night ? NIGHT_HOUR : DAY_HOUR);
    this._showStates();
  }

  _showStates() {
    const panel = this._panel;
    const deg = (rad) => `${Math.round(rad / DEG)}°`;
    panel.show('c', this._cone ? 'on' : 'off (round)');
    panel.show('v', deg(APERTURES[this._aperture]));
    panel.show('f', String(SOFTNESS[this._softness]));
    panel.show('b', String(BRIGHTNESS[this._brightness]));
    panel.show('k', !RAYCAST ? (this._castShadows ? 'on (sprite shadows)' : 'off') : this._castShadows ? 'on' : 'off');
    panel.show('r', SHADOW_RANGES[this._shadowRange] === 0 ? 'the radius' : `${SHADOW_RANGES[this._shadowRange]} px`);
    panel.show('g', this._lampGlow ? String(LAMP.glow) : '0');
    panel.show('n', `${Math.floor(Sun.hour)}:00`);
  }

  _showReadout() {
    const ms = this.readWorkerStepMs();
    this._panel.readout.textContent =
      `${CARS} cars, cone headlights ${HEADLIGHT.radius} px; ${LAMPS.length} lamps ${LAMP.radius} px\n` +
      `${RAYCAST ? 'raycasted lighting' : 'basic lighting'}   H hides this panel\n` +
      `renderer ${ms.renderer.toFixed(2)} ms   pre-render ${ms.preRender.toFixed(2)} ms   logic ${ms.logic.toFixed(2)} ms`;
  }
}
