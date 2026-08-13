import { IntegrationApiError } from '../errors.ts';
import type {
  AgentMemoryEntity,
  AgentMemoryEnvelope,
  AgentMemoryProposal,
  AgentMemoryProposalV2,
  NostrEvent,
} from '../types.ts';
import { parseTrustActionTags } from './trust-source.ts';

const HEX_64 = /^[0-9a-f]{64}$/u;
const SAFE_EXTERNAL_IRI = /^(?:https:\/\/[^<>"{}|^`\\\s]{1,990}|urn:[^<>"{}|^`\\\s]{1,995})$/u;

function invalid(message: string): never {
  throw new IntegrationApiError(400, 'invalid_memory_proposal', message);
}

const trustVouchUri = (eventId: string): string => `urn:buzz-dkg:vouch:${eventId}`;
const trustLifecycleUri = (eventId: string): string => `urn:buzz-dkg:vouch-lifecycle:${eventId}`;

function trustAttributes(entity: AgentMemoryEntity): Map<string, string | number | boolean> {
  return new Map(
    (entity.attributes ?? []).map((attribute) => [attribute.predicate, attribute.value]),
  );
}

function trustRelationTarget(
  proposal: AgentMemoryProposalV2,
  sourceId: string,
  predicate: string,
): AgentMemoryEntity {
  const matches = proposal.relations.filter(
    (relation) => relation.subject === sourceId && relation.predicate === predicate,
  );
  if (matches.length !== 1) {
    invalid(`dkg-trust@1 action must have exactly one ${predicate}`);
  }
  const target = proposal.entities.find((entity) => entity.id === matches[0]!.object);
  if (!target) invalid(`dkg-trust@1 ${predicate} target is missing`);
  return target;
}

function validateTrustPerson(
  person: AgentMemoryEntity,
  expectedUri: string,
  role: 'issuer' | 'subject',
): void {
  if (
    person.type !== 'schema:Person' ||
    person.locator?.kind !== 'uri' ||
    person.locator.uri !== expectedUri ||
    person.description ||
    person.attributes?.length
  ) {
    invalid(
      `dkg-trust@1 ${role} must resolve to the signed source ${role === 'issuer' ? 'author' : 'p tag'}`,
    );
  }
}

function validateActiveVouch(
  source: NostrEvent,
  subjectPubkey: string,
  proposal: AgentMemoryProposalV2,
): void {
  if (!source.content.trim() || source.content.length > 1_000) {
    invalid('dkg-trust@1 signed vouch explanation must contain 1 to 1,000 characters');
  }
  const vouches = proposal.entities.filter((entity) => entity.type === 'trust:Vouch');
  if (vouches.length !== 1) invalid('dkg-trust@1 proposal must contain exactly one trust:Vouch');
  const vouch = vouches[0]!;
  if (vouch.description !== source.content) {
    invalid('dkg-trust@1 vouch explanation must match the signed source content');
  }
  if (vouch.locator?.kind !== 'uri' || vouch.locator.uri !== trustVouchUri(source.id)) {
    invalid('dkg-trust@1 vouch must use its deterministic signed-event identifier');
  }
  const attributes = trustAttributes(vouch);
  if (
    attributes.size !== 2 ||
    (vouch.attributes ?? []).length !== 2 ||
    attributes.get('trust:status') !== 'active' ||
    attributes.get('trust:scope') !== 'channel'
  ) {
    invalid('new dkg-trust@1 vouches must contain only active status and channel scope');
  }

  const issuer = trustRelationTarget(proposal, vouch.id, 'trust:issuer');
  const subject = trustRelationTarget(proposal, vouch.id, 'trust:subject');
  const issuerUri = `urn:nostr:pubkey:${source.pubkey}`;
  const subjectUri = `urn:nostr:pubkey:${subjectPubkey}`;
  validateTrustPerson(issuer, issuerUri, 'issuer');
  validateTrustPerson(subject, subjectUri, 'subject');

  const rTags = source.tags.filter((tag) => tag[0] === 'r');
  const eTags = source.tags.filter((tag) => tag[0] === 'e');
  if (
    rTags.length > 8 ||
    rTags.some((tag) => tag.length !== 2 || !SAFE_EXTERNAL_IRI.test(tag[1] ?? ''))
  ) {
    invalid('dkg-trust@1 vouches may identify at most 8 valid r-tag evidence targets');
  }
  if (
    eTags.length > 8 ||
    eTags.some((tag) => tag.length !== 4 || !HEX_64.test(tag[1] ?? '') || tag[3] !== 'evidence')
  ) {
    invalid("dkg-trust@1 evidence e tags must use the 'evidence' marker");
  }
  const evidenceTargets = rTags.map((tag) => tag[1]!);
  const evidenceSources = eTags.map((tag) => `urn:nostr:event:${tag[1]!}`);
  if (
    (evidenceSources.length !== 0 && evidenceSources.length !== evidenceTargets.length) ||
    new Set(evidenceTargets).size !== evidenceTargets.length ||
    new Set(evidenceSources).size !== evidenceSources.length
  ) {
    invalid(
      'dkg-trust@1 signed evidence references must be unique and pair each source with one target',
    );
  }
  // Nostr signs tag order. When source events are supplied, each evidence e-tag is therefore
  // paired with the r-tag at the same index rather than validated as an unrelated global set.
  const signedEvidence = new Map(
    evidenceTargets.map((target, index) => [target, evidenceSources[index]] as const),
  );

  const supportedBy = proposal.relations.filter(
    (relation) => relation.subject === vouch.id && relation.predicate === 'trust:supportedBy',
  );
  const referenceIds = new Set(supportedBy.map((relation) => relation.object));
  const references = proposal.entities.filter(
    (entity) => entity.type === 'trust:EvidenceReference',
  );
  if (
    references.length !== evidenceTargets.length ||
    supportedBy.length !== references.length ||
    referenceIds.size !== references.length ||
    references.some((reference) => !referenceIds.has(reference.id))
  ) {
    invalid('dkg-trust@1 evidence entities must exactly match supportedBy relations');
  }
  const projectedTargets: string[] = [];
  for (const reference of references) {
    const referenceAttributes = trustAttributes(reference);
    const target = referenceAttributes.get('trust:evidenceTarget');
    const evidenceSource = referenceAttributes.get('trust:evidenceSource');
    if (
      (reference.attributes ?? []).length !== referenceAttributes.size ||
      referenceAttributes.size < 1 ||
      referenceAttributes.size > 2 ||
      typeof target !== 'string' ||
      (evidenceSource !== undefined && typeof evidenceSource !== 'string') ||
      reference.locator ||
      reference.description
    ) {
      invalid('dkg-trust@1 evidence references contain unsupported data');
    }
    projectedTargets.push(target);
    if (evidenceSource !== signedEvidence.get(target)) {
      invalid('dkg-trust@1 projected evidence target/source pairing must match signed tag order');
    }
  }
  if (
    projectedTargets.length !== new Set(projectedTargets).size ||
    evidenceTargets.some((target) => !projectedTargets.includes(target))
  ) {
    invalid('dkg-trust@1 projected evidence must exactly match the signed r and e tags');
  }

  const projectionIds = new Set([
    vouch.id,
    issuer.id,
    subject.id,
    ...references.map(({ id }) => id),
  ]);
  if (
    proposal.entities.length !== projectionIds.size ||
    proposal.entities.length !== 3 + references.length
  ) {
    invalid('dkg-trust@1 vouch proposals contain unsupported projection entities');
  }
  const allowedRelations = new Set(['trust:issuer', 'trust:subject', 'trust:supportedBy']);
  if (
    proposal.relations.length !== 2 + references.length ||
    proposal.relations.some(
      (relation) => relation.subject !== vouch.id || !allowedRelations.has(relation.predicate),
    )
  ) {
    invalid('dkg-trust@1 vouch proposals contain unsupported relations');
  }
}

function validateVouchLifecycle(
  source: NostrEvent,
  subjectPubkey: string,
  action: 'revoke' | 'supersede',
  proposal: AgentMemoryProposalV2,
): void {
  if (!source.content.trim() || source.content.length > 1_000) {
    invalid('dkg-trust@1 signed lifecycle reason must contain 1 to 1,000 characters');
  }
  const targetTags = source.tags.filter((tag) => tag[0] === 'e' && tag[3] === 'target');
  const replacementTags = source.tags.filter((tag) => tag[0] === 'e' && tag[3] === 'replacement');
  const allEventTags = source.tags.filter((tag) => tag[0] === 'e');
  if (
    targetTags.length !== 1 ||
    targetTags[0]!.length !== 4 ||
    !HEX_64.test(targetTags[0]![1] ?? '') ||
    allEventTags.length !== targetTags.length + replacementTags.length
  ) {
    invalid("dkg-trust@1 lifecycle source must identify exactly one 'target' vouch event");
  }
  if (
    (action === 'revoke' && replacementTags.length !== 0) ||
    (action === 'supersede' &&
      (replacementTags.length !== 1 ||
        replacementTags[0]!.length !== 4 ||
        !HEX_64.test(replacementTags[0]![1] ?? '')))
  ) {
    invalid('dkg-trust@1 supersede actions require exactly one replacement event');
  }
  const targetId = targetTags[0]![1]!;
  const replacementId = replacementTags[0]?.[1];
  if (replacementId === targetId) invalid('dkg-trust@1 replacement must differ from its target');

  const actions = proposal.entities.filter((entity) => entity.type === 'trust:VouchLifecycle');
  if (actions.length !== 1) {
    invalid('dkg-trust@1 lifecycle proposal must contain exactly one trust:VouchLifecycle');
  }
  const lifecycle = actions[0]!;
  if (
    lifecycle.locator?.kind !== 'uri' ||
    lifecycle.locator.uri !== trustLifecycleUri(source.id) ||
    lifecycle.description !== source.content
  ) {
    invalid('dkg-trust@1 lifecycle action must match its signed source event');
  }
  const attributes = trustAttributes(lifecycle);
  const expectedStatus = action === 'revoke' ? 'revoked' : 'superseded';
  if (
    attributes.get('trust:status') !== expectedStatus ||
    attributes.get('trust:scope') !== 'channel' ||
    attributes.get('trust:targetVouch') !== trustVouchUri(targetId) ||
    (action === 'revoke' && attributes.size !== 3) ||
    (action === 'supersede' &&
      (attributes.size !== 4 ||
        attributes.get('trust:replacementVouch') !== trustVouchUri(replacementId!)))
  ) {
    invalid('dkg-trust@1 lifecycle attributes must exactly match the signed action');
  }

  const issuer = trustRelationTarget(proposal, lifecycle.id, 'trust:issuer');
  const subject = trustRelationTarget(proposal, lifecycle.id, 'trust:subject');
  validateTrustPerson(issuer, `urn:nostr:pubkey:${source.pubkey}`, 'issuer');
  validateTrustPerson(subject, `urn:nostr:pubkey:${subjectPubkey}`, 'subject');
  if (proposal.entities.length !== 3 || new Set([lifecycle.id, issuer.id, subject.id]).size !== 3) {
    invalid('dkg-trust@1 lifecycle proposals contain unsupported projection entities');
  }
  if (
    proposal.relations.length !== 2 ||
    proposal.relations.some(
      (relation) =>
        relation.subject !== lifecycle.id ||
        !new Set(['trust:issuer', 'trust:subject']).has(relation.predicate),
    )
  ) {
    invalid('dkg-trust@1 lifecycle proposals contain unsupported relations');
  }
}

export function validateTrustProposal(
  envelope: AgentMemoryEnvelope,
  proposal: AgentMemoryProposal,
): void {
  if (proposal.schemaVersion !== 2 || !proposal.profiles.includes('dkg-trust@1')) return;
  const profiles = new Set(proposal.profiles);
  if (profiles.size !== 2 || !profiles.has('dkg-memory@1') || !profiles.has('dkg-trust@1')) {
    invalid('dkg-trust@1 proposals cannot mix trust with other memory profiles');
  }
  if (envelope.sourceEvents.length !== 1) {
    invalid('dkg-trust@1 proposals must reference exactly one signed vouch event');
  }
  const source = envelope.sourceEvents[0]!;
  if (source.kind !== 1985 || source.pubkey !== envelope.requesterPubkey) {
    invalid('dkg-trust@1 source must be a kind 1985 event signed by the requester');
  }
  const tags = parseTrustActionTags(source.tags);
  if (!tags.ok && tags.reason === 'label') {
    invalid('dkg-trust@1 source must use a supported buzz.wot action label');
  }
  if (!tags.ok) {
    invalid('dkg-trust@1 source must identify exactly one p-tag subject');
  }
  const issuerUri = `urn:nostr:pubkey:${source.pubkey}`;
  const subjectUri = `urn:nostr:pubkey:${tags.subjectPubkey}`;
  if (issuerUri === subjectUri) invalid('dkg-trust@1 does not allow self-vouches');
  if (tags.action === 'vouch') validateActiveVouch(source, tags.subjectPubkey, proposal);
  else validateVouchLifecycle(source, tags.subjectPubkey, tags.action, proposal);
}
