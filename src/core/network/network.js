// network.js - WebRTC multiplayer: rooms, peers, channels, messages.
//
// Star topology: one host, up to maxPeers clients, each with its own
// RTCPeerConnection to the host. Two data channels per connection:
//   reliable  ordered, retransmitted   control, JSON messages, events
//   fast      unordered, no retransmit snapshots, input, pings
//
// Lives on the main thread: RTCPeerConnection does not exist in workers. What the
// game needs in workers crosses through a SharedResource (see demos/netRacers).
//
//   const net = new Network({ signaling: 'firebase', firebase: { … } });   // or 'local'
//   const code = await net.host({ maxPeers: 3 });
//   await net.join(code);
//   net.on('peerJoined', (peerId) => …);
//   net.onMessage('start', (peerId, data) => …);
//   net.broadcastMessage('start', { seed: 7 });
//   net.onBinary(16, (peerId, view, channel) => …);
//   net.rtt(peerId);
//
// Plan and stages: docs/internal/NETWORKING_PLAN.md.

import {
  NET_CHANNEL,
  NET_MSG,
  NET_PROTOCOL_VERSION,
  decodeJsonMessage,
  encodeJsonMessage,
  encodeTimeMessage,
  formatRoomCode,
  generateRoomCode,
  netNow,
  normalizeRoomCode,
} from './netProtocol.js';
import { RoomSignaling } from './roomSignaling.js';
import { FirebaseStore, LocalStorageStore } from './signalingStore.js';

const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];
const PING_INTERVAL_MS = 1000;
const RTT_EMA = 0.25;
const DEFAULT_JOIN_TIMEOUT_MS = 20000;

/** Network.state values. */
export const NET_STATE = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  HOSTING: 'hosting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
});

function makeStore(signaling, firebase) {
  if (signaling && typeof signaling === 'object') return signaling;
  if (signaling === 'local') return new LocalStorageStore();
  if (signaling === 'firebase' || (!signaling && firebase)) return new FirebaseStore(firebase);
  throw new Error(
    "Network: signaling must be 'firebase' (with a firebase config), 'local', or a store object"
  );
}

function randomPeerId() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export class Network {
  /**
   * @param {object} config
   * @param {'firebase'|'local'|object} [config.signaling] - 'firebase' (default when config.firebase is set),
   *   'local' (tabs of one browser, localStorage), or a store object (signalingStore.js interface)
   * @param {object} [config.firebase] - Firebase web config with databaseURL (Realtime Database)
   * @param {RTCIceServer[]} [config.iceServers] - STUN/TURN; defaults to Google STUN ([] for 'local')
   * @param {number} [config.joinTimeoutMs=20000]
   * @param {boolean} [config.log=false] - connection steps to the console
   */
  constructor(config = {}) {
    this.myId = randomPeerId();
    this.signalingKind =
      typeof config.signaling === 'string'
        ? config.signaling
        : config.firebase
          ? 'firebase'
          : 'custom';
    this._store = makeStore(config.signaling, config.firebase);
    this._signaling = new RoomSignaling(this._store);
    this._iceServers =
      config.iceServers ?? (config.signaling === 'local' ? [] : DEFAULT_ICE_SERVERS);
    this._joinTimeoutMs = config.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS;
    this._log = !!config.log;

    this.role = null; // 'host' | 'client' | null
    this.state = NET_STATE.IDLE;
    this.roomCode = ''; // normalized, no separator
    this.hostId = null;
    this.maxPeers = 0;

    /** @type {Map<string, PeerLink>} */
    this._peers = new Map();
    this._unsubs = [];
    this._pingTimer = null;
    /** True while leave() closes our own links (no peerLeft / disconnected for those). */
    this._closing = false;

    this._listeners = { peerJoined: new Set(), peerLeft: new Set(), state: new Set() };
    /** @type {Map<string, Set<Function>>} */
    this._jsonHandlers = new Map();
    /** @type {Array<Function|null>} index = message type */
    this._binaryHandlers = new Array(256).fill(null);
  }

  // ---------------------------------------------------------------------------
  // Public: rooms
  // ---------------------------------------------------------------------------

  get isHost() {
    return this.role === 'host';
  }

  get isClient() {
    return this.role === 'client';
  }

  /** XXXX-XXXX, or '' before host/join. */
  get displayCode() {
    return formatRoomCode(this.roomCode);
  }

  /** Connected peers (data channel open). For a client, that is the host. */
  get peerIds() {
    const out = [];
    for (const [id, link] of this._peers) if (link.open) out.push(id);
    return out;
  }

  /**
   * Create a room and become its host. Resolves with the code as XXXX-XXXX.
   * @param {{ code?: string, maxPeers?: number }} [options]
   */
  async host(options = {}) {
    this._assertIdle();
    const code = normalizeRoomCode(options.code || generateRoomCode());
    if (!code) throw new Error(`Network.host: invalid room code "${options.code}"`);
    this.role = 'host';
    this.roomCode = code;
    this.hostId = this.myId;
    this.maxPeers = Math.max(1, options.maxPeers ?? 7);
    this._setState(NET_STATE.CONNECTING);
    try {
      await this._signaling.enter(code, this.myId);
      const claimed = await this._signaling.claimHost(this.myId);
      if (!claimed) throw new Error(`Room ${formatRoomCode(code)} already has a host`);
    } catch (e) {
      await this._reset();
      throw e;
    }
    this._unsubs.push(
      this._signaling.watchPresenceAdded((peerId) => {
        if (peerId !== this.myId) this._hostConnect(peerId);
      }),
      this._signaling.watchPresenceRemoved((peerId) => {
        if (peerId !== this.myId) this._dropPeer(peerId);
      })
    );
    this._startPings();
    this._setState(NET_STATE.HOSTING);
    this._debug(`hosting ${this.displayCode} as ${this.myId}`);
    return this.displayCode;
  }

  /**
   * Join a room. Resolves when the reliable channel to the host is open.
   * @param {string} code - as typed (XXXX-XXXX, spaces and case do not matter)
   */
  async join(code) {
    this._assertIdle();
    const room = normalizeRoomCode(code);
    if (!room) throw new Error('That is not a room code (8 letters and digits, like K7F2-Q9MX)');
    this.role = 'client';
    this.roomCode = room;
    this._setState(NET_STATE.CONNECTING);
    try {
      await this._signaling.enter(room, this.myId);
      const host = await this._signaling.liveHost();
      if (!host) throw new Error(`Room ${formatRoomCode(room)} was not found, or its host left`);
      this.hostId = host;
      await this._clientConnect();
    } catch (e) {
      await this._signaling.leave(this.myId, false).catch(() => {});
      await this._reset();
      throw e;
    }
    this._startPings();
    this._setState(NET_STATE.CONNECTED);
  }

  /** Close every connection, leave the room, forget handlers' peers. Handlers stay registered. */
  async leave() {
    const wasHost = this.isHost;
    if (this.roomCode) await this._signaling.leave(this.myId, wasHost).catch(() => {});
    await this._reset();
  }

  /** leave(), then release the store (timers, listeners). The instance is done. */
  async destroy() {
    await this.leave();
    if (this._store.close) this._store.close();
    for (const set of Object.values(this._listeners)) set.clear();
    this._jsonHandlers.clear();
    this._binaryHandlers.fill(null);
  }

  // ---------------------------------------------------------------------------
  // Public: events and messages
  // ---------------------------------------------------------------------------

  /**
   * @param {'peerJoined'|'peerLeft'|'state'} event - peerJoined(peerId), peerLeft(peerId), state(state)
   * @param {Function} fn
   * @returns {() => void} unsubscribe
   */
  on(event, fn) {
    const set = this._listeners[event];
    if (!set) throw new Error(`Network.on: unknown event "${event}"`);
    set.add(fn);
    return () => set.delete(fn);
  }

  /** JSON message handler: fn(peerId, data). Several handlers per name are fine. */
  onMessage(name, fn) {
    let set = this._jsonHandlers.get(name);
    if (!set) this._jsonHandlers.set(name, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  /**
   * Binary handler for one message type (NET_MSG.USER_MIN..255, or an engine type such as
   * NET_MSG.POSES): fn(peerId, DataView over the whole packet, channel). One per type.
   */
  onBinary(type, fn) {
    if (
      !(type >= 0 && type <= 255) ||
      type === NET_MSG.JSON ||
      type === NET_MSG.PING ||
      type === NET_MSG.PONG
    ) {
      throw new RangeError(`Network.onBinary: type ${type} is reserved or out of range`);
    }
    this._binaryHandlers[type] = fn;
    return () => {
      if (this._binaryHandlers[type] === fn) this._binaryHandlers[type] = null;
    };
  }

  sendMessage(peerId, name, data) {
    return this._sendTo(peerId, encodeJsonMessage(name, data), NET_CHANNEL.RELIABLE);
  }

  /** To every connected peer, except `exceptPeerId` when given. */
  broadcastMessage(name, data, exceptPeerId = null) {
    const bytes = encodeJsonMessage(name, data);
    for (const id of this._peers.keys())
      if (id !== exceptPeerId) this._sendTo(id, bytes, NET_CHANNEL.RELIABLE);
  }

  sendMessageToHost(name, data) {
    return this.hostId ? this.sendMessage(this.hostId, name, data) : false;
  }

  /** bytes: Uint8Array or ArrayBuffer whose first byte is the message type. */
  sendBinary(peerId, bytes, channel = NET_CHANNEL.FAST) {
    return this._sendTo(peerId, bytes, channel);
  }

  broadcastBinary(bytes, channel = NET_CHANNEL.FAST) {
    for (const id of this._peers.keys()) this._sendTo(id, bytes, channel);
  }

  sendBinaryToHost(bytes, channel = NET_CHANNEL.FAST) {
    return this.hostId ? this._sendTo(this.hostId, bytes, channel) : false;
  }

  /** Round trip to a peer in ms (smoothed), NaN before the first pong. */
  rtt(peerId) {
    const link = this._peers.get(peerId);
    return link ? link.rttMs : NaN;
  }

  // ---------------------------------------------------------------------------
  // Internals: host
  // ---------------------------------------------------------------------------

  _hostConnect(clientId) {
    if (this._peers.has(clientId)) return;
    if (this._peers.size >= this.maxPeers) {
      this._debug(`room full, ignoring ${clientId}`);
      return;
    }
    const pc = new RTCPeerConnection({ iceServers: this._iceServers });
    const link = this._newLink(clientId, pc);
    this._debug(`connecting to ${clientId}`);

    pc.onicecandidate = (e) => {
      if (e.candidate)
        this._signaling.sendCandidate(clientId, 'host', e.candidate.toJSON()).catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      this._debug(`→ ${clientId}: ${pc.connectionState}`);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed')
        this._dropPeer(clientId);
    };

    this._wireChannel(link, pc.createDataChannel('reliable'), NET_CHANNEL.RELIABLE);
    this._wireChannel(
      link,
      pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 }),
      NET_CHANNEL.FAST
    );

    let pendingOfferId = null;
    pc.onnegotiationneeded = async () => {
      if (pc.signalingState !== 'stable') return;
      const offerId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      pendingOfferId = offerId;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await this._signaling.clearAnswer(clientId);
        await this._signaling.sendOffer(clientId, {
          type: offer.type,
          sdp: offer.sdp,
          offerId,
          fromId: this.myId,
          protocol: NET_PROTOCOL_VERSION,
        });
      } catch (e) {
        console.error(`[Network] offer to ${clientId} failed:`, e);
      }
    };

    link.unsubs.push(
      this._signaling.watchAnswer(clientId, async ({ type, sdp, offerId }) => {
        if (offerId !== pendingOfferId || pc.signalingState !== 'have-local-offer') return;
        try {
          await pc.setRemoteDescription({ type, sdp });
          pendingOfferId = null;
          this._flushCandidates(link);
        } catch (e) {
          console.error(`[Network] answer from ${clientId} rejected:`, e);
        }
      }),
      this._signaling.watchCandidates(clientId, 'client', (candidate) => {
        link.pendingCandidates.push(candidate);
        this._flushCandidates(link);
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Internals: client
  // ---------------------------------------------------------------------------

  _clientConnect() {
    return new Promise((resolve, reject) => {
      const pc = new RTCPeerConnection({ iceServers: this._iceServers });
      const link = this._newLink(this.hostId, pc);
      let settled = false;
      const timer = setTimeout(
        () =>
          settle(
            new Error(
              'Could not reach the host (the room may be full, or the network blocks peer connections)'
            )
          ),
        this._joinTimeoutMs
      );
      const settle = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      link.onOpen = () => settle(null);

      pc.onicecandidate = (e) => {
        if (e.candidate)
          this._signaling.sendCandidate(this.myId, 'client', e.candidate.toJSON()).catch(() => {});
      };
      pc.onconnectionstatechange = () => {
        this._debug(`host: ${pc.connectionState}`);
        const s = pc.connectionState;
        if (s === 'failed' || s === 'closed') {
          if (!settled) settle(new Error(`Connection to the host ${s}`));
          else this._dropPeer(this.hostId);
        }
      };
      pc.ondatachannel = (e) => {
        const ch = e.channel;
        this._wireChannel(link, ch, ch.label === 'fast' ? NET_CHANNEL.FAST : NET_CHANNEL.RELIABLE);
      };

      let lastOfferId = null;
      link.unsubs.push(
        this._signaling.watchCandidates(this.myId, 'host', (candidate) => {
          link.pendingCandidates.push(candidate);
          this._flushCandidates(link);
        }),
        this._signaling.watchOffer(this.myId, async ({ type, sdp, offerId, fromId, protocol }) => {
          if (offerId && offerId === lastOfferId) return;
          lastOfferId = offerId || null;
          if (protocol !== undefined && protocol !== NET_PROTOCOL_VERSION) {
            settle(
              new Error(
                `The host runs network protocol ${protocol}, this page ${NET_PROTOCOL_VERSION}: reload both`
              )
            );
            return;
          }
          if (fromId && fromId !== this.hostId) return; // an offer from a host that is gone
          try {
            await pc.setRemoteDescription({ type, sdp });
            this._flushCandidates(link);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await this._signaling.sendAnswer(this.myId, {
              type: answer.type,
              sdp: answer.sdp,
              offerId,
            });
          } catch (e) {
            settle(e);
          }
        })
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Internals: links, channels, framing
  // ---------------------------------------------------------------------------

  /**
   * @typedef {object} PeerLink
   * @property {string} id
   * @property {RTCPeerConnection} pc
   * @property {RTCDataChannel|null} reliable
   * @property {RTCDataChannel|null} fast
   * @property {boolean} open
   * @property {number} rttMs
   * @property {object[]} pendingCandidates
   * @property {Function[]} unsubs
   * @property {Function|null} onOpen
   */
  _newLink(id, pc) {
    const link = {
      id,
      pc,
      reliable: null,
      fast: null,
      open: false,
      rttMs: NaN,
      pendingCandidates: [],
      unsubs: [],
      onOpen: null,
    };
    this._peers.set(id, link);
    return link;
  }

  _wireChannel(link, ch, channel) {
    ch.binaryType = 'arraybuffer';
    if (channel === NET_CHANNEL.FAST) link.fast = ch;
    else link.reliable = ch;
    ch.onmessage = (e) => this._receive(link.id, e.data, channel);
    if (channel === NET_CHANNEL.RELIABLE) {
      ch.onopen = () => {
        link.open = true;
        this._debug(`channel open with ${link.id}`);
        if (link.onOpen) link.onOpen();
        this._emit('peerJoined', link.id);
      };
      ch.onclose = () => {
        if (link.open) this._dropPeer(link.id);
      };
    }
  }

  _sendTo(peerId, bytes, channel) {
    const link = this._peers.get(peerId);
    if (!link || !link.open) return false;
    const ch = channel === NET_CHANNEL.FAST ? link.fast : link.reliable;
    if (!ch || ch.readyState !== 'open') return false;
    try {
      ch.send(bytes);
      return true;
    } catch (e) {
      this._debug(`send to ${peerId} failed: ${e.message}`);
      return false;
    }
  }

  _receive(peerId, data, channel) {
    if (!(data instanceof ArrayBuffer) || data.byteLength === 0) return;
    const bytes = new Uint8Array(data);
    const type = bytes[0];
    if (type === NET_MSG.JSON) {
      const msg = decodeJsonMessage(bytes);
      const set = msg && this._jsonHandlers.get(msg.name);
      if (!set) return;
      for (const fn of set) {
        try {
          fn(peerId, msg.data);
        } catch (e) {
          console.error(`[Network] handler for "${msg.name}" threw:`, e);
        }
      }
      return;
    }
    const view = new DataView(data);
    if (type === NET_MSG.PING) {
      if (data.byteLength >= 9)
        this._sendTo(
          peerId,
          encodeTimeMessage(NET_MSG.PONG, view.getFloat64(1, true)),
          NET_CHANNEL.FAST
        );
      return;
    }
    if (type === NET_MSG.PONG) {
      const link = this._peers.get(peerId);
      if (link && data.byteLength >= 9) {
        const sample = netNow() - view.getFloat64(1, true);
        link.rttMs = Number.isNaN(link.rttMs)
          ? sample
          : link.rttMs + RTT_EMA * (sample - link.rttMs);
      }
      return;
    }
    const fn = this._binaryHandlers[type];
    if (fn) {
      try {
        fn(peerId, view, channel);
      } catch (e) {
        console.error(`[Network] binary handler ${type} threw:`, e);
      }
    }
  }

  _flushCandidates(link) {
    if (!link.pc.remoteDescription) return;
    while (link.pendingCandidates.length) {
      const init = link.pendingCandidates.shift();
      if (!init || !init.candidate) continue;
      const c =
        init.sdpMLineIndex == null && init.sdpMid == null ? { ...init, sdpMLineIndex: 0 } : init;
      link.pc.addIceCandidate(c).catch((e) => this._debug(`addIceCandidate: ${e.message}`));
    }
  }

  _dropPeer(peerId) {
    const link = this._peers.get(peerId);
    if (!link) return;
    this._peers.delete(peerId);
    for (const u of link.unsubs) u();
    try {
      link.pc.close();
    } catch {
      // already closed
    }
    // Our own leave() is not news: listeners hear 'state' → idle, not that the other side went.
    if (this._closing) return;
    if (this.isHost) this._signaling.clearConnection(peerId).catch(() => {});
    if (link.open) this._emit('peerLeft', peerId);
    if (this.isClient && peerId === this.hostId) this._setState(NET_STATE.DISCONNECTED);
  }

  _startPings() {
    if (this._pingTimer) return;
    this._pingTimer = setInterval(() => {
      const bytes = encodeTimeMessage(NET_MSG.PING, netNow());
      for (const id of this._peers.keys()) this._sendTo(id, bytes, NET_CHANNEL.FAST);
    }, PING_INTERVAL_MS);
  }

  async _reset() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = null;
    for (const u of this._unsubs) u();
    this._unsubs = [];
    this._closing = true;
    try {
      for (const id of [...this._peers.keys()]) this._dropPeer(id);
    } finally {
      this._closing = false;
    }
    this.role = null;
    this.roomCode = '';
    this.hostId = null;
    this.maxPeers = 0;
    this._setState(NET_STATE.IDLE);
  }

  _assertIdle() {
    if (this.role)
      throw new Error(
        `Network: already ${this.isHost ? 'hosting' : 'in'} room ${this.displayCode}; call leave() first`
      );
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this._emit('state', state);
  }

  _emit(event, arg) {
    for (const fn of this._listeners[event]) {
      try {
        fn(arg);
      } catch (e) {
        console.error(`[Network] ${event} listener threw:`, e);
      }
    }
  }

  _debug(text) {
    if (this._log) console.log(`[Network] ${text}`);
  }
}
