import { isAbsolute, resolve } from 'node:path';

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

function isBuzzContainer(container, env = containerEnv(container)) {
  const image = String(container?.Config?.Image || '').toLowerCase();
  const service = String(
    container?.Config?.Labels?.['com.docker.compose.service'] || '',
  ).toLowerCase();
  return (
    image.includes('buzz') ||
    Boolean(env.BUZZ_BIND_ADDR) ||
    (service === 'relay' && Boolean(env.RELAY_URL))
  );
}

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

/**
 * Host-local management information is deliberately kept separate from the
 * public relay URL. It is used only to invoke Buzz's own administrative CLI on
 * a relay container that Docker has already identified; remote relays never
 * acquire an inferred management path.
 */
export function relayManagementFromContainer(container, fallbackId = '') {
  const env = containerEnv(container);
  if (!isBuzzContainer(container, env)) return null;
  const containerId = String(container?.Id || fallbackId || '');
  if (!/^[a-f0-9]{12,64}$/i.test(containerId)) return null;
  const management = {
    containerId,
    containerName: String(container?.Name || '').replace(/^\//, ''),
    membershipRequired: enabled(env.BUZZ_REQUIRE_RELAY_MEMBERSHIP),
  };
  const labels = container?.Config?.Labels || {};
  const project = String(labels['com.docker.compose.project'] || '');
  const service = String(labels['com.docker.compose.service'] || '');
  const workingDir = String(labels['com.docker.compose.project.working_dir'] || '');
  const rawFiles = String(labels['com.docker.compose.project.config_files'] || '');
  const rawEnvFiles = String(labels['com.docker.compose.project.environment_file'] || '');
  if (
    /^[A-Za-z0-9_.-]{1,128}$/.test(project) &&
    /^[A-Za-z0-9_.-]{1,128}$/.test(service) &&
    isAbsolute(workingDir) &&
    rawFiles &&
    !rawFiles.includes('\n')
  ) {
    const configFiles = rawFiles
      .split(',')
      .map((path) => path.trim())
      .filter(Boolean)
      .map((path) => (isAbsolute(path) ? path : resolve(workingDir, path)));
    const envFiles = rawEnvFiles
      ? rawEnvFiles
          .split(',')
          .map((path) => path.trim())
          .filter(Boolean)
          .map((path) => (isAbsolute(path) ? path : resolve(workingDir, path)))
      : [];
    if (configFiles.length > 0 && !rawEnvFiles.includes('\n')) {
      management.compose = { project, service, workingDir, configFiles, envFiles };
    }
  }
  return management;
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
  if (!isBuzzContainer(container, env)) return [];

  const local = (container?.NetworkSettings?.Ports?.['3000/tcp'] || [])
    .map(hostBindingUrl)
    .filter(Boolean);

  // Buzz resolves the community from the request authority and signs NIP-98
  // requests for that same public URL. A loopback host binding is therefore
  // safe for an unauthenticated readiness/NIP-11 probe, but it must never
  // replace an advertised RELAY_URL used by bootstrap or the daemon.
  if (env.RELAY_URL) {
    return [{ relayUrl: env.RELAY_URL, probeUrl: local[0] || env.RELAY_URL }];
  }
  return [...new Set(local)].map((url) => ({ relayUrl: url, probeUrl: url }));
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
    return {
      status: readiness.status,
      path: '/_readiness',
      supportedExtensions: Array.isArray(document.supported_extensions)
        ? document.supported_extensions
        : [],
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Buzz Relay ${httpUrl} validation failed (${detail})`);
  }
}
