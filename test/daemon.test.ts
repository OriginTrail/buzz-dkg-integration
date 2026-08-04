import { describe, expect, it } from 'vitest';
import { Daemon } from '../src/daemon.ts';
import {
  kaNameForDigest,
  snapshotSourceSet,
  sourceSetDigest,
} from '../src/distill/deterministic.ts';
import type { DaemonConfig, NostrEvent } from '../src/types.ts';
import { MockDkg, MockRelay, hexId, makeEvent, thread } from './helpers.ts';

const servicePubkey = hexId('service-pubkey');
const promoter = hexId('promoter');

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
    pollIntervalS: 0,
    dbPath: ':memory:',
    bindings: [{ channelId: 'chan', contextGraphId: 'devnet-test', promoters: [promoter] }],
    ...overrides,
  };
  const daemon = new Daemon(config, { relay: relay.asRelay(), dkg: dkg.asDkg() });
  return { daemon, relay, dkg, config };
}

function pinnedThread(relay: MockRelay): { events: NostrEvent[]; pin: NostrEvent; digest: string } {
  const events = thread('chan', [
    'Q: store backend?',
    'oxigraph is faster',
    'DECISION: oxigraph-server',
  ]);
  const pin = makeEvent({
    kind: 40004,
    tags: [
      ['h', 'chan'],
      ['e', events[0]!.id],
    ],
  });
  relay.ingest(...events, pin);
  const digest = sourceSetDigest(snapshotSourceSet([...events], pin, servicePubkey));
  return { events, pin, digest };
}

async function process(daemon: Daemon, ...events: NostrEvent[]): Promise<void> {
  for (const e of events) daemon.enqueue(e);
  await daemon.drain();
}

describe('daemon capture flow', () => {
  it('pin trigger → WM→finalize→share → scoped read-back → one receipt', async () => {
    const { daemon, relay, dkg } = setup();
    const { pin, digest } = pinnedThread(relay);
    await process(daemon, pin);

    const kaName = kaNameForDigest(digest);
    const ka = dkg.kas.get(kaName)!;
    expect(ka).toBeDefined();
    expect(ka.state).toBe('promoted');
    expect(ka.writes).toBe(1);
    expect(ka.finalizes).toBe(1);
    expect(ka.shares).toBe(1);
    expect(relay.sent).toHaveLength(1);
    expect(relay.sent[0]!.content).toContain(`source-digest: sha256:${digest}`);
    expect(relay.sent[0]!.content).toContain(`ka: ${kaName}`);
  });

  it('replayed trigger produces no duplicate KA or receipt', async () => {
    const { daemon, relay, dkg } = setup();
    const { pin, digest } = pinnedThread(relay);
    await process(daemon, pin);
    await process(daemon, pin);
    await process(daemon, pin);
    expect(dkg.kas.get(kaNameForDigest(digest))!.writes).toBe(1);
    expect(relay.sent).toHaveLength(1);
  });

  it('@dkg distill mention triggers capture of the mentioned thread', async () => {
    const { daemon, relay, dkg } = setup();
    const events = thread('chan', ['root msg', 'reply msg']);
    relay.ingest(...events);
    const mention = makeEvent({
      kind: 9,
      content: '@dkg distill',
      tags: [
        ['h', 'chan'],
        ['p', servicePubkey],
        ['e', events[0]!.id, '', 'root'],
      ],
    });
    relay.ingest(mention);
    await process(daemon, mention);
    expect(dkg.kas.size).toBe(1);
    expect(relay.sent).toHaveLength(1);
  });

  it('rejects captures in unmapped channels', async () => {
    const { daemon, relay, dkg } = setup();
    const events = thread('other-chan', ['x']);
    const pin = makeEvent({
      kind: 40004,
      tags: [
        ['h', 'other-chan'],
        ['e', events[0]!.id],
      ],
    });
    relay.ingest(...events, pin);
    await process(daemon, pin);
    expect(dkg.kas.size).toBe(0);
    expect(relay.sent).toHaveLength(0);
  });

  it('fails closed when a source event is soft-deleted between trigger and recovery', async () => {
    const { daemon, relay, dkg } = setup();
    const { pin, events } = pinnedThread(relay);
    dkg.failWriteOnce = new Error('ECONNRESET (crash before any external write)');
    await process(daemon, pin); // op parked in 'distilled'
    expect(daemon.registry.opByTrigger(pin.id)?.state).toBe('distilled');
    // NIP-09 soft delete hides one source event from all reads (Buzz is not append-only)
    relay.events = relay.events.filter((e) => e.id !== events[1]!.id);
    await daemon.recover();
    expect(dkg.kas.size).toBe(0);
    expect(relay.sent).toHaveLength(0);
    expect(daemon.registry.opByTrigger(pin.id)?.state).toBe('failed');
    expect(daemon.registry.opByTrigger(pin.id)?.error).toContain('source set changed');
  });
});

describe('daemon crash recovery (§9)', () => {
  it('resumes an op that crashed mid-lifecycle without duplicate writes or receipts', async () => {
    const { daemon, relay, dkg } = setup();
    const { pin, digest } = pinnedThread(relay);
    dkg.failShareOnce = new Error('ECONNRESET (simulated crash during share)');
    await process(daemon, pin); // fails at share; op parked in 'finalized'
    const kaName = kaNameForDigest(digest);
    expect(relay.sent).toHaveLength(0);
    expect(daemon.registry.opByTrigger(pin.id)?.state).toBe('finalized');

    await daemon.recover();
    const ka = dkg.kas.get(kaName)!;
    expect(ka.state).toBe('promoted');
    expect(ka.writes).toBe(1); // no duplicate write
    expect(ka.finalizes).toBe(1); // finalize not re-run (descriptor read-back)
    expect(relay.sent).toHaveLength(1); // exactly one receipt
    expect(daemon.registry.opByTrigger(pin.id)?.state).toBe('receipted');
  });

  it('finds a pre-crash receipt on the relay instead of posting a second one', async () => {
    const { daemon, relay, dkg } = setup();
    const { pin, digest } = pinnedThread(relay);
    await process(daemon, pin);
    expect(relay.sent).toHaveLength(1);

    // Simulate: crash AFTER posting the receipt but BEFORE recording it.
    const op = daemon.registry.opByTrigger(pin.id)!;
    daemon.registry.db
      .prepare("UPDATE ops SET state = 'shared', receipt_event_id = NULL WHERE id = ?")
      .run(op.id);
    await daemon.recover();
    expect(relay.sent).toHaveLength(1); // receipt reused, not re-posted
    const recovered = daemon.registry.opByTrigger(pin.id)!;
    expect(recovered.state).toBe('receipted');
    expect(recovered.receiptEventId).toBe(relay.sent[0]!.eventId);
    expect(dkg.kas.get(kaNameForDigest(digest))!.shares).toBe(1);
  });
});

describe('daemon approval flow (§6)', () => {
  async function captured(publishMode: 'devnet' | 'disabled' | 'mainnet' = 'devnet') {
    const ctx = setup({ publishMode });
    const { pin, digest } = pinnedThread(ctx.relay);
    await ctx.daemon.start(); // uses mocks; also validates CG existence
    await process(ctx.daemon, pin);
    const receiptId = ctx.relay.sent[0]!.eventId;
    return { ...ctx, pin, digest, receiptId };
  }

  it('authorized ✅ on the receipt → publish once → VM receipt with UAL', async () => {
    const { daemon, relay, dkg, receiptId, digest } = await captured();
    const approval = makeEvent({
      kind: 7,
      pubkey: promoter,
      content: '✅',
      tags: [['e', receiptId]],
    });
    relay.ingest(approval);
    await process(daemon, approval);

    const kaName = kaNameForDigest(digest);
    expect(dkg.kas.get(kaName)!.publishes).toBe(1);
    expect(relay.sent).toHaveLength(2);
    expect(relay.sent[1]!.content).toContain(`UAL: did:dkg:evm:31337/0xmock/${kaName}`);
    expect(relay.sent[1]!.content).toContain(`approval-event: ${approval.id}`);

    // replayed approval: consumed exactly once
    await process(daemon, approval);
    expect(dkg.kas.get(kaName)!.publishes).toBe(1);
    expect(relay.sent).toHaveLength(2);
  });

  it('rejects unauthorized reactors', async () => {
    const { daemon, relay, dkg, receiptId } = await captured();
    const approval = makeEvent({
      kind: 7,
      pubkey: hexId('rando'),
      content: '✅',
      tags: [['e', receiptId]],
    });
    relay.ingest(approval);
    await process(daemon, approval);
    expect([...dkg.kas.values()].every((k) => k.publishes === 0)).toBe(true);
    expect(daemon.registry.approvalOutcome(approval.id)?.outcome).toBe('rejected');
  });

  it('ignores non-approval emojis and reactions to non-receipt events', async () => {
    const { daemon, relay, dkg, receiptId, pin } = await captured();
    const thumbs = makeEvent({
      kind: 7,
      pubkey: promoter,
      content: '👍',
      tags: [['e', receiptId]],
    });
    const wrongTarget = makeEvent({
      kind: 7,
      pubkey: promoter,
      content: '✅',
      tags: [['e', pin.id]],
    });
    relay.ingest(thumbs, wrongTarget);
    await process(daemon, thumbs, wrongTarget);
    expect([...dkg.kas.values()].every((k) => k.publishes === 0)).toBe(true);
  });

  it('publishMode=mainnet publishes on base:8453 within the daily budget', async () => {
    const ctx = setup({ publishMode: 'mainnet' });
    ctx.dkg.chainId = 'base:8453';
    const { pin } = pinnedThread(ctx.relay);
    await ctx.daemon.start();
    await process(ctx.daemon, pin);
    const receiptId = ctx.relay.sent[0]!.eventId;
    const approval = makeEvent({
      kind: 7,
      pubkey: promoter,
      content: '✅',
      tags: [['e', receiptId]],
    });
    ctx.relay.ingest(approval);
    await process(ctx.daemon, approval);
    expect([...ctx.dkg.kas.values()].some((k) => k.publishes === 1)).toBe(true);
    expect(ctx.relay.sent[1]!.content).toContain('UAL:');
  });

  it('publishMode=mainnet refuses when the rolling 24h budget is exhausted', async () => {
    const ctx = setup({ publishMode: 'mainnet', maxPublishesPerDay: 0 });
    ctx.dkg.chainId = 'base:8453';
    const { pin } = pinnedThread(ctx.relay);
    await ctx.daemon.start();
    await process(ctx.daemon, pin);
    const receiptId = ctx.relay.sent[0]!.eventId;
    const approval = makeEvent({
      kind: 7,
      pubkey: promoter,
      content: '✅',
      tags: [['e', receiptId]],
    });
    ctx.relay.ingest(approval);
    await process(ctx.daemon, approval);
    expect([...ctx.dkg.kas.values()].every((k) => k.publishes === 0)).toBe(true);
    expect(ctx.daemon.registry.approvalOutcome(approval.id)?.outcome).toBe('rejected');
  });

  it('publishMode=mainnet refuses to start on a non-mainnet chain', async () => {
    const ctx = setup({ publishMode: 'mainnet' }); // MockDkg default chain is evm:31337
    await expect(ctx.daemon.start()).rejects.toThrow(/refusing to start/);
  });

  it('publishMode=disabled recognizes the approval but refuses publication (§6.8)', async () => {
    const { daemon, relay, dkg, receiptId } = await captured('disabled');
    const approval = makeEvent({
      kind: 7,
      pubkey: promoter,
      content: '✅',
      tags: [['e', receiptId]],
    });
    relay.ingest(approval);
    await process(daemon, approval);
    expect([...dkg.kas.values()].every((k) => k.publishes === 0)).toBe(true);
    expect(daemon.registry.approvalOutcome(approval.id)?.outcome).toBe('rejected');
  });

  it('an ambiguous publish (lost/errored response) is recorded unconfirmed, never announced', async () => {
    // The descriptor cannot distinguish a confirmed tx from a tentative one, so
    // a response we can't read as confirmed must NOT be announced as anchored
    // and must NOT be retried blindly (review R1) — it is terminal + budget-counted.
    const { daemon, relay, dkg, receiptId, digest } = await captured();
    dkg.failPublishButSucceed = true; // publish() throws; confirmation unknown
    const approval = makeEvent({
      kind: 7,
      pubkey: promoter,
      content: '✅',
      tags: [['e', receiptId]],
    });
    relay.ingest(approval);
    await process(daemon, approval);
    const kaName = kaNameForDigest(digest);
    expect(dkg.kas.get(kaName)!.publishes).toBe(1); // exactly one attempt, never retried
    const op = daemon.registry.opByTrigger(daemon.registry.opByReceipt(receiptId)!.triggerEventId)!;
    expect(op.state).toBe('publish_unconfirmed');
    expect(op.ual).toBeNull();
    expect(relay.sent).toHaveLength(2);
    expect(relay.sent[1]!.content).not.toContain('UAL:');
    expect(relay.sent[1]!.content).toMatch(/did not return a confirmed result/);
    expect(daemon.registry.countRecentPublishes(24 * 60 * 60 * 1000)).toBe(1); // counts toward budget
  });
});

describe('daemon ask flow (§7)', () => {
  it('supported question → cited answer; duplicate ask → one answer', async () => {
    const { daemon, relay, dkg } = setup();
    const { pin } = pinnedThread(relay);
    await process(daemon, pin); // creates the decision KA in SWM
    const ask = makeEvent({
      kind: 9,
      content: '@dkg ask what did we decide about the store backend?',
      tags: [
        ['h', 'chan'],
        ['p', servicePubkey],
      ],
    });
    relay.ingest(ask);
    dkg.evidence = [
      {
        rootUri: 'urn:buzz-dkg:decision:x',
        name: 'store decision',
        description: 'DECISION: oxigraph-server is the store backend we decide on',
        digest: null,
      },
    ];
    await process(daemon, ask);
    await process(daemon, ask);
    const answers = relay.sent.filter((s) => s.replyTo === ask.id);
    expect(answers).toHaveLength(1);
    expect(answers[0]!.content).toContain('oxigraph-server');
    expect(answers[0]!.content).toContain('urn:buzz-dkg:decision:x');
  });

  it('unsupported question → explicit refusal naming the scoped graph', async () => {
    const { daemon, relay } = setup();
    const ask = makeEvent({
      kind: 9,
      content: '@dkg ask who won the world cup?',
      tags: [
        ['h', 'chan'],
        ['p', servicePubkey],
      ],
    });
    relay.ingest(ask);
    await process(daemon, ask);
    const answers = relay.sent.filter((s) => s.replyTo === ask.id);
    expect(answers).toHaveLength(1);
    expect(answers[0]!.content).toMatch(/can't answer/);
    expect(answers[0]!.content).toContain("context graph 'devnet-test'");
  });
});

describe('daemon restart/cursor', () => {
  it('start() refuses devnet publish mode on a non-devnet chain', async () => {
    const { daemon, dkg } = setup();
    dkg.chainId = 'base:8453';
    await expect(daemon.start()).rejects.toThrow(/refusing to start/);
  });

  it('start() refuses when a bound context graph is missing on the node', async () => {
    const { daemon, dkg } = setup();
    dkg.contextGraphs = ['something-else'];
    await expect(daemon.start()).rejects.toThrow(/not present/);
  });

  it('advances the cursor and replays missed events safely on catch-up', async () => {
    const { daemon, relay } = setup();
    const { pin } = pinnedThread(relay);
    await daemon.start(); // catch-up processes the stored pin
    expect(relay.sent).toHaveLength(1);
    expect(daemon.registry.cursor).toBeGreaterThan(0);
    await daemon.catchUp(); // replay window overlaps; dedup holds
    expect(relay.sent).toHaveLength(1);
    expect(daemon.registry.opByTrigger(pin.id)?.state).toBe('receipted');
  });
});
