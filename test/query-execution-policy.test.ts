import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntegrationApiError } from '../src/errors.ts';
import { QueryExecutionPolicy } from '../src/query-gateway/query-execution-policy.ts';

const config = (
  overrides: Partial<ConstructorParameters<typeof QueryExecutionPolicy>[0]> = {},
) => ({
  operationTimeoutMs: 1_000,
  maxDkgConcurrent: 2,
  maxDkgQueue: 8,
  cacheTtlMs: 100,
  maxCacheEntries: 2,
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('query execution policy', () => {
  it('expires cached results and evicts the least-recently-used entry at the configured bound', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T00:00:00Z'));
    const policy = new QueryExecutionPolicy<number>(config());
    let executions = 0;
    const execute = (key: string) =>
      policy.execute({
        channelId: 'channel-one',
        keyParts: [key],
        work: async () => ++executions,
      });

    expect(await execute('a')).toBe(1);
    expect(await execute('b')).toBe(2);
    expect(await execute('a')).toBe(1);
    expect(await execute('c')).toBe(3);
    expect(policy.snapshot().cacheEntries).toBe(2);
    expect(await execute('b')).toBe(4);

    vi.advanceTimersByTime(101);
    expect(await execute('b')).toBe(5);
    expect(policy.snapshot().cacheEntries).toBeLessThanOrEqual(2);
  });

  it('closes the circuit after cooldown and clears failure state after a successful probe', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T00:00:00Z'));
    const policy = new QueryExecutionPolicy<string>(config({ cacheTtlMs: 0 }));
    for (let index = 0; index < 3; index += 1) {
      await expect(
        policy.execute({
          channelId: 'channel-one',
          keyParts: [index],
          work: async () => {
            throw new Error('store unavailable');
          },
        }),
      ).rejects.toThrow('store unavailable');
    }
    expect(policy.snapshot().circuitOpen).toBe(true);
    await expect(
      policy.execute({
        channelId: 'channel-one',
        keyParts: ['blocked'],
        work: async () => 'not reached',
      }),
    ).rejects.toMatchObject({ code: 'dkg_unavailable' } satisfies Partial<IntegrationApiError>);

    vi.advanceTimersByTime(15_001);
    await expect(
      policy.execute({
        channelId: 'channel-one',
        keyParts: ['probe'],
        work: async () => 'recovered',
      }),
    ).resolves.toBe('recovered');
    expect(policy.snapshot().circuitOpen).toBe(false);
  });
});
