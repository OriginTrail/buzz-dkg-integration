#!/usr/bin/env node

import { createServer, connect } from 'node:net';
import { fileURLToPath } from 'node:url';

const DEFAULT_BRIDGE_PORT = 9297;
const DEFAULT_GATEWAY_PORT = 9296;
const MAX_CONNECTIONS = 64;
const IDLE_TIMEOUT_MS = 30_000;

function port(name, raw, fallback) {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return value;
}

export function isPrivateIpv4(value) {
  const parts = value.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

export function queryBridgeConfig(env = process.env) {
  const bind = String(env.BDI_QUERY_BRIDGE_BIND || '').trim();
  if (!isPrivateIpv4(bind)) {
    throw new Error('BDI_QUERY_BRIDGE_BIND must be an explicit private IPv4 address');
  }
  const bridgePort = port('BDI_QUERY_BRIDGE_PORT', env.BDI_QUERY_BRIDGE_PORT, DEFAULT_BRIDGE_PORT);
  const gatewayPort = port(
    'BDI_QUERY_GATEWAY_PORT',
    env.BDI_QUERY_GATEWAY_PORT,
    DEFAULT_GATEWAY_PORT,
  );
  if (bridgePort === gatewayPort) {
    throw new Error('bridge and gateway ports must differ');
  }
  return { bind, bridgePort, gatewayPort };
}

export function startQueryBridge(config = queryBridgeConfig()) {
  const server = createServer({ pauseOnConnect: true }, (client) => {
    client.setTimeout(IDLE_TIMEOUT_MS);
    const upstream = connect({ host: '127.0.0.1', port: config.gatewayPort });
    const closeBoth = () => {
      client.destroy();
      upstream.destroy();
    };
    client.once('timeout', closeBoth);
    client.once('error', closeBoth);
    upstream.once('timeout', closeBoth);
    upstream.once('error', closeBoth);
    upstream.once('connect', () => {
      upstream.setTimeout(IDLE_TIMEOUT_MS);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.listen(config.bridgePort, config.bind, () => {
    process.stdout.write(
      `${JSON.stringify({
        level: 'info',
        message: 'query bridge started',
        bind: config.bind,
        port: config.bridgePort,
        target: `127.0.0.1:${config.gatewayPort}`,
      })}\n`,
    );
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = startQueryBridge();
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
