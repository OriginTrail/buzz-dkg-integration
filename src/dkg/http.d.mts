import type { Quad } from '../types.ts';

export interface DkgHttpTransportOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

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

export interface SubGraphListResponse {
  contextGraphId: string;
  subGraphs?: Array<SubGraphListItem>;
  /** Compatibility with the alternate field observed on older v10 nodes. */
  sub_graphs?: Array<SubGraphListItem>;
}

export interface SubGraphListItem {
  name: string;
  uri?: string;
  description?: string;
  createdBy?: string;
  createdAt?: string;
  entityCount: number;
  tripleCount: number;
}

export class DkgHttpTransport {
  constructor(options: DkgHttpTransportOptions);
  request<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T>;
}

export class DkgClient extends DkgHttpTransport {
  status(): Promise<{
    version: string;
    nodeRole?: 'edge' | 'core';
    chain?: { chainId?: string };
    hasIdentity?: boolean;
    [k: string]: unknown;
  }>;
  contextGraphExists(contextGraphId: string): Promise<{ exists: boolean }>;
  createContextGraph(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  listContextGraphs(): Promise<{ contextGraphs: { id: string; onChainId?: string }[] }>;
  createKa(
    name: string,
    contextGraphId: string,
  ): Promise<{ assertionUri: string; alreadyExists: boolean }>;
  write(name: string, contextGraphId: string, quads: Quad[]): Promise<{ written: number }>;
  finalize(
    name: string,
    contextGraphId: string,
  ): Promise<{ assertionUri: string; merkleRoot: string; authorAddress: string }>;
  share(
    name: string,
    contextGraphId: string,
  ): Promise<{
    swmShared: boolean;
    promotedCount: number;
    shareOperationId: string;
    publishReady?: boolean;
  }>;
  publish(
    name: string,
    contextGraphId: string,
  ): Promise<{ status: string; ual: string; txHash: string; kaId?: string; merkleRoot?: string }>;
  descriptor(name: string, contextGraphId: string): Promise<DescriptorResponse>;
  query(
    options: {
      sparql: string;
      contextGraphId: string;
      subGraphName?: string;
      view: 'working-memory' | 'shared-working-memory' | 'verifiable-memory';
    },
    timeoutMs?: number,
  ): Promise<QueryResult>;
  listSubGraphs(contextGraphId: string, timeoutMs?: number): Promise<SubGraphListResponse>;
}
