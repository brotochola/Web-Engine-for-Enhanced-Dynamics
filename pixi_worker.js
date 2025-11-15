importScripts("config.js");
importScripts("sharedArrays.js");
importScripts("pixi4webworkers.js");
importScripts("gameObject.js");
importScripts("boid.js");

let FRAMENUM = 0;
let app;
let width, height, canvasWidth, canvasHeight, resolution, view;
let arrays;
let inputData;
let cameraData;
const bunnies = [];
let lastTime = performance.now();
let fps = 0;
let mainContainer = new PIXI.Container();
let pause = true;
function getPosicionEnPantalla(x, y) {
  return {
    x: x * mainContainer.scale.x + mainContainer.x,
    y: y * mainContainer.scale.y + mainContainer.y,
  };
}

function isBunnyOnTheScreen(worldX, worldY) {
  // Calculate the visible world area based on camera position and zoom
  const pos = getPosicionEnPantalla(worldX, worldY);
  const marginX = canvasWidth * 0.25;
  const marginY = canvasHeight * 0.25;
  if (
    pos.x > -marginX &&
    pos.x < canvasWidth + marginX &&
    pos.y > -marginY &&
    pos.y < canvasHeight + marginY
  ) {
    return true;
  }
  return false;
}

function gameLoop(resuming = false) {
  if (pause) return;
  FRAMENUM++;
  const now = performance.now();
  const deltaTime = now - lastTime;
  lastTime = now;
  fps = 1000 / deltaTime;
  const dtRatio = resuming ? 1 : deltaTime / 16.67;
  // Read camera state from shared buffer
  const zoom = cameraData[0];
  const containerX = cameraData[1];
  const containerY = cameraData[2];

  // Apply camera state to main container
  mainContainer.scale.set(zoom);
  mainContainer.x = containerX;
  mainContainer.y = containerY;

  // Cache array references for performance
  const x = arrays.x;
  const y = arrays.y;
  const rotation = arrays.rotation;
  const scale = arrays.scale;

  // Update sprite positions
  // This is cache-friendly! Sequential reads from x[], y[], rotation[]
  for (let i = 0; i < ENTITY_COUNT; i++) {
    const bunny = bunnies[i];
    if (bunny) {
      if (isBunnyOnTheScreen(x[i], y[i])) {
        bunny.visible = true;
        bunny.x = x[i];
        bunny.y = y[i];
        bunny.rotation = rotation[i];
        bunny.scale.set(scale[i]);
        bunny.zIndex = y[i];
      } else {
        bunny.visible = false;
      }
    }
  }

  // Log FPS every 30 frames
  if (FRAMENUM % 30 === 0) {
    self.postMessage({ msg: "fps", fps: fps.toFixed(2) });
  }
}

async function initPIXI(data) {
  pause = false;
  console.log("PIXI WORKER: Initializing PIXI with SharedArrayBuffer (SoA)");

  arrays = new BoidArrays(data.sharedBuffer);
  inputData = new Int32Array(data.inputBuffer);
  cameraData = new Float32Array(data.cameraBuffer);

  width = data.width;
  height = data.height;
  canvasWidth = data.canvasWidth;
  canvasHeight = data.canvasHeight;
  resolution = data.resolution;
  view = data.view;

  // Create PIXI application
  app = new PIXI.Application({
    width: canvasWidth,
    height: canvasHeight,
    resolution,
    view,
    backgroundColor: 0x000000,
    // Performance optimizations
    antialias: false, // Disable antialiasing for better performance
    powerPreference: "high-performance",
  });

  // Load texture
  const texture = await PIXI.Assets.load(
    "https://brotochola.github.io/render_from_webworkers_and_multithreading/1.png"
  );

  app.stage.addChild(mainContainer);
  mainContainer.sortableChildren = true;

  // Create sprites
  for (let i = 0; i < ENTITY_COUNT; i++) {
    const bunny = new PIXI.Sprite(texture);
    bunny.anchor.set(0.5);
    bunny.scale.set(arrays.scale[i]);
    bunny.x = arrays.x[i];
    bunny.y = arrays.y[i];
    bunnies.push(bunny);
    mainContainer.addChild(bunny);
  }

  console.log(`PIXI WORKER: Created ${ENTITY_COUNT} sprites`);

  // Start render loop - runs independently at ~60fps
  app.ticker.add(gameLoop);
}

self.onmessage = (e) => {
  if (e.data.msg === "init") {
    pause = false;
    initPIXI(e.data);
  }
  if (e.data.msg === "pause") {
    pause = true;
  }
  if (e.data.msg === "resume") {
    pause = false;
    gameLoop(true);
  }
};
