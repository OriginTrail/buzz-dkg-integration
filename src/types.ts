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

/** Operation lifecycle for one trigger → one KA → one receipt. Forward-only. */
export type OpState =
  | 'distilled' // snapshot + quads computed, nothing external yet
  | 'wm_written' // KA created + quads written
  | 'finalized' // sealed
  | 'shared' // full SWM share confirmed
  | 'receipted' // in-thread receipt posted (terminal for SWM flow)
  | 'published' // VM publish confirmed (devnet only in stage ABC)
  | 'vm_receipted' // VM receipt posted (terminal)
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
  assertionUri: string | null;
  state: OpState;
  receiptEventId: string | null;
  ual: string | null;
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
}

export type PublishMode = 'disabled' | 'devnet';

export interface DaemonConfig {
  relayHttpUrl: string;
  relayWsUrl: string;
  serviceSecretKeyHex: string;
  mentionHandle: string; // e.g. "dkg" — matched as @<handle> in kind-9 content
  dkgApiUrl: string;
  dkgToken: string;
  approvalEmoji: string;
  /**
   * VM publication authority. 'disabled' (default): approvals are recognized,
   * §6 invariants evaluated, but publication is refused — production posture
   * for stage ABC. 'devnet': publication allowed ONLY when the connected node
   * reports the local devnet chain (evm:31337). A 'mainnet' mode is
   * deliberately NOT implemented — that authority arrives with SPEC §0 D3.
   */
  publishMode: PublishMode;
  dbPath: string;
  bindings: ChannelBinding[];
}
