import type { DkgClient } from '../dkg/client.ts';
import { IntegrationApiError } from '../errors.ts';
import { canonicalRepositoryIdentityUrl } from '../memory/identity.ts';
import type { QueryGatewayConfig } from '../types.ts';
import type {
  ChannelMemoryResult,
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
  ReputationConfidence,
  ReputationSummaryResult,
  SoftwareContributorEntry,
  SoftwareContributorsResult,
  SubGraphSummary,
  SubgraphGraphResult,
  SubgraphTriplesResult,
  TrustNetworkResult,
  TrustPersonSummary,
  TrustVouchSummary,
  TrustVouchStatus,
  VisibleMemoryLayer,
  WorkEvidenceSummary,
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
const HEX_SIGNATURE = /^[0-9a-f]{128}$/iu;
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
const MAX_TRUST_PEOPLE = 200;
const MAX_TRUST_VOUCHES = 400;
const MAX_TRUST_SUPPORTS = 2_400;
const MAX_TRUST_LIFECYCLE = 400;
const MAX_WORK_EVIDENCE = 24;

const BUZZ = 'https://w3id.org/buzz-dkg/buzz#';
const NOSTR = 'https://w3id.org/buzz-dkg/nostr#';
const PROV = 'http://www.w3.org/ns/prov#';
const SCHEMA = 'http://schema.org/';
const CODE = 'http://dkg.io/ontology/code/';
const GITHUB = 'http://dkg.io/ontology/github/';
const DECISIONS = 'http://dkg.io/ontology/decisions/';
const MEMORY = 'http://dkg.io/ontology/memory/';
const TASKS = 'http://dkg.io/ontology/tasks/';
const SOFTWARE = 'http://dkg.io/ontology/software/';
const TRUST = 'http://dkg.io/ontology/trust/';
const NOSTR_PUBKEY_URI = 'urn:nostr:pubkey:';
const NOSTR_EVENT_URI = /^urn:nostr:event:[0-9a-f]{64}$/u;

function trustVouchStatus(value: string | null): TrustVouchStatus {
  return value === 'active' || value === 'revoked' || value === 'superseded' ? value : 'unknown';
}

function vouchLineageGroups(vouches: readonly TrustVouchSummary[]): TrustVouchSummary[][] {
  const parent = vouches.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]!]!;
      index = parent[index]!;
    }
    return index;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  const rootOwner = new Map<string, number>();
  for (const [index, vouch] of vouches.entries()) {
    const evidenceRoots =
      vouch.evidence.length > 0
        ? vouch.evidence
        : [vouch.sourceEvent ?? `urn:buzz-dkg:lineage:${vouch.uri}`];
    // Repeated statements by one signer are one corroborating source even
    // when they cite different artifacts. Shared artifacts likewise connect
    // signers into one evidence lineage instead of inflating corroboration.
    const roots = [`urn:buzz-dkg:issuer:${vouch.issuer}`, ...evidenceRoots];
    for (const root of roots) {
      const owner = rootOwner.get(root);
      if (owner === undefined) rootOwner.set(root, index);
      else union(index, owner);
    }
  }
  const groups = new Map<number, TrustVouchSummary[]>();
  for (const [index, vouch] of vouches.entries()) {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(vouch);
    groups.set(root, group);
  }
  return [...groups.values()];
}

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
  exactKeys(value, ['channelId', 'operation', 'arguments', 'requesterPubkey'], 'request');
  const channelId = requiredString(value.channelId, 'channelId', CHANNEL_ID);
  const operations = new Set<QueryOperation>([
    'channel_memory',
    'contributor_trail',
    'software_contributors',
    'decision_trace',
    'trust_network',
    'reputation_summary',
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
  if (operation === 'channel_memory' || operation === 'trust_network') {
    exactKeys(value.arguments, [], 'arguments');
    return { ...base, operation, arguments: {} };
  }
  if (operation === 'contributor_trail' || operation === 'reputation_summary') {
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

export function withGatewayTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new IntegrationApiError(504, 'gateway_timeout', 'operation timed out')),
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
    resolveContextGraph: (channelId: string) => string | null | Promise<string | null>,
    dkg: DkgClient,
    config: EnabledGatewayConfig,
  ) {
    this.dkg = dkg;
    this.config = config;
    this.#resolveContextGraph = resolveContextGraph;
  }

  async execute(input: unknown): Promise<QueryGatewaySuccess> {
    const request = parseQueryGatewayRequest(input);
    const cg = await this.#resolveContextGraph(request.channelId);
    if (!cg) {
      throw new IntegrationApiError(
        404,
        'unknown_channel',
        'channel is not configured for DKG queries',
      );
    }
    const result = await withGatewayTimeout(
      this.dispatch(cg, request),
      this.config.operationTimeoutMs,
    );
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
      case 'trust_network':
        return this.trustNetwork(cg);
      case 'reputation_summary':
        return this.reputationSummary(cg, request.arguments.pubkey, request.requesterPubkey);
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
      throw new IntegrationApiError(
        500,
        'query_bound_exceeded',
        'internal query exceeded its bound',
      );
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

  private async trustNetwork(cg: string): Promise<TrustNetworkResult> {
    const [contributionRows, vouchRows, supportRows, lifecycleRows] = await Promise.all([
      this.layered(
        cg,
        `SELECT ?pk (COUNT(DISTINCT ?record) AS ?n) (MAX(?at) AS ?latest)
         WHERE { GRAPH ?g {
           ?memory <${MEMORY}contains> ?record .
           ?record a ?kind ;
             <${PROV}wasAttributedTo> ?agent ;
             <${PROV}wasDerivedFrom> ?source .
           VALUES ?kind {
             <${MEMORY}Claim> <${MEMORY}Question>
             <${DECISIONS}Decision> <${TASKS}Task>
             <${GITHUB}PullRequest> <${GITHUB}Issue> <${GITHUB}Commit> <${GITHUB}Review>
             <${SOFTWARE}Build> <${SOFTWARE}TestCase> <${SOFTWARE}TestRun>
             <${SOFTWARE}Deployment> <${SOFTWARE}Finding>
           }
           ?agent <${NOSTR}pubkeyHex> ?pk .
           OPTIONAL { ?source <${NOSTR}createdAt> ?at }
         } } GROUP BY ?pk ORDER BY DESC(?n) LIMIT ${MAX_TRUST_PEOPLE + 1}`,
      ),
      this.layered(
        cg,
        `SELECT DISTINCT ?vouch ?issuer ?subject ?note ?status ?at ?source
          ?sourceKind ?sourceAuthor ?sourceTags ?sourceSig WHERE { GRAPH ?g {
           ?vouch a <${TRUST}Vouch> ;
             <${TRUST}issuer> ?issuer ;
             <${TRUST}subject> ?subject ;
             <${TRUST}scope> "channel" .
           OPTIONAL { ?vouch <${SCHEMA}description> ?note }
           OPTIONAL { ?vouch <${TRUST}status> ?status }
           OPTIONAL {
             ?vouch <${PROV}wasDerivedFrom> ?source .
             ?source a <${NOSTR}Event> ;
               <${NOSTR}kind> ?sourceKind ;
               <${NOSTR}tags> ?sourceTags ;
               <${NOSTR}sig> ?sourceSig ;
               <${PROV}wasAttributedTo> ?sourceAuthor .
             OPTIONAL { ?source <${NOSTR}createdAt> ?at }
           }
         } } ORDER BY DESC(?at) LIMIT ${MAX_TRUST_VOUCHES + 1}`,
      ),
      this.layered(
        cg,
        `SELECT DISTINCT ?vouch ?reference ?target ?evidenceSource WHERE { GRAPH ?g {
           ?vouch <${TRUST}supportedBy> ?reference .
           ?reference <${TRUST}evidenceTarget> ?target .
           OPTIONAL { ?reference <${TRUST}evidenceSource> ?evidenceSource }
         } } LIMIT ${MAX_TRUST_SUPPORTS + 1}`,
      ),
      this.layered(
        cg,
        `SELECT DISTINCT ?action ?issuer ?subject ?status ?target ?replacement ?at ?source
         WHERE { GRAPH ?g {
           ?action <${TRUST}targetVouch> ?target ;
             <${TRUST}issuer> ?issuer ;
             <${TRUST}subject> ?subject ;
             <${TRUST}status> ?status .
           OPTIONAL { ?action <${TRUST}replacementVouch> ?replacement }
           OPTIONAL {
             ?action <${PROV}wasDerivedFrom> ?source .
             OPTIONAL { ?source <${NOSTR}createdAt> ?at }
           }
         } } ORDER BY DESC(?at) LIMIT ${MAX_TRUST_LIFECYCLE + 1}`,
      ),
    ]);

    const queryHitBound = (rows: LayeredRow[], maximum: number): boolean =>
      VIEWS.some(
        ([, layer]) => rows.filter((candidate) => candidate.layer === layer).length > maximum,
      );
    let partial =
      queryHitBound(contributionRows, MAX_TRUST_PEOPLE) ||
      queryHitBound(vouchRows, MAX_TRUST_VOUCHES) ||
      queryHitBound(supportRows, MAX_TRUST_SUPPORTS) ||
      queryHitBound(lifecycleRows, MAX_TRUST_LIFECYCLE);

    const people = new Map<string, TrustPersonSummary>();
    const upsertPerson = (pubkey: string, layer: VisibleMemoryLayer): TrustPersonSummary => {
      const current = people.get(pubkey);
      if (current) {
        if (LAYER_RANK[layer] > LAYER_RANK[current.layer]) current.layer = layer;
        return current;
      }
      const created: TrustPersonSummary = {
        pubkey,
        contributions: 0,
        contributionLayer: null,
        latest: null,
        vouchesReceived: 0,
        vouchesGiven: 0,
        layer,
      };
      people.set(pubkey, created);
      return created;
    };
    for (const { row, layer } of contributionRows) {
      const pubkey = term(row, 'pk').toLowerCase();
      if (!HEX_PUBKEY.test(pubkey)) continue;
      const person = upsertPerson(pubkey, layer);
      person.contributions = Math.max(person.contributions, count(row.n));
      if (
        person.contributionLayer === null ||
        LAYER_RANK[layer] > LAYER_RANK[person.contributionLayer]
      ) {
        person.contributionLayer = layer;
      }
      person.latest = Math.max(person.latest ?? 0, dateTimestamp(row.latest) ?? 0) || null;
    }

    const pubkeyFromEntity = (value: string): string | null => {
      if (!value.startsWith(NOSTR_PUBKEY_URI)) return null;
      const pubkey = value.slice(NOSTR_PUBKEY_URI.length).toLowerCase();
      return HEX_PUBKEY.test(pubkey) ? pubkey : null;
    };
    const vouchesByUri = new Map<string, TrustVouchSummary>();
    for (const { row, layer } of vouchRows) {
      const uri = bounded(term(row, 'vouch'), 1_000);
      const issuer = pubkeyFromEntity(term(row, 'issuer'));
      const subject = pubkeyFromEntity(term(row, 'subject'));
      if (!uri || !issuer || !subject || issuer === subject) continue;
      const source = optionalTerm(row, 'source');
      const sourceAuthor = optionalTerm(row, 'sourceAuthor');
      const sourceTags = optionalTerm(row, 'sourceTags');
      const sourceKind = optionalTerm(row, 'sourceKind');
      const sourceSig = optionalTerm(row, 'sourceSig');
      let sourceMatches = false;
      if (
        source &&
        NOSTR_EVENT_URI.test(source) &&
        sourceAuthor === `${NOSTR_PUBKEY_URI}${issuer}` &&
        sourceKind === '1985' &&
        sourceSig !== null &&
        HEX_SIGNATURE.test(sourceSig) &&
        sourceTags
      ) {
        try {
          const tags = JSON.parse(sourceTags) as unknown;
          if (Array.isArray(tags) && tags.every((tag) => Array.isArray(tag))) {
            const normalized = tags as unknown[][];
            const subjects = normalized.filter((tag) => tag[0] === 'p');
            sourceMatches =
              subjects.length === 1 &&
              typeof subjects[0]?.[1] === 'string' &&
              subjects[0][1].toLowerCase() === subject &&
              normalized.some((tag) => tag[0] === 'L' && tag[1] === 'buzz.wot') &&
              normalized.some(
                (tag) => tag[0] === 'l' && tag[1] === 'vouch' && tag[2] === 'buzz.wot',
              );
          }
        } catch {
          sourceMatches = false;
        }
      }
      const candidate: TrustVouchSummary = {
        uri,
        issuer,
        subject,
        note: optionalTerm(row, 'note') ? bounded(optionalTerm(row, 'note')!, 1_000) : null,
        status: trustVouchStatus(optionalTerm(row, 'status')),
        at: dateTimestamp(row.at),
        sourceEvent: sourceMatches ? bounded(source!, 1_000) : null,
        evidence: [],
        lifecycleEvent: null,
        replacementVouch: null,
        layer,
      };
      const current = vouchesByUri.get(uri);
      if (
        !current ||
        LAYER_RANK[layer] > LAYER_RANK[current.layer] ||
        (layer === current.layer && current.sourceEvent === null && candidate.sourceEvent !== null)
      ) {
        vouchesByUri.set(uri, candidate);
      }
    }

    for (const { row } of supportRows) {
      const vouch = vouchesByUri.get(bounded(term(row, 'vouch'), 1_000));
      const target = bounded(term(row, 'target'), 1_000);
      if (!vouch || !SAFE_IRI.test(target) || vouch.evidence.includes(target)) continue;
      vouch.evidence.push(target);
    }

    type LifecycleAction = {
      issuer: string;
      subject: string;
      status: 'revoked' | 'superseded';
      at: number | null;
      source: string | null;
      replacement: string | null;
      layer: VisibleMemoryLayer;
    };
    const lifecycleByTarget = new Map<string, LifecycleAction>();
    for (const { row, layer } of lifecycleRows) {
      const target = bounded(term(row, 'target'), 1_000);
      const targetVouch = vouchesByUri.get(target);
      const issuer = pubkeyFromEntity(term(row, 'issuer'));
      const subject = pubkeyFromEntity(term(row, 'subject'));
      const status = term(row, 'status');
      const source = optionalTerm(row, 'source')
        ? bounded(optionalTerm(row, 'source')!, 1_000)
        : null;
      const replacement = optionalTerm(row, 'replacement')
        ? bounded(optionalTerm(row, 'replacement')!, 1_000)
        : null;
      if (
        !targetVouch ||
        !issuer ||
        !subject ||
        issuer !== targetVouch.issuer ||
        subject !== targetVouch.subject ||
        !new Set(['revoked', 'superseded']).has(status) ||
        !source ||
        !NOSTR_EVENT_URI.test(source) ||
        (status === 'superseded' && (!replacement || !SAFE_IRI.test(replacement))) ||
        (status === 'revoked' && replacement)
      ) {
        continue;
      }
      const candidate: LifecycleAction = {
        issuer,
        subject,
        status: status as LifecycleAction['status'],
        at: dateTimestamp(row.at),
        source,
        replacement,
        layer,
      };
      const current = lifecycleByTarget.get(target);
      if (
        !current ||
        (candidate.at ?? 0) > (current.at ?? 0) ||
        ((candidate.at ?? 0) === (current.at ?? 0) &&
          candidate.source!.localeCompare(current.source ?? '') > 0)
      ) {
        lifecycleByTarget.set(target, candidate);
      }
    }
    for (const [target, lifecycle] of lifecycleByTarget) {
      const vouch = vouchesByUri.get(target)!;
      vouch.status = lifecycle.status;
      vouch.lifecycleEvent = lifecycle.source;
      vouch.replacementVouch = lifecycle.replacement;
      if (LAYER_RANK[lifecycle.layer] > LAYER_RANK[vouch.layer]) vouch.layer = lifecycle.layer;
    }
    const sortedVouches = [...vouchesByUri.values()].sort(
      (a, b) => (b.at ?? 0) - (a.at ?? 0) || a.uri.localeCompare(b.uri),
    );
    if (sortedVouches.length > MAX_TRUST_VOUCHES) partial = true;
    const vouches = sortedVouches.slice(0, MAX_TRUST_VOUCHES);
    for (const vouch of vouches) {
      if (vouch.status !== 'active') continue;
      upsertPerson(vouch.issuer, vouch.layer).vouchesGiven += 1;
      upsertPerson(vouch.subject, vouch.layer).vouchesReceived += 1;
    }

    const sortedPeople = [...people.values()].sort(
      (a, b) =>
        b.vouchesReceived - a.vouchesReceived ||
        b.contributions - a.contributions ||
        a.pubkey.localeCompare(b.pubkey),
    );
    if (sortedPeople.length > MAX_TRUST_PEOPLE) partial = true;

    return {
      completeness: partial ? 'partial' : 'complete',
      people: sortedPeople.slice(0, MAX_TRUST_PEOPLE),
      vouches,
    };
  }

  /**
   * Calculate one channel-contextual reputation lens from a bounded trust
   * network snapshot. SPARQL discovers at most 200 people and 400 vouches;
   * traversal and scoring happen here, never recursively inside the database.
   */
  private async reputationSummary(
    cg: string,
    subject: string,
    perspective: string,
  ): Promise<ReputationSummaryResult> {
    const [network, workRows] = await Promise.all([
      this.trustNetwork(cg),
      this.layered(
        cg,
        `SELECT DISTINCT ?record ?kind ?name ?source ?at WHERE { GRAPH ?g {
           ?record a ?kind ;
             <${PROV}wasAttributedTo> <${NOSTR_PUBKEY_URI}${subject}> ;
             <${PROV}wasDerivedFrom> ?source .
           VALUES ?kind {
             <${MEMORY}Claim> <${MEMORY}Question>
             <${DECISIONS}Decision> <${TASKS}Task>
             <${GITHUB}PullRequest> <${GITHUB}Issue> <${GITHUB}Commit> <${GITHUB}Review>
             <${SOFTWARE}Build> <${SOFTWARE}TestCase> <${SOFTWARE}TestRun>
             <${SOFTWARE}Deployment> <${SOFTWARE}Finding>
           }
           OPTIONAL { ?record <${SCHEMA}name> ?name }
           OPTIONAL { ?source <${NOSTR}createdAt> ?at }
         } } ORDER BY DESC(?at) LIMIT ${MAX_WORK_EVIDENCE + 1}`,
      ),
    ]);
    const active = network.vouches.filter(
      (vouch) =>
        vouch.status === 'active' &&
        vouch.sourceEvent !== null &&
        NOSTR_EVENT_URI.test(vouch.sourceEvent),
    );
    const inbound = active.filter((vouch) => vouch.subject === subject);
    const requesterVouches = new Set(
      active.filter((vouch) => vouch.issuer === perspective).map((vouch) => vouch.subject),
    );
    const inboundIssuers = new Set(inbound.map((vouch) => vouch.issuer));
    const directVouch = inboundIssuers.has(perspective);
    const twoHopIssuers = new Set(
      [...inboundIssuers].filter(
        (issuer) => issuer !== perspective && issuer !== subject && requesterVouches.has(issuer),
      ),
    );
    const person = network.people.find((candidate) => candidate.pubkey === subject);
    const evidenceRecords = person?.contributions ?? 0;
    const verifiableEvidence = person?.contributionLayer === 'VM';
    const lineageGroups = vouchLineageGroups(inbound);
    const directLineages = lineageGroups.filter((group) =>
      group.some((vouch) => vouch.issuer === perspective),
    );
    const twoHopLineages = lineageGroups.filter(
      (group) =>
        !directLineages.includes(group) && group.some((vouch) => twoHopIssuers.has(vouch.issuer)),
    );
    const communityLineages = lineageGroups.filter(
      (group) => !directLineages.includes(group) && !twoHopLineages.includes(group),
    );
    const independentLineages = lineageGroups.length;

    // Versioned, deliberately saturating weights. Activity volume cannot grow
    // a dimension beyond 100, and independent humans matter more than repeats.
    const directTrust = Math.min(
      100,
      (directVouch ? 60 : 0) +
        Math.min(2, independentLineages - (directLineages.length > 0 ? 1 : 0)) * 20,
    );
    const networkTrust = Math.min(100, twoHopLineages.length * 45 + communityLineages.length * 15);
    const demonstratedWork = Math.min(100, Math.round(evidenceRecords * 12.5));
    const evidenceDiversity = Math.min(
      100,
      independentLineages * 20 + Math.min(evidenceRecords, 5) * 8 + (verifiableEvidence ? 20 : 0),
    );
    const score = Math.round(
      directTrust * 0.35 + networkTrust * 0.25 + demonstratedWork * 0.3 + evidenceDiversity * 0.1,
    );
    const confidenceEvidence =
      independentLineages * 2 + Math.min(evidenceRecords, 8) + (verifiableEvidence ? 2 : 0);
    const confidence: ReputationConfidence =
      confidenceEvidence === 0
        ? 'none'
        : confidenceEvidence <= 3
          ? 'low'
          : confidenceEvidence <= 8
            ? 'medium'
            : 'high';

    const reasons: string[] = [];
    if (directVouch) reasons.push('You signed a direct vouch for this person.');
    if (inboundIssuers.size > 0) {
      reasons.push(
        `${inboundIssuers.size} independent contributor${inboundIssuers.size === 1 ? '' : 's'} signed a vouch.`,
      );
    }
    if (inbound.length > independentLineages) {
      reasons.push(
        `${inbound.length} vouches reduce to ${independentLineages} independent evidence lineage${independentLineages === 1 ? '' : 's'}.`,
      );
    }
    if (twoHopIssuers.size > 0) {
      reasons.push(
        `${twoHopIssuers.size} vouch${twoHopIssuers.size === 1 ? '' : 'es'} arrived through a two-hop trust path.`,
      );
    }
    if (evidenceRecords > 0) {
      reasons.push(
        `${evidenceRecords} attributed channel evidence record${evidenceRecords === 1 ? '' : 's'} were found.`,
      );
    }
    if (verifiableEvidence) reasons.push('Verifiable-memory evidence is available.');
    if (network.completeness === 'partial') {
      reasons.push(
        'Evidence discovery reached the channel bound; this score uses a bounded sample.',
      );
    }
    if (reasons.length === 0) reasons.push('No reputation evidence exists in this channel yet.');

    const pathSubjects = new Set([...twoHopIssuers]);
    const evidenceByUri = new Map<string, TrustVouchSummary>();
    for (const vouch of active) {
      if (
        vouch.subject === subject ||
        (vouch.issuer === perspective && pathSubjects.has(vouch.subject))
      ) {
        evidenceByUri.set(vouch.uri, vouch);
      }
      if (evidenceByUri.size >= 25) break;
    }

    const workByUri = new Map<string, WorkEvidenceSummary>();
    for (const { row, layer } of workRows) {
      const uri = bounded(term(row, 'record'), 1_000);
      const kind = bounded(term(row, 'kind'), 1_000);
      const sourceEvent = optionalTerm(row, 'source')
        ? bounded(optionalTerm(row, 'source')!, 1_000)
        : null;
      if (!SAFE_IRI.test(uri) || !SAFE_IRI.test(kind)) continue;
      const candidate: WorkEvidenceSummary = {
        uri,
        kind,
        name: optionalTerm(row, 'name') ? bounded(optionalTerm(row, 'name')!, 500) : null,
        sourceEvent: sourceEvent && NOSTR_EVENT_URI.test(sourceEvent) ? sourceEvent : null,
        at: dateTimestamp(row.at),
        layer,
      };
      const current = workByUri.get(uri);
      if (!current || LAYER_RANK[layer] > LAYER_RANK[current.layer]) workByUri.set(uri, candidate);
    }
    const workEvidence = [...workByUri.values()]
      .sort((left, right) => (right.at ?? 0) - (left.at ?? 0) || left.uri.localeCompare(right.uri))
      .slice(0, MAX_WORK_EVIDENCE);
    const workQueryPartial = VIEWS.some(
      ([, layer]) =>
        workRows.filter((candidate) => candidate.layer === layer).length > MAX_WORK_EVIDENCE,
    );
    if (workQueryPartial && network.completeness === 'complete') {
      reasons.push('Work-evidence discovery reached its fixed channel bound.');
    }

    return {
      subject,
      perspective,
      context: 'channel',
      completeness: network.completeness === 'partial' || workQueryPartial ? 'partial' : 'complete',
      score,
      confidence,
      breakdown: { directTrust, networkTrust, demonstratedWork, evidenceDiversity },
      signals: {
        directVouch,
        twoHopVouchers: twoHopIssuers.size,
        independentVouchers: inboundIssuers.size,
        independentLineages,
        evidenceRecords,
        verifiableEvidence,
      },
      reasons,
      evidence: [...evidenceByUri.values()],
      workEvidence,
      methodology: 'dkg-reputation-v2',
    };
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
