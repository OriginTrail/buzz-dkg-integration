#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPublicKey } from 'nostr-tools/pure';
import { BuzzClient } from '../../phase0/bridge/lib/nostr.mjs';

const runtimeDir = process.env.BDI_RUNTIME_DIR_IN_CONTAINER || '/runtime';
const statePath = join(runtimeDir, 'bootstrap.json');
const bindingsPath = join(runtimeDir, 'bindings.json');
const tokenPath = process.env.BDI_DKG_TOKEN_PATH || '/run/secrets/dkg-auth.token';
const buzzHttp = required('BDI_BUZZ_HTTP').replace(/\/$/, '');
const dkgApi = (process.env.BDI_DKG_API || 'http://127.0.0.1:9200').replace(/\/$/, '');
const ownerKey = required('BDI_BUZZ_OWNER_KEY');
const serviceKey = required('BDI_SERVICE_KEY');
const channelName = process.env.BDI_CHANNEL_NAME || 'Web of Trust';
const channelVisibility = process.env.BDI_CHANNEL_VISIBILITY || 'open';
const channelDescription =
  process.env.BDI_CHANNEL_DESCRIPTION || 'Buzz channel with DKG-backed memory';

if (!['open', 'private'].includes(channelVisibility)) {
  throw new Error('BDI_CHANNEL_VISIBILITY must be open or private');
}

const keyBytes = (hex, name) => {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`${name} must be a 64-character hex key`);
  return Uint8Array.from(Buffer.from(hex, 'hex'));
};

const ownerPubkey = getPublicKey(keyBytes(ownerKey, 'BDI_BUZZ_OWNER_KEY'));
const servicePubkey = getPublicKey(keyBytes(serviceKey, 'BDI_SERVICE_KEY'));
if (ownerPubkey === servicePubkey) throw new Error('owner and service identities must differ');

const token = readFileSync(tokenPath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .pop();
if (!token) throw new Error('DKG token file contains no token');

const buzz = new BuzzClient({ baseUrl: buzzHttp, secretKeyHex: ownerKey });
const serviceBuzz = new BuzzClient({ baseUrl: buzzHttp, secretKeyHex: serviceKey });
const prior = readJson(statePath);
const channelId = prior?.channelId || randomUUID();
const contextGraphId =
  prior?.contextGraphId ||
  process.env.BDI_CONTEXT_GRAPH_ID ||
  `buzz-${createHash('sha256')
    .update('buzz-dkg-binding-v1\0')
    .update(new URL(buzzHttp).origin.toLowerCase())
    .update('\0')
    .update(channelId.toLowerCase())
    .digest('hex')}`;

const query = (filters) => buzz.query(filters);
const metadata = async () =>
  (await query([{ kinds: [39000], '#d': [channelId], limit: 1 }]))[0] || null;

if (!(await metadata())) {
  const created = await buzz.publish({
    kind: 9007,
    tags: [
      ['h', channelId],
      ['name', channelName],
      ['visibility', channelVisibility],
      ['channel_type', 'stream'],
      ['about', channelDescription],
    ],
    content: '',
  });
  if (!created.res?.accepted) throw new Error(`Buzz channel create rejected: ${created.res?.message}`);
  await waitFor('channel metadata', metadata);
}

const membership = async () =>
  (await query([{ kinds: [39002], '#d': [channelId], limit: 1 }]))[0] || null;
const hasService = (event) =>
  event?.tags?.some((tag) => tag[0] === 'p' && String(tag[1]).toLowerCase() === servicePubkey);

if (!hasService(await membership())) {
  const added = await buzz.publish({
    kind: 9000,
    tags: [
      ['h', channelId],
      ['p', servicePubkey],
      ['role', 'bot'],
    ],
    content: '',
  });
  if (!added.res?.accepted) throw new Error(`Buzz service membership rejected: ${added.res?.message}`);
  await waitFor('service membership', async () => {
    const event = await membership();
    return hasService(event) ? event : null;
  });
}

const desiredServiceProfile = {
  name: process.env.BDI_MENTION_HANDLE || 'dkg',
  display_name: process.env.BDI_MENTION_DISPLAY_NAME || 'DKG Memory',
  about:
    'OriginTrail DKG memory service for this Buzz community. Mention @dkg distill in a thread to capture it into Shared Working Memory.',
};
const serviceProfiles = await serviceBuzz.query([
  { kinds: [0], authors: [servicePubkey], limit: 10 },
]);
serviceProfiles.sort(
  (a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id),
);
let serviceProfileAction = 'existing';
let currentServiceProfile = null;
try {
  currentServiceProfile = serviceProfiles[0]
    ? JSON.parse(serviceProfiles[0].content)
    : null;
} catch {
  // A malformed prior profile is replaced by the managed profile below.
}
if (
  currentServiceProfile?.name !== desiredServiceProfile.name ||
  currentServiceProfile?.display_name !== desiredServiceProfile.display_name ||
  currentServiceProfile?.about !== desiredServiceProfile.about
) {
  const published = await serviceBuzz.publish({
    kind: 0,
    tags: [],
    content: JSON.stringify(desiredServiceProfile),
  });
  if (!published.res?.accepted) {
    throw new Error(`Buzz service profile rejected: ${published.res?.message}`);
  }
  serviceProfileAction = 'published';
}

await dkgRequest('GET', '/api/status');
const exists = await dkgRequest(
  'GET',
  `/api/context-graph/exists?id=${encodeURIComponent(contextGraphId)}`,
);
let contextGraphAction = 'existing';
if (exists?.exists === false) {
  await dkgRequest('POST', '/api/context-graph/create', {
    id: contextGraphId,
    name: `Buzz: ${channelName}`,
    description: `Private DKG memory for Buzz channel ${channelName} (${channelId})`,
    accessPolicy: Number(process.env.BDI_CONTEXT_GRAPH_ACCESS_POLICY || 1),
    publishPolicy: 0,
    register: false,
  });
  const after = await dkgRequest(
    'GET',
    `/api/context-graph/exists?id=${encodeURIComponent(contextGraphId)}`,
  );
  if (after?.exists !== true) throw new Error('created Context Graph was not visible on read-back');
  contextGraphAction = 'created';
} else if (exists?.exists !== true) {
  throw new Error('DKG Context Graph existence route returned an unexpected response');
}

const publicState = {
  channelId,
  channelName,
  channelVisibility,
  contextGraphId,
  ownerPubkey,
  servicePubkey,
};
atomicJson(bindingsPath, [
  { channelId, contextGraphId, promoters: [ownerPubkey] },
]);
atomicJson(statePath, publicState);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    ...publicState,
    actions: {
      serviceProfile: serviceProfileAction,
      contextGraph: contextGraphAction,
    },
  }, null, 2)}\n`,
);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
}

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function atomicJson(path, value) {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

async function waitFor(label, fn) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function dkgRequest(method, path, body) {
  const response = await fetch(`${dkgApi}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { error: 'non-JSON response' };
  }
  if (!response.ok) {
    throw new Error(`DKG ${method} ${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}
