import type { ContributorSummary, DecisionSummary, VisibleMemoryLayer } from './types.ts';

type BindingRow = Record<string, unknown>;

export interface ChannelMemoryLayerSummary {
  layer: VisibleMemoryLayer;
  graphs: Array<{ graph: string; label: string }>;
  decisions: DecisionSummary[];
  contributors: ContributorSummary[];
}

const HEX_PUBKEY = /^[0-9a-f]{64}$/iu;
const BUZZ_DECISION_CLUSTER = 'https://w3id.org/buzz-dkg/buzz#DecisionCluster';
const BUZZ_SOURCE_SET_DIGEST = 'https://w3id.org/buzz-dkg/buzz#sourceSetDigest';
const NOSTR_CREATED_AT = 'https://w3id.org/buzz-dkg/nostr#createdAt';
const NOSTR_PUBKEY_HEX = 'https://w3id.org/buzz-dkg/nostr#pubkeyHex';
const PROV_ENDED_AT_TIME = 'http://www.w3.org/ns/prov#endedAtTime';
const PROV_WAS_ATTRIBUTED_TO = 'http://www.w3.org/ns/prov#wasAttributedTo';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA_NAME = 'http://schema.org/name';

function rawTerm(value: unknown): string {
  if (value && typeof value === 'object' && 'value' in value) {
    return String((value as { value?: unknown }).value ?? '');
  }
  return String(value ?? '');
}

function bindingTerm(value: unknown): string {
  const raw = rawTerm(value);
  if (raw.startsWith('<') && raw.endsWith('>')) return raw.slice(1, -1);
  if (!raw.startsWith('"')) return raw;
  let escaped = false;
  for (let index = 1; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char === '"' && !escaped) {
      try {
        return JSON.parse(raw.slice(0, index + 1)) as string;
      } catch {
        return raw.slice(1, index);
      }
    }
    escaped = char === '\\' ? !escaped : false;
  }
  return raw.slice(1);
}

function term(row: BindingRow, key: string): string {
  return bindingTerm(row[key]);
}

function optionalTerm(row: BindingRow, key: string): string | null {
  return row[key] === undefined ? null : bindingTerm(row[key]);
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function count(value: unknown): number {
  const parsed = Number(bindingTerm(value));
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function dateTimestamp(value: unknown): number | null {
  if (value === undefined) return null;
  const parsed = Date.parse(bindingTerm(value));
  return Number.isFinite(parsed) ? parsed / 1_000 : null;
}

/** Decode the compact tagged SPARQL protocol into one typed per-layer summary. */
export function summarizeChannelMemoryLayer(
  layer: VisibleMemoryLayer,
  rows: BindingRow[],
): ChannelMemoryLayerSummary {
  const graphs: ChannelMemoryLayerSummary['graphs'] = [];
  const seenGraphs = new Set<string>();
  const decisions = new Map<string, DecisionSummary>();
  const contributors = new Map<string, ContributorSummary>();
  const contributorEvents = new Map<string, Set<string>>();

  for (const row of rows) {
    const rowType = term(row, 'rowType');
    const graph = bounded(term(row, 'g'), 1_000);
    if (graph && !seenGraphs.has(graph)) {
      seenGraphs.add(graph);
      const label = optionalTerm(row, 'name') ?? graph.split('/').slice(-2).join('/');
      graphs.push({ graph, label: bounded(label, 200) });
    }
    if (rowType === 'graph') continue;
    if (rowType === 'contributor') {
      const pubkey = term(row, 'pk').toLowerCase();
      if (!HEX_PUBKEY.test(pubkey)) continue;
      let events = contributorEvents.get(pubkey);
      if (!events) {
        events = new Set<string>();
        contributorEvents.set(pubkey, events);
      }
      const event = optionalTerm(row, 'event');
      if (event) events.add(event);
      const eventCount = Math.max(events.size, count(row.n));
      const latest = dateTimestamp(row.at ?? row.latest);
      const current = contributors.get(pubkey);
      if (!current) {
        contributors.set(pubkey, { pubkey, events: eventCount, latest, layer });
      } else {
        current.events = Math.max(current.events, eventCount);
        current.latest = Math.max(current.latest ?? 0, latest ?? 0) || null;
      }
      continue;
    }
    if (rowType !== 'decision') continue;
    const uri = bounded(term(row, 's'), 1_000);
    if (!uri) continue;
    decisions.set(uri, {
      uri,
      name: optionalTerm(row, 'name') ? bounded(optionalTerm(row, 'name')!, 200) : null,
      digest: optionalTerm(row, 'digest') ? bounded(optionalTerm(row, 'digest')!, 256) : null,
      at: optionalTerm(row, 't') ? bounded(optionalTerm(row, 't')!, 128) : null,
      layer,
    });
  }

  return {
    layer,
    graphs,
    decisions: [...decisions.values()],
    contributors: [...contributors.values()],
  };
}

/**
 * Build the lightweight channel overview from a bounded plain triple scan.
 *
 * Blazegraph can answer this shape much more reliably than a nested
 * UNION/GROUP BY query over the same named graphs. The scan is already capped
 * by the caller and all joins/counts below happen in process.
 */
export function summarizeChannelMemoryTriples(
  layer: VisibleMemoryLayer,
  rows: BindingRow[],
): ChannelMemoryLayerSummary {
  const graphs: ChannelMemoryLayerSummary['graphs'] = [];
  const seenGraphs = new Set<string>();
  const properties = new Map<string, Map<string, string[]>>();

  for (const row of rows) {
    const graph = bounded(term(row, 'g'), 1_000);
    if (graph && !seenGraphs.has(graph)) {
      seenGraphs.add(graph);
      graphs.push({
        graph,
        label: bounded(graph.split('/').filter(Boolean).slice(-2).join('/') || graph, 200),
      });
    }
    const subject = term(row, 's');
    const predicate = term(row, 'p');
    if (!subject || !predicate) continue;
    let subjectProperties = properties.get(subject);
    if (!subjectProperties) {
      subjectProperties = new Map<string, string[]>();
      properties.set(subject, subjectProperties);
    }
    const values = subjectProperties.get(predicate) ?? [];
    values.push(term(row, 'o'));
    subjectProperties.set(predicate, values);
  }

  const decisions: DecisionSummary[] = [];
  for (const [subject, subjectProperties] of properties) {
    if (!(subjectProperties.get(RDF_TYPE) ?? []).includes(BUZZ_DECISION_CLUSTER)) continue;
    const first = (predicate: string) => subjectProperties.get(predicate)?.[0] ?? null;
    decisions.push({
      uri: bounded(subject, 1_000),
      name: first(SCHEMA_NAME) ? bounded(first(SCHEMA_NAME)!, 200) : null,
      digest: first(BUZZ_SOURCE_SET_DIGEST) ? bounded(first(BUZZ_SOURCE_SET_DIGEST)!, 256) : null,
      at: first(PROV_ENDED_AT_TIME) ? bounded(first(PROV_ENDED_AT_TIME)!, 128) : null,
      layer,
    });
  }

  const contributorEvents = new Map<string, Set<string>>();
  const contributorLatest = new Map<string, number>();
  for (const [event, eventProperties] of properties) {
    for (const agent of eventProperties.get(PROV_WAS_ATTRIBUTED_TO) ?? []) {
      for (const rawPubkey of properties.get(agent)?.get(NOSTR_PUBKEY_HEX) ?? []) {
        const pubkey = rawPubkey.toLowerCase();
        if (!HEX_PUBKEY.test(pubkey)) continue;
        const events = contributorEvents.get(pubkey) ?? new Set<string>();
        events.add(event);
        contributorEvents.set(pubkey, events);
        for (const createdAt of eventProperties.get(NOSTR_CREATED_AT) ?? []) {
          const latest = dateTimestamp(createdAt);
          if (latest !== null) {
            contributorLatest.set(pubkey, Math.max(contributorLatest.get(pubkey) ?? 0, latest));
          }
        }
      }
    }
  }

  return {
    layer,
    graphs,
    decisions,
    contributors: [...contributorEvents].map(([pubkey, events]) => ({
      pubkey,
      events: events.size,
      latest: contributorLatest.get(pubkey) ?? null,
      layer,
    })),
  };
}
