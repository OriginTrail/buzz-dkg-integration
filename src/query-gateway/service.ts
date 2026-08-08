import type { DkgClient } from '../dkg/client.ts';
import type { ChannelBinding, QueryGatewayConfig } from '../types.ts';
import type {
  ChannelMemoryResult,
  ContributorSummary,
  ContributorTrailEntry,
  ContributorTrailResult,
  DecisionSummary,
  EvidenceRelation,
  EvidenceResult,
  EvidenceSource,
  GraphEdge,
  GraphNode,
  GraphTriple,
  QueryGatewayRequest,
  QueryGatewayResult,
  QueryGatewaySuccess,
  QueryOperation,
  SubGraphSummary,
  SubgraphGraphResult,
  SubgraphTriplesResult,
  VisibleMemoryLayer,
} from './types.ts';

type EnabledGatewayConfig = Extract<QueryGatewayConfig, { enabled: true }>;
type BindingRow = Record<string, unknown>;
type LayeredRow = { row: BindingRow; layer: VisibleMemoryLayer };
type VisibleView = 'shared-working-memory' | 'verifiable-memory';

const VIEWS: readonly [VisibleView, VisibleMemoryLayer][] = [
  ['shared-working-memory', 'SWM'],
  ['verifiable-memory', 'VM'],
];
const LAYER_RANK: Record<VisibleMemoryLayer, number> = { SWM: 0, VM: 1 };
const HEX_PUBKEY = /^[0-9a-f]{64}$/iu;
const CHANNEL_ID = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const SUBGRAPH_NAME = /^[A-Za-z0-9_-]{1,128}$/u;
const SAFE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^<>"{}|^`\\\s]{1,999}$/u;
const MAX_DKG_ROWS = 2_500;
const MAX_GRAPH_NODES = 1_200;
const MAX_GRAPH_EDGES = 2_400;
const MAX_TRIPLES = 1_000;

const BUZZ = 'https://w3id.org/buzz-dkg/buzz#';
const NOSTR = 'https://w3id.org/buzz-dkg/nostr#';
const PROV = 'http://www.w3.org/ns/prov#';
const SCHEMA = 'http://schema.org/';

export class QueryGatewayError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'QueryGatewayError';
    this.status = status;
    this.code = code;
  }
}

function invalid(message: string): never {
  throw new QueryGatewayError(400, 'invalid_request', message);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).find((key) => !allowedSet.has(key));
  if (extra) invalid(`${context} contains unexpected field '${extra}'`);
}

function requiredString(value: unknown, name: string, pattern: RegExp, normalize = false): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${name} is invalid`);
  return normalize ? value.toLowerCase() : value;
}

export function parseQueryGatewayRequest(value: unknown): QueryGatewayRequest {
  if (!plainObject(value)) invalid('request body must be a JSON object');
  exactKeys(value, ['channelId', 'operation', 'arguments', 'requesterPubkey'], 'request');
  const channelId = requiredString(value.channelId, 'channelId', CHANNEL_ID);
  const operations = new Set<QueryOperation>([
    'channel_memory',
    'contributor_trail',
    'subgraph_graph',
    'subgraph_triples',
    'evidence',
  ]);
  if (typeof value.operation !== 'string' || !operations.has(value.operation as QueryOperation)) {
    invalid('operation is invalid');
  }
  const operation = value.operation as QueryOperation;
  if (!plainObject(value.arguments)) invalid('arguments must be a JSON object');
  const requesterPubkey = requiredString(
    value.requesterPubkey,
    'requesterPubkey',
    HEX_PUBKEY,
    true,
  );

  const base = { channelId, operation, requesterPubkey };
  if (operation === 'channel_memory') {
    exactKeys(value.arguments, [], 'arguments');
    return { ...base, operation, arguments: {} };
  }
  if (operation === 'contributor_trail') {
    exactKeys(value.arguments, ['pubkey'], 'arguments');
    return {
      ...base,
      operation,
      arguments: {
        pubkey: requiredString(value.arguments.pubkey, 'arguments.pubkey', HEX_PUBKEY, true),
      },
    };
  }
  if (operation === 'subgraph_graph' || operation === 'subgraph_triples') {
    exactKeys(value.arguments, ['name'], 'arguments');
    return {
      ...base,
      operation,
      arguments: {
        name: requiredString(value.arguments.name, 'arguments.name', SUBGRAPH_NAME),
      },
    };
  }
  exactKeys(value.arguments, ['uri'], 'arguments');
  return {
    ...base,
    operation: 'evidence',
    arguments: { uri: requiredString(value.arguments.uri, 'arguments.uri', SAFE_IRI) },
  };
}

function rawTerm(value: unknown): string {
  if (value && typeof value === 'object' && 'value' in value) {
    return String((value as { value?: unknown }).value ?? '');
  }
  return String(value ?? '');
}

/** Normalize the N-Triples-style scalar shape returned by DKG SELECT bindings. */
export function bindingTerm(value: unknown): string {
  const raw = rawTerm(value);
  if (raw.startsWith('<') && raw.endsWith('>')) return raw.slice(1, -1);
  if (!raw.startsWith('"')) return raw;
  let escaped = false;
  for (let i = 1; i < raw.length; i += 1) {
    const char = raw[i]!;
    if (char === '"' && !escaped) {
      const literal = raw.slice(0, i + 1);
      try {
        return JSON.parse(literal) as string;
      } catch {
        return raw.slice(1, i);
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

function safeDerivedIri(value: string): boolean {
  return SAFE_IRI.test(value);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new QueryGatewayError(504, 'gateway_timeout', 'query operation timed out')),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export class QueryGatewayService {
  readonly #resolveContextGraph: (channelId: string) => string | null | Promise<string | null>;
  readonly dkg: DkgClient;
  readonly config: EnabledGatewayConfig;

  constructor(
    bindings:
      readonly ChannelBinding[] | ((channelId: string) => string | null | Promise<string | null>),
    dkg: DkgClient,
    config: EnabledGatewayConfig,
  ) {
    this.dkg = dkg;
    this.config = config;
    if (typeof bindings === 'function') {
      this.#resolveContextGraph = bindings;
    } else {
      const mapped = new Map<string, string>();
      for (const binding of bindings) {
        if (mapped.has(binding.channelId)) {
          throw new Error(`duplicate query-gateway channel binding '${binding.channelId}'`);
        }
        mapped.set(binding.channelId, binding.contextGraphId);
      }
      this.#resolveContextGraph = (channelId) => mapped.get(channelId) ?? null;
    }
  }

  async execute(input: unknown): Promise<QueryGatewaySuccess> {
    const request = parseQueryGatewayRequest(input);
    const cg = await this.#resolveContextGraph(request.channelId);
    if (!cg) {
      throw new QueryGatewayError(
        404,
        'unknown_channel',
        'channel is not configured for DKG queries',
      );
    }
    const result = await withTimeout(this.dispatch(cg, request), this.config.operationTimeoutMs);
    return {
      ok: true,
      channelId: request.channelId,
      cg,
      operation: request.operation,
      result,
    };
  }

  private async dispatch(cg: string, request: QueryGatewayRequest): Promise<QueryGatewayResult> {
    switch (request.operation) {
      case 'channel_memory':
        return this.channelMemory(cg);
      case 'contributor_trail':
        return this.contributorTrail(cg, request.arguments.pubkey);
      case 'subgraph_graph':
        return this.subgraphGraph(cg, request.arguments.name);
      case 'subgraph_triples':
        return this.subgraphTriples(cg, request.arguments.name);
      case 'evidence':
        return this.evidence(cg, request.arguments.uri);
    }
  }

  private async query(
    cg: string,
    view: VisibleView,
    sparql: string,
    subGraphName?: string,
  ): Promise<BindingRow[]> {
    if (Buffer.byteLength(sparql, 'utf8') > this.config.maxQueryBytes) {
      throw new QueryGatewayError(500, 'query_bound_exceeded', 'internal query exceeded its bound');
    }
    const response = await this.dkg.query(
      { contextGraphId: cg, view, sparql, ...(subGraphName ? { subGraphName } : {}) },
      this.config.dkgTimeoutMs,
    );
    const rows = response?.result?.bindings;
    if (!Array.isArray(rows)) throw new Error('DKG query returned an invalid bindings shape');
    return rows.slice(0, MAX_DKG_ROWS) as BindingRow[];
  }

  private async layered(cg: string, sparql: string, subGraphName?: string): Promise<LayeredRow[]> {
    const batches = await Promise.all(
      VIEWS.map(async ([view, layer]) =>
        (await this.query(cg, view, sparql, subGraphName)).map((row) => ({ row, layer })),
      ),
    );
    return batches.flat();
  }

  private async layerOverview(
    cg: string,
    view: VisibleView,
  ): Promise<{ graph: string; label: string }[]> {
    const rows = await this.query(
      cg,
      view,
      `SELECT ?g (SAMPLE(?n) AS ?name) WHERE {
         GRAPH ?g { ?s ?p ?o . OPTIONAL { ?s <${SCHEMA}name> ?n } }
       } GROUP BY ?g LIMIT 200`,
    );
    const seen = new Set<string>();
    const out: { graph: string; label: string }[] = [];
    for (const row of rows) {
      const graph = bounded(term(row, 'g'), 1_000);
      if (!graph || seen.has(graph)) continue;
      seen.add(graph);
      const label = optionalTerm(row, 'name') ?? graph.split('/').slice(-2).join('/');
      out.push({ graph, label: bounded(label, 200) });
    }
    return out;
  }

  private async channelMemory(cg: string): Promise<ChannelMemoryResult> {
    const decisionsQuery = `SELECT ?s ?name ?digest ?t WHERE { GRAPH ?g {
      ?s a <${BUZZ}DecisionCluster> .
      OPTIONAL { ?s <${SCHEMA}name> ?name }
      OPTIONAL { ?s <${BUZZ}sourceSetDigest> ?digest }
      OPTIONAL { ?s <${PROV}endedAtTime> ?t }
    } } LIMIT 200`;
    const contributorsQuery = `SELECT ?pk (COUNT(DISTINCT ?event) AS ?n) (MAX(?at) AS ?latest)
      WHERE { GRAPH ?g {
        ?event <${PROV}wasAttributedTo> ?agent .
        ?agent <${NOSTR}pubkeyHex> ?pk .
        OPTIONAL { ?event <${NOSTR}createdAt> ?at }
      } } GROUP BY ?pk ORDER BY DESC(?n) LIMIT 50`;
    const [swm, vm, decisionRows, contributorRows, subGraphResponse] = await Promise.all([
      this.layerOverview(cg, 'shared-working-memory'),
      this.layerOverview(cg, 'verifiable-memory'),
      this.layered(cg, decisionsQuery),
      this.layered(cg, contributorsQuery),
      this.dkg.listSubGraphs(cg, this.config.dkgTimeoutMs),
    ]);

    const decisionsByUri = new Map<string, DecisionSummary>();
    for (const { row, layer } of decisionRows) {
      const uri = bounded(term(row, 's'), 1_000);
      if (!uri) continue;
      const current = decisionsByUri.get(uri);
      const candidate: DecisionSummary = {
        uri,
        name: optionalTerm(row, 'name') ? bounded(optionalTerm(row, 'name')!, 200) : null,
        digest: optionalTerm(row, 'digest') ? bounded(optionalTerm(row, 'digest')!, 256) : null,
        at: optionalTerm(row, 't') ? bounded(optionalTerm(row, 't')!, 128) : null,
        layer,
      };
      if (!current || LAYER_RANK[layer] > LAYER_RANK[current.layer]) {
        decisionsByUri.set(uri, candidate);
      }
    }

    const contributorsByPubkey = new Map<string, ContributorSummary>();
    for (const { row, layer } of contributorRows) {
      const pubkey = term(row, 'pk').toLowerCase();
      if (!HEX_PUBKEY.test(pubkey)) continue;
      const events = count(row.n);
      const latest = dateTimestamp(row.latest);
      const current = contributorsByPubkey.get(pubkey);
      if (!current) {
        contributorsByPubkey.set(pubkey, { pubkey, events, latest, layer });
      } else {
        current.events = Math.max(current.events, events);
        current.latest = Math.max(current.latest ?? 0, latest ?? 0) || null;
        if (LAYER_RANK[layer] > LAYER_RANK[current.layer]) current.layer = layer;
      }
    }

    const subgraphs: SubGraphSummary[] = (
      subGraphResponse.subGraphs ??
      subGraphResponse.sub_graphs ??
      []
    )
      .slice(0, 200)
      .filter((item) => SUBGRAPH_NAME.test(String(item.name ?? '')))
      .map((item) => ({
        name: String(item.name),
        uri: item.uri ? bounded(String(item.uri), 1_000) : String(item.name),
        description: item.description ? bounded(String(item.description), 500) : null,
        createdBy: item.createdBy ? bounded(String(item.createdBy), 256) : null,
        createdAt: item.createdAt ? bounded(String(item.createdAt), 128) : null,
        entityCount: Math.min(Math.max(Number(item.entityCount) || 0, 0), 1_000_000_000),
        tripleCount: Math.min(Math.max(Number(item.tripleCount) || 0, 0), 1_000_000_000),
      }));

    return {
      layers: { WM: null, SWM: swm, VM: vm },
      decisions: [...decisionsByUri.values()],
      contributors: [...contributorsByPubkey.values()].sort(
        (a, b) => b.events - a.events || a.pubkey.localeCompare(b.pubkey),
      ),
      subgraphs,
    };
  }

  private async contributorTrail(cg: string, pubkey: string): Promise<ContributorTrailResult> {
    const rows = await this.layered(
      cg,
      `SELECT ?event ?content ?at ?decision ?dname WHERE { GRAPH ?g {
         ?event <${PROV}wasAttributedTo> ?agent .
         ?agent <${NOSTR}pubkeyHex> "${pubkey}" .
         OPTIONAL { ?event <${NOSTR}content> ?content }
         OPTIONAL { ?event <${NOSTR}createdAt> ?at }
         OPTIONAL { ?decision <${PROV}wasDerivedFrom> ?event ; <${SCHEMA}name> ?dname }
       } } ORDER BY DESC(?at) LIMIT 100`,
    );
    const byKey = new Map<string, ContributorTrailEntry>();
    for (const { row, layer } of rows) {
      const event = bounded(term(row, 'event'), 1_000);
      if (!event) continue;
      const decision = optionalTerm(row, 'decision');
      const key = `${event}\0${decision ?? ''}`;
      const candidate: ContributorTrailEntry = {
        event,
        content: optionalTerm(row, 'content') ? bounded(optionalTerm(row, 'content')!, 240) : null,
        at: dateTimestamp(row.at),
        decision: decision ? bounded(decision, 1_000) : null,
        decisionName: optionalTerm(row, 'dname') ? bounded(optionalTerm(row, 'dname')!, 200) : null,
        layer,
      };
      const current = byKey.get(key);
      if (!current || LAYER_RANK[layer] > LAYER_RANK[current.layer]) byKey.set(key, candidate);
    }
    const trail = [...byKey.values()]
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.event.localeCompare(b.event))
      .slice(0, 100);
    return { pubkey, trail };
  }

  private async subgraphGraph(cg: string, name: string): Promise<SubgraphGraphResult> {
    const [claimRows, forgeRows, decisionRows, contradictionRows] = await Promise.all([
      this.layered(
        cg,
        `SELECT ?c ?text ?at ?run ?ev WHERE { GRAPH ?g {
             ?c a <${BUZZ}Claim> . OPTIONAL { ?c <${SCHEMA}text> ?text }
             OPTIONAL { ?c <${SCHEMA}dateCreated> ?at }
             OPTIONAL { ?run <${PROV}generated> ?c }
             OPTIONAL { ?c <${PROV}wasDerivedFrom> ?ev }
           } } LIMIT 500`,
        name,
      ),
      this.layered(
        cg,
        `SELECT ?f ?type ?name ?at ?ev ?commit WHERE { GRAPH ?g {
             ?f a ?type . FILTER(STRSTARTS(STR(?type), "${BUZZ}"))
             FILTER(?type IN (<${BUZZ}Patch>, <${BUZZ}Issue>, <${BUZZ}StatusApplied>,
               <${BUZZ}StatusOpen>, <${BUZZ}Commit>))
             OPTIONAL { ?f <${SCHEMA}name> ?name }
             OPTIONAL { ?f <${SCHEMA}dateCreated> ?at }
             OPTIONAL { ?f <${PROV}wasDerivedFrom> ?ev }
             OPTIONAL { ?f <${BUZZ}commit> ?commit }
           } } LIMIT 200`,
        name,
      ),
      this.layered(
        cg,
        `SELECT ?d ?name ?t ?ev WHERE { GRAPH ?g {
             ?d a <${BUZZ}DecisionCluster> . OPTIONAL { ?d <${SCHEMA}name> ?name }
             OPTIONAL { ?d <${PROV}endedAtTime> ?t }
             OPTIONAL { ?d <${PROV}wasDerivedFrom> ?ev }
           } } LIMIT 1000`,
        name,
      ),
      this.layered(
        cg,
        `SELECT ?c ?d WHERE { GRAPH ?g {
             { ?c <${BUZZ}contradicts> ?d } UNION { ?d <${PROV}wasInvalidatedBy> ?c }
           } } LIMIT 200`,
        name,
      ),
    ]);

    const decisions = new Map<string, GraphNode>();
    const eventToDecisions = new Map<string, Set<string>>();
    for (const { row, layer } of decisionRows) {
      const id = bounded(term(row, 'd'), 1_000);
      if (!id) continue;
      const current = decisions.get(id);
      if (!current) {
        decisions.set(id, {
          id,
          kind: 'decision',
          label: bounded(optionalTerm(row, 'name') ?? id.split('/').pop() ?? id, 200),
          at: dateTimestamp(row.t),
          contested: 0,
          layer,
        });
      } else if (LAYER_RANK[layer] > LAYER_RANK[current.layer]) {
        current.layer = layer;
      }
      const event = optionalTerm(row, 'ev');
      if (event) {
        const set = eventToDecisions.get(event) ?? new Set<string>();
        set.add(id);
        eventToDecisions.set(event, set);
      }
    }
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const seenEdges = new Set<string>();
    const pushEdge = (from: string, to: string, rel: GraphEdge['rel']) => {
      const key = `${from}\0${to}\0${rel}`;
      if (seenEdges.has(key) || edges.length >= MAX_GRAPH_EDGES) return;
      seenEdges.add(key);
      edges.push({ from, to, rel });
    };
    const upsertNode = (node: GraphNode) => {
      const current = nodes.get(node.id);
      if (!current || LAYER_RANK[node.layer] > LAYER_RANK[current.layer]) nodes.set(node.id, node);
    };

    for (const { row, layer } of claimRows) {
      const id = bounded(term(row, 'c'), 1_000);
      if (!id) continue;
      upsertNode({
        id,
        kind: 'claim',
        label: bounded(optionalTerm(row, 'text') ?? id.split(':').pop() ?? id, 200),
        at: dateTimestamp(row.at),
        run: optionalTerm(row, 'run') ? bounded(optionalTerm(row, 'run')!, 1_000) : null,
        layer,
      });
      const event = optionalTerm(row, 'ev');
      if (!event) continue;
      for (const decisionId of eventToDecisions.get(event) ?? []) {
        const decision = decisions.get(decisionId);
        if (decision) {
          upsertNode(decision);
          pushEdge(id, decisionId, 'supports');
        }
      }
    }
    for (const { row, layer } of forgeRows) {
      const id = bounded(term(row, 'f'), 1_000);
      if (!id) continue;
      upsertNode({
        id,
        kind: 'commit',
        label: bounded(optionalTerm(row, 'name') ?? id.split(':').pop() ?? id, 200),
        at: dateTimestamp(row.at),
        commit: optionalTerm(row, 'commit')
          ? bounded(optionalTerm(row, 'commit')!.split(':').pop() ?? '', 256)
          : null,
        layer,
      });
      const event = optionalTerm(row, 'ev');
      if (!event) continue;
      for (const decisionId of eventToDecisions.get(event) ?? []) {
        const decision = decisions.get(decisionId);
        if (decision) {
          upsertNode(decision);
          pushEdge(id, decisionId, 'supports');
        }
      }
    }
    for (const decision of decisions.values()) upsertNode(decision);
    for (const { row } of contradictionRows) {
      const from = term(row, 'c');
      const to = term(row, 'd');
      const decision = decisions.get(to);
      if (!nodes.has(from) || !decision) continue;
      decision.contested = (decision.contested ?? 0) + 1;
      upsertNode(decision);
      pushEdge(from, to, 'contradicts');
    }

    const boundedNodes = [...nodes.values()]
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.id.localeCompare(b.id))
      .slice(0, MAX_GRAPH_NODES);
    const nodeIds = new Set(boundedNodes.map((node) => node.id));
    return {
      subgraph: name,
      nodes: boundedNodes,
      edges: edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)),
    };
  }

  private async subgraphTriples(cg: string, name: string): Promise<SubgraphTriplesResult> {
    const rows = await this.layered(
      cg,
      `SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT 1200`,
      name,
    );
    const triples = new Map<string, GraphTriple>();
    for (const { row, layer } of rows) {
      const subject = bounded(term(row, 's'), 1_000);
      const predicate = bounded(term(row, 'p'), 1_000);
      const object = bounded(rawTerm(row.o), 4_000);
      if (!subject || !predicate) continue;
      const key = JSON.stringify([subject, predicate, object]);
      const existing = triples.get(key);
      if (existing) {
        if (LAYER_RANK[layer] > LAYER_RANK[existing.layer]) existing.layer = layer;
        continue;
      }
      if (triples.size >= MAX_TRIPLES) continue;
      const graph = term(row, 'g');
      const agentMatch = /\/([a-z0-9_-]+)\/_(?:shared|verifiable)_memory\//iu.exec(graph);
      triples.set(key, {
        subject,
        predicate,
        object,
        layer,
        agent: bounded(agentMatch?.[1] ?? name, 128),
      });
    }
    return { subgraph: name, triples: [...triples.values()] };
  }

  private async evidence(cg: string, uri: string): Promise<EvidenceResult> {
    let layer: VisibleMemoryLayer | null = null;
    let graph: string | null = null;
    let propertyRows: BindingRow[] = [];
    for (const [view, candidateLayer] of [...VIEWS].reverse()) {
      const rows = await this.query(
        cg,
        view,
        `SELECT ?p ?o ?g WHERE { GRAPH ?g { <${uri}> ?p ?o } } LIMIT 200`,
      );
      if (rows.length) {
        propertyRows = rows;
        layer = candidateLayer;
        graph = bounded(term(rows[0]!, 'g'), 1_000);
        break;
      }
    }
    if (!layer) {
      return {
        found: false,
        claimId: uri,
        name: null,
        status: null,
        trustState: null,
        memoryLayer: null,
        attribution: [],
        digest: null,
        asOf: null,
        sources: [],
        relations: [],
        receiptUal: null,
        graph: null,
      };
    }

    const properties = new Map<string, string[]>();
    for (const row of propertyRows) {
      const predicate = term(row, 'p');
      if (!predicate) continue;
      const values = properties.get(predicate) ?? [];
      if (values.length < 50) values.push(bounded(term(row, 'o'), 4_000));
      properties.set(predicate, values);
    }
    const values = (predicate: string) => properties.get(predicate) ?? [];
    const sourceIds = [...new Set(values(`${PROV}wasDerivedFrom`))]
      .filter(safeDerivedIri)
      .slice(0, 12);

    const sourceDetails: EvidenceSource[] = sourceIds.map((id) => ({
      id,
      span: null,
      author: null,
      at: null,
    }));
    if (sourceIds.length) {
      const sourceRows = await this.layered(
        cg,
        `SELECT ?ev ?content ?pk ?at WHERE { GRAPH ?g {
           VALUES ?ev { ${sourceIds.map((id) => `<${id}>`).join(' ')} }
           OPTIONAL { ?ev <${NOSTR}content> ?content }
           OPTIONAL {
             ?ev <${PROV}wasAttributedTo> ?agent .
             ?agent <${NOSTR}pubkeyHex> ?pk
           }
           OPTIONAL { ?ev <${NOSTR}createdAt> ?at }
         } } LIMIT 50`,
      );
      const sourceIndex = new Map(sourceDetails.map((source) => [source.id, source]));
      for (const { row } of sourceRows) {
        const source = sourceIndex.get(term(row, 'ev'));
        if (!source) continue;
        const author = optionalTerm(row, 'pk')?.toLowerCase();
        source.span = optionalTerm(row, 'content')
          ? bounded(optionalTerm(row, 'content')!, 200)
          : source.span;
        source.author = author && HEX_PUBKEY.test(author) ? author : source.author;
        source.at = dateTimestamp(row.at) ?? source.at;
      }
    }

    const relationRows = await this.layered(
      cg,
      `SELECT ?s ?p WHERE { GRAPH ?g { ?s ?p <${uri}> .
         FILTER(?p IN (<${PROV}wasDerivedFrom>, <${BUZZ}contradicts>,
           <${PROV}wasInvalidatedBy>)) } } LIMIT 50`,
    );
    const relationKeys = new Set<string>();
    const relations: EvidenceRelation[] = [];
    for (const { row } of relationRows) {
      const from = bounded(term(row, 's'), 1_000);
      const rel = bounded(term(row, 'p').split(/[/#]/u).pop() ?? '', 128);
      const key = `${from}\0${rel}`;
      if (!from || !rel || relationKeys.has(key)) continue;
      relationKeys.add(key);
      relations.push({ from, rel });
    }
    const attribution = [
      ...new Set(sourceDetails.map((source) => source.author).filter((v): v is string => !!v)),
    ];

    return {
      found: true,
      claimId: uri,
      name: values(`${SCHEMA}name`)[0] ? bounded(values(`${SCHEMA}name`)[0]!, 200) : null,
      status: values(`${SCHEMA}creativeWorkStatus`)[0]
        ? bounded(values(`${SCHEMA}creativeWorkStatus`)[0]!, 128)
        : layer === 'VM'
          ? 'anchored'
          : 'shared',
      trustState: 'provenance checked by the configured DKG node',
      memoryLayer: layer,
      attribution,
      digest: values(`${BUZZ}sourceSetDigest`)[0]
        ? bounded(values(`${BUZZ}sourceSetDigest`)[0]!, 256)
        : null,
      asOf: values(`${PROV}endedAtTime`)[0]
        ? bounded(values(`${PROV}endedAtTime`)[0]!, 128)
        : values(`${SCHEMA}dateCreated`)[0]
          ? bounded(values(`${SCHEMA}dateCreated`)[0]!, 128)
          : null,
      sources: sourceDetails,
      relations,
      receiptUal: values(`${BUZZ}ual`)[0] ? bounded(values(`${BUZZ}ual`)[0]!, 1_000) : null,
      graph,
    };
  }
}
