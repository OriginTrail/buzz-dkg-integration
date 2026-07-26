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

/** Strip the outer quotes some servers keep on literal binding values. */
const unquote = (v: string | undefined): string | undefined =>
  v === undefined ? undefined : v.replace(/^"(.*)"$/s, '$1');

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

export type EvidenceView = 'verifiable-memory' | 'shared-working-memory';

/**
 * Published KAs migrate from the SWM view to the VM view (observed live: a
 * decision vanished from shared-working-memory after its VM publish), so
 * evidence spans both layers of the SAME context graph — VM first, matching
 * the protocol's trust gradient. Never any other graph.
 */
export async function retrieveEvidence(
  dkg: DkgClient,
  contextGraphId: string,
  question: string,
  limit = 12,
): Promise<EvidenceRecord[]> {
  const terms = questionTerms(question);
  if (!terms.length) return [];
  const has = (t: string): string => `CONTAINS(LCASE(STR(?text)), "${escapeForRegex(t)}")`;
  // Two-pass retrieval: conjunctive term-pairs first (multi-term-supported
  // records), single-term disjunction as fallback — the store returns an
  // arbitrary LIMIT subset, so a lone OR-filter can drown specific records
  // (e.g. "Result: Argentina 2-0 Austria") in single-term matches.
  const passes: string[] = [];
  if (terms.length >= 2) {
    const pairs: string[] = [];
    for (let i = 0; i < terms.length; i++)
      for (let j = i + 1; j < terms.length; j++)
        pairs.push(`(${has(terms[i]!)} && ${has(terms[j]!)})`);
    passes.push(pairs.join(' || '));
  }
  passes.push(terms.map(has).join(' || '));
  // description is OPTIONAL: domain data (e.g. IPTC sport entities) often
  // carries only schema:name — the same name-or-description surface the
  // node's own /api/memory/search indexes. Text = COALESCE(desc, name).
  const sparqlFor = (filters: string): string => `
    SELECT ?root ?name ?desc ?digest WHERE {
      ?root <${SCHEMA}name> ?name .
      OPTIONAL { ?root <${SCHEMA}description> ?desc }
      OPTIONAL { ?root <${BUZZ}sourceSetDigest> ?digest }
      BIND(COALESCE(?desc, ?name) AS ?text)
      FILTER(${filters})
    } LIMIT ${limit}`;
  const out: EvidenceRecord[] = [];
  const seen = new Set<string>();
  for (const filters of passes) {
    for (const view of ['verifiable-memory', 'shared-working-memory'] as const) {
      const res = await dkg.query({ sparql: sparqlFor(filters), contextGraphId, view });
      for (const b of res.result?.bindings ?? []) {
        const rootUri = bindingValue(b.root as never);
        const name = unquote(bindingValue(b.name as never));
        const description = unquote(bindingValue(b.desc as never)) || name;
        if (!rootUri || !description || seen.has(rootUri)) continue;
        seen.add(rootUri);
        out.push({
          rootUri,
          name: name ?? '',
          description,
          digest: unquote(bindingValue(b.digest as never)) ?? null,
          view,
        });
      }
      if (out.length >= limit) break;
    }
    if (out.length) break; // a stricter pass produced evidence; no fallback needed
  }
  return out.slice(0, limit);
}

/** §7.8: every citation must resolve in the SAME scoped view it was retrieved from. */
export async function validateCitations(
  dkg: DkgClient,
  contextGraphId: string,
  evidence: EvidenceRecord[],
): Promise<boolean> {
  for (const e of evidence) {
    const res = await dkg.query({
      sparql: `ASK { <${e.rootUri}> ?p ?o }`,
      contextGraphId,
      view: e.view ?? 'shared-working-memory',
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
  const matched = (e: EvidenceRecord): string[] =>
    terms.filter((t) => e.description.toLowerCase().includes(t));
  const score = (e: EvidenceRecord): number => matched(e).length;
  // Insufficient-support gate (§7.5), deterministic: either two independent
  // term hits, or one highly specific term (≥7 chars — e.g. "telemetry");
  // plain substring matching has no stemmer, so "retention"/"retain" style
  // morphology must not silently starve well-supported answers.
  const sufficient = (e: EvidenceRecord): boolean => {
    const m = matched(e);
    return m.length >= 2 || m.some((t) => t.length >= 7);
  };
  const ranked = [...evidence].sort((a, b) => score(b) - score(a));
  const best = ranked[0]!;
  if (!sufficient(best)) return { kind: 'refusal', text: '', evidence: [] };

  const cited = ranked.filter(sufficient).slice(0, 3);
  if (!(await validateCitations(dkg, contextGraphId, cited))) {
    return { kind: 'refusal', text: '', evidence: [] };
  }
  const text = `${best.description.trim()} [1]`;
  return { kind: 'answer', text, evidence: cited };
}
