/** Canonical authenticated HTTP transport shared by the daemon and bootstraps. */
export class DkgHttpTransport {
  constructor({ baseUrl, token, timeoutMs = 30_000, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async request(method, path, body, timeoutMs = this.timeoutMs) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          authorization: `Bearer ${this.token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError') {
        throw new Error(`dkg ${method} ${path} timed out after ${timeoutMs}ms`);
      }
      throw error;
    }
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      const error = new Error(`dkg ${method} ${path} ${response.status}: ${text.slice(0, 400)}`);
      error.status = response.status;
      error.body = payload;
      throw error;
    }
    return payload;
  }
}

/** Canonical route-level surface shared by runtime and bootstrap clients. */
export class DkgApiClient extends DkgHttpTransport {
  status() {
    return this.request('GET', '/api/status');
  }

  contextGraphExists(contextGraphId) {
    return this.request(
      'GET',
      `/api/context-graph/exists?id=${encodeURIComponent(contextGraphId)}`,
    );
  }

  createContextGraph(payload) {
    return this.request('POST', '/api/context-graph/create', payload);
  }
}
