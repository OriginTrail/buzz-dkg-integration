#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const configDir = process.env.BUZZ_DKG_CONFIG_DIR || '/etc/buzz-dkg';
const stateDir = process.env.BUZZ_DKG_STATE_DIR || '/var/lib/buzz-dkg';
const envPath = join(configDir, 'runtime.env');
const composePath = join(appDir, 'deploy', 'v1a', 'compose.yml');
const dkgVersion = process.env.BUZZ_DKG_DKG_VERSION || '10.0.11';
const managedDkgRoot = join(stateDir, 'dkg-cli');
const managedDkgHome = join(stateDir, 'dkg');
const managedDkgBin = join(managedDkgRoot, 'node_modules', '.bin', 'dkg');

function fail(message) {
  throw new Error(message);
}

function executable(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return !result.error;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
    env: options.env || process.env,
  });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? `: ${(result.stderr || result.stdout || '').trim()}` : '';
    fail(`${command} exited with status ${result.status}${detail}`);
  }
  return result;
}

export function parseArgs(argv) {
  const parsed = { command: argv[0] || 'help' };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) fail(`${arg} requires a value`);
      i += 1;
      return next;
    };
    if (arg === '--relay') parsed.relay = value();
    else if (arg === '--dkg-api') parsed.dkgApi = value();
    else if (arg === '--dkg-token-path') parsed.dkgTokenPath = value();
    else if (arg === '--dkg-role') parsed.dkgRole = value();
    else if (arg === '--dkg-network') parsed.dkgNetwork = value();
    else if (arg === '--yes') parsed.yes = true;
    else fail(`unknown argument: ${arg}`);
  }
  if (parsed.dkgRole && !['auto', 'edge', 'core'].includes(parsed.dkgRole)) {
    fail('--dkg-role must be auto, edge, or core');
  }
  return parsed;
}

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) continue;
    values[line.slice(0, at)] = line.slice(at + 1);
  }
  return values;
}

export function relayEndpoints(raw) {
  const parsed = new URL(raw);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    fail(`unsupported Buzz Relay URL protocol: ${parsed.protocol}`);
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

function dockerRelayCandidates() {
  if (!executable('docker')) return [];
  const ids = run('docker', ['ps', '--format', '{{.ID}}'], { capture: true, allowFailure: true });
  if (ids.status !== 0) return [];
  const candidates = [];
  for (const id of ids.stdout.split(/\s+/).filter(Boolean)) {
    const inspected = run('docker', ['inspect', id], { capture: true, allowFailure: true });
    if (inspected.status !== 0) continue;
    let container;
    try {
      container = JSON.parse(inspected.stdout)[0];
    } catch {
      continue;
    }
    const env = Object.fromEntries(
      (container?.Config?.Env || []).map((entry) => {
        const at = entry.indexOf('=');
        return at < 0 ? [entry, ''] : [entry.slice(0, at), entry.slice(at + 1)];
      }),
    );
    const image = String(container?.Config?.Image || '').toLowerCase();
    const service = String(
      container?.Config?.Labels?.['com.docker.compose.service'] || '',
    ).toLowerCase();
    if (!image.includes('buzz') && service !== 'relay' && !env.BUZZ_BIND_ADDR) continue;
    if (env.RELAY_URL) candidates.push(env.RELAY_URL);
  }
  return [...new Set(candidates)];
}

async function probeRelay(httpUrl) {
  const probes = ['/_readiness', '/'];
  let last;
  for (const path of probes) {
    try {
      const response = await fetch(`${httpUrl}${path}`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status < 500) return { status: response.status, path };
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  fail(`Buzz Relay ${httpUrl} is not reachable (${last || 'no response'})`);
}

async function dkgStatus(api) {
  try {
    const response = await fetch(`${api.replace(/\/$/, '')}/api/status`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const status = await response.json();
    if (!['edge', 'core'].includes(status.nodeRole)) return null;
    return status;
  } catch {
    return null;
  }
}

function defaultTokenCandidates() {
  const values = [
    process.env.BDI_DKG_TOKEN_PATH,
    join(managedDkgHome, 'auth.token'),
    join(homedir(), '.dkg', 'auth.token'),
  ];
  if (process.env.SUDO_USER && process.env.SUDO_USER !== 'root') {
    values.push(join('/home', process.env.SUDO_USER, '.dkg', 'auth.token'));
  }
  return values.filter(Boolean);
}

function npmCommand() {
  const bundled = join(appDir, 'runtime', 'bin', 'npm');
  if (existsSync(bundled)) return bundled;
  if (executable('npm')) return 'npm';
  fail('npm is unavailable; reinstall buzz-dkg from an official release bundle');
}

function managedDkgEnv() {
  const runtimeBin = join(appDir, 'runtime', 'bin');
  return {
    ...process.env,
    DKG_HOME: managedDkgHome,
    PATH: `${runtimeBin}:${process.env.PATH || ''}`,
  };
}

async function waitForDkg(api) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const status = await dkgStatus(api);
    if (status) return status;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  fail(`DKG node did not become ready at ${api}`);
}

async function waitForIntegration() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = run('docker', composeArgs('logs', '--no-color', 'daemon'), {
      capture: true,
      allowFailure: true,
    });
    if (result.status === 0 && result.stdout.includes('"message":"daemon started"')) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail('integration daemon did not become ready; run sudo buzz-dkg logs');
}

function composeArgs(command, ...args) {
  return ['compose', '--env-file', envPath, '-f', composePath, command, ...args];
}

function generatedSecrets(prior) {
  return {
    BDI_SERVICE_KEY: prior.BDI_SERVICE_KEY || randomBytes(32).toString('hex'),
    BDI_BUZZ_OWNER_KEY: prior.BDI_BUZZ_OWNER_KEY || randomBytes(32).toString('hex'),
  };
}

function writeRuntimeEnv(values) {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const ordered = [
    'BUZZ_DKG_APP_DIR',
    'BUZZ_DKG_STATE_DIR',
    'BDI_BUZZ_HTTP',
    'BDI_BUZZ_WS',
    'BDI_DKG_API',
    'BDI_DKG_TOKEN_PATH',
    'BDI_DKG_ROLE',
    'BDI_SERVICE_KEY',
    'BDI_BUZZ_OWNER_KEY',
    'BDI_CHANNEL_NAME',
    'BDI_PUBLISH_MODE',
    'BDI_MAX_PUBLISHES_PER_DAY',
  ];
  for (const name of ordered) {
    if (String(values[name] || '').includes('\n')) fail(`${name} contains a newline`);
  }
  writeFileSync(envPath, `${ordered.map((name) => `${name}=${values[name]}`).join('\n')}\n`, {
    mode: 0o600,
  });
  chmodSync(envPath, 0o600);
}

function showPlan(plan) {
  console.log('\nInstallation plan');
  console.log(`  Buzz Relay: ${plan.relay.ws} (adopt in place; no container or database changes)`);
  console.log(
    `  DKG node:   ${plan.dkgExisting ? `reuse ${plan.dkgRole} at ${plan.dkgApi}` : `install ${plan.dkgRole} ${dkgVersion} on ${plan.network}`}`,
  );
  console.log('  Integration: install projector/provider sidecar with VM publication disabled');
  console.log('  Memory:      create or reuse one managed Web of Trust channel and Context Graph');
  console.log(`  State:       ${stateDir}`);
  console.log('  Public ports: none added by the integration');
}

async function resolvePlan(options, prompt) {
  const prior = parseEnvFile(envPath);
  let relayRaw = options.relay || prior.BDI_BUZZ_WS;
  if (!relayRaw) {
    const candidates = dockerRelayCandidates();
    if (candidates.length === 1) {
      relayRaw = candidates[0];
      console.log(`Found Buzz Relay: ${relayRaw}`);
    } else if (candidates.length > 1) {
      console.log(`Found ${candidates.length} possible Buzz Relays:`);
      candidates.forEach((candidate, index) => console.log(`  ${index + 1}. ${candidate}`));
      const selected = await prompt.question('Select the relay number: ');
      relayRaw = candidates[Number(selected) - 1];
      if (!relayRaw) fail('invalid Buzz Relay selection');
    } else if (options.yes) {
      fail('no Buzz Relay was detected; pass --relay <wss-url>');
    } else {
      relayRaw = await prompt.question('Buzz Relay URL (wss://...): ');
    }
  }
  const relay = relayEndpoints(relayRaw);
  await probeRelay(relay.http);

  const dkgApi = (options.dkgApi || prior.BDI_DKG_API || 'http://127.0.0.1:9200').replace(
    /\/$/,
    '',
  );
  const existingStatus = await dkgStatus(dkgApi);
  const requestedRole = options.dkgRole || prior.BDI_DKG_ROLE || 'auto';
  const dkgRole = existingStatus?.nodeRole || (requestedRole === 'auto' ? 'edge' : requestedRole);
  if (existingStatus && requestedRole !== 'auto' && existingStatus.nodeRole !== requestedRole) {
    fail(`DKG node at ${dkgApi} is ${existingStatus.nodeRole}, but ${requestedRole} was requested`);
  }
  const network = options.dkgNetwork || 'mainnet-gnosis';
  return {
    relay,
    dkgApi,
    dkgRole,
    network,
    dkgExisting: Boolean(existingStatus),
    dkgStatus: existingStatus,
  };
}

async function ensureDkg(plan, prompt, options) {
  if (plan.dkgExisting) return plan.dkgStatus;
  if (!options.yes) {
    const answer = (
      await prompt.question(`No DKG node found. Install a managed ${plan.dkgRole} node? [Y/n] `)
    )
      .trim()
      .toLowerCase();
    if (answer && answer !== 'y' && answer !== 'yes')
      fail('installation cancelled before DKG setup');
  }
  mkdirSync(managedDkgRoot, { recursive: true, mode: 0o700 });
  mkdirSync(managedDkgHome, { recursive: true, mode: 0o700 });
  console.log(`Installing @origintrail-official/dkg@${dkgVersion}...`);
  run(
    npmCommand(),
    ['install', '--prefix', managedDkgRoot, `@origintrail-official/dkg@${dkgVersion}`],
    {
      env: managedDkgEnv(),
    },
  );
  console.log('Starting the supported DKG setup wizard...');
  run(managedDkgBin, ['init', '--role', plan.dkgRole, '--network', plan.network], {
    env: managedDkgEnv(),
  });
  run(managedDkgBin, ['start'], { env: managedDkgEnv() });
  return waitForDkg(plan.dkgApi);
}

async function resolveTokenPath(options, prompt) {
  if (options.dkgTokenPath) return options.dkgTokenPath;
  const prior = parseEnvFile(envPath);
  if (prior.BDI_DKG_TOKEN_PATH && existsSync(prior.BDI_DKG_TOKEN_PATH)) {
    return prior.BDI_DKG_TOKEN_PATH;
  }
  const found = defaultTokenCandidates().find((candidate) => existsSync(candidate));
  if (found) return found;
  if (options.yes) fail('DKG auth token was not found; pass --dkg-token-path <path>');
  return prompt.question('DKG auth.token path: ');
}

async function install(options, prompt) {
  if (process.platform !== 'linux' && process.env.BUZZ_DKG_ALLOW_UNSUPPORTED !== '1') {
    fail('Beta V1 supports Linux only');
  }
  if (process.getuid?.() !== 0 && process.env.BUZZ_DKG_ALLOW_NON_ROOT !== '1') {
    fail('run installation with sudo');
  }
  if (!executable('docker')) fail('Docker with the Compose plugin is required');
  const compose = run('docker', ['compose', 'version'], { capture: true, allowFailure: true });
  if (compose.status !== 0) fail('the Docker Compose plugin is required');

  const plan = await resolvePlan(options, prompt);
  showPlan(plan);
  if (!options.yes) {
    const answer = (await prompt.question('\nContinue? [Y/n] ')).trim().toLowerCase();
    if (answer && answer !== 'y' && answer !== 'yes') fail('installation cancelled');
  }
  const status = await ensureDkg(plan, prompt, options);
  const tokenPath = await resolveTokenPath(options, prompt);
  if (!existsSync(tokenPath)) fail(`DKG token does not exist: ${tokenPath}`);
  const prior = parseEnvFile(envPath);
  const secrets = generatedSecrets(prior);
  writeRuntimeEnv({
    BUZZ_DKG_APP_DIR: appDir,
    BUZZ_DKG_STATE_DIR: stateDir,
    BDI_BUZZ_HTTP: plan.relay.http,
    BDI_BUZZ_WS: plan.relay.ws,
    BDI_DKG_API: plan.dkgApi,
    BDI_DKG_TOKEN_PATH: tokenPath,
    BDI_DKG_ROLE: status.nodeRole,
    ...secrets,
    BDI_CHANNEL_NAME: 'Web of Trust',
    BDI_PUBLISH_MODE: 'disabled',
    BDI_MAX_PUBLISHES_PER_DAY: '0',
  });

  console.log('Creating or reusing the Web of Trust channel and Context Graph...');
  run('docker', composeArgs('run', '--rm', 'bootstrap'));
  run('docker', composeArgs('up', '-d', 'daemon'));
  await waitForIntegration();
  console.log('Running the end-to-end smoke check...');
  run('docker', composeArgs('run', '--rm', 'smoke'));
  const bootstrap = JSON.parse(readFileSync(join(stateDir, 'bootstrap.json'), 'utf8'));
  console.log('\nBuzz + DKG is ready.');
  console.log(`  Buzz Relay:   ${plan.relay.ws}`);
  console.log(`  DKG node:     ${status.nodeRole} ${status.version || ''}`.trimEnd());
  console.log(`  Channel:      ${bootstrap.channelName} (${bootstrap.channelId})`);
  console.log(`  Context Graph: ${bootstrap.contextGraphId}`);
  console.log('\nCommands: sudo buzz-dkg status | logs | smoke | remove');
}

async function plan(options, prompt) {
  const resolved = await resolvePlan(options, prompt);
  showPlan(resolved);
}

async function status() {
  const values = parseEnvFile(envPath);
  if (!values.BDI_BUZZ_HTTP) fail(`no V1a installation found at ${envPath}`);
  console.log(`Buzz Relay: ${values.BDI_BUZZ_WS}`);
  await probeRelay(values.BDI_BUZZ_HTTP);
  console.log('  reachable');
  const dkg = await dkgStatus(values.BDI_DKG_API);
  console.log(
    dkg
      ? `DKG node:   ${dkg.nodeRole} ${dkg.version || 'unknown'} (${values.BDI_DKG_API})`
      : `DKG node:   unavailable (${values.BDI_DKG_API})`,
  );
  run('docker', composeArgs('ps'), { allowFailure: true });
  console.log(`State:      ${stateDir}`);
}

function logs() {
  if (!existsSync(envPath)) fail(`no V1a installation found at ${envPath}`);
  run('docker', composeArgs('logs', '--tail', '100', 'daemon'));
}

function smoke() {
  if (!existsSync(envPath)) fail(`no V1a installation found at ${envPath}`);
  run('docker', composeArgs('run', '--rm', 'smoke'));
}

function remove() {
  if (!existsSync(envPath)) fail(`no V1a installation found at ${envPath}`);
  run('docker', composeArgs('down'));
  console.log(
    'Buzz–DKG integration stopped. Buzz and retained integration/DKG data were not removed.',
  );
}

function help() {
  console.log(`buzz-dkg — Buzz-first DKG installer preview

Usage:
  buzz-dkg plan [--relay URL] [--dkg-role auto|edge|core]
  buzz-dkg install [--relay URL] [--dkg-role auto|edge|core]
  buzz-dkg status
  buzz-dkg logs
  buzz-dkg smoke
  buzz-dkg remove

Install adopts a reachable Buzz Relay without replacing its process, identity,
database, URL, or TLS configuration. Verifiable Memory publication stays off.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (options.command === 'install') await install(options, prompt);
    else if (options.command === 'plan') await plan(options, prompt);
    else if (options.command === 'status' || options.command === 'doctor') await status();
    else if (options.command === 'logs') logs();
    else if (options.command === 'smoke') smoke();
    else if (options.command === 'remove') remove();
    else help();
  } catch (error) {
    console.error(`buzz-dkg: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    prompt.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
