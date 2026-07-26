import { createHash } from 'node:crypto';
import type { DistillResult, NostrEvent, Quad } from '../types.ts';

export const PROV = 'http://www.w3.org/ns/prov#';
export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const SCHEMA = 'http://schema.org/';
export const BUZZ = 'https://w3id.org/buzz-dkg/buzz#';
export const NOSTR = 'https://w3id.org/buzz-dkg/nostr#';

export const eventUri = (id: string): string => `urn:nostr:event:${id}`;
export const pubkeyUri = (pk: string): string => `urn:nostr:pubkey:${pk}`;
export const channelUri = (uuid: string): string => `urn:buzz:channel:${uuid}`;

const lit = (s: unknown): string => JSON.stringify(String(s));
const intLit = (n: number): string => `"${n}"^^<http://www.w3.org/2001/XMLSchema#integer>`;
const timeLit = (unix: number): string =>
  `"${new Date(unix * 1000).toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`;

/**
 * The trigger-time source snapshot (SPEC §12 / Gate B finding #1): thread
 * events at-or-before the trigger, never the service's own messages. Without
 * both filters the service's receipt lands in the next snapshot, the digest
 * shifts, and trigger replay stops deduplicating.
 */
export function snapshotSourceSet(
  thread: NostrEvent[],
  trigger: NostrEvent,
  servicePubkey: string,
): NostrEvent[] {
  return thread.filter((e) => e.created_at <= trigger.created_at && e.pubkey !== servicePubkey);
}

/**
 * Canonical digest over the exact source set: events sorted by id, each in
 * Nostr canonical form plus signature. Any change to any source event or to
 * set membership changes the digest.
 */
export function sourceSetDigest(events: NostrEvent[]): string {
  const canon = [...events]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig ?? '']))
    .join('\n');
  return createHash('sha256').update(canon, 'utf8').digest('hex');
}

/**
 * Provider seam (SPEC §9 src/distill): a Distiller turns a source snapshot
 * into one single-root PROV-O cluster. `deterministicDistiller` is the
 * no-model fallback the test suite and refusal contract rely on; a model-
 * backed provider can be added behind the same interface without touching
 * the lifecycle code.
 */
export interface Distiller {
  distill(input: { channelId: string; events: NostrEvent[]; servicePubkey: string }): DistillResult;
}

export const deterministicDistiller: Distiller = {
  distill({ channelId, events, servicePubkey }) {
    if (!events.length) throw new Error('empty source set');
    const digest = sourceSetDigest(events);
    const sorted = [...events].sort(
      (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
    );
    const root = sorted[0]!;
    const rootUri = `urn:buzz-dkg:decision:${digest}`;
    const activityUri = `urn:buzz-dkg:distillation:${digest}`;
    const authors = [...new Set(sorted.map((e) => e.pubkey))].sort();
    // Prefer an explicit DECISION: line anywhere in the thread; else the root.
    const decisionMsg = sorted.find((e) => /\bDECISION:/.test(e.content)) ?? root;
    const title =
      decisionMsg.content.length > 120
        ? `${decisionMsg.content.slice(0, 117)}...`
        : decisionMsg.content;

    const quads: Quad[] = [];
    const add = (subject: string, predicate: string, object: string) =>
      quads.push({ subject, predicate, object });

    add(rootUri, `${RDF}type`, `${PROV}Entity`);
    add(rootUri, `${RDF}type`, `${BUZZ}DecisionCluster`);
    add(rootUri, `${SCHEMA}name`, lit(title));
    add(rootUri, `${SCHEMA}description`, lit(decisionMsg.content));
    add(rootUri, `${BUZZ}channel`, channelUri(channelId));
    add(rootUri, `${BUZZ}sourceSetDigest`, lit(digest));
    add(rootUri, `${BUZZ}sourceEventCount`, intLit(sorted.length));
    add(rootUri, `${PROV}wasGeneratedBy`, activityUri);
    for (const e of sorted) add(rootUri, `${PROV}wasDerivedFrom`, eventUri(e.id));

    add(activityUri, `${RDF}type`, `${PROV}Activity`);
    add(activityUri, `${RDF}type`, `${BUZZ}Distillation`);
    add(activityUri, `${PROV}wasAssociatedWith`, pubkeyUri(servicePubkey));
    add(activityUri, `${PROV}startedAtTime`, timeLit(sorted[0]!.created_at));
    add(activityUri, `${PROV}endedAtTime`, timeLit(sorted[sorted.length - 1]!.created_at));
    for (const e of sorted) add(activityUri, `${PROV}used`, eventUri(e.id));

    sorted.forEach((e, i) => {
      const u = eventUri(e.id);
      add(u, `${RDF}type`, `${NOSTR}Event`);
      add(u, `${NOSTR}kind`, intLit(e.kind));
      add(u, `${NOSTR}createdAt`, timeLit(e.created_at));
      add(u, `${NOSTR}content`, lit(e.content));
      add(u, `${NOSTR}sig`, lit(e.sig ?? ''));
      add(u, `${NOSTR}tags`, lit(JSON.stringify(e.tags)));
      add(u, `${NOSTR}threadIndex`, intLit(i));
      add(u, `${PROV}wasAttributedTo`, pubkeyUri(e.pubkey));
      if (i > 0) add(u, `${BUZZ}inThreadOf`, eventUri(root.id));
    });
    for (const a of authors) {
      add(pubkeyUri(a), `${RDF}type`, `${PROV}Agent`);
      add(pubkeyUri(a), `${NOSTR}pubkeyHex`, lit(a));
    }
    add(pubkeyUri(servicePubkey), `${RDF}type`, `${PROV}SoftwareAgent`);

    return { rootUri, activityUri, digest, title, quads };
  },
};

export const kaNameForDigest = (digest: string): string => `buzz-dkg-${digest.slice(0, 12)}`;
