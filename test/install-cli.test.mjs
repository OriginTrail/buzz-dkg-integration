import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getPublicKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs, relayEndpoints } from '../scripts/install.mjs';
import {
  probeRelay,
  relayCandidatesFromContainer,
  relayManagementFromContainer,
} from '../scripts/install/relay.mjs';

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
          supported_extensions: status.supportedExtensions || [],
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
  const relayInspect = join(root, 'relay-inspect.json');
  const relayMembers = join(root, 'relay-members.txt');
  const relayCompose = join(root, 'relay-compose.yml');
  mkdirSync(bin, { recursive: true });
  writeFileSync(token, 'test-token\n', { mode: 0o600 });
  writeFileSync(relayCompose, 'services:\n  relay:\n    image: ghcr.io/block/buzz:sha-test\n');
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
printf '%s\n' "$*" >> "$BUZZ_DKG_DOCKER_LOG"
case "$*" in
  *"ps --format"*)
    test ! -f "$BUZZ_DKG_RELAY_INSPECT" || echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    ;;
  "inspect "*) cat "$BUZZ_DKG_RELAY_INSPECT" ;;
  *"test -x /usr/local/bin/buzz-admin"*)
    test "$BUZZ_DKG_FAKE_BUZZ_ADMIN" = present
    ;;
  *"/usr/local/bin/buzz-admin add-member"*)
    touch "$BUZZ_DKG_RELAY_MEMBERS"
    grep -Fqx "$6" "$BUZZ_DKG_RELAY_MEMBERS" || printf '%s\n' "$6" >> "$BUZZ_DKG_RELAY_MEMBERS"
    ;;
  *"/usr/local/bin/buzz-admin list-members"*) cat "$BUZZ_DKG_RELAY_MEMBERS" ;;
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
  return {
    root,
    bin,
    config,
    state,
    token,
    dockerLog,
    daemonReady,
    relayInspect,
    relayMembers,
    relayCompose,
    buzzAdmin: 'present',
  };
}

function configureBuzzRelay(
  f,
  relayUrl,
  { membershipRequired = true, buzzAdmin = 'present', compose = false } = {},
) {
  f.buzzAdmin = buzzAdmin;
  writeFileSync(
    f.relayInspect,
    JSON.stringify([
      {
        Id: 'a'.repeat(64),
        Name: '/buzz-relay-1',
        Config: {
          Image: 'ghcr.io/block/buzz:sha-test',
          Env: [`RELAY_URL=${relayUrl}`, `BUZZ_REQUIRE_RELAY_MEMBERSHIP=${membershipRequired}`],
          Labels: {
            'com.docker.compose.service': 'relay',
            ...(compose
              ? {
                  'com.docker.compose.project': 'buzz',
                  'com.docker.compose.project.working_dir': f.root,
                  'com.docker.compose.project.config_files': f.relayCompose,
                }
              : {}),
          },
        },
        NetworkSettings: { Ports: {} },
      },
    ]),
  );
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
      BUZZ_DKG_RELAY_INSPECT: f.relayInspect,
      BUZZ_DKG_RELAY_MEMBERS: f.relayMembers,
      BUZZ_DKG_FAKE_BUZZ_ADMIN: f.buzzAdmin,
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

  it('extracts only host-local native management from a real Buzz container', () => {
    expect(
      relayManagementFromContainer({
        Id: 'a'.repeat(64),
        Name: '/buzz-relay-1',
        Config: {
          Image: 'ghcr.io/block/buzz:sha-test',
          Env: ['BUZZ_REQUIRE_RELAY_MEMBERSHIP=true'],
        },
      }),
    ).toEqual({
      containerId: 'a'.repeat(64),
      containerName: 'buzz-relay-1',
      membershipRequired: true,
    });
    expect(
      relayManagementFromContainer({
        Id: 'b'.repeat(64),
        Config: { Image: 'example/generic-relay:latest', Env: [] },
      }),
    ).toBeNull();
  });

  it('extracts validated local Compose metadata for controlled relay updates', () => {
    expect(
      relayManagementFromContainer({
        Id: 'a'.repeat(64),
        Name: '/buzz-relay-1',
        Config: {
          Image: 'ghcr.io/block/buzz:sha-test',
          Env: [],
          Labels: {
            'com.docker.compose.project': 'buzz',
            'com.docker.compose.service': 'relay',
            'com.docker.compose.project.working_dir': '/srv/buzz',
            'com.docker.compose.project.config_files': 'compose.yml,/etc/buzz/secure.yml',
          },
        },
      }),
    ).toMatchObject({
      compose: {
        project: 'buzz',
        service: 'relay',
        workingDir: '/srv/buzz',
        configFiles: ['/srv/buzz/compose.yml', '/etc/buzz/secure.yml'],
      },
    });
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

  it('accepts an explicit operator confirmation for externally enrolled identities', () => {
    expect(parseArgs(['install', '--relay-members-enrolled', '--yes'])).toEqual({
      command: 'install',
      relayMembersEnrolled: true,
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
    expect(runtime).toContain('BDI_QUERY_GATEWAY_ENABLED=true');
    expect(runtime).toContain('BDI_QUERY_GATEWAY_BIND=127.0.0.1');
    expect(runtime).toContain('BDI_QUERY_GATEWAY_PORT=9296');
    expect(runtime).toContain('BDI_QUERY_GATEWAY_MAX_BODY_BYTES=262144');
    expect(runtime).toContain('BDI_QUERY_GATEWAY_TIMEOUT_MS=120000');
    expect(runtime).toContain('BDI_AUTO_PROVISION_CHANNELS=true');
    expect(runtime).toContain('BDI_CONTEXT_GRAPH_ACCESS_POLICY=1');
    expect(runtime).toMatch(/BDI_QUERY_GATEWAY_TOKEN=[0-9a-f]{64}/);
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

  it('configures and bridges a discovered local Compose relay for agent memory', async () => {
    const f = fixture();
    const api = await apiServer('edge', {
      supportedExtensions: ['buzz-dkg-memory-v1'],
    });
    configureBuzzRelay(f, api, { membershipRequired: false, compose: true });
    const result = await runInstaller(f, [
      'install',
      '--relay',
      api,
      '--dkg-api',
      api,
      '--dkg-token-path',
      f.token,
      '--yes',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Agent memory: enabled');
    const override = readFileSync(join(f.config, 'relay.dkg.override.yml'), 'utf8');
    expect(override).toContain('BUZZ_DKG_QUERY_URL: http://127.0.0.1:9297/v1/query');
    expect(override).toMatch(/BUZZ_DKG_QUERY_TOKEN: "[0-9a-f]{64}"/);
    expect(override).toContain('BUZZ_DKG_QUERY_TIMEOUT_MS: "120000"');
    expect(override).toContain('BUZZ_DKG_MEMORY_ENABLED: "true"');
    const dockerCalls = readFileSync(f.dockerLog, 'utf8');
    expect(dockerCalls).toContain(`--project-name buzz --project-directory ${f.root}`);
    expect(dockerCalls).toContain(
      '--profile bridge-relay up -d daemon host-query-bridge relay-query-bridge',
    );
  });

  it('enrolls stable managed identities through the native Buzz admin CLI on a closed relay', async () => {
    const f = fixture();
    const api = await apiServer();
    configureBuzzRelay(f, api);
    const result = await runInstaller(f, [
      'install',
      '--relay',
      api,
      '--dkg-api',
      api,
      '--dkg-token-path',
      f.token,
      '--yes',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("enroll two managed identities with Buzz's native admin CLI");
    const runtime = Object.fromEntries(
      readFileSync(join(f.config, 'runtime.env'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('=')),
    );
    const expectedPubkeys = [runtime.BDI_BUZZ_OWNER_KEY, runtime.BDI_SERVICE_KEY].map((secret) =>
      getPublicKey(Uint8Array.from(Buffer.from(secret, 'hex'))),
    );
    const members = readFileSync(f.relayMembers, 'utf8').trim().split('\n');
    expect(members).toEqual(expectedPubkeys);
    const dockerCalls = readFileSync(f.dockerLog, 'utf8');
    expect(dockerCalls.match(/buzz-admin add-member/g)).toHaveLength(2);
    expect(dockerCalls).toContain('buzz-admin list-members');
    for (const secret of [runtime.BDI_BUZZ_OWNER_KEY, runtime.BDI_SERVICE_KEY]) {
      expect(result.stdout).not.toContain(secret);
      expect(dockerCalls).not.toContain(secret);
    }

    const rerun = await runInstaller(f, [
      'install',
      '--relay',
      api,
      '--dkg-api',
      api,
      '--dkg-token-path',
      f.token,
      '--yes',
    ]);
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(readFileSync(f.relayMembers, 'utf8').trim().split('\n')).toEqual(expectedPubkeys);

    const identityOutput = await runInstaller(f, ['identities']);
    expect(identityOutput.status, identityOutput.stderr).toBe(0);
    expect(identityOutput.stdout).toContain(`DKG channel owner: ${expectedPubkeys[0]}`);
    expect(identityOutput.stdout).toContain(`DKG Memory service: ${expectedPubkeys[1]}`);
    for (const secret of [runtime.BDI_BUZZ_OWNER_KEY, runtime.BDI_SERVICE_KEY]) {
      expect(identityOutput.stdout).not.toContain(secret);
    }
  });

  it('fails closed without native relay administration and supports explicit prior enrollment', async () => {
    const api = await apiServer();
    const blocked = fixture();
    configureBuzzRelay(blocked, api, { buzzAdmin: 'absent' });
    const blockedResult = await runInstaller(blocked, [
      'install',
      '--relay',
      api,
      '--dkg-api',
      api,
      '--dkg-token-path',
      blocked.token,
      '--yes',
    ]);
    expect(blockedResult.status).not.toBe(0);
    expect(blockedResult.stderr).toContain('does not expose /usr/local/bin/buzz-admin');
    expect(readFileSync(blocked.dockerLog, 'utf8')).not.toContain('run --rm bootstrap');

    const enrolled = fixture();
    configureBuzzRelay(enrolled, api, { buzzAdmin: 'absent' });
    const enrolledResult = await runInstaller(enrolled, [
      'install',
      '--relay',
      api,
      '--dkg-api',
      api,
      '--dkg-token-path',
      enrolled.token,
      '--relay-members-enrolled',
      '--yes',
    ]);
    expect(enrolledResult.status, enrolledResult.stderr).toBe(0);
    const dockerCalls = readFileSync(enrolled.dockerLog, 'utf8');
    expect(dockerCalls).not.toContain('buzz-admin add-member');
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
