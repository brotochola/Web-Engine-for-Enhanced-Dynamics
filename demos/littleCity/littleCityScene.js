// LittleCityScene — tilemap city, sidewalk people, road-only traffic, free cam

import WEED from '/src/index.js';
import { NavGrid } from '/src/core/navGrid.js';
import { rng } from '/src/util/utils.js';
import { TrafficCar } from './gameObjects/trafficCar.js';
import { CityPerson } from './gameObjects/cityPerson.js';
import { CityHouse } from './gameObjects/cityHouse.js';
import { CityTree } from './gameObjects/cityTree.js';

const { Camera, LAYER_KIND } = WEED;

const useBaked = true;

const excludedLPCAnimations = [
  'spellcast_up',
  'spellcast_left',
  'spellcast_down',
  'spellcast_right',
  'thrust_up',
  'thrust_left',
  'thrust_down',
  'thrust_right',
  'slash_up',
  'slash_left',
  'slash_down',
  'slash_right',
  'shoot_up',
  'shoot_left',
  'shoot_down',
  'shoot_right',
  'hurt',
  'climb',
  'jump_up',
  'jump_left',
  'jump_down',
  'jump_right',
  'sit_up',
  'sit_left',
  'sit_down',
  'sit_right',
  'emote_up',
  'emote_left',
  'emote_down',
  'emote_right',
  'combat_up',
  'combat_left',
  'combat_down',
  'combat_right',
  '1h_slash_up',
  '1h_slash_left',
  '1h_slash_down',
  '1h_slash_right',
  '1h_halfslash_up',
  '1h_halfslash_left',
  '1h_halfslash_down',
  '1h_halfslash_right',
];

const HOUSE_COUNT = 63;
const TREE_COUNT = 18;
const PERSON_SPAWN_COUNT = 8000;
const TRAFFIC_SPAWN_COUNT = 300;

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

function buildHouseTextures() {
  const textures = {};
  for (let i = 1; i <= HOUSE_COUNT; i++) {
    const id = pad2(i);
    textures[`house_${id}`] = `/demos/img/little_city/house_${id}.png`;
  }
  return textures;
}

function buildTreeTextures() {
  const textures = {};
  for (let i = 1; i <= TREE_COUNT; i++) {
    const id = pad2(i);
    textures[`tree_${id}`] = `/demos/img/little_city/trees/tree_${id}.png`;
  }
  return textures;
}

function buildPeopleSpritesheets() {
  const sheets = {};
  const groups = [
    ['male', 30],
    ['female', 30],
    ['amarillo', 3],
    ['rojito', 3],
    ['verde', 3],
  ];
  for (let g = 0; g < groups.length; g++) {
    const prefix = groups[g][0];
    const count = groups[g][1];
    for (let i = 1; i <= count; i++) {
      const name = `${prefix}_${pad2(i)}`;
      sheets[name] = {
        json: '/demos/img/civil1.json',
        png: `/demos/img/people/${name}.png`,
        excludeAnimations: excludedLPCAnimations,
      };
    }
  }
  return sheets;
}

function pickRandom(arr) {
  return arr[(rng() * arr.length) | 0];
}

function flattenRoadCells(roads) {
  const cells = [];
  for (let r = 0; r < roads.length; r++) {
    const road = roads[r];
    const list = road.cells || [];
    for (let c = 0; c < list.length; c++) {
      cells.push(list[c]);
    }
  }
  return cells;
}

export class LittleCityScene extends WEED.Scene {
  static config = {
    worldWidth: 9984,
    worldHeight: 4992,
    seed: 123456,

    debug: {
      maxDebugDrawEntries: 30192,
      collectDetailedStats: false,
    },
    spatial: {
      cellSize: 128,
      maxNeighbors: 512,
      maxEntitiesPerCell: 128,
      numberOfSpatialWorkers: 2,
      noLimitFPS: false,
    },
    particle: {
      noLimitFPS: false,
      maxParticles: 10000,
      decals: true,
      decalsTileSize: 256,
      decalsResolution: 0.5,
    },
    decoration: {
      maxDecorations: 20000,
    },
    logic: {
      noLimitFPS: false,
      numberOfLogicWorkers: 1,
      staggeredUpdates: true,
    },
    physics: {
      subStepCount: 0,
      noLimitFPS: false,
      maxJoints: 0,
      gravity: { x: 0, y: 0 },
      sleeping: true,
    },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      ySort: true,
      cullingRatio: 0.1,
      startFadingDecorationsAtZoom: 0.5,
      hideDecorationsAtZoom: 0.25,
    },
    preRender: {
      noLimitFPS: false,
    },
    lighting: {
      enabled: false,
    },
    navigation: {
      enabled: true,
      cellSize: 48,
    },
    layers: {
      ground: {
        kind: LAYER_KIND.TILEMAP,
        tilemap: 'little_city',
        scale: 1,
        zIndex: 0.5,
      },
    },
  };

  static audios = {
    dolor1: '/demos/audios/dolor1.mp3',
    dolor2: '/demos/audios/dolor2.mp3',
    dolor3: '/demos/audios/dolor3.mp3',
    dolor4: '/demos/audios/dolor4.mp3',
  };

  static assets = {
    ...(useBaked
      ? {
          bigAtlas: {
            json: '/demos/littleCity/baked/bigAtlas.json',
            png: '/demos/littleCity/baked/bigAtlas.png',
          },
        }
      : {}),
    textures: {
      smoke: '/demos/img/smoke.png',
      blood: '/demos/img/blood.png',
      ...buildHouseTextures(),
      ...buildTreeTextures(),
    },
    spritesheets: {
      red_car: {
        json: '/demos/img/cars/red.json',
        png: '/demos/img/cars/red.png',
      },
      yellow_car: {
        json: '/demos/img/cars/yellow.json',
        png: '/demos/img/cars/yellow.png',
      },
      black_car: {
        json: '/demos/img/cars/black.json',
        png: '/demos/img/cars/black.png',
      },
      white_car: {
        json: '/demos/img/cars/white.json',
        png: '/demos/img/cars/white.png',
      },
      blue_car: {
        json: '/demos/img/cars/blue.json',
        png: '/demos/img/cars/blue.png',
      },
      ...buildPeopleSpritesheets(),
    },
    tilemaps: {
      little_city: {
        json: '/demos/littleCity/little_city_tilemap_export.json',
        png: '/demos/img/tilemap/2.png',
      },
    },
    flowfields: {
      sidewalks: '/demos/littleCity/flowfield_sidewalks_208x104_1790114592711.json',
      roads: '/demos/littleCity/flowfield_roads_208x104_1790114564727.json',
    },
  };

  static entities = [
    [TrafficCar, 500],
    [CityPerson, 10000],
    [CityHouse, 80],
    [CityTree, 1300],
  ];

  createNavGridForTheFlowField() {
    NavGrid.updateNavGrid([
      ...CityTree.getAllActive(),
      ...CityHouse.getAllActive(),
    ]);
  }

  async preload() {
    console.log('🏙️ LittleCityScene: Preloading...');

    const res = await fetch('/demos/littleCity/objects_208x104_1790114635638.json');
    const data = await res.json();

    const houses = data.houses || [];
    for (let i = 0; i < houses.length; i++) {
      const h = houses[i];
      CityHouse.spawn({ x: h.x, y: h.y });
    }

    const trees = data.trees || [];
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      CityTree.spawn({ x: t.x, y: t.y, radius: t.radius });
    }

    const sidewalks = data.sidewalks || [];
    const personCount = Math.min(PERSON_SPAWN_COUNT, sidewalks.length);
    for (let i = 0; i < personCount; i++) {
      const cell = pickRandom(sidewalks);
      CityPerson.spawn({
        x: cell.x + (rng() - 0.5) * 24,
        y: cell.y + (rng() - 0.5) * 24,
      });
    }

    const roadCells = flattenRoadCells(data.roads || []);
    const carSprites = ['red_car', 'yellow_car', 'black_car', 'white_car', 'blue_car'];
    const carCount = Math.min(TRAFFIC_SPAWN_COUNT, roadCells.length);
    for (let i = 0; i < carCount; i++) {
      const cell = pickRandom(roadCells);
      TrafficCar.spawn({
        x: cell.x,
        y: cell.y,
        sprite: pickRandom(carSprites),
      });
    }

    this.createNavGridForTheFlowField();

    const cx = this.config.worldWidth / 2;
    const cy = this.config.worldHeight / 2;
    Camera.setFree(true, { panSpeed: 14, zoomSensitivity: 0.001 });
    Camera.setFreeTarget(cx, cy);
    Camera.centerOn(cx, cy);

    console.log(
      `🏙️ LittleCityScene: Preloaded — houses=${houses.length} trees=${trees.length} people=${personCount} cars=${carCount}`,
    );
  }

  create() {
    console.log('🏙️ LittleCityScene: WASD/Arrows pan, wheel zoom. People follow sidewalks; cars follow roads.');
  }

  update() { }
}
