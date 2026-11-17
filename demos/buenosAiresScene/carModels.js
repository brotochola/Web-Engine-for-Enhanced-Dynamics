// The barrio's cars are the demos' standard cars ("TopDown Vehicles" v1.17 by MinZiin, CC BY 4.0: demos/img/autos). The
// Editor de Barrios only says where each car is, its heading, whether it drives and a colour ('poli' a police car,
// 'burnt' a wreck); which model it is, the demo chooses, as the game did: by weight, by how rich the block is, and only
// where the model fits.

import { CARS } from '../img/autos/index.js';

export const CAR_DIR = '/demos/img/autos/';

/** The pictures' scale: 18 px a metre on their floor, as the barrio. */
const PICTURE_PX_PER_M = 18;

/**
 * The models the demo draws, a handful of the pack's: `weight` how common each is; `richer` / `poorer` more common in rich
 * or poor blocks; `drivingOnly` never parked; `minimumDriving` how many drive at least (the special ones do not depend on
 * luck); `driveForce` its engine's push (the heavy ones start slower).
 */
export const CAR_MODELS = Object.freeze({
  hatch: { sheets: ['hatch_rojo', 'hatch_azul'], weight: 16, poorer: true },
  sedan: { sheets: ['sedan_blanco', 'sedan_negro'], weight: 13 },
  pickup: { sheets: ['pickup_blanco'], weight: 9 },
  suv: { sheets: ['suv_negro'], weight: 5, richer: true },
  taxi: { sheets: ['taxi'], weight: 3 },
  camion: { sheets: ['camion_rojo'], weight: 3.5, minimumDriving: 2, driveForce: 300 },
  colectivo: { sheets: ['colectivo_amarillo'], weight: 2.5, minimumDriving: 4, drivingOnly: true, driveForce: 270 },
});
export const POLICE_SHEET = 'policia';
export const WRECK_SHEET = 'quemado_sedan';

/** Every car sheet the scene loads. */
export const CAR_SHEETS = [...new Set([...Object.values(CAR_MODELS).flatMap((model) => model.sheets), POLICE_SHEET, WRECK_SHEET])];

/** The editor's colours, as the sheets' names say them. */
const EDITOR_COLORS = Object.freeze({ red: 'rojo', white: 'blanco', black: 'negro', blue: 'azul', yellow: 'amarillo' });

/** A sheet's car on the floor, metres: its box in the cars' index (floor px of the model, 18 a metre). */
export function carSizeMetres(sheet) {
  const box = CARS[sheet].box;
  return { length: (box[1] - box[0]) / PICTURE_PX_PER_M, width: (box[3] - box[2]) / PICTURE_PX_PER_M };
}

/** Two boxes on the floor ({ x, y, cos, sin, halfLength, halfWidth }), whether they overlap: separating axes. */
export function boxesOverlap(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const axes = [[a.cos, a.sin], [-a.sin, a.cos], [b.cos, b.sin], [-b.sin, b.cos]];
  for (const [axisX, axisY] of axes) {
    const reachA = a.halfLength * Math.abs(axisX * a.cos + axisY * a.sin) + a.halfWidth * Math.abs(axisY * a.cos - axisX * a.sin);
    const reachB = b.halfLength * Math.abs(axisX * b.cos + axisY * b.sin) + b.halfWidth * Math.abs(axisY * b.cos - axisX * b.sin);
    if (Math.abs(dx * axisX + dy * axisY) >= reachA + reachB) return false;
  }
  return true;
}

/**
 * Which sheet each car place gets. `places`: [{ x, y, rotation, color, moving }] (world px); `solidProps`: flat x, y,
 * radius of the objects that stop a car; `wealthAt(x, y)`: 0 poor to 1 rich; `random`: () => [0, 1); `pxPerMetre`: the
 * editor's px a metre for sizes on the floor. Returns [{ sheet, driveForce }], one per place.
 *
 * The editor's places are 4.6 × 1.8 m: a model longer or wider than that keeps its place only where its box (30 cm to
 * spare) overlaps nothing the place's own box did not (another car, a lamp).
 */
export function chooseCarSheets(places, solidProps, wealthAt, random, pxPerMetre) {
  const fit = makeFitTest(places, solidProps, pxPerMetre);
  const chosen = new Array(places.length).fill(null);
  placeMinimums(places, chosen, fit, random);
  return places.map((place, index) => {
    if (place.color === 'burnt') return { sheet: WRECK_SHEET, driveForce: 0 };
    if (place.color === 'poli') return { sheet: POLICE_SHEET, driveForce: 340 };
    const modelName = chosen[index] ?? pickModel(place, index, fit, wealthAt, random);
    const model = CAR_MODELS[modelName];
    fit.claim(index, modelName);
    return { sheet: sheetInColor(model, place.color, random), driveForce: model.driveForce ?? 340 };
  });
}

/** The models with a minimum of driving cars: given first, to driving places drawn at random where they fit. */
function placeMinimums(places, chosen, fit, random) {
  const driving = [];
  places.forEach((place, index) => {
    if (place.moving && place.color !== 'burnt' && place.color !== 'poli') driving.push(index);
  });
  for (let last = driving.length - 1; last > 0; last--) {
    const pick = Math.floor(random() * (last + 1));
    [driving[last], driving[pick]] = [driving[pick], driving[last]];
  }
  for (const [modelName, model] of Object.entries(CAR_MODELS)) {
    let given = 0;
    for (const index of driving) {
      if (given >= (model.minimumDriving || 0)) break;
      if (chosen[index] || !fit.fits(index, modelName)) continue;
      chosen[index] = modelName;
      fit.claim(index, modelName);
      given++;
    }
  }
}

/** A model for a place, drawn by weight (the block's wealth tilting the rich and poor ones) among those that fit. */
function pickModel(place, index, fit, wealthAt, random) {
  const wealth = wealthAt(place.x, place.y);
  const candidates = Object.keys(CAR_MODELS).filter((name) => place.moving || !CAR_MODELS[name].drivingOnly);
  const weights = candidates.map((name) => {
    const model = CAR_MODELS[name];
    const tilt = model.richer ? 0.2 + 2.5 * wealth : model.poorer ? 1.5 - wealth : 1;
    return model.weight * tilt;
  });
  while (candidates.length > 0) {
    let ticket = random() * weights.reduce((sum, weight) => sum + weight, 0);
    let drawn = 0;
    while (drawn < candidates.length - 1 && (ticket -= weights[drawn]) > 0) drawn++;
    if (fit.fits(index, candidates[drawn])) return candidates[drawn];
    candidates.splice(drawn, 1);
    weights.splice(drawn, 1);
  }
  return 'hatch';
}

/** The model's sheet in the editor's colour when it has one, else one of its own. */
function sheetInColor(model, editorColor, random) {
  const word = EDITOR_COLORS[editorColor];
  const matching = word ? model.sheets.find((sheet) => sheet.endsWith(`_${word}`)) : undefined;
  return matching ?? model.sheets[Math.floor(random() * model.sheets.length)];
}

/** The fit test: every place's box and every solid object's, in a grid of 160 px cells to find the neighbours. */
function makeFitTest(places, solidProps, pxPerMetre) {
  const CELL = 160;
  const SPARE = 0.3 * pxPerMetre;
  const PLACE_HALF_LENGTH = 2.3 * pxPerMetre;
  const PLACE_HALF_WIDTH = 0.9 * pxPerMetre;
  const boxes = [];
  const grid = new Map();
  const cellKey = (x, y) => Math.floor(x / CELL) * 65536 + Math.floor(y / CELL);
  const add = (box) => {
    const key = cellKey(box.x, box.y);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(boxes.length);
    boxes.push(box);
  };
  for (const place of places) {
    const rotation = place.rotation || 0;
    add({ x: place.x, y: place.y, cos: Math.cos(rotation), sin: Math.sin(rotation), halfLength: PLACE_HALF_LENGTH, halfWidth: PLACE_HALF_WIDTH });
  }
  for (let n = 0; n + 2 < solidProps.length; n += 3) {
    const radius = solidProps[n + 2];
    add({ x: solidProps[n], y: solidProps[n + 1], cos: 1, sin: 0, halfLength: radius, halfWidth: radius });
  }
  const halfSizeOf = (modelName) => {
    const size = carSizeMetres(CAR_MODELS[modelName].sheets[0]);
    return { halfLength: (size.length * pxPerMetre) / 2, halfWidth: (size.width * pxPerMetre) / 2 };
  };
  return {
    fits(index, modelName) {
      const place = boxes[index];
      const half = halfSizeOf(modelName);
      const wanted = { ...place, halfLength: half.halfLength + SPARE, halfWidth: half.halfWidth + SPARE / 2 };
      const own = { ...place, halfLength: PLACE_HALF_LENGTH + SPARE, halfWidth: PLACE_HALF_WIDTH + SPARE / 2 };
      if (wanted.halfLength <= own.halfLength && wanted.halfWidth <= own.halfWidth) return true;
      const cellX = Math.floor(place.x / CELL);
      const cellY = Math.floor(place.y / CELL);
      for (let gx = cellX - 1; gx <= cellX + 1; gx++) {
        for (let gy = cellY - 1; gy <= cellY + 1; gy++) {
          for (const other of grid.get(gx * 65536 + gy) || []) {
            if (other !== index && boxesOverlap(wanted, boxes[other]) && !boxesOverlap(own, boxes[other])) return false;
          }
        }
      }
      return true;
    },
    /** The place now holds that model: its box is the model's, for the places tested after it. */
    claim(index, modelName) {
      const half = halfSizeOf(modelName);
      boxes[index].halfLength = half.halfLength;
      boxes[index].halfWidth = half.halfWidth;
    },
  };
}
