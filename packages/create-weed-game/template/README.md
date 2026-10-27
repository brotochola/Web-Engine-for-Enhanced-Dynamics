# My WeedJS game

```sh
npm install
npm run dev       # http://localhost:8000, reloads when you save
npm run build     # dist/, ready to upload
npm run preview   # serves dist/ like a host would
```

- `index.html`: the page. It loads the engine and the scene, and holds the HTML HUD.
- `src/gameScene.js`: the scene and its entities. Workers load this file too, so it reads the engine from the global `WEED` instead of importing it.
- `scripts/`: the dev server and the build. No bundler.

## The editor

`npm run dev` also serves the editor: open http://localhost:8000/__weed/editor/?game=/index.html, or press Shift+E in the game to edit it in place. Click an entity to select it, drag it, tune its params in the inspector, place new ones from the Assets list, press Play to try the level and Stop to come back to it, and Ctrl+S to save the level's `*.scene.json` file. It is `@weed.js/editor`, a dev dependency: `npm run build` leaves it out.

The editor's **Export** builds the game for a host into `dist/`: the production engine, your game minified into `game.min.js` with its levels inside, its assets and a baked atlas, and `_headers`. `npm run build` copies the game as it is instead, without minifying; Export refuses a `dist/` that holds something else than an export, so remove it first.

`npm run dev` answers this machine only; `npm run dev -- --host` opens it to your network, to try the game on a phone.

The page needs two response headers (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`). `npm run dev` sends them, and the build adds a `_headers` file for Netlify and Cloudflare Pages. Hosts that cannot send headers (GitHub Pages, any static server) are covered too: the build puts `weed-sw.js` next to `index.html`, and on a player's first visit the game reloads once while it sets itself up. Details per host: [DEPLOY.md](https://github.com/brotochola/Web-Engine-for-Enhanced-Dynamics/blob/main/docs/guide/DEPLOY.md).

Next: [Your first game](https://github.com/brotochola/Web-Engine-for-Enhanced-Dynamics/blob/main/docs/guide/FIRST_GAME.md) builds a small complete game step by step. If you know Unity, Godot or Phaser, see [COMING_FROM.md](https://github.com/brotochola/Web-Engine-for-Enhanced-Dynamics/blob/main/docs/guide/COMING_FROM.md).
