export type QueryOperation =
  | 'channel_memory'
  | 'contributor_trail'
  | 'software_contributors'
  | 'decision_trace'
  | 'subgraph_graph'
  | 'subgraph_triples'
  | 'evidence'
  | 'semantic_query';

interface RequestBase<T extends QueryOperation, A> {
  channelId: string;
  operation: T;
  arguments: A;
  requesterPubkey: string;
}

export type SemanticQueryView = 'both' | 'shared' | 'verified';

interface SemanticQueryRequest extends RequestBase<
  'semantic_query',
  { sparql: string; view: SemanticQueryView }
> {
  scope: { type: 'current_channel' };
}

export type QueryGatewayRequest =
  | RequestBase<'channel_memory', Record<string, never>>
  | RequestBase<'contributor_trail', { pubkey: string }>
  | RequestBase<
      'software_contributors',
      {
        repository: string;
        componentName: string;
        componentType?: 'function' | 'class' | 'interface' | 'file' | 'package';
      }
    >
  | RequestBase<'decision_trace', { repository: string; commitSha: string; componentName: string }>
  | RequestBase<'subgraph_graph', { name: string }>
  | RequestBase<'subgraph_triples', { name: string }>
  | RequestBase<'evidence', { uri: string }>
  | SemanticQueryRequest;

export type VisibleMemoryLayer = 'SWM' | 'VM';

export interface LayerEntry {
  graph: string;
  label: string;
}

export interface DecisionSummary {
  uri: string;
  name: string | null;
  digest: string | null;
  at: string | null;
  layer: VisibleMemoryLayer;
}

export interface ContributorSummary {
  pubkey: string;
  events: number;
  latest: number | null;
  layer: VisibleMemoryLayer;
}

export interface SubGraphSummary {
  name: string;
  uri: string;
  description: string | null;
  createdBy: string | null;
  createdAt: string | null;
  entityCount: number;
  tripleCount: number;
}

export interface ChannelMemoryResult {
  layers: {
    /** Working memory is intentionally not queried by this community gateway. */
    WM: null;
    SWM: LayerEntry[];
    VM: LayerEntry[];
  };
  decisions: DecisionSummary[];
  contributors: ContributorSummary[];
  subgraphs: SubGraphSummary[];
}

export interface ContributorTrailEntry {
  event: string;
  content: string | null;
  at: number | null;
  decision: string | null;
  decisionName: string | null;
  layer: VisibleMemoryLayer;
}

export interface ContributorTrailResult {
  pubkey: string;
  trail: ContributorTrailEntry[];
}

export interface SoftwareContributorEntry {
  contributor: string;
  contributorName: string | null;
  commit: string;
  sha: string;
  at: number | null;
  layer: VisibleMemoryLayer;
}

export interface SoftwareContributorsResult {
  repository: string;
  componentName: string;
  componentType: string | null;
  contributors: SoftwareContributorEntry[];
}

export interface DecisionTraceEntry {
  decision: string;
  decisionName: string | null;
  context: string | null;
  outcome: string | null;
  commit: string;
  sha: string;
  component: string;
  layer: VisibleMemoryLayer;
}

export interface DecisionTraceResult {
  repository: string;
  commitSha: string;
  componentName: string;
  decisions: DecisionTraceEntry[];
}

export interface GraphNode {
  id: string;
  kind: 'claim' | 'commit' | 'decision';
  label: string;
  at: number | null;
  layer: VisibleMemoryLayer;
  contested?: number;
  run?: string | null;
  commit?: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  rel: 'supports' | 'contradicts';
}

export interface SubgraphGraphResult {
  subgraph: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphTriple {
  subject: string;
  predicate: string;
  object: string;
  layer: VisibleMemoryLayer;
  agent: string;
}

export interface SubgraphTriplesResult {
  subgraph: string;
  triples: GraphTriple[];
}

export interface EvidenceSource {
  id: string;
  span: string | null;
  author: string | null;
  at: number | null;
}

export interface EvidenceRelation {
  from: string;
  rel: string;
}

export interface EvidenceResult {
  found: boolean;
  claimId: string;
  name: string | null;
  status: string | null;
  trustState: string | null;
  memoryLayer: VisibleMemoryLayer | null;
  attribution: string[];
  digest: string | null;
  asOf: string | null;
  sources: EvidenceSource[];
  relations: EvidenceRelation[];
  receiptUal: string | null;
  graph: string | null;
}

export interface SemanticQueryMetrics {
  triples: number;
  constructTriples: number;
  optionalPatterns: number;
  unionBranches: number;
  filters: number;
  graphPatterns: number;
  propertyPaths: number;
  variablePredicates: number;
  subqueries: number;
  valuesRows: number;
  aggregates: number;
  orderConditions: number;
  groupConditions: number;
  distinct: number;
}

export type SparqlJsonValue =
  null | boolean | number | string | SparqlJsonValue[] | { [key: string]: SparqlJsonValue };

/** Stable public boundary for SPARQL JSON binding terms returned by DKG. */
export type SparqlBindingValue = string | { [key: string]: SparqlJsonValue };
export type SparqlBindingRow = Record<string, SparqlBindingValue>;
export type SparqlQuad = { [key: string]: SparqlJsonValue };

export interface SemanticQueryLayerResult {
  layer: VisibleMemoryLayer;
  bindings: SparqlBindingRow[];
  quads?: SparqlQuad[];
}

export interface SemanticQueryResult {
  queryType: 'select' | 'ask' | 'construct';
  scope: { type: 'current_channel' };
  cost: {
    score: number;
    budget: number;
    metrics: SemanticQueryMetrics;
  };
  layers: SemanticQueryLayerResult[];
}

export type QueryGatewayResult =
  | ChannelMemoryResult
  | ContributorTrailResult
  | SoftwareContributorsResult
  | DecisionTraceResult
  | SubgraphGraphResult
  | SubgraphTriplesResult
  | EvidenceResult
  | SemanticQueryResult;

export interface QueryGatewaySuccess {
  ok: true;
  channelId: string;
  /** Context Graph resolved by the server from the configured channel binding. */
  cg: string;
  operation: QueryOperation;
  result: QueryGatewayResult;
}
