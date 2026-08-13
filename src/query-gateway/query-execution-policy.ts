import { AsyncLocalStorage } from 'node:async_hooks';
import { IntegrationApiError } from '../errors.ts';
import { DkgReadLimiter } from './read-limiter.ts';

const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 15_000;

export type QueryCacheStatus = 'hit' | 'miss' | 'coalesced';

type QueryExecutionConfig = {
  operationTimeoutMs: number;
  maxDkgConcurrent: number;
  maxDkgQueue: number;
  cacheTtlMs: number;
  maxCacheEntries: number;
};

type CacheEntry<T> = {
  channelId: string;
  expiresAt: number;
  value: T;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new IntegrationApiError(504, 'gateway_timeout', 'operation timed out'));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Owns query admission, coalescing, caching, invalidation, timeout, and circuit state. */
export class QueryExecutionPolicy<T> {
  readonly #cache = new Map<string, CacheEntry<T>>();
  readonly #channelGeneration = new Map<string, number>();
  readonly #config: QueryExecutionConfig;
  readonly #executionSignal = new AsyncLocalStorage<AbortSignal>();
  readonly #pending = new Map<string, Promise<T>>();
  readonly #readLimiter: DkgReadLimiter;
  #circuitOpenUntil = 0;
  #consecutiveFailures = 0;

  constructor(config: QueryExecutionConfig) {
    this.#config = config;
    this.#readLimiter = new DkgReadLimiter(config.maxDkgConcurrent, config.maxDkgQueue);
  }

  snapshot(): ReturnType<DkgReadLimiter['snapshot']> & {
    cacheEntries: number;
    pendingQueries: number;
    circuitOpen: boolean;
  } {
    return {
      ...this.#readLimiter.snapshot(),
      cacheEntries: this.#cache.size,
      pendingQueries: this.#pending.size,
      circuitOpen: Date.now() < this.#circuitOpenUntil,
    };
  }

  invalidateChannel(channelId: string): void {
    this.#channelGeneration.set(channelId, (this.#channelGeneration.get(channelId) ?? 0) + 1);
    for (const [key, entry] of this.#cache) {
      if (entry.channelId === channelId) this.#cache.delete(key);
    }
  }

  read<R>(read: () => Promise<R>): Promise<R> {
    return this.#readLimiter.run(read, this.#executionSignal.getStore());
  }

  async execute(options: {
    channelId: string;
    keyParts: readonly unknown[];
    observe?: (status: QueryCacheStatus) => void;
    work: () => Promise<T>;
  }): Promise<T> {
    const now = Date.now();
    const generation = this.#channelGeneration.get(options.channelId) ?? 0;
    this.#pruneCache(now);
    const key = JSON.stringify([options.channelId, generation, ...options.keyParts]);
    const cached = this.#cache.get(key);
    if (cached && cached.expiresAt > now) {
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      options.observe?.('hit');
      return cached.value;
    }
    const pending = this.#pending.get(key);
    if (pending) {
      options.observe?.('coalesced');
      return pending;
    }
    if (now < this.#circuitOpenUntil) {
      const retryAfterSeconds = Math.max(1, Math.ceil((this.#circuitOpenUntil - now) / 1_000));
      throw new IntegrationApiError(
        503,
        'dkg_unavailable',
        'DKG reads are cooling down after repeated upstream failures',
        { retryAfterSeconds },
      );
    }

    options.observe?.('miss');
    const controller = new AbortController();
    const dispatch = this.#executionSignal.run(controller.signal, options.work);
    const work = withTimeout(dispatch, this.#config.operationTimeoutMs, () => controller.abort())
      .then((value) => {
        this.#consecutiveFailures = 0;
        this.#circuitOpenUntil = 0;
        if (
          this.#config.cacheTtlMs > 0 &&
          (this.#channelGeneration.get(options.channelId) ?? 0) === generation
        ) {
          this.#cache.set(key, {
            channelId: options.channelId,
            expiresAt: Date.now() + this.#config.cacheTtlMs,
            value,
          });
          this.#pruneCache(Date.now());
        }
        return value;
      })
      .catch((error: unknown) => {
        const upstreamFailure =
          !(error instanceof IntegrationApiError) || error.code === 'gateway_timeout';
        if (upstreamFailure) {
          this.#consecutiveFailures += 1;
          if (this.#consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
            this.#circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
          }
        }
        throw error;
      });
    this.#pending.set(key, work);
    try {
      return await work;
    } finally {
      if (this.#pending.get(key) === work) this.#pending.delete(key);
    }
  }

  #pruneCache(now: number): void {
    for (const [key, entry] of this.#cache) {
      if (entry.expiresAt <= now) this.#cache.delete(key);
    }
    while (this.#cache.size > this.#config.maxCacheEntries) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#cache.delete(oldest);
    }
  }
}
