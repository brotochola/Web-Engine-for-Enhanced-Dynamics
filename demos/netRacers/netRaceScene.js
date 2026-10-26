// NetRaceScene - two to four cars on the roads map, driven from different computers.
//
// Host: simulates every car with Box2D (the car scene's drive). Its own car reads
// its keyboard; a remote player's car reads NetInput, which the main thread fills
// from input packets. Every SNAPSHOT_INTERVAL_MS it sends the poses of all
// replicated cars (POSES, fast channel).
//
// Client: no bodies for the cars, only PuppetCars. The main thread sends its
// keyboard state every frame (MSG_INPUT, fast channel: a lost packet is replaced by
// the next one) and writes each snapshot into NetPose for the puppets to follow.
//
// Race messages (JSON, reliable): host → all 'end' (back to the lobby),
// 'despawn' { netId } (a player left); host → late client 'busy'.

import WEED from '/src/index.js';
import { NetCar, ParkedCar } from './gameObjects/netCar.js';
import { PuppetCar } from './gameObjects/puppetCar.js';
import { NetRock } from './gameObjects/netRock.js';
import {
  CAR_SPRITESHEETS,
  MAX_NET_IDS,
  MAX_PLAYERS,
  MSG_INPUT,
  NetInput,
  NetPose,
  NetSession,
  ROADS_TILEMAP,
  ROLE,
  closeNetwork,
  readKeyboardBits,
  session,
} from './netShared.js';
import { PARKED_COUNT, ROCK_COUNT, buildRocks } from './track.js';
import { mountRaceHud, toast } from './ui.js';

const {
  Camera,
  LAYER_KIND,
  NET_CHANNEL,
  NET_MSG,
  NET_STATE,
  RigidBody,
  Transform,
  isNewerTick,
  netNow,
  poseSnapshotBytes,
  readPoseSnapshot,
  writePoseSnapshot,
} = WEED;

const LOBBY_SCENE_URL = '/demos/netRacers/netLobbyScene.js';
/** 30 Hz: dead reckoning on the client covers the frames between. */
const SNAPSHOT_INTERVAL_MS = 33;
/** The host drops a remote player's input after this long without a packet (they froze or left). */
const INPUT_STALE_MS = 500;
const HUD_REFRESH_MS = 500;

export class NetRaceScene extends WEED.Scene {
  static config = {
    worldWidth: 49968,
    worldHeight: 9984,
    seed: 123456,
    spatial: { cellSize: 128, maxNeighbors: 64, maxEntitiesPerCell: 32, numberOfSpatialWorkers: 1 },
    particle: { maxParticles: 4000, decals: false },
    decoration: { maxDecorations: 0 },
    logic: { numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 0, maxJoints: 0, gravity: { x: 0, y: 0 }, sleeping: true },
    renderer: { backend: 'webgl', ySort: true },
    preRender: { cullingRatio: 0.1 },
    lighting: { enabled: false },
    navigation: { enabled: false },
    layers: {
      ground: { kind: LAYER_KIND.TILEMAP, tilemap: 'roads_tilemap', scale: 1, zIndex: 0.5 },
    },
  };

  static assets = {
    textures: {
      smoke: '/demos/img/smoke.png',
      rock1: '/demos/img/rock1.png',
      rock2: '/demos/img/rock2.png',
      rock3: '/demos/img/rock3.png',
      rock4: '/demos/img/rock4.png',
    },
    spritesheets: CAR_SPRITESHEETS,
    tilemaps: { roads_tilemap: ROADS_TILEMAP },
  };

  static entities = [
    [NetCar, MAX_PLAYERS],
    [ParkedCar, PARKED_COUNT],
    [PuppetCar, MAX_PLAYERS + PARKED_COUNT],
    [NetRock, ROCK_COUNT],
  ];

  static sharedResources = [
    [NetSession, NetSession.schema],
    [NetInput, NetInput.schema],
    [NetPose, NetPose.schema],
  ];

  constructor(game) {
    super(game);
    this.hud = null;
    this.unsubs = [];
    /** netId → the entity (NetCar / ParkedCar on the host, PuppetCar on a client) */
    this.byNetId = new Map();
    // Host: what goes into every snapshot.
    this.netIds = new Uint16Array(MAX_NET_IDS);
    this.netIndices = new Int32Array(MAX_NET_IDS);
    this.netCount = 0;
    this.snapshotBuf = new ArrayBuffer(poseSnapshotBytes(MAX_NET_IDS));
    this.snapshotView = new DataView(this.snapshotBuf);
    this.snapshotTick = 0;
    this.lastSnapshotAt = 0;
    /** slot → netNow() of its last input packet, and its last sequence number */
    this.inputAt = new Float64Array(MAX_PLAYERS);
    this.inputSeq = new Uint32Array(MAX_PLAYERS);
    /** peerId → slot */
    this.slotOf = new Map();
    // Client
    this.inputBuf = new Uint8Array(6);
    this.inputView = new DataView(this.inputBuf.buffer);
    this.sendSeq = 0;
    this.lastPoseTick = -1;
    this.lastHud = 0;
    this.leaving = false;
    this.leavingDone = false;
  }

  get net() {
    return session.net;
  }

  preload(data) {
    const race = (data && data.race) || session.race;
    const net = this.net;
    if (!race || !net || !net.role) {
      // No room to race in (the page was reloaded into this scene): back to the lobby
      // once this load finishes (loadScene refuses while a transition runs).
      const retry = async () => {
        if ((await this.game.loadScene(LOBBY_SCENE_URL)) === false) setTimeout(retry, 200);
      };
      setTimeout(retry, 0);
      return;
    }
    const isHost = net.isHost;
    if (race.players && race.players.length) session.players = race.players.map((p) => ({ ...p }));
    const mine = (race.players || []).find((p) => p.id === net.myId) || null;
    NetSession.role[0] = isHost ? ROLE.HOST : ROLE.CLIENT;
    NetSession.localNetId[0] = mine ? mine.slot : -1;
    NetInput.bits.fill(0);
    NetPose.time.fill(0);

    for (const r of buildRocks(race.seed)) NetRock.spawn(r);

    for (const e of race.entities) {
      let entity;
      if (isHost) {
        entity = e.kind === 'player' ? NetCar.spawn(e) : ParkedCar.spawn(e);
        this.netIds[this.netCount] = e.netId;
        this.netIndices[this.netCount] = entity.index;
        this.netCount++;
      } else {
        entity = PuppetCar.spawn(e);
      }
      this.byNetId.set(e.netId, entity);
    }
    for (const p of race.players) this.slotOf.set(p.id, p.slot);

    const own = race.entities.find((e) => mine && e.netId === mine.slot);
    if (own) Camera.centerOn(own.x, own.y);
  }

  create() {
    const net = this.net;
    if (!net || !net.role) return;
    this.hud = mountRaceHud({ onLeave: () => this.leave() });
    this.wire(net);
    this.refreshHud();
    toast(
      net.isHost
        ? 'You are hosting. Your car simulates here.'
        : 'Connected. The host simulates; you drive.'
    );
  }

  update() {
    const net = this.net;
    if (!net || !net.role || this.leaving) return;
    const now = netNow();
    if (net.isHost) {
      for (let s = 0; s < MAX_PLAYERS; s++) {
        if (NetInput.bits[s] !== 0 && now - this.inputAt[s] > INPUT_STALE_MS) NetInput.bits[s] = 0;
      }
      if (now - this.lastSnapshotAt >= SNAPSHOT_INTERVAL_MS && this.netCount > 0) {
        this.lastSnapshotAt = now;
        this.snapshotTick = (this.snapshotTick + 1) >>> 0;
        const bytes = writePoseSnapshot(
          this.snapshotView,
          this.snapshotTick,
          this.netIds,
          this.netIndices,
          this.netCount,
          Transform,
          RigidBody
        );
        net.broadcastBinary(new Uint8Array(this.snapshotBuf, 0, bytes), NET_CHANNEL.FAST);
      }
    } else {
      this.sendSeq = (this.sendSeq + 1) >>> 0;
      this.inputBuf[0] = MSG_INPUT;
      this.inputView.setUint32(1, this.sendSeq, true);
      this.inputBuf[5] = readKeyboardBits();
      net.sendBinaryToHost(this.inputBuf, NET_CHANNEL.FAST);
    }

    if (now - this.lastHud >= HUD_REFRESH_MS) {
      this.lastHud = now;
      this.refreshHud();
    }
  }

  async destroy() {
    this.teardown();
    await super.destroy();
  }

  // ---------------------------------------------------------------------------

  teardown() {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.hud) this.hud.destroy();
    this.hud = null;
  }

  refreshHud() {
    const net = this.net;
    if (!this.hud || !net) return;
    this.hud.update({
      code: net.displayCode,
      isHost: net.isHost,
      ping: net.isHost ? NaN : net.rtt(net.hostId),
      players: session.players,
      myId: net.myId,
    });
  }

  wire(net) {
    if (net.isHost) {
      this.unsubs.push(
        net.onBinary(MSG_INPUT, (peerId, view) => {
          if (view.byteLength < 6) return;
          const slot = this.slotOf.get(peerId);
          if (slot === undefined) return;
          const seq = view.getUint32(1, true);
          // Unordered channel: an older packet arriving late must not undo a newer one.
          if (this.inputAt[slot] > 0 && !isNewerTick(seq, this.inputSeq[slot])) return;
          this.inputSeq[slot] = seq;
          this.inputAt[slot] = netNow();
          NetInput.bits[slot] = view.getUint8(5);
        }),
        net.onMessage('hello', (peerId) => net.sendMessage(peerId, 'busy', {})),
        net.on('peerLeft', (peerId) => {
          const slot = this.slotOf.get(peerId);
          const p = session.players.find((q) => q.id === peerId);
          session.players = session.players.filter((q) => q.id !== peerId);
          if (slot === undefined) return;
          this.slotOf.delete(peerId);
          NetInput.bits[slot] = 0;
          this.removeNetEntity(slot);
          net.broadcastMessage('despawn', { netId: slot });
          net.broadcastMessage('lobby', { players: session.players });
          toast(`${p ? p.name : 'A driver'} left`);
          this.refreshHud();
        })
      );
    } else {
      const target = NetPose;
      this.unsubs.push(
        net.onBinary(NET_MSG.POSES, (_peer, view) => {
          if (view.byteLength < 5) return;
          const tick = view.getUint32(1, true);
          if (this.lastPoseTick >= 0 && !isNewerTick(tick, this.lastPoseTick)) return;
          if (readPoseSnapshot(view, target, netNow())) this.lastPoseTick = tick;
        }),
        net.onMessage('despawn', (_peer, data) => {
          if (data && Number.isInteger(data.netId)) this.removeNetEntity(data.netId);
        }),
        net.onMessage('lobby', (_peer, data) => {
          session.players = (data && data.players) || session.players;
          this.refreshHud();
        }),
        net.onMessage('end', () => this.backToLobby(true)),
        net.on('state', (state) => {
          if (state !== NET_STATE.DISCONNECTED || this.leaving) return;
          if (this.hud) {
            this.hud.showModal(
              'The host left',
              'The race ended because the host closed the room.',
              'Back to the lobby',
              async () => {
                await closeNetwork();
                this.backToLobby(false);
              }
            );
          }
        })
      );
    }
  }

  removeNetEntity(netId) {
    const entity = this.byNetId.get(netId);
    if (!entity) return;
    this.byNetId.delete(netId);
    for (let k = 0; k < this.netCount; k++) {
      if (this.netIds[k] !== netId) continue;
      this.netCount--;
      this.netIds[k] = this.netIds[this.netCount];
      this.netIndices[k] = this.netIndices[this.netCount];
      break;
    }
    entity.constructor.despawn(entity);
  }

  async leave() {
    const net = this.net;
    if (!net) return this.backToLobby(false);
    if (net.isHost) {
      net.broadcastMessage('end', {});
      this.backToLobby(true);
    } else {
      this.leaving = true;
      await closeNetwork();
      this.backToLobby(false);
    }
  }

  /** keepRoom: the room stays open and the lobby shows it (the host ended the race). */
  backToLobby(keepRoom) {
    if (this.leavingDone) return;
    this.leavingDone = true;
    this.leaving = true;
    this.teardown();
    session.race = null;
    this.game.loadScene(LOBBY_SCENE_URL, { data: { returning: keepRoom } });
  }
}
