// roomSignaling.js - the room protocol: presence, host election, encrypted SDP/ICE.
//
// Ported from the `networking` branch's FirebaseSignaling, now over any store
// (signalingStore.js), so Firebase and localStorage share one protocol.
//
// Tree (every SDP / ICE value is { iv, ct }, AES-GCM with the room key):
//   rooms/{code}/meta                         { created, lastUse, protocol }
//   rooms/{code}/host                         peerId of the host (the lock)
//   rooms/{code}/presence/{peerId}            { joinedAt }
//   rooms/{code}/connections/{clientId}/offer      host → client
//   rooms/{code}/connections/{clientId}/answer     client → host
//   rooms/{code}/connections/{clientId}/candidates/{key}  both; { from: 'host'|'client', candidate }

import { deriveRoomKey, encryptValue, decryptValue } from './roomCrypto.js';
import { NET_PROTOCOL_VERSION } from './netProtocol.js';

export class RoomSignaling {
  /** @param {object} store - FirebaseStore, LocalStorageStore, or anything with the same interface */
  constructor(store) {
    this.store = store;
    this.code = null;
    this.key = null;
  }

  _room(sub = '') {
    return sub ? `rooms/${this.code}/${sub}` : `rooms/${this.code}`;
  }

  /**
   * Derive the room key and write this peer's presence.
   * @param {string} code - normalized room code
   * @param {string} peerId
   */
  async enter(code, peerId) {
    if (this.store.connect) await this.store.connect();
    this.code = code;
    this.key = await deriveRoomKey(code);
    await this.store.set(this._room(`presence/${peerId}`), { joinedAt: Date.now() });
    await this.store.removeOnDisconnect(this._room(`presence/${peerId}`));
    const now = Date.now();
    const meta = await this.store.get(this._room('meta'));
    if (!meta)
      await this.store.set(this._room('meta'), {
        created: now,
        lastUse: now,
        protocol: NET_PROTOCOL_VERSION,
      });
    else await this.store.update(this._room('meta'), { lastUse: now });
  }

  /**
   * Take the host lock. A lock whose holder has no presence is stale: it is cleared
   * together with the old connections. Resolves true when this peer is the host.
   */
  async claimHost(peerId) {
    const [holder, presence] = await Promise.all([
      this.store.get(this._room('host')),
      this.store.get(this._room('presence')),
    ]);
    if (holder && !(presence && presence[holder])) {
      await Promise.all([
        this.store.remove(this._room('host')),
        this.store.remove(this._room('connections')),
      ]);
    }
    let committed = holder === peerId;
    if (!committed) {
      const tx = await this.store.transaction(this._room('host'), (current) =>
        current ? undefined : peerId
      );
      committed = tx.committed;
    }
    if (committed) {
      await this.store.removeOnDisconnect(this._room('host'));
      await this.store.removeOnDisconnect(this._room('connections'));
    }
    return committed;
  }

  /** The host's peerId when a host holds the lock and is present, else null. */
  async liveHost() {
    const [holder, presence] = await Promise.all([
      this.store.get(this._room('host')),
      this.store.get(this._room('presence')),
    ]);
    return holder && presence && presence[holder] ? holder : null;
  }

  async leave(peerId, isHost) {
    if (!this.code) return;
    const removals = [this.store.remove(this._room(`presence/${peerId}`))];
    if (isHost) {
      removals.push(
        this.store.remove(this._room('host')),
        this.store.remove(this._room('connections'))
      );
    } else {
      removals.push(this.store.remove(this._room(`connections/${peerId}`)));
    }
    await Promise.all(removals);
  }

  watchPresenceAdded(cb) {
    return this.store.onChildAdded(this._room('presence'), (peerId) => cb(peerId));
  }

  watchPresenceRemoved(cb) {
    return this.store.onChildRemoved(this._room('presence'), (peerId) => cb(peerId));
  }

  // --- offer / answer ---------------------------------------------------------

  async sendOffer(clientId, payload) {
    await this.store.set(
      this._room(`connections/${clientId}/offer`),
      await encryptValue(this.key, payload)
    );
  }

  watchOffer(clientId, cb) {
    return this._watchEncrypted(`connections/${clientId}/offer`, cb, 'offer');
  }

  async sendAnswer(clientId, payload) {
    await this.store.set(
      this._room(`connections/${clientId}/answer`),
      await encryptValue(this.key, payload)
    );
  }

  clearAnswer(clientId) {
    return this.store.remove(this._room(`connections/${clientId}/answer`));
  }

  watchAnswer(clientId, cb) {
    return this._watchEncrypted(`connections/${clientId}/answer`, cb, 'answer');
  }

  // --- ICE --------------------------------------------------------------------

  async sendCandidate(clientId, from, candidate) {
    await this.store.push(
      this._room(`connections/${clientId}/candidates`),
      await encryptValue(this.key, { from, candidate })
    );
  }

  /** cb(candidate) for the candidates written by `expectedFrom` ('host' or 'client'). */
  watchCandidates(clientId, expectedFrom, cb) {
    return this.store.onChildAdded(
      this._room(`connections/${clientId}/candidates`),
      async (_key, value) => {
        if (!value) return;
        let data;
        try {
          data = await decryptValue(this.key, value);
        } catch {
          return; // another room key, or tampered
        }
        if (data && data.from === expectedFrom) cb(data.candidate);
      }
    );
  }

  clearConnection(clientId) {
    return this.store.remove(this._room(`connections/${clientId}`));
  }

  _watchEncrypted(sub, cb, what) {
    return this.store.onValue(this._room(sub), async (value) => {
      if (!value) return;
      try {
        cb(await decryptValue(this.key, value));
      } catch (e) {
        console.warn(`[Network] could not decrypt ${what}:`, e);
      }
    });
  }
}
