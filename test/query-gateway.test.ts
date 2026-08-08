import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadQueryGatewayConfig } from '../src/config.ts';
import type { DkgClient } from '../src/dkg/client.ts';
import { QueryGateway } from '../src/query-gateway/server.ts';
import { parseQueryGatewayRequest, QueryGatewayService } from '../src/query-gateway/service.ts';
import type { QueryGatewayConfig } from '../src/types.ts';

const TOKEN = 'gateway-token-'.padEnd(32, 'x');
const REQUESTER = 'ab'.repeat(32);
const CONTRIBUTOR = 'cd'.repeat(32);
const CHANNEL = 'channel-one';
const CONTEXT_GRAPH = 'did:dkg:otp/0xabc/42';
const REPO = fileURLToPath(new URL('..', import.meta.url));

type EnabledConfig = Extract<QueryGatewayConfig, { enabled: true }>;

function gatewayConfig(overrides: Partial<EnabledConfig> = {}): EnabledConfig {
  return {
    enabled: true,
    bind: '127.0.0.1',
    port: 0,
    token: TOKEN,
    maxBodyBytes: 16 * 1024,
    maxResultBytes: 1024 * 1024,
    maxQueryBytes: 8 * 1024,
    operationTimeoutMs: 1_000,
    dkgTimeoutMs: 500,
    maxConcurrent: 4,
    ...overrides,
  };
}

class GatewayDkg {
  readonly calls: Array<{
    kind: 'query' | 'subgraphs';
    contextGraphId: string;
    view?: string;
    sparql?: string;
    subGraphName?: string;
    timeoutMs?: number;
  }> = [];
  failWith: string | null = null;
  hang = false;
  tripleBindings: Array<Record<string, { value: string }>> = [];
  bindingResolver:
    | ((options: {
        contextGraphId: string;
        view: string;
        sparql: string;
        subGraphName?: string;
      }) => Array<Record<string, { value: string }>> | null)
    | null = null;

  async query(
    options: { contextGraphId: string; view: string; sparql: string; subGraphName?: string },
    timeoutMs?: number,
  ) {
    this.calls.push({ kind: 'query', ...options, timeoutMs });
    if (this.failWith) throw new Error(this.failWith);
    if (this.hang) return new Promise<never>(() => undefined);
    const resolved = this.bindingResolver?.(options);
    if (resolved !== null && resolved !== undefined) {
      return { result: { bindings: resolved } };
    }
    if (options.sparql.includes('SAMPLE(?n)')) {
      return {
        result: {
          bindings: [
            {
              g: { value: `https://example.test/${options.view}/graph` },
              name: { value: `${options.view} graph` },
            },
          ],
        },
      };
    }
    if (options.sparql.includes('SELECT ?s ?p ?o ?g')) {
      return { result: { bindings: this.tripleBindings } };
    }
    return { result: { bindings: [] } };
  }

  async listSubGraphs(contextGraphId: string, timeoutMs?: number) {
    this.calls.push({ kind: 'subgraphs', contextGraphId, timeoutMs });
    if (this.failWith) throw new Error(this.failWith);
    return {
      contextGraphId,
      subGraphs: [
        {
          name: 'core',
          uri: 'https://example.test/subgraph/core',
          entityCount: 2,
          tripleCount: 3,
        },
        {
          name: 'no_uri',
          entityCount: 1,
          tripleCount: 1,
        },
      ],
    };
  }

  asDkg(): DkgClient {
    return this as unknown as DkgClient;
  }
}

const running: QueryGateway[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((gateway) => gateway.stop()));
});

async function startGateway(
  dkg = new GatewayDkg(),
  config = gatewayConfig(),
  log?: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  },
  submitAgentMemory?: NonNullable<
    ConstructorParameters<typeof QueryGateway>[3]
  >['submitAgentMemory'],
) {
  const gateway = new QueryGateway(
    config,
    [{ channelId: CHANNEL, contextGraphId: CONTEXT_GRAPH, promoters: [] }],
    dkg.asDkg(),
    { log, submitAgentMemory },
  );
  running.push(gateway);
  await gateway.start();
  const port = gateway.address?.port;
  if (!port) throw new Error('gateway did not bind a port');
  return { gateway, dkg, url: `http://127.0.0.1:${port}/v1/query` };
}

async function request(
  url: string,
  body: unknown,
  options: { token?: string; contentType?: string } = {},
) {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.token ?? TOKEN}`,
      'content-type': options.contentType ?? 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function body(operation: string, args: Record<string, unknown> = {}) {
  return { channelId: CHANNEL, operation, arguments: args, requesterPubkey: REQUESTER };
}

function binding(value: string): { value: string } {
  return { value };
}

describe('query gateway configuration', () => {
  it('loads under the production Node type-stripper', () => {
    const loaded = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        "await import('./src/query-gateway/server.ts')",
      ],
      { cwd: REPO, encoding: 'utf8' },
    );
    expect(loaded.status, loaded.stderr).toBe(0);
  });

  it('is disabled by default and accepts only literal loopback binds', () => {
    expect(loadQueryGatewayConfig({})).toEqual({ enabled: false });
    expect(
      loadQueryGatewayConfig({
        BDI_QUERY_GATEWAY_ENABLED: 'true',
        BDI_QUERY_GATEWAY_TOKEN: TOKEN,
      }).enabled,
    ).toBe(true);
    expect(() =>
      loadQueryGatewayConfig({
        BDI_QUERY_GATEWAY_ENABLED: 'true',
        BDI_QUERY_GATEWAY_BIND: '0.0.0.0',
        BDI_QUERY_GATEWAY_TOKEN: TOKEN,
      }),
    ).toThrow(/loopback literal/);
  });

  it('requires a strong gateway token and bounded timeout values when enabled', () => {
    expect(() =>
      loadQueryGatewayConfig({
        BDI_QUERY_GATEWAY_ENABLED: 'true',
        BDI_QUERY_GATEWAY_TOKEN: 'short',
      }),
    ).toThrow(/32 to 512/);
    expect(() =>
      loadQueryGatewayConfig({
        BDI_QUERY_GATEWAY_ENABLED: 'true',
        BDI_QUERY_GATEWAY_TOKEN: TOKEN,
        BDI_QUERY_GATEWAY_TIMEOUT_MS: '1000',
        BDI_QUERY_GATEWAY_DKG_TIMEOUT_MS: '1001',
      }),
    ).toThrow(/must not exceed/);
  });
});

describe('query gateway request contract', () => {
  it('accepts only the five typed operations and exact argument shapes', () => {
    expect(parseQueryGatewayRequest(body('channel_memory'))).toMatchObject({
      operation: 'channel_memory',
      requesterPubkey: REQUESTER,
    });
    expect(
      parseQueryGatewayRequest(body('contributor_trail', { pubkey: CONTRIBUTOR })),
    ).toMatchObject({ operation: 'contributor_trail', arguments: { pubkey: CONTRIBUTOR } });
    expect(parseQueryGatewayRequest(body('subgraph_graph', { name: 'core_1' }))).toMatchObject({
      operation: 'subgraph_graph',
    });
    expect(parseQueryGatewayRequest(body('subgraph_triples', { name: 'core_1' }))).toMatchObject({
      operation: 'subgraph_triples',
    });
    expect(parseQueryGatewayRequest(body('evidence', { uri: 'urn:buzz:claim:1' }))).toMatchObject({
      operation: 'evidence',
    });
  });

  it('rejects omitted requester identity and all client-supplied query controls', () => {
    const valid = body('channel_memory');
    const missingRequester = {
      channelId: valid.channelId,
      operation: valid.operation,
      arguments: valid.arguments,
    };
    expect(() => parseQueryGatewayRequest(missingRequester)).toThrow(/requesterPubkey/);
    for (const field of ['contextGraphId', 'cg', 'sparql', 'url', 'token']) {
      expect(() => parseQueryGatewayRequest({ ...valid, [field]: 'attacker-value' })).toThrow(
        /unexpected field/,
      );
    }
    expect(() =>
      parseQueryGatewayRequest(body('subgraph_graph', { name: 'core', sparql: 'DELETE WHERE {}' })),
    ).toThrow(/unexpected field/);
    expect(() => parseQueryGatewayRequest(body('raw_query'))).toThrow(/operation is invalid/);
  });
});

describe('query gateway HTTP boundary', () => {
  it('accepts agent memory only through the authenticated loopback JSON boundary', async () => {
    const submitted: unknown[] = [];
    const { url } = await startGateway(
      new GatewayDkg(),
      gatewayConfig(),
      undefined,
      async (raw) => {
        submitted.push(raw);
        return {
          ok: true,
          outcome: 'stored',
          proposalEventId: '11'.repeat(32),
          channelId: 'c69311ba-a5a2-4b2a-a27f-99f7669af643',
          requesterPubkey: REQUESTER,
          contextGraphId: 'buzz-memory-graph',
          kaName: 'buzz-dkg-memory',
          digest: '22'.repeat(32),
          state: 'receipted',
        };
      },
    );
    const payload = { signed: 'envelope' };
    const response = await request(url.replace('/v1/query', '/v1/memory'), payload);
    expect(response.status).toBe(200);
    expect(submitted).toEqual([payload]);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      outcome: 'stored',
      requesterPubkey: REQUESTER,
    });

    const unauthorized = await request(url.replace('/v1/query', '/v1/memory'), payload, {
      token: 'wrong-token-that-is-still-long-enough',
    });
    expect(unauthorized.status).toBe(401);
    expect(submitted).toHaveLength(1);
  });

  it('resolves newly provisioned channel bindings at request time', async () => {
    const dkg = new GatewayDkg();
    const service = new QueryGatewayService(
      async (channelId) => (channelId === 'new-channel' ? 'buzz-new-graph' : null),
      dkg.asDkg(),
      gatewayConfig(),
    );
    const response = await service.execute({
      ...body('channel_memory'),
      channelId: 'new-channel',
    });
    expect(response.cg).toBe('buzz-new-graph');
    expect(dkg.calls.every((call) => call.contextGraphId === 'buzz-new-graph')).toBe(true);
  });

  it('resolves the Context Graph server-side and queries only SWM and VM', async () => {
    const { dkg, url } = await startGateway();
    const response = await request(url, body('channel_memory'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      channelId: CHANNEL,
      cg: CONTEXT_GRAPH,
      operation: 'channel_memory',
      result: {
        layers: {
          WM: null,
          SWM: [
            {
              graph: 'https://example.test/shared-working-memory/graph',
              label: 'shared-working-memory graph',
            },
          ],
          VM: [
            {
              graph: 'https://example.test/verifiable-memory/graph',
              label: 'verifiable-memory graph',
            },
          ],
        },
        decisions: [],
        contributors: [],
        subgraphs: [
          {
            name: 'core',
            uri: 'https://example.test/subgraph/core',
            description: null,
            createdBy: null,
            createdAt: null,
            entityCount: 2,
            tripleCount: 3,
          },
          {
            name: 'no_uri',
            uri: 'no_uri',
            description: null,
            createdBy: null,
            createdAt: null,
            entityCount: 1,
            tripleCount: 1,
          },
        ],
      },
    });
    expect(dkg.calls.length).toBeGreaterThan(0);
    expect(dkg.calls.every((call) => call.contextGraphId === CONTEXT_GRAPH)).toBe(true);
    expect(
      dkg.calls
        .filter((call) => call.kind === 'query')
        .every((call) => ['shared-working-memory', 'verifiable-memory'].includes(call.view ?? '')),
    ).toBe(true);
    expect(dkg.calls.some((call) => call.view === 'working-memory')).toBe(false);
  });

  it.each([
    ['contributor_trail', { pubkey: CONTRIBUTOR }, { pubkey: CONTRIBUTOR, trail: [] }],
    ['subgraph_graph', { name: 'core' }, { subgraph: 'core', nodes: [], edges: [] }],
    ['subgraph_triples', { name: 'core' }, { subgraph: 'core', triples: [] }],
    [
      'evidence',
      { uri: 'urn:buzz:claim:1' },
      {
        found: false,
        claimId: 'urn:buzz:claim:1',
        name: null,
        status: null,
        trustState: null,
        memoryLayer: null,
        attribution: [],
        digest: null,
        asOf: null,
        sources: [],
        relations: [],
        receiptUal: null,
        graph: null,
      },
    ],
  ])('returns the strict %s result shape', async (operation, args, expected) => {
    const { url } = await startGateway();
    const response = await request(url, body(operation, args));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      channelId: CHANNEL,
      cg: CONTEXT_GRAPH,
      operation,
      result: expected,
    });
  });

  it('preserves raw N-Triples objects in topology triples', async () => {
    const dkg = new GatewayDkg();
    dkg.tripleBindings = [
      {
        s: { value: '<urn:buzz:subject:1>' },
        p: { value: '<urn:buzz:predicate:1>' },
        o: { value: '"quoted literal"@en' },
        g: { value: '<https://example.test/core/_shared_memory/graph>' },
      },
      {
        s: { value: '<urn:buzz:subject:2>' },
        p: { value: '<urn:buzz:predicate:2>' },
        o: { value: '<urn:buzz:object:2>' },
        g: { value: '<https://example.test/core/_shared_memory/graph>' },
      },
    ];
    const { url } = await startGateway(dkg);
    const response = await request(url, body('subgraph_triples', { name: 'core' }));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      result: { triples: Array<{ object: string; layer: string }> };
    };
    expect(payload.result.triples).toEqual([
      expect.objectContaining({ object: '"quoted literal"@en', layer: 'VM' }),
      expect.objectContaining({ object: '<urn:buzz:object:2>', layer: 'VM' }),
    ]);
  });

  it('maps contributors and evidence through the RDF author relation', async () => {
    const dkg = new GatewayDkg();
    const event = 'urn:nostr:event:event-one';
    const decision = 'urn:buzz-dkg:decision:decision-one';
    const claim = 'urn:buzz:claim:claim-one';
    const at = '2026-08-05T12:00:00.000Z';
    const expectedAt = Date.parse(at) / 1_000;
    dkg.bindingResolver = (options) => {
      if (options.view !== 'verifiable-memory') return [];
      if (options.sparql.includes('COUNT(DISTINCT ?event)')) {
        return [{ pk: binding(CONTRIBUTOR), n: binding('2'), latest: binding(at) }];
      }
      if (options.sparql.includes('SELECT ?s ?name ?digest ?t')) {
        return [
          {
            s: binding(decision),
            name: binding('Choose the graph store'),
            digest: binding('digest-one'),
            t: binding(at),
          },
        ];
      }
      if (options.sparql.includes('SELECT ?event ?content ?at ?decision ?dname')) {
        return [
          {
            event: binding(event),
            content: binding('Use the embedded graph store.'),
            at: binding(at),
            decision: binding(decision),
            dname: binding('Choose the graph store'),
          },
        ];
      }
      if (options.sparql.includes(`GRAPH ?g { <${claim}> ?p ?o }`)) {
        return [
          {
            p: binding('http://schema.org/name'),
            o: binding('Storage claim'),
            g: binding('urn:g'),
          },
          {
            p: binding('http://www.w3.org/ns/prov#wasDerivedFrom'),
            o: binding(event),
            g: binding('urn:g'),
          },
          {
            p: binding('https://w3id.org/buzz-dkg/buzz#sourceSetDigest'),
            o: binding('digest-one'),
            g: binding('urn:g'),
          },
        ];
      }
      if (options.sparql.includes('VALUES ?ev')) {
        return [
          {
            ev: binding(event),
            content: binding('Use the embedded graph store.'),
            pk: binding(CONTRIBUTOR),
            at: binding(at),
          },
        ];
      }
      if (options.sparql.includes('SELECT ?s ?p WHERE')) {
        return [
          {
            s: binding(decision),
            p: binding('http://www.w3.org/ns/prov#wasDerivedFrom'),
          },
        ];
      }
      return null;
    };

    const { url } = await startGateway(dkg);
    const memoryResponse = await request(url, body('channel_memory'));
    expect(memoryResponse.status).toBe(200);
    const memoryPayload = (await memoryResponse.json()) as { result: unknown };
    expect(memoryPayload.result).toMatchObject({
      contributors: [{ pubkey: CONTRIBUTOR, events: 2, latest: expectedAt, layer: 'VM' }],
      decisions: [{ uri: decision, name: 'Choose the graph store', layer: 'VM' }],
    });

    const trailResponse = await request(url, body('contributor_trail', { pubkey: CONTRIBUTOR }));
    expect(trailResponse.status).toBe(200);
    const trailPayload = (await trailResponse.json()) as { result: unknown };
    expect(trailPayload.result).toEqual({
      pubkey: CONTRIBUTOR,
      trail: [
        {
          event,
          content: 'Use the embedded graph store.',
          at: expectedAt,
          decision,
          decisionName: 'Choose the graph store',
          layer: 'VM',
        },
      ],
    });

    const evidenceResponse = await request(url, body('evidence', { uri: claim }));
    expect(evidenceResponse.status).toBe(200);
    const evidencePayload = (await evidenceResponse.json()) as { result: unknown };
    expect(evidencePayload.result).toMatchObject({
      found: true,
      claimId: claim,
      name: 'Storage claim',
      memoryLayer: 'VM',
      attribution: [CONTRIBUTOR],
      digest: 'digest-one',
      sources: [
        {
          id: event,
          span: 'Use the embedded graph store.',
          author: CONTRIBUTOR,
          at: expectedAt,
        },
      ],
      relations: [{ from: decision, rel: 'wasDerivedFrom' }],
    });

    const authorQueries = dkg.calls
      .filter((call) => call.kind === 'query' && call.sparql?.includes('pubkeyHex'))
      .map((call) => call.sparql ?? '');
    expect(authorQueries.length).toBeGreaterThan(0);
    expect(authorQueries.every((sparql) => sparql.includes('wasAttributedTo'))).toBe(true);
  });

  it('scopes every topology query with the exact DKG subgraph option', async () => {
    const dkg = new GatewayDkg();
    const event = 'urn:nostr:event:core-event';
    const decision = 'urn:buzz:decision:core';
    const claim = 'urn:buzz:claim:core';
    const commit = 'urn:buzz:commit:core';
    const at = '2026-08-05T12:00:00.000Z';
    dkg.bindingResolver = (options) => {
      if (options.view !== 'verifiable-memory') return [];
      if (options.subGraphName !== 'core') {
        return [{ d: binding('urn:buzz:decision:foreign'), name: binding('Foreign decision') }];
      }
      if (options.sparql.includes('SELECT ?c ?text ?at ?run ?ev')) {
        return [
          {
            c: binding(claim),
            text: binding('Core claim'),
            at: binding(at),
            run: binding('urn:buzz:run:core'),
            ev: binding(event),
          },
        ];
      }
      if (options.sparql.includes('SELECT ?f ?type ?name ?at ?ev ?commit')) {
        return [
          {
            f: binding(commit),
            type: binding('https://w3id.org/buzz-dkg/buzz#Commit'),
            name: binding('Core commit'),
            at: binding(at),
            ev: binding(event),
            commit: binding('urn:git:commit:abc123'),
          },
        ];
      }
      if (options.sparql.includes('SELECT ?d ?name ?t ?ev')) {
        return [
          {
            d: binding(decision),
            name: binding('Core decision'),
            t: binding(at),
            ev: binding(event),
          },
        ];
      }
      if (options.sparql.includes('SELECT ?c ?d WHERE')) {
        return [{ c: binding(claim), d: binding(decision) }];
      }
      if (options.sparql.includes('SELECT ?s ?p ?o ?g')) {
        return [
          {
            s: binding(claim),
            p: binding('http://schema.org/name'),
            o: binding('"Core claim"'),
            g: binding('did:dkg:context-graph:team/core/_verifiable_memory/1'),
          },
        ];
      }
      return [];
    };

    const { url } = await startGateway(dkg);
    const graphResponse = await request(url, body('subgraph_graph', { name: 'core' }));
    expect(graphResponse.status).toBe(200);
    const graphPayload = (await graphResponse.json()) as {
      result: {
        nodes: Array<{ id: string; kind: string; contested?: number }>;
        edges: Array<{ from: string; to: string; rel: string }>;
      };
    };
    const graph = graphPayload.result;
    expect(graph.nodes.map((node) => node.id).sort()).toEqual([claim, commit, decision].sort());
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({ id: decision, kind: 'decision', contested: 1 }),
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { from: claim, to: decision, rel: 'supports' },
        { from: commit, to: decision, rel: 'supports' },
        { from: claim, to: decision, rel: 'contradicts' },
      ]),
    );

    const triplesResponse = await request(url, body('subgraph_triples', { name: 'core' }));
    expect(triplesResponse.status).toBe(200);
    const triplesPayload = (await triplesResponse.json()) as {
      result: { triples: unknown[] };
    };
    expect(triplesPayload.result.triples).toEqual([
      expect.objectContaining({ subject: claim, object: '"Core claim"', layer: 'VM' }),
    ]);

    const topologyCalls = dkg.calls.filter(
      (call) =>
        call.kind === 'query' &&
        (call.sparql?.includes('SELECT ?c ?text') ||
          call.sparql?.includes('SELECT ?f ?type') ||
          call.sparql?.includes('SELECT ?d ?name') ||
          call.sparql?.includes('SELECT ?c ?d WHERE') ||
          call.sparql?.includes('SELECT ?s ?p ?o ?g')),
    );
    expect(topologyCalls.length).toBeGreaterThan(0);
    expect(topologyCalls.every((call) => call.subGraphName === 'core')).toBe(true);
    expect(topologyCalls.every((call) => !call.sparql?.includes('CONTAINS(STR(?g)'))).toBe(true);
  });

  it('rejects unknown channels, query parameters, and invalid authorization before DKG access', async () => {
    const { dkg, url } = await startGateway();
    const unknown = await request(url, { ...body('channel_memory'), channelId: 'not-configured' });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ ok: false, error: { code: 'unknown_channel' } });

    const queryParameter = await request(`${url}?cg=attacker`, body('channel_memory'));
    expect(queryParameter.status).toBe(400);
    expect(await queryParameter.json()).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });

    const unauthorized = await request(url, body('channel_memory'), { token: 'wrong-token' });
    expect(unauthorized.status).toBe(401);
    expect(dkg.calls).toHaveLength(0);
  });

  it('bounds request bodies, result bodies, and operation duration', async () => {
    const bodyLimited = await startGateway(new GatewayDkg(), gatewayConfig({ maxBodyBytes: 100 }));
    const bodyResponse = await request(bodyLimited.url, body('channel_memory'));
    expect(bodyResponse.status).toBe(413);
    expect(await bodyResponse.json()).toMatchObject({ error: { code: 'body_too_large' } });

    const resultLimited = await startGateway(
      new GatewayDkg(),
      gatewayConfig({ maxResultBytes: 128 }),
    );
    const resultResponse = await request(resultLimited.url, body('channel_memory'));
    expect(resultResponse.status).toBe(502);
    expect(await resultResponse.json()).toMatchObject({ error: { code: 'result_too_large' } });

    const slowDkg = new GatewayDkg();
    slowDkg.hang = true;
    const timed = await startGateway(slowDkg, gatewayConfig({ operationTimeoutMs: 20 }));
    const timedResponse = await request(
      timed.url,
      body('evidence', { uri: 'urn:buzz:claim:slow' }),
    );
    expect(timedResponse.status).toBe(504);
    expect(await timedResponse.json()).toMatchObject({ error: { code: 'gateway_timeout' } });
  });

  it('does not expose gateway or DKG credentials in responses or audit logs', async () => {
    const dkg = new GatewayDkg();
    const dkgToken = 'dkg-secret-that-must-never-escape';
    dkg.failWith = `upstream rejected Bearer ${dkgToken}`;
    const records: unknown[] = [];
    const log = {
      info: (message: string, fields?: Record<string, unknown>) =>
        records.push({ message, fields }),
      warn: (message: string, fields?: Record<string, unknown>) =>
        records.push({ message, fields }),
    };
    const { url } = await startGateway(dkg, gatewayConfig(), log);
    const response = await request(url, body('evidence', { uri: 'urn:buzz:claim:1' }));
    expect(response.status).toBe(502);
    const serialized = `${await response.text()}\n${JSON.stringify(records)}`;
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(dkgToken);
    expect(serialized).not.toContain('Bearer');
    expect(serialized).toContain(REQUESTER);
  });
});
