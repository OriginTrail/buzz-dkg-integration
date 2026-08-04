import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getPublicKey } from 'nostr-tools/pure';
import { BuzzClient } from '../../phase0/bridge/lib/nostr.mjs';
import { DkgHttpTransport } from '../../src/dkg/http.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CG_ID = /^[\w:/.@-]+$/u;

function required(value, name) {
  if (!value || !String(value).trim()) throw new Error(`missing required ${name}`);
  return String(value).trim();
}

function keyBytes(hex, name) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`${name} must be a 64-character hex key`);
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`invalid JSON at ${path}`);
  }
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

function parseToken(raw) {
  const token = String(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .at(-1);
  if (!token) throw new Error('DKG token file contains no token');
  return token;
}

function contextGraphIdFor(relayUrl, channelId) {
  return `buzz-${createHash('sha256')
    .update('buzz-dkg-binding-v1\0')
    .update(new URL(relayUrl).origin.toLowerCase())
    .update('\0')
    .update(channelId.toLowerCase())
    .digest('hex')}`;
}

function validateContextGraphId(value) {
  const id = required(value, 'context graph ID');
  if (id.length > 256 || !CG_ID.test(id) || id.split('/').some((part) => part.startsWith('_'))) {
    throw new Error('context graph ID is not valid for DKG v10');
  }
  return id;
}

function mergeBinding(raw, desired) {
  if (!Array.isArray(raw)) throw new Error('bindings file must contain a JSON array');
  const others = raw.filter((binding) => {
    if (!binding?.channelId || !binding?.contextGraphId) throw new Error('invalid existing binding');
    if (binding.contextGraphId === desired.contextGraphId && binding.channelId !== desired.channelId) {
      throw new Error(`Context Graph ${desired.contextGraphId} is already bound to another channel`);
    }
    if (binding.channelId === desired.channelId && binding.contextGraphId !== desired.contextGraphId) {
      throw new Error(`channel ${desired.channelId} is already bound to another Context Graph`);
    }
    return binding.channelId !== desired.channelId;
  });
  return [...others, desired];
}

async function poll(label, fn, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

export class ExistingRelayBuzzAdapter {
  constructor(config) {
    this.owner = new BuzzClient({ baseUrl: config.buzzHttp, secretKeyHex: config.ownerKey });
    this.service = new BuzzClient({ baseUrl: config.buzzHttp, secretKeyHex: config.serviceKey });
  }

  async findChannels(name) {
    const events = await this.owner.query([{ kinds: [39000] }]);
    return events
      .map((event) => ({
        id: event.tags.find((tag) => tag[0] === 'd')?.[1],
        name: event.tags.find((tag) => tag[0] === 'name')?.[1],
      }))
      .filter((channel) => channel.name === name && UUID.test(channel.id || ''));
  }

  async getChannel(channelId) {
    const events = await this.owner.query([{ kinds: [39000], '#d': [channelId], limit: 1 }]);
    const event = events[0];
    if (!event) return null;
    return {
      id: event.tags.find((tag) => tag[0] === 'd')?.[1],
      name: event.tags.find((tag) => tag[0] === 'name')?.[1],
    };
  }

  createChannel(config) {
    return this.owner.publish({
      kind: 9007,
      tags: [
        ['name', config.channelName],
        ['visibility', config.channelVisibility],
        ['channel_type', 'stream'],
        ['about', config.channelDescription],
      ],
      content: '',
    });
  }

  async membership(channelId) {
    const events = await this.owner.query([{ kinds: [39002], '#d': [channelId], limit: 1 }]);
    return events[0] || null;
  }

  addBot(channelId, servicePubkey) {
    return this.owner.addMember(channelId, servicePubkey, 'bot');
  }

  profiles(servicePubkey) {
    return this.service.query([{ kinds: [0], authors: [servicePubkey], limit: 10 }]);
  }

  publishProfile(profile) {
    return this.service.publish({ kind: 0, tags: [], content: JSON.stringify(profile) });
  }
}

export class ExistingRelayDkgAdapter extends DkgHttpTransport {
  status() {
    return this.request('GET', '/api/status');
  }

  exists(id) {
    return this.request('GET', `/api/context-graph/exists?id=${encodeURIComponent(id)}`);
  }

  create(id, config) {
    return this.request('POST', '/api/context-graph/create', {
      id,
      name: `Buzz: ${config.channelName}`,
      description: `Private DKG memory for Buzz channel ${config.channelName} (${config.channelId})`,
      accessPolicy: config.accessPolicy,
      publishPolicy: 0,
      register: false,
    });
  }
}

function accepted(result, operation) {
  const payload = result?.res ?? result;
  if (payload?.accepted !== true) throw new Error(`${operation} rejected: ${payload?.message || 'unknown'}`);
}

async function ensureChannel(config, buzz, prior) {
  if (prior?.channelId) {
    if (!UUID.test(prior.channelId)) throw new Error('bootstrap state has invalid channelId');
    const channel = await buzz.getChannel(prior.channelId);
    if (!channel) throw new Error(`bootstrap channel ${prior.channelId} no longer exists`);
    if (channel.name !== config.channelName) throw new Error('bootstrap channel name drift detected');
    return { channelId: prior.channelId.toLowerCase(), action: 'existing' };
  }
  const matches = await buzz.findChannels(config.channelName);
  if (matches.length > 1) throw new Error(`multiple Buzz channels are named '${config.channelName}'`);
  if (matches.length === 1) return { channelId: matches[0].id.toLowerCase(), action: 'existing' };
  accepted(await buzz.createChannel(config), 'Buzz channel create');
  const discovered = await poll('relay-assigned channel metadata', async () => {
    const found = await buzz.findChannels(config.channelName);
    if (found.length > 1) throw new Error(`multiple Buzz channels are named '${config.channelName}'`);
    return found[0] || null;
  });
  return { channelId: discovered.id.toLowerCase(), action: 'created' };
}

function hasBotMembership(event, servicePubkey) {
  return Boolean(
    event?.tags?.some(
      (tag) =>
        tag[0] === 'p' &&
        String(tag[1]).toLowerCase() === servicePubkey &&
        String(tag[2]).toLowerCase() === 'bot',
    ),
  );
}

async function ensureMembership(buzz, channelId, servicePubkey) {
  if (hasBotMembership(await buzz.membership(channelId), servicePubkey)) return 'existing';
  accepted(await buzz.addBot(channelId, servicePubkey), 'Buzz bot membership');
  await poll('bot-role membership', async () => {
    const membership = await buzz.membership(channelId);
    return hasBotMembership(membership, servicePubkey) ? membership : null;
  });
  return 'added';
}

async function ensureProfile(buzz, servicePubkey, desired) {
  const matches = (await buzz.profiles(servicePubkey)).sort(
    (a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id),
  );
  const parse = (event) => {
    try {
      return event ? JSON.parse(event.content) : null;
    } catch {
      return null;
    }
  };
  const same = (profile) =>
    profile?.name === desired.name &&
    profile?.display_name === desired.display_name &&
    profile?.about === desired.about;
  if (same(parse(matches[0]))) return 'existing';
  accepted(await buzz.publishProfile(desired), 'Buzz service profile');
  await poll('service profile', async () => {
    const profiles = await buzz.profiles(servicePubkey);
    return profiles.some((event) => same(parse(event))) ? true : null;
  });
  return 'published';
}

async function ensureContextGraph(dkg, contextGraphId, config) {
  await dkg.status();
  const before = await dkg.exists(contextGraphId);
  if (before?.exists === true) return 'existing';
  if (before?.exists !== false) throw new Error('DKG Context Graph existence returned an unexpected response');
  try {
    await dkg.create(contextGraphId, config);
  } catch (error) {
    if (error?.status !== 409) throw error;
  }
  const after = await dkg.exists(contextGraphId);
  if (after?.exists !== true) throw new Error('created Context Graph was not visible on read-back');
  return 'created';
}

export async function bootstrapExistingRelay(config, dependencies = {}) {
  const prior = readJson(config.statePath);
  if (prior?.ownerPubkey && prior.ownerPubkey !== config.ownerPubkey) throw new Error('owner identity drift detected');
  if (prior?.servicePubkey && prior.servicePubkey !== config.servicePubkey) throw new Error('service identity drift detected');
  const buzz = dependencies.buzz ?? new ExistingRelayBuzzAdapter(config);
  const dkg = dependencies.dkg ?? new ExistingRelayDkgAdapter({ baseUrl: config.dkgApi, token: config.token });
  const channel = await ensureChannel(config, buzz, prior);
  const channelId = channel.channelId;
  const derivedId = contextGraphIdFor(config.buzzHttp, channelId);
  const contextGraphId = validateContextGraphId(
    prior?.contextGraphId || config.requestedContextGraphId || derivedId,
  );
  if (prior?.contextGraphId && config.requestedContextGraphId && prior.contextGraphId !== config.requestedContextGraphId) {
    throw new Error('requested Context Graph conflicts with bootstrap state');
  }

  const publicState = {
    phase: 'provisional',
    channelId,
    channelName: config.channelName,
    channelVisibility: config.channelVisibility,
    contextGraphId,
    ownerPubkey: config.ownerPubkey,
    servicePubkey: config.servicePubkey,
  };
  // Persist the relay-assigned identity before any later side effect. A crash
  // resumes this record instead of creating a second channel/graph.
  atomicJson(config.statePath, publicState);

  const membershipAction = await ensureMembership(buzz, channelId, config.servicePubkey);
  const profileAction = await ensureProfile(buzz, config.servicePubkey, config.serviceProfile);
  const graphAction = await ensureContextGraph(dkg, contextGraphId, { ...config, channelId });
  const bindings = mergeBinding(readJson(config.bindingsPath) ?? [], {
    channelId,
    contextGraphId,
    promoters: [config.ownerPubkey],
  });
  atomicJson(config.bindingsPath, bindings);
  atomicJson(config.statePath, { ...publicState, phase: 'complete' });

  return {
    ok: true,
    ...publicState,
    phase: 'complete',
    actions: {
      channel: channel.action,
      serviceMembership: membershipAction,
      serviceProfile: profileAction,
      contextGraph: graphAction,
    },
  };
}

export function loadExistingRelayConfig(env = process.env) {
  const runtimeDir = env.BDI_RUNTIME_DIR_IN_CONTAINER || '/runtime';
  const ownerKey = required(env.BDI_BUZZ_OWNER_KEY, 'BDI_BUZZ_OWNER_KEY');
  const serviceKey = required(env.BDI_SERVICE_KEY, 'BDI_SERVICE_KEY');
  const ownerPubkey = getPublicKey(keyBytes(ownerKey, 'BDI_BUZZ_OWNER_KEY'));
  const servicePubkey = getPublicKey(keyBytes(serviceKey, 'BDI_SERVICE_KEY'));
  if (ownerPubkey === servicePubkey) throw new Error('owner and service identities must differ');
  const channelVisibility = env.BDI_CHANNEL_VISIBILITY || 'open';
  if (!['open', 'private'].includes(channelVisibility)) throw new Error('BDI_CHANNEL_VISIBILITY must be open or private');
  const accessPolicyRaw = env.BDI_CONTEXT_GRAPH_ACCESS_POLICY ?? '1';
  if (!/^[01]$/.test(accessPolicyRaw)) {
    throw new Error('BDI_CONTEXT_GRAPH_ACCESS_POLICY must be 0 (public) or 1 (private)');
  }
  const tokenPath = env.BDI_DKG_TOKEN_PATH || '/run/secrets/dkg-auth.token';
  return {
    runtimeDir,
    statePath: join(runtimeDir, 'bootstrap.json'),
    bindingsPath: join(runtimeDir, 'bindings.json'),
    buzzHttp: required(env.BDI_BUZZ_HTTP, 'BDI_BUZZ_HTTP').replace(/\/$/, ''),
    dkgApi: (env.BDI_DKG_API || 'http://127.0.0.1:9200').replace(/\/$/, ''),
    token: parseToken(readFileSync(tokenPath, 'utf8')),
    ownerKey,
    serviceKey,
    ownerPubkey,
    servicePubkey,
    channelName: env.BDI_CHANNEL_NAME || 'Web of Trust',
    channelVisibility,
    channelDescription: env.BDI_CHANNEL_DESCRIPTION || 'Buzz channel with DKG-backed memory',
    requestedContextGraphId: env.BDI_CONTEXT_GRAPH_ID,
    accessPolicy: Number(accessPolicyRaw),
    serviceProfile: {
      name: env.BDI_MENTION_HANDLE || 'dkg',
      display_name: env.BDI_MENTION_DISPLAY_NAME || 'DKG Memory',
      about:
        'OriginTrail DKG memory service for this Buzz community. Mention @dkg distill in a thread to capture it into Shared Working Memory.',
    },
  };
}

export async function runExistingRelayBootstrap(env = process.env) {
  const result = await bootstrapExistingRelay(loadExistingRelayConfig(env));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}
