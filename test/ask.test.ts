import { describe, expect, it } from 'vitest';
import { answerGrounded, questionTerms, retrieveEvidence } from '../src/ask/grounded.ts';
import { MockDkg } from './helpers.ts';

describe('grounded answering (§7)', () => {
  it('refuses on empty evidence before any generation', async () => {
    const dkg = new MockDkg();
    const res = await answerGrounded(dkg.asDkg(), 'devnet-test', 'what about the moon landing?');
    expect(res.kind).toBe('refusal');
    expect(res.evidence).toEqual([]);
  });

  it('refuses on insufficient support (fewer than two term hits)', async () => {
    const dkg = new MockDkg();
    dkg.evidence = [
      {
        rootUri: 'urn:x:1',
        name: 'other',
        description: 'we discussed backend things',
        digest: null,
      },
    ];
    const res = await answerGrounded(
      dkg.asDkg(),
      'devnet-test',
      'what pricing did marketing choose?',
    );
    expect(res.kind).toBe('refusal');
  });

  it('answers extractively with citations when evidence supports the question', async () => {
    const dkg = new MockDkg();
    dkg.evidence = [
      {
        rootUri: 'urn:buzz-dkg:decision:abc',
        name: 'store decision',
        description: 'DECISION: standardize on oxigraph-server for the staging cluster',
        digest: 'a'.repeat(64),
      },
    ];
    const res = await answerGrounded(
      dkg.asDkg(),
      'devnet-test',
      'what did we decide about the staging cluster store?',
    );
    expect(res.kind).toBe('answer');
    expect(res.text).toContain('oxigraph-server');
    expect(res.text).toContain('[1]');
    expect(res.evidence[0]!.rootUri).toBe('urn:buzz-dkg:decision:abc');
  });

  it('refuses when a citation fails to resolve in the scoped view (§7.8)', async () => {
    const dkg = new MockDkg();
    dkg.evidence = [
      {
        rootUri: 'urn:buzz-dkg:decision:ghost',
        name: 'x',
        description: 'staging cluster store decision text',
        digest: null,
      },
    ];
    // Sabotage citation resolution: ASK sees evidence list, so remove it after retrieval
    const original = dkg.query.bind(dkg);
    let selects = 0;
    dkg.query = (async (opts: any) => {
      if (!/^\s*ASK/i.test(opts.sparql)) {
        selects++;
        return original(opts);
      }
      return { result: { bindings: [] } }; // citation never resolves
    }) as never;
    const res = await answerGrounded(
      dkg.asDkg(),
      'devnet-test',
      'what store for the staging cluster?',
    );
    expect(selects).toBe(1);
    expect(res.kind).toBe('refusal');
  });

  it('every retrieval query is explicitly scoped (contextGraphId + view)', async () => {
    const dkg = new MockDkg();
    dkg.evidence = [
      { rootUri: 'urn:x', name: 'n', description: 'staging cluster store decision', digest: null },
    ];
    await answerGrounded(dkg.asDkg(), 'devnet-test', 'staging cluster store?');
    expect(dkg.queryLog.length).toBeGreaterThan(0);
    for (const q of dkg.queryLog) {
      expect(q.contextGraphId).toBe('devnet-test');
      expect(q.view).toBe('shared-working-memory');
    }
  });

  it('tokenizes questions into content words', () => {
    expect(questionTerms('What did we decide about the store backend?')).toEqual(
      expect.arrayContaining(['decide', 'store', 'backend']),
    );
    expect(questionTerms('the a of')).toEqual([]);
  });

  it('returns structured evidence records', async () => {
    const dkg = new MockDkg();
    dkg.evidence = [{ rootUri: 'urn:x', name: 'n', description: 'd', digest: 'b'.repeat(64) }];
    const ev = await retrieveEvidence(dkg.asDkg(), 'devnet-test', 'anything relevant');
    expect(ev).toEqual([{ rootUri: 'urn:x', name: 'n', description: 'd', digest: 'b'.repeat(64) }]);
  });
});
