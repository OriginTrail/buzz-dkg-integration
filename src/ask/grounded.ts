import { bindingValue, type DkgClient } from '../dkg/client.ts';
import { BUZZ, SCHEMA } from '../distill/deterministic.ts';
import type { EvidenceRecord } from '../types.ts';

/**
 * SPEC §7 grounded-answering contract, enforced in code:
 *  1. channel → CG resolution happens in the daemon (registry); this module
 *     receives an already-resolved contextGraphId and never accepts a query
 *     without one.
 *  2. retrieval is explicitly graph-scoped SPARQL (server-enforced — Gate A);
 *  3. evidence is structured records; 4. empty/insufficient evidence is
 *     rejected BEFORE any generation; 5. the deterministic no-model answerer
 *     is extractive over retrieved evidence only; 6. every material claim
 *     cites a retrieved assertion root URI; 7. citations are resolved against
 *     the same scoped view before posting; 8. there is no fallback to any
 *     other graph or global index (no code path exists for it).
 */

const escapeForRegex = (s: string): string =>
  s
    .replace(/[\\"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Tokenize a question into content words for substring retrieval. */
export function questionTerms(question: string): string[] {
  const stop = new Set(
    'a an and are be but did do does for from had has have how i in is it of on or that the this to was we what when where which who why will with you your'.split(
      ' ',
    ),
  );
  return [
    ...new Set(
      question
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !stop.has(w)),
    ),
  ];
}

export async function retrieveEvidence(
  dkg: DkgClient,
  contextGraphId: string,
  question: string,
  limit = 5,
): Promise<EvidenceRecord[]> {
  const terms = questionTerms(question);
  if (!terms.length) return [];
  const filters = terms
    .map((t) => `CONTAINS(LCASE(STR(?desc)), "${escapeForRegex(t)}")`)
    .join(' || ');
  const sparql = `
    SELECT ?root ?name ?desc ?digest WHERE {
      ?root <${SCHEMA}name> ?name ;
            <${SCHEMA}description> ?desc .
      OPTIONAL { ?root <${BUZZ}sourceSetDigest> ?digest }
      FILTER(${filters})
    } LIMIT ${limit}`;
  const res = await dkg.query({ sparql, contextGraphId, view: 'shared-working-memory' });
  const out: EvidenceRecord[] = [];
  for (const b of res.result?.bindings ?? []) {
    const rootUri = bindingValue(b.root as never);
    const name = bindingValue(b.name as never);
    const description = bindingValue(b.desc as never);
    if (!rootUri || !description) continue;
    out.push({
      rootUri,
      name: name ?? '',
      description,
      digest: bindingValue(b.digest as never) ?? null,
    });
  }
  return out;
}

/** §7.8: every citation must resolve in the SAME scoped view before posting. */
export async function validateCitations(
  dkg: DkgClient,
  contextGraphId: string,
  evidence: EvidenceRecord[],
): Promise<boolean> {
  for (const e of evidence) {
    const res = await dkg.query({
      sparql: `ASK { <${e.rootUri}> ?p ?o }`,
      contextGraphId,
      view: 'shared-working-memory',
    });
    const b = res.result?.bindings ?? [];
    const truthy =
      b.length > 0 &&
      Object.values(b[0] ?? {}).some((v) => String(bindingValue(v as never) ?? v) === 'true');
    if (!truthy) return false;
  }
  return true;
}

export interface GroundedAnswer {
  kind: 'answer' | 'refusal';
  text: string;
  evidence: EvidenceRecord[];
}

/**
 * Deterministic no-model answering: rank evidence by term overlap, answer
 * extractively from the best-supported decision cluster, cite it. A model
 * provider can replace ONLY the text-composition step — evidence gating,
 * citation validation, and refusal remain in code.
 */
export async function answerGrounded(
  dkg: DkgClient,
  contextGraphId: string,
  question: string,
): Promise<GroundedAnswer> {
  const evidence = await retrieveEvidence(dkg, contextGraphId, question);
  if (!evidence.length) return { kind: 'refusal', text: '', evidence: [] };

  const terms = questionTerms(question);
  const score = (e: EvidenceRecord): number =>
    terms.filter((t) => e.description.toLowerCase().includes(t)).length;
  const ranked = [...evidence].sort((a, b) => score(b) - score(a));
  const best = ranked[0]!;
  // Insufficient-support gate (§7.5): at least two independent term hits.
  if (score(best) < 2) return { kind: 'refusal', text: '', evidence: [] };

  const cited = ranked.filter((e) => score(e) >= 2).slice(0, 3);
  if (!(await validateCitations(dkg, contextGraphId, cited))) {
    return { kind: 'refusal', text: '', evidence: [] };
  }
  const text = `${best.description.trim()} [1]`;
  return { kind: 'answer', text, evidence: cited };
}
