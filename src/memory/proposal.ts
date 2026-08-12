import { createHash } from 'node:crypto';
import { verifyEvent, type Event as SignedNostrEvent } from 'nostr-tools';
import {
  BUZZ,
  NOSTR,
  PROV,
  RDF,
  SCHEMA,
  channelUri,
  eventUri,
  pubkeyUri,
  sourceSetDigest,
} from '../distill/deterministic.ts';
import { IntegrationApiError } from '../errors.ts';
import type {
  AgentMemoryAttribute,
  AgentMemoryEntity,
  AgentMemoryEnvelope,
  AgentMemoryItem,
  AgentMemoryItemKind,
  AgentMemoryLocator,
  AgentMemoryProposal,
  AgentMemoryProposalV1,
  AgentMemoryProposalV2,
  AgentMemoryProfileId,
  AgentMemoryRelation,
  DistillResult,
  NostrEvent,
  Quad,
} from '../types.ts';
import { DKG_MEMORY_PROPOSAL_KIND } from '../types.ts';
import {
  expandProfileTerm,
  PREFIXES,
  PROFILE_IRIS,
  profileAllowsRelation,
  profileAllowsType,
  profileAttributeDatatype,
} from './profiles.ts';
import { canonicalExternalIdentityUri, canonicalRepositoryIdentityUrl } from './identity.ts';
import { validateTrustProposal } from './trust-profile.ts';

const HEX_64 = /^[0-9a-f]{64}$/u;
const CHANNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ITEM_KINDS = new Set(['decision', 'claim', 'question', 'task', 'relationship']);
const PROFILE_IDS = new Set<AgentMemoryProfileId>([
  'dkg-memory@1',
  'dkg-software@1',
  'dkg-trust@1',
]);
const LOCAL_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const GITHUB_RESOURCE = new Set(['repository', 'pull-request', 'issue', 'commit']);
const CODE_SYMBOL_KIND = new Set(['function', 'class', 'interface', 'type-alias', 'enum']);
const GITHUB_LOCATOR_TYPES = new Set([
  'github:Repository',
  'github:PullRequest',
  'github:Issue',
  'github:Commit',
]);
const CODE_LOCATOR_TYPES = new Set([
  'code:Package',
  'code:File',
  'code:Function',
  'code:Class',
  'code:Interface',
  'code:TypeAlias',
  'code:Enum',
]);
const EXTERNAL_IDENTITY_TYPES = new Set(['schema:Project']);
const SAFE_EXTERNAL_IRI = /^(?:https:\/\/[^<>"{}|^`\\\s]{1,990}|urn:[^<>"{}|^`\\\s]{1,995})$/u;
const MAX_SOURCES = 16;
const MAX_ITEMS = 50;
const MAX_ENTITIES = 100;
const MAX_RELATIONS = 200;
const MAX_ATTRIBUTES = 20;

function invalid(message: string): never {
  throw new IntegrationApiError(400, 'invalid_memory_proposal', message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) invalid(`${label} contains unexpected field '${extra}'`);
}

function text(value: unknown, label: string, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value, 'utf8') > max ||
    /\p{Cc}/u.test(value)
  ) {
    invalid(`${label} must contain 1 to ${max} non-control UTF-8 bytes`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  return value === undefined ? undefined : text(value, label, max);
}

function canonicalExternalUri(value: string, label: string): string {
  try {
    return canonicalExternalIdentityUri(value);
  } catch (error) {
    invalid(`${label} ${(error as Error).message}`);
  }
}

function canonicalRepositoryUrl(value: string, label: string): string {
  try {
    return canonicalRepositoryIdentityUrl(value);
  } catch (error) {
    invalid(`${label} ${(error as Error).message}`);
  }
}

function parseItem(raw: unknown, index: number): AgentMemoryItem {
  const value = object(raw, `items[${index}]`);
  exactKeys(
    value,
    ['kind', 'text', 'subject', 'predicate', 'object', 'confidence'],
    `items[${index}]`,
  );
  if (typeof value.kind !== 'string' || !ITEM_KINDS.has(value.kind)) {
    invalid(`items[${index}].kind is invalid`);
  }
  const kind = value.kind as AgentMemoryItemKind;
  const itemText = text(value.text, `items[${index}].text`, 2_000);
  const subject = optionalText(value.subject, `items[${index}].subject`, 500);
  const predicate = optionalText(value.predicate, `items[${index}].predicate`, 200);
  const itemObject = optionalText(value.object, `items[${index}].object`, 500);
  let confidence: number | undefined;
  if (value.confidence !== undefined) {
    if (typeof value.confidence !== 'number' || value.confidence < 0 || value.confidence > 1) {
      invalid(`items[${index}].confidence must be between 0 and 1`);
    }
    confidence = value.confidence;
  }
  if (kind === 'relationship') {
    if (!subject || !predicate || !itemObject) {
      invalid(`items[${index}] relationships require subject, predicate and object`);
    }
    return {
      kind,
      text: itemText,
      subject,
      predicate,
      object: itemObject,
      ...(confidence === undefined ? {} : { confidence }),
    };
  }
  return {
    kind,
    text: itemText,
    ...(subject ? { subject } : {}),
    ...(predicate ? { predicate } : {}),
    ...(itemObject ? { object: itemObject } : {}),
    ...(confidence === undefined ? {} : { confidence }),
  };
}

function parseProposalV1(value: Record<string, unknown>): AgentMemoryProposalV1 {
  exactKeys(value, ['schemaVersion', 'summary', 'items', 'model', 'promptVersion'], 'proposal');
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > MAX_ITEMS) {
    invalid(`proposal.items must contain 1 to ${MAX_ITEMS} entries`);
  }
  const proposal: AgentMemoryProposalV1 = {
    schemaVersion: 1,
    summary: text(value.summary, 'proposal.summary', 1_000),
    items: value.items.map(parseItem),
  };
  const model = optionalText(value.model, 'proposal.model', 200);
  const promptVersion = optionalText(value.promptVersion, 'proposal.promptVersion', 200);
  if (model) proposal.model = model;
  if (promptVersion) proposal.promptVersion = promptVersion;
  return proposal;
}

function parseProfiles(raw: unknown): AgentMemoryProfileId[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3) {
    invalid('proposal.profiles must contain 1 to 3 profile identifiers');
  }
  const profiles = raw.map((profile, index) => {
    if (typeof profile !== 'string' || !PROFILE_IDS.has(profile as AgentMemoryProfileId)) {
      invalid(`proposal.profiles[${index}] is unsupported`);
    }
    return profile as AgentMemoryProfileId;
  });
  if (new Set(profiles).size !== profiles.length) invalid('proposal.profiles contains duplicates');
  if (!profiles.includes('dkg-memory@1')) invalid("proposal.profiles must include 'dkg-memory@1'");
  return profiles;
}

function parseLocator(raw: unknown, label: string): AgentMemoryLocator {
  const value = object(raw, label);
  const kind = value.kind;
  if (kind === 'uri') {
    exactKeys(value, ['kind', 'uri'], label);
    const uri = text(value.uri, `${label}.uri`, 1_000);
    if (!SAFE_EXTERNAL_IRI.test(uri)) invalid(`${label}.uri must be an HTTPS or URN identifier`);
    return { kind, uri: canonicalExternalUri(uri, `${label}.uri`) };
  }
  if (kind === 'github') {
    exactKeys(value, ['kind', 'repository', 'resource', 'id'], label);
    const repository = text(value.repository, `${label}.repository`, 201);
    if (!GITHUB_REPOSITORY.test(repository)) invalid(`${label}.repository is invalid`);
    if (typeof value.resource !== 'string' || !GITHUB_RESOURCE.has(value.resource)) {
      invalid(`${label}.resource is invalid`);
    }
    const resource = value.resource as Extract<AgentMemoryLocator, { kind: 'github' }>['resource'];
    const id = optionalText(value.id, `${label}.id`, 200);
    if (resource === 'repository' && id) invalid(`${label}.id is not used for repositories`);
    if (resource !== 'repository' && !id) invalid(`${label}.id is required for ${resource}`);
    if ((resource === 'pull-request' || resource === 'issue') && !/^[1-9][0-9]{0,9}$/u.test(id!)) {
      invalid(`${label}.id must be a positive integer for ${resource}`);
    }
    if (resource === 'commit' && !/^[0-9a-f]{7,64}$/iu.test(id!)) {
      invalid(`${label}.id must be a hexadecimal commit id`);
    }
    return { kind, repository, resource, ...(id ? { id } : {}) };
  }
  if (kind === 'code') {
    exactKeys(value, ['kind', 'repository', 'package', 'path', 'symbol', 'symbolKind'], label);
    const repository = canonicalRepositoryUrl(
      text(value.repository, `${label}.repository`, 1_000),
      `${label}.repository`,
    );
    const packageName = text(value.package, `${label}.package`, 214);
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/iu.test(packageName)) {
      invalid(`${label}.package is invalid`);
    }
    const path = optionalText(value.path, `${label}.path`, 1_000);
    if (path && (path.startsWith('/') || path.split('/').includes('..') || path.includes('\\'))) {
      invalid(`${label}.path must be package-relative`);
    }
    const symbol = optionalText(value.symbol, `${label}.symbol`, 500);
    const symbolKind = optionalText(value.symbolKind, `${label}.symbolKind`, 20);
    if ((symbol || symbolKind) && (!path || !symbol || !symbolKind)) {
      invalid(`${label} symbols require path, symbol and symbolKind`);
    }
    if (symbolKind && !CODE_SYMBOL_KIND.has(symbolKind)) invalid(`${label}.symbolKind is invalid`);
    return {
      kind,
      repository,
      package: packageName,
      ...(path ? { path } : {}),
      ...(symbol ? { symbol } : {}),
      ...(symbolKind
        ? {
            symbolKind: symbolKind as Extract<AgentMemoryLocator, { kind: 'code' }>['symbolKind'],
          }
        : {}),
    };
  }
  invalid(`${label}.kind is invalid`);
}

function parseAttribute(
  raw: unknown,
  label: string,
  profiles: readonly AgentMemoryProfileId[],
): AgentMemoryAttribute {
  const value = object(raw, label);
  exactKeys(value, ['predicate', 'value'], label);
  const predicate = text(value.predicate, `${label}.predicate`, 100);
  const datatype = profileAttributeDatatype(profiles, predicate);
  if (!datatype || !expandProfileTerm(predicate)) invalid(`${label}.predicate is not allowed`);
  if (!['string', 'number', 'boolean'].includes(typeof value.value)) {
    invalid(`${label}.value must be a string, number or boolean`);
  }
  if (typeof value.value === 'string') text(value.value, `${label}.value`, 4_000);
  if (datatype === 'integer' && !Number.isSafeInteger(value.value)) {
    invalid(`${label}.value must be an integer`);
  }
  if (datatype === 'decimal' && typeof value.value !== 'number') {
    invalid(`${label}.value must be a number`);
  }
  if (datatype === 'boolean' && typeof value.value !== 'boolean') {
    invalid(`${label}.value must be a boolean`);
  }
  if (
    datatype === 'dateTime' &&
    (typeof value.value !== 'string' || !Number.isFinite(Date.parse(value.value)))
  ) {
    invalid(`${label}.value must be an ISO date-time`);
  }
  if (
    datatype === 'anyURI' &&
    (typeof value.value !== 'string' || !SAFE_EXTERNAL_IRI.test(value.value))
  ) {
    invalid(`${label}.value must be an HTTPS or URN identifier`);
  }
  if (
    predicate === 'decisions:status' &&
    !new Set(['proposed', 'accepted', 'rejected', 'superseded']).has(String(value.value))
  ) {
    invalid(`${label}.value is not a supported decision status`);
  }
  if (
    predicate === 'tasks:status' &&
    !new Set(['todo', 'in_progress', 'blocked', 'done', 'cancelled']).has(String(value.value))
  ) {
    invalid(`${label}.value is not a supported task status`);
  }
  if (
    predicate === 'trust:status' &&
    !new Set(['active', 'revoked', 'superseded']).has(String(value.value))
  ) {
    invalid(`${label}.value is not a supported trust status`);
  }
  if (predicate === 'trust:scope' && value.value !== 'channel') {
    invalid(`${label}.value is not a supported trust scope`);
  }
  return { predicate, value: value.value as string | number | boolean };
}

function parseEntity(
  raw: unknown,
  index: number,
  profiles: readonly AgentMemoryProfileId[],
): AgentMemoryEntity {
  const label = `entities[${index}]`;
  const value = object(raw, label);
  exactKeys(value, ['id', 'type', 'name', 'description', 'locator', 'attributes'], label);
  const id = text(value.id, `${label}.id`, 64);
  if (!LOCAL_ID.test(id)) invalid(`${label}.id is invalid`);
  const type = text(value.type, `${label}.type`, 100);
  if (!profileAllowsType(profiles, type) || !expandProfileTerm(type)) {
    invalid(`${label}.type is not allowed by the selected profiles`);
  }
  const description = optionalText(value.description, `${label}.description`, 4_000);
  const locator =
    value.locator === undefined ? undefined : parseLocator(value.locator, `${label}.locator`);
  if (GITHUB_LOCATOR_TYPES.has(type) && locator?.kind !== 'github') {
    invalid(`${label}.locator must provide a stable github identifier for ${type}`);
  }
  if (CODE_LOCATOR_TYPES.has(type) && locator?.kind !== 'code') {
    invalid(`${label}.locator must provide a stable code identifier for ${type}`);
  }
  if (EXTERNAL_IDENTITY_TYPES.has(type) && locator?.kind !== 'uri') {
    invalid(`${label}.locator must provide a stable external identifier for ${type}`);
  }
  if (locator?.kind === 'github' && !type.startsWith('github:')) {
    invalid(`${label}.locator kind github requires a github type`);
  }
  if (locator?.kind === 'github') {
    const expectedType = {
      repository: 'github:Repository',
      'pull-request': 'github:PullRequest',
      issue: 'github:Issue',
      commit: 'github:Commit',
    }[locator.resource];
    if (type !== expectedType) invalid(`${label}.locator resource does not match its entity type`);
  }
  if (locator?.kind === 'code' && !type.startsWith('code:')) {
    invalid(`${label}.locator kind code requires a code type`);
  }
  if (locator?.kind === 'code') {
    const symbolType = locator.symbolKind
      ? {
          function: 'code:Function',
          class: 'code:Class',
          interface: 'code:Interface',
          'type-alias': 'code:TypeAlias',
          enum: 'code:Enum',
        }[locator.symbolKind]
      : null;
    if (symbolType && type !== symbolType) {
      invalid(`${label}.locator symbolKind does not match its entity type`);
    }
    if (!locator.symbol && locator.path && type !== 'code:File') {
      invalid(`${label}.locator path without a symbol requires code:File`);
    }
    if (!locator.path && type !== 'code:Package') {
      invalid(`${label}.locator without a path requires code:Package`);
    }
  }
  let entityAttributes: AgentMemoryAttribute[] | undefined;
  if (value.attributes !== undefined) {
    if (!Array.isArray(value.attributes) || value.attributes.length > MAX_ATTRIBUTES) {
      invalid(`${label}.attributes must contain at most ${MAX_ATTRIBUTES} entries`);
    }
    entityAttributes = value.attributes.map((item, attributeIndex) =>
      parseAttribute(item, `${label}.attributes[${attributeIndex}]`, profiles),
    );
    const predicates = entityAttributes.map((item) => item.predicate);
    if (new Set(predicates).size !== predicates.length)
      invalid(`${label}.attributes contains duplicate predicates`);
  }
  return {
    id,
    type,
    name: text(value.name, `${label}.name`, 500),
    ...(description ? { description } : {}),
    ...(locator ? { locator } : {}),
    ...(entityAttributes ? { attributes: entityAttributes } : {}),
  };
}

function parseRelation(
  raw: unknown,
  index: number,
  profiles: readonly AgentMemoryProfileId[],
  entityIds: ReadonlySet<string>,
): AgentMemoryRelation {
  const label = `relations[${index}]`;
  const value = object(raw, label);
  exactKeys(value, ['subject', 'predicate', 'object', 'confidence'], label);
  const subject = text(value.subject, `${label}.subject`, 64);
  const predicate = text(value.predicate, `${label}.predicate`, 100);
  const relationObject = text(value.object, `${label}.object`, 64);
  if (!entityIds.has(subject) || !entityIds.has(relationObject)) {
    invalid(`${label} endpoints must reference proposal entities`);
  }
  if (!profileAllowsRelation(profiles, predicate) || !expandProfileTerm(predicate)) {
    invalid(`${label}.predicate is not allowed by the selected profiles`);
  }
  if (
    value.confidence !== undefined &&
    (typeof value.confidence !== 'number' || value.confidence < 0 || value.confidence > 1)
  ) {
    invalid(`${label}.confidence must be between 0 and 1`);
  }
  return {
    subject,
    predicate,
    object: relationObject,
    ...(value.confidence === undefined ? {} : { confidence: value.confidence }),
  };
}

function parseProposalV2(value: Record<string, unknown>): AgentMemoryProposalV2 {
  exactKeys(
    value,
    ['schemaVersion', 'profiles', 'summary', 'entities', 'relations', 'model', 'promptVersion'],
    'proposal',
  );
  const profiles = parseProfiles(value.profiles);
  if (
    !Array.isArray(value.entities) ||
    value.entities.length < 1 ||
    value.entities.length > MAX_ENTITIES
  ) {
    invalid(`proposal.entities must contain 1 to ${MAX_ENTITIES} entries`);
  }
  const entities = value.entities.map((entity, index) => parseEntity(entity, index, profiles));
  const entityIds = new Set(entities.map((entity) => entity.id));
  if (entityIds.size !== entities.length) invalid('proposal.entities contains duplicate ids');
  if (!Array.isArray(value.relations) || value.relations.length > MAX_RELATIONS) {
    invalid(`proposal.relations must contain 0 to ${MAX_RELATIONS} entries`);
  }
  const proposal: AgentMemoryProposalV2 = {
    schemaVersion: 2,
    profiles,
    summary: text(value.summary, 'proposal.summary', 1_000),
    entities,
    relations: value.relations.map((relation, index) =>
      parseRelation(relation, index, profiles, entityIds),
    ),
  };
  const model = optionalText(value.model, 'proposal.model', 200);
  const promptVersion = optionalText(value.promptVersion, 'proposal.promptVersion', 200);
  if (model) proposal.model = model;
  if (promptVersion) proposal.promptVersion = promptVersion;
  return proposal;
}

export function parseAgentMemoryProposal(content: string): AgentMemoryProposal {
  if (Buffer.byteLength(content, 'utf8') > 64 * 1024) invalid('proposal content is too large');
  let raw: unknown;
  try {
    raw = JSON.parse(content) as unknown;
  } catch {
    invalid('proposal content must be valid JSON');
  }
  const value = object(raw, 'proposal');
  if (value.schemaVersion === 1) return parseProposalV1(value);
  if (value.schemaVersion === 2) return parseProposalV2(value);
  invalid('proposal.schemaVersion must be 1 or 2');
}

function parseEvent(raw: unknown, label: string): NostrEvent {
  const event = object(raw, label) as unknown as NostrEvent;
  if (
    !HEX_64.test(event.id) ||
    !HEX_64.test(event.pubkey) ||
    !Number.isSafeInteger(event.created_at) ||
    !Number.isSafeInteger(event.kind) ||
    !Array.isArray(event.tags) ||
    typeof event.content !== 'string' ||
    typeof event.sig !== 'string' ||
    !/^[0-9a-f]{128}$/u.test(event.sig)
  ) {
    invalid(`${label} is not a complete signed Nostr event`);
  }
  if (
    !event.tags.every((tag) => Array.isArray(tag) && tag.every((part) => typeof part === 'string'))
  ) {
    invalid(`${label}.tags is invalid`);
  }
  if (!verifyEvent(event as SignedNostrEvent)) invalid(`${label} signature or event id is invalid`);
  // Rebuild in a fixed field order so semantically identical JSON objects have
  // one durable representation for idempotency checks.
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  };
}

function tagValues(event: NostrEvent, name: string): string[] {
  return event.tags.filter((tag) => tag[0] === name && tag[1]).map((tag) => tag[1]!);
}

export function parseAgentMemoryEnvelope(raw: unknown): {
  envelope: AgentMemoryEnvelope;
  proposal: AgentMemoryProposal;
} {
  const value = object(raw, 'request');
  exactKeys(value, ['channelId', 'requesterPubkey', 'proposalEvent', 'sourceEvents'], 'request');
  if (typeof value.channelId !== 'string' || !CHANNEL_ID.test(value.channelId)) {
    invalid('channelId is invalid');
  }
  if (typeof value.requesterPubkey !== 'string' || !HEX_64.test(value.requesterPubkey)) {
    invalid('requesterPubkey is invalid');
  }
  if (
    !Array.isArray(value.sourceEvents) ||
    value.sourceEvents.length < 1 ||
    value.sourceEvents.length > MAX_SOURCES
  ) {
    invalid(`sourceEvents must contain 1 to ${MAX_SOURCES} events`);
  }
  const proposalEvent = parseEvent(value.proposalEvent, 'proposalEvent');
  const sourceEvents = value.sourceEvents.map((event, index) =>
    parseEvent(event, `sourceEvents[${index}]`),
  );
  const channelId = value.channelId;
  const requesterPubkey = value.requesterPubkey.toLowerCase();
  if (proposalEvent.kind !== DKG_MEMORY_PROPOSAL_KIND)
    invalid(`proposalEvent.kind must be ${DKG_MEMORY_PROPOSAL_KIND}`);
  if (proposalEvent.pubkey !== requesterPubkey)
    invalid('proposalEvent author does not match requesterPubkey');
  const channels = tagValues(proposalEvent, 'h');
  if (channels.length !== 1 || channels[0] !== channelId)
    invalid('proposalEvent must contain exactly one matching h tag');
  if (!tagValues(proposalEvent, 't').includes('dkg-memory-proposal')) {
    invalid("proposalEvent must contain a 'dkg-memory-proposal' t tag");
  }
  const sourceTags = proposalEvent.tags.filter((tag) => tag[0] === 'e');
  if (sourceTags.some((tag) => tag[3] !== 'source')) {
    invalid("every proposalEvent e tag must use the 'source' marker");
  }
  const referenced = sourceTags.map((tag) => tag[1] ?? '');
  if (referenced.length !== new Set(referenced).size)
    invalid('proposalEvent contains duplicate source references');
  const actual = sourceEvents.map((event) => event.id);
  if (actual.length !== new Set(actual).size) invalid('sourceEvents contains duplicate events');
  if (referenced.length !== actual.length || actual.some((id) => !referenced.includes(id))) {
    invalid('proposalEvent source references do not match sourceEvents');
  }
  for (const [index, event] of sourceEvents.entries()) {
    const eventChannels = tagValues(event, 'h');
    if (eventChannels.length !== 1 || eventChannels[0] !== channelId) {
      invalid(`sourceEvents[${index}] does not belong to the requested channel`);
    }
  }
  if (!sourceEvents.some((event) => event.pubkey === requesterPubkey)) {
    invalid('at least one source event must be authored by the proposing agent');
  }
  // The signed proposal tag order is authoritative. Relay/database row order
  // is a transport detail and must not turn a legitimate retry into a conflict.
  const sourcesById = new Map(sourceEvents.map((event) => [event.id, event]));
  const orderedSourceEvents = referenced.map((id) => sourcesById.get(id)!);
  const envelope = { channelId, requesterPubkey, proposalEvent, sourceEvents: orderedSourceEvents };
  const proposal = parseAgentMemoryProposal(proposalEvent.content);
  validateTrustProposal(envelope, proposal);
  return {
    envelope,
    proposal,
  };
}

const literal = (value: unknown): string => JSON.stringify(String(value));
const integer = (value: number): string => `"${value}"^^<http://www.w3.org/2001/XMLSchema#integer>`;
const decimal = (value: number): string => `"${value}"^^<http://www.w3.org/2001/XMLSchema#decimal>`;
const instant = (value: number): string =>
  `"${new Date(value * 1_000).toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`;

function itemUri(digest: string, index: number): string {
  return `urn:buzz-dkg:memory-item:${digest}:${index + 1}`;
}

function semanticType(kind: AgentMemoryItem['kind']): string {
  return `${BUZZ}${kind[0]!.toUpperCase()}${kind.slice(1)}`;
}

function encodeId(value: string): string {
  return encodeURIComponent(value).replace(/%[0-9a-f]{2}/giu, (escape) => escape.toUpperCase());
}

interface RepositoryIdentity {
  canonicalUrl: string;
  key: string;
  uri: string;
  githubSlug: string | null;
}

function repositoryIdentity(canonicalUrl: string): RepositoryIdentity {
  const url = new URL(canonicalUrl);
  // `host` retains a non-default port, so independently hosted forges on the
  // same DNS name cannot collapse into one repository identity.
  const key = `${url.host}${url.pathname}`;
  const githubSlug =
    url.hostname === 'github.com' ? url.pathname.split('/').filter(Boolean).join('/') : null;
  return {
    canonicalUrl,
    key,
    uri: githubSlug ? `urn:dkg:github:repo:${githubSlug}` : `urn:dkg:repository:${encodeId(key)}`,
    githubSlug,
  };
}

function githubRepositoryIdentity(repository: string): RepositoryIdentity {
  return repositoryIdentity(`https://github.com/${repository.toLowerCase()}`);
}

type CodeLocator = Extract<AgentMemoryLocator, { kind: 'code' }>;

function codeIdentity(locator: CodeLocator): {
  repository: RepositoryIdentity;
  packageUri: string;
  fileUri: string | null;
  entityUri: string;
} {
  const repository = repositoryIdentity(locator.repository);
  const scope = encodeId(repository.key);
  const packageUri = `urn:dkg:code:package:${scope}/${encodeId(locator.package)}`;
  if (!locator.path) return { repository, packageUri, fileUri: null, entityUri: packageUri };
  const fileUri = `urn:dkg:code:file:${scope}/${encodeId(locator.package)}/${encodeId(locator.path)}`;
  return {
    repository,
    packageUri,
    fileUri,
    entityUri: locator.symbol
      ? `${fileUri}#${locator.symbolKind}:${encodeId(locator.symbol)}`
      : fileUri,
  };
}

function entityUri(digest: string, entity: AgentMemoryEntity): string {
  const locator = entity.locator;
  if (!locator) return `urn:buzz-dkg:entity:${digest}:${entity.id}`;
  if (locator.kind === 'uri') return locator.uri;
  if (locator.kind === 'github') {
    const repository = githubRepositoryIdentity(locator.repository);
    if (locator.resource === 'repository') return repository.uri;
    const kind = locator.resource === 'pull-request' ? 'pr' : locator.resource;
    return `urn:dkg:github:${kind}:${repository.githubSlug}/${locator.id!.toLowerCase()}`;
  }
  return codeIdentity(locator).entityUri;
}

function attributeLiteral(value: string | number | boolean, datatype: string): string {
  const XSD = 'http://www.w3.org/2001/XMLSchema#';
  if (datatype === 'integer') return `"${value}"^^<${XSD}integer>`;
  if (datatype === 'decimal') return `"${value}"^^<${XSD}decimal>`;
  if (datatype === 'boolean') return `"${value}"^^<${XSD}boolean>`;
  if (datatype === 'dateTime') {
    return `"${new Date(String(value)).toISOString()}"^^<${XSD}dateTime>`;
  }
  if (datatype === 'anyURI') return `"${String(value)}"^^<${XSD}anyURI>`;
  return literal(value);
}

function compileAgentMemoryV2(
  envelope: AgentMemoryEnvelope,
  proposal: AgentMemoryProposalV2,
): DistillResult {
  const signedSet = [envelope.proposalEvent, ...envelope.sourceEvents];
  const digest = sourceSetDigest(signedSet);
  const rootUri = `urn:buzz-dkg:memory:${digest}`;
  const activityUri = `urn:buzz-dkg:agent-memory:${digest}`;
  const quads: Quad[] = [];
  const add = (subject: string, predicate: string, value: string) =>
    quads.push({ subject, predicate, object: value });
  const sorted = [...envelope.sourceEvents].sort(
    (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
  );
  const uris = new Map(proposal.entities.map((entity) => [entity.id, entityUri(digest, entity)]));
  if (new Set(uris.values()).size !== uris.size)
    invalid('proposal.entities resolve to duplicate identifiers');

  add(rootUri, `${RDF}type`, `${PROV}Entity`);
  add(rootUri, `${RDF}type`, `${PREFIXES.memory}Memory`);
  // Retain the existing summary surface while the Buzz UI migrates to profile-aware views.
  add(rootUri, `${RDF}type`, `${BUZZ}DecisionCluster`);
  add(rootUri, `${RDF}type`, `${BUZZ}AgentMemory`);
  add(rootUri, `${SCHEMA}name`, literal(proposal.summary));
  add(rootUri, `${SCHEMA}description`, literal(proposal.summary));
  add(rootUri, `${PREFIXES.memory}sourceSetDigest`, literal(digest));
  // Preserve the digest surface used by existing channel-memory, evidence,
  // and grounded-answer readers while they learn the DKG-native profile term.
  add(rootUri, `${BUZZ}sourceSetDigest`, literal(digest));
  add(rootUri, `${PREFIXES.memory}sourceEventCount`, integer(sorted.length));
  add(rootUri, `${BUZZ}channel`, channelUri(envelope.channelId));
  add(rootUri, `${BUZZ}proposalEvent`, eventUri(envelope.proposalEvent.id));
  add(rootUri, `${PROV}wasGeneratedBy`, activityUri);
  for (const profile of [...proposal.profiles, 'buzz-nostr@1'] as const) {
    add(rootUri, `${PREFIXES.memory}profile`, PROFILE_IRIS[profile]);
  }
  for (const event of sorted) add(rootUri, `${PROV}wasDerivedFrom`, eventUri(event.id));

  add(activityUri, `${RDF}type`, `${PROV}Activity`);
  add(activityUri, `${RDF}type`, `${BUZZ}AgentMemoryProposal`);
  add(activityUri, `${PROV}wasAssociatedWith`, pubkeyUri(envelope.requesterPubkey));
  add(activityUri, `${PROV}endedAtTime`, instant(envelope.proposalEvent.created_at));
  if (proposal.model) add(activityUri, `${BUZZ}model`, literal(proposal.model));
  if (proposal.promptVersion)
    add(activityUri, `${BUZZ}promptVersion`, literal(proposal.promptVersion));
  for (const event of sorted) add(activityUri, `${PROV}used`, eventUri(event.id));

  for (const entity of proposal.entities) {
    const uri = uris.get(entity.id)!;
    const typeIri = expandProfileTerm(entity.type)!;
    add(rootUri, `${PREFIXES.memory}contains`, uri);
    add(uri, `${RDF}type`, `${PROV}Entity`);
    add(uri, `${RDF}type`, typeIri);
    add(uri, `${SCHEMA}name`, literal(entity.name));
    add(uri, `${PROV}wasAttributedTo`, pubkeyUri(envelope.requesterPubkey));
    if (entity.description) add(uri, `${SCHEMA}description`, literal(entity.description));
    for (const attribute of entity.attributes ?? []) {
      const datatype = profileAttributeDatatype(proposal.profiles, attribute.predicate)!;
      add(
        uri,
        expandProfileTerm(attribute.predicate)!,
        attributeLiteral(attribute.value, datatype),
      );
    }
    if (entity.locator?.kind === 'github') {
      const locator = entity.locator;
      const repository = githubRepositoryIdentity(locator.repository);
      const suffix =
        locator.resource === 'repository'
          ? ''
          : locator.resource === 'pull-request'
            ? `/pull/${locator.id}`
            : locator.resource === 'commit'
              ? `/commit/${locator.id}`
              : `/issues/${locator.id}`;
      add(
        uri,
        `${PREFIXES.github}url`,
        attributeLiteral(`${repository.canonicalUrl}${suffix}`, 'anyURI'),
      );
      add(repository.uri, `${RDF}type`, `${PREFIXES.software}Repository`);
      add(repository.uri, `${RDF}type`, `${PREFIXES.github}Repository`);
      add(
        repository.uri,
        `${PREFIXES.github}url`,
        attributeLiteral(repository.canonicalUrl, 'anyURI'),
      );
      if (uri !== repository.uri) add(uri, `${PREFIXES.github}inRepo`, repository.uri);
      if (locator.resource === 'commit')
        add(uri, `${PREFIXES.github}sha`, literal(locator.id!.toLowerCase()));
      if (locator.resource === 'pull-request' || locator.resource === 'issue') {
        add(uri, `${PREFIXES.github}number`, integer(Number(locator.id)));
      }
    }
    if (entity.locator?.kind === 'code') {
      const locator = entity.locator;
      const identity = codeIdentity(locator);
      add(identity.repository.uri, `${RDF}type`, `${PREFIXES.software}Repository`);
      add(
        identity.repository.uri,
        `${SCHEMA}url`,
        attributeLiteral(identity.repository.canonicalUrl, 'anyURI'),
      );
      if (identity.repository.githubSlug) {
        add(identity.repository.uri, `${RDF}type`, `${PREFIXES.github}Repository`);
        add(
          identity.repository.uri,
          `${PREFIXES.github}url`,
          attributeLiteral(identity.repository.canonicalUrl, 'anyURI'),
        );
      }
      add(identity.packageUri, `${RDF}type`, `${PREFIXES.code}Package`);
      add(identity.packageUri, `${PREFIXES.software}repository`, identity.repository.uri);
      add(uri, `${PREFIXES.software}repository`, identity.repository.uri);
      if (uri !== identity.packageUri) add(uri, `${PREFIXES.code}package`, identity.packageUri);
      if (identity.fileUri) {
        add(identity.fileUri, `${RDF}type`, `${PREFIXES.code}File`);
        if (uri !== identity.fileUri) {
          add(identity.fileUri, `${SCHEMA}name`, literal(locator.path!.split('/').at(-1)!));
        }
        add(identity.fileUri, `${PREFIXES.code}path`, literal(locator.path!));
        add(identity.fileUri, `${PREFIXES.code}package`, identity.packageUri);
        add(identity.fileUri, `${PREFIXES.software}repository`, identity.repository.uri);
      }
      if (locator.path && uri !== identity.fileUri)
        add(uri, `${PREFIXES.code}path`, literal(locator.path));
      if (locator.symbol) {
        add(uri, `${PREFIXES.code}qualifiedName`, literal(locator.symbol));
        add(uri, `${PREFIXES.code}definedIn`, identity.fileUri!);
      }
    }
    for (const event of sorted) add(uri, `${PROV}wasDerivedFrom`, eventUri(event.id));
  }

  proposal.relations.forEach((relation, index) => {
    const subject = uris.get(relation.subject)!;
    const predicate = expandProfileTerm(relation.predicate)!;
    const relationObject = uris.get(relation.object)!;
    const assertion = `urn:buzz-dkg:assertion:${digest}:${index + 1}`;
    add(subject, predicate, relationObject);
    add(rootUri, `${PREFIXES.memory}contains`, assertion);
    add(assertion, `${RDF}type`, `${PREFIXES.memory}Assertion`);
    add(assertion, `${RDF}type`, `${PREFIXES.memory}Relationship`);
    add(assertion, `${PREFIXES.memory}subject`, subject);
    add(assertion, `${PREFIXES.memory}predicate`, predicate);
    add(assertion, `${PREFIXES.memory}object`, relationObject);
    add(assertion, `${PROV}wasAttributedTo`, pubkeyUri(envelope.requesterPubkey));
    if (relation.confidence !== undefined) {
      add(assertion, `${PREFIXES.memory}confidence`, decimal(relation.confidence));
    }
    for (const event of sorted) add(assertion, `${PROV}wasDerivedFrom`, eventUri(event.id));
  });

  sorted.forEach((event, index) => {
    const uri = eventUri(event.id);
    add(uri, `${RDF}type`, `${NOSTR}Event`);
    add(uri, `${NOSTR}kind`, integer(event.kind));
    add(uri, `${NOSTR}createdAt`, instant(event.created_at));
    add(uri, `${NOSTR}content`, literal(event.content));
    add(uri, `${NOSTR}sig`, literal(event.sig ?? ''));
    add(uri, `${NOSTR}tags`, literal(JSON.stringify(event.tags)));
    add(uri, `${NOSTR}threadIndex`, integer(index));
    add(uri, `${PROV}wasAttributedTo`, pubkeyUri(event.pubkey));
  });
  for (const pubkey of new Set([
    ...sorted.map((event) => event.pubkey),
    envelope.requesterPubkey,
  ])) {
    add(pubkeyUri(pubkey), `${RDF}type`, `${PROV}Agent`);
    add(pubkeyUri(pubkey), `${NOSTR}pubkeyHex`, literal(pubkey));
  }
  add(pubkeyUri(envelope.requesterPubkey), `${RDF}type`, `${PROV}SoftwareAgent`);
  const proposalEvent = eventUri(envelope.proposalEvent.id);
  add(proposalEvent, `${RDF}type`, `${NOSTR}Event`);
  add(proposalEvent, `${NOSTR}kind`, integer(envelope.proposalEvent.kind));
  add(proposalEvent, `${NOSTR}createdAt`, instant(envelope.proposalEvent.created_at));
  add(proposalEvent, `${NOSTR}content`, literal(envelope.proposalEvent.content));
  add(proposalEvent, `${NOSTR}sig`, literal(envelope.proposalEvent.sig));
  add(proposalEvent, `${NOSTR}tags`, literal(JSON.stringify(envelope.proposalEvent.tags)));
  add(proposalEvent, `${PROV}wasAttributedTo`, pubkeyUri(envelope.requesterPubkey));

  return { rootUri, activityUri, digest, title: proposal.summary, quads };
}

/** Compile agent semantics plus the exact signed evidence snapshot into deterministic RDF. */
function compileAgentMemoryV1(
  envelope: AgentMemoryEnvelope,
  proposal: AgentMemoryProposalV1,
): DistillResult {
  const signedSet = [envelope.proposalEvent, ...envelope.sourceEvents];
  const digest = sourceSetDigest(signedSet);
  const rootUri = `urn:buzz-dkg:memory:${digest}`;
  const activityUri = `urn:buzz-dkg:agent-memory:${digest}`;
  const quads: Quad[] = [];
  const add = (subject: string, predicate: string, object: string) =>
    quads.push({ subject, predicate, object });
  const sorted = [...envelope.sourceEvents].sort(
    (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
  );

  add(rootUri, `${RDF}type`, `${PROV}Entity`);
  add(rootUri, `${RDF}type`, `${BUZZ}DecisionCluster`);
  add(rootUri, `${RDF}type`, `${BUZZ}AgentMemory`);
  add(rootUri, `${SCHEMA}name`, literal(proposal.summary));
  add(rootUri, `${SCHEMA}description`, literal(proposal.summary));
  add(rootUri, `${BUZZ}channel`, channelUri(envelope.channelId));
  add(rootUri, `${BUZZ}sourceSetDigest`, literal(digest));
  add(rootUri, `${BUZZ}sourceEventCount`, integer(sorted.length));
  add(rootUri, `${BUZZ}proposalEvent`, eventUri(envelope.proposalEvent.id));
  add(rootUri, `${PROV}wasGeneratedBy`, activityUri);
  for (const event of sorted) add(rootUri, `${PROV}wasDerivedFrom`, eventUri(event.id));

  add(activityUri, `${RDF}type`, `${PROV}Activity`);
  add(activityUri, `${RDF}type`, `${BUZZ}AgentMemoryProposal`);
  add(activityUri, `${PROV}wasAssociatedWith`, pubkeyUri(envelope.requesterPubkey));
  add(activityUri, `${PROV}endedAtTime`, instant(envelope.proposalEvent.created_at));
  if (proposal.model) add(activityUri, `${BUZZ}model`, literal(proposal.model));
  if (proposal.promptVersion)
    add(activityUri, `${BUZZ}promptVersion`, literal(proposal.promptVersion));
  for (const event of sorted) add(activityUri, `${PROV}used`, eventUri(event.id));

  proposal.items.forEach((item, index) => {
    const uri = itemUri(digest, index);
    add(rootUri, `${BUZZ}contains`, uri);
    add(uri, `${RDF}type`, `${PROV}Entity`);
    add(uri, `${RDF}type`, `${BUZZ}Claim`);
    add(uri, `${RDF}type`, semanticType(item.kind));
    add(uri, `${SCHEMA}text`, literal(item.text));
    add(uri, `${BUZZ}memoryKind`, literal(item.kind));
    if (item.subject) add(uri, `${BUZZ}subjectText`, literal(item.subject));
    if (item.predicate) add(uri, `${BUZZ}predicateText`, literal(item.predicate));
    if (item.object) add(uri, `${BUZZ}objectText`, literal(item.object));
    if (item.confidence !== undefined) add(uri, `${BUZZ}confidence`, decimal(item.confidence));
    for (const event of sorted) add(uri, `${PROV}wasDerivedFrom`, eventUri(event.id));
  });

  sorted.forEach((event, index) => {
    const uri = eventUri(event.id);
    add(uri, `${RDF}type`, `${NOSTR}Event`);
    add(uri, `${NOSTR}kind`, integer(event.kind));
    add(uri, `${NOSTR}createdAt`, instant(event.created_at));
    add(uri, `${NOSTR}content`, literal(event.content));
    add(uri, `${NOSTR}sig`, literal(event.sig ?? ''));
    add(uri, `${NOSTR}tags`, literal(JSON.stringify(event.tags)));
    add(uri, `${NOSTR}threadIndex`, integer(index));
    add(uri, `${PROV}wasAttributedTo`, pubkeyUri(event.pubkey));
  });
  for (const pubkey of new Set([
    ...sorted.map((event) => event.pubkey),
    envelope.requesterPubkey,
  ])) {
    add(pubkeyUri(pubkey), `${RDF}type`, `${PROV}Agent`);
    add(pubkeyUri(pubkey), `${NOSTR}pubkeyHex`, literal(pubkey));
  }
  add(pubkeyUri(envelope.requesterPubkey), `${RDF}type`, `${PROV}SoftwareAgent`);
  add(eventUri(envelope.proposalEvent.id), `${RDF}type`, `${NOSTR}Event`);
  add(eventUri(envelope.proposalEvent.id), `${NOSTR}kind`, integer(envelope.proposalEvent.kind));
  add(
    eventUri(envelope.proposalEvent.id),
    `${NOSTR}createdAt`,
    instant(envelope.proposalEvent.created_at),
  );
  add(
    eventUri(envelope.proposalEvent.id),
    `${NOSTR}content`,
    literal(envelope.proposalEvent.content),
  );
  add(
    eventUri(envelope.proposalEvent.id),
    `${PROV}wasAttributedTo`,
    pubkeyUri(envelope.requesterPubkey),
  );
  add(eventUri(envelope.proposalEvent.id), `${NOSTR}sig`, literal(envelope.proposalEvent.sig));
  add(
    eventUri(envelope.proposalEvent.id),
    `${NOSTR}tags`,
    literal(JSON.stringify(envelope.proposalEvent.tags)),
  );

  return { rootUri, activityUri, digest, title: proposal.summary, quads };
}

/** Compile either proposal version without changing the established v1 graph shape. */
export function compileAgentMemory(
  envelope: AgentMemoryEnvelope,
  proposal: AgentMemoryProposal,
): DistillResult {
  return proposal.schemaVersion === 2
    ? compileAgentMemoryV2(envelope, proposal)
    : compileAgentMemoryV1(envelope, proposal);
}

export function contextGraphIdForChannel(relayUrl: string, channelId: string): string {
  const origin = new URL(relayUrl).origin.toLowerCase();
  const digest = createHash('sha256')
    .update('buzz-dkg-binding-v1\0')
    .update(origin)
    .update('\0')
    .update(channelId.toLowerCase())
    .digest('hex');
  return `buzz-${digest}`;
}
