// The light bench's code panel: the WeedJS code of what is selected (an element, a lamp, or the scene when nothing is),
// with DX-LIGHT3D's API (DX_LIGHT3D_PLAN.md §5). It writes the calls benchLook.js's applyLook makes, in the same order.

import { BENCH_ASSETS } from './benchAssets.js';
import { boxOf, boxOptions, castsVolume, normalizeLook, volumeRotation } from './benchLook.js';

const DEG = 180 / Math.PI;

/** A number as code: at most `digits` decimals, no trailing zeros. */
function num(v, digits = 2) {
  const s = (+v).toFixed(digits);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

function hex(color) {
  return `0x${(color >>> 0).toString(16).padStart(6, '0')}`;
}

/** A line with its comment at column `col`. */
function line(indent, code, comment, col = 52) {
  const text = ' '.repeat(indent) + code;
  if (!comment) return text;
  return `${text}${' '.repeat(Math.max(1, col - text.length))}// ${comment}`;
}

function className(el) {
  if (el.kind === 'tree') return 'Tree';
  if (el.kind === 'char') return 'Walker';
  return el.sheet.charAt(0).toUpperCase() + el.sheet.slice(1);
}

/** What the sheet's way casts, for the comment on a kind left 'auto' (`mapsOn`: the sheet loads its height map). */
function autoText(el, light, mapsOn) {
  if (el.kind === 'tree' || el.kind === 'char') return 'one view: its card';
  if (!mapsOn) return 'no height map: its card';
  const cast = el.cast?.[light === 'sun' ? 'sun' : 'lamp'];
  if (cast === 'sprite') return 'its json says meta.light3d.cast: its card';
  return 'a render with a height map: its solid';
}

const KIND_COMMENT = {
  sprite: 'a card on its base, the frame that light sees',
  heightMap: 'each pixel where it is in 3D (its height map)',
  box: 'width, depth (floor px), height (screen px)',
  hull: 'the convex volume around its points',
  wall: 'stops the lamps as a wall (flat view: pitch 90 or 0)',
  none: 'no shadow',
};

/** The call for one kind on `who` ('this.shadowCaster', or its .sun / .lamps). */
function castLine(who, kind, el, look) {
  if (kind === 'sprite') {
    return look.orient === 'fixed'
      ? line(4, `${who}.setSprite({ orient: 'fixed' });`, 'a card along the object, face on')
      : line(4, `${who}.setSprite();`, KIND_COMMENT.sprite);
  }
  if (kind === 'heightMap') return line(4, `${who}.setHeightMap();`, KIND_COMMENT.heightMap);
  if (kind === 'box') {
    const box = boxOf(el.sheet);
    const o = boxOptions(box);
    const opts = o ? `, { ${Object.entries(o).map(([k, v]) => `${k}: ${num(v, 1)}`).join(', ')} }` : '';
    return line(4, `${who}.setBox(${num(box.width, 1)}, ${num(box.depth, 1)}, ${num(box.height, 1)}${opts});`, KIND_COMMENT.box);
  }
  if (kind === 'hull') return line(4, `${who}.setHull(HULL);`, KIND_COMMENT.hull);
  if (kind === 'wall') return line(4, `${who}.setWall({ shape: 'sprite' });`, KIND_COMMENT.wall);
  if (kind === 'none') return line(4, `${who}.clear();`, KIND_COMMENT.none);
  return null;
}

/**
 * An element's code: its sheet in assets and its class.
 * @param {{ kind: string, sheet: string, anim?: string, facing: number, look: object, cast?: object, hull?: number[]|null }} el
 * @param {{ maps: boolean }} opts whether the sheets load their maps (?maps=0 drops them)
 */
export function elementCode(el, { maps }) {
  const asset = BENCH_ASSETS[el.sheet];
  const look = normalizeLook(el.look, el.sheet, Array.isArray(el.hull) && el.hull.length >= 12);
  const out = [];
  const mapsOn = maps && asset?.maps === true;
  const twins = mapsOn ? `, heightMap: '${el.sheet}_h.png', normalMap: '${el.sheet}_n.png'` : '';
  out.push('// Its sheet and the twins of its pictures: the same frames in the same places (DX-MAPS).');
  out.push('static assets = {');
  out.push('  spritesheets: {');
  out.push(`    ${el.sheet}: { json: '${el.sheet}.json', png: '${el.sheet}.png'${twins} },`);
  out.push('  },');
  out.push('};');
  out.push('');
  if (look.sun === 'hull' || look.lamps === 'hull') {
    out.push('// The model\'s hull: x, y on the floor (floor px), z its height (screen px).');
    const pts = el.hull ?? [];
    const rows = [];
    for (let k = 0; k < pts.length; k += 12) rows.push('  ' + pts.slice(k, k + 12).map((v) => num(v, 1)).join(', ') + ',');
    out.push('const HULL = [', ...rows, '];');
    out.push('');
  }
  const directional = el.kind === 'prop' || el.kind === 'car' || el.kind === 'char';
  const components = directional ? 'DirectionalSprite, ShadowCaster' : 'SpriteRenderer, ShadowCaster';
  out.push(`class ${className(el)} extends GameObject {`);
  out.push(`  static components = [${components}];`);
  out.push('');
  out.push('  onSpawned() {');
  out.push(line(4, `this.setSpritesheet('${el.sheet}');`));
  out.push(line(4, `this.setAnchor(${num(asset.anchorX, 3)}, ${num(asset.anchorY, 3)});`, 'the foot, where every frame has it'));
  if (asset.scale !== 1) out.push(line(4, `this.setScale(${num(asset.scale)});`, 'the sheet at the scene\'s scale (its maps follow)'));
  if (el.kind === 'prop') {
    out.push(line(4, "this.setAnimation('stand');", 'no direction: the json\'s directions (32 renders)'));
    out.push(line(4, `this.directionalSprite.facing = ${num(el.facing)};`, `${num(((el.facing * DEG) % 360 + 360) % 360, 0)}°; 90° looks at the camera`));
  } else if (el.kind === 'car') {
    out.push(line(4, "this.setAnimation('drive');", 'half a turn drawn, the rest mirrored (mirrorX)'));
    out.push(line(4, `this.directionalSprite.facing = ${num(el.facing)};`, `${num(((el.facing * DEG) % 360 + 360) % 360, 0)}°: where it heads`));
  } else if (el.kind === 'char') {
    out.push(line(4, "this.directionalSprite.facingFrom = 'velocity';", 'it faces where it walks'));
    out.push(line(4, "this.setAnimation('idle');", 'walk_up, idle_left…: directions from the names'));
  } else {
    out.push(line(4, `this.setAnimation('${el.anim}');`, 'one view'));
  }
  // The shadows: the same order as applyLook.
  if (look.sun === look.lamps) {
    const l = castLine('this.shadowCaster', look.sun, el, look);
    out.push(l ?? line(4, `// Shadows: its sheet's way (${autoText(el, 'sun', mapsOn)}).`));
  } else {
    out.push(castLine('this.shadowCaster.sun', look.sun, el, look) ?? line(4, `// The sun: its sheet's way (${autoText(el, 'sun', mapsOn)}).`));
    out.push(castLine('this.shadowCaster.lamps', look.lamps, el, look) ?? line(4, `// The lamps: its sheet's way (${autoText(el, 'lamps', mapsOn)}).`));
  }
  if (castsVolume(look)) {
    out.push(line(4, `this.rotation = ${num(volumeRotation(el.sheet, el.facing))};`, 'a volume turns with rotation; the sprite does not'));
  }
  if (look.self !== 'auto') out.push(line(4, `this.shadowCaster.selfShadow = ${look.self === 'on'};`, look.self === 'on' ? 'it shades itself' : 'it does not shade itself'));
  if (look.base > 0) out.push(line(4, `this.shadowCaster.baseRadius = ${num(look.base, 1)};`, 'px: corrects the measured base'));
  if (look.opacity < 1) out.push(line(4, `this.shadowCaster.opacity = ${num(look.opacity)};`, `takes out ${num(look.opacity * 100, 0)} % of the light`));
  if (look.normals !== 'auto') {
    const why = { map: 'its normal map', height: 'normals from its height map', flat: 'flat: lit as the floor' }[look.normals];
    out.push(line(4, `this.spriteRenderer.normals = '${look.normals}';`, why));
  }
  if (look.emissive) out.push(line(4, 'this.spriteRenderer.emissive = true;', 'it glows: no night or shadow darkens it'));
  out.push('  }');
  if (el.kind === 'char') {
    out.push('');
    out.push('  tick(dtRatio) {');
    out.push(line(4, '// WASD moves it (this.x, this.y), then:'));
    out.push(line(4, "this.setAnimation(moving ? 'walk' : 'idle');", 'no direction: it faces its velocity'));
    out.push('  }');
  }
  out.push('}');
  return out.join('\n');
}

/**
 * A lamp's code.
 * @param {{ color: number, radius: number, elevation: number, brightness: number, castShadows: boolean, r: number }} lamp
 */
export function lampCode(lamp) {
  const out = [];
  out.push('class Lamp extends GameObject {');
  out.push('  static components = [Collider, LightEmitter];');
  out.push('');
  out.push('  onSpawned() {');
  out.push(line(4, 'this.collider.radius = 4;'));
  out.push(line(4, '// elevation: the bulb\'s real height in px. In an oblique scene it is in the shadows\' geometry:'));
  out.push(line(4, '// a car under a lamp 150 px up casts a short shadow, under one 40 px up a long one.'));
  out.push(line(4, 'Object.assign(this.lightEmitter, {'));
  out.push(line(6, `color: ${hex(lamp.color)},`));
  out.push(line(6, `radius: ${num(lamp.radius, 0)},`, 'px it reaches, on the floor'));
  out.push(line(6, `elevation: ${num(lamp.elevation, 0)},`));
  out.push(line(6, `brightness: ${num(lamp.brightness)},`));
  out.push(line(6, `castShadows: ${lamp.castShadows},`, lamp.castShadows ? 'its own shadow map (lampShadows: \'map\')' : 'light only: cheaper'));
  out.push(line(4, '});'));
  out.push('  }');
  if (lamp.r > 0) {
    out.push('');
    out.push('  tick(dtRatio, dt) {');
    out.push(line(4, `// a slow circle of ${num(lamp.r, 0)} px: this.setPosition(cx + cos(phase) * r, cy + sin(phase) * r * floorScaleY)`));
    out.push('  }');
  }
  out.push('}');
  return out.join('\n');
}

/**
 * The scene's code: its config and the sun.
 * @param {object} s the bench's settings: pitch, floorScaleY and heightScaleY (null: from the pitch), backend, depth
 *   (null|true|false), ambient, resolution, sunMap, lampMap, self, sweep, maps, hour, sunHeight, sunTurn, intensity, cycle
 */
export function sceneCode(s) {
  const out = [];
  out.push('static config = {');
  const floor = s.floorScaleY === null ? '' : `, floorScaleY: ${num(s.floorScaleY, 3)}`;
  const height = s.heightScaleY === null ? '' : `, heightScaleY: ${num(s.heightScaleY, 3)}`;
  const flat = s.pitch === 90 || s.pitch === 0;
  out.push(line(2, `camera: { pitch: ${num(s.pitch, 1)}${floor}${height} },`,
    flat ? 'a flat view: the 2D sweep, walls stop the lamps' : floor || height ? 'how the pictures were drawn' : 'floor sin(pitch), heights cos(pitch)'));
  const depth = s.depth === null ? '' : `, pixelDepth: ${s.depth}`;
  out.push(line(2, `renderer: { backend: '${s.backend}', ySort: true${depth} },`,
    s.depth === null ? 'pixel depth: on by itself (oblique, maps)' : s.depth ? 'depth corrects the painter' : 'the painter alone'));
  out.push('  lighting: {');
  out.push(line(4, `enabled: true, shadowsEnabled: true, baseAmbient: ${num(s.ambient)},`));
  out.push(line(4, `resolution: ${num(s.resolution)}, shadowResolution: ${num(s.resolution)},`, 'the light pass and the shadows, × canvas'));
  out.push(line(4, `sunShadows: '${s.sunMap ? 'map' : 'sprite'}',`, s.sunMap ? 'the sun\'s shadow map: it takes out the sun alone' : 'cards on the shadows\' layer'));
  out.push(line(4, `lampShadows: '${s.lampMap ? 'map' : 'sprite'}',`, s.lampMap ? 'a shadow map a lamp' : 'stamps on the shadows\' layer'));
  out.push(line(4, `selfShadow: ${s.self},`, 'what has height shades itself'));
  if (!s.sweep) out.push(line(4, 'footprintSolids: false,', 'solids as columns down to the floor'));
  out.push(line(4, 'sun: { enabled: true, shadowAlpha: 0.7, shadowStretchAlphaFactor: 0 },'));
  out.push('  },');
  out.push('};');
  out.push('');
  out.push('create() {');
  if (s.sunHeight !== 90) out.push(line(2, `Sun.maxElevation = ${num(s.sunHeight, 0)};`, 'how high the sun climbs at noon'));
  if (s.sunTurn !== 0) out.push(line(2, `Sun.shadowAngleOffset = Math.PI + ${num(s.sunTurn * Math.PI / 180, 3)};`, 'its path turned'));
  out.push(line(2, `Sun.setTimeOfDay(${num(s.hour)});`, 'direction, height, intensity and colour'));
  if (s.intensity !== 1) out.push(line(2, `Sun.intensity *= ${num(s.intensity)};`));
  out.push('}');
  if (s.cycle > 0) {
    out.push('');
    out.push('update(dtRatio, dt) {');
    out.push(line(2, `Sun.setTimeOfDay(Sun.hour + dt * ${num(s.cycle / 1000, 4)});`, `${num(s.cycle)} hours a second`));
    out.push('}');
  }
  if (!s.maps) {
    out.push('');
    out.push('// (no heightMap or normalMap in the sheets: lit as the floor, as before)');
  }
  return out.join('\n');
}
