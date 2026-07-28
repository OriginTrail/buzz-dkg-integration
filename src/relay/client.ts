import WebSocket from 'ws';
import { createHash } from 'node:crypto';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { logger } from '../log.ts';
import type { NostrEvent } from '../types.ts';

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));

/** Per-request deadline for the relay HTTP bridge. */
const RELAY_TIMEOUT_MS = 15_000;

export interface RelayClientOptions {
  httpUrl: string;
  wsUrl: string;
  secretKeyHex: string;
  /** called for every live event on any subscription */
  onEvent?: (event: NostrEvent) => void;
  onReconnect?: () => void;
}

interface EventTemplate {
  kind: number;
  tags: string[][];
  content: string;
  created_at?: number;
}

/**
 * Buzz relay client (Gate A/B-verified surfaces only):
 *  - reads/writes over the NIP-98-authenticated HTTP bridge (POST /events|/query)
 *  - live subscriptions over WebSocket with NIP-42 auth (relay proactively
 *    sends the AUTH challenge on connect — buzz-relay connection.rs)
 *  - reconnect with exponential backoff; subscriptions re-established on
 *    reconnect (the daemon replays missed events via cursor-based /query).
 */
export class RelayClient {
  readonly pubkey: string;
  #sk: Uint8Array;
  #http: string;
  #ws: string;
  #sock: WebSocket | null = null;
  #subs = new Map<string, unknown[]>();
  #backoffMs = 1000;
  #closed = false;
  #opts: RelayClientOptions;

  constructor(opts: RelayClientOptions) {
    this.#opts = opts;
    this.#sk = hexToBytes(opts.secretKeyHex);
    this.pubkey = getPublicKey(this.#sk);
    this.#http = opts.httpUrl.replace(/\/$/, '');
    this.#ws = opts.wsUrl;
  }

  sign(tmpl: EventTemplate): NostrEvent {
    return finalizeEvent(
      { created_at: Math.floor(Date.now() / 1000), ...tmpl },
      this.#sk,
    ) as NostrEvent;
  }

  /**
   * NIP-98 auth header. The relay keeps a replay cache of auth-event ids, and
   * two identical same-second requests collide (observed live in Gate B); a
   * random nonce tag makes every auth event unique WITHOUT skewing
   * created_at — a monotonic bump drifts out of the relay's ±60s freshness
   * window under bursts (observed live in the Gate C acceptance run).
   */
  authHeader(url: string, method: string, payload?: unknown): string {
    const now = Math.floor(Date.now() / 1000);
    const tags: string[][] = [
      ['u', url],
      ['method', method.toUpperCase()],
      [
        'nonce',
        createHash('sha256')
          .update(`${Math.random()}${process.hrtime.bigint()}`)
          .digest('hex')
          .slice(0, 16),
      ],
    ];
    if (payload !== undefined) {
      tags.push([
        'payload',
        createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex'),
      ]);
    }
    const event = finalizeEvent({ kind: 27235, created_at: now, tags, content: '' }, this.#sk);
    return `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`;
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.#http}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: this.authHeader(url, 'post', body),
        },
        body: JSON.stringify(body),
        // Bound every relay call: events are serialized through one queue, so a
        // single hung socket would otherwise stall all channels for undici's
        // ~300s default and head-of-line-block captures/approvals.
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') {
        throw new Error(`buzz ${path} timed out after ${RELAY_TIMEOUT_MS}ms`);
      }
      throw err;
    }
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(`buzz ${path} ${res.status}: ${text.slice(0, 300)}`) as Error & {
        status?: number;
        body?: unknown;
      };
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json as T;
  }

  /** Publish a signed event; returns the relay write contract {event_id, accepted, message}. */
  async publish(
    tmpl: EventTemplate,
  ): Promise<{ event: NostrEvent; eventId: string; accepted: boolean }> {
    const event = this.sign(tmpl);
    const res = await this.#post<{ event_id: string; accepted: boolean; message?: string }>(
      '/events',
      event,
    );
    if (!res.accepted) throw new Error(`relay rejected event: ${res.message ?? 'no message'}`);
    return { event, eventId: res.event_id, accepted: res.accepted };
  }

  /** Query stored events; body is a raw array of Nostr filters. */
  query(filters: unknown[]): Promise<NostrEvent[]> {
    return this.#post<NostrEvent[]>('/query', filters);
  }

  /** kind 9 message; NIP-10 markers when replying. */
  async sendMessage(
    channelId: string,
    content: string,
    opts: { replyTo?: string; root?: string; mentions?: string[] } = {},
  ): Promise<{ eventId: string }> {
    const tags: string[][] = [['h', channelId]];
    if (opts.root && opts.replyTo && opts.root !== opts.replyTo) {
      tags.push(['e', opts.root, '', 'root'], ['e', opts.replyTo, '', 'reply']);
    } else if (opts.replyTo) {
      tags.push(['e', opts.replyTo, '', 'reply']);
    }
    for (const p of opts.mentions ?? []) tags.push(['p', p]);
    const { eventId } = await this.publish({ kind: 9, tags, content });
    return { eventId };
  }

  /** Thread fetch: root by id + descendants via #e/#h; deterministic order. */
  async fetchThread(channelId: string, rootId: string): Promise<NostrEvent[]> {
    const roots = await this.query([{ ids: [rootId] }]);
    const replies = await this.query([
      { kinds: [9, 40002, 40003], '#h': [channelId], '#e': [rootId] },
    ]);
    const seen = new Set<string>();
    const events = [...roots, ...replies].filter((e) =>
      seen.has(e.id) ? false : (seen.add(e.id), true),
    );
    events.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    return events;
  }

  // ── live subscription (WS + NIP-42) ─────────────────────────────────────────

  subscribe(subId: string, filters: unknown[]): void {
    this.#subs.set(subId, filters);
    if (this.#sock?.readyState === WebSocket.OPEN) {
      this.#sock.send(JSON.stringify(['REQ', subId, ...filters]));
    }
  }

  connect(): void {
    if (this.#closed) return;
    const sock = new WebSocket(this.#ws);
    this.#sock = sock;
    sock.on('open', () => {
      logger.info('relay ws connected', { url: this.#ws });
      this.#backoffMs = 1000;
    });
    sock.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      const [type] = msg;
      if (type === 'AUTH') {
        const challenge = msg[1];
        const auth = this.sign({
          kind: 22242,
          tags: [
            ['relay', this.#ws],
            ['challenge', challenge],
          ],
          content: '',
        });
        sock.send(JSON.stringify(['AUTH', auth]));
        // (re)establish subscriptions after auth
        for (const [subId, filters] of this.#subs) {
          sock.send(JSON.stringify(['REQ', subId, ...filters]));
        }
        this.#opts.onReconnect?.();
      } else if (type === 'EVENT') {
        const event = msg[2] as NostrEvent;
        this.#opts.onEvent?.(event);
      } else if (type === 'CLOSED' || type === 'NOTICE') {
        logger.warn('relay control message', { msg });
      }
    });
    sock.on('close', () => this.#scheduleReconnect('close'));
    sock.on('error', (err) => {
      logger.warn('relay ws error', { error: String(err) });
      sock.close();
    });
  }

  #scheduleReconnect(why: string): void {
    if (this.#closed) return;
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, 30_000);
    logger.warn('relay ws disconnected; reconnecting', { why, delayMs: delay });
    // Deliberately NOT unref'd: during relay downtime this timer can be the
    // process's only active handle — an unref'd timer let Node exit cleanly
    // mid-outage (observed live: daemon silently gone after a relay restart).
    setTimeout(() => this.connect(), delay);
  }

  close(): void {
    this.#closed = true;
    this.#sock?.close();
  }
}
