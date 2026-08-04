import type { Quad } from '../types.ts';
import { DkgHttpTransport } from './http.mjs';

/**
 * DKG v10 daemon HTTP adapter — Gate A-verified routes only (docs/audit/dkg-audit.md
 * @ bf919a0). Bearer auth; no transport idempotency exists, so callers own
 * dedup + read-back (SPEC §9; registry state machine).
 */
export interface DescriptorResponse {
  contextGraphId: string;
  agentAddress: string;
  name: string;
  state: 'created' | 'promoted' | 'published' | 'finalized' | 'discarded';
  memoryLayer: 'WM' | 'SWM' | 'VM';
  assertionGraph?: string;
  events: { type: string; timestamp: string; [k: string]: unknown }[];
  swmCurrentAssertion?: string;
  reservedUal?: string;
  [k: string]: unknown;
}

export interface QueryResult {
  result: { bindings: Record<string, { value?: string } | string>[]; quads?: unknown[] };
  phases?: Record<string, unknown>;
}

/** Default per-request deadline. Every event is serialized through one queue,
 * so an untimed hung socket stalls all channels for undici's ~300s default. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** vm/publish is synchronous on-chain, so it needs a longer ceiling. */
const PUBLISH_TIMEOUT_MS = 180_000;

export class DkgClient extends DkgHttpTransport {
  constructor(opts: { baseUrl: string; token: string }) {
    super({ ...opts, timeoutMs: DEFAULT_TIMEOUT_MS });
  }

  status(): Promise<{
    version: string;
    chain?: { chainId?: string };
    hasIdentity?: boolean;
    [k: string]: unknown;
  }> {
    return this.request('GET', '/api/status');
  }

  listContextGraphs(): Promise<{ contextGraphs: { id: string; onChainId?: string }[] }> {
    return this.request('GET', '/api/context-graph/list');
  }

  /** Narrow existence probe — the broad list route has a scan budget and can 500 on large nodes. */
  contextGraphExists(id: string): Promise<{ exists: boolean }> {
    return this.request('GET', `/api/context-graph/exists?id=${encodeURIComponent(id)}`);
  }

  createKa(
    name: string,
    contextGraphId: string,
  ): Promise<{ assertionUri: string; alreadyExists: boolean }> {
    return this.request('POST', '/api/knowledge-assets', { name, contextGraphId });
  }

  write(name: string, contextGraphId: string, quads: Quad[]): Promise<{ written: number }> {
    return this.request('POST', `/api/knowledge-assets/${encodeURIComponent(name)}/wm/write`, {
      quads,
      contextGraphId,
    });
  }

  finalize(
    name: string,
    contextGraphId: string,
  ): Promise<{ assertionUri: string; merkleRoot: string; authorAddress: string }> {
    return this.request('POST', `/api/knowledge-assets/${encodeURIComponent(name)}/wm/finalize`, {
      contextGraphId,
    });
  }

  share(
    name: string,
    contextGraphId: string,
  ): Promise<{
    swmShared: boolean;
    promotedCount: number;
    shareOperationId: string;
    publishReady?: boolean;
  }> {
    return this.request('POST', `/api/knowledge-assets/${encodeURIComponent(name)}/swm/share`, {
      contextGraphId,
    });
  }

  publish(
    name: string,
    contextGraphId: string,
  ): Promise<{ status: string; ual: string; txHash: string; kaId?: string; merkleRoot?: string }> {
    return this.request(
      'POST',
      `/api/knowledge-assets/${encodeURIComponent(name)}/vm/publish`,
      { contextGraphId },
      PUBLISH_TIMEOUT_MS,
    );
  }

  descriptor(name: string, contextGraphId: string): Promise<DescriptorResponse> {
    return this.request(
      'GET',
      `/api/knowledge-assets/${encodeURIComponent(name)}?contextGraphId=${encodeURIComponent(contextGraphId)}`,
    );
  }

  /** Server-side scoped query (SPEC §7.3): always carries contextGraphId + view. */
  query(opts: {
    sparql: string;
    contextGraphId: string;
    view: 'working-memory' | 'shared-working-memory' | 'verifiable-memory';
  }): Promise<QueryResult> {
    return this.request('POST', '/api/query', opts);
  }
}

export function bindingValue(b: { value?: string } | string | undefined): string | undefined {
  if (b === undefined) return undefined;
  return typeof b === 'string' ? b : b.value;
}
