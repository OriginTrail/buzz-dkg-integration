import { describe, expect, it, vi } from 'vitest';
import { DkgClient, DkgHttpTransport } from '../src/dkg/http.mjs';

describe('shared DKG HTTP transport', () => {
  it('applies bearer auth and parses JSON consistently', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const client = new DkgHttpTransport({ baseUrl: 'http://dkg/', token: 'secret', fetchImpl });
    await expect(client.request('POST', '/api/test', { value: 1 })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://dkg/api/test',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer secret' }),
        body: '{"value":1}',
      }),
    );
  });

  it('preserves status and parsed body on HTTP errors', async () => {
    const client = new DkgHttpTransport({
      baseUrl: 'http://dkg',
      token: 'secret',
      fetchImpl: async () => new Response('{"reason":"no"}', { status: 409 }),
    });
    await expect(client.request('GET', '/conflict')).rejects.toMatchObject({
      status: 409,
      body: { reason: 'no' },
    });
  });

  it('always supplies an abort signal and maps TimeoutError consistently', async () => {
    const signalClient = new DkgHttpTransport({
      baseUrl: 'http://dkg',
      token: 'secret',
      fetchImpl: async (_url, options) => {
        expect(options.signal).toBeInstanceOf(AbortSignal);
        return new Response('{}', { status: 200 });
      },
    });
    await signalClient.request('GET', '/signal');

    const timeoutClient = new DkgHttpTransport({
      baseUrl: 'http://dkg',
      token: 'secret',
      timeoutMs: 17,
      fetchImpl: async () => {
        const error = new Error('aborted');
        error.name = 'TimeoutError';
        throw error;
      },
    });
    await expect(timeoutClient.request('POST', '/slow')).rejects.toThrow(
      'dkg POST /slow timed out after 17ms',
    );
  });

  it('owns shared status and context-graph routes', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"exists":true}', { status: 200 }));
    const client = new DkgClient({ baseUrl: 'http://dkg', token: 'secret', fetchImpl });
    await client.contextGraphExists('channel/a');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://dkg/api/context-graph/exists?id=channel%2Fa',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
