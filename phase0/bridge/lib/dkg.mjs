// Minimal DKG v10 daemon HTTP client for the Phase 0 spike (isolated devnet only).
// Routes verified in docs/audit/dkg-audit.md @ bf919a0.
export class DkgClient {
  constructor({ baseUrl, token }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  async #req(method, path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`dkg ${method} ${path} ${res.status}: ${text.slice(0, 400)}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  status() { return this.#req('GET', '/api/status'); }
  listContextGraphs() { return this.#req('GET', '/api/context-graph/list'); }

  createKa(name, contextGraphId) {
    return this.#req('POST', '/api/knowledge-assets', { name, contextGraphId });
  }
  write(name, contextGraphId, quads) {
    return this.#req('POST', `/api/knowledge-assets/${encodeURIComponent(name)}/wm/write`, { quads, contextGraphId });
  }
  finalize(name, contextGraphId) {
    return this.#req('POST', `/api/knowledge-assets/${encodeURIComponent(name)}/wm/finalize`, { contextGraphId });
  }
  share(name, contextGraphId, opts = {}) {
    return this.#req('POST', `/api/knowledge-assets/${encodeURIComponent(name)}/swm/share`, { contextGraphId, ...opts });
  }
  publish(name, contextGraphId, opts = {}) {
    return this.#req('POST', `/api/knowledge-assets/${encodeURIComponent(name)}/vm/publish`, { contextGraphId, ...opts });
  }
  descriptor(name) {
    return this.#req('GET', `/api/knowledge-assets/${encodeURIComponent(name)}`);
  }
  wmQuads(name, contextGraphId) {
    return this.#req('GET', `/api/knowledge-assets/${encodeURIComponent(name)}/wm/quads?contextGraphId=${encodeURIComponent(contextGraphId)}`);
  }
  query({ sparql, contextGraphId, view, ...rest }) {
    return this.#req('POST', '/api/query', { sparql, contextGraphId, view, ...rest });
  }
}
