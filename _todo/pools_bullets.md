


class DecorationPool extends SharedAtomicPool {
  static spawn(config)
  static despawn(i)
  static tickAll(dt)
}

class ParticlePool extends SharedAtomicPool {
  static spawn(config)
  static despawn(i)
  static tickAll(dt)
}

class BulletPool extends SharedAtomicPool {
  static spawn({ x, y, vx, vy, damage, ownerId, textureId })
  static despawn(i)
  static tickAll(dt)
}


const BulletComponent = {
  active: Uint8Array,

  x: Float32Array,
  y: Float32Array,

  vx: Float32Array,
  vy: Float32Array,

  damage: Float32Array,
  ownerId: Uint16Array,

  textureId: Uint16Array,   // ← renderable
  scale: Float32Array,
  alpha: Float32Array,
  tint: Uint32Array
};


logic_worker → BulletPool.spawn()

particle_worker:
    BulletPool.tickAll()
    ParticlePool.tickAll()
    DecorationPool.tickAll()
    let logicWorkerIdx=entityIdThatGotShot%totalLogicWorkers;
    logicworkersMessagePorts[logicWorkerIdx].postMessage(  unit16:[entityIdThatGotShot,damage,impactX,impactY,linearSpeed, force,...])

logic_worker:
  recibe mensaje



`
static tickAll(dt) {
  for (let i = 0; i < this.maxCount; i++) {
    if (!BulletComponent.active[i]) continue;

    const px = BulletComponent.x[i];
    const py = BulletComponent.y[i];

    BulletComponent.prevX[i] = px;
    BulletComponent.prevY[i] = py;

    const nx = px + BulletComponent.vx[i] * dt;
    const ny = py + BulletComponent.vy[i] * dt;

    BulletComponent.x[i] = nx;
    BulletComponent.y[i] = ny;

    const hit = Grid.raycastSegment(px, py, nx, ny);

    if (hit) {
      ImpactEventBuffer.push({
        targetId: hit.entityId,
        x: hit.x,
        y: hit.y,
        damage: BulletComponent.damage[i],
        ownerId: BulletComponent.ownerId[i]
      });

      ParticlePool.spawn({
        x: hit.x,
        y: hit.y,
        texture: "impact_spark",
        count: 6
      });

      this.despawn(i);
    }
  }
}

`


---------------------------------

Logic worker:




🧠 Lectura (logic_worker)


let pendingImpactBuffer = null;

onmessage = (e) => {
  pendingImpactBuffer = e.data;
};

function logicFrame() {
  if (pendingImpactBuffer) {
    processImpacts(pendingImpactBuffer);
    returnBuffer(pendingImpactBuffer);
    pendingImpactBuffer = null;

    for(let idx of pendingImpactBuffer){
        GameObject.get(idx).onGotshot(...)
    }
  }

  updateEntities();
}
