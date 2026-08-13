import { finalizeEvent, getPublicKey, type EventTemplate } from 'nostr-tools';
import oxigraph from 'oxigraph';
import { describe, expect, it } from 'vitest';
import { compileAgentMemory, parseAgentMemoryEnvelope } from '../src/memory/proposal.ts';
import { DKG_MEMORY_PROPOSAL_KIND, type NostrEvent } from '../src/types.ts';

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

function envelope(overrides: { proposalContent?: string } = {}) {
  const source = signed({
    kind: 9,
    created_at: 1_788_000_000,
    tags: [['h', CHANNEL]],
    content: 'We will use Oxigraph and ship the migration on Friday.',
  });
  const proposal = signed({
    kind: DKG_MEMORY_PROPOSAL_KIND,
    created_at: source.created_at + 1,
    tags: [
      ['h', CHANNEL],
      ['e', source.id, '', 'source'],
      ['t', 'dkg-memory-proposal'],
    ],
    content:
      overrides.proposalContent ??
      JSON.stringify({ schemaVersion: 1, summary: 'Memory', items: [] }),
  });
  return {
    channelId: CHANNEL,
    requesterPubkey: PUBKEY,
    proposalEvent: proposal,
    sourceEvents: [source],
  };
}

type TrustProposalContent = {
  schemaVersion: number;
  profiles: string[];
  summary: string;
  entities: Array<{
    id: string;
    type: string;
    name?: string;
    description?: string;
    locator?: { kind: string; uri: string };
    attributes?: Array<{ predicate: string; value: string }>;
  }>;
  relations: Array<{ subject: string; predicate: string; object: string }>;
  promptVersion?: string;
};

function trustVouchContent(subject: string, note: string): TrustProposalContent {
  return {
    schemaVersion: 2,
    profiles: ['dkg-memory@1', 'dkg-trust@1'],
    summary: 'Vouch for Alice',
    entities: [
      {
        id: 'vouch',
        type: 'trust:Vouch',
        name: 'Vouch for Alice',
        description: note,
        attributes: [
          { predicate: 'trust:status', value: 'active' },
          { predicate: 'trust:scope', value: 'channel' },
        ],
      },
      {
        id: 'issuer',
        type: 'schema:Person',
        name: 'Vouch issuer',
        locator: { kind: 'uri', uri: `urn:nostr:pubkey:${PUBKEY}` },
      },
      {
        id: 'subject',
        type: 'schema:Person',
        name: 'Alice',
        locator: { kind: 'uri', uri: `urn:nostr:pubkey:${subject}` },
      },
    ],
    relations: [
      { subject: 'vouch', predicate: 'trust:issuer', object: 'issuer' },
      { subject: 'vouch', predicate: 'trust:subject', object: 'subject' },
    ],
    promptVersion: 'human-vouch-v1',
  };
}

function signedVouchFixture(subject: string) {
  const source = signed({
    kind: 1985,
    created_at: 1_788_000_030,
    tags: [
      ['h', CHANNEL],
      ['L', 'buzz.wot'],
      ['l', 'vouch', 'buzz.wot'],
      ['p', subject],
    ],
    content: 'Reviewed two releases carefully and caught a rollback edge case.',
  });
  const proposal = proposalForTrustSource(
    source,
    JSON.stringify(trustVouchContent(subject, source.content)),
  );
  return { proposal, source };
}

function proposalForTrustSource(source: NostrEvent, content: string): NostrEvent {
  return signed({
    kind: DKG_MEMORY_PROPOSAL_KIND,
    created_at: source.created_at + 1,
    tags: [
      ['h', CHANNEL],
      ['e', source.id, '', 'source'],
      ['t', 'dkg-memory-proposal'],
    ],
    content,
  });
}

function generatedStore(quads: ReturnType<typeof compileAgentMemory>['quads']) {
  const store = new oxigraph.Store();
  const serialized = quads
    .map(({ subject, predicate, object }) => {
      const rdfObject = object.startsWith('"') ? object : '<' + object + '>';
      return '<' + subject + '> <' + predicate + '> ' + rdfObject + ' <urn:test:generated:swm> .';
    })
    .join('\n');
  store.load(serialized, { format: 'application/n-quads' });
  return store;
}

function queryRows(store: InstanceType<typeof oxigraph.Store>, sparql: string) {
  const result = store.query(sparql);
  if (!Array.isArray(result)) throw new Error('expected SELECT results');
  return result as Array<Map<string, oxigraph.Term>>;
}

describe('signed trust proposal profile', () => {
  it('compiles a signed human vouch into queryable trust edges with source provenance', () => {
    const subject = 'ab'.repeat(32);
    const { proposal, source } = signedVouchFixture(subject);
    const parsed = parseAgentMemoryEnvelope({
      channelId: CHANNEL,
      requesterPubkey: PUBKEY,
      proposalEvent: proposal,
      sourceEvents: [source],
    });
    const store = generatedStore(compileAgentMemory(parsed.envelope, parsed.proposal).quads);
    const rows = queryRows(
      store,
      `PREFIX trust: <http://dkg.io/ontology/trust/>
       PREFIX schema: <http://schema.org/>
       PREFIX prov: <http://www.w3.org/ns/prov#>
       SELECT ?issuer ?subject ?note ?source WHERE { GRAPH ?g {
         ?vouch a trust:Vouch ; trust:issuer ?issuer ; trust:subject ?subject ;
           schema:description ?note ; prov:wasDerivedFrom ?source .
       } }`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.get('issuer')?.value).toBe(`urn:nostr:pubkey:${PUBKEY}`);
    expect(rows[0]!.get('subject')?.value).toBe(`urn:nostr:pubkey:${subject}`);
    expect(rows[0]!.get('note')?.value).toBe(source.content);
    expect(rows[0]!.get('source')?.value).toBe(`urn:nostr:event:${source.id}`);

    const tampered = JSON.parse(proposal.content) as {
      entities: Array<{ id: string; locator?: { uri: string } }>;
    };
    tampered.entities.find((entity) => entity.id === 'subject')!.locator!.uri =
      `urn:nostr:pubkey:${'cd'.repeat(32)}`;
    const tamperedProposal = signed({
      kind: DKG_MEMORY_PROPOSAL_KIND,
      created_at: proposal.created_at,
      tags: proposal.tags,
      content: JSON.stringify(tampered),
    });
    expect(() =>
      parseAgentMemoryEnvelope({
        channelId: CHANNEL,
        requesterPubkey: PUBKEY,
        proposalEvent: tamperedProposal,
        sourceEvents: [source],
      }),
    ).toThrow(/subject must resolve to the signed source p tag/);

    const tamperedExplanation = JSON.parse(proposal.content) as {
      entities: Array<{ id: string; description?: string }>;
    };
    tamperedExplanation.entities.find((entity) => entity.id === 'vouch')!.description =
      'A different, unsigned explanation.';
    expect(() =>
      parseAgentMemoryEnvelope({
        channelId: CHANNEL,
        requesterPubkey: PUBKEY,
        proposalEvent: proposalForTrustSource(source, JSON.stringify(tamperedExplanation)),
        sourceEvents: [source],
      }),
    ).toThrow(/explanation must match the signed source content/);

    const ambiguousSource = signed({
      kind: 1985,
      created_at: source.created_at,
      tags: [...source.tags, ['p', '']],
      content: source.content,
    });
    const ambiguousProposal = signed({
      kind: DKG_MEMORY_PROPOSAL_KIND,
      created_at: proposal.created_at,
      tags: [
        ['h', CHANNEL],
        ['e', ambiguousSource.id, '', 'source'],
        ['t', 'dkg-memory-proposal'],
      ],
      content: proposal.content,
    });
    expect(() =>
      parseAgentMemoryEnvelope({
        channelId: CHANNEL,
        requesterPubkey: PUBKEY,
        proposalEvent: ambiguousProposal,
        sourceEvents: [ambiguousSource],
      }),
    ).toThrow(/exactly one p-tag subject/);

    const mixed = JSON.parse(proposal.content) as {
      entities: Array<{
        id: string;
        type: string;
        name?: string;
        attributes?: Array<{ predicate: string; value: string }>;
      }>;
      relations: Array<{ subject: string; predicate: string; object: string }>;
    };
    mixed.entities.push({ id: 'claim', type: 'memory:Claim', name: 'Smuggled approval claim' });
    const mixedProposal = signed({
      kind: DKG_MEMORY_PROPOSAL_KIND,
      created_at: proposal.created_at,
      tags: proposal.tags,
      content: JSON.stringify(mixed),
    });
    expect(() =>
      parseAgentMemoryEnvelope({
        channelId: CHANNEL,
        requesterPubkey: PUBKEY,
        proposalEvent: mixedProposal,
        sourceEvents: [source],
      }),
    ).toThrow(/only the vouch, issuer, and subject entities/);

    const revoked = JSON.parse(proposal.content) as typeof mixed;
    const status = revoked.entities
      .find((entity) => entity.id === 'vouch')!
      .attributes!.find((attribute) => attribute.predicate === 'trust:status')!;
    status.value = 'revoked';
    const revokedProposal = signed({
      kind: DKG_MEMORY_PROPOSAL_KIND,
      created_at: proposal.created_at,
      tags: proposal.tags,
      content: JSON.stringify(revoked),
    });
    expect(() =>
      parseAgentMemoryEnvelope({
        channelId: CHANNEL,
        requesterPubkey: PUBKEY,
        proposalEvent: revokedProposal,
        sourceEvents: [source],
      }),
    ).toThrow(/active and channel-scoped/);

    const proposalFor = (trustSource: NostrEvent, content = proposal.content) =>
      proposalForTrustSource(trustSource, content);
    const wrongKind = signed({ ...source, kind: 1 });
    expect(() =>
      parseAgentMemoryEnvelope({
        channelId: CHANNEL,
        requesterPubkey: PUBKEY,
        proposalEvent: proposalFor(wrongKind),
        sourceEvents: [wrongKind],
      }),
    ).toThrow(/kind 1985 event signed by the requester/);

    const wrongSigner = signedWith(
      {
        kind: source.kind,
        created_at: source.created_at,
        tags: source.tags,
        content: source.content,
      },
      OTHER_SECRET,
    );
    expect(() =>
      parseAgentMemoryEnvelope({
        channelId: CHANNEL,
        requesterPubkey: PUBKEY,
        proposalEvent: proposalFor(wrongSigner),
        sourceEvents: [wrongSigner],
      }),
    ).toThrow(/source event must be authored by the proposing agent/);

    const unlabeled = signed({
      kind: source.kind,
      created_at: source.created_at,
      tags: [
        ['h', CHANNEL],
        ['p', subject],
      ],
      content: source.content,
    });
    expect(() =>
      parseAgentMemoryEnvelope({
        channelId: CHANNEL,
        requesterPubkey: PUBKEY,
        proposalEvent: proposalFor(unlabeled),
        sourceEvents: [unlabeled],
      }),
    ).toThrow(/buzz.wot vouch label/);

    const selfVouch = signed({
      kind: source.kind,
      created_at: source.created_at,
      tags: source.tags.map((tag) => (tag[0] === 'p' ? ['p', PUBKEY] : tag)),
      content: source.content,
    });
    const selfProjection = JSON.parse(proposal.content) as {
      entities: Array<{ id: string; locator?: { uri: string } }>;
    };
    selfProjection.entities.find((entity) => entity.id === 'subject')!.locator!.uri =
      `urn:nostr:pubkey:${PUBKEY}`;
    expect(() =>
      parseAgentMemoryEnvelope({
        channelId: CHANNEL,
        requesterPubkey: PUBKEY,
        proposalEvent: proposalFor(selfVouch, JSON.stringify(selfProjection)),
        sourceEvents: [selfVouch],
      }),
    ).toThrow(/does not allow self-vouches/);
  });

  it('rejects unsupported trust lifecycle states and non-channel scopes', () => {
    const trustProposal = (predicate: string, value: string) =>
      JSON.stringify({
        schemaVersion: 2,
        profiles: ['dkg-memory@1', 'dkg-trust@1'],
        summary: 'Invalid vouch',
        entities: [
          {
            id: 'vouch',
            type: 'trust:Vouch',
            name: 'Invalid vouch',
            attributes: [{ predicate, value }],
          },
        ],
        relations: [],
      });
    expect(() =>
      parseAgentMemoryEnvelope(
        envelope({ proposalContent: trustProposal('trust:status', 'trusted') }),
      ),
    ).toThrow(/supported trust status/);
    expect(() =>
      parseAgentMemoryEnvelope(
        envelope({ proposalContent: trustProposal('trust:scope', 'global') }),
      ),
    ).toThrow(/supported trust scope/);
  });
});
