import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import oxigraph from 'oxigraph';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

function loadKnowledgeBase(): InstanceType<typeof oxigraph.Store> {
  const store = new oxigraph.Store();
  for (const file of [
    'ontology/profiles/dkg-memory-v1.ttl',
    'ontology/profiles/dkg-software-v1.ttl',
    'ontology/profiles/dkg-trust-v1.ttl',
    'ontology/profiles/buzz-nostr-v1.ttl',
    'ontology/profiles/dkg-memory-v1.shacl.ttl',
    'ontology/profiles/dkg-software-v1.shacl.ttl',
    'ontology/profiles/dkg-trust-v1.shacl.ttl',
    'ontology/profiles/buzz-nostr-v1.shacl.ttl',
  ]) {
    store.load(read(file), { format: 'text/turtle' });
  }
  store.load(read('test/fixtures/ontology/lifelike-project.trig'), {
    format: 'application/trig',
  });
  return store;
}

type QueryRow = Map<string, oxigraph.Term>;

function select(store: InstanceType<typeof oxigraph.Store>, file: string): QueryRow[] {
  const result = store.query(read(`ontology/queries/${file}`));
  if (!Array.isArray(result)) throw new Error(`${file} did not return SELECT rows`);
  return result as QueryRow[];
}

function value(row: QueryRow, variable: string): string | null {
  return row.get(variable)?.value ?? null;
}

describe('DKG ontology profile competency questions', () => {
  it('loads every ontology and SHACL shape in the same RDF engine family used by DKG', () => {
    const store = loadKnowledgeBase();
    const result = store.query(`PREFIX owl: <http://www.w3.org/2002/07/owl#>
      ASK {
        <http://dkg.io/ontology/profile/dkg-memory/1> a owl:Ontology .
        <http://dkg.io/ontology/profile/dkg-software/1> a owl:Ontology .
        <http://dkg.io/ontology/profile/dkg-trust/1> a owl:Ontology .
        <https://w3id.org/buzz-dkg/profile/buzz-nostr/1> a owl:Ontology .
      }`);
    expect(result).toBe(true);
    expect(store.size).toBeGreaterThan(250);
  });

  it('returns a contextual vouch with its signed evidence instead of a score', () => {
    const rows = select(loadKnowledgeBase(), 'web-of-trust.sparql');
    expect(rows).toHaveLength(1);
    expect(value(rows[0]!, 'issuer')).toBe(
      'urn:nostr:pubkey:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(value(rows[0]!, 'subject')).toBe(
      'urn:nostr:pubkey:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    expect(value(rows[0]!, 'note')).toContain('rollback edge case');
    expect(value(rows[0]!, 'source')).toBe(
      'urn:nostr:event:4444444444444444444444444444444444444444444444444444444444444444',
    );
  });

  it('answers who all edited a function with distinct people, commits, and timestamps', () => {
    const rows = select(loadKnowledgeBase(), 'who-edited-function.sparql');
    expect(
      rows.map((row) => ({
        editor: value(row, 'editorName'),
        sha: value(row, 'sha'),
        at: value(row, 'at'),
      })),
    ).toEqual([
      { editor: 'Alice Nguyen', sha: 'a1b2c3d4', at: '2026-07-14T10:15:00Z' },
      { editor: 'Bob Ortiz', sha: 'e5f6a7b8', at: '2026-07-21T16:40:00Z' },
      { editor: 'Diana Okafor', sha: 'f00baa12', at: '2026-07-29T11:05:00Z' },
    ]);
  });

  it('traces the decisions behind a commit that affected a named component', () => {
    const rows = select(loadKnowledgeBase(), 'decisions-behind-commit-component.sparql');
    expect(rows).toHaveLength(1);
    expect(value(rows[0]!, 'decisionName')).toBe('Use short-lived JWT access tokens');
    expect(value(rows[0]!, 'context')).toContain('credential exposure');
    expect(value(rows[0]!, 'outcome')).toContain('15-minute access tokens');
    expect(value(rows[0]!, 'sha')).toBe('a1b2c3d4');
  });

  it('resolves the signed source messages and responsible agent for a decision', () => {
    const rows = select(loadKnowledgeBase(), 'decision-evidence.sparql');
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => value(row, 'agentName')))).toEqual(
      new Set(["Alice's coding agent"]),
    );
    expect(rows.map((row) => value(row, 'content'))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('reduce the blast radius'),
        expect.stringContaining('15-minute access tokens'),
      ]),
    );
  });

  it('finds open follow-up work, ownership, and priority from a decision', () => {
    const rows = select(loadKnowledgeBase(), 'open-tasks-for-decision.sparql');
    expect(rows).toHaveLength(1);
    expect(value(rows[0]!, 'taskName')).toContain('refresh-token rotation');
    expect(value(rows[0]!, 'assigneeName')).toBe('Carol Singh');
    expect(value(rows[0]!, 'priority')).toBe('p1');
  });

  it('finds the concrete passing test that supports a software change', () => {
    const rows = select(loadKnowledgeBase(), 'tests-supporting-change.sparql');
    expect(rows).toHaveLength(1);
    expect(value(rows[0]!, 'runName')).toBe('CI run 8812');
    expect(value(rows[0]!, 'testName')).toBe('rejects refresh-token replay');
    expect(value(rows[0]!, 'result')).toBe('passed');
  });

  it('answers a non-software task question using only the general profile', () => {
    const rows = select(loadKnowledgeBase(), 'general-task.sparql');
    expect(rows).toHaveLength(1);
    expect(value(rows[0]!, 'assigneeName')).toBe('Maya Petrović');
    expect(value(rows[0]!, 'eventName')).toBe('Belgrade community meetup');
    expect(value(rows[0]!, 'where')).toBe('Dorćol, Belgrade');
    expect(value(rows[0]!, 'due')).toBe('2026-08-20T17:00:00+02:00');
  });

  it('joins general memory, software entities, Buzz channel, and evidence profiles', () => {
    const rows = select(loadKnowledgeBase(), 'mixed-profile-trace.sparql');
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => value(row, 'commit')))).toEqual(
      new Set(['urn:dkg:github:commit:acme/api/a1b2c3d4']),
    );
    expect(new Set(rows.map((row) => value(row, 'channel')))).toEqual(
      new Set(['urn:buzz:channel:8e8cd542-e5d0-4f81-a060-e9980b20599d']),
    );
  });

  it('joins the same function across communities without merging a homonym from another repo', () => {
    const rows = select(loadKnowledgeBase(), 'cross-community-identity.sparql');
    expect(rows.map((row) => value(row, 'sha'))).toEqual(['a1b2c3d4', 'e5f6a7b8', 'f00baa12']);
    expect(new Set(rows.map((row) => value(row, 'editorName')))).toEqual(
      new Set(['Alice Nguyen', 'Bob Ortiz', 'Diana Okafor']),
    );
    expect(new Set(rows.map((row) => value(row, 'function')))).toEqual(
      new Set([
        'urn:dkg:code:file:github.com%2Facme%2Fapi/%40acme%2Fauth/src%2Ftoken.ts#function:verifyToken',
      ]),
    );
    expect(rows.some((row) => value(row, 'editorName') === 'Erin Chen')).toBe(false);
  });
});
