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
    const evidenceEventId = '55'.repeat(32);
    const evidenceTarget = 'urn:dkg:code:file:github.com%2Facme%2Fapi/src%2Fauth.ts';
    const source = signed({
      kind: 1985,
      created_at: 1_788_000_030,
      tags: [
        ['h', CHANNEL],
        ['L', 'buzz.wot'],
        ['l', 'vouch', 'buzz.wot'],
        ['p', subject],
        ['r', evidenceTarget],
        ['e', evidenceEventId, '', 'evidence'],
      ],
      content: 'Reviewed two releases carefully and caught a rollback edge case.',
    });
    const proposal = signed({
      kind: DKG_MEMORY_PROPOSAL_KIND,
      created_at: source.created_at + 1,
      tags: [
        ['h', CHANNEL],
        ['e', source.id, '', 'source'],
        ['t', 'dkg-memory-proposal'],
      ],
      content: JSON.stringify({
        schemaVersion: 2,
        profiles: ['dkg-memory@1', 'dkg-trust@1'],
        summary: 'Vouch for Alice',
        entities: [
          {
            id: 'vouch',
            type: 'trust:Vouch',
            name: 'Vouch for Alice',
            description: source.content,
            locator: { kind: 'uri', uri: `urn:buzz-dkg:vouch:${source.id}` },
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
          {
            id: 'evidence-1',
            type: 'trust:EvidenceReference',
            name: 'Evidence reference',
            attributes: [
              { predicate: 'trust:evidenceTarget', value: evidenceTarget },
              {
                predicate: 'trust:evidenceSource',
                value: `urn:nostr:event:${evidenceEventId}`,
              },
            ],
          },
        ],
        relations: [
          { subject: 'vouch', predicate: 'trust:issuer', object: 'issuer' },
          { subject: 'vouch', predicate: 'trust:subject', object: 'subject' },
          { subject: 'vouch', predicate: 'trust:supportedBy', object: 'evidence-1' },
        ],
        promptVersion: 'human-vouch-v1',
      }),
    });
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
       SELECT ?issuer ?subject ?note ?source ?target ?evidenceSource WHERE { GRAPH ?g {
         ?vouch a trust:Vouch ; trust:issuer ?issuer ; trust:subject ?subject ;
           schema:description ?note ; prov:wasDerivedFrom ?source .
         ?vouch trust:supportedBy ?reference .
         ?reference trust:evidenceTarget ?target ; trust:evidenceSource ?evidenceSource .
       } }`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.get('issuer')?.value).toBe(`urn:nostr:pubkey:${PUBKEY}`);
    expect(rows[0]!.get('subject')?.value).toBe(`urn:nostr:pubkey:${subject}`);
    expect(rows[0]!.get('note')?.value).toBe(source.content);
    expect(rows[0]!.get('source')?.value).toBe(`urn:nostr:event:${source.id}`);
    expect(rows[0]!.get('target')?.value).toBe(evidenceTarget);
    expect(rows[0]!.get('evidenceSource')?.value).toBe(`urn:nostr:event:${evidenceEventId}`);

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

    const tamperedEvidence = JSON.parse(proposal.content) as {
      entities: Array<{
        id: string;
        attributes?: Array<{ predicate: string; value: string }>;
      }>;
    };
    tamperedEvidence.entities
      .find((entity) => entity.id === 'evidence-1')!
      .attributes!.find((attribute) => attribute.predicate === 'trust:evidenceTarget')!.value =
      'urn:dkg:code:file:github.com%2Facme%2Fapi/src%2Fbilling.ts';
    const tamperedEvidenceProposal = signed({
      kind: proposal.kind,
      created_at: proposal.created_at,
      tags: proposal.tags,
      content: JSON.stringify(tamperedEvidence),
    });
    expect(() =>
      parseAgentMemoryEnvelope({
        channelId: CHANNEL,
        requesterPubkey: PUBKEY,
        proposalEvent: tamperedEvidenceProposal,
        sourceEvents: [source],
      }),
    ).toThrow(/projected evidence.*match/);

    const secondEvidenceTarget = 'urn:dkg:github:review:github.com/acme/api/42';
    const secondEvidenceEventId = '66'.repeat(32);
    const pairedSource = signed({
      kind: source.kind,
      created_at: source.created_at,
      tags: [
        ...source.tags,
        ['r', secondEvidenceTarget],
        ['e', secondEvidenceEventId, '', 'evidence'],
      ],
      content: source.content,
    });
    const pairedContent = JSON.parse(proposal.content) as {
      entities: Array<{
        id: string;
        type: string;
        name?: string;
        description?: string;
        locator?: { uri: string };
        attributes?: Array<{ predicate: string; value: string }>;
      }>;
      relations: Array<{ subject: string; predicate: string; object: string }>;
    };
    pairedContent.entities.find((entity) => entity.id === 'vouch')!.locator!.uri =
      `urn:buzz-dkg:vouch:${pairedSource.id}`;
    pairedContent.entities.push({
      id: 'evidence-2',
      type: 'trust:EvidenceReference',
      name: 'Second evidence reference',
      attributes: [
        { predicate: 'trust:evidenceTarget', value: secondEvidenceTarget },
        {
          predicate: 'trust:evidenceSource',
          value: `urn:nostr:event:${secondEvidenceEventId}`,
        },
      ],
    });
    pairedContent.relations.push({
      subject: 'vouch',
      predicate: 'trust:supportedBy',
      object: 'evidence-2',
    });
    const pairedProposal = signed({
      kind: proposal.kind,
      created_at: proposal.created_at,
      tags: [
        ['h', CHANNEL],
        ['e', pairedSource.id, '', 'source'],
        ['t', 'dkg-memory-proposal'],
      ],
      content: JSON.stringify(pairedContent),
    });
    expect(() =>
      parseAgentMemoryEnvelope({
        channelId: CHANNEL,
        requesterPubkey: PUBKEY,
        proposalEvent: pairedProposal,
        sourceEvents: [pairedSource],
      }),
    ).not.toThrow();

    const swappedPairs = structuredClone(pairedContent);
    const firstSource = swappedPairs.entities
      .find((entity) => entity.id === 'evidence-1')!
      .attributes!.find((attribute) => attribute.predicate === 'trust:evidenceSource')!;
    const secondSource = swappedPairs.entities
      .find((entity) => entity.id === 'evidence-2')!
      .attributes!.find((attribute) => attribute.predicate === 'trust:evidenceSource')!;
    [firstSource.value, secondSource.value] = [secondSource.value, firstSource.value];
    const swappedProposal = signed({
      kind: proposal.kind,
      created_at: proposal.created_at,
      tags: pairedProposal.tags,
      content: JSON.stringify(swappedPairs),
    });
    expect(() =>
      parseAgentMemoryEnvelope({
        channelId: CHANNEL,
        requesterPubkey: PUBKEY,
        proposalEvent: swappedProposal,
        sourceEvents: [pairedSource],
      }),
    ).toThrow(/target\/source pairing must match signed tag order/);

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
    ).toThrow(/unsupported projection entities/);

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
    ).toThrow(/active status and channel scope/);

    const proposalFor = (trustSource: NostrEvent, content = proposal.content) =>
      signed({
        kind: DKG_MEMORY_PROPOSAL_KIND,
        created_at: proposal.created_at,
        tags: [
          ['h', CHANNEL],
          ['e', trustSource.id, '', 'source'],
          ['t', 'dkg-memory-proposal'],
        ],
        content,
      });
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
    ).toThrow(/supported buzz.wot action label/);

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

  it('compiles signed revoke and supersede actions as append-only lifecycle evidence', () => {
    const subject = 'ab'.repeat(32);
    const targetEventId = '66'.repeat(32);
    const replacementEventId = '77'.repeat(32);
    const source = signed({
      kind: 1985,
      created_at: 1_788_000_040,
      tags: [
        ['h', CHANNEL],
        ['L', 'buzz.wot'],
        ['l', 'supersede', 'buzz.wot'],
        ['p', subject],
        ['e', targetEventId, '', 'target'],
        ['e', replacementEventId, '', 'replacement'],
      ],
      content: 'Replaced after gathering newer review evidence.',
    });
    const proposal = signed({
      kind: DKG_MEMORY_PROPOSAL_KIND,
      created_at: source.created_at + 1,
      tags: [
        ['h', CHANNEL],
        ['e', source.id, '', 'source'],
        ['t', 'dkg-memory-proposal'],
      ],
      content: JSON.stringify({
        schemaVersion: 2,
        profiles: ['dkg-memory@1', 'dkg-trust@1'],
        summary: 'Supersede vouch',
        entities: [
          {
            id: 'lifecycle',
            type: 'trust:VouchLifecycle',
            name: 'Supersede vouch',
            description: source.content,
            locator: {
              kind: 'uri',
              uri: `urn:buzz-dkg:vouch-lifecycle:${source.id}`,
            },
            attributes: [
              { predicate: 'trust:status', value: 'superseded' },
              { predicate: 'trust:scope', value: 'channel' },
              {
                predicate: 'trust:targetVouch',
                value: `urn:buzz-dkg:vouch:${targetEventId}`,
              },
              {
                predicate: 'trust:replacementVouch',
                value: `urn:buzz-dkg:vouch:${replacementEventId}`,
              },
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
            name: 'Vouch subject',
            locator: { kind: 'uri', uri: `urn:nostr:pubkey:${subject}` },
          },
        ],
        relations: [
          { subject: 'lifecycle', predicate: 'trust:issuer', object: 'issuer' },
          { subject: 'lifecycle', predicate: 'trust:subject', object: 'subject' },
        ],
        promptVersion: 'human-vouch-lifecycle-v1',
      }),
    });
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
       SELECT ?status ?target ?replacement WHERE { GRAPH ?g {
         ?action a trust:VouchLifecycle ; trust:status ?status ;
           trust:targetVouch ?target ; trust:replacementVouch ?replacement .
       } }`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.get('status')?.value).toBe('superseded');
    expect(rows[0]!.get('target')?.value).toBe(`urn:buzz-dkg:vouch:${targetEventId}`);
    expect(rows[0]!.get('replacement')?.value).toBe(`urn:buzz-dkg:vouch:${replacementEventId}`);

    const revokeSource = signed({
      kind: 1985,
      created_at: source.created_at + 2,
      tags: [
        ['h', CHANNEL],
        ['L', 'buzz.wot'],
        ['l', 'revoke', 'buzz.wot'],
        ['p', subject],
        ['e', targetEventId, '', 'target'],
      ],
      content: 'Revoked after the underlying evidence was withdrawn.',
    });
    const revokeContent = JSON.parse(proposal.content) as {
      summary: string;
      entities: Array<{
        id: string;
        description?: string;
        locator?: { kind: string; uri: string };
        attributes?: Array<{ predicate: string; value: string }>;
      }>;
    };
    revokeContent.summary = 'Revoke vouch';
    const revokeLifecycle = revokeContent.entities.find((entity) => entity.id === 'lifecycle')!;
    revokeLifecycle.description = revokeSource.content;
    revokeLifecycle.locator!.uri = `urn:buzz-dkg:vouch-lifecycle:${revokeSource.id}`;
    revokeLifecycle.attributes = revokeLifecycle
      .attributes!.filter((attribute) => attribute.predicate !== 'trust:replacementVouch')
      .map((attribute) =>
        attribute.predicate === 'trust:status' ? { ...attribute, value: 'revoked' } : attribute,
      );
    const revokeProposal = signed({
      kind: DKG_MEMORY_PROPOSAL_KIND,
      created_at: revokeSource.created_at + 1,
      tags: [
        ['h', CHANNEL],
        ['e', revokeSource.id, '', 'source'],
        ['t', 'dkg-memory-proposal'],
      ],
      content: JSON.stringify(revokeContent),
    });
    const parsedRevoke = parseAgentMemoryEnvelope({
      channelId: CHANNEL,
      requesterPubkey: PUBKEY,
      proposalEvent: revokeProposal,
      sourceEvents: [revokeSource],
    });
    const revokeStore = generatedStore(
      compileAgentMemory(parsedRevoke.envelope, parsedRevoke.proposal).quads,
    );
    const revokeRows = queryRows(
      revokeStore,
      `PREFIX trust: <http://dkg.io/ontology/trust/>
       SELECT ?status ?target WHERE { GRAPH ?g {
         ?action a trust:VouchLifecycle ; trust:status ?status ; trust:targetVouch ?target .
         FILTER NOT EXISTS { ?action trust:replacementVouch ?replacement }
       } }`,
    );
    expect(revokeRows).toHaveLength(1);
    expect(revokeRows[0]!.get('status')?.value).toBe('revoked');
    expect(revokeRows[0]!.get('target')?.value).toBe(`urn:buzz-dkg:vouch:${targetEventId}`);

    const tampered = JSON.parse(proposal.content) as {
      entities: Array<{ id: string; attributes?: Array<{ predicate: string; value: string }> }>;
    };
    tampered.entities
      .find((entity) => entity.id === 'lifecycle')!
      .attributes!.find((attribute) => attribute.predicate === 'trust:targetVouch')!.value =
      `urn:buzz-dkg:vouch:${'88'.repeat(32)}`;
    const tamperedProposal = signed({
      kind: proposal.kind,
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
    ).toThrow(/attributes must exactly match the signed action/);
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
