import { createHash } from 'node:crypto';
import type { NostrEvent, Quad } from '../src/types.ts';
import type { RelayClient } from '../src/relay/client.ts';
import type { DkgClient } from '../src/dkg/client.ts';

export const hexId = (seed: string): string => createHash('sha256').update(seed).digest('hex');

let ts = 1_785_000_000;
export const nextTs = (): number => ++ts;

export function makeEvent(partial: Partial<NostrEvent> & { kind: number }): NostrEvent {
  const created_at = partial.created_at ?? nextTs();
  const id =
    partial.id ?? hexId(`${partial.kind}:${created_at}:${partial.content ?? ''}:${Math.random()}`);
  return {
    id,
    pubkey: partial.pubkey ?? hexId('default-author'),
    created_at,
    kind: partial.kind,
    tags: partial.tags ?? [],
    content: partial.content ?? '',
    sig: partial.sig ?? 'f'.repeat(128),
  };
}

export function thread(channelId: string, contents: string[], authors?: string[]): NostrEvent[] {
  const events: NostrEvent[] = [];
  for (let i = 0; i < contents.length; i++) {
    const root = events[0];
    const tags: string[][] = [['h', channelId]];
    if (root) tags.push(['e', root.id, '', i === 1 ? 'reply' : 'root']);
    events.push(
      makeEvent({
        kind: 9,
        content: contents[i]!,
        pubkey: authors?.[i] ?? hexId(`author-${i % 2}`),
        tags,
      }),
    );
  }
  return events;
}

/** In-memory Buzz relay double: stores events, answers the client surface the daemon uses. */
export class MockRelay {
  pubkey: string;
  events: NostrEvent[] = [];
  sent: { channelId: string; content: string; replyTo?: string; eventId: string }[] = [];
  onEvent: ((e: NostrEvent) => void) | null = null;
  failNextSend: Error | null = null;

  constructor(servicePubkey: string) {
    this.pubkey = servicePubkey;
  }

  ingest(...events: NostrEvent[]): void {
    this.events.push(...events);
  }

  async query(filters: any[]): Promise<NostrEvent[]> {
    const out: NostrEvent[] = [];
    for (const f of filters) {
      for (const e of this.events) {
        if (f.ids && !f.ids.includes(e.id)) continue;
        if (f.kinds && !f.kinds.includes(e.kind)) continue;
        if (f.authors && !f.authors.includes(e.pubkey)) continue;
        if (f['#h'] && !this.matchesChannel(e, f['#h'])) continue;
        if (f['#e'] && !e.tags.some((t) => t[0] === 'e' && f['#e'].includes(t[1]))) continue;
        if (f.since && e.created_at < f.since) continue;
        if (!out.includes(e)) out.push(e);
      }
    }
    return out;
  }

  /** Mirrors buzz-core filter.rs: reactions/deletions match #h via the channel derived from their target. */
  matchesChannel(e: NostrEvent, channels: string[]): boolean {
    if (e.tags.some((t) => t[0] === 'h' && channels.includes(t[1]!))) return true;
    if (e.kind === 7 || e.kind === 5) {
      const target = [...e.tags].reverse().find((t) => t[0] === 'e')?.[1];
      const targetEvent = this.events.find((x) => x.id === target);
      const ch = targetEvent?.tags.find((t) => t[0] === 'h')?.[1];
      return !!ch && channels.includes(ch);
    }
    return false;
  }

  async fetchThread(channelId: string, rootId: string): Promise<NostrEvent[]> {
    const roots = await this.query([{ ids: [rootId] }]);
    const replies = await this.query([
      { kinds: [9, 40002, 40003], '#h': [channelId], '#e': [rootId] },
    ]);
    const seen = new Set<string>();
    const all = [...roots, ...replies].filter((e) =>
      seen.has(e.id) ? false : (seen.add(e.id), true),
    );
    all.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    return all;
  }

  async sendMessage(
    channelId: string,
    content: string,
    opts: { replyTo?: string; root?: string } = {},
  ): Promise<{ eventId: string }> {
    if (this.failNextSend) {
      const err = this.failNextSend;
      this.failNextSend = null;
      throw err;
    }
    const tags: string[][] = [['h', channelId]];
    if (opts.replyTo) tags.push(['e', opts.replyTo, '', 'reply']);
    const event = makeEvent({ kind: 9, content, pubkey: this.pubkey, tags });
    this.events.push(event);
    this.sent.push({ channelId, content, replyTo: opts.replyTo, eventId: event.id });
    return { eventId: event.id };
  }

  subscribe(): void {}
  connect(): void {}
  close(): void {}

  asRelay(): RelayClient {
    return this as unknown as RelayClient;
  }
}

interface KaState {
  quads: Quad[];
  state: 'created' | 'promoted' | 'published';
  writes: number;
  finalizes: number;
  shares: number;
  publishes: number;
}

/** In-memory DKG double with call counting and injectable failures. */
export class MockDkg {
  kas = new Map<string, KaState>();
  chainId = 'evm:31337';
  contextGraphs = ['devnet-test'];
  evidence: { rootUri: string; name: string; description: string; digest: string | null }[] = [];
  failShareOnce: Error | null = null;
  failWriteOnce: Error | null = null;
  failPublishButSucceed = false; // simulates lost publish response (ambiguity)
  queryLog: any[] = [];

  async status() {
    return { version: 'mock', chain: { chainId: this.chainId }, hasIdentity: true };
  }
  async listContextGraphs() {
    return { contextGraphs: this.contextGraphs.map((id) => ({ id })) };
  }
  async contextGraphExists(id: string) {
    return { exists: this.contextGraphs.includes(id) };
  }
  #ka(name: string): KaState {
    let ka = this.kas.get(name);
    if (!ka) {
      ka = { quads: [], state: 'created', writes: 0, finalizes: 0, shares: 0, publishes: 0 };
      this.kas.set(name, ka);
    }
    return ka;
  }
  async write(name: string, _cg: string, quads: Quad[]) {
    if (this.failWriteOnce) {
      const err = this.failWriteOnce;
      this.failWriteOnce = null;
      throw err;
    }
    const ka = this.#ka(name);
    ka.writes++;
    // set semantics like a triple store
    for (const q of quads) {
      if (
        !ka.quads.some(
          (x) => x.subject === q.subject && x.predicate === q.predicate && x.object === q.object,
        )
      ) {
        ka.quads.push(q);
      }
    }
    return { written: quads.length };
  }
  async finalize(name: string, _cg: string) {
    const ka = this.#ka(name);
    ka.finalizes++;
    return {
      assertionUri: `did:dkg:context-graph/mock/assertion/0xmock/${name}`,
      merkleRoot: '0xmock',
      authorAddress: '0xmock',
    };
  }
  async share(name: string, _cg: string) {
    if (this.failShareOnce) {
      const err = this.failShareOnce;
      this.failShareOnce = null;
      throw err;
    }
    const ka = this.#ka(name);
    ka.shares++;
    ka.state = 'promoted';
    return {
      swmShared: true,
      promotedCount: ka.quads.length,
      shareOperationId: 'mock-op',
      publishReady: true,
    };
  }
  async publish(name: string, _cg: string) {
    const ka = this.#ka(name);
    ka.publishes++;
    ka.state = 'published';
    if (this.failPublishButSucceed) throw new Error('socket hang up (simulated lost response)');
    return { status: 'confirmed', ual: `did:dkg:evm:31337/0xmock/${name}`, txHash: '0xtx' };
  }
  async descriptor(name: string, contextGraphId: string) {
    const ka = this.kas.get(name);
    if (!ka) {
      const err = new Error('404') as Error & { status?: number };
      err.status = 404;
      throw err;
    }
    return {
      contextGraphId,
      agentAddress: '0xmock',
      name,
      state: ka.state,
      memoryLayer: ka.state === 'created' ? 'WM' : ka.state === 'promoted' ? 'SWM' : 'VM',
      events: [],
      reservedUal: `did:dkg:evm:31337/0xmock/${name}`,
    };
  }
  async query(opts: { sparql: string; contextGraphId: string; view: string }) {
    this.queryLog.push(opts);
    if (!opts.contextGraphId || !opts.view) throw new Error('unscoped query — contract violation');
    if (/^\s*ASK/i.test(opts.sparql)) {
      // digest ASK: true when any promoted KA carries the digest quad
      const m = opts.sparql.match(/sourceSetDigest> "([0-9a-f]{64})"/);
      if (m) {
        const found = [...this.kas.values()].some(
          (ka) => ka.state !== 'created' && ka.quads.some((q) => q.object === JSON.stringify(m[1])),
        );
        return { result: { bindings: found ? [{ ask: { value: 'true' } }] : [] } };
      }
      // citation ASK: true when the subject exists in evidence or any shared KA
      const s = opts.sparql.match(/ASK \{ <([^>]+)>/)?.[1];
      const known =
        this.evidence.some((e) => e.rootUri === s) ||
        [...this.kas.values()].some(
          (ka) => ka.state !== 'created' && ka.quads.some((q) => q.subject === s),
        );
      return { result: { bindings: known ? [{ ask: { value: 'true' } }] : [] } };
    }
    // subject-scoped read-back SELECT: return the KA quads for that subject
    const subj = opts.sparql.match(/SELECT \?p \?o WHERE \{ <([^>]+)> \?p \?o \}/)?.[1];
    if (subj) {
      const rows: any[] = [];
      for (const ka of this.kas.values()) {
        if (ka.state === 'created') continue;
        for (const q of ka.quads) {
          if (q.subject === subj) rows.push({ p: { value: q.predicate }, o: { value: q.object } });
        }
      }
      return { result: { bindings: rows } };
    }
    // evidence SELECT
    const bindings = this.evidence.map((e) => ({
      root: { value: e.rootUri },
      name: { value: e.name },
      desc: { value: e.description },
      ...(e.digest ? { digest: { value: e.digest } } : {}),
    }));
    return { result: { bindings } };
  }

  asDkg(): DkgClient {
    return this as unknown as DkgClient;
  }
}
