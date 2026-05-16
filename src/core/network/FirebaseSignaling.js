/**
 * Firebase Realtime Database signaling layer for WeedJS WebRTC networking.
 *
 * Handles peer discovery, host election, and encrypted SDP/ICE exchange.
 * Firebase is loaded from the official CDN (no npm install required).
 */

import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import {
  getDatabase,
  ref,
  set,
  update,
  push,
  remove,
  get,
  onChildAdded,
  onChildRemoved,
  onValue,
  runTransaction,
  onDisconnect,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js';
import { deriveRoomKey, encryptVal, decryptVal } from './CryptoUtils.js';

export class FirebaseSignaling {
  /**
   * @param {object} firebaseConfig - Firebase project config object (apiKey, authDomain, databaseURL, …)
   */
  constructor(firebaseConfig) {
    this.app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    this.db = getDatabase(this.app);
    this.roomId = null;
    this.roomKey = null;
  }

  // ---------------------------------------------------------------------------
  // Room lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Writes presence for this peer and derives the room encryption key.
   * Must be called before any other room-scoped method.
   * @param {string} roomId
   * @param {string} myId
   */
  async enterRoom(roomId, myId) {
    this.roomId = roomId;
    this.roomKey = await deriveRoomKey(roomId);
    await this._registerPresence(roomId, myId);
    await this._touchRoomMeta(roomId);
  }

  async _registerPresence(roomId, myId) {
    const presRef = ref(this.db, `rooms/${roomId}/presence/${myId}`);
    await set(presRef, true);
    onDisconnect(presRef).remove();
  }

  async _touchRoomMeta(roomId) {
    const roundedNow = Math.floor(Date.now() / 300_000) * 300_000;
    const metaRef = ref(this.db, `rooms/${roomId}/meta`);
    const snap = await get(metaRef);
    if (!snap.exists()) {
      await set(metaRef, { date_created: roundedNow, last_use: roundedNow });
    } else {
      await update(metaRef, { last_use: roundedNow });
    }
  }

  /**
   * Attempts to claim the host role via a Firebase transaction.
   * The first peer to call this wins; subsequent peers fail.
   * Stale locks (host left without cleanup) are automatically cleared.
   * @param {string} roomId
   * @param {string} myId
   * @returns {Promise<boolean>} true if this peer is now host
   */
  async claimHost(roomId, myId) {
    const lockRef = ref(this.db, `rooms/${roomId}/callerClaimed`);
    const [lockSnap, presSnap] = await Promise.all([
      get(lockRef),
      get(ref(this.db, `rooms/${roomId}/presence`)),
    ]);

    const lockedById = lockSnap.val();
    const presence = presSnap.val() || {};

    if (lockedById && !presence[lockedById]) {
      console.log(`[Network] stale host lock (${lockedById}), clearing room state...`);
      await Promise.all([
        remove(lockRef),
        remove(ref(this.db, `rooms/${roomId}/connections`)),
      ]);
    }

    if (lockedById === myId) {
      onDisconnect(lockRef).remove();
      onDisconnect(ref(this.db, `rooms/${roomId}/connections`)).remove();
      return true;
    }

    const tx = await runTransaction(lockRef, current => {
      if (current === null) return myId;
      return undefined;
    });

    if (tx.committed) {
      onDisconnect(lockRef).remove();
      onDisconnect(ref(this.db, `rooms/${roomId}/connections`)).remove();
    }

    return tx.committed;
  }

  /**
   * Returns the current host's peer ID, or null if no host is present.
   * @param {string} roomId
   * @returns {Promise<string|null>}
   */
  async getHostId(roomId) {
    const snap = await get(ref(this.db, `rooms/${roomId}/callerClaimed`));
    return snap.exists() ? snap.val() : null;
  }

  /**
   * Cleans up presence and (if host) the connections tree on intentional leave.
   * @param {string} roomId
   * @param {string} myId
   * @param {boolean} isHost
   */
  async leaveRoom(roomId, myId, isHost) {
    if (!roomId) return;
    const deletes = [remove(ref(this.db, `rooms/${roomId}/presence/${myId}`))];
    if (isHost) {
      deletes.push(
        remove(ref(this.db, `rooms/${roomId}/callerClaimed`)),
        remove(ref(this.db, `rooms/${roomId}/connections`)),
      );
    } else {
      deletes.push(remove(ref(this.db, `rooms/${roomId}/connections/${myId}`)));
    }
    await Promise.all(deletes);
  }

  // ---------------------------------------------------------------------------
  // Presence watchers
  // ---------------------------------------------------------------------------

  /**
   * @param {string} roomId
   * @param {function(string): void} onAdded - called with peerId for each new presence entry
   * @returns {function} unsubscribe
   */
  watchPresenceAdded(roomId, onAdded) {
    return onChildAdded(ref(this.db, `rooms/${roomId}/presence`), snap => onAdded(snap.key));
  }

  /**
   * @param {string} roomId
   * @param {function(string): void} onRemoved - called with peerId when a peer leaves
   * @returns {function} unsubscribe
   */
  watchPresenceRemoved(roomId, onRemoved) {
    return onChildRemoved(ref(this.db, `rooms/${roomId}/presence`), snap => onRemoved(snap.key));
  }

  // ---------------------------------------------------------------------------
  // Offer / Answer
  // ---------------------------------------------------------------------------

  async sendOffer(roomId, clientId, payload) {
    const enc = await this._encrypt(payload);
    return set(ref(this.db, `rooms/${roomId}/connections/${clientId}/offer`), enc);
  }

  /**
   * @param {string} roomId
   * @param {string} clientId
   * @param {function(object): void} onOffer
   * @returns {function} unsubscribe
   */
  watchOffer(roomId, clientId, onOffer) {
    return onValue(ref(this.db, `rooms/${roomId}/connections/${clientId}/offer`), async snap => {
      if (!snap.exists()) return;
      try {
        onOffer(await this._decrypt(snap.val()));
      } catch (e) {
        console.warn('[Network] could not decrypt offer:', e);
      }
    });
  }

  async sendAnswer(roomId, clientId, payload) {
    const enc = await this._encrypt(payload);
    return set(ref(this.db, `rooms/${roomId}/connections/${clientId}/answer`), enc);
  }

  async clearAnswer(roomId, clientId) {
    return remove(ref(this.db, `rooms/${roomId}/connections/${clientId}/answer`));
  }

  /**
   * @param {string} roomId
   * @param {string} clientId
   * @param {function(object): void} onAnswer
   * @returns {function} unsubscribe
   */
  watchAnswer(roomId, clientId, onAnswer) {
    return onValue(ref(this.db, `rooms/${roomId}/connections/${clientId}/answer`), async snap => {
      if (!snap.exists()) return;
      try {
        onAnswer(await this._decrypt(snap.val()));
      } catch (e) {
        console.warn(`[Network] could not decrypt answer from ${clientId}:`, e);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // ICE candidates
  // ---------------------------------------------------------------------------

  async sendCandidate(roomId, clientId, payload) {
    const enc = await this._encrypt(payload);
    return push(ref(this.db, `rooms/${roomId}/connections/${clientId}/candidates`), enc);
  }

  /**
   * @param {string} roomId
   * @param {string} clientId - path key (the peer whose candidates are written here)
   * @param {'host'|'client'} expectedFrom - filter by sender role
   * @param {function(object): void} onCandidate
   * @returns {function} unsubscribe
   */
  watchCandidates(roomId, clientId, expectedFrom, onCandidate) {
    return onChildAdded(
      ref(this.db, `rooms/${roomId}/connections/${clientId}/candidates`),
      async snap => {
        let data;
        try {
          data = await this._decrypt(snap.val());
        } catch (e) {
          console.warn('[Network] could not decrypt ICE candidate:', e);
          return;
        }
        if (data.from !== expectedFrom) return;
        onCandidate(data.candidate);
      },
    );
  }

  async clearCandidates(roomId, clientId) {
    return remove(ref(this.db, `rooms/${roomId}/connections/${clientId}/candidates`));
  }

  // ---------------------------------------------------------------------------
  // Crypto helpers
  // ---------------------------------------------------------------------------

  _assertRoomKey() {
    if (!this.roomKey) throw new Error('[Network] FirebaseSignaling: enterRoom must be called first');
  }

  async _encrypt(value) {
    this._assertRoomKey();
    return encryptVal(this.roomKey, value);
  }

  async _decrypt(value) {
    this._assertRoomKey();
    return decryptVal(this.roomKey, value);
  }
}
