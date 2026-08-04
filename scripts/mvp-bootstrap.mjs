#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { DkgHttpTransport } from '../src/dkg/http.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(SCRIPT_PATH));
const HEX_64 = /^[0-9a-f]{64}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CG_ID = /^[\w:/.@-]+$/u;
const DEFAULT_TIMEOUT_MS = 30_000;

let redactionValues = [];

function fail(message) {
  throw new Error(message);
}

function required(value, name) {
  if (!value || !String(value).trim()) fail(`missing required ${name}`);
  return String(value).trim();
}

function parseOptions(argv) {
  const out = { command: null, help: false };
  const valueFlags = new Map([
    ['--state-dir', 'stateDir'],
    ['--bindings-path', 'bindingsPath'],
    ['--buzz-http', 'buzzHttp'],
    ['--buzz-cli', 'buzzCli'],
    ['--channel-name', 'channelName'],
    ['--channel-type', 'channelType'],
    ['--channel-visibility', 'channelVisibility'],
    ['--channel-description', 'channelDescription'],
    ['--context-graph-id', 'contextGraphId'],
    ['--dkg-api', 'dkgApi'],
    ['--dkg-token-path', 'dkgTokenPath'],
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    if (!arg.startsWith('-') && out.command === null) {
      out.command = arg;
      continue;
    }
    const key = valueFlags.get(arg);
    if (!key) fail(`unknown argument '${arg}'`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) fail(`${arg} requires a value`);
    out[key] = value;
    i += 1;
  }
  return out;
}

function helpJson() {
  return {
    usage: 'node scripts/mvp-bootstrap.mjs bootstrap [options]',
    options: [
      '--state-dir PATH',
      '--bindings-path PATH',
      '--buzz-http URL',
      '--buzz-cli PATH',
      '--channel-name NAME',
      '--channel-type stream|forum',
      '--channel-visibility open|private',
      '--channel-description TEXT',
      '--context-graph-id ID',
      '--dkg-api URL',
      '--dkg-token-path PATH',
    ],
    secretEnvironment: [
      'BDI_BUZZ_OWNER_KEY (or BUZZ_PRIVATE_KEY)',
      'BDI_SERVICE_KEY',
      'BDI_PROMOTER_KEY (optional; defaults to owner)',
      'BDI_DKG_TOKEN_PATH or BDI_DKG_TOKEN',
      'BDI_BUZZ_AUTH_TAG (optional)',
    ],
  };
}

function pathFrom(value, fallback) {
  return resolve(process.cwd(), value || fallback);
}

export function parseTokenFile(raw) {
  const token = String(raw)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .pop();
  if (!token) fail('DKG token file contains no token');
  return token;
}

function secretBytes(raw, envName) {
  const value = required(raw, envName);
  if (HEX_64.test(value)) return Uint8Array.from(Buffer.from(value, 'hex'));
  if (value.startsWith('nsec1')) {
    try {
      const decoded = nip19.decode(value);
      if (decoded.type === 'nsec' && decoded.data instanceof Uint8Array) return decoded.data;
    } catch {
      // The error below intentionally names only the variable, never its value.
    }
  }
  fail(`${envName} must be a 64-character hex key or nsec`);
}

export function publicKeyFromSecret(raw, envName = 'secret key') {
  return getPublicKey(secretBytes(raw, envName)).toLowerCase();
}

function normalizePublicKey(raw, label) {
  const value = required(raw, label);
  if (HEX_64.test(value)) return value.toLowerCase();
  if (value.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(value);
      if (decoded.type === 'npub' && typeof decoded.data === 'string') {
        return decoded.data.toLowerCase();
      }
    } catch {
      // Fall through to the value-free error below.
    }
  }
  fail(`${label} must be a 64-character hex key or npub`);
}

function validateHttpUrl(raw, name) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`${name} must be a valid URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) fail(`${name} must use http or https`);
  return url.toString().replace(/\/$/, '');
}

export function normalizeRelayOrigin(raw) {
  const url = new URL(validateHttpUrl(raw, 'Buzz relay URL'));
  return url.origin.toLowerCase();
}

export function bindingMappingKey(relayUrl, channelId) {
  if (!UUID.test(channelId)) fail('Buzz channel ID is not a UUID');
  return createHash('sha256')
    .update('buzz-dkg-binding-v1')
    .update('\0')
    .update(normalizeRelayOrigin(relayUrl))
    .update('\0')
    .update(channelId.toLowerCase())
    .digest('hex');
}

export function defaultContextGraphId(relayUrl, channelId) {
  return `buzz-${bindingMappingKey(relayUrl, channelId)}`;
}

function validateContextGraphId(value) {
  const id = required(value, 'context graph ID');
  if (id.length > 256 || !CG_ID.test(id) || id.split('/').some((part) => part.startsWith('_'))) {
    fail('context graph ID is not valid for DKG v10');
  }
  return id;
}

function readJsonIfPresent(path, label) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${label} is not valid JSON: ${path}`);
  }
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${randomBytes(8).toString('hex')}.${process.pid}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}

function validateBinding(binding, index) {
  if (!binding || typeof binding !== 'object') fail(`bindings[${index}] must be an object`);
  const channelId = required(binding.channelId, `bindings[${index}].channelId`);
  if (!UUID.test(channelId)) fail(`bindings[${index}].channelId is not a UUID`);
  const contextGraphId = validateContextGraphId(binding.contextGraphId);
  const promoters = Array.isArray(binding.promoters) ? binding.promoters : [];
  return {
    channelId: channelId.toLowerCase(),
    contextGraphId,
    promoters: [
      ...new Set(
        promoters.map((pubkey, promoterIndex) =>
          normalizePublicKey(pubkey, `bindings[${index}].promoters[${promoterIndex}]`),
        ),
      ),
    ].sort(),
  };
}

export function mergeBinding(rawBindings, desired) {
  if (!Array.isArray(rawBindings)) fail('bindings file must contain a JSON array');
  const normalized = rawBindings.map(validateBinding);
  const seen = new Set();
  for (const binding of normalized) {
    if (seen.has(binding.channelId))
      fail(`bindings file has duplicate channel ${binding.channelId}`);
    seen.add(binding.channelId);
    if (
      binding.contextGraphId === desired.contextGraphId &&
      binding.channelId !== desired.channelId
    ) {
      fail(`context graph '${desired.contextGraphId}' is already bound to another channel`);
    }
  }

  const index = normalized.findIndex((binding) => binding.channelId === desired.channelId);
  if (index >= 0 && normalized[index].contextGraphId !== desired.contextGraphId) {
    fail(`channel '${desired.channelId}' is already bound to a different context graph`);
  }
  if (index >= 0) normalized[index] = validateBinding(desired, index);
  else normalized.push(validateBinding(desired, normalized.length));
  return normalized;
}

function loadConfig(options, env = process.env) {
  const stateDir = pathFrom(options.stateDir ?? env.BDI_MVP_STATE_DIR, join(REPO_ROOT, '.mvp'));
  const dkgTokenPath = options.dkgTokenPath ?? env.BDI_DKG_TOKEN_PATH;
  let dkgToken = env.BDI_DKG_TOKEN;
  if (!dkgToken && dkgTokenPath)
    dkgToken = parseTokenFile(readFileSync(pathFrom(dkgTokenPath), 'utf8'));

  const ownerSecret = required(
    env.BDI_BUZZ_OWNER_KEY ?? env.BUZZ_PRIVATE_KEY,
    'BDI_BUZZ_OWNER_KEY',
  );
  const serviceSecret = required(env.BDI_SERVICE_KEY, 'BDI_SERVICE_KEY');
  const promoterSecret = env.BDI_PROMOTER_KEY || ownerSecret;
  redactionValues = [
    ownerSecret,
    serviceSecret,
    promoterSecret,
    dkgToken,
    env.BDI_BUZZ_AUTH_TAG,
  ].filter(Boolean);
  const ownerPubkey = publicKeyFromSecret(ownerSecret, 'BDI_BUZZ_OWNER_KEY');
  const servicePubkey = publicKeyFromSecret(serviceSecret, 'BDI_SERVICE_KEY');
  const promoterPubkey = publicKeyFromSecret(promoterSecret, 'BDI_PROMOTER_KEY');
  if (ownerPubkey === servicePubkey) {
    fail('BDI_BUZZ_OWNER_KEY and BDI_SERVICE_KEY must identify different users');
  }

  const channelType = options.channelType ?? env.BDI_MVP_CHANNEL_TYPE ?? 'stream';
  const channelVisibility = options.channelVisibility ?? env.BDI_MVP_CHANNEL_VISIBILITY ?? 'open';
  if (!['stream', 'forum'].includes(channelType)) fail('channel type must be stream or forum');
  if (!['open', 'private'].includes(channelVisibility)) {
    fail('channel visibility must be open or private');
  }

  return {
    stateDir,
    statePath: join(stateDir, 'bootstrap.json'),
    bindingsPath: pathFrom(
      options.bindingsPath ?? env.BDI_BINDINGS_PATH,
      join(stateDir, 'bindings.json'),
    ),
    buzzHttp: validateHttpUrl(
      options.buzzHttp ?? env.BDI_BUZZ_HTTP ?? 'http://127.0.0.1:9440',
      'BDI_BUZZ_HTTP',
    ),
    buzzCli: options.buzzCli ?? env.BDI_BUZZ_CLI ?? 'buzz',
    buzzAuthTag: env.BDI_BUZZ_AUTH_TAG,
    ownerSecret,
    ownerPubkey,
    servicePubkey,
    promoterPubkeys: [promoterPubkey],
    channelName: required(
      options.channelName ?? env.BDI_MVP_CHANNEL_NAME ?? 'buzz-dkg-canary',
      'channel name',
    ),
    channelType,
    channelVisibility,
    channelDescription:
      options.channelDescription ??
      env.BDI_MVP_CHANNEL_DESCRIPTION ??
      'Local Buzz + DKG M0 canary channel',
    requestedContextGraphId: options.contextGraphId ?? env.BDI_MVP_CONTEXT_GRAPH_ID,
    dkgApi: validateHttpUrl(
      options.dkgApi ?? env.BDI_DKG_API ?? 'http://127.0.0.1:9200',
      'BDI_DKG_API',
    ),
    dkgToken: required(dkgToken, 'BDI_DKG_TOKEN_PATH or BDI_DKG_TOKEN'),
  };
}

class BuzzCli {
  constructor(config) {
    this.binary = config.buzzCli;
    this.relay = config.buzzHttp;
    this.ownerSecret = config.ownerSecret;
    this.authTag = config.buzzAuthTag;
  }

  async run(args) {
    const childEnv = {};
    for (const key of [
      'PATH',
      'HOME',
      'TMPDIR',
      'NO_PROXY',
      'no_proxy',
      'HTTP_PROXY',
      'http_proxy',
      'HTTPS_PROXY',
      'https_proxy',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
    ]) {
      if (process.env[key]) childEnv[key] = process.env[key];
    }
    childEnv.BUZZ_PRIVATE_KEY = this.ownerSecret;
    if (this.authTag) childEnv.BUZZ_AUTH_TAG = this.authTag;

    let stdout;
    try {
      ({ stdout } = await execFileAsync(
        this.binary,
        ['--relay', this.relay, '--format', 'json', ...args],
        {
          env: childEnv,
          encoding: 'utf8',
          timeout: DEFAULT_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
        },
      ));
    } catch (error) {
      const detail = String(error?.stderr || error?.message || 'Buzz CLI failed').trim();
      fail(`buzz ${args.slice(0, 2).join(' ')} failed: ${detail.slice(0, 500)}`);
    }
    try {
      return JSON.parse(stdout.trim());
    } catch {
      fail(`buzz ${args.slice(0, 2).join(' ')} returned non-JSON output`);
    }
  }

  searchExact(name, includeArchived = false) {
    return this.run([
      'channels',
      'search',
      '--query',
      name,
      '--exact',
      ...(includeArchived ? ['--include-archived'] : []),
    ]);
  }

  getChannel(channelId) {
    return this.run(['channels', 'get', '--channel', channelId]);
  }

  createChannel(config) {
    return this.run([
      'channels',
      'create',
      '--name',
      config.channelName,
      '--type',
      config.channelType,
      '--visibility',
      config.channelVisibility,
      '--description',
      config.channelDescription,
    ]);
  }

  unarchiveChannel(channelId) {
    return this.run(['channels', 'unarchive', '--channel', channelId]);
  }

  members(channelId) {
    return this.run(['channels', 'members', '--channel', channelId]);
  }

  addBot(channelId, servicePubkey) {
    return this.run([
      'channels',
      'add-member',
      '--channel',
      channelId,
      '--pubkey',
      servicePubkey,
      '--role',
      'bot',
    ]);
  }
}

export class DkgHttp extends DkgHttpTransport {
  constructor(config) {
    super({ baseUrl: config.dkgApi, token: config.dkgToken, timeoutMs: DEFAULT_TIMEOUT_MS });
  }

  status() {
    return this.request('GET', '/api/status');
  }

  exists(contextGraphId) {
    return this.request(
      'GET',
      `/api/context-graph/exists?id=${encodeURIComponent(contextGraphId)}`,
    );
  }

  create(contextGraphId, config) {
    return this.request('POST', '/api/context-graph/create', contextGraphCreatePayload(contextGraphId, config));
  }
}

export function contextGraphCreatePayload(contextGraphId, config) {
  return {
    id: contextGraphId,
    name: `Buzz: ${config.channelName}`,
    description: `Local M0 graph for Buzz channel ${config.channelName} (${config.channelId})`,
    accessPolicy: config.channelVisibility === 'private' ? 1 : 0,
    // M0 is strictly off-chain: do not expose either field as ambient config.
    publishPolicy: 0,
    register: false,
  };
}

function writeAccepted(payload, operation) {
  if (!payload || payload.accepted !== true) {
    fail(`${operation} was not accepted by the Buzz relay`);
  }
}

async function poll(fn, predicate, label, attempts = 20, delayMs = 250) {
  let value;
  for (let i = 0; i < attempts; i += 1) {
    value = await fn();
    if (predicate(value)) return value;
    if (i + 1 < attempts) await new Promise((done) => setTimeout(done, delayMs));
  }
  fail(`${label} was not observable after reconciliation`);
}

async function ensureChannel(config, buzz, priorState) {
  if (priorState?.channelId) {
    if (!UUID.test(priorState.channelId)) fail('bootstrap state contains an invalid channelId');
    const channel = await buzz.getChannel(priorState.channelId);
    if (!channel) fail(`state channel '${priorState.channelId}' no longer exists`);
    const summaries = await buzz.searchExact(channel.name, true);
    if (!Array.isArray(summaries)) fail('Buzz channel search returned an unexpected shape');
    const summary = summaries.find(
      (candidate) => candidate.channel_id?.toLowerCase() === priorState.channelId.toLowerCase(),
    );
    if (!summary) fail(`state channel '${priorState.channelId}' was not discoverable by the owner`);
    await ensureChannelShape(config, buzz, summary);
    return { channelId: priorState.channelId.toLowerCase(), action: 'existing' };
  }

  const matches = await buzz.searchExact(config.channelName, true);
  if (!Array.isArray(matches)) fail('Buzz channel search returned an unexpected shape');
  if (matches.length > 1) {
    fail(`more than one Buzz channel is named '${config.channelName}'; refusing an ambiguous bind`);
  }
  if (matches.length === 1) {
    const channel = matches[0];
    if (!UUID.test(channel.channel_id || '')) fail('Buzz channel search returned an invalid ID');
    await ensureChannelShape(config, buzz, channel);
    return { channelId: channel.channel_id.toLowerCase(), action: 'existing' };
  }

  const created = await buzz.createChannel(config);
  writeAccepted(created, 'Buzz channel create');
  if (!UUID.test(created.channel_id || '')) fail('Buzz create did not return a channel UUID');
  const channelId = created.channel_id.toLowerCase();
  await poll(
    () => buzz.getChannel(channelId),
    (channel) => channel && channel.channel_id?.toLowerCase() === channelId,
    'created Buzz channel',
  );
  return { channelId, action: 'created' };
}

async function ensureChannelShape(config, buzz, channel) {
  if (channel.channel_type && channel.channel_type !== config.channelType) {
    fail(
      `existing canary channel has type '${channel.channel_type}', expected '${config.channelType}'`,
    );
  }
  const actualVisibility = channel.visibility === 'public' ? 'open' : channel.visibility;
  if (actualVisibility && actualVisibility !== config.channelVisibility) {
    fail(
      `existing canary channel has visibility '${actualVisibility}', expected '${config.channelVisibility}'`,
    );
  }
  if (!channel.archived) return;
  writeAccepted(await buzz.unarchiveChannel(channel.channel_id), 'Buzz channel unarchive');
  await poll(
    () => buzz.searchExact(channel.name, true),
    (matches) =>
      Array.isArray(matches) &&
      matches.some(
        (candidate) =>
          candidate.channel_id?.toLowerCase() === channel.channel_id.toLowerCase() &&
          candidate.archived === false,
      ),
    'unarchived Buzz channel',
  );
}

async function ensureMembership(buzz, channelId, servicePubkey) {
  const hasBot = (members) =>
    Array.isArray(members) &&
    members.some(
      (member) =>
        String(member.pubkey).toLowerCase() === servicePubkey && String(member.role) === 'bot',
    );
  const current = await buzz.members(channelId);
  if (hasBot(current)) return 'existing';
  writeAccepted(await buzz.addBot(channelId, servicePubkey), 'Buzz bot membership');
  await poll(() => buzz.members(channelId), hasBot, 'Buzz bot membership');
  return 'added';
}

async function ensureContextGraph(dkg, contextGraphId, config) {
  await dkg.status();
  const before = await dkg.exists(contextGraphId);
  if (before?.exists === true) return 'existing';
  if (before?.exists !== false)
    fail('DKG context graph existence probe returned an unexpected shape');
  try {
    await dkg.create(contextGraphId, config);
  } catch (error) {
    if (error?.status !== 409) throw error;
  }
  const after = await dkg.exists(contextGraphId);
  if (after?.exists !== true) fail('DKG context graph create was not visible on read-back');
  return 'created';
}

function validatePriorState(state, desired) {
  if (!state) return;
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    fail('bootstrap state must be a JSON object');
  }
  for (const key of ['ownerPubkey', 'servicePubkey']) {
    if (state[key] && state[key] !== desired[key]) {
      fail(`bootstrap identity drift detected for ${key}`);
    }
  }
  if (
    state.promoterPubkeys &&
    JSON.stringify([...state.promoterPubkeys].sort()) !==
      JSON.stringify([...desired.promoterPubkeys].sort())
  ) {
    fail('bootstrap identity drift detected for promoterPubkeys');
  }
}

export async function bootstrap(config, dependencies = {}) {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const priorState = readJsonIfPresent(config.statePath, 'bootstrap state');
  validatePriorState(priorState, config);
  const oldBindings = readJsonIfPresent(config.bindingsPath, 'bindings file') ?? [];
  if (!Array.isArray(oldBindings)) fail('bindings file must contain a JSON array');
  // Validate the complete existing file before making any external mutation.
  // mergeBinding performs the duplicate-channel check; a harmless sentinel
  // binding is not needed because validation itself is sufficient here.
  const normalizedOldBindings = oldBindings.map(validateBinding);
  const seenChannels = new Set();
  for (const binding of normalizedOldBindings) {
    if (seenChannels.has(binding.channelId)) {
      fail(`bindings file has duplicate channel ${binding.channelId}`);
    }
    seenChannels.add(binding.channelId);
  }

  const buzz = dependencies.buzz ?? new BuzzCli(config);
  const dkg = dependencies.dkg ?? new DkgHttp(config);
  const channel = await ensureChannel(config, buzz, priorState);
  const channelId = channel.channelId;
  const existingBinding = normalizedOldBindings.find((binding) => binding.channelId === channelId);

  const requestedId = config.requestedContextGraphId
    ? validateContextGraphId(config.requestedContextGraphId)
    : null;
  const stateId = priorState?.contextGraphId
    ? validateContextGraphId(priorState.contextGraphId)
    : null;
  if (requestedId && stateId && requestedId !== stateId) {
    fail('requested context graph conflicts with bootstrap state');
  }
  if (existingBinding && stateId && existingBinding.contextGraphId !== stateId) {
    fail('bindings file conflicts with bootstrap state');
  }
  if (existingBinding && requestedId && existingBinding.contextGraphId !== requestedId) {
    fail('requested context graph conflicts with bindings file');
  }

  const contextGraphId = validateContextGraphId(
    stateId ||
      existingBinding?.contextGraphId ||
      requestedId ||
      defaultContextGraphId(config.buzzHttp, channelId),
  );
  const desiredBinding = {
    channelId,
    contextGraphId,
    promoters: [...config.promoterPubkeys].sort(),
  };
  // Detect an imported-binding conflict before adding the service or creating
  // a graph. The returned value is committed only after both read-backs pass.
  const bindings = mergeBinding(oldBindings, desiredBinding);
  const membershipAction = await ensureMembership(buzz, channelId, config.servicePubkey);
  const contextGraphAction = await ensureContextGraph(dkg, contextGraphId, {
    ...config,
    channelId,
  });

  atomicWriteJson(config.bindingsPath, bindings);

  const publicState = {
    channelId,
    contextGraphId,
    ownerPubkey: config.ownerPubkey,
    servicePubkey: config.servicePubkey,
    promoterPubkeys: [...config.promoterPubkeys].sort(),
  };
  atomicWriteJson(config.statePath, publicState);

  return {
    ok: true,
    ...publicState,
    bindingsPath: config.bindingsPath,
    statePath: config.statePath,
    actions: {
      channel: channel.action,
      serviceMembership: membershipAction,
      contextGraph: contextGraphAction,
      bindings: 'written',
    },
  };
}

export function redact(value) {
  let safe = String(value);
  for (const secret of redactionValues) {
    if (secret) safe = safe.split(secret).join('<redacted>');
  }
  return safe;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseOptions(argv);
  if (options.help) {
    process.stdout.write(`${JSON.stringify(helpJson(), null, 2)}\n`);
    return 0;
  }
  if (options.command !== 'bootstrap') fail("expected command 'bootstrap'");
  const config = loadConfig(options, env);
  const result = await bootstrap(config);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: redact(error?.message || error) })}\n`,
    );
    process.exitCode = 1;
  });
}
