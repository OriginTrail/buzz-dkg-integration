import { describe, expect, it } from 'vitest';
import { agentMemoryCapability, agentMemorySchema, askCommand } from '../scripts/smoke-command.mjs';

describe('smoke mention commands', () => {
  it('uses the configured mention handle and preserves the default', () => {
    expect(askCommand('what changed?', { BDI_MENTION_HANDLE: 'memory' })).toBe(
      '@memory ask what changed?',
    );
    expect(askCommand('what changed?', {})).toBe('@dkg ask what changed?');
  });
});

describe('targeted agent-memory smoke capability', () => {
  it('fails closed when the targeted relay does not advertise memory support', () => {
    expect(() => agentMemoryCapability({ supported_extensions: [] }, true)).toThrow(
      /requires.*buzz-dkg-memory-v1/,
    );
    expect(agentMemoryCapability({ supported_extensions: ['buzz-dkg-memory-v1'] }, true)).toBe(
      true,
    );
    expect(agentMemoryCapability({ supported_extensions: [] }, false)).toBe(false);
    expect(
      agentMemorySchema({
        supported_extensions: ['buzz-dkg-memory-v1', 'buzz-dkg-memory-v2'],
        dkg_memory: {
          schema_versions: [1, 2],
          profiles: ['dkg-memory@1', 'dkg-software@1'],
        },
      }),
    ).toBe(2);
    expect(
      agentMemorySchema({ supported_extensions: ['buzz-dkg-memory-v1', 'buzz-dkg-memory-v2'] }),
    ).toBe(1);
  });
});
