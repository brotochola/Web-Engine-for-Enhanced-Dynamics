/**
 * Classify a Node test file against a bundle export set.
 * ponytail: static regex only — computed import(x) is not seen; the register
 * hook still remaps src/ and throws if a named export is missing (no src/ fallback).
 */
import fs from 'node:fs';
import path from 'node:path';

const FROM_IMPORT_RE = /\bimport\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT_RE = /\bimport\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

function isUnderDir(filePath, dir) {
  const rel = path.relative(dir, filePath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function resolveSpecifier(specifier, fromFile) {
  if (!specifier || specifier.startsWith('node:')) return null;
  if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
    return path.normalize(path.resolve(path.dirname(fromFile), specifier));
  }
  return null;
}

export function isSrcPath(absPath, repoRoot) {
  if (!absPath) return false;
  return isUnderDir(absPath, path.resolve(repoRoot, 'src'));
}

export function isBarrelPath(absPath) {
  if (!absPath) return false;
  const base = path.basename(absPath);
  return base === 'index.js' || base === 'index.bundle.js';
}

export function parseImportClause(clause) {
  const c = (clause || '').trim();
  if (!c) return { sideEffect: true, default: false, namespace: false, names: [] };

  const result = { sideEffect: false, default: false, namespace: false, names: [] };

  if (/^\*\s+as\s+/.test(c)) {
    result.namespace = true;
    return result;
  }

  let rest = c;
  if (!c.startsWith('{')) {
    const defaultAnd = c.match(/^([A-Za-z_$][\w$]*)\s*,\s*([\s\S]+)$/);
    if (defaultAnd) {
      result.default = true;
      rest = defaultAnd[2].trim();
      if (/^\*\s+as\s+/.test(rest)) {
        result.namespace = true;
        return result;
      }
    } else if (IDENT_RE.test(c)) {
      result.default = true;
      return result;
    }
  }

  const named = rest.match(/\{([\s\S]*)\}/);
  if (named) {
    for (const part of named[1].split(',')) {
      const p = part.trim();
      if (!p) continue;
      const m = p.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+[A-Za-z_$][\w$]*)?$/);
      if (m) result.names.push(m[1]);
    }
  }

  return result;
}

export function collectImports(source) {
  const out = [];
  let m;
  FROM_IMPORT_RE.lastIndex = 0;
  while ((m = FROM_IMPORT_RE.exec(source))) {
    out.push({ specifier: m[2], clause: m[1], dynamic: false, sideEffect: false });
  }
  SIDE_EFFECT_IMPORT_RE.lastIndex = 0;
  while ((m = SIDE_EFFECT_IMPORT_RE.exec(source))) {
    out.push({ specifier: m[1], clause: '', dynamic: false, sideEffect: true });
  }
  DYNAMIC_IMPORT_RE.lastIndex = 0;
  while ((m = DYNAMIC_IMPORT_RE.exec(source))) {
    out.push({ specifier: m[1], clause: '', dynamic: true, sideEffect: false });
  }
  return out;
}

function stripStaticImports(source) {
  return source
    .replace(FROM_IMPORT_RE, ' ')
    .replace(SIDE_EFFECT_IMPORT_RE, ' ')
    .replace(DYNAMIC_IMPORT_RE, ' ');
}

export function findSrcDiskReads(source) {
  const rest = stripStaticImports(source);
  const hits = [];
  const re = /(['"`])([^'"`]+)\1/g;
  let m;
  while ((m = re.exec(rest))) {
    const spec = m[2].replace(/\\/g, '/');
    if (spec.includes('/src/') || spec.startsWith('src/')) hits.push(spec);
  }
  if (/\b(?:path\.)?(?:join|resolve)\s*\([^;)]*(['"])src\1/.test(rest)) {
    hits.push("join(..., 'src', ...)");
  }
  return hits;
}

function prettySrc(absPath, repoRoot) {
  return path.relative(repoRoot, absPath).replace(/\\/g, '/');
}

/**
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function classifyTestFile(source, { fromFile, repoRoot, exportNames }) {
  const names = exportNames instanceof Set ? exportNames : new Set(exportNames || []);
  const disk = findSrcDiskReads(source);
  if (disk.length) {
    return { ok: false, reason: 'reads src/ on disk' };
  }

  const missing = [];
  for (const imp of collectImports(source)) {
    const abs = resolveSpecifier(imp.specifier, fromFile);
    if (!isSrcPath(abs, repoRoot)) continue;

    const rel = prettySrc(abs, repoRoot);
    if (imp.sideEffect) {
      return { ok: false, reason: `side-effect import of ${rel}` };
    }
    if (imp.dynamic) {
      if (isBarrelPath(abs)) continue;
      return { ok: false, reason: `dynamic import of ${rel}` };
    }

    const clause = parseImportClause(imp.clause);
    if (clause.sideEffect) {
      return { ok: false, reason: `side-effect import of ${rel}` };
    }
    if (clause.namespace && !isBarrelPath(abs)) {
      return { ok: false, reason: `namespace import of ${rel}` };
    }
    if (clause.default && !isBarrelPath(abs)) {
      return { ok: false, reason: `default import of ${rel}` };
    }
    if (clause.default && !names.has('default')) {
      missing.push('default');
    }
    for (const name of clause.names) {
      if (!names.has(name)) missing.push(name);
    }
  }

  if (missing.length) {
    const uniq = [...new Set(missing)];
    return { ok: false, reason: `missing ${uniq.join(', ')}` };
  }
  return { ok: true };
}

const WALK_EXT = new Set(['.js', '.mjs', '.cjs']);

function resolveWalkTarget(specifier, fromFile, repoRoot) {
  const abs = resolveSpecifier(specifier, fromFile);
  if (!abs || isSrcPath(abs, repoRoot)) return null;
  const candidates = [abs];
  if (!path.extname(abs)) {
    candidates.push(`${abs}.js`, `${abs}.mjs`, `${abs}.cjs`);
  }
  const nodeModules = path.join(repoRoot, 'node_modules');
  const distDir = path.join(repoRoot, 'dist');
  const scriptsDir = path.join(repoRoot, 'scripts');
  for (const c of candidates) {
    if (!WALK_EXT.has(path.extname(c)) || !fs.existsSync(c)) continue;
    if (!isUnderDir(c, repoRoot)) continue;
    if (
      isUnderDir(c, nodeModules) ||
      isUnderDir(c, distDir) ||
      isUnderDir(c, scriptsDir) ||
      isSrcPath(c, repoRoot)
    ) {
      continue;
    }
    return c;
  }
  return null;
}

function collectGraphSources(entryFile, repoRoot) {
  const out = [];
  const seen = new Set();
  const visit = (file) => {
    const norm = path.normalize(file);
    if (seen.has(norm) || !fs.existsSync(norm)) return;
    seen.add(norm);
    const source = fs.readFileSync(norm, 'utf8');
    out.push({ source, fromFile: norm });
    for (const imp of collectImports(source)) {
      const next = resolveWalkTarget(imp.specifier, norm, repoRoot);
      if (next) visit(next);
    }
  };
  visit(entryFile);
  return out;
}

export function classifyTestPath(filePath, { repoRoot, exportNames }) {
  for (const { source, fromFile } of collectGraphSources(filePath, repoRoot)) {
    const result = classifyTestFile(source, { fromFile, repoRoot, exportNames });
    if (!result.ok) return result;
  }
  return { ok: true };
}
