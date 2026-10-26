# Networking plan

Multiplayer for WeedJS: browser to browser over WebRTC, one authoritative host, clients that send input and
render what the host simulates. This file is the plan: what exists, the constraints, the architecture, the
developer API we are heading to, the stages (items NET-xx) and the open decisions.

Status, 2026-10-26: stage N0 is built on the branch `networking_cars` (transport, signaling, ping, pose
codec, and the two-car demo `demos/netRacers/`). Everything after N0 is open.

Tested: `node demos/tests/netRacersTwoPages.mjs` (two pages of one headless Chromium, `signaling: 'local'`,
real WebRTC) passes 5 runs out of 5: the guest's input drives only its car on the host, the guest's copies
converge to the host's poses (≤ 1.5 px once stopped), ping 3 ms on loopback. **Not tested yet: Firebase
signaling between two machines** (the session that built N0 could not reach gstatic or firebaseio). The
Firebase store makes the same SDK calls as the `networking` branch did.

Found on the way (engine fixes, their own commits):

- `Camera.followEntity` on an entity without a body, in a scene with physics: the camera never moved.
  The follow held on an unchanged physics publish frame, and the drawn camera snapped to the entity's
  latched pose slot, which only bodies have (it read 0: the view sat at the world origin). A client's
  puppets are such entities. Both now apply to bodies only (`tests/node/cameraFollowBodyless.test.js`).
- Tilemap loading: two tabs of one browser loading the 16 MB roads tilemap at once failed one of them
  with `net::ERR_CACHE_WRITE_FAILURE` (the body read rejected). The loader now retries a network failure
  once with `cache: 'no-store'` (`src/util/fetchRetry.js`).

---

## 1. Goal

A developer adds a few static declarations to entities they already have and gets a game two to eight
people can play from different computers, with no server of their own to run:

- **Co-op and versus action** (cars, top-down shooters, brawlers): 2–8 players, tens to a few hundred
  replicated entities, 50–150 ms of latency between players.
- **Not in scope yet:** hundreds of players, MMO worlds, deterministic lockstep for RTS, fighting-game
  rollback. Section 9 says why and what would have to change.

"Acceptable" means: a player feels their own car or character respond at once (prediction), sees the others
move smoothly (interpolation), survives a lost packet and a short drop (redundancy, reconnection), joins a
game already running (join in progress), and connects from most networks (TURN).

## 2. What exists

| Where                               | What                                                                                                                                                                                                                                                                                                                      | What we keep                                                                                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Branch `networking` (2026-05, v0.5) | `Network.js`: host/join, star topology, `reliable` + `fast` channels, `send` / `broadcast` / `sendToHost`. `FirebaseSignaling.js`: presence, host election by transaction, SDP/ICE exchange. `CryptoUtils.js`: signaling encrypted with a key derived from the room name. `NETWORKING.md`: the host-authoritative design. | All of it, ported (N0). Its own list of missing items is this plan's N1–N5. `onMessage` was never wired.                                                                                                                                                           |
| Repo `brotochola/webrtc` (2026-04)  | A standalone circles game: host physics, snapshots at 20 Hz, input packets, client prediction + reconciliation (nudge / snap at 60 px), dead reckoning, adaptive lerp (`α = 1 − e^(−dt/τ)`, τ from the packet interval), and `rtc-transport.js`, a binary router with a header (version, module, type, sequence).         | The client techniques (N0 uses dead reckoning + adaptive smoothing; N4 adds prediction), the header idea. Its input is sent only on key change over the unreliable channel: a lost key-up leaves the player driving. N0 sends the input state every frame instead. |
| `main`                              | State in SoA inside SharedArrayBuffers; `SharedResource` blobs any thread can read; the save system (`static serializable`, schema hash, entity-id remap `oldToNew`, `worldBufferSave.js`); the spatial grid; renderer-queue interpolation.                                                                               | The save system is most of join-in-progress (N5) and the shape of declarative replication (N1). The spatial grid is interest management (N2).                                                                                                                      |

## 3. Constraints

1. **WebRTC lives on the main thread.** `RTCPeerConnection` does not exist in workers, and Chrome cannot
   transfer an `RTCDataChannel` to one. The main thread owns the sockets; the work (packing, deltas,
   relevance) can move to a worker that the main thread feeds bytes (N3). WebSocket and WebTransport do
   exist in workers: a server transport (N7) could live entirely in one.
2. **Box2D is not deterministic across machines** (multithreaded solver, float order, different CPUs).
   So: state replication, not lockstep; prediction only for what the client owns, with reconciliation;
   no full-world rollback.
3. **The host's upload is the budget.** Star topology: every snapshot leaves the host once per client.
   16 000 entities × 8 bytes × 20 Hz ≈ 20 Mbit/s per client. Quantization, deltas and relevance (N2) bring
   a client that sees ~500 entities to ≈ 0.5 Mbit/s.
4. **Cross-origin isolation.** The engine needs COOP/COEP (or `weed-sw.js`). Firebase is imported from
   gstatic, which serves `Cross-Origin-Resource-Policy: cross-origin`; a different signaling CDN must too.
5. **Indices are not identities.** The host's entity index and the client's differ as soon as anything
   spawns in another order. Every replicated entity needs a net id (N1).
6. **Time differs per thread.** `performance.now()` starts at each worker's creation. Anything that crosses
   threads stamps `performance.timeOrigin + performance.now()` (epoch milliseconds).

## 4. Architecture

```
            Signaling (Firebase RTDB, or localStorage for tabs on one machine)
            presence · host lock · SDP offer/answer · ICE   (AES-GCM, key from the room code)
                      ▲                        ▲
                      │ once per connection    │
   ┌──────────────────┴───────┐      ┌─────────┴─────────────────┐
   │ HOST (one browser)       │      │ CLIENT (n browsers)       │
   │                          │ P2P  │                           │
   │ main: Network ───────────┼──────┼─► Network ──► NetPose SR  │
   │   reads SoA, packs poses │ fast │     (SharedResource)      │
   │   writes NetInput SR ◄───┼──────┼── input state every frame │
   │ physics/logic: simulate  │      │ logic: puppets read       │
   │   every entity           │      │   NetPose, extrapolate,   │
   │                          │      │   smooth; no physics on   │
   │                          │      │   replicated entities     │
   └──────────────────────────┘      └───────────────────────────┘
```

- **Authority:** the host simulates everything. Clients send input, never state. Today the host is also a
  player, so the host can cheat; a dedicated host (N7) is the answer when that matters.
- **Channels:** `reliable` (ordered, retransmitted) for control, spawns, events, chat, JSON messages;
  `fast` (unordered, no retransmits) for snapshots, input and pings, which are all superseded by the next
  packet anyway.
- **Threads (N0):** the main thread packs and unpacks; the result crosses to workers through
  `SharedResource` fields (one writer each). The codec is pure functions over typed arrays, so N3 moves it
  to a worker without rewriting it.

### Wire format (N0)

Every packet starts with one byte, the message type. Types 0–15 belong to the engine, 16–255 to the game.

| Type | Name    | Channel  | Body                                                                                                           |
| ---- | ------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| 0    | `JSON`  | reliable | `u8 nameLength`, name (UTF-8), JSON (UTF-8)                                                                    |
| 1    | `PING`  | fast     | `f64` sender time                                                                                              |
| 2    | `PONG`  | fast     | `f64` echoed time                                                                                              |
| 3    | `POSES` | fast     | `u32 tick`, `u16 count`, then per entity `u16 netId`, `f32 x, y, rotation, vx, vy, angularVelocity` (26 bytes) |
| 16+  | game    | either   | anything (the demo's input is type 16: `u32 seq`, `u8 bits`)                                                   |

N2 replaces `POSES` with a schema-driven, quantized, delta-coded snapshot; the type byte and a version in
the handshake keep old and new apart.

## 5. Developer API

### Now (N0, on `networking_cars`)

```js
import WEED from '/src/index.js';
const { Network, NET_CHANNEL, NET_MSG, writePoseSnapshot, readPoseSnapshot } = WEED;

const net = new Network({ signaling: 'firebase', firebase: { /* project config */ } });
// or { signaling: 'local' }: tabs of one browser on one machine, no internet needed

const code = await net.host({ maxPeers: 3 });      // 'K7F2-Q9MX'
await net.join('K7F2-Q9MX');

net.on('peerJoined', (peerId) => …);
net.on('peerLeft', (peerId) => …);
net.onMessage('start', (peerId, data) => …);       // JSON on the reliable channel
net.sendMessage(peerId, 'start', { seed: 7 });     // or broadcastMessage / sendMessageToHost
net.onBinary(16, (peerId, view, channel) => …);    // game binary types 16–255
net.rtt(peerId);                                   // round trip, ms (EMA of pings)
```

### Target (N1–N4)

```js
class Car extends WEED.GameObject {
  static components = [RigidBody, Collider, SpriteRenderer, CarComponent];
  static replicate = {
    Transform: { x: 'q16', y: 'q16', rotation: 'q8' },   // quantized
    RigidBody: { vx: 'q16', vy: 'q16' },
    SpriteRenderer: ['animationState'],
    rate: 30,                // Hz, per type; the scene sets the default
    relevance: 'spatial',    // only to clients whose view is near (default for >64 entities)
  };
  static input = { throttle: Int8Array, steer: Int8Array, boost: Uint8Array }; // SoA, client → host
  static predict = ['Transform', 'RigidBody'];  // only for the owner, reconciled

  tick() {
    // runs on the host for everyone; on the owner's client too when predicted
    this.applyForces(this.input.throttle, this.input.steer);
  }
}

// Scene: same file for host and clients
const game = new GameEngine({ network: { signaling: WEED.firebaseSignaling({ … }) } });
await game.network.host();
game.network.on('peerJoined', (peer) => Car.spawn({ x, y, owner: peer.id }));
await game.loadScene(RaceScene, { role: 'client' }); // on clients: no tick, no physics for replicated types

this.sendTo(other, 'hit', 10);           // crosses the network when the target lives on another peer
scene.rpc('chat', text, { to: 'all' });  // a scene-level message, reliable
```

It follows the opt-in style the engine already has (`static serializable`, `static messages`), and it reads
like Godot's `MultiplayerSynchronizer` and Unity's `NetworkVariable`, with fields instead of nodes or
properties.

## 6. Stages

Each item has an exit test. A stage is done when its demo works between two machines and its node tests
pass.

### N0 — Transport and a demo (done on `networking_cars`)

| Item   | What                                                                                                                                                                                                        | Exit                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| NET-01 | Port `Network`, Firebase signaling and crypto from `networking` into `src/core/network/`; signaling as a store adapter (Firebase or localStorage) under one room protocol                                   | Two tabs connect with `signaling: 'local'`; two machines with Firebase |
| NET-02 | Message routing: one type byte, JSON messages by name, binary types for games                                                                                                                               | node test of the framing                                               |
| NET-03 | Ping/pong RTT per peer (EMA)                                                                                                                                                                                | RTT shown in the demo HUD                                              |
| NET-04 | Pose codec `writePoseSnapshot` / `readPoseSnapshot` over Transform / RigidBody SoA                                                                                                                          | node round-trip test                                                   |
| NET-05 | Room codes: 8 characters from a 31-symbol alphabet (≈ 2^40), shown as `XXXX-XXXX`; join link `?room=`                                                                                                       | the lobby joins from a link                                            |
| NET-06 | Demo `demos/netRacers/`: lobby scene (create, share, join, players, ping, start) and race scene (host drives physics, client sends input every frame and renders puppets with dead reckoning and smoothing) | Two players drive two cars, push parked cars, see each other           |

### N1 — Declarative replication

| Item   | What                                                                                                                                                                                                                                                                                                                                          |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NET-10 | Net ids: a `NetId` component (u16/u32) assigned by the host at spawn; a client table netId → local index                                                                                                                                                                                                                                      |
| NET-11 | `static replicate` read at scene init into a schema (component, field, encoding)                                                                                                                                                                                                                                                              |
| NET-12 | Spawn / despawn replication on the reliable channel, with the spawn config the type needs to look right (sprite, scale)                                                                                                                                                                                                                       |
| NET-13 | Client role: `loadScene(Scene, { role: 'client' })` registers replicated types without RigidBody/Collider bodies and without `tick`; a built-in puppet system writes Transform from the snapshot buffer Also: a client needs no Box2D at all (N0's client boots it for static rocks only); a role-specific config can turn physics off there. |
| NET-14 | Interpolation buffer (render 2 snapshots behind, ~66–100 ms) as the default, dead reckoning as the fallback when a packet is late                                                                                                                                                                                                             |
| NET-15 | Replicated events: `emit` / `sendTo` / particle bursts the host marks `replicate: true` reach clients (sparks on a crash are visible to everyone)                                                                                                                                                                                             |
| NET-16 | Ownership: `owner` in the spawn config; `this.isMine`; input routed to the owner's entity                                                                                                                                                                                                                                                     |

### N2 — Bandwidth

| Item   | What                                                                                                                              |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| NET-20 | Quantization per field (`q8`, `q16`, `f16`, `f32`), positions relative to a cell origin                                           |
| NET-21 | Delta against the last snapshot the client acknowledged (ack on the fast channel; full snapshot after a loss streak)              |
| NET-22 | Relevance through the spatial grid: each client's view rectangle plus a margin; entities leaving relevance despawn on that client |
| NET-23 | Priority accumulator: a per-client byte budget per tick; far or slow entities wait their turn                                     |
| NET-24 | Per-type rates (`rate: 10` for barrels, 30 for cars)                                                                              |
| NET-25 | Stats: bytes per second per client and per type in the DebugUI                                                                    |

### N3 — The network worker

| Item   | What                                                                                                                       |
| ------ | -------------------------------------------------------------------------------------------------------------------------- |
| NET-30 | A `NetWorker` that owns packing, deltas and relevance, reading the SoA directly                                            |
| NET-31 | Main ↔ NetWorker byte rings in a SharedArrayBuffer (no postMessage per packet)                                             |
| NET-32 | Kernel benchmarks for pack/unpack (`tests/bench/netSnapshotMicrobench.mjs`) before and after; WASM when the kernel says so |

### N4 — Feel

| Item   | What                                                                                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NET-40 | Input state every tick with the last 3 ticks repeated (redundancy) and a sequence number                                                                                                          |
| NET-41 | Client prediction for owned entities: a kinematic predictor (integrate the entity's own forces) first; a client-side Box2D island with the owned body and static neighbours if that is not enough |
| NET-42 | Reconciliation: replay unacknowledged inputs from the corrected state; nudge under a threshold, snap above it                                                                                     |
| NET-43 | Lag compensation for hitscan: `Ray` rewinds replicated poses to the shooter's time (a short pose history per entity)                                                                              |
| NET-44 | Clock sync: host tick estimate on clients from ping and snapshot ticks                                                                                                                            |

### N5 — Operations

| Item   | What                                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------- |
| NET-50 | TURN: config for any provider; a doc page with Cloudflare / Metered / self-hosted coturn                               |
| NET-51 | Reconnection: a client that drops for < 10 s keeps its slot and its car                                                |
| NET-52 | Join in progress: the save system's payload as the first snapshot                                                      |
| NET-53 | Host migration: the save payload broadcast every few seconds; a new host is elected by the signaling lock and loads it |
| NET-54 | Network conditions simulator: delay, jitter, loss on the transport, a DebugUI panel                                    |
| NET-55 | Room list / quick match on the signaling store (open rooms with a player count)                                        |

### N6 — Security

| Item   | What                                                                                                              |
| ------ | ----------------------------------------------------------------------------------------------------------------- |
| NET-60 | Firebase rules shipped as a file: rooms writable only under their own path, sizes capped, anonymous auth required |
| NET-61 | A room secret separate from the code shown (link carries both), so a guessed code is not a decrypted handshake    |
| NET-62 | Host-side input validation (ranges, rates) and a per-peer message budget                                          |
| NET-63 | Document the trust model: P2P host = a player with authority                                                      |

### N7 — Other transports (research)

| Item   | What                                                                                                            |
| ------ | --------------------------------------------------------------------------------------------------------------- |
| NET-70 | WebSocket / WebTransport transport with the same `Network` API, for a dedicated host                            |
| NET-71 | Headless host: the engine in Node (`worker_threads`, SAB) without Pixi, or a browser host in a server container |
| NET-72 | Godot-style transport swap: `Network({ transport })`                                                            |

## 7. Testing

- **Node:** framing, pose codec round trip, room codes, the localStorage store (with a fake storage and
  events), signaling against a fake store. These run in `npm run test:node`.
- **Browser:** `demos/tests/netRacersTwoPages.mjs` opens two pages of one Chromium on the dev server with
  `signaling: 'local'`, hosts on one, joins on the other, starts, drives the client's car with
  synthesized keys and checks that the host's car index for the client moved and that the client sees it.
- **Two machines:** the demo with Firebase. Before each stage is closed.
- **Network conditions (N5):** the simulator, plus Chrome DevTools' WebRTC throttling where it applies.

## 8. Measuring

Not a speed claim under HOW_WE_MEASURE until N3: then pack/unpack kernels, a stress scene with N replicated
entities and C simulated clients, primary = main thread or NetWorker `STEP_MS`. Bandwidth is measured, not
estimated: bytes per second per client from the stats panel (NET-25) at 1, 4 and 8 clients.

## 9. Risks and open decisions

1. **Prediction with Box2D.** A kinematic predictor will drift on collisions; a client island costs a
   physics worker on the client. Decide after NET-41's first try in the car demo.
2. **Puppets and contacts.** Client-side puppets have no bodies: nothing collides locally, which is right
   for authority but means local effects (sparks, sounds) need replicated events (NET-15).
3. **Firebase as a dependency.** Free tier limits (simultaneous connections) and a Google account. The store
   adapter keeps the room protocol independent; a small self-hosted signaling server is one more adapter.
4. **Lockstep for RTS.** Needs a deterministic simulation: fixed-point or WASM-only physics with one thread.
   Out of scope; noted so that nobody builds N1 assuming it.
5. **Engine vs demo.** N0 keeps the replication buffers (`NetPose`, `NetInput`) in the demo, as
   SharedResources the scene declares. N1 moves the general version into the engine; the demo should then
   shrink, which is the test that N1's API is right.
