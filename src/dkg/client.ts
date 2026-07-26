import type { Quad } from '../types.ts';

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

export class DkgClient {
  #base: string;
  #token: string;

  constructor(opts: { baseUrl: string; token: string }) {
    this.#base = opts.baseUrl.replace(/\/$/, '');
    this.#token = opts.token;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.#base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${this.#token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(
        `dkg ${method} ${path} ${res.status}: ${text.slice(0, 400)}`,
      ) as Error & {
        status?: number;
        body?: unknown;
      };
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json as T;
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
    return this.request('POST', `/api/knowledge-assets/${encodeURIComponent(name)}/vm/publish`, {
      contextGraphId,
    });
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
