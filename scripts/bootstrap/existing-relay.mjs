import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPublicKey } from 'nostr-tools/pure';
import { BuzzClient } from '../../phase0/bridge/lib/nostr.mjs';
import { DkgClient } from '../../src/dkg/http.mjs';
import {
  assertContextGraphBindingAvailable,
  defaultContextGraphId,
  parseTokenFile,
  readJsonFile,
  reconcileResolvedBootstrap,
  validateContextGraphId,
} from './core.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function required(value, name) {
  if (!value || !String(value).trim()) throw new Error(`missing required ${name}`);
  return String(value).trim();
}

function keyBytes(hex, name) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`${name} must be a 64-character hex key`);
  return Uint8Array.from(Buffer.from(hex, 'hex'));
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
        visibility: event.tags.find((tag) => tag[0] === 'visibility')?.[1],
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
      visibility: event.tags.find((tag) => tag[0] === 'visibility')?.[1],
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
    ensureChannelVisibility(config, channel);
    return { channelId: prior.channelId.toLowerCase(), action: 'existing' };
  }
  const matches = await buzz.findChannels(config.channelName);
  if (matches.length > 1) throw new Error(`multiple Buzz channels are named '${config.channelName}'`);
  if (matches.length === 1) {
    ensureChannelVisibility(config, matches[0]);
    return { channelId: matches[0].id.toLowerCase(), action: 'existing' };
  }
  accepted(await buzz.createChannel(config), 'Buzz channel create');
  const discovered = await poll('relay-assigned channel metadata', async () => {
    const found = await buzz.findChannels(config.channelName);
    if (found.length > 1) throw new Error(`multiple Buzz channels are named '${config.channelName}'`);
    return found[0] || null;
  });
  return { channelId: discovered.id.toLowerCase(), action: 'created' };
}

function ensureChannelVisibility(config, channel) {
  const actual = channel.visibility === 'public' ? 'open' : channel.visibility;
  if (actual !== config.channelVisibility) {
    throw new Error(
      `existing Buzz channel has visibility '${actual || 'unknown'}', expected '${config.channelVisibility}'`,
    );
  }
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

export async function bootstrapExistingRelay(config, dependencies = {}) {
  const prior = readJsonFile(config.statePath, 'bootstrap state');
  if (prior?.ownerPubkey && prior.ownerPubkey !== config.ownerPubkey) throw new Error('owner identity drift detected');
  if (prior?.servicePubkey && prior.servicePubkey !== config.servicePubkey) throw new Error('service identity drift detected');
  if (prior?.contextGraphId && config.requestedContextGraphId && prior.contextGraphId !== config.requestedContextGraphId) {
    throw new Error('requested Context Graph conflicts with bootstrap state');
  }
  const existingBindings = readJsonFile(config.bindingsPath, 'bindings file') ?? [];
  const preselectedContextGraphId = prior?.contextGraphId || config.requestedContextGraphId;
  if (preselectedContextGraphId) {
    assertContextGraphBindingAvailable(
      existingBindings,
      preselectedContextGraphId,
      prior?.channelId,
    );
  }
  const buzz = dependencies.buzz ?? new ExistingRelayBuzzAdapter(config);
  const dkg = dependencies.dkg ?? new DkgClient({ baseUrl: config.dkgApi, token: config.token });
  const channel = await ensureChannel(config, buzz, prior);
  const channelId = channel.channelId;
  const derivedId = defaultContextGraphId(config.buzzHttp, channelId);
  const contextGraphId = validateContextGraphId(
    prior?.contextGraphId || config.requestedContextGraphId || derivedId,
  );
  const binding = {
    channelId,
    contextGraphId,
    promoters: [config.ownerPubkey],
  };

  const publicState = {
    phase: 'provisional',
    channelId,
    channelName: config.channelName,
    channelVisibility: config.channelVisibility,
    contextGraphId,
    ownerPubkey: config.ownerPubkey,
    servicePubkey: config.servicePubkey,
  };
  const actions = await reconcileResolvedBootstrap({
    statePath: config.statePath,
    bindingsPath: config.bindingsPath,
    binding,
    provisionalState: publicState,
    completeState: { ...publicState, phase: 'complete' },
    ensureMembership: () => ensureMembership(buzz, channelId, config.servicePubkey),
    ensureProfile: () => ensureProfile(buzz, config.servicePubkey, config.serviceProfile),
    dkg,
    graphPayload: {
      id: contextGraphId,
      name: `Buzz: ${config.channelName}`,
      description: `Private DKG memory for Buzz channel ${config.channelName} (${channelId})`,
      accessPolicy: config.accessPolicy,
      publishPolicy: 0,
      register: false,
    },
  });

  return {
    ok: true,
    ...publicState,
    phase: 'complete',
    actions: {
      channel: channel.action,
      serviceMembership: actions.serviceMembership,
      serviceProfile: actions.serviceProfile,
      contextGraph: actions.contextGraph,
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
    token: parseTokenFile(readFileSync(tokenPath, 'utf8')),
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
