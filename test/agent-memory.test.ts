import { finalizeEvent, getPublicKey, type EventTemplate } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { Daemon } from '../src/daemon.ts';
import {
  compileAgentMemory,
  contextGraphIdForChannel,
  parseAgentMemoryEnvelope,
} from '../src/memory/proposal.ts';
import { DKG_MEMORY_PROPOSAL_KIND, type DaemonConfig, type NostrEvent } from '../src/types.ts';
import { MockDkg, MockRelay, hexId } from './helpers.ts';

const CHANNEL = 'c69311ba-a5a2-4b2a-a27f-99f7669af643';
const SECRET = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const PUBKEY = getPublicKey(SECRET);

function signed(template: EventTemplate): NostrEvent {
  return finalizeEvent(template, SECRET) as NostrEvent;
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
});

describe('automatic channel memory lifecycle', () => {
  it('provisions one private Context Graph and stores a proposal in SWM without a chat receipt', async () => {
    const { daemon, relay, dkg } = setup();
    const request = envelope();
    const result = await daemon.submitAgentMemory(request);
    const expectedGraph = contextGraphIdForChannel('https://relay.example.test', CHANNEL);

    expect(result).toMatchObject({
      ok: true,
      outcome: 'stored',
      channelId: CHANNEL,
      requesterPubkey: PUBKEY,
      contextGraphId: expectedGraph,
      state: 'receipted',
    });
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
    expect(relay.sent).toHaveLength(0);

    const replay = await daemon.submitAgentMemory(request);
    expect(replay.outcome).toBe('duplicate');
    expect(dkg.createdContextGraphs).toHaveLength(1);
    expect(dkg.kas.get(result.kaName)?.writes).toBe(1);
  });

  it('creates a different deterministic graph for a different channel', async () => {
    const { daemon, dkg } = setup();
    const other = 'e5a7cdb2-544e-480e-b388-71a1e5580370';
    const first = await daemon.submitAgentMemory(envelope());
    const second = await daemon.submitAgentMemory(envelope({ channelId: other }));
    expect(first.contextGraphId).not.toBe(second.contextGraphId);
    expect(dkg.createdContextGraphs).toHaveLength(2);
  });
});
