import type { EvidenceRecord, OpRecord } from '../types.ts';

/**
 * Receipts are ordinary kind-9 thread replies (the relay rejects unregistered
 * kinds — SPEC §12). Machine-readable lines up front, human-readable status
 * last. The SWM receipt is also the anchor the ✅ approval must target (§6.2).
 */
export function swmReceipt(op: OpRecord): string {
  return [
    'Distilled to Shared Working Memory.',
    `assertion: ${op.assertionUri}`,
    `ka: ${op.kaName}`,
    `context-graph: ${op.contextGraphId}`,
    `source-digest: sha256:${op.digest}`,
    `trigger: ${op.triggerEventId}`,
    'status: SWM (not published to Verifiable Memory)',
  ].join('\n');
}

export function vmReceipt(op: OpRecord, approvalEventId: string, approverPubkey: string): string {
  return [
    'Published to Verifiable Memory.',
    `UAL: ${op.ual}`,
    `ka: ${op.kaName}`,
    `context-graph: ${op.contextGraphId}`,
    `source-digest: sha256:${op.digest}`,
    `approved-by: ${approverPubkey}`,
    `approval-event: ${approvalEventId}`,
  ].join('\n');
}

export function answerMessage(
  question: string,
  answer: string,
  evidence: EvidenceRecord[],
): string {
  const cites = evidence.map((e, i) => `[${i + 1}] ${e.rootUri}`).join('\n');
  return `${answer}\n\nEvidence (context-graph-scoped):\n${cites}`;
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
