import { describe, expect, it, vi } from 'vitest';
import { DkgHttpTransport } from '../src/dkg/http.mjs';

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
});
