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
  AgentMemoryEnvelope,
  AgentMemoryItem,
  AgentMemoryItemKind,
  AgentMemoryProposal,
  DistillResult,
  NostrEvent,
  Quad,
} from '../types.ts';
import { DKG_MEMORY_PROPOSAL_KIND } from '../types.ts';

const HEX_64 = /^[0-9a-f]{64}$/u;
const CHANNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ITEM_KINDS = new Set(['decision', 'claim', 'question', 'task', 'relationship']);
const MAX_SOURCES = 16;
const MAX_ITEMS = 50;

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

export function parseAgentMemoryProposal(content: string): AgentMemoryProposal {
  if (Buffer.byteLength(content, 'utf8') > 64 * 1024) invalid('proposal content is too large');
  let raw: unknown;
  try {
    raw = JSON.parse(content) as unknown;
  } catch {
    invalid('proposal content must be valid JSON');
  }
  const value = object(raw, 'proposal');
  exactKeys(value, ['schemaVersion', 'summary', 'items', 'model', 'promptVersion'], 'proposal');
  if (value.schemaVersion !== 1) invalid('proposal.schemaVersion must be 1');
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > MAX_ITEMS) {
    invalid(`proposal.items must contain 1 to ${MAX_ITEMS} entries`);
  }
  const proposal: AgentMemoryProposal = {
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
  return {
    envelope: { channelId, requesterPubkey, proposalEvent, sourceEvents: orderedSourceEvents },
    proposal: parseAgentMemoryProposal(proposalEvent.content),
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

/** Compile agent semantics plus the exact signed evidence snapshot into deterministic RDF. */
export function compileAgentMemory(
  envelope: AgentMemoryEnvelope,
  proposal: AgentMemoryProposal,
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
