import { readFileSync } from 'node:fs';
import {
  normalizePublicKey,
  parseBindings as parseSharedBindings,
  parseTokenFile as parseSharedTokenFile,
} from '../scripts/bootstrap/core.mjs';
import type {
  ChannelBinding,
  CommunityMemoryConfig,
  DaemonConfig,
  MentionLabels,
  PublishMode,
  QueryGatewayConfig,
} from './types.ts';

const CHANNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function required(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

/**
 * Promoter identities are stored and compared as 64-char lowercase hex pubkeys
 * (that is the shape signed events carry). Buzz surfaces identities as `npub1…`,
 * so we accept and decode that form too — a wrong-format promoter would
 * otherwise start the daemon cleanly and silently ignore every approval (a
 * `logger.warn` at best). Fail fast instead.
 */
export function normalizePubkey(raw: string, ctx: string): string {
  return normalizePublicKey(raw, ctx);
}

/** Last non-comment line — DKG auth.token files carry a comment header. */
export function parseTokenFile(raw: string): string {
  return parseSharedTokenFile(raw);
}

/**
 * Channel bindings come from a JSON file (BDI_BINDINGS_PATH):
 *   [{ "channelId": "<uuid>", "contextGraphId": "<cg>", "promoters": ["<hex-pubkey>", ...] }]
 * One Buzz channel ↔ one Context Graph (SPEC §4.3). These are explicit seed
 * mappings; the beta can also provision deterministic mappings on first use.
 */
export function parseBindings(raw: string): ChannelBinding[] {
  return parseSharedBindings(raw);
}

/** Own mention-label cleanup at the config boundary, not in the trigger parser. */
export function normalizeMentionLabels(values: readonly (string | undefined)[]): MentionLabels {
  const labels = [
    ...new Set(
      values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)),
    ),
  ].sort((a, b) => b.length - a.length);
  if (labels.length === 0) throw new Error('at least one non-empty mention label is required');
  return [labels[0]!, ...labels.slice(1)];
}

function envBoolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new Error(`${name} must be true/false or 1/0`);
}

function envInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function loadQueryGatewayConfig(env: NodeJS.ProcessEnv): QueryGatewayConfig {
  if (!envBoolean('BDI_QUERY_GATEWAY_ENABLED', env.BDI_QUERY_GATEWAY_ENABLED, false)) {
    return { enabled: false };
  }
  const bind = env.BDI_QUERY_GATEWAY_BIND || '127.0.0.1';
  if (bind !== '127.0.0.1' && bind !== '::1') {
    throw new Error('BDI_QUERY_GATEWAY_BIND must be the loopback literal 127.0.0.1 or ::1');
  }
  const token = required('BDI_QUERY_GATEWAY_TOKEN', env);
  if (token.length < 32 || token.length > 512) {
    throw new Error('BDI_QUERY_GATEWAY_TOKEN must contain 32 to 512 characters');
  }
  const operationTimeoutMs = envInteger(
    'BDI_QUERY_GATEWAY_TIMEOUT_MS',
    env.BDI_QUERY_GATEWAY_TIMEOUT_MS,
    15_000,
    1_000,
    120_000,
  );
  const dkgTimeoutMs = envInteger(
    'BDI_QUERY_GATEWAY_DKG_TIMEOUT_MS',
    env.BDI_QUERY_GATEWAY_DKG_TIMEOUT_MS,
    5_000,
    500,
    60_000,
  );
  if (dkgTimeoutMs > operationTimeoutMs) {
    throw new Error('BDI_QUERY_GATEWAY_DKG_TIMEOUT_MS must not exceed the operation timeout');
  }
  return {
    enabled: true,
    bind,
    port: envInteger('BDI_QUERY_GATEWAY_PORT', env.BDI_QUERY_GATEWAY_PORT, 9296, 1, 65_535),
    token,
    maxBodyBytes: envInteger(
      'BDI_QUERY_GATEWAY_MAX_BODY_BYTES',
      env.BDI_QUERY_GATEWAY_MAX_BODY_BYTES,
      256 * 1024,
      1_024,
      1024 * 1024,
    ),
    maxResultBytes: envInteger(
      'BDI_QUERY_GATEWAY_MAX_RESULT_BYTES',
      env.BDI_QUERY_GATEWAY_MAX_RESULT_BYTES,
      8 * 1024 * 1024,
      64 * 1024,
      8 * 1024 * 1024,
    ),
    maxQueryBytes: envInteger(
      'BDI_QUERY_GATEWAY_MAX_QUERY_BYTES',
      env.BDI_QUERY_GATEWAY_MAX_QUERY_BYTES,
      8 * 1024,
      512,
      32 * 1024,
    ),
    operationTimeoutMs,
    dkgTimeoutMs,
    maxConcurrent: envInteger(
      'BDI_QUERY_GATEWAY_MAX_CONCURRENT',
      env.BDI_QUERY_GATEWAY_MAX_CONCURRENT,
      4,
      1,
      32,
    ),
    maxDkgConcurrent: envInteger(
      'BDI_QUERY_GATEWAY_MAX_DKG_CONCURRENT',
      env.BDI_QUERY_GATEWAY_MAX_DKG_CONCURRENT,
      1,
      1,
      8,
    ),
    maxDkgQueue: envInteger(
      'BDI_QUERY_GATEWAY_MAX_DKG_QUEUE',
      env.BDI_QUERY_GATEWAY_MAX_DKG_QUEUE,
      32,
      1,
      256,
    ),
    cacheTtlMs: envInteger(
      'BDI_QUERY_GATEWAY_CACHE_TTL_MS',
      env.BDI_QUERY_GATEWAY_CACHE_TTL_MS,
      120_000,
      0,
      300_000,
    ),
    maxCacheEntries: envInteger(
      'BDI_QUERY_GATEWAY_MAX_CACHE_ENTRIES',
      env.BDI_QUERY_GATEWAY_MAX_CACHE_ENTRIES,
      256,
      1,
      4_096,
    ),
  };
}

export function loadCommunityMemoryConfig(env: NodeJS.ProcessEnv): CommunityMemoryConfig {
  if (!envBoolean('BDI_COMMUNITY_MEMORY_ENABLED', env.BDI_COMMUNITY_MEMORY_ENABLED, false)) {
    return { enabled: false };
  }
  const endpoint = required('BDI_COMMUNITY_MEMORY_ENDPOINT', env);
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new Error('BDI_COMMUNITY_MEMORY_ENDPOINT must be an absolute URL');
  }
  if (!['http:', 'https:'].includes(parsedEndpoint.protocol)) {
    throw new Error('BDI_COMMUNITY_MEMORY_ENDPOINT must use HTTP or HTTPS');
  }
  const rawChannels = required('BDI_COMMUNITY_MEMORY_CHANNELS', env).trim();
  let channels: '*' | string[];
  if (rawChannels === '*') {
    channels = '*';
  } else {
    channels = [
      ...new Set(
        rawChannels
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    if (channels.length === 0 || channels.some((channel) => !CHANNEL_ID.test(channel))) {
      throw new Error('BDI_COMMUNITY_MEMORY_CHANNELS must be * or comma-separated channel UUIDs');
    }
  }
  return {
    enabled: true,
    endpoint: parsedEndpoint.toString(),
    apiKey: required('BDI_COMMUNITY_MEMORY_API_KEY', env),
    model: required('BDI_COMMUNITY_MEMORY_MODEL', env),
    channels,
    debounceMs: envInteger(
      'BDI_COMMUNITY_MEMORY_DEBOUNCE_MS',
      env.BDI_COMMUNITY_MEMORY_DEBOUNCE_MS,
      30_000,
      1_000,
      15 * 60_000,
    ),
    maxEvents: envInteger(
      'BDI_COMMUNITY_MEMORY_MAX_EVENTS',
      env.BDI_COMMUNITY_MEMORY_MAX_EVENTS,
      12,
      1,
      16,
    ),
    maxInputChars: envInteger(
      'BDI_COMMUNITY_MEMORY_MAX_INPUT_CHARS',
      env.BDI_COMMUNITY_MEMORY_MAX_INPUT_CHARS,
      32_768,
      1_024,
      131_072,
    ),
    requestTimeoutMs: envInteger(
      'BDI_COMMUNITY_MEMORY_TIMEOUT_MS',
      env.BDI_COMMUNITY_MEMORY_TIMEOUT_MS,
      60_000,
      1_000,
      180_000,
    ),
    retryBaseMs: envInteger(
      'BDI_COMMUNITY_MEMORY_RETRY_BASE_MS',
      env.BDI_COMMUNITY_MEMORY_RETRY_BASE_MS,
      30_000,
      1_000,
      15 * 60_000,
    ),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const publishMode = (env.BDI_PUBLISH_MODE ?? 'disabled') as PublishMode;
  if (!['disabled', 'devnet', 'mainnet'].includes(publishMode)) {
    throw new Error(
      `BDI_PUBLISH_MODE must be 'disabled', 'devnet' or 'mainnet', got '${publishMode}'`,
    );
  }
  const dkgToken =
    env.BDI_DKG_TOKEN ?? parseTokenFile(readFileSync(required('BDI_DKG_TOKEN_PATH', env), 'utf8'));
  // The publication budget is the only ceiling on real ETH spend. A bare
  // Number('unlimited') is NaN, and `recent >= NaN` is always false — which
  // would silently remove the ceiling. Fail closed, like publishMode does.
  const maxPublishesPerDay = Number(env.BDI_MAX_PUBLISHES_PER_DAY ?? 5);
  if (!Number.isFinite(maxPublishesPerDay) || maxPublishesPerDay < 0) {
    throw new Error(
      `BDI_MAX_PUBLISHES_PER_DAY must be a non-negative number, got '${env.BDI_MAX_PUBLISHES_PER_DAY}'`,
    );
  }
  const mentionHandle = env.BDI_MENTION_HANDLE?.trim() || 'dkg';
  const mentionDisplayName = env.BDI_MENTION_DISPLAY_NAME?.trim();
  const mentionLabels = normalizeMentionLabels([mentionHandle, mentionDisplayName]);
  return {
    relayHttpUrl: (env.BDI_BUZZ_HTTP ?? 'http://127.0.0.1:9440').replace(/\/$/, ''),
    relayWsUrl:
      env.BDI_BUZZ_WS ?? (env.BDI_BUZZ_HTTP ?? 'ws://127.0.0.1:9440').replace(/^http/, 'ws'),
    serviceSecretKeyHex: required('BDI_SERVICE_KEY', env),
    mentionLabels,
    dkgApiUrl: (env.BDI_DKG_API ?? 'http://127.0.0.1:9200').replace(/\/$/, ''),
    dkgToken,
    approvalEmoji: env.BDI_APPROVAL_EMOJI ?? '✅',
    publishMode,
    maxPublishesPerDay,
    dbPath: env.BDI_DB_PATH ?? './data/daemon.db',
    bindings: parseBindings(readFileSync(required('BDI_BINDINGS_PATH', env), 'utf8')),
    autoProvisionChannels: envBoolean(
      'BDI_AUTO_PROVISION_CHANNELS',
      env.BDI_AUTO_PROVISION_CHANNELS,
      false,
    ),
    contextGraphAccessPolicy: envInteger(
      'BDI_CONTEXT_GRAPH_ACCESS_POLICY',
      env.BDI_CONTEXT_GRAPH_ACCESS_POLICY,
      1,
      0,
      2,
    ),
    queryGateway: loadQueryGatewayConfig(env),
    communityMemory: loadCommunityMemoryConfig(env),
  };
}
