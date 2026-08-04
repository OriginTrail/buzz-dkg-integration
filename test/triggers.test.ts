import { describe, expect, it } from 'vitest';
import { classify } from '../src/triggers/detect.ts';
import { hexId, makeEvent } from './helpers.ts';

const servicePubkey = hexId('svc');
const opts = { servicePubkey, mentionLabels: ['DKG Memory', 'dkg'] };
const target = hexId('target');

describe('trigger classification', () => {
  it('classifies pins (kind 40004) with channel + target correlation', () => {
    const t = classify(
      makeEvent({
        kind: 40004,
        tags: [
          ['h', 'chan'],
          ['e', target],
        ],
      }),
      opts,
    );
    expect(t).toMatchObject({ type: 'pin', channelId: 'chan', targetEventId: target });
  });

  it('rejects pins without channel or valid target', () => {
    expect(classify(makeEvent({ kind: 40004, tags: [['e', target]] }), opts)).toBeNull();
    expect(
      classify(
        makeEvent({
          kind: 40004,
          tags: [
            ['h', 'chan'],
            ['e', 'not-hex'],
          ],
        }),
        opts,
      ),
    ).toBeNull();
  });

  it('classifies reactions with relay-style last-valid-e-tag targeting', () => {
    const other = hexId('other');
    const t = classify(
      makeEvent({
        kind: 7,
        content: '✅',
        tags: [
          ['e', other],
          ['e', 'garbage'],
          ['e', target],
        ],
      }),
      opts,
    );
    expect(t).toMatchObject({ type: 'approval', targetEventId: target, emoji: '✅' });
  });

  it('classifies @dkg distill mentions and resolves the thread root (NIP-10)', () => {
    const root = hexId('root');
    const parent = hexId('parent');
    const t = classify(
      makeEvent({
        kind: 9,
        content: '@dkg distill this please',
        tags: [
          ['h', 'chan'],
          ['p', servicePubkey],
          ['e', root, '', 'root'],
          ['e', parent, '', 'reply'],
        ],
      }),
      opts,
    );
    expect(t).toMatchObject({ type: 'distill', channelId: 'chan', targetEventId: root });
  });

  it('classifies @dkg ask with the question text', () => {
    const t = classify(
      makeEvent({
        kind: 9,
        content: '@dkg ask what did we decide about the store backend?',
        tags: [
          ['h', 'chan'],
          ['p', servicePubkey],
        ],
      }),
      opts,
    );
    expect(t).toMatchObject({
      type: 'ask',
      question: 'what did we decide about the store backend?',
    });
  });

  it('classifies the multi-word display name emitted by Buzz mention autocomplete', () => {
    const t = classify(
      makeEvent({
        kind: 9,
        content: '@DKG Memory distill this please',
        tags: [
          ['h', 'chan'],
          ['p', servicePubkey],
          ['e', target, '', 'reply'],
        ],
      }),
      opts,
    );
    expect(t).toMatchObject({ type: 'distill', channelId: 'chan', targetEventId: target });
  });

  it('tolerates presentation whitespace inside a multi-word display name', () => {
    const t = classify(
      makeEvent({
        kind: 9,
        content: '@DKG  Memory distill this please',
        tags: [
          ['h', 'chan'],
          ['p', servicePubkey],
          ['e', target, '', 'reply'],
        ],
      }),
      opts,
    );
    expect(t).toMatchObject({ type: 'distill', channelId: 'chan', targetEventId: target });
  });

  it('does not treat arbitrary labels as the service even when another p tag mentions it', () => {
    expect(
      classify(
        makeEvent({
          kind: 9,
          content: '@someone distill this',
          tags: [
            ['h', 'chan'],
            ['p', servicePubkey],
            ['e', target, '', 'reply'],
          ],
        }),
        opts,
      ),
    ).toBeNull();
  });

  it('ignores the configured display name when the p tag is not the service', () => {
    expect(
      classify(
        makeEvent({
          kind: 9,
          content: '@DKG Memory distill this',
          tags: [
            ['h', 'chan'],
            ['p', hexId('other')],
            ['e', target, '', 'reply'],
          ],
        }),
        opts,
      ),
    ).toBeNull();
  });

  it('rejects an empty mention-label set instead of matching a bare at-sign', () => {
    expect(
      classify(
        makeEvent({
          kind: 9,
          content: '@ distill this',
          tags: [
            ['h', 'chan'],
            ['p', servicePubkey],
            ['e', target, '', 'reply'],
          ],
        }),
        { servicePubkey, mentionLabels: [] },
      ),
    ).toBeNull();
  });

  it('ignores mentions without a p tag for the service (client-side handle collisions)', () => {
    expect(
      classify(makeEvent({ kind: 9, content: '@dkg ask something', tags: [['h', 'chan']] }), opts),
    ).toBeNull();
  });

  it('ignores the service’s own events (no self-triggering)', () => {
    expect(
      classify(
        makeEvent({
          kind: 9,
          pubkey: servicePubkey,
          content: '@dkg ask x',
          tags: [
            ['h', 'c'],
            ['p', servicePubkey],
          ],
        }),
        opts,
      ),
    ).toBeNull();
    expect(
      classify(
        makeEvent({
          kind: 40004,
          pubkey: servicePubkey,
          tags: [
            ['h', 'c'],
            ['e', target],
          ],
        }),
        opts,
      ),
    ).toBeNull();
  });

  it('ignores unrelated kinds and non-command mentions', () => {
    expect(classify(makeEvent({ kind: 1, content: 'hi' }), opts)).toBeNull();
    expect(
      classify(
        makeEvent({
          kind: 9,
          content: 'thanks @dkg!',
          tags: [
            ['h', 'c'],
            ['p', servicePubkey],
          ],
        }),
        opts,
      ),
    ).toBeNull();
  });
});
