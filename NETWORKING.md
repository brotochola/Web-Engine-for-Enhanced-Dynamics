# WeedJS Networking

Browser-only multiplayer using WebRTC peer-to-peer data channels.
No dedicated game server is required — Firebase Realtime Database is used only for the initial handshake (signaling), after which all game data flows directly between browsers.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Roles: Host and Client](#roles-host-and-client)
- [Quick Start](#quick-start)
- [Connection Lifecycle](#connection-lifecycle)
- [Signaling: How Peers Find Each Other](#signaling-how-peers-find-each-other)
- [Security: Encrypted Signaling](#security-encrypted-signaling)
- [Data Channels: reliable vs fast](#data-channels-reliable-vs-fast)
- [The Network API](#the-network-api)
- [Firebase Database Structure](#firebase-database-structure)
- [ICE and NAT Traversal](#ice-and-nat-traversal)
- [What is NOT implemented yet](#what-is-not-implemented-yet)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                    Firebase RTDB                         │
│   (signaling only — used once per connection, then idle) │
└────────────────────┬─────────────────────────────────────┘
                     │ SDP offer/answer + ICE candidates
          ┌──────────┴──────────┐
          │                     │
   ┌──────▼──────┐       ┌──────▼──────┐
   │    HOST     │       │   CLIENT    │
   │             │◄─────►│             │
   │ physics     │  P2P  │  render     │
   │ logic       │  data │  input      │
   │ simulation  │       │  commands   │
   └─────────────┘       └─────────────┘
          │
          └──────► more clients (star topology)
```

The topology is a **star**: every client connects directly to the host. Clients do not connect to each other.

Firebase is only involved during the initial handshake. Once WebRTC data channels are open, Firebase is completely idle — no game data ever touches it.

---

## Roles: Host and Client

### Host

- Runs the full simulation: physics worker, logic workers, spatial workers
- Is the **authoritative source of truth** for all game state
- Sends state snapshots to clients
- Receives commands from clients and validates them before simulating
- Creates one `RTCPeerConnection` per client

### Client

- Does not run gameplay simulation or physics
- Receives replicated state from the host and renders it
- Sends player input/commands to the host
- Runs only: render worker, prerender worker

This separation means clients are lightweight and cheap. All cheating is impossible because clients never simulate — they only tell the host what they want to do, and the host decides what actually happens.

---

## Quick Start

```js
const game = new GameEngine({
  network: {
    firebase: {
      apiKey:            '...',
      authDomain:        '...',
      databaseURL:       'https://your-project-rtdb.firebaseio.com',
      projectId:         '...',
      storageBucket:     '...',
      messagingSenderId: '...',
      appId:             '...',
    },
    // Optional: override ICE servers (defaults to 5 Google STUN servers)
    iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
  },
});

// --- Host flow ---
const roomId = await game.network.host();     // returns e.g. "k7f2q"
console.log('Share this code:', roomId);
// listen for clients joining
game.network.onPeerConnected(peerId => console.log('client joined:', peerId));

// --- Client flow ---
await game.network.join('k7f2q');             // resolves when connected to host
console.log('connected to host');

// Then load the scene normally
await game.loadScene(MyScene);
```

---

## Connection Lifecycle

```
HOST calls host()                   CLIENT calls join(roomId)
│                                   │
├─ enterRoom()                      ├─ enterRoom()
│   writes presence to Firebase     │   writes presence to Firebase
│   derives AES key from roomId     │   derives same AES key from roomId
│                                   │
├─ claimHost() ──── Firebase tx ────► wins → becomes host
│   wins transaction                │   loses transaction → proceeds as client
│   host() resolves with roomId     │
│                                   ├─ creates RTCPeerConnection
├─ watchPresenceAdded()             │   watches Firebase for host's offer
│   fires when client joins         │
│                                   │
├─ _connectToClient(clientId)       │
│   creates RTCPeerConnection       │
│   creates 'reliable' data channel │
│   creates 'fast' data channel     │
│                                   │
├─ onnegotiationneeded fires        │
│   createOffer()                   │
│   setLocalDescription(offer)      │
│   sendOffer() → Firebase ─────────► watchOffer() fires
│                                   │   setRemoteDescription(offer)
│                                   │   createAnswer()
│                                   │   setLocalDescription(answer)
│                                   │   sendAnswer() → Firebase
│                                   │
├─ watchAnswer() fires ◄────────────┤
│   setRemoteDescription(answer)    │
│                                   │
│  ◄── ICE candidates exchanged ──► │  (in parallel with SDP above)
│                                   │
├─ reliable channel opens           ├─ reliable channel opens (ondatachannel)
│   onPeerConnected fires           │   join() Promise resolves
```

---

## Signaling: How Peers Find Each Other

WebRTC requires an out-of-band mechanism for peers to exchange connection metadata before they can talk directly. This is called **signaling**. WeedJS uses Firebase Realtime Database for this.

### Why Firebase?

- No server to run or maintain
- Real-time push updates (no polling)
- Automatic presence cleanup via `onDisconnect()`
- Free tier is more than enough for signaling traffic

### What gets exchanged

**SDP (Session Description Protocol)** — a text description of what codecs, formats, and network capabilities each peer supports. The host creates an "offer" SDP; the client creates an "answer" SDP.

**ICE candidates** — a list of possible network paths to reach each peer (local IP, public IP via STUN, relay address via TURN). Both peers gather their candidates and exchange them through Firebase.

Once both peers have each other's SDP and a matching ICE candidate pair, the direct P2P connection is established and Firebase is no longer needed.

### Host election

When multiple peers enter the same room, exactly one must become host. This is decided with a **Firebase transaction** on `rooms/{roomId}/callerClaimed`:

```
First peer:  read callerClaimed → null → write myId  → commits → IS HOST
Second peer: read callerClaimed → myId → abort        → aborts  → IS CLIENT
```

The transaction is atomic — two peers cannot both win simultaneously. If the host leaves and the lock becomes stale (their presence is gone but the lock remains), the next peer to call `claimHost()` automatically clears the stale state and takes over.

---

## Security: Encrypted Signaling

The Firebase API key is public by design (it only identifies the project, it is not a secret). However, the signaling payloads — SDP and ICE candidates — are encrypted before being written to Firebase.

### How it works

Both peers independently derive the same AES-GCM-256 key from the room name using PBKDF2:

```
roomName  ──PBKDF2-SHA256 (100k iterations)──►  AES-GCM-256 key
```

Since both peers type the same room name, they get the same key — with zero key exchange over the network. Every SDP and ICE payload written to Firebase is encrypted with this key and a random IV:

```
Firebase stores: { iv: "base64...", ct: "base64..." }
```

A third party reading Firebase sees only opaque ciphertext, even with the API key. The room name is the shared secret.

**Note:** This does not protect the game data channel itself (WebRTC data channels use DTLS-SRTP which is always encrypted end-to-end by the browser).

---

## Data Channels: reliable vs fast

Each peer-to-peer connection has two data channels open simultaneously.

### `reliable` — ordered, guaranteed delivery

Standard TCP-like semantics. Every message arrives, in order.

```js
game.network.send(peerId, data, 'reliable');  // or omit — reliable is default
```

Use for anything that **must not be lost**:
- Spawn and despawn events
- HP changes, inventory, game state transitions
- Commands from client to host (`MOVE`, `BUILD`, `ATTACK`)
- Scene load/unload signals

If a reliable message is dropped, the WebRTC stack retransmits it automatically. The next message waits until the dropped one is recovered, preserving order.

### `fast` — unordered, no retransmits

```js
game.network.send(peerId, data, 'fast');
```

Created with `{ ordered: false, maxRetransmits: 0 }`. If a packet is lost, it is gone — the stack never retries it.

Use for anything that will **be overwritten by the next frame** anyway:
- Entity positions and velocities every tick
- Animation frame state
- Camera position

At 60 snapshots per second, a dropped packet doesn't matter — a fresh one arrives 16ms later. Retrying a stale position would waste bandwidth and cause jitter. You want the latest data, not every piece of data.

| | `reliable` | `fast` |
|---|---|---|
| Delivery | Guaranteed | Best-effort |
| Order | In-order | Any order |
| Latency | Higher (waits for retransmit) | Minimal |
| Underlying protocol | SCTP with retransmission | SCTP, 0 retransmits |
| Use when | Must not be missed | Replaced soon anyway |

---

## The Network API

### Setup

```js
// Configured via GameEngine constructor
const game = new GameEngine({ network: { firebase: {...}, iceServers: [...] } });

// Access the Network instance
game.network   // → Network | null
```

### Room management

```js
// Become host (auto-generates a 5-char room code if no roomId given)
const roomId = await game.network.host(roomId?);

// Join as client (rejects if room has no host)
await game.network.join(roomId);
```

### State

```js
game.network.role       // 'host' | 'client' | null
game.network.roomId     // current room ID string
game.network.isHost     // boolean
game.network.isClient   // boolean
game.network.peers      // Map<peerId, { pc, reliableDc, fastDc }>
```

### Events

```js
game.network.onPeerConnected(peerId => { ... });
game.network.onPeerDisconnected(peerId => { ... });
```

> **Note:** `onMessage` is not yet implemented. Data channels are established but incoming message handlers (`onmessage`) have not been wired. This is the next step.

### Sending data

```js
// To a specific peer
game.network.send(peerId, data);                   // reliable
game.network.send(peerId, data, 'fast');            // fast

// To all connected peers
game.network.broadcast(data);                      // reliable
game.network.broadcast(data, 'fast');              // fast
```

`data` can be an `ArrayBuffer` or `string`. For performance, prefer `ArrayBuffer` with typed arrays — no JSON serialization in hot paths.

### Teardown

```js
await game.network.destroy();       // also called by game.destroy()
```

---

## Firebase Database Structure

```
rooms/
  {roomId}/
    meta/
      date_created: 1700000000000   ← rounded to 5-min boundary
      last_use:     1700000300000
    callerClaimed: "{hostPeerId}"   ← host election lock
    presence/
      {hostPeerId}: true
      {clientPeerId}: true
    connections/
      {clientPeerId}/
        offer:    { iv, ct }        ← encrypted SDP offer from host
        answer:   { iv, ct }        ← encrypted SDP answer from client
        candidates/
          {pushKey}: { iv, ct }     ← encrypted ICE candidates (both directions, filtered by 'from' field)
```

On disconnect, Firebase automatically removes each peer's presence entry via `onDisconnect().remove()`. The host's `callerClaimed` lock and `connections` tree are also removed on host disconnect, allowing a new host to claim the room.

---

## ICE and NAT Traversal

Most peers are behind NAT (home routers, 4G, etc.) and don't have a public IP. ICE (Interactive Connectivity Establishment) solves this by collecting multiple candidate addresses and trying them in priority order.

### STUN

STUN servers let a peer discover its public IP/port as seen from the internet. WeedJS uses five Google STUN servers in a single group (tested in parallel):

```js
[{
  urls: [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
    'stun:stun2.l.google.com:19302',
    'stun:stun3.l.google.com:19302',
    'stun:stun4.l.google.com:19302',
  ]
}]
```

STUN works for ~80–85% of connections. The failure case is **symmetric NAT**, where both peers are behind routers that assign a different public port for every destination.

### TURN (not yet configured)

TURN servers act as a relay when direct P2P fails. All traffic flows through the TURN server, so it always works but adds latency and server cost. For production internet play, add a TURN server to `config.network.iceServers`:

```js
iceServers: [
  { urls: ['stun:stun.l.google.com:19302', /* ... */] },
  {
    urls: 'turn:your-turn-server.com:3478',
    username: 'user',
    credential: 'password',
  },
]
```

Free TURN options: Metered.ca (500 MB/month free), Xirsys free tier.

---

## What is NOT implemented yet

| Feature | Status | Notes |
|---------|--------|-------|
| `onMessage` callback | Not implemented | `onmessage` not yet wired on data channels |
| `HostNetworkWorker` | Future | Move host network logic off main thread |
| `ClientNetworkWorker` | Future | Move client network logic off main thread |
| Replication snapshots | Future | Typed-array state snapshots from host to clients |
| Delta compression | Future | Send only changed entity fields |
| Quantized positions | Future | Integer positions instead of floats |
| Chunk/spatial replication | Future | Only replicate entities near each client |
| Client-mode scene loading | Future | Clients load a stripped scene without simulation workers |
| Reconnection | Future | Auto-reconnect on transient disconnects |
| TURN relay | Future | Required for symmetric NAT environments |
