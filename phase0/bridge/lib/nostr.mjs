// Minimal Buzz relay client for the Phase 0 spike (isolated stack only).
// Uses the two Gate-A-verified surfaces:
//  - HTTP bridge POST /events | /query with NIP-98 auth (buzz-cli's transport)
//  - raw Nostr event construction per NOSTR.md recipes @ dd222a5
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { getToken } from 'nostr-tools/nip98';

const hexToBytes = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));

export class BuzzClient {
  constructor({ baseUrl, secretKeyHex }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.sk = hexToBytes(secretKeyHex);
    this.pubkey = getPublicKey(this.sk);
  }

  sign(tmpl) {
    return finalizeEvent({ created_at: Math.floor(Date.now() / 1000), ...tmpl }, this.sk);
  }

  async #authHeader(url, method, payload) {
    return getToken(url, method, (e) => finalizeEvent(e, this.sk), true, payload);
  }

  async #post(path, body) {
    const url = `${this.baseUrl}${path}`;
    const auth = await this.#authHeader(url, 'post', body);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`buzz ${path} ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  /** Publish a signed event via the HTTP bridge. Returns {event_id, accepted, message}. */
  async publish(tmpl) {
    const event = this.sign(tmpl);
    const res = await this.#post('/events', event);
    return { event, res };
  }

  /** Query via the HTTP bridge. Body is a raw array of Nostr filters. */
  async query(filters) {
    return this.#post('/query', filters);
  }

  // ── Buzz operations (kinds per docs/audit/buzz-audit.md) ──────────────────
  async createChannel(name) {
    return this.publish({ kind: 9007, tags: [['name', name]], content: '' });
  }

  /** Find channel UUID by name from relay-signed kind 39000 metadata state. */
  async findChannel(name) {
    const events = await this.query([{ kinds: [39000] }]);
    for (const ev of events) {
      const d = ev.tags.find((t) => t[0] === 'd')?.[1];
      const n = ev.tags.find((t) => t[0] === 'name')?.[1];
      if (n === name && d) return d;
    }
    return null;
  }

  /** kind 9000 add-user (owner/admin, or self-add on open channels). */
  async addMember(channelId, memberPubkey, role) {
    const tags = [['h', channelId], ['p', memberPubkey]];
    if (role) tags[1].push(role);
    return this.publish({ kind: 9000, tags, content: '' });
  }

  /** kind 9 chat message; replyTo adds NIP-10 root/reply markers. */
  async sendMessage(channelId, content, { replyTo, root, mentions = [] } = {}) {
    const tags = [['h', channelId]];
    if (root && replyTo && root !== replyTo) {
      tags.push(['e', root, '', 'root'], ['e', replyTo, '', 'reply']);
    } else if (replyTo) {
      tags.push(['e', replyTo, '', 'reply']);
    }
    for (const p of mentions) tags.push(['p', p]);
    return this.publish({ kind: 9, tags, content });
  }

  /** kind 40004 pin. No SDK builder exists @ dd222a5; convention: e=target, h=channel. */
  async pinMessage(channelId, targetEventId) {
    return this.publish({ kind: 40004, tags: [['h', channelId], ['e', targetEventId]], content: '' });
  }

  /** kind 7 reaction; relay derives channel from the target via the e tag. */
  async react(targetEventId, emoji) {
    return this.publish({ kind: 7, tags: [['e', targetEventId]], content: emoji });
  }

  /** Fetch a thread: root by id + descendants by #e (+#h). */
  async fetchThread(channelId, rootId) {
    const [roots, replies] = await Promise.all([
      this.query([{ ids: [rootId] }]),
      this.query([{ kinds: [9, 40002, 40003], '#h': [channelId], '#e': [rootId] }]),
    ]);
    const all = [...roots, ...replies];
    const seen = new Set();
    const events = all.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
    events.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    return events;
  }
}
