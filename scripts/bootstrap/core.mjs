import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { nip19 } from 'nostr-tools';

const HEX_64 = /^[0-9a-f]{64}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CG_ID = /^[\w:/.@-]+$/u;

export function requiredValue(value, name) {
  if (!value || !String(value).trim()) throw new Error(`missing required ${name}`);
  return String(value).trim();
}

/** Last non-comment line — DKG auth.token files may carry a comment header. */
export function parseTokenFile(raw) {
  const token = String(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .at(-1);
  if (!token) throw new Error('token file contains no token');
  return token;
}

export function normalizePublicKey(raw, label) {
  const value = String(raw).trim();
  if (HEX_64.test(value)) return value.toLowerCase();
  if (value.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(value);
      if (decoded.type === 'npub' && typeof decoded.data === 'string') {
        return decoded.data.toLowerCase();
      }
    } catch {
      // Fall through to the value-limited error below.
    }
  }
  throw new Error(`${label}: '${value.slice(0, 16)}…' is not a 64-hex pubkey or npub1… identity`);
}

export function normalizeRelayOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Buzz relay URL must be a valid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Buzz relay URL must use http or https');
  }
  return url.origin.toLowerCase();
}

export function bindingMappingKey(relayUrl, channelId) {
  if (!UUID.test(channelId)) throw new Error('Buzz channel ID is not a UUID');
  return createHash('sha256')
    .update('buzz-dkg-binding-v1\0')
    .update(normalizeRelayOrigin(relayUrl))
    .update('\0')
    .update(channelId.toLowerCase())
    .digest('hex');
}

export function defaultContextGraphId(relayUrl, channelId) {
  return `buzz-${bindingMappingKey(relayUrl, channelId)}`;
}

export function validateContextGraphId(value) {
  const id = requiredValue(value, 'context graph ID');
  if (id.length > 256 || !CG_ID.test(id) || id.split('/').some((part) => part.startsWith('_'))) {
    throw new Error('context graph ID is not valid for DKG v10');
  }
  return id;
}

export function readJsonFile(path, label = 'JSON file') {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON: ${path}`);
  }
}

export function atomicWriteJson(path, value) {
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

function normalizeBinding(binding, index, strict) {
  if (!binding || typeof binding !== 'object') throw new Error(`bindings[${index}] must be an object`);
  const channelId = requiredValue(binding.channelId, `bindings[${index}].channelId`);
  if (strict && !UUID.test(channelId)) throw new Error(`bindings[${index}].channelId is not a UUID`);
  const contextGraphId = strict
    ? validateContextGraphId(binding.contextGraphId)
    : requiredValue(binding.contextGraphId, `bindings[${index}].contextGraphId`);
  const promoters = Array.isArray(binding.promoters) ? binding.promoters : [];
  return {
    channelId: strict ? channelId.toLowerCase() : channelId,
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

export function parseBindingArray(rawBindings, options = {}) {
  if (!Array.isArray(rawBindings)) throw new Error('bindings file must contain a JSON array');
  const normalized = rawBindings.map((binding, index) =>
    normalizeBinding(binding, index, options.strict === true),
  );
  const seen = new Set();
  for (const [index, binding] of normalized.entries()) {
    if (seen.has(binding.channelId)) throw new Error(`bindings[${index}]: duplicate channelId`);
    seen.add(binding.channelId);
  }
  return normalized;
}

export function parseBindings(raw, options = {}) {
  return parseBindingArray(JSON.parse(raw), options);
}

export function mergeBinding(rawBindings, desired) {
  const normalized = parseBindingArray(rawBindings, { strict: true });
  const normalizedDesired = normalizeBinding(desired, normalized.length, true);
  for (const binding of normalized) {
    if (
      binding.contextGraphId === normalizedDesired.contextGraphId &&
      binding.channelId !== normalizedDesired.channelId
    ) {
      throw new Error(
        `context graph '${normalizedDesired.contextGraphId}' is already bound to another channel`,
      );
    }
  }
  const index = normalized.findIndex(
    (binding) => binding.channelId === normalizedDesired.channelId,
  );
  if (index >= 0 && normalized[index].contextGraphId !== normalizedDesired.contextGraphId) {
    throw new Error(
      `channel '${normalizedDesired.channelId}' is already bound to a different context graph`,
    );
  }
  if (index >= 0) normalized[index] = normalizedDesired;
  else normalized.push(normalizedDesired);
  return normalized;
}

async function ensureContextGraph(dkg, contextGraphId, graphConfig) {
  await dkg.status();
  const before = await dkg.exists(contextGraphId);
  if (before?.exists === true) return 'existing';
  if (before?.exists !== false) {
    throw new Error('DKG Context Graph existence returned an unexpected response');
  }
  try {
    await dkg.create(contextGraphId, graphConfig);
  } catch (error) {
    if (error?.status !== 409) throw error;
  }
  const after = await dkg.exists(contextGraphId);
  if (after?.exists !== true) throw new Error('created Context Graph was not visible on read-back');
  return 'created';
}

/**
 * Shared convergent phase after a profile-specific adapter resolves a channel.
 * Conflicts are checked first, then provisional identity is persisted, then all
 * external mutations are read back before binding/state commit.
 */
export async function reconcileResolvedBootstrap(input) {
  const bindings = mergeBinding(readJsonFile(input.bindingsPath, 'bindings file') ?? [], input.binding);
  atomicWriteJson(input.statePath, input.provisionalState);
  const serviceMembership = await input.ensureMembership();
  const serviceProfile = input.ensureProfile ? await input.ensureProfile() : undefined;
  const contextGraph = await ensureContextGraph(
    input.dkg,
    input.binding.contextGraphId,
    input.graphConfig,
  );
  atomicWriteJson(input.bindingsPath, bindings);
  atomicWriteJson(input.statePath, input.completeState);
  return { serviceMembership, serviceProfile, contextGraph };
}
