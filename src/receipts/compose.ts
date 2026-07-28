import type { EvidenceRecord, OpRecord } from '../types.ts';

/**
 * Receipts are ordinary kind-9 thread replies (the relay rejects unregistered
 * kinds — SPEC §12). Machine-readable lines up front, human-readable status
 * last. The SWM receipt is also the anchor the ✅ approval must target (§6.2).
 */
export function swmReceipt(op: OpRecord): string {
  // A leading human line so the receipt says WHAT was captured, not just seven
  // lines of hashes. The machine-readable lines below stay `^…$`-anchored, so
  // the approval parsers are unaffected.
  const lead = op.title ? `Captured “${op.title.replace(/\s+/g, ' ').trim()}”. ` : '';
  return [
    `${lead}Distilled to Shared Working Memory.`,
    `assertion: ${op.assertionUri}`,
    `ka: ${op.kaName}`,
    `context-graph: ${op.contextGraphId}`,
    `source-digest: sha256:${op.digest}`,
    `trigger: ${op.triggerEventId}`,
    'status: SWM (not published to Verifiable Memory)',
  ].join('\n');
}

export function vmReceipt(op: OpRecord, approvalEventId: string, approverPubkey: string): string {
  const lead = op.title ? `Published “${op.title.replace(/\s+/g, ' ').trim()}”. ` : '';
  return [
    `${lead}Published to Verifiable Memory.`,
    `UAL: ${op.ual}`,
    ...(op.txHash ? [`tx: ${op.txHash}`] : []),
    `ka: ${op.kaName}`,
    `context-graph: ${op.contextGraphId}`,
    `source-digest: sha256:${op.digest}`,
    `approved-by: ${approverPubkey}`,
    `approval-event: ${approvalEventId}`,
  ].join('\n');
}

const viewTag = (v: EvidenceRecord['view']): string =>
  v === 'verifiable-memory' ? 'VM' : v === 'shared-working-memory' ? 'SWM' : '';

/**
 * The answer quotes exactly one record as `[1]`, so only that record is a
 * numbered citation; any other matched records are listed as context WITHOUT a
 * bracket the answer never uses. Each line carries the source-set digest + view,
 * which cross-references the in-channel SWM/VM receipt (same `source-digest`),
 * so a human can resolve a citation back to a real, verifiable record.
 */
export function answerMessage(
  question: string,
  answer: string,
  evidence: EvidenceRecord[],
): string {
  const ref = (e: EvidenceRecord): string => {
    const bits = [e.rootUri];
    if (e.digest) bits.push(`source-digest sha256:${e.digest}`);
    const tag = viewTag(e.view);
    if (tag) bits.push(tag);
    return bits.join(' · ');
  };
  const [primary, ...also] = evidence;
  const lines = [answer, '', 'Cited (context-graph-scoped):'];
  if (primary) lines.push(`[1] ${ref(primary)}`);
  if (also.length) {
    lines.push('', 'Also matched:');
    for (const e of also) lines.push(`- ${ref(e)}`);
  }
  return lines.join('\n');
}

/** SPEC §7.5/§7 refusal — explicit, and honest about scope. */
export function refusalMessage(question: string, contextGraphId: string): string {
  return (
    `I can't answer that from this room's knowledge. ` +
    `No supporting evidence was found in context graph '${contextGraphId}', ` +
    `and I only answer from this room's designated context graph.`
  );
}

export function parseReceiptDigest(content: string): string | null {
  const m = content.match(/^source-digest: sha256:([0-9a-f]{64})$/m);
  return m?.[1] ?? null;
}

export function parseReceiptKaName(content: string): string | null {
  const m = content.match(/^ka: (\S+)$/m);
  return m?.[1] ?? null;
}
