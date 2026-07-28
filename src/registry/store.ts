import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';

// vite/vitest's builtin list predates node:sqlite; a runtime require keeps the
// import out of the static graph while @types/node still provides the types.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncT;
};
import type { ChannelBinding, OpRecord, OpState } from '../types.ts';

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
        assertion_uri TEXT,
        state TEXT NOT NULL,
        receipt_event_id TEXT,
        ual TEXT,
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
        answer_event_id TEXT,
        outcome TEXT NOT NULL, -- 'answered' | 'refused' | 'pending'
        created_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO cursor (id, last_created_at) VALUES (1, 0);
    `);
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
  }): OpRecord | null {
    const now = Date.now();
    try {
      this.db
        .prepare(
          `INSERT INTO ops (trigger_event_id, trigger_kind, channel_id, context_graph_id, root_event_id,
             digest, ka_name, root_uri, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'distilled', ?, ?)`,
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
  claimAsk(askEventId: string, channelId: string): boolean {
    try {
      this.db
        .prepare(
          "INSERT INTO asks (ask_event_id, channel_id, outcome, created_at) VALUES (?, ?, 'pending', ?)",
        )
        .run(askEventId, channelId, Date.now());
      return true;
    } catch (e: any) {
      if (String(e.message).includes('UNIQUE')) return false;
      throw e;
    }
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
    assertionUri: (r.assertion_uri as string) ?? null,
    state: r.state as OpState,
    receiptEventId: (r.receipt_event_id as string) ?? null,
    ual: (r.ual as string) ?? null,
    vmReceiptEventId: (r.vm_receipt_event_id as string) ?? null,
    consumedApprovalId: (r.consumed_approval_id as string) ?? null,
    error: (r.error as string) ?? null,
  };
}
