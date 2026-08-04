export function relayEndpoints(raw) {
  const parsed = new URL(raw);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    throw new Error(`unsupported Buzz Relay URL protocol: ${parsed.protocol}`);
  }
  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  const http = new URL(parsed);
  http.protocol =
    parsed.protocol === 'wss:' ? 'https:' : parsed.protocol === 'ws:' ? 'http:' : parsed.protocol;
  const ws = new URL(parsed);
  ws.protocol =
    parsed.protocol === 'https:' ? 'wss:' : parsed.protocol === 'http:' ? 'ws:' : parsed.protocol;
  return { http: http.toString().replace(/\/$/, ''), ws: ws.toString().replace(/\/$/, '') };
}

export async function probeRelay(httpUrl, fetchImpl = fetch) {
  try {
    const readiness = await fetchImpl(`${httpUrl}/_readiness`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    });
    const readinessBody = await readiness.json().catch(() => null);
    if (readiness.status !== 200 || readinessBody?.status !== 'ready') {
      throw new Error(`readiness contract failed (HTTP ${readiness.status})`);
    }

    const info = await fetchImpl(`${httpUrl}/info`, {
      headers: { accept: 'application/nostr+json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    });
    const document = await info.json().catch(() => null);
    if (
      info.status !== 200 ||
      document?.software !== 'https://github.com/block/buzz' ||
      !Array.isArray(document?.supported_nips) ||
      !document.supported_nips.includes(29)
    ) {
      throw new Error('endpoint does not advertise the Buzz Relay NIP-11 contract');
    }
    return { status: readiness.status, path: '/_readiness' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Buzz Relay ${httpUrl} validation failed (${detail})`);
  }
}
