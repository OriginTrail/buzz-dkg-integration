import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs, relayEndpoints } from '../scripts/install.mjs';
import { probeRelay, relayCandidatesFromContainer } from '../scripts/install/relay.mjs';

const roots = [];
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function apiServer(role = 'edge', status = {}) {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/_readiness') {
      response.end(JSON.stringify({ status: 'ready' }));
      return;
    }
    if (request.url === '/info') {
      response.end(
        JSON.stringify({
          software: 'https://github.com/block/buzz',
          supported_nips: [1, 29],
          version: 'test',
        }),
      );
      return;
    }
    if (request.url === '/api/status') {
      response.end(
        JSON.stringify({
          nodeRole: role,
          version: '10.0.12',
          networkId: 'testnet',
          ...status,
        }),
      );
      return;
    }
    response.statusCode = 200;
    response.end('{}');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

async function genericServer() {
  const server = createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader('content-type', 'text/html');
    response.end('<h1>generic web server</h1>');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'buzz-dkg-install-test-'));
  roots.push(root);
  const bin = join(root, 'bin');
  const config = join(root, 'config');
  const state = join(root, 'state');
  const token = join(root, 'auth.token');
  const dockerLog = join(root, 'docker.log');
  const daemonReady = join(root, 'daemon.ready');
  mkdirSync(bin, { recursive: true });
  writeFileSync(token, 'test-token\n', { mode: 0o600 });
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
printf '%s\n' "$*" >> "$BUZZ_DKG_DOCKER_LOG"
case "$*" in
  *"compose version"*) echo "Docker Compose version v2.30.0" ;;
  *"up -d daemon"*) touch "$BUZZ_DKG_DAEMON_READY" ;;
  *"logs --no-color daemon"*)
    test -f "$BUZZ_DKG_DAEMON_READY" && echo '{"message":"daemon started"}'
    ;;
  *"run --rm bootstrap"*)
    mkdir -p "$BUZZ_DKG_STATE_DIR"
    printf '%s\n' '{"channelName":"Web of Trust","channelId":"550e8400-e29b-41d4-a716-446655440000","contextGraphId":"buzz-test"}' > "$BUZZ_DKG_STATE_DIR/bootstrap.json"
    ;;
  *) echo "Docker version 27.0.0" ;;
esac
`,
  );
  chmodSync(join(bin, 'docker'), 0o755);
  return { root, bin, config, state, token, dockerLog, daemonReady };
}

function runInstaller(f, args) {
  const child = spawn(process.execPath, [resolve('scripts/install.mjs'), ...args], {
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      BUZZ_DKG_CONFIG_DIR: f.config,
      BUZZ_DKG_STATE_DIR: f.state,
      BUZZ_DKG_ALLOW_NON_ROOT: '1',
      BUZZ_DKG_ALLOW_UNSUPPORTED: '1',
      BUZZ_DKG_DOCKER_LOG: f.dockerLog,
      BUZZ_DKG_DAEMON_READY: f.daemonReady,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return new Promise((done) => child.on('close', (status) => done({ status, stdout, stderr })));
}

describe('Buzz-first installer CLI', () => {
  it('derives matching HTTP and WebSocket relay origins', () => {
    expect(relayEndpoints('wss://community.example.com/some/path?ignored=1')).toEqual({
      http: 'https://community.example.com',
      ws: 'wss://community.example.com',
    });
    expect(relayEndpoints('http://127.0.0.1:9440')).toEqual({
      http: 'http://127.0.0.1:9440',
      ws: 'ws://127.0.0.1:9440',
    });
  });

  it('preserves a Buzz community authority while using its local port only for probes', () => {
    expect(
      relayCandidatesFromContainer({
        Config: {
          Image: 'ghcr.io/block/buzz:sha-test',
          Env: ['RELAY_URL=wss://community.example.com'],
          Labels: { 'com.docker.compose.service': 'relay' },
        },
        NetworkSettings: {
          Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '9440' }] },
        },
      }),
    ).toEqual([
      {
        relayUrl: 'wss://community.example.com',
        probeUrl: 'http://127.0.0.1:9440',
      },
    ]);
  });

  it('uses the configured relay URL when the Buzz container has no host mapping', () => {
    expect(
      relayCandidatesFromContainer({
        Config: {
          Image: 'ghcr.io/block/buzz:sha-test',
          Env: ['RELAY_URL=wss://community.example.com'],
        },
        NetworkSettings: { Ports: {} },
      }),
    ).toEqual([
      {
        relayUrl: 'wss://community.example.com',
        probeUrl: 'wss://community.example.com',
      },
    ]);
  });

  it('does not discover a generic Compose relay service as Buzz', () => {
    expect(
      relayCandidatesFromContainer({
        Config: {
          Image: 'example/generic-relay:latest',
          Env: [],
          Labels: { 'com.docker.compose.service': 'relay' },
        },
        NetworkSettings: {
          Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3000' }] },
        },
      }),
    ).toEqual([]);
  });

  it('normalizes wildcard Buzz host bindings to loopback URLs', () => {
    const container = (hostIp) => ({
      Config: { Image: 'ghcr.io/block/buzz:sha-test', Env: [] },
      NetworkSettings: {
        Ports: { '3000/tcp': [{ HostIp: hostIp, HostPort: '9440' }] },
      },
    });
    expect(relayCandidatesFromContainer(container('0.0.0.0'))).toEqual([
      { relayUrl: 'http://127.0.0.1:9440', probeUrl: 'http://127.0.0.1:9440' },
    ]);
    expect(relayCandidatesFromContainer(container(''))).toEqual([
      { relayUrl: 'http://127.0.0.1:9440', probeUrl: 'http://127.0.0.1:9440' },
    ]);
    expect(relayCandidatesFromContainer(container('::'))).toEqual([
      { relayUrl: 'http://[::1]:9440', probeUrl: 'http://[::1]:9440' },
    ]);
  });

  it('keeps tenant operations on the advertised authority after a loopback probe', async () => {
    const probeServer = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/_readiness') {
        response.end(JSON.stringify({ status: 'ready' }));
      } else if (request.url === '/info') {
        response.end(
          JSON.stringify({
            software: 'https://github.com/block/buzz',
            supported_nips: [1, 29],
          }),
        );
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'no community is configured for this host' }));
      }
    });
    await new Promise((done) => probeServer.listen(0, '127.0.0.1', done));
    servers.push(probeServer);

    let publicAuthority;
    const tenantServer = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/query' && request.headers.host === publicAuthority) {
        response.end('[]');
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'no community is configured for this host' }));
      }
    });
    await new Promise((done) => tenantServer.listen(0, '127.0.0.1', done));
    servers.push(tenantServer);
    publicAuthority = `127.0.0.1:${tenantServer.address().port}`;
    const publicUrl = `http://${publicAuthority}`;
    const probeUrl = `http://127.0.0.1:${probeServer.address().port}`;

    const [candidate] = relayCandidatesFromContainer({
      Config: {
        Image: 'ghcr.io/block/buzz:sha-test',
        Env: [`RELAY_URL=${publicUrl}`],
      },
      NetworkSettings: {
        Ports: {
          '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(probeServer.address().port) }],
        },
      },
    });

    expect(candidate).toEqual({ relayUrl: publicUrl, probeUrl });
    await expect(probeRelay(relayEndpoints(candidate.probeUrl).http)).resolves.toMatchObject({
      status: 200,
    });
    expect((await fetch(`${relayEndpoints(candidate.relayUrl).http}/query`)).status).toBe(200);
    expect((await fetch(`${relayEndpoints(candidate.probeUrl).http}/query`)).status).toBe(404);
  });

  it('accepts explicit Buzz and DKG selections', () => {
    expect(
      parseArgs([
        'install',
        '--relay',
        'wss://community.example.com',
        '--dkg-role',
        'edge',
        '--dkg-network',
        'testnet',
        '--dkg-api',
        'http://127.0.0.1:9200',
        '--yes',
      ]),
    ).toEqual({
      command: 'install',
      relay: 'wss://community.example.com',
      dkgRole: 'edge',
      dkgNetwork: 'testnet',
      dkgApi: 'http://127.0.0.1:9200',
      yes: true,
    });
  });

  it('rejects unsupported node roles, networks, and relay protocols', () => {
    expect(() => parseArgs(['install', '--dkg-role', 'validator'])).toThrow(
      '--dkg-role must be auto, edge, or core',
    );
    expect(() => parseArgs(['install', '--dkg-network', 'testent'])).toThrow(
      '--dkg-network must be one of',
    );
    expect(() => relayEndpoints('ftp://community.example.com')).toThrow(
      'unsupported Buzz Relay URL protocol',
    );
  });

  it('writes safe runtime config and invokes bootstrap, daemon, and smoke', async () => {
    const f = fixture();
    const api = await apiServer();
    const result = await runInstaller(f, [
      'install',
      '--relay',
      api,
      '--dkg-api',
      api,
      '--dkg-token-path',
      f.token,
      '--dkg-role',
      'edge',
      '--yes',
    ]);
    expect(result.status, result.stderr).toBe(0);
    const runtime = readFileSync(join(f.config, 'runtime.env'), 'utf8');
    expect(runtime).toContain('BDI_PUBLISH_MODE=disabled');
    expect(runtime).toContain('BDI_MAX_PUBLISHES_PER_DAY=0');
    expect(runtime).toContain(`BDI_DKG_TOKEN_PATH=${f.token}`);
    expect(runtime).toMatch(/BUZZ_DKG_RUNTIME_UID=\d+/);
    expect(existsSync(join(f.state, 'bootstrap.json'))).toBe(true);
    const dockerCalls = readFileSync(f.dockerLog, 'utf8');
    expect(dockerCalls).toContain('run --rm bootstrap');
    expect(dockerCalls).toContain('up -d daemon');
    expect(dockerCalls).toContain('logs --no-color daemon');
    expect(dockerCalls).toContain('run --rm smoke');
    expect(result.stdout).toContain('Buzz + DKG is ready.');
  });

  it('aborts before persistent config for a missing token or role mismatch', async () => {
    const api = await apiServer('edge');
    const missing = fixture();
    const missingResult = await runInstaller(missing, [
      'install',
      '--relay',
      api,
      '--dkg-api',
      api,
      '--dkg-token-path',
      join(missing.root, 'missing.token'),
      '--yes',
    ]);
    expect(missingResult.status).not.toBe(0);
    expect(missingResult.stderr).toContain('DKG token does not exist');
    expect(existsSync(join(missing.config, 'runtime.env'))).toBe(false);

    const mismatch = fixture();
    const mismatchResult = await runInstaller(mismatch, [
      'install',
      '--relay',
      api,
      '--dkg-api',
      api,
      '--dkg-token-path',
      mismatch.token,
      '--dkg-role',
      'core',
      '--yes',
    ]);
    expect(mismatchResult.status).not.toBe(0);
    expect(mismatchResult.stderr).toContain('is edge, but core was requested');
    expect(existsSync(join(mismatch.config, 'runtime.env'))).toBe(false);
  });

  it('rejects a generic HTTP 200 endpoint before DKG or config mutation', async () => {
    const endpoint = await genericServer();
    const f = fixture();
    const result = await runInstaller(f, [
      'install',
      '--relay',
      endpoint,
      '--dkg-api',
      'http://127.0.0.1:1',
      '--dkg-token-path',
      f.token,
      '--dkg-network',
      'testnet',
      '--yes',
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Buzz Relay');
    expect(existsSync(join(f.config, 'runtime.env'))).toBe(false);
    expect(existsSync(join(f.state, 'dkg-cli'))).toBe(false);
  });

  it('rejects incompatible or wrong-network DKG reuse before config writes', async () => {
    const incompatibleApi = await apiServer('edge', { version: '10.0.8' });
    const incompatible = fixture();
    const incompatibleResult = await runInstaller(incompatible, [
      'install',
      '--relay',
      incompatibleApi,
      '--dkg-api',
      incompatibleApi,
      '--dkg-token-path',
      incompatible.token,
      '--yes',
    ]);
    expect(incompatibleResult.status).not.toBe(0);
    expect(incompatibleResult.stderr).toContain('version 10.0.8 is incompatible');
    expect(existsSync(join(incompatible.config, 'runtime.env'))).toBe(false);

    const wrongNetworkApi = await apiServer('edge', { networkId: 'testnet' });
    const wrongNetwork = fixture();
    const wrongNetworkResult = await runInstaller(wrongNetwork, [
      'install',
      '--relay',
      wrongNetworkApi,
      '--dkg-api',
      wrongNetworkApi,
      '--dkg-token-path',
      wrongNetwork.token,
      '--dkg-network',
      'mainnet-base',
      '--yes',
    ]);
    expect(wrongNetworkResult.status).not.toBe(0);
    expect(wrongNetworkResult.stderr).toContain('does not match requested mainnet-base');
    expect(existsSync(join(wrongNetwork.config, 'runtime.env'))).toBe(false);
  });
});
