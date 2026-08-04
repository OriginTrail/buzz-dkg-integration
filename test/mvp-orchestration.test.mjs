import { describe, expect, it, vi } from 'vitest';
import { startBuzzDependencies } from '../scripts/mvp-orchestration.mjs';

describe('M0 service-mutation ordering', () => {
  it('never starts Compose when DKG preparation fails', async () => {
    const startBuzz = vi.fn();
    const waitForBuzz = vi.fn();
    await expect(
      startBuzzDependencies({
        prepareDkg: () => {
          throw new Error('native build failed');
        },
        startBuzz,
        waitForBuzz,
      }),
    ).rejects.toThrow('native build failed');
    expect(startBuzz).not.toHaveBeenCalled();
    expect(waitForBuzz).not.toHaveBeenCalled();
  });
});
