export type QueryOperation =
  | 'channel_memory'
  | 'contributor_trail'
  | 'software_contributors'
  | 'decision_trace'
  | 'trust_network'
  | 'reputation_summary'
  | 'subgraph_graph'
  | 'subgraph_triples'
  | 'evidence';

interface RequestBase<T extends QueryOperation, A> {
  channelId: string;
  operation: T;
  arguments: A;
  requesterPubkey: string;
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
  | RequestBase<'trust_network', Record<string, never>>
  | RequestBase<'reputation_summary', { pubkey: string }>
  | RequestBase<'subgraph_graph', { name: string }>
  | RequestBase<'subgraph_triples', { name: string }>
  | RequestBase<'evidence', { uri: string }>;

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

export interface TrustPersonSummary {
  pubkey: string;
  contributions: number;
  latest: number | null;
  vouchesReceived: number;
  vouchesGiven: number;
  layer: VisibleMemoryLayer;
}

export interface TrustVouchSummary {
  uri: string;
  issuer: string;
  subject: string;
  note: string | null;
  status: string;
  at: number | null;
  sourceEvent: string | null;
  layer: VisibleMemoryLayer;
}

export interface TrustNetworkResult {
  /** Evidence discovery completed for every visible DKG layer. */
  completeness: 'complete';
  people: TrustPersonSummary[];
  vouches: TrustVouchSummary[];
}

export type ReputationConfidence = 'none' | 'low' | 'medium' | 'high';

export interface ReputationBreakdown {
  directTrust: number;
  networkTrust: number;
  demonstratedWork: number;
  evidenceDiversity: number;
}

export interface ReputationSignals {
  directVouch: boolean;
  twoHopVouchers: number;
  independentVouchers: number;
  evidenceRecords: number;
  verifiableEvidence: boolean;
}

export interface ReputationSummaryResult {
  subject: string;
  perspective: string;
  context: 'channel';
  score: number;
  confidence: ReputationConfidence;
  breakdown: ReputationBreakdown;
  signals: ReputationSignals;
  reasons: string[];
  evidence: TrustVouchSummary[];
  methodology: 'dkg-reputation-v1';
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

export type QueryGatewayResult =
  | ChannelMemoryResult
  | ContributorTrailResult
  | SoftwareContributorsResult
  | DecisionTraceResult
  | TrustNetworkResult
  | ReputationSummaryResult
  | SubgraphGraphResult
  | SubgraphTriplesResult
  | EvidenceResult;

export interface QueryGatewaySuccess {
  ok: true;
  channelId: string;
  /** Context Graph resolved by the server from the configured channel binding. */
  cg: string;
  operation: QueryOperation;
  result: QueryGatewayResult;
}
