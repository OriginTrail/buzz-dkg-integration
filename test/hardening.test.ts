import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';
import { loadConfig, normalizePubkey, parseBindings } from '../src/config.ts';
import { classify } from '../src/triggers/detect.ts';
import { questionTerms, MAX_TERMS } from '../src/ask/grounded.ts';
import { kaNameForDigest } from '../src/distill/deterministic.ts';
import { Daemon } from '../src/daemon.ts';
import type { DaemonConfig, NostrEvent } from '../src/types.ts';
import { MockDkg, MockRelay, hexId, makeEvent } from './helpers.ts';
import { thread } from './helpers.ts';
import { sourceSetDigest, snapshotSourceSet } from '../src/distill/deterministic.ts';

const servicePubkey = hexId('service-pubkey');
const promoter = hexId('promoter');

// ── config: budget + promoter validation (review #12, #22) ───────────────────

describe('config hardening', () => {
  it('rejects a non-numeric publish budget (fails closed, not open)', () => {
    expect(() =>
      loadConfig({ BDI_DKG_TOKEN: 'x', BDI_MAX_PUBLISHES_PER_DAY: 'unlimited' } as never),
    ).toThrow(/BDI_MAX_PUBLISHES_PER_DAY/);
  });

  it('normalizes a hex promoter pubkey and decodes an npub', () => {
    const hex = 'ab'.repeat(32);
    expect(normalizePubkey(hex.toUpperCase(), 'x')).toBe(hex);
    expect(normalizePubkey(nip19.npubEncode(hex), 'x')).toBe(hex);
  });

  it('fails fast on a promoter that is neither hex nor npub', () => {
    const raw = JSON.stringify([{ channelId: 'c', contextGraphId: 'g', promoters: ['not-a-key'] }]);
    expect(() => parseBindings(raw)).toThrow(/not a 64-hex pubkey or npub/);
  });
});

// ── triggers: question cap + bare-distill guard (review #6, nit) ──────────────

describe('trigger classification hardening', () => {
  const opts = { servicePubkey, mentionHandle: 'dkg' };

  it('drops an over-length ask instead of building a giant SPARQL filter', () => {
    const huge = makeEvent({
      kind: 9,
      content: `@dkg ask ${'word '.repeat(400)}`,
      tags: [
        ['h', 'chan'],
        ['p', servicePubkey],
      ],
    });
    expect(classify(huge, opts)).toBeNull();
  });

  it('ignores a bare "@dkg distill" with no referenced thread', () => {
    const bare = makeEvent({
      kind: 9,
      content: '@dkg distill',
      tags: [
        ['h', 'chan'],
        ['p', servicePubkey],
      ],
    });
    expect(classify(bare, opts)).toBeNull();
  });
});

describe('grounded retrieval bounds', () => {
  it('caps the term set that drives O(n^2) pair building', () => {
    const q = Array.from({ length: 40 }, (_, i) => `term${i}`).join(' ');
    expect(questionTerms(q)).toHaveLength(MAX_TERMS);
  });
});

// ── daemon: §6.5 digest recheck, ask replay-safety, publish recovery ─────────

function setup(overrides: Partial<DaemonConfig> = {}) {
  const relay = new MockRelay(servicePubkey);
  const dkg = new MockDkg();
  const config: DaemonConfig = {
    relayHttpUrl: 'http://mock',
    relayWsUrl: 'ws://mock',
    serviceSecretKeyHex: '11'.repeat(32),
    mentionHandle: 'dkg',
    dkgApiUrl: 'http://mock',
    dkgToken: 'mock',
    approvalEmoji: '✅',
    publishMode: 'devnet',
    maxPublishesPerDay: 5,
    dbPath: ':memory:',
    bindings: [{ channelId: 'chan', contextGraphId: 'devnet-test', promoters: [promoter] }],
    ...overrides,
  };
  const daemon = new Daemon(config, { relay: relay.asRelay(), dkg: dkg.asDkg() });
  return { daemon, relay, dkg };
}

function pinnedThread(relay: MockRelay) {
  const events = thread('chan', ['Q: store backend?', 'DECISION: oxigraph-server']);
  const pin = makeEvent({
    kind: 40004,
    tags: [
      ['h', 'chan'],
      ['e', events[0]!.id],
    ],
  });
  relay.ingest(...events, pin);
  const digest = sourceSetDigest(snapshotSourceSet([...events], pin, servicePubkey));
  return { pin, digest };
}

async function run(daemon: Daemon, ...events: NostrEvent[]) {
  for (const e of events) daemon.enqueue(e);
  await daemon.drain();
}

describe('daemon approval hardening (review #14)', () => {
  it('§6.5 rejects when the shared SWM digest no longer matches the approved digest', async () => {
    const { daemon, relay, dkg } = setup();
    const { pin, digest } = pinnedThread(relay);
    await daemon.start();
    await run(daemon, pin);
    const receiptId = relay.sent[0]!.eventId;
    const kaName = kaNameForDigest(digest);

    // Tamper the shared graph's stored digest AFTER the receipt — descriptor
    // state stays 'promoted'/SWM, so only the content re-check can catch it.
    const q = dkg.kas.get(kaName)!.quads.find((x) => x.predicate.includes('sourceSetDigest'))!;
    q.object = JSON.stringify('deadbeef'.repeat(8));

    const approval = makeEvent({
      kind: 7,
      pubkey: promoter,
      content: '✅',
      tags: [['e', receiptId]],
    });
    relay.ingest(approval);
    await run(daemon, approval);

    expect(dkg.kas.get(kaName)!.publishes).toBe(0);
    expect(daemon.registry.approvalOutcome(approval.id)?.outcome).toBe('rejected');
    expect(daemon.registry.approvalOutcome(approval.id)).toBeTruthy();
  });
});

describe('daemon ask replay-safety (review #6)', () => {
  it('an ask that throws is resolved (not left pending) so it never replays on boot', async () => {
    const { daemon, relay, dkg } = setup();
    await daemon.start();
    const ask = makeEvent({
      kind: 9,
      content: '@dkg ask what did we decide?',
      tags: [
        ['h', 'chan'],
        ['p', servicePubkey],
      ],
    });
    relay.ingest(ask);
    // Force the retrieval path to throw.
    dkg.query = (async () => {
      throw new Error('node 500 (simulated)');
    }) as never;
    await run(daemon, ask);
    // No pending ask remains → recover() will not replay it.
    expect(daemon.registry.pendingAsks()).toHaveLength(0);
  });
});

describe('daemon publish crash-window recovery (review #11)', () => {
  it('resumes a "publishing" op via descriptor read-back without re-publishing', async () => {
    const { daemon, relay, dkg } = setup();
    const { pin, digest } = pinnedThread(relay);
    await daemon.start();
    await run(daemon, pin);
    const receiptId = relay.sent[0]!.eventId;
    const kaName = kaNameForDigest(digest);
    const op = daemon.registry.opByReceipt(receiptId)!;

    // Simulate: publish() succeeded on the node, then the process died BEFORE
    // persisting 'published'. Reserve intent + stamp the node as published.
    const approval = makeEvent({
      kind: 7,
      pubkey: promoter,
      content: '✅',
      tags: [['e', receiptId]],
    });
    relay.ingest(approval);
    daemon.registry.transition(op.id, 'publishing', { consumed_approval_id: approval.id });
    dkg.kas.get(kaName)!.state = 'published';

    const sentBefore = relay.sent.length;
    await daemon.recover();

    expect(dkg.kas.get(kaName)!.publishes).toBe(0); // never re-published
    expect(daemon.registry.opByTrigger(pin.id)!.state).toBe('vm_receipted');
    expect(relay.sent.length).toBe(sentBefore + 1); // one VM receipt
    expect(relay.sent.at(-1)!.content).toContain('UAL:');
  });
});

describe('daemon cursor hardening (review #17)', () => {
  it('clamps a far-future created_at so the catch-up cursor cannot be poisoned', async () => {
    const { daemon, relay } = setup();
    const future = makeEvent({
      kind: 9,
      content: 'just a normal message',
      created_at: Math.floor(Date.now() / 1000) + 86_400,
      tags: [['h', 'chan']],
    });
    relay.ingest(future);
    await run(daemon, future);
    expect(daemon.registry.cursor).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 300);
  });
});
