import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';

// vite/vitest's builtin list predates node:sqlite; a runtime require keeps the
// import out of the static graph while @types/node still provides the types.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncT;
};
import type { ChannelBinding, NostrEvent, OpRecord, OpState } from '../types.ts';

export type AgentMemoryOrigin = 'agent' | 'community';

/**
 * Durable registry + operation state machine (SQLite).
 *
 * Idempotency model (SPEC §9):
 *  - ops.trigger_event_id UNIQUE   → one trigger event ⇒ at most one operation
 *  - asks.ask_event_id UNIQUE      → one question ⇒ at most one answer
 *  - approvals.approval_event_id UNIQUE, consumed exactly once
 *  - forward-only op states; every external call is bracketed by a persisted
 *    intent so crash recovery can resume with read-back instead of re-execute.
 */
export class Registry {
  readonly db: DatabaseSyncT;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS channels (
        channel_id TEXT PRIMARY KEY,
        context_graph_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS promoters (
        channel_id TEXT NOT NULL,
        pubkey TEXT NOT NULL,
        PRIMARY KEY (channel_id, pubkey)
      );
      CREATE TABLE IF NOT EXISTS cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_created_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS ops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger_event_id TEXT NOT NULL UNIQUE,
        trigger_kind INTEGER NOT NULL,
        channel_id TEXT NOT NULL,
        context_graph_id TEXT NOT NULL,
        root_event_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        ka_name TEXT NOT NULL,
        root_uri TEXT NOT NULL,
        title TEXT,
        assertion_uri TEXT,
        state TEXT NOT NULL,
        receipt_event_id TEXT,
        ual TEXT,
        tx_hash TEXT,
        vm_receipt_event_id TEXT,
        consumed_approval_id TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        approval_event_id TEXT PRIMARY KEY,
        op_id INTEGER NOT NULL REFERENCES ops(id),
        outcome TEXT NOT NULL, -- 'consumed' | 'rejected'
        detail TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS asks (
        ask_event_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        author_pubkey TEXT,
        answer_event_id TEXT,
        outcome TEXT NOT NULL, -- 'answered' | 'refused' | 'pending'
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_memory (
        proposal_event_id TEXT PRIMARY KEY,
        channel_id TEXT,
        evidence_digest TEXT,
        origin TEXT NOT NULL DEFAULT 'agent' CHECK (origin IN ('agent', 'community')),
        envelope_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS community_memory_events (
        event_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'accepted', 'covered', 'stored', 'no_memory')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        proposal_event_id TEXT,
        error TEXT,
        enqueued_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO cursor (id, last_created_at) VALUES (1, 0);
    `);
    // Additive migrations for DBs created before these columns existed. SQLite
    // ADD COLUMN is a cheap metadata-only change; ignore "duplicate column".
    for (const alter of [
      'ALTER TABLE ops ADD COLUMN title TEXT',
      'ALTER TABLE ops ADD COLUMN tx_hash TEXT',
      'ALTER TABLE asks ADD COLUMN author_pubkey TEXT',
      'ALTER TABLE agent_memory ADD COLUMN channel_id TEXT',
      'ALTER TABLE agent_memory ADD COLUMN evidence_digest TEXT',
      "ALTER TABLE agent_memory ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent'",
    ]) {
      try {
        this.db.exec(alter);
      } catch (e: any) {
        if (!String(e.message).includes('duplicate column')) throw e;
      }
    }
    // SQLite cannot extend a CHECK constraint in place. Upgrade databases made
    // by the first community-worker beta without discarding queued evidence.
    const communitySchema = this.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'community_memory_events'",
      )
      .get() as { sql: string } | undefined;
    if (communitySchema && !communitySchema.sql.includes("'accepted'")) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE community_memory_events RENAME TO community_memory_events_legacy;
        CREATE TABLE community_memory_events (
          event_id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          event_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('queued', 'accepted', 'covered', 'stored', 'no_memory')),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL,
          proposal_event_id TEXT,
          error TEXT,
          enqueued_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO community_memory_events
        SELECT * FROM community_memory_events_legacy;
        DROP TABLE community_memory_events_legacy;
        COMMIT;
      `);
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memory_evidence
      ON agent_memory(channel_id, evidence_digest)
      WHERE channel_id IS NOT NULL AND evidence_digest IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_community_memory_ready
      ON community_memory_events(state, next_attempt_at, channel_id, enqueued_at);
    `);
  }

  /** Queue raw signed evidence before any model call; replay is idempotent. */
  queueCommunityMemoryEvent(event: NostrEvent, channelId: string, now = Date.now()): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO community_memory_events
         (event_id, channel_id, event_json, state, attempts, next_attempt_at, enqueued_at, updated_at)
         VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)`,
      )
      .run(event.id, channelId, JSON.stringify(event), now, now, now);
    return result.changes === 1;
  }

  communityMemoryReadyChannels(now: number, debounceMs: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT channel_id
         FROM community_memory_events
         WHERE state = 'queued' AND next_attempt_at <= ?
         GROUP BY channel_id
         HAVING MAX(enqueued_at) <= ?
         ORDER BY MIN(enqueued_at), channel_id`,
      )
      .all(now, now - debounceMs) as { channel_id: string }[];
    return rows.map((row) => row.channel_id);
  }

  communityMemoryBatch(
    channelId: string,
    maxEvents: number,
    maxInputChars: number,
    now = Date.now(),
  ): NostrEvent[] {
    const rows = this.db
      .prepare(
        `SELECT event_json
         FROM community_memory_events
         WHERE channel_id = ? AND state = 'queued' AND next_attempt_at <= ?
         ORDER BY enqueued_at, event_id
         LIMIT ?`,
      )
      .all(channelId, now, maxEvents) as { event_json: string }[];
    const events: NostrEvent[] = [];
    let chars = 0;
    for (const row of rows) {
      const event = JSON.parse(row.event_json) as NostrEvent;
      const added = event.content.length;
      if (events.length > 0 && chars + added > maxInputChars) break;
      if (added > maxInputChars) continue;
      events.push(event);
      chars += added;
    }
    return events;
  }

  /** Agent-authored proposals win over the fallback community worker. */
  coverCommunityMemoryEvents(eventIds: readonly string[], proposalEventId: string): void {
    this.resolveCommunityMemoryEvents(eventIds, 'covered', proposalEventId);
  }

  resolveCommunityMemoryEvents(
    eventIds: readonly string[],
    state: 'covered' | 'stored' | 'no_memory',
    proposalEventId?: string,
  ): void {
    if (eventIds.length === 0) return;
    const placeholders = eventIds.map(() => '?').join(',');
    this.db
      .prepare(
        `UPDATE community_memory_events
         SET state = ?, proposal_event_id = ?, error = NULL, updated_at = ?
         WHERE event_id IN (${placeholders}) AND state = 'queued'`,
      )
      .run(state, proposalEventId ?? null, Date.now(), ...eventIds);
  }

  retryCommunityMemoryEvents(
    eventIds: readonly string[],
    error: string,
    nextAttemptAt: number,
  ): void {
    if (eventIds.length === 0) return;
    const placeholders = eventIds.map(() => '?').join(',');
    this.db
      .prepare(
        `UPDATE community_memory_events
         SET attempts = attempts + 1, next_attempt_at = ?, error = ?, updated_at = ?
         WHERE event_id IN (${placeholders}) AND state = 'queued'`,
      )
      .run(nextAttemptAt, error.slice(0, 1_000), Date.now(), ...eventIds);
  }

  communityMemoryAttempt(eventId: string): number {
    const row = this.db
      .prepare('SELECT attempts FROM community_memory_events WHERE event_id = ?')
      .get(eventId) as { attempts: number } | undefined;
    return row?.attempts ?? 0;
  }

  communityMemoryState(eventId: string): string | null {
    const row = this.db
      .prepare('SELECT state FROM community_memory_events WHERE event_id = ?')
      .get(eventId) as { state: string } | undefined;
    return row?.state ?? null;
  }

  /** Run a synchronous registry mutation as one crash-safe SQLite commit. */
  transaction<T>(mutate: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = mutate();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Move an exact queued evidence batch behind its durable proposal. Call this
   * in the same transaction that reserves the proposal and claims its op. */
  acceptCommunityMemoryEvents(
    eventIds: readonly string[],
    channelId: string,
    proposalEventId: string,
  ): void {
    if (eventIds.length === 0) throw new Error('community memory requires queued evidence');
    const uniqueIds = [...new Set(eventIds)];
    if (uniqueIds.length !== eventIds.length)
      throw new Error('community memory evidence is duplicated');
    const placeholders = uniqueIds.map(() => '?').join(',');
    const eligible = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM community_memory_events
         WHERE event_id IN (${placeholders}) AND channel_id = ? AND state = 'queued'`,
      )
      .get(...uniqueIds, channelId) as { count: number };
    if (eligible.count !== uniqueIds.length) {
      throw new Error('community memory evidence is no longer queued in this channel');
    }
    this.db
      .prepare(
        `UPDATE community_memory_events
         SET state = 'accepted', proposal_event_id = ?, error = NULL, updated_at = ?
         WHERE event_id IN (${placeholders}) AND channel_id = ? AND state = 'queued'`,
      )
      .run(proposalEventId, Date.now(), ...uniqueIds, channelId);
  }

  markCommunityMemoryStored(proposalEventId: string): void {
    this.db
      .prepare(
        `UPDATE community_memory_events SET state = 'stored', error = NULL, updated_at = ?
         WHERE proposal_event_id = ? AND state = 'accepted'`,
      )
      .run(Date.now(), proposalEventId);
  }

  loadBindings(bindings: ChannelBinding[]): void {
    const insCh = this.db.prepare(
      'INSERT INTO channels (channel_id, context_graph_id) VALUES (?, ?) ' +
        'ON CONFLICT(channel_id) DO UPDATE SET context_graph_id = excluded.context_graph_id',
    );
    const delProm = this.db.prepare('DELETE FROM promoters WHERE channel_id = ?');
    const insProm = this.db.prepare(
      'INSERT OR IGNORE INTO promoters (channel_id, pubkey) VALUES (?, ?)',
    );
    this.db.exec('BEGIN');
    try {
      for (const b of bindings) {
        insCh.run(b.channelId, b.contextGraphId);
        delProm.run(b.channelId);
        for (const p of b.promoters) insProm.run(b.channelId, p);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** SPEC §4.3 / §7.2: unmapped or ambiguous channel ⇒ null; callers must reject. */
  contextGraphFor(channelId: string): string | null {
    const row = this.db
      .prepare('SELECT context_graph_id FROM channels WHERE channel_id = ?')
      .get(channelId) as { context_graph_id: string } | undefined;
    return row?.context_graph_id ?? null;
  }

  /** Persist a lazily provisioned mapping; safe under concurrent first use. */
  bindChannel(channelId: string, contextGraphId: string): void {
    const existing = this.contextGraphFor(channelId);
    if (existing && existing !== contextGraphId) {
      throw new Error(`channel '${channelId}' is already bound to '${existing}'`);
    }
    const collision = this.db
      .prepare('SELECT channel_id FROM channels WHERE context_graph_id = ? AND channel_id <> ?')
      .get(contextGraphId, channelId) as { channel_id: string } | undefined;
    if (collision)
      throw new Error(`context graph '${contextGraphId}' is already bound to another channel`);
    this.db
      .prepare('INSERT OR IGNORE INTO channels (channel_id, context_graph_id) VALUES (?, ?)')
      .run(channelId, contextGraphId);
  }

  bindings(): ChannelBinding[] {
    const rows = this.db
      .prepare('SELECT channel_id, context_graph_id FROM channels ORDER BY channel_id')
      .all() as {
      channel_id: string;
      context_graph_id: string;
    }[];
    return rows.map((row) => ({
      channelId: row.channel_id,
      contextGraphId: row.context_graph_id,
      promoters: this.promotersFor(row.channel_id),
    }));
  }

  /**
   * Reserve one canonical channel evidence set for a signed proposal.
   *
   * `proposal_event_id` still protects byte-for-byte event replays. The
   * `(channel_id, evidence_digest)` index additionally makes a newly signed
   * retry idempotent when it references the same exact evidence set.
   */
  reserveAgentMemoryEnvelope(
    proposalEventId: string,
    channelId: string,
    evidenceDigest: string,
    envelope: unknown,
    origin: AgentMemoryOrigin = 'agent',
  ): { proposalEventId: string; duplicate: boolean } {
    const json = JSON.stringify(envelope);
    const existing = this.db
      .prepare(
        'SELECT envelope_json, channel_id, evidence_digest, origin FROM agent_memory WHERE proposal_event_id = ?',
      )
      .get(proposalEventId) as
      | {
          envelope_json: string;
          channel_id: string | null;
          evidence_digest: string | null;
          origin: AgentMemoryOrigin;
        }
      | undefined;
    if (existing && existing.envelope_json !== json) {
      throw new Error(`proposal event '${proposalEventId}' was replayed with different evidence`);
    }
    if (existing) {
      if (
        (existing.channel_id !== null && existing.channel_id !== channelId) ||
        (existing.evidence_digest !== null && existing.evidence_digest !== evidenceDigest) ||
        existing.origin !== origin
      ) {
        throw new Error(`proposal event '${proposalEventId}' was replayed with different evidence`);
      }
      return { proposalEventId, duplicate: true };
    }
    const evidenceOwner = this.db
      .prepare(
        'SELECT proposal_event_id FROM agent_memory WHERE channel_id = ? AND evidence_digest = ?',
      )
      .get(channelId, evidenceDigest) as { proposal_event_id: string } | undefined;
    if (evidenceOwner) {
      return { proposalEventId: evidenceOwner.proposal_event_id, duplicate: true };
    }
    this.db
      .prepare(
        'INSERT OR IGNORE INTO agent_memory ' +
          '(proposal_event_id, channel_id, evidence_digest, origin, envelope_json, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(proposalEventId, channelId, evidenceDigest, origin, json, Date.now());
    const owner = this.db
      .prepare(
        'SELECT proposal_event_id FROM agent_memory WHERE channel_id = ? AND evidence_digest = ?',
      )
      .get(channelId, evidenceDigest) as { proposal_event_id: string } | undefined;
    if (!owner) throw new Error('could not reserve agent memory evidence set');
    return {
      proposalEventId: owner.proposal_event_id,
      duplicate: owner.proposal_event_id !== proposalEventId,
    };
  }

  agentMemoryEnvelope(proposalEventId: string): unknown | null {
    return this.agentMemoryRecord(proposalEventId)?.envelope ?? null;
  }

  agentMemoryRecord(
    proposalEventId: string,
  ): { envelope: unknown; origin: AgentMemoryOrigin } | null {
    const row = this.db
      .prepare('SELECT envelope_json, origin FROM agent_memory WHERE proposal_event_id = ?')
      .get(proposalEventId) as { envelope_json: string; origin: AgentMemoryOrigin } | undefined;
    return row ? { envelope: JSON.parse(row.envelope_json) as unknown, origin: row.origin } : null;
  }

  promotersFor(channelId: string): string[] {
    const rows = this.db
      .prepare('SELECT pubkey FROM promoters WHERE channel_id = ?')
      .all(channelId) as {
      pubkey: string;
    }[];
    return rows.map((r) => r.pubkey);
  }

  get cursor(): number {
    const row = this.db.prepare('SELECT last_created_at FROM cursor WHERE id = 1').get() as {
      last_created_at: number;
    };
    return row.last_created_at;
  }

  advanceCursor(createdAt: number): void {
    this.db
      .prepare('UPDATE cursor SET last_created_at = MAX(last_created_at, ?) WHERE id = 1')
      .run(createdAt);
  }

  /** Returns the new op, or null when the trigger was already claimed (dedup). */
  claimTrigger(fields: {
    triggerEventId: string;
    triggerKind: number;
    channelId: string;
    contextGraphId: string;
    rootEventId: string;
    digest: string;
    kaName: string;
    rootUri: string;
    title?: string;
  }): OpRecord | null {
    const now = Date.now();
    try {
      this.db
        .prepare(
          `INSERT INTO ops (trigger_event_id, trigger_kind, channel_id, context_graph_id, root_event_id,
             digest, ka_name, root_uri, title, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'distilled', ?, ?)`,
        )
        .run(
          fields.triggerEventId,
          fields.triggerKind,
          fields.channelId,
          fields.contextGraphId,
          fields.rootEventId,
          fields.digest,
          fields.kaName,
          fields.rootUri,
          fields.title ?? null,
          now,
          now,
        );
    } catch (e: any) {
      if (String(e.message).includes('UNIQUE')) return null;
      throw e;
    }
    return this.opByTrigger(fields.triggerEventId);
  }

  opByTrigger(triggerEventId: string): OpRecord | null {
    const row = this.db.prepare('SELECT * FROM ops WHERE trigger_event_id = ?').get(triggerEventId);
    return row ? toOp(row as Record<string, unknown>) : null;
  }

  opByReceipt(receiptEventId: string): OpRecord | null {
    const row = this.db.prepare('SELECT * FROM ops WHERE receipt_event_id = ?').get(receiptEventId);
    return row ? toOp(row as Record<string, unknown>) : null;
  }

  opByKaName(kaName: string): OpRecord | null {
    const row = this.db.prepare('SELECT * FROM ops WHERE ka_name = ?').get(kaName);
    return row ? toOp(row as Record<string, unknown>) : null;
  }

  opById(opId: number): OpRecord | null {
    const row = this.db.prepare('SELECT * FROM ops WHERE id = ?').get(opId);
    return row ? toOp(row as Record<string, unknown>) : null;
  }

  /** Forward-only transition; refuses to move backwards or from terminal failure. */
  transition(opId: number, to: OpState, extra: Partial<Record<string, string | null>> = {}): void {
    const orderIdx: OpState[] = [
      'distilled',
      'wm_written',
      'finalized',
      'shared',
      'receipted',
      'publishing',
      'published',
      'vm_receipted',
    ];
    const row = this.db.prepare('SELECT state FROM ops WHERE id = ?').get(opId) as
      { state: OpState } | undefined;
    if (!row) throw new Error(`op ${opId} not found`);
    // 'failed' and 'publish_unconfirmed' are terminal off-track states reachable
    // from any non-terminal state; everything else must move strictly forward.
    if (to !== 'failed' && to !== 'publish_unconfirmed') {
      const from = orderIdx.indexOf(row.state);
      const target = orderIdx.indexOf(to);
      if (from === -1 || target <= from) {
        throw new Error(`illegal transition ${row.state} → ${to} for op ${opId}`);
      }
    }
    const sets = ['state = ?', 'updated_at = ?'];
    const vals: (string | number | null)[] = [to, Date.now()];
    for (const [k, v] of Object.entries(extra)) {
      sets.push(`${k} = ?`);
      vals.push(v ?? null);
    }
    vals.push(opId);
    this.db.prepare(`UPDATE ops SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  /**
   * Publications counting against the rolling mainnet budget. Includes
   * 'publishing' (intent reserved BEFORE the on-chain call) and
   * 'publish_unconfirmed' (an attempt whose confirmation is unknown — gas may
   * already have been spent), so a stranded or ambiguous publish still consumes
   * the ceiling rather than reading as 0 (§ review #11 + the 502 budget-release
   * follow-up).
   */
  countRecentPublishes(windowMs: number): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM ops WHERE state IN ('publishing', 'published', 'vm_receipted', 'publish_unconfirmed') AND updated_at > ?",
      )
      .get(Date.now() - windowMs) as { n: number };
    return row.n;
  }

  pendingOps(): OpRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM ops WHERE state NOT IN ('receipted', 'vm_receipted', 'failed', 'publish_unconfirmed')",
      )
      .all();
    return rows.map((r) => toOp(r as Record<string, unknown>));
  }

  /** Records an approval outcome exactly once; false when already recorded (§6.6). */
  recordApproval(
    approvalEventId: string,
    opId: number,
    outcome: 'consumed' | 'rejected',
    detail?: string,
  ): boolean {
    try {
      this.db
        .prepare(
          'INSERT INTO approvals (approval_event_id, op_id, outcome, detail, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(approvalEventId, opId, outcome, detail ?? null, Date.now());
      return true;
    } catch (e: any) {
      if (String(e.message).includes('UNIQUE')) return false;
      throw e;
    }
  }

  approvalOutcome(approvalEventId: string): { outcome: string; opId: number } | null {
    const row = this.db
      .prepare('SELECT outcome, op_id FROM approvals WHERE approval_event_id = ?')
      .get(approvalEventId) as { outcome: string; op_id: number } | undefined;
    return row ? { outcome: row.outcome, opId: row.op_id } : null;
  }

  /** Claims an ask exactly once; false = duplicate. */
  claimAsk(askEventId: string, channelId: string, authorPubkey?: string): boolean {
    try {
      this.db
        .prepare(
          "INSERT INTO asks (ask_event_id, channel_id, author_pubkey, outcome, created_at) VALUES (?, ?, ?, 'pending', ?)",
        )
        .run(askEventId, channelId, authorPubkey ?? null, Date.now());
      return true;
    } catch (e: any) {
      if (String(e.message).includes('UNIQUE')) return false;
      throw e;
    }
  }

  /** Count asks claimed by one pubkey within the window (per-pubkey ask rate limit). */
  recentAskCountByPubkey(authorPubkey: string, windowMs: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM asks WHERE author_pubkey = ? AND created_at > ?')
      .get(authorPubkey, Date.now() - windowMs) as { n: number };
    return row.n;
  }

  resolveAsk(askEventId: string, outcome: 'answered' | 'refused', answerEventId?: string): void {
    this.db
      .prepare('UPDATE asks SET outcome = ?, answer_event_id = ? WHERE ask_event_id = ?')
      .run(outcome, answerEventId ?? null, askEventId);
  }

  pendingAsks(): { askEventId: string; channelId: string }[] {
    const rows = this.db
      .prepare("SELECT ask_event_id, channel_id FROM asks WHERE outcome = 'pending'")
      .all() as {
      ask_event_id: string;
      channel_id: string;
    }[];
    return rows.map((r) => ({ askEventId: r.ask_event_id, channelId: r.channel_id }));
  }

  close(): void {
    this.db.close();
  }
}

function toOp(r: Record<string, unknown>): OpRecord {
  return {
    id: r.id as number,
    triggerEventId: r.trigger_event_id as string,
    triggerKind: r.trigger_kind as number,
    channelId: r.channel_id as string,
    contextGraphId: r.context_graph_id as string,
    rootEventId: r.root_event_id as string,
    digest: r.digest as string,
    kaName: r.ka_name as string,
    rootUri: r.root_uri as string,
    title: (r.title as string) ?? null,
    assertionUri: (r.assertion_uri as string) ?? null,
    state: r.state as OpState,
    receiptEventId: (r.receipt_event_id as string) ?? null,
    ual: (r.ual as string) ?? null,
    txHash: (r.tx_hash as string) ?? null,
    vmReceiptEventId: (r.vm_receipt_event_id as string) ?? null,
    consumedApprovalId: (r.consumed_approval_id as string) ?? null,
    error: (r.error as string) ?? null,
  };
}
