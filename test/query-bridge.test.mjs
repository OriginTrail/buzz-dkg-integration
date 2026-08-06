import { mkdtempSync, rmSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { isPrivateIpv4, queryBridgeConfig, startQueryBridge } from '../scripts/query-bridge.mjs';

const servers = [];
const tempDirs = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

test('accepts only loopback or explicit RFC1918 bridge binds', () => {
  for (const value of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1']) {
    expect(isPrivateIpv4(value)).toBe(true);
  }
  for (const value of ['', '0.0.0.0', '127.0.0.1', '172.32.0.1', '8.8.8.8', '::1']) {
    expect(isPrivateIpv4(value)).toBe(false);
  }
  expect(() => queryBridgeConfig({})).toThrow(/loopback or an explicit private IPv4/);
});

test('validates the two bounded and distinct ports', () => {
  expect(queryBridgeConfig({ BDI_QUERY_BRIDGE_BIND: '172.18.0.1' })).toEqual({
    bind: '172.18.0.1',
    bridgePort: 9297,
    gatewayPort: 9296,
    listenSocket: null,
    targetSocket: null,
  });
  expect(() =>
    queryBridgeConfig({
      BDI_QUERY_BRIDGE_BIND: '172.18.0.1',
      BDI_QUERY_BRIDGE_PORT: '9296',
    }),
  ).toThrow(/must differ/);
});

test('validates Unix socket endpoints and rejects ambiguous listeners', () => {
  expect(
    queryBridgeConfig({
      BDI_QUERY_BRIDGE_LISTEN_SOCKET: '/runtime/query-gateway.sock',
    }),
  ).toMatchObject({
    bind: '',
    listenSocket: '/runtime/query-gateway.sock',
    targetSocket: null,
  });
  expect(
    queryBridgeConfig({
      BDI_QUERY_BRIDGE_BIND: '127.0.0.1',
      BDI_QUERY_BRIDGE_TARGET_SOCKET: '/runtime/query-gateway.sock',
    }),
  ).toMatchObject({
    bind: '127.0.0.1',
    listenSocket: null,
    targetSocket: '/runtime/query-gateway.sock',
  });
  expect(() =>
    queryBridgeConfig({
      BDI_QUERY_BRIDGE_BIND: '127.0.0.1',
      BDI_QUERY_BRIDGE_LISTEN_SOCKET: '/runtime/query-gateway.sock',
    }),
  ).toThrow(/either/);
  expect(() => queryBridgeConfig({ BDI_QUERY_BRIDGE_TARGET_SOCKET: 'relative.sock' })).toThrow(
    /absolute .sock path/,
  );
});

test('forwards bytes to the loopback gateway without interpreting credentials', async () => {
  const upstream = createServer((socket) => socket.pipe(socket));
  servers.push(upstream);
  const upstreamAddress = await listen(upstream);
  const bridge = startQueryBridge({
    bind: '127.0.0.1',
    bridgePort: 0,
    gatewayPort: upstreamAddress.port,
  });
  servers.push(bridge);
  const bridgeAddress = await new Promise((resolve, reject) => {
    bridge.once('error', reject);
    bridge.once('listening', () => resolve(bridge.address()));
  });

  const echoed = await new Promise((resolve, reject) => {
    const socket = connect(bridgeAddress.port, '127.0.0.1');
    socket.once('error', reject);
    socket.once('connect', () => socket.write('opaque-bearer-request'));
    let value = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      value += chunk;
      if (value === 'opaque-bearer-request') {
        socket.end();
        resolve(value);
      }
    });
  });
  expect(echoed).toBe('opaque-bearer-request');
});

test('chains a relay-loopback bridge through a shared Unix socket', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'buzz-dkg-query-bridge-'));
  tempDirs.push(directory);
  const socketPath = join(directory, 'query-gateway.sock');

  const upstream = createServer((socket) => socket.pipe(socket));
  servers.push(upstream);
  const upstreamAddress = await listen(upstream);

  const hostBridge = startQueryBridge({
    bind: '',
    bridgePort: 9297,
    gatewayPort: upstreamAddress.port,
    listenSocket: socketPath,
    targetSocket: null,
  });
  servers.push(hostBridge);
  await new Promise((resolve, reject) => {
    hostBridge.once('error', reject);
    hostBridge.once('listening', resolve);
  });

  const relayBridge = startQueryBridge({
    bind: '127.0.0.1',
    bridgePort: 0,
    gatewayPort: 9296,
    listenSocket: null,
    targetSocket: socketPath,
  });
  servers.push(relayBridge);
  const relayAddress = await new Promise((resolve, reject) => {
    relayBridge.once('error', reject);
    relayBridge.once('listening', () => resolve(relayBridge.address()));
  });

  const echoed = await new Promise((resolve, reject) => {
    const socket = connect(relayAddress.port, '127.0.0.1');
    socket.once('error', reject);
    socket.once('connect', () => socket.write('socket-isolated-request'));
    socket.setEncoding('utf8');
    socket.once('data', (value) => {
      socket.end();
      resolve(value);
    });
  });
  expect(echoed).toBe('socket-isolated-request');
});
