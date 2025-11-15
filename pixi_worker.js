// pixi_worker.js - Rendering worker using PixiJS
// Reads GameObject arrays and renders sprites

importScripts("config.js");
importScripts("gameObject.js");
importScripts("pixi4webworkers.js");

let FRAMENUM = 0;
let app;
let width, height, canvasWidth, canvasHeight, resolution, view;
let inputData;
let cameraData;
let entityCount = 0;
const sprites = [];
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

function isSpriteOnTheScreen(worldX, worldY) {
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
  const x = GameObject.x;
  const y = GameObject.y;
  const rotation = GameObject.rotation;
  const scale = GameObject.scale;

  // Update sprite positions
  // This is cache-friendly! Sequential reads from GameObject arrays
  for (let i = 0; i < entityCount; i++) {
    const sprite = sprites[i];
    if (sprite) {
      if (isSpriteOnTheScreen(x[i], y[i])) {
        sprite.visible = true;
        sprite.x = x[i];
        sprite.y = y[i];
        sprite.rotation = rotation[i];
        sprite.scale.set(scale[i]);
        // sprite.zIndex = y[i];
      } else {
        sprite.visible = false;
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
  console.log("PIXI WORKER: Initializing PIXI with GameObject arrays");

  entityCount = data.entityCount;

  // Initialize GameObject arrays
  GameObject.initializeArrays(data.gameObjectBuffer, entityCount);

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
    antialias: false,
    powerPreference: "high-performance",
  });

  // Load texture
  const texture = await PIXI.Assets.load(
    "https://brotochola.github.io/render_from_webworkers_and_multithreading/1.png"
  );

  app.stage.addChild(mainContainer);
  mainContainer.sortableChildren = true;

  // Create sprites for all entities
  for (let i = 0; i < entityCount; i++) {
    const sprite = new PIXI.Sprite(texture);
    sprite.anchor.set(0.5);
    sprite.scale.set(GameObject.scale[i]);
    sprite.x = GameObject.x[i];
    sprite.y = GameObject.y[i];
    sprites.push(sprite);
    mainContainer.addChild(sprite);
  }

  console.log(`PIXI WORKER: Created ${entityCount} sprites`);

  // Start render loop
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
