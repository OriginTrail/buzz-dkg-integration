import { readFileSync } from 'node:fs';
import {
  normalizePublicKey,
  parseBindings as parseSharedBindings,
  parseTokenFile as parseSharedTokenFile,
} from '../scripts/bootstrap/core.mjs';
import type { ChannelBinding, DaemonConfig, PublishMode } from './types.ts';

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
 * One Buzz channel ↔ one Context Graph (SPEC §4.3). The daemon never invents
 * mappings; an unmapped channel is rejected everywhere.
 */
export function parseBindings(raw: string): ChannelBinding[] {
  return parseSharedBindings(raw);
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
  return {
    relayHttpUrl: (env.BDI_BUZZ_HTTP ?? 'http://127.0.0.1:9440').replace(/\/$/, ''),
    relayWsUrl:
      env.BDI_BUZZ_WS ?? (env.BDI_BUZZ_HTTP ?? 'ws://127.0.0.1:9440').replace(/^http/, 'ws'),
    serviceSecretKeyHex: required('BDI_SERVICE_KEY', env),
    mentionHandle: env.BDI_MENTION_HANDLE ?? 'dkg',
    dkgApiUrl: (env.BDI_DKG_API ?? 'http://127.0.0.1:9200').replace(/\/$/, ''),
    dkgToken,
    approvalEmoji: env.BDI_APPROVAL_EMOJI ?? '✅',
    publishMode,
    maxPublishesPerDay,
    dbPath: env.BDI_DB_PATH ?? './data/daemon.db',
    bindings: parseBindings(readFileSync(required('BDI_BINDINGS_PATH', env), 'utf8')),
  };
}
