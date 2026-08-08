/** Signed Nostr event as stored/served by the Buzz relay (sig-stripped on reads). */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig?: string;
}

/** A quad in the DKG wm/write JSON shape (object = quoted literal or absolute IRI). */
export interface Quad {
  subject: string;
  predicate: string;
  object: string;
  graph?: string;
}

export interface DistillResult {
  rootUri: string;
  activityUri: string;
  digest: string;
  title: string;
  quads: Quad[];
}

export const DKG_MEMORY_PROPOSAL_KIND = 40009;

export type AgentMemoryItemKind = 'decision' | 'claim' | 'question' | 'task' | 'relationship';

export interface AgentMemoryItem {
  kind: AgentMemoryItemKind;
  text: string;
  subject?: string;
  predicate?: string;
  object?: string;
  confidence?: number;
}

/** Semantic memory emitted by a Buzz agent after a normal chat turn. */
export interface AgentMemoryProposal {
  schemaVersion: 1;
  summary: string;
  items: AgentMemoryItem[];
  model?: string;
  promptVersion?: string;
}

/** Relay-authenticated envelope accepted only by the loopback gateway. */
export interface AgentMemoryEnvelope {
  channelId: string;
  requesterPubkey: string;
  proposalEvent: NostrEvent;
  sourceEvents: NostrEvent[];
}

export interface AgentMemoryIngestResult {
  ok: true;
  outcome: 'stored' | 'duplicate';
  proposalEventId: string;
  channelId: string;
  requesterPubkey: string;
  contextGraphId: string;
  kaName: string;
  digest: string;
  state: OpState;
}

/** Operation lifecycle for one trigger → one KA → one receipt. Forward-only. */
export type OpState =
  | 'distilled' // snapshot + quads computed, nothing external yet
  | 'wm_written' // KA created + quads written
  | 'finalized' // sealed
  | 'shared' // full SWM share confirmed
  | 'receipted' // in-thread receipt posted (terminal for SWM flow)
  | 'publishing' // vm/publish intent persisted + budget reserved, BEFORE the call
  | 'published' // VM publish confirmed (devnet only in stage ABC)
  | 'vm_receipted' // VM receipt posted (terminal)
  | 'publish_unconfirmed' // vm/publish outcome not a confirmed response — terminal, counts toward budget (gas may have been spent), never auto-re-published
  | 'failed';

export interface OpRecord {
  id: number;
  triggerEventId: string;
  triggerKind: number;
  channelId: string;
  contextGraphId: string;
  rootEventId: string;
  digest: string;
  kaName: string;
  rootUri: string;
  /** human-readable distilled title, for a leading line on receipts + citations */
  title: string | null;
  assertionUri: string | null;
  state: OpState;
  receiptEventId: string | null;
  ual: string | null;
  txHash: string | null;
  vmReceiptEventId: string | null;
  consumedApprovalId: string | null;
  error: string | null;
}

export interface ChannelBinding {
  channelId: string;
  contextGraphId: string;
  /** npubs (hex) authorized to approve VM publication for this channel (§6.1). */
  promoters: string[];
}

export interface EvidenceRecord {
  rootUri: string;
  name: string;
  description: string;
  digest: string | null;
  /** scoped view the record was retrieved from (citations validate in the same view) */
  view?: 'verifiable-memory' | 'shared-working-memory';
}

export type PublishMode = 'disabled' | 'devnet' | 'mainnet';

export type QueryGatewayConfig =
  | { enabled: false }
  | {
      enabled: true;
      bind: '127.0.0.1' | '::1';
      port: number;
      token: string;
      maxBodyBytes: number;
      maxResultBytes: number;
      maxQueryBytes: number;
      operationTimeoutMs: number;
      dkgTimeoutMs: number;
      maxConcurrent: number;
    };

/** Normalized, non-empty labels Buzz may render for a service mention. */
export type MentionLabels = readonly [string, ...string[]];

export interface DaemonConfig {
  relayHttpUrl: string;
  relayWsUrl: string;
  serviceSecretKeyHex: string;
  /** Non-empty labels Buzz may render when the service is selected as a mention. */
  mentionLabels: MentionLabels;
  dkgApiUrl: string;
  dkgToken: string;
  approvalEmoji: string;
  /**
   * VM publication authority. 'disabled' (default): approvals are recognized,
   * §6 invariants evaluated, but publication is refused. 'devnet': publication
   * only when the node reports the local devnet chain (evm:31337). 'mainnet':
   * publication only when the node reports base:8453, additionally bounded by
   * maxPublishesPerDay — operator-enabled post-D3 (D-gates proved the path;
   * the operator granted standing mainnet authority on 2026-07-27).
   */
  publishMode: PublishMode;
  /** mainnet guardrail: max daemon-initiated publications per rolling 24 h. */
  maxPublishesPerDay: number;
  dbPath: string;
  bindings: ChannelBinding[];
  /** Lazily create one private Context Graph when a new Buzz channel first uses DKG memory. */
  autoProvisionChannels?: boolean;
  /** DKG access policy used for lazily provisioned channel graphs (1 = private/local). */
  contextGraphAccessPolicy?: number;
  /** Optional loopback-only read API for a trusted Buzz authorization front. */
  queryGateway?: QueryGatewayConfig;
}
