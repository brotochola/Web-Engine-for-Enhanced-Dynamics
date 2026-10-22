#!/usr/bin/env node
// npm create weed-game [folder]: copies template/ into a new folder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = process.argv[2] || 'my-weed-game';
const target = path.resolve(folder);

if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
  console.error(`${folder} already exists and is not empty. Pick another name: npm create weed-game my-game`);
  process.exit(1);
}

fs.cpSync(fileURLToPath(new URL('./template', import.meta.url)), target, { recursive: true });
// npm leaves .gitignore out of published packages, so the template ships it as _gitignore.
fs.renameSync(path.join(target, '_gitignore'), path.join(target, '.gitignore'));

const pkgFile = path.join(target, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
pkg.name = path.basename(target).toLowerCase().replace(/[^a-z0-9._~-]+/g, '-').replace(/^[._-]+/, '') || 'weed-game';
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');

console.log(`
Your game is in ${folder}. Next:

  cd ${folder}
  npm install
  npm run dev

Then open http://localhost:8000 and edit src/gameScene.js: the game reloads where you were.
`);
