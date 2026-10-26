// NetLobbyScene - create or join a room, see who is in, start the race.
//
// The canvas shows the roads map with a few cars cruising; the card on top is
// HTML (ui.js). The Network lives in netShared.session, so it survives the jump to
// the race scene and back.
//
// Lobby messages (JSON, reliable):
//   client → host  hello { name, skin }
//   host → all     lobby { players: [{ id, name, skin, slot, isHost, rtt }] }
//   host → all     start { seed, players, entities }       (see track.js)
//   host → client  full  {}  /  busy {}                     (no seat / a race is running)

import WEED from '/src/index.js';
import { CruiserCar } from './gameObjects/cruiserCar.js';
import {
  CAR_SKINS,
  CAR_SPRITESHEETS,
  MAX_PLAYERS,
  ROADS_TILEMAP,
  closeNetwork,
  loadPrefs,
  openNetwork,
  savePrefs,
  session,
} from './netShared.js';
import { ROAD_Y, START_X, buildRace } from './track.js';
import { mountLobby, toast } from './ui.js';

const { Camera, LAYER_KIND, NET_STATE, formatRoomCode, normalizeRoomCode } = WEED;

export const RACE_SCENE_URL = '/demos/netRacers/netRaceScene.js';
export const LOBBY_SCENE_URL = '/demos/netRacers/netLobbyScene.js';

const LOBBY_REFRESH_MS = 1000;

export class NetLobbyScene extends WEED.Scene {
  static config = {
    worldWidth: 49968,
    worldHeight: 9984,
    seed: 4242,
    spatial: { cellSize: 256, maxNeighbors: 16, maxEntitiesPerCell: 16, numberOfSpatialWorkers: 1 },
    particle: { maxParticles: 0, decals: false },
    decoration: { maxDecorations: 0 },
    logic: { numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { enabled: false },
    renderer: { backend: 'webgl', ySort: true },
    lighting: { enabled: false },
    navigation: { enabled: false },
    layers: {
      ground: { kind: LAYER_KIND.TILEMAP, tilemap: 'roads_tilemap', scale: 1, zIndex: 0.5 },
    },
  };

  static assets = {
    spritesheets: CAR_SPRITESHEETS,
    tilemaps: { roads_tilemap: ROADS_TILEMAP },
  };

  static entities = [[CruiserCar, 8]];

  constructor(game) {
    super(game);
    this.ui = null;
    this.unsubs = [];
    this.view = {
      screen: 'home',
      name: '',
      skin: 0,
      signaling: 'firebase',
      code: '',
      joinCode: '',
      isHost: false,
      players: [],
      myId: '',
      statusText: '',
      hostRtt: NaN,
    };
    this.lastRefresh = 0;
    this.camT = 0;
    this.leavingToRace = false;
  }

  preload() {
    const sprites = CAR_SKINS.map((s) => s.sprite);
    for (let k = 0; k < 8; k++) {
      CruiserCar.spawn({
        sprite: sprites[k % sprites.length],
        cx: START_X + 900 + (k % 4) * 520,
        cy: ROAD_Y + (k < 4 ? -40 : 40),
        rx: 420 + (k % 3) * 90,
        ry: 120 + (k % 2) * 60,
        w: (k % 2 ? -1 : 1) * (0.35 + (k % 3) * 0.08),
        phase: k * 0.8,
      });
    }
    Camera.centerOn(START_X + 1600, ROAD_Y);
    Camera.setZoom(0.75);
  }

  create(data) {
    loadPrefs();
    const params = new URLSearchParams(location.search);
    const fromLink = normalizeRoomCode(params.get('room') || '');
    const net = params.get('net');
    if (net === 'local' || net === 'firebase') session.signaling = net;

    Object.assign(this.view, {
      name: session.name,
      skin: session.skin,
      signaling: session.signaling,
      joinCode: fromLink ? formatRoomCode(fromLink) : '',
    });

    this.ui = mountLobby(this.actions());

    if (data && data.returning && session.net && session.net.role) {
      this.wire(session.net);
      this.enterRoom();
      if (session.net.isHost) this.broadcastLobby();
    } else {
      this.view.screen = 'home';
      this.render();
      if (fromLink)
        toast(`Invited to room ${formatRoomCode(fromLink)}. Pick a name and press Join.`);
    }
  }

  update(dtRatio, deltaTime) {
    // Slow drift along the road.
    this.camT += (deltaTime || 16.667) * 0.001;
    Camera.centerOn(
      START_X + 1600 + Math.sin(this.camT * 0.11) * 900,
      ROAD_Y + Math.sin(this.camT * 0.07) * 120
    );

    const now = performance.now();
    if (now - this.lastRefresh < LOBBY_REFRESH_MS) return;
    this.lastRefresh = now;
    const net = session.net;
    if (!net || this.view.screen !== 'room') return;
    if (net.isHost) {
      for (const p of session.players) p.rtt = p.isHost ? null : net.rtt(p.id);
      this.broadcastLobby();
    } else {
      this.view.hostRtt = net.rtt(net.hostId);
      this.render();
    }
  }

  async destroy() {
    this.teardown();
    await super.destroy();
  }

  // ---------------------------------------------------------------------------

  render() {
    if (!this.ui) return;
    const net = session.net;
    this.view.players = session.players;
    this.view.myId = net ? net.myId : '';
    this.view.isHost = !!(net && net.isHost);
    this.view.code = net ? net.displayCode : '';
    this.ui.render(this.view);
  }

  teardown() {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.ui) this.ui.destroy();
    this.ui = null;
  }

  enterRoom() {
    this.view.screen = 'room';
    this.render();
  }

  goHome(message) {
    this.view.screen = 'home';
    this.render();
    if (message) toast(message, 'error');
  }

  broadcastLobby() {
    const net = session.net;
    if (!net || !net.isHost) return;
    net.broadcastMessage('lobby', { players: session.players });
    this.render();
  }

  goRace() {
    if (this.leavingToRace) return;
    this.leavingToRace = true;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    this.teardown();
    this.game.loadScene(RACE_SCENE_URL, { data: { race: session.race } });
  }

  /** Message handlers for the lobby; removed when the scene goes. */
  wire(net) {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (net.isHost) {
      this.unsubs.push(
        net.onMessage('hello', (peerId, data) => {
          if (session.players.some((p) => p.id === peerId)) return;
          const used = new Set(session.players.map((p) => p.slot));
          let slot = -1;
          for (let s = 0; s < MAX_PLAYERS; s++) {
            if (!used.has(s)) {
              slot = s;
              break;
            }
          }
          if (slot < 0) {
            net.sendMessage(peerId, 'full', {});
            return;
          }
          const name = String((data && data.name) || '').slice(0, 16) || `Driver ${slot + 1}`;
          const skin =
            Number.isInteger(data && data.skin) && data.skin >= 0 && data.skin < CAR_SKINS.length
              ? data.skin
              : slot;
          session.players.push({ id: peerId, name, skin, slot, isHost: false, rtt: NaN });
          session.players.sort((a, b) => a.slot - b.slot);
          toast(`${name} joined`);
          this.broadcastLobby();
        }),
        net.on('peerLeft', (peerId) => {
          const p = session.players.find((q) => q.id === peerId);
          session.players = session.players.filter((q) => q.id !== peerId);
          if (p) toast(`${p.name} left`);
          this.broadcastLobby();
        })
      );
    } else {
      this.unsubs.push(
        net.onMessage('lobby', (_peer, data) => {
          session.players = (data && data.players) || [];
          this.render();
        }),
        net.onMessage('start', (_peer, race) => {
          session.race = race;
          this.goRace();
        }),
        net.onMessage('full', async () => {
          await closeNetwork();
          this.goHome('That room is full.');
        }),
        net.onMessage('busy', async () => {
          await closeNetwork();
          this.goHome('A race is running in that room. Try again when it ends.');
        }),
        net.on('state', async (state) => {
          if (state !== NET_STATE.DISCONNECTED) return;
          await closeNetwork();
          this.goHome('The host left the room.');
        })
      );
    }
  }

  actions() {
    return {
      onName: (v) => {
        session.name = String(v).slice(0, 16);
        this.view.name = session.name;
        savePrefs();
      },
      onSkin: (i) => {
        session.skin = i;
        this.view.skin = i;
        savePrefs();
        this.render();
      },
      onSignaling: (kind) => {
        session.signaling = kind;
        this.view.signaling = kind;
        savePrefs();
        this.render();
      },
      onJoinCode: (input, value) => {
        const raw = String(value)
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, '')
          .slice(0, 8);
        const formatted = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
        if (input.value !== formatted) input.value = formatted;
        this.view.joinCode = formatted;
      },
      onCreate: () => this.createRoom(),
      onJoin: () => this.joinRoom(),
      onStart: () => this.startRace(),
      onLeave: async () => {
        await closeNetwork();
        this.goHome();
      },
      onCopyCode: () => this.copy(session.net ? session.net.displayCode : '', 'Code copied'),
      onCopyLink: () => {
        const net = session.net;
        if (!net) return;
        const url = new URL(location.href);
        url.search = '';
        url.searchParams.set('scene', 'netracers');
        url.searchParams.set('room', net.displayCode);
        url.searchParams.set('net', session.signaling);
        this.copy(url.toString(), 'Invite link copied');
      },
    };
  }

  async copy(text, done) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast(done);
    } catch {
      toast(text); // no clipboard permission: show it so it can be copied by hand
    }
  }

  playerName(fallbackSlot) {
    return session.name.trim() || `Driver ${fallbackSlot + 1}`;
  }

  async createRoom() {
    this.view.screen = 'connecting';
    this.view.statusText =
      session.signaling === 'local' ? 'Opening a room on this computer…' : 'Creating a room…';
    this.render();
    try {
      const net = await openNetwork(session.signaling);
      await net.host({ maxPeers: MAX_PLAYERS - 1 });
      session.players = [
        {
          id: net.myId,
          name: this.playerName(0),
          skin: session.skin,
          slot: 0,
          isHost: true,
          rtt: null,
        },
      ];
      this.wire(net);
      this.enterRoom();
    } catch (e) {
      await closeNetwork();
      this.goHome(friendlyError(e));
    }
  }

  async joinRoom() {
    const code = normalizeRoomCode(this.view.joinCode);
    if (!code) {
      toast('Type the 8-character room code (like K7F2-Q9MX).', 'error');
      const input = document.getElementById('nr-join-code');
      if (input) input.focus();
      return;
    }
    this.view.screen = 'connecting';
    this.view.statusText = `Joining ${formatRoomCode(code)}…`;
    this.render();
    try {
      const net = await openNetwork(session.signaling);
      this.wire(net); // before join: the host may answer hello at once
      await net.join(code);
      session.players = [];
      net.sendMessageToHost('hello', { name: this.playerName(1), skin: session.skin });
      this.enterRoom();
    } catch (e) {
      await closeNetwork();
      this.goHome(friendlyError(e));
    }
  }

  startRace() {
    const net = session.net;
    if (!net || !net.isHost) return;
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    session.race = {
      seed,
      players: session.players.map(({ rtt, ...p }) => p),
      entities: buildRace(seed, session.players),
    };
    net.broadcastMessage('start', session.race);
    this.goRace();
  }
}

function friendlyError(e) {
  const msg = (e && e.message) || String(e);
  if (/Failed to fetch|import|gstatic|NetworkError/i.test(msg)) {
    return 'Could not reach the signaling service. Check the connection, or play over "This computer".';
  }
  if (/PERMISSION_DENIED|permission/i.test(msg))
    return 'The signaling database refused the request (check its rules).';
  return msg;
}
