import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  checkPackageMeta, parseBarrioScene, checkBarrioScene, expandEntity, spawnOrder, textureName, gunzip, isGzip, loadBarrio,
  attachDecorations,
} from '../buenosAiresScene/barrioLoader.js';
import { META } from './fixtures/barrioMini/meta.js';

// The demo's package loader (demos/buenosAiresScene/barrioLoader.js) against a tiny package (fixtures/barrioMini): its
// meta.js, its scene file (prefabs, a prefab's config overridden, attached records, palettes, a parent by name, a
// prefab's child) and a gzipped binary. The loader spawns through the functions it is given: here, recorders.

const FIXTURE = new URL('./fixtures/barrioMini/', import.meta.url);
const sceneText = () => readFileSync(new URL('parquechas.scene.json', FIXTURE), 'utf8');

/** The decoration classes the fixture uses, as the scene declares them (with a two-object perTexture table). */
const DECORATIONS = {
  Cara: { anchorX: 0.5, anchorY: 0.5 },
  Grafiti: { sheet: 'grafitis', anchorX: 0.5, anchorY: 0.5 },
  Ventana: { sheet: 'ventanas', anchorX: 0.5, anchorY: 0.5, hidden: true, keep: true },
  Rama: { sheet: 'arboles', anchorX: 0.5, anchorY: 1, sway: true, swayAmplitude: { min: 0.01, max: 0.02 }, swayFrequency: { min: 0.4, max: 0.7 } },
  Prop: {
    perTexture: {
      pl_malvon_0: { texture: 'garden_malvon', anchorX: 0.4, anchorY: 0.9, scaleX: 0.6, scaleY: 0.6, swaySkew: true, swayAmplitude: 0.03, swayFrequency: 0.6 },
      yy_avena_2: { texture: 'weeds_avena', anchorX: 0.5, anchorY: 0.95, scaleX: 0.6, scaleY: 0.6 },
    },
  },
  Cable: { texture: '_white', anchorX: 0, anchorY: 0.5, scaleY: 1 / 8, tint: 0x17171b, alpha: 0.9, layer: 'cables' },
};

/** Loads the fixture with recorders: what each class was asked to spawn, each decoration call, each warning. */
async function loadFixture() {
  const spawned = [];
  const decorationCalls = [];
  const warnings = [];
  const places = [];
  let nextEntity = 100;
  let nextDecoration = 0;
  const spawn = (className) => (config) => {
    spawned.push({ className, config });
    return nextEntity++;
  };
  const doc = parseBarrioScene(sceneText(), 'parquechas.scene.json');
  const result = await loadBarrio(doc, {
    where: 'parquechas.scene.json',
    classes: {
      Casa: spawn('Casa'),
      Arbol: spawn('Arbol'),
      Prop: spawn('Prop'),
      Luz: spawn('Luz'),
      LugarAuto: (config) => {
        places.push(config);
        return -1;
      },
    },
    decorations: DECORATIONS,
    spawnDecorations: (config) => {
      decorationCalls.push(config);
      // As the pool does: each decoration takes the next index, written to out when the call gives one.
      for (let n = 0; n < config.count; n++) {
        const index = nextDecoration++;
        if (config.out) config.out[n] = index;
      }
      return config.count;
    },
    spawnDecoration: (config) => {
      decorationCalls.push({ ...config, one: true });
      return nextDecoration++;
    },
    random: () => 0.5,
    warn: (message) => warnings.push(message),
  });
  return { result, spawned, decorationCalls, warnings, places };
}

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} is not ${expected}`);

test("meta.js must say the package's format: 1, or an error that names the file", () => {
  assert.equal(checkPackageMeta(META, 'barrioMini/meta.js'), META);
  assert.throws(() => checkPackageMeta({ ...META, packageFormat: 2 }, 'barrio/meta.js'), /barrio\/meta\.js: package format 2: this demo reads/);
  assert.throws(() => checkPackageMeta({ WW: 10 }, 'barrio/meta.js'), /barrio\/meta\.js: package format undefined/);
});

test('a scene file that is not format 1 and the extensions is refused, naming the file and the place', () => {
  const where = 'x.scene.json';
  assert.throws(() => parseBarrioScene('{ nope', where), /x\.scene\.json is not JSON/);
  assert.throws(() => checkBarrioScene({ format: 2 }, where), /x\.scene\.json: scene file format 2: this demo reads format 1/);
  const entity = { name: 'A', class: 'Casa', x: 0, y: 0 };
  assert.throws(() => checkBarrioScene({ format: 1, entities: [{ ...entity, prefab: 'nope' }] }, where), /entities\[0\] \(A\): there is no prefab "nope"/);
  assert.throws(() => checkBarrioScene({ format: 1, entities: [{ ...entity, parent: 'Nadie' }] }, where), /its parent "Nadie" is no entity of the file/);
  assert.throws(() => checkBarrioScene({ format: 1, entities: [entity, { ...entity }] }, where), /the name "A" is used twice/);
  assert.throws(() => checkBarrioScene({ format: 1, entities: [{ name: 'B', x: 0, y: 0 }] }, where), /\(B\) needs a "class"/);
  const record = { class: 'Cara', x: [1, 2], y: [1] };
  assert.throws(() => checkBarrioScene({ format: 1, decorations: [record] }, where), /decorations\[0\] \(Cara\): "x" has 2 values and "y" 1/);
  const badFrame = { class: 'Cara', textures: ['a'], frame: [1], x: [0], y: [0] };
  assert.throws(() => checkBarrioScene({ format: 1, decorations: [badFrame] }, where), /frame\[0\] is 1, not an index into its 1 textures/);
  const attached = { class: 'Rama', attached: true, x: [0], y: [0] };
  assert.throws(() => checkBarrioScene({ format: 1, decorations: [attached] }, where), /"attached" needs an entity to hang from/);
  const badArray = { class: 'Cara', x: [0], y: [0], faceHeight: ['tall'] };
  assert.throws(() => checkBarrioScene({ format: 1, decorations: [badArray] }, where), /faceHeight\[0\] is "tall", not a number/);
  // Keys the format does not know are kept: the crossings of this fixture are one.
  assert.equal(parseBarrioScene(sceneText()).cruces.length, 1);
});

test("an entity takes its prefab's class, config, children and decorations; its own config keys win, its decorations add", () => {
  const doc = parseBarrioScene(sceneText());
  const house = expandEntity(doc.entities[0], doc.prefabs);
  assert.equal(house.class, 'Casa');
  assert.equal(house.config.k, 'poste', 'its own key wins over the prefab\'s');
  assert.equal(house.config.l, 1);
  assert.deepEqual(house.config.col, doc.prefabs.casa_a.config.col);
  assert.deepEqual(house.decorations.map((d) => d.class), ['Cara', 'Ventana', 'Grafiti']);
  const lamp = expandEntity(doc.entities[3], doc.prefabs);
  assert.equal(lamp.rotation, 0.5);
  assert.equal(lamp.children.length, 1);
});

test('parents spawn before the entities that name them', () => {
  const doc = parseBarrioScene(sceneText());
  const { order, cut } = spawnOrder(doc.entities);
  assert.deepEqual(order, [0, 1, 3, 2, 4, 5], 'Farol1 before Cartel1, which comes first in the file');
  assert.equal(cut.size, 0);
  const loop = spawnOrder([{ name: 'A', parent: 'B' }, { name: 'B', parent: 'A' }]);
  assert.equal(loop.order.length, 2);
  assert.equal(loop.cut.size, 1, 'a loop loses one link');
});

test('palette names become atlas names: the sheet the class names, or the name itself', () => {
  assert.equal(textureName({ sheet: 'grafitis' }, 'gr_big_3'), 'grafitis_gr_big_3');
  assert.equal(textureName({ sheet: 'grafitis' }, 'grafitis_gr_big_3'), 'grafitis_gr_big_3');
  assert.equal(textureName({ sheet: 'grafitis' }, '_white'), '_white');
  assert.equal(textureName({}, 'caras0_t0_0_0'), 'caras0_t0_0_0');
});

test('the load: entities with their configs, links and attached decorations; world decorations placed once', async () => {
  const { result, spawned, decorationCalls, warnings, places } = await loadFixture();
  assert.deepEqual(spawned.map((s) => s.className), ['Casa', 'Arbol', 'Prop', 'Luz', 'Prop']);

  const [house, tree, lamp, lampLight, sign] = spawned.map((s) => s.config);
  assert.equal(house.x, 100);
  assert.equal(house.y, 200);
  assert.equal(house.k, 'poste');
  assert.equal(house.decor, undefined, 'a house has no attached decorations');

  // The tree: its branches travel in its config, their textures resolved, for attachDecorations in its onSpawned.
  assert.equal(tree.fl, 1);
  assert.equal(tree.decor.length, 1);
  assert.deepEqual(tree.decor[0].texture, ['arboles_fresno_r1', 'arboles_fresno_r2']);
  assert.deepEqual(tree.decor[0].y, [-30, -40]);

  // The lamp's prefab child: turned with the lamp, linked to it (DX-PARENT's parent, localX, localY).
  assert.equal(lamp.rotation, 0.5);
  assert.equal(lampLight.parent, 102);
  assert.equal(lampLight.localX, 0);
  assert.equal(lampLight.localY, -12);
  near(lampLight.x, 400 + 12 * Math.sin(0.5), 'the child x');
  near(lampLight.y, 250 - 12 * Math.cos(0.5), 'the child y');

  // The sign names the lamp as its parent: its offset in the lamp's frame (the lamp's rotation undone).
  assert.equal(sign.parent, 102);
  near(sign.localX, 10 * Math.cos(0.5) + 10 * Math.sin(0.5), 'localX');
  near(sign.localY, -10 * Math.sin(0.5) + 10 * Math.cos(0.5), 'localY');

  // The car place reaches its class with its rotation and config; an unknown class is skipped, once told.
  assert.equal(places.length, 1);
  assert.equal(places[0].rotation, 2.39);
  assert.equal(places[0].color, 'blue');
  assert.equal(places[0].moving, true);
  assert.equal(result.byName.get('Raro1'), -1);
  assert.ok(warnings.some((w) => /"Desconocida" is not a class this scene spawns/.test(w)), warnings.join('\n'));
  assert.equal(result.entities, 5);

  // World decorations: the house's faces at its position, their palette resolved per decoration, their arrays as given.
  const faces = decorationCalls[0];
  assert.deepEqual(Array.from(faces.x), [95, 100, 105]);
  assert.deepEqual(Array.from(faces.y), [180, 190, 180]);
  assert.deepEqual(faces.texture, ['caras0_t0_0_0', '_white', 'caras0_t0_0_0']);
  assert.deepEqual(faces.faceNormalX, [0, 0.71, 0]);
  assert.deepEqual(faces.innerZ, [0, 0, 0]);
  assert.deepEqual(faces.sortOffsetY, [5, 5, 5]);
  assert.equal(faces.anchorY, 0.5);
  assert.equal(faces.count, 3);
  // The windows: hidden whatever the record says, and kept for the scene.
  const windows = decorationCalls[1];
  assert.deepEqual(windows.texture, ['ventanas_v_1', 'ventanas_v_1']);
  assert.equal(windows.alpha, 0);
  assert.deepEqual(result.kept.Ventana, [3, 4]);
  // The house's own graffiti, after its prefab's decorations.
  const graffiti = decorationCalls[2];
  assert.deepEqual(graffiti.texture, ['grafitis_gr_big_3']);
  assert.deepEqual(Array.from(graffiti.x), [102]);
  assert.deepEqual(graffiti.faceHeight, [12]);
});

test("a class that resolves its own names spawns one group a name, the record's scale winning, unknown names skipped", async () => {
  const { decorationCalls, warnings, result } = await loadFixture();
  const malvon = decorationCalls.find((call) => call.texture === 'garden_malvon');
  assert.deepEqual(Array.from(malvon.x), [600, 630]);
  assert.deepEqual(malvon.scaleX, [0.6, -0.6], 'the record gives scaleX: it is the scale');
  assert.equal(malvon.scaleY, 0.6, 'scaleY from the object');
  assert.equal(malvon.anchorX, 0.4);
  assert.equal(malvon.swaySkew, true);
  const oats = decorationCalls.find((call) => call.texture === 'weeds_avena');
  assert.deepEqual(oats.scaleX, [-0.6]);
  assert.ok(warnings.some((w) => /"no_existe" is not one it knows/.test(w)));
  // The cable takes its class's texture, anchor and thickness, the record's length, turn and colour.
  const cable = decorationCalls.find((call) => Array.isArray(call.texture) && call.texture[0] === '_white');
  assert.equal(cable.anchorX, 0);
  assert.equal(cable.scaleY, 1 / 8);
  assert.deepEqual(cable.scaleX, [33.9]);
  assert.deepEqual(cable.tint, [0]);
  assert.equal(cable.layer, 'cables');
  assert.equal(result.decorations, 3 + 2 + 1 + 2 + 1 + 1);
});

test('attached decorations hang from the entity, mirrored for a flipped tree, each drawing its own sway', async () => {
  const { spawned } = await loadFixture();
  const tree = spawned.find((s) => s.className === 'Arbol').config;
  const calls = [];
  const entity = { addDecoration: (...args) => calls.push(args) };
  const hung = attachDecorations(entity, tree.decor, () => 0.5, -1);
  assert.equal(hung, 2);
  const [texture, localX, localY, scaleX, scaleY, innerZ, extra] = calls[1];
  assert.equal(texture, 'arboles_fresno_r2');
  assert.equal(localX, -2, 'mirrored');
  assert.equal(localY, -40);
  assert.equal(scaleX, -1, 'mirrored');
  assert.equal(scaleY, 1);
  assert.equal(innerZ, 2);
  assert.equal(extra.rotation, 0.25, 'its turn mirrored');
  assert.equal(extra.sway, false, 'the record says this branch does not sway');
  const first = calls[0][6];
  assert.equal(first.sway, true);
  near(first.swayAmplitude, 0.015, 'drawn from the class range');
  near(first.swayFrequency, 0.55, 'drawn from the class range');
  assert.equal(first.anchorY, 1);
  assert.equal(first.rotation, -0.5);
});

test('package binaries are inflated when gzipped and passed through when not', async () => {
  const gz = new Uint8Array(readFileSync(new URL('transito.bin.gz', FIXTURE)));
  assert.ok(isGzip(gz));
  const bytes = await gunzip(gz);
  const grid = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  assert.equal(grid.length, META.transito.W * META.transito.H);
  assert.equal(grid[0], 3);
  assert.equal(grid[4], 3 | (1 << 4) | (1 << 6));
  const plain = new Uint8Array([1, 2, 3]);
  assert.equal(await gunzip(plain), plain);
});
