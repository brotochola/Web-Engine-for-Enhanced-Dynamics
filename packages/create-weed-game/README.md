# create-weed-game

Start a [WeedJS](https://github.com/brotochola/Web-Engine-for-Enhanced-Dynamics) game:

```sh
npm create weed-game my-game
cd my-game
npm install
npm run dev
```

Open `http://localhost:8000`. You get one scene, a player you move with WASD and an HTML HUD. Saving a script puts the new code into the running game, with no reload.

- `npm run dev`: a local server that sends the two headers `SharedArrayBuffer` needs, with the debug engine and hot reload.
- `npm run build`: `dist/`, with the production engine and a `_headers` file for Netlify and Cloudflare Pages.
- `npm run preview`: serves `dist/` the way a host would.

No bundler: the page loads the engine through an import map, and the engine's workers load your scene file themselves.
