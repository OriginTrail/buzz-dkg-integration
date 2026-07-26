// Deterministic naive distillation: Buzz thread snapshot -> one PROV-O
// decision cluster (single root subject URI) + source-set digest.
// No model involved; same input events => byte-identical quads and digest.
import { createHash } from 'node:crypto';

const PROV = 'http://www.w3.org/ns/prov#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SCHEMA = 'http://schema.org/';
const BUZZ = 'https://w3id.org/buzz-dkg/buzz#';
const NOSTR = 'https://w3id.org/buzz-dkg/nostr#';

const eventUri = (id) => `urn:nostr:event:${id}`;
const pubkeyUri = (pk) => `urn:nostr:pubkey:${pk}`;
const channelUri = (uuid) => `urn:buzz:channel:${uuid}`;

const lit = (s) => JSON.stringify(String(s)); // quoted N-Triples-style literal
const intLit = (n) => `"${n}"^^<http://www.w3.org/2001/XMLSchema#integer>`;
const timeLit = (unix) => `"${new Date(unix * 1000).toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`;

/**
 * Canonical digest over the exact source set: events sorted by id, each
 * serialized as its Nostr canonical form [0,pubkey,created_at,kind,tags,content]
 * plus the signature. Any change to any source event changes the digest.
 */
export function sourceSetDigest(events) {
  const canon = [...events]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig]))
    .join('\n');
  return createHash('sha256').update(canon, 'utf8').digest('hex');
}

/**
 * Distill a thread (root first after sort) into quads for one KA.
 * Returns { rootUri, digest, quads, title }.
 */
export function distillThread({ channelId, events, servicePubkey }) {
  if (!events.length) throw new Error('empty source set');
  const digest = sourceSetDigest(events);
  const sorted = [...events].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  const root = sorted[0];
  const rootUri = `urn:buzz-dkg:decision:${digest}`;
  const activityUri = `urn:buzz-dkg:distillation:${digest}`;
  const authors = [...new Set(sorted.map((e) => e.pubkey))].sort();
  const title = root.content.length > 120 ? `${root.content.slice(0, 117)}...` : root.content;

  const q = [];
  const add = (s, p, o) => q.push({ subject: s, predicate: p, object: o });

  // Root decision cluster — the single root subject of this KA.
  add(rootUri, `${RDF}type`, `${PROV}Entity`);
  add(rootUri, `${RDF}type`, `${BUZZ}DecisionCluster`);
  add(rootUri, `${SCHEMA}name`, lit(title));
  add(rootUri, `${SCHEMA}description`, lit(root.content));
  add(rootUri, `${BUZZ}channel`, channelUri(channelId));
  add(rootUri, `${BUZZ}sourceSetDigest`, lit(digest));
  add(rootUri, `${BUZZ}sourceEventCount`, intLit(sorted.length));
  add(rootUri, `${PROV}wasGeneratedBy`, activityUri);
  for (const e of sorted) add(rootUri, `${PROV}wasDerivedFrom`, eventUri(e.id));

  // Distillation activity.
  add(activityUri, `${RDF}type`, `${PROV}Activity`);
  add(activityUri, `${RDF}type`, `${BUZZ}Distillation`);
  add(activityUri, `${PROV}wasAssociatedWith`, pubkeyUri(servicePubkey));
  add(activityUri, `${PROV}startedAtTime`, timeLit(sorted[0].created_at));
  add(activityUri, `${PROV}endedAtTime`, timeLit(sorted[sorted.length - 1].created_at));
  for (const e of sorted) add(activityUri, `${PROV}used`, eventUri(e.id));

  // Source event snapshots (Buzz is not append-only — SPEC §12 — so the KA
  // carries the full signed material needed for independent verification).
  sorted.forEach((e, i) => {
    const u = eventUri(e.id);
    add(u, `${RDF}type`, `${NOSTR}Event`);
    add(u, `${NOSTR}kind`, intLit(e.kind));
    add(u, `${NOSTR}createdAt`, timeLit(e.created_at));
    add(u, `${NOSTR}content`, lit(e.content));
    add(u, `${NOSTR}sig`, lit(e.sig));
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

  return { rootUri, activityUri, digest, quads: q, title };
}
