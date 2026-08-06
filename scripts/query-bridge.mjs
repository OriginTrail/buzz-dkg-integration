#!/usr/bin/env node

import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { isAbsolute } from 'node:path';
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

function socketPath(name, raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (!isAbsolute(value) || !value.endsWith('.sock') || Buffer.byteLength(value) > 100) {
    throw new Error(`${name} must be an absolute .sock path of at most 100 bytes`);
  }
  return value;
}

function removeStaleSocket(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isSocket()) {
      throw new Error(`refusing to replace non-socket path: ${path}`);
    }
    unlinkSync(path);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return;
    throw error;
  }
}

export function queryBridgeConfig(env = process.env) {
  const listenSocket = socketPath(
    'BDI_QUERY_BRIDGE_LISTEN_SOCKET',
    env.BDI_QUERY_BRIDGE_LISTEN_SOCKET,
  );
  const targetSocket = socketPath(
    'BDI_QUERY_BRIDGE_TARGET_SOCKET',
    env.BDI_QUERY_BRIDGE_TARGET_SOCKET,
  );
  const bind = String(env.BDI_QUERY_BRIDGE_BIND || '').trim();
  if (listenSocket && bind) {
    throw new Error('configure either BDI_QUERY_BRIDGE_LISTEN_SOCKET or BDI_QUERY_BRIDGE_BIND');
  }
  if (!listenSocket && bind !== '127.0.0.1' && !isPrivateIpv4(bind)) {
    throw new Error('BDI_QUERY_BRIDGE_BIND must be loopback or an explicit private IPv4 address');
  }
  const bridgePort = port('BDI_QUERY_BRIDGE_PORT', env.BDI_QUERY_BRIDGE_PORT, DEFAULT_BRIDGE_PORT);
  const gatewayPort = port(
    'BDI_QUERY_GATEWAY_PORT',
    env.BDI_QUERY_GATEWAY_PORT,
    DEFAULT_GATEWAY_PORT,
  );
  if (!listenSocket && !targetSocket && bridgePort === gatewayPort) {
    throw new Error('bridge and gateway ports must differ');
  }
  return { bind, bridgePort, gatewayPort, listenSocket, targetSocket };
}

export function startQueryBridge(config = queryBridgeConfig()) {
  const server = createServer({ pauseOnConnect: true }, (client) => {
    client.setTimeout(IDLE_TIMEOUT_MS);
    const upstream = config.targetSocket
      ? connect({ path: config.targetSocket })
      : connect({ host: '127.0.0.1', port: config.gatewayPort });
    upstream.setTimeout(IDLE_TIMEOUT_MS);
    const closeBoth = () => {
      client.destroy();
      upstream.destroy();
    };
    client.once('timeout', closeBoth);
    client.once('error', closeBoth);
    upstream.once('timeout', closeBoth);
    upstream.once('error', closeBoth);
    upstream.once('connect', () => {
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
  });
  server.maxConnections = MAX_CONNECTIONS;
  if (config.listenSocket) {
    removeStaleSocket(config.listenSocket);
    server.once('close', () => removeStaleSocket(config.listenSocket));
  }
  const onListening = () => {
    if (config.listenSocket) chmodSync(config.listenSocket, 0o660);
    process.stdout.write(
      `${JSON.stringify({
        level: 'info',
        message: 'query bridge started',
        listen: config.listenSocket || `${config.bind}:${config.bridgePort}`,
        target: config.targetSocket || `127.0.0.1:${config.gatewayPort}`,
      })}\n`,
    );
  };
  if (config.listenSocket) server.listen(config.listenSocket, onListening);
  else server.listen(config.bridgePort, config.bind, onListening);
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = startQueryBridge();
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
