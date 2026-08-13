import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import oxigraph from 'oxigraph';
import type { DkgClient } from '../src/dkg/client.ts';
import { QueryGateway } from '../src/query-gateway/server.ts';
import { QueryGatewayService } from '../src/query-gateway/service.ts';
import type { QueryGatewayConfig } from '../src/types.ts';

const TOKEN = 'gateway-token-'.padEnd(32, 'x');
const REQUESTER = 'ab'.repeat(32);
const CHANNEL = 'channel-one';
const CONTEXT_GRAPH = 'did:dkg:otp/0xabc/42';

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
    kind: 'query';
    contextGraphId: string;
    view: string;
    sparql: string;
    timeoutMs?: number;
  }> = [];
  bindingResolver:
    | ((options: {
        contextGraphId: string;
        view: string;
        sparql: string;
      }) => Array<Record<string, { value: string }>> | null)
    | null = null;
  quads: unknown[] | null = null;
  askResult: boolean | null = null;
  rawResponse: unknown | null = null;

  async query(
    options: { contextGraphId: string; view: string; sparql: string },
    timeoutMs?: number,
  ) {
    this.calls.push({ kind: 'query', ...options, timeoutMs });
    if (this.rawResponse !== null) return this.rawResponse;
    const bindings = this.bindingResolver?.(options) ?? [];
    return {
      result: {
        bindings,
        ...(this.askResult !== null ? { boolean: this.askResult } : {}),
        ...(this.quads ? { quads: this.quads } : {}),
      },
    };
  }

  async listSubGraphs() {
    return { contextGraphId: CONTEXT_GRAPH, subGraphs: [] };
  }

  asDkg(): DkgClient {
    return this as unknown as DkgClient;
  }
}

const running: QueryGateway[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((gateway) => gateway.stop()));
});

async function startGateway(dkg = new GatewayDkg()) {
  const gateway = new QueryGateway(
    gatewayConfig(),
    [{ channelId: CHANNEL, contextGraphId: CONTEXT_GRAPH, promoters: [] }],
    dkg.asDkg(),
  );
  running.push(gateway);
  await gateway.start();
  const port = gateway.address?.port;
  if (!port) throw new Error('gateway did not bind a port');
  return { dkg, url: `http://127.0.0.1:${port}/v1/query` };
}

async function request(url: string, body: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function semanticBody(sparql: string, view = 'both') {
  return {
    channelId: CHANNEL,
    operation: 'semantic_query',
    scope: { type: 'current_channel' },
    arguments: { sparql, view },
    requesterPubkey: REQUESTER,
  };
}

function binding(value: string): { value: string } {
  return { value };
}

function fixtureQuery(sparql: string): Array<Record<string, { value: string }>> {
  const store = new oxigraph.Store();
  store.load(readFileSync(new URL('./fixtures/ontology/lifelike-project.trig', import.meta.url)), {
    format: 'application/trig',
  });
  const result = store.query(sparql);
  if (!Array.isArray(result)) throw new Error('expected SELECT results from fixture query');
  return (result as Array<Map<string, oxigraph.Term>>).map((row) =>
    Object.fromEntries([...row.entries()].map(([name, term]) => [name, { value: term.value }])),
  );
}

describe('semantic query execution', () => {
  it('resolves the current channel graph server-side and queries selected visible layers', async () => {
    const dkg = new GatewayDkg();
    dkg.bindingResolver = ({ sparql }) =>
      sparql.includes('<urn:decision>') ? [{ name: binding('Use x402') }] : [];
    const service = new QueryGatewayService(
      (channelId) => (channelId === CHANNEL ? CONTEXT_GRAPH : null),
      dkg.asDkg(),
      gatewayConfig(),
    );
    const sparql =
      'SELECT ?name WHERE { GRAPH ?g { <urn:decision> <http://schema.org/name> ?name } } LIMIT 25';
    const result = await service.execute(semanticBody(sparql, 'shared'));

    expect(result).toMatchObject({
      ok: true,
      channelId: CHANNEL,
      cg: CONTEXT_GRAPH,
      operation: 'semantic_query',
      result: {
        queryType: 'select',
        scope: { type: 'current_channel' },
        layers: [{ layer: 'SWM', bindings: [{ name: binding('Use x402') }] }],
      },
    });
    expect(dkg.calls).toEqual([
      expect.objectContaining({
        kind: 'query',
        contextGraphId: CONTEXT_GRAPH,
        view: 'shared-working-memory',
        sparql,
      }),
    ]);
  });

  it('defaults to both visible layers and maps verified queries to VM', async () => {
    const dkg = new GatewayDkg();
    const service = new QueryGatewayService(() => CONTEXT_GRAPH, dkg.asDkg(), gatewayConfig());
    const sparql = 'SELECT ?o WHERE { GRAPH ?g { <urn:s> <urn:p> ?o } } LIMIT 25';
    const omittedView = semanticBody(sparql) as {
      arguments: { sparql: string; view?: string };
    };
    delete omittedView.arguments.view;

    const both = await service.execute(omittedView);
    expect((both.result as { layers: Array<{ layer: string }> }).layers).toEqual([
      expect.objectContaining({ layer: 'SWM' }),
      expect.objectContaining({ layer: 'VM' }),
    ]);
    expect(dkg.calls.map((call) => call.view)).toEqual([
      'shared-working-memory',
      'verifiable-memory',
    ]);

    dkg.calls.length = 0;
    const verified = await service.execute(semanticBody(sparql, 'verified'));
    expect((verified.result as { layers: Array<{ layer: string }> }).layers).toEqual([
      expect.objectContaining({ layer: 'VM' }),
    ]);
    expect(dkg.calls.map((call) => call.view)).toEqual(['verifiable-memory']);
  });

  it('caps semantic DKG reads at ten seconds', async () => {
    const dkg = new GatewayDkg();
    const service = new QueryGatewayService(
      () => CONTEXT_GRAPH,
      dkg.asDkg(),
      gatewayConfig({ dkgTimeoutMs: 30_000, operationTimeoutMs: 30_000 }),
    );
    await service.execute(
      semanticBody('SELECT ?o WHERE { GRAPH ?g { <urn:s> <urn:p> ?o } } LIMIT 25', 'shared'),
    );
    expect(dkg.calls).toEqual([expect.objectContaining({ timeoutMs: 10_000 })]);
  });

  it('returns ASK booleans and caps SELECT rows to the verified query limit', async () => {
    const dkg = new GatewayDkg();
    dkg.askResult = true;
    const service = new QueryGatewayService(() => CONTEXT_GRAPH, dkg.asDkg(), gatewayConfig());
    const ask = await service.execute(
      semanticBody('ASK { GRAPH ?g { <urn:s> <urn:p> ?o } }', 'shared'),
    );
    expect(ask.result).toMatchObject({
      queryType: 'ask',
      layers: [{ layer: 'SWM', boolean: true }],
    });

    dkg.askResult = null;
    dkg.bindingResolver = () => [
      { value: binding('one') },
      { value: binding('two') },
      { value: binding('must be capped') },
    ];
    const select = await service.execute(
      semanticBody('SELECT ?value WHERE { GRAPH ?g { ?s <urn:p> ?value } } LIMIT 2', 'shared'),
    );
    expect(select.result).toMatchObject({
      queryType: 'select',
      layers: [{ layer: 'SWM', bindings: [{ value: binding('one') }, { value: binding('two') }] }],
    });
  });

  it('answers a lifelike agent-authored decision trace with the ontology fixture', async () => {
    const dkg = new GatewayDkg();
    dkg.bindingResolver = ({ sparql }) => fixtureQuery(sparql);
    const service = new QueryGatewayService(() => CONTEXT_GRAPH, dkg.asDkg(), gatewayConfig());
    const sparql = `PREFIX schema: <http://schema.org/>
      PREFIX github: <http://dkg.io/ontology/github/>
      PREFIX decisions: <http://dkg.io/ontology/decisions/>
      SELECT ?decision ?name ?context ?outcome WHERE { GRAPH ?g {
        VALUES ?commit { <urn:dkg:github:commit:acme/api/a1b2c3d4> }
        ?decision a decisions:Decision ; schema:name ?name ;
          decisions:implementedBy ?commit ; decisions:context ?context ;
          decisions:outcome ?outcome .
      } } LIMIT 25`;
    const response = await service.execute(semanticBody(sparql, 'shared'));
    const layers = (
      response.result as {
        layers: Array<{ bindings: Array<Record<string, { value?: string }>> }>;
      }
    ).layers;

    expect(layers[0]?.bindings).toHaveLength(1);
    expect(layers[0]?.bindings[0]).toMatchObject({
      name: binding('Use short-lived JWT access tokens'),
    });
    expect(String(layers[0]?.bindings[0]?.outcome?.value)).toContain('15-minute');
  });

  it('returns structured simplification feedback through the HTTP gateway', async () => {
    const { url, dkg } = await startGateway();
    const response = await request(
      url,
      semanticBody('SELECT ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT 25'),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: {
        code: 'unsafe_query',
        details: { suggestions: expect.any(Array) },
      },
    });
    expect(dkg.calls).toHaveLength(0);
  });

  it('rejects oversized CONSTRUCT fanout before querying the DKG', async () => {
    const dkg = new GatewayDkg();
    const service = new QueryGatewayService(() => CONTEXT_GRAPH, dkg.asDkg(), gatewayConfig());
    const sparql = `CONSTRUCT {
      ?s <urn:p1> ?o1 . ?s <urn:p2> ?o2 . ?s <urn:p3> ?o3 . ?s <urn:p4> ?o4 .
    } WHERE {
      GRAPH ?g { ?s <urn:p1> ?o1 ; <urn:p2> ?o2 ; <urn:p3> ?o3 ; <urn:p4> ?o4 }
    } LIMIT 100`;

    await expect(service.execute(semanticBody(sparql, 'shared'))).rejects.toMatchObject({
      status: 422,
      code: 'query_too_expensive',
    });
    expect(dkg.calls).toHaveLength(0);
  });

  it('fails closed if the DKG violates a verified CONSTRUCT result bound', async () => {
    const dkg = new GatewayDkg();
    dkg.bindingResolver = () => [];
    dkg.quads = Array.from({ length: 301 }, (_, index) => ({ index }));
    const service = new QueryGatewayService(() => CONTEXT_GRAPH, dkg.asDkg(), gatewayConfig());

    await expect(
      service.execute(
        semanticBody(
          'CONSTRUCT { ?s <urn:p> ?o } WHERE { GRAPH ?g { ?s <urn:p> ?o } } LIMIT 100',
          'shared',
        ),
      ),
    ).rejects.toMatchObject({ status: 502, code: 'result_bound_exceeded' });
  });

  it('requires and returns a valid bounded CONSTRUCT graph', async () => {
    const dkg = new GatewayDkg();
    dkg.quads = [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }];
    const service = new QueryGatewayService(() => CONTEXT_GRAPH, dkg.asDkg(), gatewayConfig());
    const query = 'CONSTRUCT { ?s <urn:p> ?o } WHERE { GRAPH ?g { ?s <urn:p> ?o } } LIMIT 2';
    const result = await service.execute(semanticBody(query, 'shared'));
    expect(result.result).toMatchObject({
      queryType: 'construct',
      layers: [{ layer: 'SWM', quads: dkg.quads }],
    });

    dkg.quads = null;
    await expect(service.execute(semanticBody(query, 'shared'))).rejects.toThrow(
      /invalid quads shape/,
    );
  });

  it('rejects malformed DKG response shapes for every semantic query form', async () => {
    const dkg = new GatewayDkg();
    const service = new QueryGatewayService(() => CONTEXT_GRAPH, dkg.asDkg(), gatewayConfig());

    dkg.rawResponse = { result: { bindings: 'not-an-array' } };
    await expect(
      service.execute(
        semanticBody('SELECT ?o WHERE { GRAPH ?g { <urn:s> <urn:p> ?o } } LIMIT 1', 'shared'),
      ),
    ).rejects.toThrow(/invalid bindings shape/);

    dkg.rawResponse = { result: { boolean: 'true' } };
    await expect(
      service.execute(semanticBody('ASK { GRAPH ?g { <urn:s> <urn:p> ?o } }', 'shared')),
    ).rejects.toThrow(/invalid boolean shape/);

    dkg.rawResponse = { result: { quads: [() => undefined] } };
    await expect(
      service.execute(
        semanticBody(
          'CONSTRUCT { ?s <urn:p> ?o } WHERE { GRAPH ?g { ?s <urn:p> ?o } } LIMIT 1',
          'shared',
        ),
      ),
    ).rejects.toThrow(/invalid quad/);
  });
});
