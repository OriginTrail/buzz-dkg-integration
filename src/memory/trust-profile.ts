import { IntegrationApiError } from '../errors.ts';
import type {
  AgentMemoryEntity,
  AgentMemoryEnvelope,
  AgentMemoryProposal,
  AgentMemoryProposalV2,
  NostrEvent,
} from '../types.ts';

const HEX_64 = /^[0-9a-f]{64}$/u;
const TRUST_RELATIONS = new Set(['trust:issuer', 'trust:subject']);

function invalid(message: string): never {
  throw new IntegrationApiError(400, 'invalid_request', message);
}

interface SignedVouchAction {
  source: NostrEvent;
  issuerUri: string;
  subjectUri: string;
}

function signedVouchAction(envelope: AgentMemoryEnvelope): SignedVouchAction {
  if (envelope.sourceEvents.length !== 1) {
    invalid('dkg-trust@1 proposals must reference exactly one signed vouch event');
  }
  const source = envelope.sourceEvents[0]!;
  if (source.kind !== 1985 || source.pubkey !== envelope.requesterPubkey) {
    invalid('dkg-trust@1 source must be a kind 1985 event signed by the requester');
  }
  const namespaces = source.tags.filter((tag) => tag[0] === 'L');
  const labels = source.tags.filter((tag) => tag[0] === 'l');
  if (
    namespaces.length !== 1 ||
    namespaces[0]!.length !== 2 ||
    namespaces[0]![1] !== 'buzz.wot' ||
    labels.length !== 1 ||
    labels[0]!.length !== 3 ||
    labels[0]![1] !== 'vouch' ||
    labels[0]![2] !== 'buzz.wot'
  ) {
    invalid('dkg-trust@1 source must be a buzz.wot vouch label');
  }
  if (!source.content.trim() || source.content.length > 1_000) {
    invalid('dkg-trust@1 signed vouch explanation must contain 1 to 1,000 characters');
  }
  const subjectTags = source.tags.filter((tag) => tag[0] === 'p');
  const subjectPubkey = subjectTags[0]?.[1];
  if (subjectTags.length !== 1 || !subjectPubkey || !HEX_64.test(subjectPubkey)) {
    invalid('dkg-trust@1 source must identify exactly one p-tag subject');
  }
  const issuerUri = `urn:nostr:pubkey:${source.pubkey}`;
  const subjectUri = `urn:nostr:pubkey:${subjectPubkey.toLowerCase()}`;
  if (issuerUri === subjectUri) invalid('dkg-trust@1 does not allow self-vouches');
  return { source, issuerUri, subjectUri };
}

function relationTarget(
  proposal: AgentMemoryProposalV2,
  vouch: AgentMemoryEntity,
  predicate: 'trust:issuer' | 'trust:subject',
): AgentMemoryEntity {
  const matches = proposal.relations.filter(
    (relation) => relation.subject === vouch.id && relation.predicate === predicate,
  );
  if (matches.length !== 1) invalid(`dkg-trust@1 vouch must have exactly one ${predicate}`);
  const target = proposal.entities.find((entity) => entity.id === matches[0]!.object);
  if (!target) invalid(`dkg-trust@1 ${predicate} target is missing`);
  return target;
}

/** Validate one profile-specific projection against its already-verified Nostr action. */
export function validateTrustProposal(
  envelope: AgentMemoryEnvelope,
  proposal: AgentMemoryProposal,
): void {
  if (proposal.schemaVersion !== 2 || !proposal.profiles.includes('dkg-trust@1')) return;
  const profiles = new Set(proposal.profiles);
  if (profiles.size !== 2 || !profiles.has('dkg-memory@1') || !profiles.has('dkg-trust@1')) {
    invalid('dkg-trust@1 proposals cannot mix trust with other memory profiles');
  }
  const { source, issuerUri, subjectUri } = signedVouchAction(envelope);
  const vouches = proposal.entities.filter((entity) => entity.type === 'trust:Vouch');
  if (vouches.length !== 1) invalid('dkg-trust@1 proposal must contain exactly one trust:Vouch');
  const vouch = vouches[0]!;
  if (vouch.description !== source.content) {
    invalid('dkg-trust@1 vouch explanation must match the signed source content');
  }
  const attributes = new Map(
    (vouch.attributes ?? []).map((attribute) => [attribute.predicate, attribute.value]),
  );
  if (
    attributes.size !== 2 ||
    (vouch.attributes ?? []).length !== 2 ||
    !attributes.has('trust:status') ||
    !attributes.has('trust:scope')
  ) {
    invalid('dkg-trust@1 vouch must contain only status and scope attributes');
  }
  if (attributes.get('trust:status') !== 'active' || attributes.get('trust:scope') !== 'channel') {
    invalid('new dkg-trust@1 vouches must be active and channel-scoped');
  }
  const issuer = relationTarget(proposal, vouch, 'trust:issuer');
  const subject = relationTarget(proposal, vouch, 'trust:subject');
  const projectionIds = new Set([vouch.id, issuer.id, subject.id]);
  if (proposal.entities.length !== 3 || projectionIds.size !== 3) {
    invalid('dkg-trust@1 proposals must contain only the vouch, issuer, and subject entities');
  }
  if (
    proposal.relations.length !== 2 ||
    proposal.relations.some(
      (relation) => relation.subject !== vouch.id || !TRUST_RELATIONS.has(relation.predicate),
    )
  ) {
    invalid('dkg-trust@1 proposals must contain only issuer and subject relations');
  }
  if (
    vouch.locator ||
    issuer.description ||
    issuer.attributes?.length ||
    subject.description ||
    subject.attributes?.length
  ) {
    invalid('dkg-trust@1 projection entities contain unsupported extra data');
  }
  if (
    issuer.type !== 'schema:Person' ||
    issuer.locator?.kind !== 'uri' ||
    issuer.locator.uri !== issuerUri
  ) {
    invalid('dkg-trust@1 issuer must resolve to the signed source author');
  }
  if (
    subject.type !== 'schema:Person' ||
    subject.locator?.kind !== 'uri' ||
    subject.locator.uri !== subjectUri
  ) {
    invalid('dkg-trust@1 subject must resolve to the signed source p tag');
  }
}
