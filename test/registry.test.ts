import { describe, expect, it } from 'vitest';
import { Registry } from '../src/registry/store.ts';
import { hexId, makeEvent } from './helpers.ts';

const bindings = [
  { channelId: 'chan-a', contextGraphId: 'cg-a', promoters: [hexId('prom-1')] },
  { channelId: 'chan-b', contextGraphId: 'cg-b', promoters: [] },
];

const opFields = (trigger: string) => ({
  triggerEventId: trigger,
  triggerKind: 40004,
  channelId: 'chan-a',
  contextGraphId: 'cg-a',
  rootEventId: hexId('root'),
  digest: hexId('digest'),
  kaName: 'buzz-dkg-abc',
  rootUri: 'urn:buzz-dkg:decision:abc',
});

describe('registry', () => {
  it('maps channels to context graphs and rejects unmapped channels', () => {
    const r = new Registry(':memory:');
    r.loadBindings(bindings);
    expect(r.contextGraphFor('chan-a')).toBe('cg-a');
    expect(r.contextGraphFor('chan-unknown')).toBeNull();
    expect(r.promotersFor('chan-a')).toEqual([hexId('prom-1')]);
    expect(r.promotersFor('chan-b')).toEqual([]);
  });

  it('persists and monotonically advances the cursor', () => {
    const r = new Registry(':memory:');
    expect(r.cursor).toBe(0);
    r.advanceCursor(100);
    r.advanceCursor(50); // never goes backwards
    expect(r.cursor).toBe(100);
  });

  it('claims a trigger exactly once (idempotency by event id)', () => {
    const r = new Registry(':memory:');
    r.loadBindings(bindings);
    const op = r.claimTrigger(opFields(hexId('t1')));
    expect(op).not.toBeNull();
    expect(r.claimTrigger(opFields(hexId('t1')))).toBeNull();
  });

  it('reserves a channel evidence set across newly signed proposal events', () => {
    const r = new Registry(':memory:');
    const first = r.reserveAgentMemoryEnvelope('proposal-a', 'chan-a', 'evidence-a', {
      proposal: 'a',
    });
    const retry = r.reserveAgentMemoryEnvelope('proposal-b', 'chan-a', 'evidence-a', {
      proposal: 'b',
    });
    const otherChannel = r.reserveAgentMemoryEnvelope('proposal-c', 'chan-b', 'evidence-a', {
      proposal: 'c',
    });
    expect(first).toEqual({ proposalEventId: 'proposal-a', duplicate: false });
    expect(retry).toEqual({ proposalEventId: 'proposal-a', duplicate: true });
    expect(otherChannel).toEqual({ proposalEventId: 'proposal-c', duplicate: false });
  });

  it('atomically hands queued community evidence to a durable proposal and operation', () => {
    const r = new Registry(':memory:');
    const source = makeEvent({ kind: 9, tags: [['h', 'chan-a']], content: 'durable decision' });
    const proposalId = hexId('community-proposal');
    r.queueCommunityMemoryEvent(source, 'chan-a');

    expect(() =>
      r.transaction(() => {
        r.reserveAgentMemoryEnvelope(
          proposalId,
          'chan-a',
          hexId('community-evidence'),
          { proposal: 'community' },
          'community',
        );
        r.claimTrigger({ ...opFields(proposalId), triggerKind: 40009 });
        r.acceptCommunityMemoryEvents([source.id], 'chan-a', proposalId);
        throw new Error('simulated crash before commit');
      }),
    ).toThrow(/simulated crash/);
    expect(r.agentMemoryRecord(proposalId)).toBeNull();
    expect(r.opByTrigger(proposalId)).toBeNull();
    expect(r.communityMemoryState(source.id)).toBe('queued');

    r.transaction(() => {
      r.reserveAgentMemoryEnvelope(
        proposalId,
        'chan-a',
        hexId('community-evidence'),
        { proposal: 'community' },
        'community',
      );
      r.claimTrigger({ ...opFields(proposalId), triggerKind: 40009 });
      r.acceptCommunityMemoryEvents([source.id], 'chan-a', proposalId);
    });
    expect(r.agentMemoryRecord(proposalId)?.origin).toBe('community');
    expect(r.opByTrigger(proposalId)).not.toBeNull();
    expect(r.communityMemoryState(source.id)).toBe('accepted');
    r.markCommunityMemoryStored(proposalId);
    expect(r.communityMemoryState(source.id)).toBe('stored');
  });

  it('enforces forward-only state transitions', () => {
    const r = new Registry(':memory:');
    const op = r.claimTrigger(opFields(hexId('t2')))!;
    r.transition(op.id, 'wm_written');
    r.transition(op.id, 'finalized');
    expect(() => r.transition(op.id, 'wm_written')).toThrow(/illegal transition/);
    expect(() => r.transition(op.id, 'distilled' as never)).toThrow(/illegal transition/);
    r.transition(op.id, 'shared');
    r.transition(op.id, 'receipted', { receipt_event_id: hexId('receipt') });
    expect(r.opByReceipt(hexId('receipt'))?.id).toBe(op.id);
  });

  it('records an approval outcome exactly once', () => {
    const r = new Registry(':memory:');
    const op = r.claimTrigger(opFields(hexId('t3')))!;
    expect(r.recordApproval(hexId('appr'), op.id, 'consumed')).toBe(true);
    expect(r.recordApproval(hexId('appr'), op.id, 'consumed')).toBe(false);
    expect(r.approvalOutcome(hexId('appr'))?.outcome).toBe('consumed');
  });

  it('claims asks exactly once and resolves them', () => {
    const r = new Registry(':memory:');
    expect(r.claimAsk(hexId('ask'), 'chan-a')).toBe(true);
    expect(r.claimAsk(hexId('ask'), 'chan-a')).toBe(false);
    r.resolveAsk(hexId('ask'), 'answered', hexId('answer'));
    expect(r.pendingAsks()).toEqual([]);
  });

  it('lists pending (non-terminal) ops for crash recovery', () => {
    const r = new Registry(':memory:');
    const a = r.claimTrigger(opFields(hexId('t4')))!;
    const b = r.claimTrigger({ ...opFields(hexId('t5')), kaName: 'other' })!;
    r.transition(b.id, 'wm_written');
    r.transition(b.id, 'finalized');
    r.transition(b.id, 'shared');
    r.transition(b.id, 'receipted');
    expect(r.pendingOps().map((o) => o.id)).toEqual([a.id]);
  });
});
