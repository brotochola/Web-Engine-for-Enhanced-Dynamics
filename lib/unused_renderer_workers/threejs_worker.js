// threejs_worker.js - High-performance rendering using Three.js InstancedMesh
// Uses instanced rendering for maximum performance (single draw call for all sprites)

importScripts(
  "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"
);
importScripts("config.js");
importScripts("gameObject.js");

let FRAMENUM = 0;
let renderer;
let scene;
let camera;
let instancedMesh;
let width, height, canvasWidth, canvasHeight;
let inputData;
let cameraData;
let entityCount = 0;
let lastTime = performance.now();
let fps = 0;
let pause = true;

// Three.js objects for matrix manipulation
const matrix = new THREE.Matrix4();
const position = new THREE.Vector3();
const rotation = new THREE.Quaternion();
const scale = new THREE.Vector3(1, 1, 1);

// Frustum culling
let visibleCount = 0;
const frustum = new THREE.Frustum();
const cameraViewProjectionMatrix = new THREE.Matrix4();
const boundingSphere = new THREE.Sphere();
const cullingRadius = 10; // Adjust based on your sprite size

function gameLoop(resuming = false) {
  if (pause) return;
  FRAMENUM++;
  const now = performance.now();
  const deltaTime = now - lastTime;
  lastTime = now;
  fps = 1000 / deltaTime;

  // Read camera state from shared buffer (in world coordinates, Y-down)
  const zoom = cameraData[0];
  const worldCameraX = cameraData[1]; // Camera position in world space
  const worldCameraY = cameraData[2];

  // Convert world-space camera to Three.js orthographic camera bounds
  // World space: Y-down, origin at top-left
  // Three.js space: Y-up, camera looks at center

  const halfWidth = canvasWidth / 2 / zoom;
  const halfHeight = canvasHeight / 2 / zoom;

  // Camera shows world coordinates from [worldCameraX, worldCameraY]
  // to [worldCameraX + canvasWidth/zoom, worldCameraY + canvasHeight/zoom]

  camera.left = worldCameraX;
  camera.right = worldCameraX + canvasWidth / zoom;
  camera.top = -worldCameraY; // Flip Y axis
  camera.bottom = -(worldCameraY + canvasHeight / zoom); // Flip Y axis
  camera.updateProjectionMatrix();

  // Update frustum for culling
  cameraViewProjectionMatrix.multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse
  );
  frustum.setFromProjectionMatrix(cameraViewProjectionMatrix);

  // Cache array references for performance
  const x = GameObject.x;
  const y = GameObject.y;
  const rotationArray = GameObject.rotation;
  const scaleArray = GameObject.scale;

  visibleCount = 0;

  // Update instance matrices from GameObject arrays
  for (let i = 0; i < entityCount; i++) {
    const worldX = x[i]; // World space X (same in Three.js)
    const worldY = y[i]; // World space Y (Y-down)
    const threeY = -worldY; // Three.js Y (Y-up)

    // Simple frustum culling using bounding sphere
    boundingSphere.center.set(worldX, threeY, 0);
    boundingSphere.radius = cullingRadius * scaleArray[i];

    if (frustum.intersectsSphere(boundingSphere)) {
      // Sprite is visible
      position.set(worldX, threeY, 0);
      rotation.setFromAxisAngle(new THREE.Vector3(0, 0, 1), rotationArray[i]);
      scale.set(scaleArray[i] * 10, scaleArray[i] * 10, 1);

      matrix.compose(position, rotation, scale);
      instancedMesh.setMatrixAt(i, matrix);
      visibleCount++;
    } else {
      // Sprite is not visible - move far away
      position.set(999999, 999999, 0);
      matrix.compose(position, rotation, scale);
      instancedMesh.setMatrixAt(i, matrix);
    }
  }

  // Tell Three.js to update the instance matrix buffer
  instancedMesh.instanceMatrix.needsUpdate = true;

  // Render the scene
  renderer.render(scene, camera);

  // Log FPS every 30 frames
  if (FRAMENUM % 30 === 0) {
    self.postMessage({
      msg: "fps",
      fps: fps.toFixed(2),
    });
  }

  requestAnimationFrame(gameLoop);
}

async function initThreeJS(data) {
  pause = false;
  console.log("THREE.JS WORKER: Initializing with InstancedMesh");

  entityCount = data.entityCount;

  // Initialize GameObject arrays
  GameObject.initializeArrays(data.gameObjectBuffer, entityCount);

  inputData = new Int32Array(data.inputBuffer);
  cameraData = new Float32Array(data.cameraBuffer);

  width = data.width;
  height = data.height;
  canvasWidth = data.canvasWidth;
  canvasHeight = data.canvasHeight;

  // Create renderer
  renderer = new THREE.WebGLRenderer({
    canvas: data.view,
    antialias: false,
    powerPreference: "high-performance",
  });
  // renderer.setSize(canvasWidth, canvasHeight);
  renderer.setClearColor(0x000000, 1);

  // Create scene
  scene = new THREE.Scene();

  // Create orthographic camera (for 2D rendering)
  // Camera will be updated each frame based on world-space camera position
  camera = new THREE.OrthographicCamera(
    0,
    canvasWidth,
    0,
    -canvasHeight,
    0.1,
    1000
  );
  camera.position.set(0, 0, 10);

  // Create texture from ImageBitmap (loaded in main thread)
  const texture = new THREE.Texture(data.textureBitmap);
  texture.needsUpdate = true;

  // Create instanced mesh (ONE mesh for ALL sprites!)
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
  });

  instancedMesh = new THREE.InstancedMesh(geometry, material, entityCount);
  instancedMesh.frustumCulled = false; // We do our own culling

  // Initialize all instances with identity matrices
  for (let i = 0; i < entityCount; i++) {
    matrix.identity();
    instancedMesh.setMatrixAt(i, matrix);
  }

  scene.add(instancedMesh);

  console.log(
    `THREE.JS WORKER: Created InstancedMesh with ${entityCount} instances`
  );
  console.log(`THREE.JS WORKER: Single draw call for all sprites!`);

  // Start render loop
  gameLoop();
}

self.onmessage = (e) => {
  if (e.data.msg === "init") {
    pause = false;
    initThreeJS(e.data);
  }
  if (e.data.msg === "pause") {
    pause = true;
  }
  if (e.data.msg === "resume") {
    pause = false;
    gameLoop(true);
  }
};
