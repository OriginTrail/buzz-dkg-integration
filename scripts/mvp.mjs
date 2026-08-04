#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBaseMvpEnvironments,
  buildCredentialedMvpEnvironments,
} from './mvp-env.mjs';
import { createLifecycleLockManager } from './mvp-lock.mjs';
import { createDkgDeploymentRecovery } from './mvp-dkg-recovery.mjs';
import { createMvpDaemonManager } from './mvp-daemon.mjs';
import { startBuzzDependencies } from './mvp-orchestration.mjs';
import { DkgClient } from '../src/dkg/http.mjs';

const EXPECTED_DKG_VERSION = '10.0.11';
const PROJECT = 'buzz-dkg-m0';
const DKG_DOCKER_PREFIX = 'bdi-mvp-dkg';
const BUZZ_HTTP = 'http://127.0.0.1:9440';
const BUZZ_WS = 'ws://127.0.0.1:9440';
const DKG_API = 'http://127.0.0.1:9420';
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const composeFile = join(repo, 'deploy', 'mvp', 'compose.yml');
const stateDir = resolve(process.env.BDI_MVP_STATE_DIR || join(repo, '.mvp'));
const stateOwnerMarker = join(stateDir, '.buzz-dkg-m0-state');
const secretsPath = join(stateDir, 'secrets.env');
const bindingsPath = join(stateDir, 'bindings.json');
const daemonPidPath = join(stateDir, 'daemon.pid');
const daemonLogPath = join(stateDir, 'daemon.log');
const daemonDbPath = join(stateDir, 'daemon.db');
const dkgRepo = resolve(process.env.BDI_MVP_DKG_REPO || join(dirname(repo), 'dkg-v10.0.11'));
const dkgDevnetDir = join(stateDir, 'dkg-devnet');
const dkgOwnerMarker = join(dkgDevnetDir, '.buzz-dkg-m0-owner');
const dkgStoppedMarker = join(dkgDevnetDir, '.buzz-dkg-m0-stopped');
const dkgTokenPath = join(dkgDevnetDir, 'node1', 'auth.token');
const dkgDeploymentPath = join(
  dkgRepo,
  'packages',
  'evm-module',
  'deployments',
  'localhost_contracts.json',
);
// Lifecycle resources are checkout-wide, not state-directory-local: Compose,
// fixed ports, and the sibling deployment artifact remain shared even when a
// caller overrides BDI_MVP_STATE_DIR.
const controlDir = join(repo, '.buzz-dkg-m0-control');
const controlOwnerMarker = join(controlDir, 'owner.json');
const dkgDeploymentBackupPath = join(controlDir, 'dkg-deployment-backup');
const dkgDeploymentBackupMetaPath = join(controlDir, 'dkg-deployment-backup.json');
const lifecycleLockDir = join(controlDir, 'lifecycle-lock');
const lifecycleLockOwnerPath = join(lifecycleLockDir, 'owner.json');
const bootstrapScript = join(repo, 'scripts', 'mvp-bootstrap.mjs');
const smokeScript = join(repo, 'scripts', 'mvp-smoke.mjs');
const dkgNodes = parseNodeCount(process.env.BDI_MVP_DKG_NODES || '1');

function parseNodeCount(raw) {
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 6) {
    throw new Error('BDI_MVP_DKG_NODES must be an integer from 1 through 6');
  }
  return Number(raw);
}

function help() {
  console.log(`buzz-dkg — isolated local Buzz ↔ DKG M0

Usage:
  ./buzz-dkg up       Start dependencies, bootstrap the canary, and start the daemon
  ./buzz-dkg status   Show a sanitized, read-only component summary
  ./buzz-dkg logs     Show recent logs for this M0 stack only
  ./buzz-dkg smoke    Run the synthetic distill → receipt → ask check
  ./buzz-dkg down     Stop this M0 stack; retain secrets, DKG state, and volumes
  ./buzz-dkg unlock   Clear a stale lifecycle lock after verifying no owner or DKG child is alive

Environment overrides:
  BDI_MVP_NODE        Node >=22.13 <23 or >=23.4 executable used by the launcher
  BDI_MVP_STATE_DIR   Runtime state directory (default: ${join(repo, '.mvp')})
  BDI_MVP_DKG_REPO    DKG v10.0.11 checkout (default: ${join(dirname(repo), 'dkg-v10.0.11')})
  BDI_MVP_DKG_NODES   Local DKG node count, 1..6 (default: 1; M0 keeps VM disabled)
  BDI_BUZZ_CLI        Buzz CLI executable used for bootstrap (default: buzz)

Only 127.0.0.1:9440 is published by Docker. DKG uses the isolated Phase 0
ports beginning at API 9420 and Hardhat 8655. No production DKG home is read.`);
}

function fail(message, code = 1) {
  console.error(`buzz-dkg: ${message}`);
  process.exitCode = code;
}

function commandExists(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

export function assertBuzzCliPrerequisite(command = process.env.BDI_BUZZ_CLI || 'buzz') {
  if (!commandExists(command)) {
    throw new Error(`Buzz CLI not found at '${command}'; install it or set BDI_BUZZ_CLI`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repo,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw new Error(`could not run ${command}: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? `: ${(result.stderr || result.stdout || '').trim()}` : '';
    throw new Error(`${command} exited with status ${result.status}${detail}`);
  }
  return result;
}

function ensureRuntimeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const supported = (major === 22 && minor >= 13) || (major === 23 && minor >= 4) || major > 23;
  if (!supported) {
    throw new Error(`Node >=22.13 <23 or >=23.4 is required; running ${process.version}`);
  }
}

function ensureStateDir() {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    atomicWrite(
      stateOwnerMarker,
      `${JSON.stringify({ owner: PROJECT, repo, createdAt: new Date().toISOString() })}\n`,
      0o600,
    );
  }
  assertStateOwnership();
  chmodSync(stateDir, 0o700);
}

function assertStateOwnership() {
  const stateStat = lstatMaybe(stateDir);
  if (!stateStat?.isDirectory() || stateStat.isSymbolicLink()) {
    throw new Error(`M0 state path is not a real directory: ${stateDir}`);
  }
  const markerStat = lstatMaybe(stateOwnerMarker);
  if (!markerStat?.isFile() || markerStat.isSymbolicLink()) {
    throw new Error(
      `refusing unowned state directory ${stateDir}; choose a new empty path or restore its M0 ownership marker`,
    );
  }
  let marker;
  try {
    marker = JSON.parse(readFileSync(stateOwnerMarker, 'utf8'));
  } catch {
    throw new Error(`invalid M0 state ownership marker: ${stateOwnerMarker}`);
  }
  if (marker.owner !== PROJECT || marker.repo !== repo) {
    throw new Error(`M0 state ownership marker does not belong to this checkout: ${stateDir}`);
  }
}

function ensureControlDir() {
  if (!existsSync(controlDir)) {
    mkdirSync(controlDir, { mode: 0o700 });
    atomicWrite(
      controlOwnerMarker,
      `${JSON.stringify({ owner: PROJECT, repo, createdAt: new Date().toISOString() })}\n`,
      0o600,
    );
  }
  assertControlOwnership();
  chmodSync(controlDir, 0o700);
}

function assertControlOwnership() {
  const controlStat = lstatMaybe(controlDir);
  if (!controlStat?.isDirectory() || controlStat.isSymbolicLink()) {
    throw new Error(`M0 control path is not a real directory: ${controlDir}`);
  }
  const markerStat = lstatMaybe(controlOwnerMarker);
  if (!markerStat?.isFile() || markerStat.isSymbolicLink()) {
    throw new Error(`M0 control directory has no valid owner marker: ${controlOwnerMarker}`);
  }
  let marker;
  try {
    marker = JSON.parse(readFileSync(controlOwnerMarker, 'utf8'));
  } catch {
    throw new Error(`invalid M0 control ownership marker: ${controlOwnerMarker}`);
  }
  if (marker.owner !== PROJECT || marker.repo !== repo) {
    throw new Error(`M0 control ownership marker does not belong to this checkout`);
  }
}

function processIdentity(pid) {
  if (!processAlive(pid)) return null;
  const result = run('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
    capture: true,
    allowFailure: true,
  });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

const dkgDeploymentRecovery = createDkgDeploymentRecovery({
  deploymentPath: dkgDeploymentPath,
  backupPath: dkgDeploymentBackupPath,
  metadataPath: dkgDeploymentBackupMetaPath,
  dkgRepo,
  dkgNodes,
  processAlive,
  assertStateOwnership,
  assertControlOwnership,
});
const recoverPendingDkgDeployment = dkgDeploymentRecovery.recover;
const runDevnetStart = dkgDeploymentRecovery.runDevnetStart;

const lifecycleLock = createLifecycleLockManager({
  lockDir: lifecycleLockDir,
  ownerPath: lifecycleLockOwnerPath,
  project: PROJECT,
  repo,
  processAlive,
  processIdentity,
  readRecovery: dkgDeploymentRecovery.readMetadata,
  recover: recoverPendingDkgDeployment,
});

function unlockLifecycle() {
  ensureStateDir();
  ensureControlDir();
  console.log(
    lifecycleLock.unlock()
      ? '[buzz-dkg] stale lifecycle lock cleared'
      : '[buzz-dkg] no stale lifecycle lock found',
  );
}

async function withLifecycleLock(command, action) {
  ensureStateDir();
  ensureControlDir();
  const release = lifecycleLock.acquire(command);
  try {
    // Recovery is deliberately limited to an exclusive lifecycle command.
    // Read-only status/log commands can therefore never interfere with an up.
    recoverPendingDkgDeployment();
    return await action();
  } finally {
    release();
  }
}

function atomicWrite(path, content, mode) {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(temp, content, { encoding: 'utf8', mode, flag: 'wx' });
  chmodSync(temp, mode);
  renameSync(temp, path);
}

function parseSecrets(raw) {
  const parsed = {};
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=([A-Za-z0-9_-]+)$/.exec(trimmed);
    if (!match) throw new Error(`invalid secrets.env syntax on line ${index + 1}`);
    parsed[match[1]] = match[2];
  }
  return parsed;
}

function privateScalar() {
  const order = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
  for (;;) {
    const value = randomBytes(32);
    const number = BigInt(`0x${value.toString('hex')}`);
    if (number > 0n && number < order) return value.toString('hex');
  }
}

function ensureSecrets() {
  ensureStateDir();
  let values = {};
  if (existsSync(secretsPath)) {
    if (!lstatSync(secretsPath).isFile()) throw new Error(`${secretsPath} is not a regular file`);
    values = parseSecrets(readFileSync(secretsPath, 'utf8'));
  }
  const generated = {
    POSTGRES_PASSWORD: () => randomBytes(24).toString('hex'),
    REDIS_PASSWORD: () => randomBytes(24).toString('hex'),
    BUZZ_S3_ACCESS_KEY: () => `m0${randomBytes(8).toString('hex')}`,
    BUZZ_S3_SECRET_KEY: () => randomBytes(32).toString('hex'),
    BDI_SPIKE_RELAY_KEY: privateScalar,
    BDI_SPIKE_AUTHOR_KEY: privateScalar,
    BDI_SPIKE_MEMBER_KEY: privateScalar,
    BDI_SPIKE_SERVICE_KEY: privateScalar,
    BDI_SPIKE_PROMOTER_KEY: privateScalar,
  };
  let changed = !existsSync(secretsPath);
  for (const [name, create] of Object.entries(generated)) {
    if (!values[name]) {
      values[name] = create();
      changed = true;
    }
  }
  if (changed) {
    const body = [
      '# Generated once by buzz-dkg. Never print, share, or commit this file.',
      ...Object.keys(generated).map((name) => `${name}=${values[name]}`),
      '',
    ].join('\n');
    atomicWrite(secretsPath, body, 0o600);
  }
  chmodSync(secretsPath, 0o600);
  return values;
}

function readSecretsIfPresent() {
  if (!existsSync(secretsPath)) return null;
  assertStateOwnership();
  const secrets = parseSecrets(readFileSync(secretsPath, 'utf8'));
  chmodSync(secretsPath, 0o600);
  return secrets;
}

function runtimeEnvironmentInput() {
  const shimDir = ensureNodeShim();
  return {
    base: {
      host: {
        processEnv: process.env,
        nodePath: `${shimDir}:${process.env.PATH || ''}`,
        project: PROJECT,
        stateDir,
        dkgRepo,
      },
      dkg: { dkgDevnetDir, dkgDockerPrefix: DKG_DOCKER_PREFIX, dkgNodes },
    },
    integration: {
      processEnv: process.env,
      dkgTokenPath,
      bindingsPath,
      daemonDbPath,
      buzzHttp: BUZZ_HTTP,
      buzzWs: BUZZ_WS,
      dkgApi: DKG_API,
      buzzCli: process.env.BDI_BUZZ_CLI || 'buzz',
    },
  };
}

function runtimeBaseEnvironments() {
  return buildBaseMvpEnvironments(runtimeEnvironmentInput().base);
}

function runtimeCredentialedEnvironments(secrets) {
  return buildCredentialedMvpEnvironments({ ...runtimeEnvironmentInput(), secrets });
}

function ensureNodeShim() {
  assertStateOwnership();
  const shimDir = join(stateDir, 'bin');
  const shim = join(shimDir, 'node');
  mkdirSync(shimDir, { recursive: true, mode: 0o700 });
  try {
    if (existsSync(shim) || lstatMaybe(shim)) {
      const current = readlinkSync(shim);
      if (resolve(shimDir, current) === resolve(process.execPath)) return shimDir;
      unlinkSync(shim);
    }
  } catch {
    rmSync(shim, { force: true });
  }
  symlinkSync(process.execPath, shim);
  return shimDir;
}

function lstatMaybe(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function composeArgs(...args) {
  return [
    'compose',
    '--project-name',
    PROJECT,
    '--env-file',
    secretsPath,
    '-f',
    composeFile,
    ...args,
  ];
}

function assertPrerequisites() {
  assertBuzzCliPrerequisite();
  if (!commandExists('docker')) throw new Error('Docker is required');
  run('docker', ['info'], { capture: true });
  const devnet = join(dkgRepo, 'scripts', 'devnet.sh');
  const pkgPath = join(dkgRepo, 'package.json');
  if (!existsSync(devnet) || !existsSync(pkgPath)) {
    throw new Error(`DKG checkout not found at ${dkgRepo}; set BDI_MVP_DKG_REPO`);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.version !== EXPECTED_DKG_VERSION) {
    throw new Error(`DKG checkout is ${pkg.version || 'unknown'}; M0 pins ${EXPECTED_DKG_VERSION}`);
  }
  if (!existsSync(bootstrapScript)) {
    throw new Error(
      `missing ${bootstrapScript}; the M0 bootstrap component must be present before up`,
    );
  }
}

function tcpOpen(port, host = '127.0.0.1', timeoutMs = 350) {
  return new Promise((resolveOpen) => {
    const socket = net.createConnection({ port, host });
    const done = (open) => {
      socket.destroy();
      resolveOpen(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function projectContainerIds(all = false) {
  if (!commandExists('docker')) return [];
  const args = ['ps'];
  if (all) args.push('-a');
  args.push('-q', '--filter', `label=com.docker.compose.project=${PROJECT}`);
  const result = run('docker', args, { capture: true, allowFailure: true });
  return result.status === 0 ? result.stdout.trim().split(/\s+/).filter(Boolean) : [];
}

function relayContainerRunning() {
  const result = run(
    'docker',
    [
      'ps',
      '-q',
      '--filter',
      `label=com.docker.compose.project=${PROJECT}`,
      '--filter',
      'label=com.docker.compose.service=relay',
    ],
    { capture: true, allowFailure: true },
  );
  return result.status === 0 && result.stdout.trim() !== '';
}

function dkgReservedPorts() {
  const ports = [8655, 19999];
  for (let i = 0; i < dkgNodes; i += 1) {
    ports.push(9420 + i, 10401 + i);
    if (i < 2) ports.push(7921 + i);
  }
  if (dkgNodes >= 5) ports.push(7931);
  if (dkgNodes >= 6) ports.push(7932);
  return [...new Set(ports)];
}

function inspectDkgOwnership() {
  if (!existsSync(dkgDevnetDir)) return false;
  const entries = readdirSync(dkgDevnetDir);
  if (entries.length === 0) return false;
  const markerStat = lstatMaybe(dkgOwnerMarker);
  if (!markerStat?.isFile() || markerStat.isSymbolicLink()) {
    throw new Error(`refusing to reuse unowned DKG state at ${dkgDevnetDir}`);
  }
  let marker;
  try {
    marker = JSON.parse(readFileSync(dkgOwnerMarker, 'utf8'));
  } catch {
    throw new Error(`invalid DKG ownership marker at ${dkgOwnerMarker}`);
  }
  if (marker.owner !== PROJECT) {
    throw new Error(`DKG ownership marker does not belong to ${PROJECT}: ${dkgOwnerMarker}`);
  }
  return true;
}

function liveDkgPids() {
  const pidFiles = [join(dkgDevnetDir, 'hardhat.pid')];
  for (let i = 1; i <= 6; i += 1) {
    pidFiles.push(
      join(dkgDevnetDir, `node${i}`, 'daemon.pid'),
      join(dkgDevnetDir, `node${i}`, 'devnet.pid'),
    );
  }
  const live = [];
  for (const path of pidFiles) {
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, 'utf8').trim();
    if (/^\d+$/u.test(raw) && processAlive(Number(raw))) live.push(Number(raw));
  }
  return [...new Set(live)];
}

function claimDkgState() {
  assertStateOwnership();
  mkdirSync(dkgDevnetDir, { recursive: true, mode: 0o700 });
  chmodSync(dkgDevnetDir, 0o700);
  if (!existsSync(dkgOwnerMarker)) {
    atomicWrite(
      dkgOwnerMarker,
      `${JSON.stringify({ owner: PROJECT, createdAt: new Date().toISOString() })}\n`,
      0o600,
    );
    markDkgStopped();
  }
}

function markDkgStopped() {
  atomicWrite(
    dkgStoppedMarker,
    `${JSON.stringify({ owner: PROJECT, confirmedAt: new Date().toISOString() })}\n`,
    0o600,
  );
}

function hasDkgStoppedMarker() {
  const markerStat = lstatMaybe(dkgStoppedMarker);
  if (!markerStat) return false;
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new Error(`invalid DKG stopped marker at ${dkgStoppedMarker}`);
  }
  let marker;
  try {
    marker = JSON.parse(readFileSync(dkgStoppedMarker, 'utf8'));
  } catch {
    throw new Error(`invalid DKG stopped marker at ${dkgStoppedMarker}`);
  }
  if (marker.owner !== PROJECT) {
    throw new Error(`DKG stopped marker does not belong to ${PROJECT}: ${dkgStoppedMarker}`);
  }
  return true;
}

async function dkgReservedPortStillOpen() {
  for (const port of dkgReservedPorts()) {
    if (await tcpOpen(port)) return port;
  }
  return null;
}

async function preflightPorts(dkgOwned) {
  if ((await tcpOpen(9440)) && !relayContainerRunning()) {
    throw new Error('port 9440 is already used outside the buzz-dkg-m0 Compose project');
  }
  if (!dkgOwned) {
    for (const port of dkgReservedPorts()) {
      if (await tcpOpen(port)) {
        throw new Error(`DKG M0 port ${port} is already in use; no process was stopped`);
      }
    }
  }
}

async function waitUntil(label, probe, timeoutMs = 120_000, intervalMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  const detail = lastError ? ` (${lastError.message || String(lastError)})` : '';
  throw new Error(`timed out waiting for ${label}${detail}`);
}

async function dkgStatus() {
  return new DkgClient({
    baseUrl: DKG_API,
    token: existsSync(dkgTokenPath) ? readToken() : undefined,
    timeoutMs: 3_000,
  }).status();
}

function validateDkgStatus(status) {
  if (status.version !== EXPECTED_DKG_VERSION) {
    throw new Error(
      `DKG API reports version ${status.version || 'unknown'}, expected ${EXPECTED_DKG_VERSION}`,
    );
  }
  if (status.nodeRole !== 'core')
    throw new Error(`DKG node role is ${status.nodeRole || 'unknown'}, expected core`);
  if (status.chain?.chainId !== 'evm:31337') {
    throw new Error(`DKG chain is ${status.chain?.chainId || 'unknown'}, expected evm:31337`);
  }
  if (status.hasIdentity !== true) throw new Error('DKG node has no local-chain identity');
  return status;
}

function readToken() {
  if (!existsSync(dkgTokenPath)) throw new Error(`DKG token is missing at ${dkgTokenPath}`);
  const token = readFileSync(dkgTokenPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .at(-1);
  if (!token) throw new Error('DKG token file contains no token');
  return token;
}

async function validateContextGraph() {
  const result = await new DkgClient({
    baseUrl: DKG_API,
    token: readToken(),
    timeoutMs: 3_000,
  }).contextGraphExists('devnet-test');
  if (result.exists !== true) throw new Error('DKG context graph devnet-test is absent');
}

function ensureDkgBuild(env) {
  const nativeProbe = [
    "const Database = require('better-sqlite3');",
    "const db = new Database(':memory:');",
    'db.close();',
  ].join('');
  const nativeReady = () =>
    run(process.execPath, ['-e', nativeProbe], {
      // better-sqlite3 is a node-ui workspace dependency, not a root direct
      // dependency, so probe it from the package that actually loads it.
      cwd: join(dkgRepo, 'packages', 'node-ui'),
      env,
      capture: true,
      allowFailure: true,
    }).status === 0;

  if (!existsSync(join(dkgRepo, 'node_modules'))) {
    console.log('[buzz-dkg] installing pinned DKG dependencies');
    run('pnpm', ['install', '--frozen-lockfile'], { cwd: dkgRepo, env });
  } else if (!nativeReady()) {
    console.log(`[buzz-dkg] rebuilding DKG native dependencies for Node ${process.versions.node}`);
    // pnpm 10 can skip this install script when the upstream workspace keeps
    // onlyBuiltDependencies in package.json. npm rebuild invokes the package's
    // installer directly while still using pnpm's linked dependency.
    run('npm', ['rebuild', 'better-sqlite3', '--foreground-scripts'], {
      cwd: dkgRepo,
      env,
    });
  }
  if (!nativeReady()) {
    throw new Error(
      `DKG better-sqlite3 is incompatible with Node ${process.versions.node}; ` +
        'set BDI_MVP_NODE to the Node version used for the DKG checkout and retry',
    );
  }

  const cli = join(dkgRepo, 'packages', 'cli', 'dist', 'cli.js');
  if (existsSync(cli)) return;
  console.log('[buzz-dkg] building the pinned DKG runtime packages');
  run('pnpm', ['run', 'build:runtime:packages'], { cwd: dkgRepo, env });
  if (!existsSync(cli))
    throw new Error('DKG runtime build completed without packages/cli/dist/cli.js');
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const daemonManager = createMvpDaemonManager({
  repo,
  pidPath: daemonPidPath,
  logPath: daemonLogPath,
  bindingsPath,
  processAlive,
  run,
  atomicWrite,
  waitUntil,
  tailText,
});
const readPid = daemonManager.readPid;
const daemonOwned = daemonManager.daemonOwned;
const startDaemon = daemonManager.start;
const stopDaemon = daemonManager.stop;

async function up() {
  ensureRuntimeVersion();
  // Complete all host/tooling preflight before generating secrets or starting
  // any external service, so a missing Buzz CLI cannot leave a partial stack.
  assertPrerequisites();
  const secrets = ensureSecrets();
  const env = runtimeCredentialedEnvironments(secrets);
  const dkgOwned = inspectDkgOwnership();
  await preflightPorts(dkgOwned);
  claimDkgState();

  await startBuzzDependencies({
    prepareDkg: () => ensureDkgBuild(env.dkg),
    startBuzz: () => {
      console.log('[buzz-dkg] starting isolated Buzz dependencies on 127.0.0.1:9440');
      run('docker', composeArgs('up', '-d', 'postgres', 'redis', 'minio', 'minio-init', 'relay'), {
        env: env.compose,
      });
    },
    waitForBuzz: () => waitUntil('Buzz relay', () => tcpOpen(9440), 150_000),
  });

  let status;
  if (await tcpOpen(9420)) {
    status = validateDkgStatus(await dkgStatus());
    await validateContextGraph();
    console.log(`[buzz-dkg] isolated DKG v${EXPECTED_DKG_VERSION} devnet already ready`);
  } else {
    if (!hasDkgStoppedMarker()) {
      throw new Error(
        'the owned DKG API is down but no confirmed-stop marker exists; ' +
          'refusing a destructive devnet restart — run ./buzz-dkg down first',
      );
    }
    const livePids = liveDkgPids();
    if (livePids.length > 0) {
      throw new Error(
        `owned DKG processes are alive but API 9420 is unavailable (PIDs ${livePids.join(', ')}); ` +
          'refusing a destructive devnet restart — inspect logs or run ./buzz-dkg down first',
      );
    }
    const livePort = await dkgReservedPortStillOpen();
    if (livePort !== null) {
      throw new Error(
        `DKG was marked stopped but reserved port ${livePort} is still open; refusing restart`,
      );
    }
    // Consume the one-shot proof before spawning. If startup is interrupted,
    // another `up` cannot wipe partial/live state until an explicit `down`
    // confirms the stack is stopped again.
    unlinkSync(dkgStoppedMarker);
    // A devnet restart rotates its bearer token. Stop the integration first so
    // it cannot retain an obsolete token while the DKG process is replaced.
    await stopDaemon();
    console.log(
      `[buzz-dkg] starting isolated DKG v${EXPECTED_DKG_VERSION} devnet ` +
        `(${dkgNodes} core node${dkgNodes === 1 ? '' : 's'})`,
    );
    await runDevnetStart(env.dkg);
    status = await waitUntil(
      'DKG API identity',
      async () => validateDkgStatus(await dkgStatus()),
      180_000,
      1_000,
    );
    await validateContextGraph();
  }

  console.log('[buzz-dkg] bootstrapping the canary channel and binding');
  run(process.execPath, [bootstrapScript, 'bootstrap'], { env: env.bootstrap });
  await startDaemon(env.daemon);
  console.log(
    `[buzz-dkg] M0 ready — Buzz ${BUZZ_HTTP}; DKG ${DKG_API}; DKG ${status.version}/${status.chain.chainId}`,
  );
}

function containerSummary() {
  if (!commandExists('docker')) return ['Docker: unavailable'];
  const result = run(
    'docker',
    [
      'ps',
      '-a',
      '--filter',
      `label=com.docker.compose.project=${PROJECT}`,
      '--format',
      '{{.Label "com.docker.compose.service"}}\t{{.Status}}',
    ],
    { capture: true, allowFailure: true },
  );
  if (result.status !== 0) return ['Buzz containers: Docker unavailable'];
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean).sort();
  return lines.length ? lines.map((line) => `  ${line}`) : ['  stopped'];
}

async function status() {
  ensureRuntimeVersion();
  console.log('Buzz dependencies:');
  for (const line of containerSummary()) console.log(line);
  console.log(
    `Buzz relay:       ${(await tcpOpen(9440)) ? `reachable at ${BUZZ_HTTP}` : 'stopped'}`,
  );
  try {
    const dkg = await dkgStatus();
    console.log(
      `DKG node:         ${dkg.version || 'unknown'} / ${dkg.nodeRole || 'unknown'} / ${dkg.chain?.chainId || 'unknown'} / identity ${dkg.hasIdentity === true ? 'ready' : 'missing'}`,
    );
  } catch {
    console.log('DKG node:         stopped');
  }
  const pid = readPid();
  console.log(
    `Integration:      ${daemonOwned(pid) ? `running (PID ${pid}, VM disabled)` : 'stopped'}`,
  );
  console.log(`Bootstrap:        ${existsSync(bindingsPath) ? 'binding present' : 'not run'}`);
  console.log(`State:            ${stateDir}`);
  if (existsSync(secretsPath)) {
    const safeMode = (statSync(secretsPath).mode & 0o077) === 0;
    console.log(
      `Secrets:          present (${safeMode ? 'private permissions' : 'WARNING: permissions too broad'})`,
    );
  } else {
    console.log('Secrets:          not generated');
  }
}

function tailText(path, lines = 100) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines);
}

function printLogSection(title, path, lines = 100) {
  console.log(`\n== ${title} ==`);
  const content = tailText(path, lines);
  if (content.length === 0) console.log(`no log at ${path}`);
  else console.log(content.join('\n'));
}

function logs() {
  ensureRuntimeVersion();
  console.log('== Buzz containers (buzz-dkg-m0 only) ==');
  const ids = projectContainerIds(true);
  if (ids.length === 0) console.log('no M0 containers');
  for (const id of ids) run('docker', ['logs', '--tail', '100', id], { allowFailure: true });
  printLogSection('DKG node 1', join(dkgDevnetDir, 'node1', 'daemon.log'));
  printLogSection('Integration daemon', daemonLogPath);
}

async function smoke() {
  ensureRuntimeVersion();
  if (!existsSync(smokeScript)) {
    throw new Error(
      `missing ${smokeScript}; add the M0 smoke component before running this command`,
    );
  }
  const secrets = readSecretsIfPresent();
  if (!secrets) throw new Error('M0 is not initialized; run ./buzz-dkg up first');
  const env = runtimeCredentialedEnvironments(secrets);
  const dkg = validateDkgStatus(await dkgStatus());
  if (!(await tcpOpen(9440)) || !daemonOwned(readPid())) {
    throw new Error('M0 is not fully running; inspect ./buzz-dkg status and ./buzz-dkg logs');
  }
  await validateContextGraph();
  console.log(`[buzz-dkg] smoke preflight: DKG ${dkg.version}/${dkg.chain.chainId}; VM disabled`);
  run(process.execPath, [smokeScript], { env: env.smoke });
}

async function down() {
  ensureRuntimeVersion();
  if (!existsSync(stateDir)) {
    console.log('[buzz-dkg] no M0 state directory; nothing to stop');
    return;
  }
  assertStateOwnership();
  await stopDaemon();
  const secrets = readSecretsIfPresent();
  const baseEnv = runtimeBaseEnvironments();
  const credentialedEnv = secrets ? runtimeCredentialedEnvironments(secrets) : null;
  let dkgStopConfirmed = true;
  if (existsSync(dkgDevnetDir) && inspectDkgOwnership()) {
    if (!existsSync(join(dkgRepo, 'scripts', 'devnet.sh'))) {
      throw new Error(`DKG stop script is missing from ${dkgRepo}`);
    }
    console.log('[buzz-dkg] stopping the M0-owned DKG devnet (state retained)');
    const stopped = run(join(dkgRepo, 'scripts', 'devnet.sh'), ['stop'], {
      cwd: dkgRepo,
      env: baseEnv.dkg,
      allowFailure: true,
    });
    const livePids = liveDkgPids();
    const livePort = await dkgReservedPortStillOpen();
    dkgStopConfirmed = stopped.status === 0 && livePids.length === 0 && livePort === null;
    if (dkgStopConfirmed) markDkgStopped();
    else {
      console.warn(
        `[buzz-dkg] DKG stop could not be confirmed; no restart marker was written` +
          `${livePids.length ? ` (live PIDs ${livePids.join(', ')})` : ''}` +
          `${livePort !== null ? ` (open port ${livePort})` : ''}`,
      );
    }
  }
  if (commandExists('docker') && projectContainerIds(true).length > 0) {
    if (!secrets) {
      throw new Error(
        `cannot safely render the M0 Compose project because ${secretsPath} is missing`,
      );
    }
    console.log('[buzz-dkg] stopping the buzz-dkg-m0 Compose project (volumes retained)');
    run('docker', composeArgs('down', '--remove-orphans'), { env: credentialedEnv.compose });
  }
  if (!dkgStopConfirmed) {
    throw new Error('M0 dependencies stopped, but DKG shutdown was not confirmed; inspect logs');
  }
  console.log('[buzz-dkg] stopped; stable secrets, DKG state, and named volumes were retained');
}

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    help();
    return;
  }
  if (extra.length > 0)
    throw new Error(`unexpected argument(s) for ${command}: ${extra.join(' ')}`);
  switch (command) {
    case 'up':
      // Check the profile's explicit host client before lock/state creation.
      assertBuzzCliPrerequisite();
      await withLifecycleLock(command, up);
      break;
    case 'status':
      await status();
      break;
    case 'logs':
      logs();
      break;
    case 'smoke':
      if (existsSync(stateDir)) await withLifecycleLock(command, smoke);
      else await smoke();
      break;
    case 'down':
      if (existsSync(stateDir)) await withLifecycleLock(command, down);
      else await down();
      break;
    case 'unlock':
      unlockLifecycle();
      break;
    default:
      help();
      throw new Error(`unknown command: ${command}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
