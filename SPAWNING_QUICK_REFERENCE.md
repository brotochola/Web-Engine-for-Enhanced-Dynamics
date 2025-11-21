# Entity Spawning - Quick Reference Card

## 🎮 Main Thread API

```javascript
// Spawn entity
gameEngine.spawnEntity("Prey", { x: 500, y: 300 });

// Check pool stats
const stats = gameEngine.getPoolStats(Prey);
// Returns: { total: 10000, active: 523, available: 9477 }

// Despawn all of one type
gameEngine.despawnAllEntities("Predator");
```

## 🔧 Worker Thread API

```javascript
// Spawn entity in logic worker
const prey = GameObject.spawn(Prey, {
  x: 500,
  y: 300,
  vx: 2,
  vy: -1,
});

// Check if spawn succeeded
if (prey) {
  console.log("Spawned!");
} else {
  console.log("Pool exhausted!");
}

// Get pool stats
const stats = GameObject.getPoolStats(Prey);

// Despawn all
GameObject.despawnAll(Predator);
```

## 🧬 Entity Lifecycle

```javascript
class MyEntity extends RenderableGameObject {
  // Called ONCE when first created
  start() {
    this.maxHealth = 100;
  }

  // Called EVERY TIME entity spawns
  awake() {
    this.health = this.maxHealth;
    this.setTint(0xffffff);
    this.ax = 0;
    this.ay = 0;
  }

  // Called EVERY TIME entity despawns
  sleep() {
    console.log("Despawned with", this.health, "health");
  }

  tick(dtRatio, inputData) {
    if (this.health <= 0) {
      this.despawn(); // Return to pool
    }
  }
}
```

## 📋 Registration

```javascript
// Register with pool size
gameEngine.registerEntityClass(Prey, 10000, "prey.js");
//                                     ^^^^^ pool size

// Now 10000 Prey entities are pre-allocated
// All start inactive (active = 0)
```

## 💡 Common Patterns

### Spawn at Mouse

```javascript
canvas.addEventListener("click", () => {
  gameEngine.spawnEntity("Prey", {
    x: mouseWorldX,
    y: mouseWorldY,
  });
});
```

### Auto-Despawn Off-Screen

```javascript
tick(dtRatio, inputData) {
  if (!this.isItOnScreen) {
    this.despawn();
  }
}
```

### Spawn Wave

```javascript
function spawnWave(count) {
  for (let i = 0; i < count; i++) {
    gameEngine.spawnEntity("Enemy", {
      x: Math.random() * worldWidth,
      y: 100,
    });
  }
}
```

### Check Before Spawn

```javascript
const stats = GameObject.getPoolStats(Bullet);
if (stats.available > 0) {
  GameObject.spawn(Bullet, { x: this.x, y: this.y });
}
```

## ⚠️ Important Rules

| ✅ DO                      | ❌ DON'T                     |
| -------------------------- | ---------------------------- |
| Use `entity.despawn()`     | Set `active[i] = 0` directly |
| Reset state in `awake()`   | Leave stale state            |
| Check `available` count    | Spawn in tight loops         |
| Use `spawn()` return value | Assume spawn always succeeds |

## 🔍 Debug Tips

```javascript
// Monitor pool in console
setInterval(() => {
  const s = GameObject.getPoolStats(Prey);
  console.log(`Prey: ${s.active}/${s.total}`);
}, 1000);

// Log lifecycle events
awake() {
  console.log(`${this.constructor.name} ${this.index} spawned`);
}

sleep() {
  console.log(`${this.constructor.name} ${this.index} despawned`);
}
```

## 📊 Pool Stats Object

```javascript
{
  total: 10000,      // Pool size
  active: 523,       // Currently active
  available: 9477    // Available for spawn
}
```

## 🎯 Quick Test

```html
<button onclick="test()">Test Spawn</button>
<script>
  function test() {
    // Spawn 5 entities
    for (let i = 0; i < 5; i++) {
      gameEngine.spawnEntity("Prey", {
        x: 400 + i * 50,
        y: 300,
      });
    }

    // Check stats
    const s = gameEngine.getPoolStats(Prey);
    console.log(`Active: ${s.active}/${s.total}`);
  }
</script>
```

---

**That's it! Start spawning entities! 🚀**
