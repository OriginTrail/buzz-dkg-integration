import { connect, createServer } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { isPrivateIpv4, queryBridgeConfig, startQueryBridge } from '../scripts/query-bridge.mjs';

const servers = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
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

test('accepts only explicit RFC1918 bridge binds', () => {
  for (const value of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1']) {
    expect(isPrivateIpv4(value)).toBe(true);
  }
  for (const value of ['', '0.0.0.0', '127.0.0.1', '172.32.0.1', '8.8.8.8', '::1']) {
    expect(isPrivateIpv4(value)).toBe(false);
  }
  expect(() => queryBridgeConfig({})).toThrow(/explicit private IPv4/);
});

test('validates the two bounded and distinct ports', () => {
  expect(queryBridgeConfig({ BDI_QUERY_BRIDGE_BIND: '172.18.0.1' })).toEqual({
    bind: '172.18.0.1',
    bridgePort: 9297,
    gatewayPort: 9296,
  });
  expect(() =>
    queryBridgeConfig({
      BDI_QUERY_BRIDGE_BIND: '172.18.0.1',
      BDI_QUERY_BRIDGE_PORT: '9296',
    }),
  ).toThrow(/must differ/);
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
