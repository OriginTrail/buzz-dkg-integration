import { describe, expect, it } from 'vitest';
import {
  BUZZ,
  PROV,
  RDF,
  deterministicDistiller,
  kaNameForDigest,
  snapshotSourceSet,
  sourceSetDigest,
} from '../src/distill/deterministic.ts';
import { hexId, makeEvent, thread } from './helpers.ts';

const servicePubkey = hexId('service');

describe('deterministic distillation', () => {
  it('is byte-identical for identical inputs (digest + quads)', () => {
    const events = thread('chan', ['Q: pick a db?', 'sqlite', 'DECISION: sqlite it is']);
    const a = deterministicDistiller.distill({ channelId: 'chan', events, servicePubkey });
    const b = deterministicDistiller.distill({
      channelId: 'chan',
      events: [...events].reverse(),
      servicePubkey,
    });
    expect(a.digest).toBe(b.digest);
    expect(JSON.stringify(a.quads)).toBe(JSON.stringify(b.quads));
    expect(kaNameForDigest(a.digest)).toMatch(/^buzz-dkg-[0-9a-f]{12}$/);
  });

  it('changes digest when any source event changes', () => {
    const events = thread('chan', ['a', 'b']);
    const d1 = sourceSetDigest(events);
    const mutated = [{ ...events[0]!, content: 'a (edited)' }, events[1]!];
    expect(sourceSetDigest(mutated)).not.toBe(d1);
  });

  it('snapshot excludes service-authored events and events after the trigger', () => {
    const t = thread('chan', ['root', 'reply']);
    const receipt = makeEvent({
      kind: 9,
      pubkey: servicePubkey,
      content: 'receipt',
      tags: [['h', 'chan']],
    });
    const trigger = makeEvent({
      kind: 40004,
      tags: [
        ['h', 'chan'],
        ['e', t[0]!.id],
      ],
    });
    const late = makeEvent({ kind: 9, content: 'after the pin', tags: [['h', 'chan']] });
    const snap = snapshotSourceSet([...t, receipt, late], trigger, servicePubkey);
    expect(snap.map((e) => e.id)).toEqual(t.map((e) => e.id));
  });

  it('produces exactly one root subject of type DecisionCluster with a full PROV chain', () => {
    const events = thread('chan', ['topic', 'input', 'DECISION: done']);
    const { quads, rootUri, activityUri } = deterministicDistiller.distill({
      channelId: 'chan',
      events,
      servicePubkey,
    });
    const roots = quads.filter(
      (q) => q.predicate === `${RDF}type` && q.object === `${BUZZ}DecisionCluster`,
    );
    expect(roots).toHaveLength(1);
    expect(roots[0]!.subject).toBe(rootUri);
    // PROV chain (SPEC §5)
    expect(
      quads.filter((q) => q.subject === rootUri && q.predicate === `${PROV}wasDerivedFrom`),
    ).toHaveLength(3);
    expect(quads).toContainEqual({
      subject: rootUri,
      predicate: `${PROV}wasGeneratedBy`,
      object: activityUri,
    });
    expect(
      quads.filter((q) => q.subject === activityUri && q.predicate === `${PROV}used`),
    ).toHaveLength(3);
    expect(quads.filter((q) => q.predicate === `${PROV}wasAttributedTo`)).toHaveLength(3);
    expect(
      quads.some((q) => q.subject === activityUri && q.predicate === `${PROV}wasAssociatedWith`),
    ).toBe(true);
  });

  it('emits only valid object terms (quoted literal or absolute IRI) and stable URIs', () => {
    const events = thread('chan', ['x "quoted" text\nnewline', 'y']);
    const { quads, digest, rootUri } = deterministicDistiller.distill({
      channelId: 'chan',
      events,
      servicePubkey,
    });
    for (const q of quads) {
      expect(q.subject).toMatch(/^(urn:|https?:)/);
      expect(q.predicate).toMatch(/^https?:/);
      const objectOk = q.object.startsWith('"') || /^(urn:|https?:)/.test(q.object);
      expect(objectOk, `bad object term: ${q.object}`).toBe(true);
    }
    expect(rootUri).toBe(`urn:buzz-dkg:decision:${digest}`);
  });

  it('prefers an explicit DECISION: line as the cluster title', () => {
    const events = thread('chan', ['should we?', 'maybe', 'DECISION: yes, ship it']);
    const { title } = deterministicDistiller.distill({ channelId: 'chan', events, servicePubkey });
    expect(title).toContain('DECISION: yes, ship it');
  });
});
