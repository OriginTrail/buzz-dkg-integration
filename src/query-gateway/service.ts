import type { DkgClient } from '../dkg/client.ts';
import { IntegrationApiError } from '../errors.ts';
import { canonicalRepositoryIdentityUrl } from '../memory/identity.ts';
import type { QueryGatewayConfig } from '../types.ts';
import { executeSemanticQuery, requiredSemanticSparql } from './semantic-query.ts';
import { normalizeBindingQueryResult } from './sparql-result.ts';
import type {
  ChannelMemoryResult,
  ChannelTriplesResult,
  ContributorSummary,
  ContributorTrailEntry,
  ContributorTrailResult,
  DecisionTraceEntry,
  DecisionTraceResult,
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
  SparqlBindingRow,
  SoftwareContributorEntry,
  SoftwareContributorsResult,
  SubGraphSummary,
  SubgraphGraphResult,
  SubgraphTriplesResult,
  VisibleMemoryLayer,
} from './types.ts';
import { QueryExecutionPolicy, type QueryCacheStatus } from './query-execution-policy.ts';
import {
  summarizeChannelMemoryLayer,
  type ChannelMemoryLayerSummary,
} from './channel-memory-summary.ts';

export type { QueryCacheStatus } from './query-execution-policy.ts';

type EnabledGatewayConfig = Extract<QueryGatewayConfig, { enabled: true }>;
type BindingRow = SparqlBindingRow;
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
const COMMIT_SHA = /^[0-9a-f]{7,64}$/iu;
const COMPONENT_TYPES = {
  function: 'Function',
  class: 'Class',
  interface: 'Interface',
  file: 'File',
  package: 'Package',
} as const;
const MAX_DKG_ROWS = 2_500;
const MAX_GRAPH_NODES = 1_200;
const MAX_GRAPH_EDGES = 2_400;
const MAX_TRIPLES = 1_000;
const MAX_CHANNEL_TRIPLES = 10_000;
const BUZZ = 'https://w3id.org/buzz-dkg/buzz#';
const NOSTR = 'https://w3id.org/buzz-dkg/nostr#';
const PROV = 'http://www.w3.org/ns/prov#';
const SCHEMA = 'http://schema.org/';
const CODE = 'http://dkg.io/ontology/code/';
const GITHUB = 'http://dkg.io/ontology/github/';
const DECISIONS = 'http://dkg.io/ontology/decisions/';
const SOFTWARE = 'http://dkg.io/ontology/software/';

function invalid(message: string): never {
  throw new IntegrationApiError(400, 'invalid_request', message);
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

function requiredText(value: unknown, name: string, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value, 'utf8') > max ||
    /\p{Cc}/u.test(value)
  ) {
    invalid(`${name} is invalid`);
  }
  return value.trim();
}

function requiredRepository(value: unknown): string {
  const repository = requiredText(value, 'arguments.repository', 1_000);
  try {
    return canonicalRepositoryIdentityUrl(repository);
  } catch {
    invalid('arguments.repository is not a canonical HTTPS repository URL');
  }
}

function sparqlLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
}

export function parseQueryGatewayRequest(value: unknown): QueryGatewayRequest {
  if (!plainObject(value)) invalid('request body must be a JSON object');
  exactKeys(value, ['channelId', 'operation', 'scope', 'arguments', 'requesterPubkey'], 'request');
  const channelId = requiredString(value.channelId, 'channelId', CHANNEL_ID);
  const operations = new Set<QueryOperation>([
    'channel_memory',
    'contributor_trail',
    'software_contributors',
    'decision_trace',
    'subgraph_graph',
    'subgraph_triples',
    'channel_triples',
    'evidence',
    'semantic_query',
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
  if (operation === 'semantic_query') {
    if (!plainObject(value.scope)) invalid('scope must be a JSON object');
    exactKeys(value.scope, ['type'], 'scope');
    if (value.scope.type !== 'current_channel') invalid('scope.type must be current_channel');
    exactKeys(value.arguments, ['sparql', 'view'], 'arguments');
    const view = value.arguments.view ?? 'both';
    if (view !== 'both' && view !== 'shared' && view !== 'verified') {
      invalid('arguments.view is invalid');
    }
    return {
      ...base,
      operation,
      scope: { type: 'current_channel' },
      arguments: { sparql: requiredSemanticSparql(value.arguments.sparql), view },
    };
  }
  if (value.scope !== undefined) invalid('scope is only accepted for semantic_query');
  if (operation === 'channel_memory' || operation === 'channel_triples') {
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
  if (operation === 'software_contributors') {
    exactKeys(value.arguments, ['repository', 'componentName', 'componentType'], 'arguments');
    const componentType = value.arguments.componentType;
    if (
      componentType !== undefined &&
      (typeof componentType !== 'string' || !(componentType in COMPONENT_TYPES))
    ) {
      invalid('arguments.componentType is invalid');
    }
    return {
      ...base,
      operation,
      arguments: {
        repository: requiredRepository(value.arguments.repository),
        componentName: requiredText(value.arguments.componentName, 'arguments.componentName', 500),
        ...(componentType
          ? {
              componentType: componentType as keyof typeof COMPONENT_TYPES,
            }
          : {}),
      },
    };
  }
  if (operation === 'decision_trace') {
    exactKeys(value.arguments, ['repository', 'commitSha', 'componentName'], 'arguments');
    return {
      ...base,
      operation,
      arguments: {
        repository: requiredRepository(value.arguments.repository),
        commitSha: requiredString(
          value.arguments.commitSha,
          'arguments.commitSha',
          COMMIT_SHA,
          true,
        ),
        componentName: requiredText(value.arguments.componentName, 'arguments.componentName', 500),
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

function dateTimestamp(value: unknown): number | null {
  if (value === undefined) return null;
  const parsed = Date.parse(bindingTerm(value));
  return Number.isFinite(parsed) ? parsed / 1_000 : null;
}

function safeDerivedIri(value: string): boolean {
  return SAFE_IRI.test(value);
}

type QueryExecutionObserver = (status: QueryCacheStatus) => void;

export class QueryGatewayService {
  readonly #resolveContextGraph: (channelId: string) => string | null | Promise<string | null>;
  readonly #executionPolicy: QueryExecutionPolicy<QueryGatewaySuccess>;
  readonly dkg: DkgClient;
  readonly config: EnabledGatewayConfig;

  constructor(
    resolveContextGraph: (channelId: string) => string | null | Promise<string | null>,
    dkg: DkgClient,
    config: EnabledGatewayConfig,
  ) {
    this.dkg = dkg;
    this.config = config;
    this.#resolveContextGraph = resolveContextGraph;
    this.#executionPolicy = new QueryExecutionPolicy(config);
  }

  loadSnapshot(): ReturnType<QueryExecutionPolicy<QueryGatewaySuccess>['snapshot']> {
    return this.#executionPolicy.snapshot();
  }

  invalidateChannel(channelId: string): void {
    this.#executionPolicy.invalidateChannel(channelId);
  }

  async execute(input: unknown, observe?: QueryExecutionObserver): Promise<QueryGatewaySuccess> {
    const request = parseQueryGatewayRequest(input);
    const cg = await this.#resolveContextGraph(request.channelId);
    if (!cg) {
      throw new IntegrationApiError(
        404,
        'unknown_channel',
        'channel is not configured for DKG queries',
      );
    }
    return this.#executionPolicy.execute({
      channelId: request.channelId,
      keyParts: [
        cg,
        request.operation,
        'scope' in request ? request.scope : null,
        request.arguments,
      ],
      observe,
      work: async () => {
        const result = await this.dispatch(cg, request);
        const value: QueryGatewaySuccess = {
          ok: true,
          channelId: request.channelId,
          cg,
          operation: request.operation,
          result,
        };
        if (Buffer.byteLength(JSON.stringify(value), 'utf8') > this.config.maxResultBytes) {
          throw new IntegrationApiError(502, 'result_too_large', 'query result exceeds the limit');
        }
        return value;
      },
    });
  }

  private async dispatch(cg: string, request: QueryGatewayRequest): Promise<QueryGatewayResult> {
    switch (request.operation) {
      case 'channel_memory':
        return this.channelMemory(cg);
      case 'contributor_trail':
        return this.contributorTrail(cg, request.arguments.pubkey);
      case 'software_contributors':
        return this.softwareContributors(
          cg,
          request.arguments.repository,
          request.arguments.componentName,
          request.arguments.componentType,
        );
      case 'decision_trace':
        return this.decisionTrace(
          cg,
          request.arguments.repository,
          request.arguments.commitSha,
          request.arguments.componentName,
        );
      case 'subgraph_graph':
        return this.subgraphGraph(cg, request.arguments.name);
      case 'subgraph_triples':
        return this.subgraphTriples(cg, request.arguments.name);
      case 'channel_triples':
        return this.channelTriples(cg);
      case 'evidence':
        return this.evidence(cg, request.arguments.uri);
      case 'semantic_query':
        return executeSemanticQuery({
          sparql: request.arguments.sparql,
          selectedView: request.arguments.view,
          maxQueryBytes: this.config.maxQueryBytes,
          dkgTimeoutMs: this.config.dkgTimeoutMs,
          query: async (view, sparql, timeoutMs) =>
            this.#executionPolicy.read(() =>
              this.dkg.query({ contextGraphId: cg, view, sparql }, timeoutMs),
            ),
        });
    }
  }

  private async queryResult(
    cg: string,
    view: VisibleView,
    sparql: string,
    subGraphName?: string,
    timeoutMs = this.config.dkgTimeoutMs,
  ): Promise<{ bindings: BindingRow[] }> {
    const response = await this.#executionPolicy.read(() =>
      this.dkg.query(
        { contextGraphId: cg, view, sparql, ...(subGraphName ? { subGraphName } : {}) },
        timeoutMs,
      ),
    );
    return { bindings: normalizeBindingQueryResult(response) };
  }

  private async query(
    cg: string,
    view: VisibleView,
    sparql: string,
    subGraphName?: string,
    maxRows = MAX_DKG_ROWS,
  ): Promise<BindingRow[]> {
    if (Buffer.byteLength(sparql, 'utf8') > this.config.maxQueryBytes) {
      throw new IntegrationApiError(
        500,
        'query_bound_exceeded',
        'internal query exceeded its bound',
      );
    }
    const result = await this.queryResult(cg, view, sparql, subGraphName);
    return result.bindings.slice(0, maxRows);
  }

  private async layered(cg: string, sparql: string, subGraphName?: string): Promise<LayeredRow[]> {
    const batches = await Promise.all(
      VIEWS.map(async ([view, layer]) =>
        (await this.query(cg, view, sparql, subGraphName)).map((row) => ({ row, layer })),
      ),
    );
    return batches.flat();
  }

  private async channelMemoryLayer(
    cg: string,
    view: VisibleView,
    layer: VisibleMemoryLayer,
  ): Promise<ChannelMemoryLayerSummary> {
    const rows = await this.query(
      cg,
      view,
      `SELECT DISTINCT ?rowType ?g ?name ?s ?digest ?t ?pk ?n ?latest WHERE {
        {
          {
            SELECT DISTINCT ?g WHERE {
              GRAPH ?g { ?graphSubject ?graphPredicate ?graphObject }
            } LIMIT 201
          }
          BIND("graph" AS ?rowType)
        }
        UNION
        {
          {
            SELECT DISTINCT ?g ?s ?name ?digest ?t WHERE {
              GRAPH ?g {
                ?s a <${BUZZ}DecisionCluster> .
                OPTIONAL { ?s <${SCHEMA}name> ?name }
                OPTIONAL { ?s <${BUZZ}sourceSetDigest> ?digest }
                OPTIONAL { ?s <${PROV}endedAtTime> ?t }
              }
            } LIMIT 201
          }
          BIND("decision" AS ?rowType)
        }
        UNION
        {
          {
            SELECT ?g ?pk (COUNT(DISTINCT ?event) AS ?n) (MAX(?eventAt) AS ?latest) WHERE {
              GRAPH ?g {
                ?event <${PROV}wasAttributedTo> ?agent .
                ?agent <${NOSTR}pubkeyHex> ?pk .
                OPTIONAL { ?event <${NOSTR}createdAt> ?eventAt }
              }
            } GROUP BY ?g ?pk LIMIT 201
          }
          BIND("contributor" AS ?rowType)
        }
      } LIMIT 1000`,
    );
    return summarizeChannelMemoryLayer(layer, rows);
  }

  private async channelMemory(cg: string): Promise<ChannelMemoryResult> {
    const [summaries, subGraphResponse] = await Promise.all([
      Promise.all(VIEWS.map(([view, layer]) => this.channelMemoryLayer(cg, view, layer))),
      this.#executionPolicy.read(() => this.dkg.listSubGraphs(cg, this.config.dkgTimeoutMs)),
    ]);

    const layerGraphs: Record<VisibleMemoryLayer, { graph: string; label: string }[]> = {
      SWM: [],
      VM: [],
    };

    const decisionsByUri = new Map<string, DecisionSummary>();
    const contributorsByPubkey = new Map<string, ContributorSummary>();
    for (const summary of summaries) {
      layerGraphs[summary.layer] = summary.graphs;
      for (const candidate of summary.contributors) {
        const current = contributorsByPubkey.get(candidate.pubkey);
        if (!current) {
          contributorsByPubkey.set(candidate.pubkey, candidate);
        } else {
          current.events = Math.max(current.events, candidate.events);
          current.latest = Math.max(current.latest ?? 0, candidate.latest ?? 0) || null;
          if (LAYER_RANK[candidate.layer] > LAYER_RANK[current.layer]) {
            current.layer = candidate.layer;
          }
        }
      }
      for (const candidate of summary.decisions) {
        const current = decisionsByUri.get(candidate.uri);
        if (!current || LAYER_RANK[candidate.layer] > LAYER_RANK[current.layer]) {
          decisionsByUri.set(candidate.uri, candidate);
        }
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
      layers: { WM: null, SWM: layerGraphs.SWM, VM: layerGraphs.VM },
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

  private async softwareContributors(
    cg: string,
    repository: string,
    componentName: string,
    componentType?: keyof typeof COMPONENT_TYPES,
  ): Promise<SoftwareContributorsResult> {
    const componentPattern = componentType
      ? `?component a <${CODE}${COMPONENT_TYPES[componentType]}> ;
           <${SCHEMA}name> ${sparqlLiteral(componentName)} .`
      : `?component a ?componentType ; <${SCHEMA}name> ${sparqlLiteral(componentName)} .
         FILTER(STRSTARTS(STR(?componentType), "${CODE}"))`;
    const rows = await this.layered(
      cg,
      `SELECT DISTINCT ?contributor ?contributorName ?commit ?sha ?at WHERE { GRAPH ?g {
         ${componentPattern}
         ?component <${SOFTWARE}repository> ?repository .
         ?repository (<${GITHUB}url>|<${SCHEMA}url>) ?repositoryUrl .
         FILTER(STR(?repositoryUrl) = ${sparqlLiteral(repository)})
         ?commit a <${GITHUB}Commit> ; <${GITHUB}affects> ?component ;
           <${GITHUB}authoredBy> ?contributor ; <${GITHUB}sha> ?sha .
         OPTIONAL { ?contributor <${SCHEMA}name> ?contributorName }
         OPTIONAL { ?commit <${SCHEMA}dateCreated> ?at }
       } } ORDER BY ?at ?contributorName LIMIT 200`,
    );
    const byKey = new Map<string, SoftwareContributorEntry>();
    for (const { row, layer } of rows) {
      const contributor = bounded(term(row, 'contributor'), 1_000);
      const commit = bounded(term(row, 'commit'), 1_000);
      const sha = bounded(term(row, 'sha').toLowerCase(), 64);
      if (!contributor || !commit || !COMMIT_SHA.test(sha)) continue;
      const key = `${contributor}\0${commit}`;
      const candidate: SoftwareContributorEntry = {
        contributor,
        contributorName: optionalTerm(row, 'contributorName')
          ? bounded(optionalTerm(row, 'contributorName')!, 500)
          : null,
        commit,
        sha,
        at: dateTimestamp(row.at),
        layer,
      };
      const current = byKey.get(key);
      if (!current || LAYER_RANK[layer] > LAYER_RANK[current.layer]) byKey.set(key, candidate);
    }
    return {
      repository,
      componentName,
      componentType: componentType ?? null,
      contributors: [...byKey.values()].sort(
        (a, b) => (a.at ?? 0) - (b.at ?? 0) || a.sha.localeCompare(b.sha),
      ),
    };
  }

  private async decisionTrace(
    cg: string,
    repository: string,
    commitSha: string,
    componentName: string,
  ): Promise<DecisionTraceResult> {
    const rows = await this.layered(
      cg,
      `SELECT DISTINCT ?decision ?decisionName ?context ?outcome ?commit ?sha ?component WHERE { GRAPH ?g {
         ?component <${SCHEMA}name> ${sparqlLiteral(componentName)} ;
           <${SOFTWARE}repository> ?repositoryEntity .
         ?repositoryEntity (<${GITHUB}url>|<${SCHEMA}url>) ?repositoryUrl .
         FILTER(STR(?repositoryUrl) = ${sparqlLiteral(repository)})
         ?commit a <${GITHUB}Commit> ; <${GITHUB}sha> ?sha ;
           <${GITHUB}inRepo> ?repositoryEntity ; <${GITHUB}affects> ?component .
         FILTER(LCASE(STR(?sha)) = ${sparqlLiteral(commitSha.toLowerCase())})
         ?decision a <${DECISIONS}Decision> ; <${DECISIONS}affects> ?component ;
           <${DECISIONS}implementedBy> ?commit .
         OPTIONAL { ?decision <${SCHEMA}name> ?decisionName }
         OPTIONAL { ?decision <${DECISIONS}context> ?context }
         OPTIONAL { ?decision <${DECISIONS}outcome> ?outcome }
       } } ORDER BY ?decision LIMIT 200`,
    );
    const byKey = new Map<string, DecisionTraceEntry>();
    for (const { row, layer } of rows) {
      const decision = bounded(term(row, 'decision'), 1_000);
      const commit = bounded(term(row, 'commit'), 1_000);
      const component = bounded(term(row, 'component'), 1_000);
      const sha = bounded(term(row, 'sha').toLowerCase(), 64);
      if (!decision || !commit || !component || !COMMIT_SHA.test(sha)) continue;
      const key = `${decision}\0${commit}\0${component}`;
      const candidate: DecisionTraceEntry = {
        decision,
        decisionName: optionalTerm(row, 'decisionName')
          ? bounded(optionalTerm(row, 'decisionName')!, 500)
          : null,
        context: optionalTerm(row, 'context')
          ? bounded(optionalTerm(row, 'context')!, 4_000)
          : null,
        outcome: optionalTerm(row, 'outcome')
          ? bounded(optionalTerm(row, 'outcome')!, 4_000)
          : null,
        commit,
        sha,
        component,
        layer,
      };
      const current = byKey.get(key);
      if (!current || LAYER_RANK[layer] > LAYER_RANK[current.layer]) byKey.set(key, candidate);
    }
    return { repository, commitSha, componentName, decisions: [...byKey.values()] };
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

  private async channelTriples(cg: string): Promise<ChannelTriplesResult> {
    const query = `SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT ${
      MAX_CHANNEL_TRIPLES + 1
    }`;
    const triples = new Map<string, GraphTriple>();
    let truncated = false;

    // Query serially to avoid doubling peak Blazegraph load. VM comes first so
    // a shared/verifiable duplicate retains its strongest visible layer.
    for (const [view, layer] of [...VIEWS].reverse()) {
      const rows = await this.query(cg, view, query, undefined, MAX_CHANNEL_TRIPLES + 1);
      if (rows.length > MAX_CHANNEL_TRIPLES) truncated = true;
      for (const row of rows) {
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
        if (triples.size >= MAX_CHANNEL_TRIPLES) {
          truncated = true;
          continue;
        }
        const graph = term(row, 'g');
        const agentMatch = /\/([a-z0-9_-]+)\/_?(?:shared|verifiable)_memory\//iu.exec(graph);
        triples.set(key, {
          subject,
          predicate,
          object,
          layer,
          agent: bounded(agentMatch?.[1] ?? 'channel', 128),
        });
      }
    }

    return {
      triples: [...triples.values()],
      limit: MAX_CHANNEL_TRIPLES,
      truncated,
    };
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
