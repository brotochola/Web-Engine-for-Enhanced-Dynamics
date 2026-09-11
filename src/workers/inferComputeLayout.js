/**
 * Infer compute bind-group specs from WGSL @group/@binding declarations.
 * Scene still declares textures/buffers; this only wires slots to those names.
 */

const ENGINE_ALIASES = {
  frame: 'params',
  params: 'params',
  bodies: 'bodies',
  shapes: 'bodies',
  verts: 'verts',
};

const SUFFIXES = ['Texture', 'Write', 'Read', 'Tex'];

const BINDING_RE =
  /@(?:group\s*\(\s*(\d+)\s*\)\s*@binding\s*\(\s*(\d+)\s*\)|binding\s*\(\s*(\d+)\s*\)\s*@group\s*\(\s*(\d+)\s*\))\s*var\s*(?:<([^>]*)>)?\s+(\w+)\s*:\s*([^;]+);/g;

function stripWgslComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

function sampleTypeForFormat(format) {
  const f = format || '';
  if (f.indexOf('32float') !== -1) return 'unfilterable-float';
  return 'float';
}

function stemResource(ident) {
  if (ENGINE_ALIASES[ident]) {
    return { resource: ENGINE_ALIASES[ident], ping: null, stripped: false };
  }
  let stem = ident;
  let ping = null;
  let stripped = false;
  for (let i = 0; i < SUFFIXES.length; i++) {
    const s = SUFFIXES[i];
    if (stem.length > s.length && stem.endsWith(s)) {
      if (s === 'Write') ping = 'write';
      else if (s === 'Read') ping = 'read';
      stem = stem.slice(0, -s.length);
      stripped = true;
      break;
    }
  }
  return { resource: stem, ping, stripped };
}

function knownResource(name, textures, buffers) {
  if (name === 'params' || name === 'bodies' || name === 'verts') return true;
  for (let i = 0; i < textures.length; i++) {
    if (textures[i].name === name) return true;
  }
  for (let i = 0; i < buffers.length; i++) {
    if (buffers[i].name === name) return true;
  }
  return false;
}

function textureFormat(name, textures) {
  for (let i = 0; i < textures.length; i++) {
    if (textures[i].name === name) return textures[i].format || 'rgba8unorm';
  }
  return null;
}

function parseStorageType(typeSrc) {
  const m = /texture_storage_2d\s*<\s*([A-Za-z0-9_]+)\s*,\s*([A-Za-z0-9_]+)\s*>/.exec(typeSrc);
  if (!m) return null;
  const accessWgsl = m[2];
  let access = 'write-only';
  if (accessWgsl === 'read') access = 'read-only';
  else if (accessWgsl === 'read_write') access = 'read-write';
  return { format: m[1], access };
}

function bufferKind(space) {
  const parts = String(space || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts[0] === 'uniform') return 'uniform';
  if (parts[0] === 'storage') {
    if (parts[1] === 'read') return 'read-only-storage';
    return 'storage';
  }
  return null;
}

/**
 * @param {string} wgsl
 * @param {{ textures?: Array<{name:string, format?:string}>, buffers?: Array<{name:string}> }} ctx
 * @returns {Array<Array<object>>}
 */
export function inferComputeLayout(wgsl, ctx) {
  const textures = ctx?.textures || [];
  const buffers = ctx?.buffers || [];
  const text = stripWgslComments(wgsl);
  const byGroup = Object.create(null);
  BINDING_RE.lastIndex = 0;
  let m;
  while ((m = BINDING_RE.exec(text))) {
    const group = Number(m[1] != null ? m[1] : m[4]);
    const binding = Number(m[2] != null ? m[2] : m[3]);
    const space = m[5] || '';
    const ident = m[6];
    const typeSrc = m[7] || '';
    const mapped = stemResource(ident);
    if (!knownResource(mapped.resource, textures, buffers)) {
      throw new Error(
        `WeedJS: unknown compute resource "${ident}" (stem "${mapped.resource}") at @group(${group}) @binding(${binding})`
      );
    }
    const entry = { binding, resource: mapped.resource };
    const buf = bufferKind(space);
    if (buf) {
      entry.buffer = buf;
    } else {
      const storage = parseStorageType(typeSrc);
      if (storage) {
        entry.storageTexture = { format: storage.format, access: storage.access };
        entry.ping = mapped.ping || 'write';
      } else if (/texture_2d\s*</.test(typeSrc)) {
        const format = textureFormat(mapped.resource, textures) || 'rgba8unorm';
        entry.texture = { sampleType: sampleTypeForFormat(format) };
        entry.ping = mapped.ping || 'read';
      } else {
        throw new Error(
          `WeedJS: unsupported compute binding "${ident}" at @group(${group}) @binding(${binding})`
        );
      }
    }
    if (!byGroup[group]) byGroup[group] = [];
    byGroup[group].push(entry);
  }
  const groupIdx = Object.keys(byGroup)
    .map((n) => n | 0)
    .sort((a, b) => a - b);
  if (!groupIdx.length) return [];
  const max = groupIdx[groupIdx.length - 1];
  const groups = [];
  for (let g = 0; g <= max; g++) {
    const list = byGroup[g] || [];
    list.sort((a, b) => a.binding - b.binding);
    groups.push(list);
  }
  return groups;
}
