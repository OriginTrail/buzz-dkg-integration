import { finalizeEvent, getPublicKey, type EventTemplate } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { Daemon } from '../src/daemon.ts';
import {
  compileAgentMemory,
  contextGraphIdForChannel,
  parseAgentMemoryEnvelope,
} from '../src/memory/proposal.ts';
import { QueryGatewayService } from '../src/query-gateway/service.ts';
import { DKG_MEMORY_PROPOSAL_KIND, type DaemonConfig, type NostrEvent } from '../src/types.ts';
import { MockDkg, MockRelay, hexId } from './helpers.ts';

const CHANNEL = 'c69311ba-a5a2-4b2a-a27f-99f7669af643';
const SECRET = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const PUBKEY = getPublicKey(SECRET);
const OTHER_SECRET = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

function signed(template: EventTemplate): NostrEvent {
  return finalizeEvent(template, SECRET) as NostrEvent;
}

function signedWith(template: EventTemplate, secret: Uint8Array): NostrEvent {
  return finalizeEvent(template, secret) as NostrEvent;
}

function envelope(overrides: { proposalContent?: string; channelId?: string } = {}) {
  const channelId = overrides.channelId ?? CHANNEL;
  const source = signed({
    kind: 9,
    created_at: 1_788_000_000,
    tags: [['h', channelId]],
    content: 'We will use Oxigraph and ship the migration on Friday.',
  });
  const content =
    overrides.proposalContent ??
    JSON.stringify({
      schemaVersion: 1,
      summary: 'Adopt Oxigraph and migrate Friday',
      items: [
        { kind: 'decision', text: 'The project will use Oxigraph.' },
        { kind: 'task', text: 'Ship the migration on Friday.' },
        {
          kind: 'relationship',
          text: 'The migration uses Oxigraph.',
          subject: 'migration',
          predicate: 'uses',
          object: 'Oxigraph',
          confidence: 0.96,
        },
      ],
      model: 'test-model',
      promptVersion: 'agent-memory-v1',
    });
  const proposal = signed({
    kind: DKG_MEMORY_PROPOSAL_KIND,
    created_at: source.created_at + 1,
    tags: [
      ['h', channelId],
      ['e', source.id, '', 'source'],
      ['t', 'dkg-memory-proposal'],
    ],
    content,
  });
  return {
    channelId,
    requesterPubkey: PUBKEY,
    proposalEvent: proposal,
    sourceEvents: [source],
  };
}

function setup() {
  const relay = new MockRelay(hexId('service'));
  const dkg = new MockDkg();
  const config: DaemonConfig = {
    relayHttpUrl: 'https://relay.example.test',
    relayWsUrl: 'wss://relay.example.test',
    serviceSecretKeyHex: '11'.repeat(32),
    mentionLabels: ['dkg'],
    dkgApiUrl: 'http://127.0.0.1:9200',
    dkgToken: 'test-token',
    approvalEmoji: '✅',
    publishMode: 'disabled',
    maxPublishesPerDay: 0,
    dbPath: ':memory:',
    bindings: [],
    autoProvisionChannels: true,
    contextGraphAccessPolicy: 1,
  };
  const daemon = new Daemon(config, { relay: relay.asRelay(), dkg: dkg.asDkg() });
  return { daemon, relay, dkg };
}

describe('agent memory proposal contract', () => {
  it('verifies signed evidence and compiles semantic items with provenance', () => {
    const parsed = parseAgentMemoryEnvelope(envelope());
    const compiled = compileAgentMemory(parsed.envelope, parsed.proposal);
    expect(compiled.title).toBe('Adopt Oxigraph and migrate Friday');
    expect(compiled.quads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: 'https://w3id.org/buzz-dkg/buzz#memoryKind',
          object: '"decision"',
        }),
        expect.objectContaining({
          predicate: 'http://www.w3.org/ns/prov#wasDerivedFrom',
          object: `urn:nostr:event:${parsed.envelope.sourceEvents[0]!.id}`,
        }),
      ]),
    );
  });

  it('rejects invalid semantics and evidence that does not match the signed references', () => {
    expect(() =>
      parseAgentMemoryEnvelope(
        envelope({
          proposalContent: JSON.stringify({ schemaVersion: 1, summary: 'x', items: [] }),
        }),
      ),
    ).toThrow(/items must contain/);
    const mismatched = envelope();
    mismatched.sourceEvents = [
      signed({
        kind: 9,
        created_at: 1_788_000_010,
        tags: [['h', CHANNEL]],
        content: 'different event',
      }),
    ];
    expect(() => parseAgentMemoryEnvelope(mismatched)).toThrow(/references do not match/);

    const wrongMarker = envelope();
    wrongMarker.proposalEvent = signed({
      kind: DKG_MEMORY_PROPOSAL_KIND,
      created_at: wrongMarker.proposalEvent.created_at,
      tags: [
        ['h', CHANNEL],
        ['e', wrongMarker.sourceEvents[0]!.id, '', 'reply'],
        ['t', 'dkg-memory-proposal'],
      ],
      content: wrongMarker.proposalEvent.content,
    });
    expect(() => parseAgentMemoryEnvelope(wrongMarker)).toThrow(/source.*marker/);

    expect(() =>
      parseAgentMemoryEnvelope(
        envelope({
          proposalContent: JSON.stringify({
            schemaVersion: 1,
            summary: 'contains\na control character',
            items: [{ kind: 'claim', text: 'x' }],
          }),
        }),
      ),
    ).toThrow(/non-control UTF-8 bytes/);
    expect(() => parseAgentMemoryEnvelope(envelope({ channelId: CHANNEL.toUpperCase() }))).toThrow(
      /channelId is invalid/,
    );
  });

  it('rejects tampered signatures and requester/source authentication mismatches', () => {
    // JSON round-trip mirrors the HTTP boundary and removes nostr-tools'
    // private verification cache symbol before tampering.
    const tamperedSource = JSON.parse(JSON.stringify(envelope())) as ReturnType<typeof envelope>;
    tamperedSource.sourceEvents[0] = {
      ...tamperedSource.sourceEvents[0]!,
      content: 'changed after signing',
    };
    expect(() => parseAgentMemoryEnvelope(tamperedSource)).toThrow(/signature or event id/);

    const tamperedProposal = JSON.parse(JSON.stringify(envelope())) as ReturnType<typeof envelope>;
    tamperedProposal.proposalEvent = {
      ...tamperedProposal.proposalEvent,
      content: '{"schemaVersion":1,"summary":"changed","items":[]}',
    };
    expect(() => parseAgentMemoryEnvelope(tamperedProposal)).toThrow(/signature or event id/);

    const wrongRequester = envelope();
    wrongRequester.requesterPubkey = '00'.repeat(32);
    expect(() => parseAgentMemoryEnvelope(wrongRequester)).toThrow(/author.*requesterPubkey/);

    const otherSource = signedWith(
      {
        kind: 9,
        created_at: 1_788_000_020,
        tags: [['h', CHANNEL]],
        content: 'A source written by another participant.',
      },
      OTHER_SECRET,
    );
    const noRequesterSource = envelope();
    noRequesterSource.sourceEvents = [otherSource];
    noRequesterSource.proposalEvent = signed({
      kind: DKG_MEMORY_PROPOSAL_KIND,
      created_at: otherSource.created_at + 1,
      tags: [
        ['h', CHANNEL],
        ['e', otherSource.id, '', 'source'],
        ['t', 'dkg-memory-proposal'],
      ],
      content: noRequesterSource.proposalEvent.content,
    });
    expect(() => parseAgentMemoryEnvelope(noRequesterSource)).toThrow(/authored by the proposing/);
  });
});

describe('automatic channel memory lifecycle', () => {
  it('keeps an unknown-channel read side-effect-free', async () => {
    const { daemon, dkg } = setup();
    const service = new QueryGatewayService(
      (channelId) => daemon.contextGraphForQuery(channelId),
      dkg.asDkg(),
      {
        enabled: true,
        bind: '127.0.0.1',
        port: 0,
        token: 'x'.repeat(32),
        maxBodyBytes: 16_384,
        maxResultBytes: 1_048_576,
        maxQueryBytes: 8_192,
        operationTimeoutMs: 1_000,
        dkgTimeoutMs: 500,
        maxConcurrent: 4,
      },
    );
    await expect(
      service.execute({
        channelId: CHANNEL,
        operation: 'channel_memory',
        arguments: {},
        requesterPubkey: PUBKEY,
      }),
    ).rejects.toMatchObject({ code: 'unknown_channel' });
    expect(dkg.createdContextGraphs).toHaveLength(0);
    expect(daemon.registry.contextGraphFor(CHANNEL)).toBeNull();
  });

  it('provisions one private Context Graph and stores a proposal in SWM without a chat receipt', async () => {
    const { daemon, relay, dkg } = setup();
    const request = envelope();
    const result = await daemon.submitAgentMemory(request);
    const expectedGraph = contextGraphIdForChannel('https://relay.example.test', CHANNEL);

    expect(result).toMatchObject({
      ok: true,
      outcome: 'accepted',
      channelId: CHANNEL,
      requesterPubkey: PUBKEY,
      contextGraphId: expectedGraph,
      state: 'distilled',
    });
    await daemon.drain();
    expect(dkg.createdContextGraphs).toEqual([
      expect.objectContaining({
        id: expectedGraph,
        accessPolicy: 1,
        publishPolicy: 0,
        register: false,
      }),
    ]);
    expect(dkg.kas.get(result.kaName)).toMatchObject({
      state: 'promoted',
      writes: 1,
      finalizes: 1,
      shares: 1,
      publishes: 0,
    });
    expect(dkg.lifecycleLog).toEqual([
      { operation: 'write', name: result.kaName, contextGraphId: expectedGraph },
      { operation: 'finalize', name: result.kaName, contextGraphId: expectedGraph },
      { operation: 'share', name: result.kaName, contextGraphId: expectedGraph },
    ]);
    expect(dkg.queryLog).toContainEqual(
      expect.objectContaining({ contextGraphId: expectedGraph, view: 'shared-working-memory' }),
    );
    expect(relay.sent).toHaveLength(0);

    const replay = await daemon.submitAgentMemory(request);
    expect(replay.outcome).toBe('duplicate');
    expect(replay.state).toBe('receipted');
    expect(dkg.createdContextGraphs).toHaveLength(1);
    expect(dkg.kas.get(result.kaName)?.writes).toBe(1);
  });

  it('creates a different deterministic graph for a different channel', async () => {
    const { daemon, dkg } = setup();
    const other = 'e5a7cdb2-544e-480e-b388-71a1e5580370';
    const first = await daemon.submitAgentMemory(envelope());
    const second = await daemon.submitAgentMemory(envelope({ channelId: other }));
    expect(first.contextGraphId).not.toBe(second.contextGraphId);
    await daemon.drain();
    expect(dkg.createdContextGraphs).toHaveLength(2);
    const firstGraph = contextGraphIdForChannel('https://relay.example.test', CHANNEL);
    const secondGraph = contextGraphIdForChannel('https://relay.example.test', other);
    expect(
      dkg.lifecycleLog
        .filter((entry) => entry.name === first.kaName)
        .map((entry) => entry.contextGraphId),
    ).toEqual([firstGraph, firstGraph, firstGraph]);
    expect(
      dkg.lifecycleLog
        .filter((entry) => entry.name === second.kaName)
        .map((entry) => entry.contextGraphId),
    ).toEqual([secondGraph, secondGraph, secondGraph]);
    expect(dkg.queryLog.filter((entry) => entry.contextGraphId === firstGraph)).not.toHaveLength(0);
    expect(dkg.queryLog.filter((entry) => entry.contextGraphId === secondGraph)).not.toHaveLength(
      0,
    );
  });

  it('accepts durably before slow first-use graph provisioning starts', async () => {
    const { daemon, dkg } = setup();
    let release!: () => void;
    dkg.createContextGraphGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const accepted = daemon.submitAgentMemory(envelope());
    expect(accepted).toMatchObject({ outcome: 'accepted', state: 'distilled' });
    expect(dkg.createContextGraphStarted).toBe(0);
    expect(dkg.lifecycleLog).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dkg.createContextGraphStarted).toBe(1);
    expect(daemon.registry.opByTrigger(accepted.proposalEventId)?.state).toBe('distilled');
    release();
    await daemon.drain();
    expect(daemon.registry.opByTrigger(accepted.proposalEventId)?.state).toBe('receipted');
  });

  it('treats reordered source events and JSON object keys as an idempotent retry', async () => {
    const { daemon, dkg } = setup();
    const request = envelope();
    const second = signed({
      kind: 9,
      created_at: request.sourceEvents[0]!.created_at + 1,
      tags: [['h', CHANNEL]],
      content: 'The second signed source event.',
    });
    request.sourceEvents.push(second);
    request.proposalEvent = signed({
      kind: DKG_MEMORY_PROPOSAL_KIND,
      created_at: second.created_at + 1,
      tags: [
        ['h', CHANNEL],
        ['e', request.sourceEvents[0]!.id, '', 'source'],
        ['e', second.id, '', 'source'],
        ['t', 'dkg-memory-proposal'],
      ],
      content: request.proposalEvent.content,
    });
    const first = await daemon.submitAgentMemory(request);
    await daemon.drain();

    const retry = {
      sourceEvents: [...request.sourceEvents].reverse().map((event) => ({
        sig: event.sig,
        content: event.content,
        tags: event.tags,
        kind: event.kind,
        created_at: event.created_at,
        pubkey: event.pubkey,
        id: event.id,
      })),
      proposalEvent: {
        sig: request.proposalEvent.sig,
        content: request.proposalEvent.content,
        tags: request.proposalEvent.tags,
        kind: request.proposalEvent.kind,
        created_at: request.proposalEvent.created_at,
        pubkey: request.proposalEvent.pubkey,
        id: request.proposalEvent.id,
      },
      requesterPubkey: request.requesterPubkey,
      channelId: request.channelId,
    };
    const duplicate = await daemon.submitAgentMemory(retry);
    expect(duplicate.outcome).toBe('duplicate');
    expect(duplicate.kaName).toBe(first.kaName);
    expect(dkg.kas.get(first.kaName)?.writes).toBe(1);
  });

  it('recovers a proposal interrupted after finalize without repeating completed steps', async () => {
    const { daemon, dkg } = setup();
    dkg.failShareOnce = new Error('transient share failure');
    const accepted = await daemon.submitAgentMemory(envelope());
    await daemon.drain();
    expect(daemon.registry.opByTrigger(accepted.proposalEventId)?.state).toBe('finalized');

    await daemon.recover();
    expect(daemon.registry.opByTrigger(accepted.proposalEventId)?.state).toBe('receipted');
    expect(dkg.kas.get(accepted.kaName)).toMatchObject({
      writes: 1,
      finalizes: 1,
      shares: 1,
      state: 'promoted',
    });
  });
});
