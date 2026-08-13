import type { ContributorSummary, DecisionSummary, VisibleMemoryLayer } from './types.ts';

type BindingRow = Record<string, unknown>;

export interface ChannelMemoryLayerSummary {
  layer: VisibleMemoryLayer;
  graphs: Array<{ graph: string; label: string }>;
  decisions: DecisionSummary[];
  contributors: ContributorSummary[];
}

const HEX_PUBKEY = /^[0-9a-f]{64}$/iu;

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
      const eventCount = events.size || count(row.n);
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
