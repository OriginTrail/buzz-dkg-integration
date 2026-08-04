import { describe, expect, it } from 'vitest';
import { askCommand } from '../scripts/smoke-command.mjs';

describe('smoke mention commands', () => {
  it('uses the configured mention handle and preserves the default', () => {
    expect(askCommand('what changed?', { BDI_MENTION_HANDLE: 'memory' })).toBe(
      '@memory ask what changed?',
    );
    expect(askCommand('what changed?', {})).toBe('@dkg ask what changed?');
  });
});
