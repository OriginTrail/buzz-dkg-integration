export interface DkgHttpTransportOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class DkgHttpTransport {
  constructor(options: DkgHttpTransportOptions);
  request<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T>;
}

export class DkgApiClient extends DkgHttpTransport {
  status(): Promise<Record<string, unknown>>;
  contextGraphExists(contextGraphId: string): Promise<{ exists: boolean }>;
  createContextGraph(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}
