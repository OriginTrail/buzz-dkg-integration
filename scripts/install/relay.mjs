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

function containerEnv(container) {
  return Object.fromEntries(
    (container?.Config?.Env || []).map((entry) => {
      const at = entry.indexOf('=');
      return at < 0 ? [entry, ''] : [entry.slice(0, at), entry.slice(at + 1)];
    }),
  );
}

function hostBindingUrl(binding) {
  const port = String(binding?.HostPort || '');
  if (!/^\d+$/.test(port)) return null;
  let host = String(binding?.HostIp || '127.0.0.1');
  if (!host || host === '0.0.0.0') host = '127.0.0.1';
  if (host === '::') host = '::1';
  if (host.includes(':')) host = `[${host}]`;
  return `http://${host}:${port}`;
}

export function relayCandidatesFromContainer(container) {
  const env = containerEnv(container);
  const image = String(container?.Config?.Image || '').toLowerCase();
  const service = String(
    container?.Config?.Labels?.['com.docker.compose.service'] || '',
  ).toLowerCase();
  const isBuzz =
    image.includes('buzz') ||
    Boolean(env.BUZZ_BIND_ADDR) ||
    (service === 'relay' && Boolean(env.RELAY_URL));
  if (!isBuzz) return [];

  const local = (container?.NetworkSettings?.Ports?.['3000/tcp'] || [])
    .map(hostBindingUrl)
    .filter(Boolean);

  // Prefer a host-local mapping. It avoids hairpin TLS/auth failures and keeps
  // the integration working when the relay's public URL is private-network gated.
  return [...new Set(local.length > 0 ? local : env.RELAY_URL ? [env.RELAY_URL] : [])];
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
