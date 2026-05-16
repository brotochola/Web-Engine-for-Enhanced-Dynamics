/**
 * Network — WeedJS multiplayer layer.
 *
 * Browser-only WebRTC networking with Firebase Realtime Database as the
 * signaling back-end.  One peer is the authoritative host; all others are
 * clients.  The host runs physics/logic workers; clients only render.
 *
 * Usage:
 *   const game = new GameEngine({
 *     network: {
 *       firebase: { apiKey, authDomain, databaseURL, … },
 *       iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
 *     }
 *   });
 *
 *   const roomId = await game.network.host();
 *   // — or —
 *   await game.network.join('abc12');
 *
 *   await game.loadScene(MyScene);
 *
 * Firebase is loaded from the official CDN — no npm install required.
 */

import { FirebaseSignaling } from './FirebaseSignaling.js';
import { NETWORK_CHANNEL } from '../ConfigDefaults.js';

const DEFAULT_ICE = [
  {
    urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun2.l.google.com:19302',
      'stun:stun3.l.google.com:19302',
      'stun:stun4.l.google.com:19302',
    ],
  },
];
export class Network {
  /**
   * @param {object} config
   * @param {object} config.firebase       - Firebase project config
   * @param {object[]} [config.iceServers] - RTCIceServer array (defaults to Google STUN)
   */
  constructor(config) {
    this.myId = Math.random().toString(36).slice(2);
    this._iceServers = config.iceServers ?? DEFAULT_ICE;
    this._signaling = new FirebaseSignaling(config.firebase);

    this._role = null;      // 'host' | 'client'
    this._roomId = null;
    this._hostId = null;    // peerId of the host (known by clients after first offer)

    // host state
    this._peers = new Map();           // peerId → PeerState
    this._presenceAddedUnsub = null;
    this._presenceRemovedUnsub = null;

    // client state
    this._clientPc = null;
    this._clientPendingCandidates = [];
    this._clientCandidatesUnsub = null;
    this._clientOfferUnsub = null;

    // event callbacks
    this._onPeerConnectedCbs = [];
    this._onPeerDisconnectedCbs = [];

    // single message handler — set via `network.onMessage = fn`
    // fn signature: (peerId: string, data: ArrayBuffer, channel: 0|1) => void
    this._onMessageHandler = null;
  }

  // ---------------------------------------------------------------------------
  // Public API — setup
  // ---------------------------------------------------------------------------

  /**
   * Creates a room and claims the host role.
   * Resolves immediately; clients that join later trigger onPeerConnected.
   * @param {string} [roomId] - Leave empty to auto-generate a 5-char room code.
   * @returns {Promise<string>} The room ID.
   */
  async host(roomId) {
    this._roomId = roomId ?? Math.random().toString(36).slice(2, 7);
    this._role = 'host';

    await this._signaling.enterRoom(this._roomId, this.myId);
    const claimed = await this._signaling.claimHost(this._roomId, this.myId);
    if (!claimed) {
      this._role = null;
      throw new Error(`[Network] Could not claim host in room "${this._roomId}". Another host is already present.`);
    }

    this._presenceAddedUnsub = this._signaling.watchPresenceAdded(this._roomId, peerId => {
      if (peerId === this.myId) return;
      this._connectToClient(peerId);
    });

    this._presenceRemovedUnsub = this._signaling.watchPresenceRemoved(this._roomId, peerId => {
      if (peerId === this.myId) return;
      console.log(`[Network] peer ${peerId} left`);
      this._closePeer(peerId);
      this._onPeerDisconnectedCbs.forEach(cb => cb(peerId));
    });

    console.log(`[Network] hosting room "${this._roomId}" as ${this.myId}`);
    return this._roomId;
  }

  /**
   * Joins an existing room as a client.
   * Resolves when the WebRTC reliable data channel to the host is open.
   * @param {string} roomId
   * @returns {Promise<void>}
   */
  async join(roomId) {
    this._roomId = roomId;
    this._role = 'client';

    await this._signaling.enterRoom(roomId, this.myId);
    const claimed = await this._signaling.claimHost(roomId, this.myId);

    if (claimed) {
      // Room had no host; revert so the caller must use host() explicitly.
      this._role = null;
      await this._signaling.leaveRoom(roomId, this.myId, true);
      throw new Error(`[Network] Room "${roomId}" has no host. Call network.host() to create it.`);
    }

    console.log(`[Network] joining room "${roomId}" as client ${this.myId}`);
    return new Promise((resolve, reject) => this._startClientConnection(resolve, reject));
  }

  // ---------------------------------------------------------------------------
  // Public API — messaging
  // ---------------------------------------------------------------------------

  /**
   * Registers a callback fired when a peer's reliable data channel opens.
   * @param {function(string): void} cb - receives the peerId
   */
  onPeerConnected(cb) {
    this._onPeerConnectedCbs.push(cb);
  }

  /**
   * Registers a callback fired when a peer disconnects.
   * @param {function(string): void} cb - receives the peerId
   */
  onPeerDisconnected(cb) {
    this._onPeerDisconnectedCbs.push(cb);
  }

  /**
   * Registers the single incoming-message handler.
   * There is only one handler (not an array) to keep the hot path allocation-free.
   * @param {function(string, ArrayBuffer, 0|1): void} handler
   *   - peerId:  sender's peer ID
   *   - data:    raw ArrayBuffer from the data channel
   *   - channel: NETWORK_CHANNEL.RELIABLE (0) or NETWORK_CHANNEL.FAST (1)
   */
  set onMessage(handler) {
    this._onMessageHandler = handler;
  }

  /**
   * Sends data to a specific peer.
   * @param {string} peerId
   * @param {ArrayBuffer|TypedArray|DataView} data
   * @param {0|1} [channel=NETWORK_CHANNEL.RELIABLE]
   */
  send(peerId, data, channel = NETWORK_CHANNEL.RELIABLE) {
    const peer = this._peers.get(peerId);
    if (!peer) return;
    const dc = channel === NETWORK_CHANNEL.FAST ? peer.fastDc : peer.reliableDc;
    if (dc?.readyState === 'open') dc.send(data);
  }

  /**
   * Sends data to all connected peers.
   * Iterates peers.values() directly to avoid a redundant Map lookup per peer.
   * @param {ArrayBuffer|TypedArray|DataView} data
   * @param {0|1} [channel=NETWORK_CHANNEL.RELIABLE]
   */
  broadcast(data, channel = NETWORK_CHANNEL.RELIABLE) {
    const fast = channel === NETWORK_CHANNEL.FAST;
    for (const peer of this._peers.values()) {
      const dc = fast ? peer.fastDc : peer.reliableDc;
      if (dc?.readyState === 'open') dc.send(data);
    }
  }

  /**
   * Sends data to the host. Only valid when this peer is a client.
   * Bypasses the send() wrapper for a direct single Map lookup.
   * @param {ArrayBuffer|TypedArray|DataView} data
   * @param {0|1} [channel=NETWORK_CHANNEL.RELIABLE]
   */
  sendToHost(data, channel = NETWORK_CHANNEL.RELIABLE) {
    if (!this._hostId) return;
    const peer = this._peers.get(this._hostId);
    if (!peer) return;
    const dc = channel === NETWORK_CHANNEL.FAST ? peer.fastDc : peer.reliableDc;
    if (dc?.readyState === 'open') dc.send(data);
  }

  // ---------------------------------------------------------------------------
  // Public API — getters
  // ---------------------------------------------------------------------------

  get role() { return this._role; }
  get roomId() { return this._roomId; }
  get isHost() { return this._role === 'host'; }
  get isClient() { return this._role === 'client'; }

  /** @returns {Map<string, {pc: RTCPeerConnection, reliableDc: RTCDataChannel, fastDc: RTCDataChannel}>} */
  get peers() { return this._peers; }

  // ---------------------------------------------------------------------------
  // Public API — teardown
  // ---------------------------------------------------------------------------

  /**
   * Closes all peer connections, removes Firebase presence, and resets state.
   */
  async destroy() {
    if (this._presenceAddedUnsub) { this._presenceAddedUnsub(); this._presenceAddedUnsub = null; }
    if (this._presenceRemovedUnsub) { this._presenceRemovedUnsub(); this._presenceRemovedUnsub = null; }

    for (const clientId of [...this._peers.keys()]) {
      this._closePeer(clientId);
    }

    if (this._clientCandidatesUnsub) { this._clientCandidatesUnsub(); this._clientCandidatesUnsub = null; }
    if (this._clientOfferUnsub) { this._clientOfferUnsub(); this._clientOfferUnsub = null; }
    if (this._clientPc) {
      try { this._clientPc.close(); } catch (_) { }
      this._clientPc = null;
    }
    this._clientPendingCandidates = [];

    if (this._roomId) {
      await this._signaling.leaveRoom(this._roomId, this.myId, this.isHost);
    }

    this._role = null;
    this._roomId = null;
    this._hostId = null;
    console.log('[Network] destroyed');
  }

  // ---------------------------------------------------------------------------
  // Host internals
  // ---------------------------------------------------------------------------

  /**
   * Called by the host for each peer that joins the room.
   * Creates an RTCPeerConnection, data channels, and kicks off offer/answer.
   * @param {string} clientId
   */
  _connectToClient(clientId) {
    if (this._peers.has(clientId)) return;

    const pc = this._createPC();
    /** @type {PeerState} */
    const peer = {
      pc,
      reliableDc: null,
      fastDc: null,
      pendingCandidates: [],
      candidatesUnsub: null,
      answerUnsub: null,
    };
    this._peers.set(clientId, peer);
    console.log(`[Network] host connecting to ${clientId}`);

    pc.onicecandidate = async e => {
      if (!e.candidate) return;
      await this._signaling.sendCandidate(this._roomId, clientId, {
        from: 'host',
        candidate: e.candidate.toJSON(),
      });
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log(`[Network] host→${clientId} connectionState →`, state);
      if (state === 'failed') {
        this._closePeer(clientId);
        this._onPeerDisconnectedCbs.forEach(cb => cb(clientId));
      }
    };

    peer.reliableDc = pc.createDataChannel('reliable');
    peer.reliableDc.binaryType = 'arraybuffer';
    peer.reliableDc.onopen = () => {
      console.log(`[Network] reliable open → ${clientId}`);
      this._onPeerConnectedCbs.forEach(cb => cb(clientId));
    };
    peer.reliableDc.onerror = e => console.error(`[Network] reliable error → ${clientId}:`, e);
    peer.reliableDc.onmessage = e => {
      if (this._onMessageHandler) this._onMessageHandler(clientId, e.data, NETWORK_CHANNEL.RELIABLE);
    };

    peer.fastDc = pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 });
    peer.fastDc.binaryType = 'arraybuffer';
    peer.fastDc.onerror = e => console.error(`[Network] fast error → ${clientId}:`, e);
    peer.fastDc.onmessage = e => {
      if (this._onMessageHandler) this._onMessageHandler(clientId, e.data, NETWORK_CHANNEL.FAST);
    };

    let currentOfferId = null;
    let lastAnswerOfferId = null;

    pc.onnegotiationneeded = async () => {
      if (pc.signalingState !== 'stable') return;
      const offerId = `${this.myId}-${clientId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      currentOfferId = offerId;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await this._signaling.clearAnswer(this._roomId, clientId);
        await this._signaling.sendOffer(this._roomId, clientId, {
          type: offer.type,
          sdp: offer.sdp,
          offerId,
          fromId: this.myId,
        });
      } catch (err) {
        console.error(`[Network] onnegotiationneeded error for ${clientId}:`, err);
      }
    };

    peer.answerUnsub = this._signaling.watchAnswer(this._roomId, clientId, async ({ type, sdp, offerId }) => {
      if (offerId !== currentOfferId) return;
      if (offerId === lastAnswerOfferId) return;
      if (pc.signalingState !== 'have-local-offer') return;
      try {
        await pc.setRemoteDescription({ type, sdp });
        lastAnswerOfferId = offerId;
        currentOfferId = null;
        this._flushCandidates(pc, peer.pendingCandidates);
      } catch (err) {
        console.error(`[Network] setRemoteDescription(answer) error for ${clientId}:`, err);
      }
    });

    peer.candidatesUnsub = this._signaling.watchCandidates(
      this._roomId, clientId, 'client',
      candidate => {
        peer.pendingCandidates.push(candidate);
        this._flushCandidates(pc, peer.pendingCandidates);
      },
    );
  }

  _closePeer(clientId) {
    const peer = this._peers.get(clientId);
    if (!peer) return;
    if (peer.candidatesUnsub) peer.candidatesUnsub();
    if (peer.answerUnsub) peer.answerUnsub();
    try { peer.pc.close(); } catch (_) { }
    this._peers.delete(clientId);
    console.log(`[Network] peer ${clientId} closed`);
  }

  // ---------------------------------------------------------------------------
  // Client internals
  // ---------------------------------------------------------------------------

  /**
   * Sets up the client-side RTCPeerConnection and waits for the host's offer.
   * Resolves the join() Promise when the reliable data channel opens.
   */
  _startClientConnection(resolve, reject) {
    const pc = this._createPC();
    this._clientPc = pc;

    let reliableDc = null;
    let fastDc = null;
    let settled = false;

    const settle = (err) => {
      if (settled) return;
      settled = true;
      if (err) {
        reject(err);
      } else {
        const hostPeerId = this._hostId ?? 'host';
        this._peers.set(hostPeerId, { pc, reliableDc, fastDc, pendingCandidates: [] });
        this._onPeerConnectedCbs.forEach(cb => cb(hostPeerId));
        resolve();
      }
    };

    pc.onicecandidate = async e => {
      if (!e.candidate) return;
      await this._signaling.sendCandidate(this._roomId, this.myId, {
        from: 'client',
        candidate: e.candidate.toJSON(),
      });
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log('[Network] client connectionState →', state);
      if ((state === 'failed' || state === 'closed') && !settled) {
        settle(new Error(`[Network] WebRTC connection ${state}`));
      }
    };

    pc.ondatachannel = e => {
      const ch = e.channel;
      ch.binaryType = 'arraybuffer';
      if (ch.label === 'reliable') {
        reliableDc = ch;
        ch.onopen = () => settle(null);
        ch.onerror = err => settle(new Error(`[Network] reliable channel error: ${err}`));
        ch.onmessage = e => {
          if (this._onMessageHandler) this._onMessageHandler(this._hostId, e.data, NETWORK_CHANNEL.RELIABLE);
        };
      } else if (ch.label === 'fast') {
        fastDc = ch;
        ch.onmessage = e => {
          if (this._onMessageHandler) this._onMessageHandler(this._hostId, e.data, NETWORK_CHANNEL.FAST);
        };
      }
    };

    this._clientCandidatesUnsub = this._signaling.watchCandidates(
      this._roomId, this.myId, 'host',
      candidate => {
        this._clientPendingCandidates.push(candidate);
        this._flushClientCandidates();
      },
    );

    let lastOfferId = null;
    this._clientOfferUnsub = this._signaling.watchOffer(
      this._roomId, this.myId,
      async ({ type, sdp, offerId, fromId }) => {
        if (offerId && offerId === lastOfferId) return;
        lastOfferId = offerId ?? null;

        if (fromId) this._hostId = fromId;

        try {
          await pc.setRemoteDescription({ type, sdp });
          await this._flushClientCandidates();

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await this._signaling.sendAnswer(this._roomId, this.myId, {
            type: answer.type,
            sdp: answer.sdp,
            offerId,
          });
          console.log('[Network] answer sent to host');
        } catch (err) {
          console.error('[Network] error processing offer:', err);
          settle(err);
        }
      },
    );
  }

  async _flushClientCandidates() {
    if (!this._clientPc?.remoteDescription) return;
    while (this._clientPendingCandidates.length) {
      const init = this._clientPendingCandidates.shift();
      if (!init?.candidate) continue;
      const patched = { ...init };
      if (patched.sdpMLineIndex == null && patched.sdpMid == null) patched.sdpMLineIndex = 0;
      try {
        await this._clientPc.addIceCandidate(patched);
      } catch (e) {
        console.error('[Network] addIceCandidate error:', e);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Shared internals
  // ---------------------------------------------------------------------------

  _createPC() {
    return new RTCPeerConnection({ iceServers: this._iceServers });
  }

  _flushCandidates(pc, queue) {
    if (!pc.remoteDescription) return;
    while (queue.length) {
      const init = queue.shift();
      if (!init?.candidate) continue;
      const patched = { ...init };
      if (patched.sdpMLineIndex == null && patched.sdpMid == null) patched.sdpMLineIndex = 0;
      pc.addIceCandidate(patched).catch(e => console.error('[Network] addIceCandidate error:', e));
    }
  }
}
