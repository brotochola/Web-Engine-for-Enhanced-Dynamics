#!/usr/bin/env node
// Bakes the objects' height maps (<sheet>_h.png beside each sheet in this folder) with the engine's own tool,
// scripts/weedMaps.mjs (npm run maps), heights only (the engine derives the normals from them):
//
//   node demos/img/objetos/bakeHeights.mjs
//
// Every frame is a standing card on its own lowest row with the prop dome (--profile prop --surface standing
// --base frame: these frames are separate objects, not an animation that must not bounce), for the standard art's
// camera, the one the LPC people, the MinZiin cars, the light bench and the barrio editor's export share: a px of
// height rises 0.752 px on the screen and the floor is drawn at 0.736 of its width (camera.heightScaleY and
// floorScaleY). Art made for another camera changes STANDARD_ART_CAMERA and runs this again.
//
// A standing card makes a thing as tall as its picture, floor depth included: right for a lamp post or a plant, wrong
// for what lies on the floor, whose picture is mostly its top (a pallet lying down came out 1.5 m tall). So the frames
// in FLOOR_FRAMES are mapped otherwise:
// - lying (a pool, a mattress or a pallet lying down, planks, tyres, heaps of sand, rubble or rocks, a scatter of
//   rubbish or mushrooms): --surface floor, the dome alone above the floor (the lying pallet: 0.6 m);
// - flat (the drawn shadows sh_*, papers, puddles): --surface floor --relief 0, height 0, a mark on the floor.
// The tool maps a whole sheet with one set of options, so a sheet with such frames is mapped once more with theirs
// into a scratch folder, and those frames' rectangles are copied into the sheet's map (the tool computes each frame
// within its own rectangle, so a frame copied whole is exactly what the tool made for it).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePng, encodePng } from '../../lightBenchScene/tools/png.mjs';

const OBJECTS_FOLDER = path.dirname(fileURLToPath(import.meta.url));
const WEED_MAPS = path.join(OBJECTS_FOLDER, '..', '..', '..', 'scripts', 'weedMaps.mjs');

/** The standard art's camera: screen px a px of height rises (0.752) and how deep the floor is drawn (0.736). */
const STANDARD_ART_CAMERA = ['--height-scale-y', '0.752', '--floor-scale-y', '0.736'];
/** Options every run shares: the prop dome, heights only, each frame on its own lowest row. */
const SHARED_OPTIONS = ['--profile', 'prop', '--no-normal', '--base', 'frame', ...STANDARD_ART_CAMERA];
const STANDING_OPTIONS = ['--surface', 'standing'];
const FLOOR_OPTIONS = {
  lying: ['--surface', 'floor'],
  flat: ['--surface', 'floor', '--relief', '0'],
};

/** Per sheet, its frames (names in the sheet's json) that lie on the floor or are flat on it; the rest stand. */
const FLOOR_FRAMES = {
  viejos: {
    lying: ['pileta'],
    flat: ['sh_bus_h', 'sh_car_h', 'sh_car_v', 'sh_person', 'sh_pole', 'sh_small', 'sh_tree'],
  },
  lpc_revised_recortado: {
    lying: ['maderas_03_0_0', 'maderas_05_0_0', 'maderas_06_0_0', 'maderas_10_0_0', 'hongos_25_0_0'],
    flat: ['papeles_04_0_0', 'papeles_05_0_0'],
  },
  karsiori_rock_pile_pack: {
    lying: [
      'rock_pile_12_silver_big', 'rock_pile_14_beige_big', 'rock_pile_15_azure_big', 'rock_pile_2_white_big',
      'rock_pile_3_beige_big', 'rock_pile_4_orange_small', 'rock_pile_6_azure_big', 'rock_pile_6_azure_small',
      'rock_pile_6_mossy_big', 'rock_pile_7_beige_small',
    ],
  },
  karsiori_mountains_deco: { lying: ['rock_3', 'rock_4'] },
  cainos_village_props: { lying: ['tx_village_props_816_365'] },
  karsiori_trash_pack: { lying: ['trash_pile_2'] },
  mem0ry_post_apoc_office_asset_pack: { lying: ['office_exterior_32x32_102_290'] },
  mem0ry_post_apoc_shelter_asset_pack: {
    lying: [
      'shelter_exterior_32x32_323_262', 'shelter_exterior_32x32_355_257', 'shelter_exterior_32x32_387_262',
      'shelter_exterior_32x32_419_257', 'shelter_exterior_32x32_326_192', 'shelter_exterior_32x32_340_224',
      'shelter_exterior_32x32_461_174', 'shelter_exterior_32x32_461_238', 'shelter_furniture_32x32_456_100',
    ],
  },
  mem0ry_garden_planters: {
    lying: [
      'garden_planters_rubbertire_100_10', 'garden_planters_rubbertire_164_1', 'garden_planters_rubbertire_197_1',
      'garden_planters_rubbertire_36_10', 'garden_planters_rubbertire_4_10',
    ],
  },
  mem0ry_public_bathroom: { flat: ['dirty_publicbathroom_set_197_163', 'dirty_publicbathroom_set_197_194'] },
};

/** Runs weedMaps on one sheet with these options, writing <sheet>_h.png into outputFolder; prints its summary line. */
function runWeedMaps(sheetJsonPath, options, outputFolder) {
  const args = [WEED_MAPS, sheetJsonPath, ...SHARED_OPTIONS, ...options, '--out', outputFolder];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`weedMaps ${path.basename(sheetJsonPath)} ${options.join(' ')}: ${result.stderr || result.stdout}`);
  }
  // The tool's line about the sheet (frames, foot rows, tallest px), without the folder or the files it wrote.
  const summary = result.stdout.split('\n').find((line) => line.startsWith(sheetJsonPath)) ?? '';
  console.log(`${path.basename(sheetJsonPath)}${summary.slice(sheetJsonPath.length)} [${options.join(' ')}]`);
}

const sheetNames = fs
  .readdirSync(OBJECTS_FOLDER)
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.slice(0, -'.json'.length))
  .sort();
for (const sheetName of Object.keys(FLOOR_FRAMES)) {
  if (!sheetNames.includes(sheetName)) throw new Error(`FLOOR_FRAMES names ${sheetName}: no ${sheetName}.json here`);
}

const scratchFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-objetos-'));
try {
  for (const sheetName of sheetNames) {
    const sheetJsonPath = path.join(OBJECTS_FOLDER, `${sheetName}.json`);
    runWeedMaps(sheetJsonPath, STANDING_OPTIONS, OBJECTS_FOLDER);
    const floorGroups = FLOOR_FRAMES[sheetName];
    if (!floorGroups) continue;

    const frames = JSON.parse(fs.readFileSync(sheetJsonPath, 'utf8')).frames;
    const heightMapPath = path.join(OBJECTS_FOLDER, `${sheetName}_h.png`);
    const heightMap = decodePng(fs.readFileSync(heightMapPath));
    for (const [group, frameNames] of Object.entries(floorGroups)) {
      runWeedMaps(sheetJsonPath, FLOOR_OPTIONS[group], scratchFolder);
      const groupMap = decodePng(fs.readFileSync(path.join(scratchFolder, `${sheetName}_h.png`)));
      for (const frameName of frameNames) {
        const rect = frames[frameName]?.frame;
        if (!rect) throw new Error(`${sheetName}.json has no frame ${frameName}`);
        // Both maps are RGBA, the sheet's size: copy the frame's rectangle row by row.
        for (let y = rect.y; y < rect.y + rect.h; y++) {
          const rowStart = (y * heightMap.width + rect.x) * 4;
          heightMap.data.set(groupMap.data.subarray(rowStart, rowStart + rect.w * 4), rowStart);
        }
      }
      console.log(`  ${group}: ${frameNames.join(', ')}`);
    }
    fs.writeFileSync(heightMapPath, encodePng(heightMap.width, heightMap.height, heightMap.data));
  }
} finally {
  fs.rmSync(scratchFolder, { recursive: true, force: true });
}
