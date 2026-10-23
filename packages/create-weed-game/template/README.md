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

The page needs two response headers (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`). `npm run dev` sends them, and the build adds a `_headers` file for Netlify and Cloudflare Pages. Hosts that cannot send headers (GitHub Pages, any static server) are covered too: the build puts `weed-sw.js` next to `index.html`, and on a player's first visit the game reloads once while it sets itself up. Details per host: [DEPLOY.md](https://github.com/brotochola/Web-Engine-for-Enhanced-Dynamics/blob/main/docs/guide/DEPLOY.md).

Next: [Your first game](https://github.com/brotochola/Web-Engine-for-Enhanced-Dynamics/blob/main/docs/guide/FIRST_GAME.md) builds a small complete game step by step. If you know Unity, Godot or Phaser, see [COMING_FROM.md](https://github.com/brotochola/Web-Engine-for-Enhanced-Dynamics/blob/main/docs/guide/COMING_FROM.md).
