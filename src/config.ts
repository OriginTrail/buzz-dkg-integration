import { readFileSync } from 'node:fs';
import type { ChannelBinding, DaemonConfig, PublishMode } from './types.ts';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

/** Last non-comment line — DKG auth.token files carry a comment header. */
export function parseTokenFile(raw: string): string {
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .pop();
  if (!line) throw new Error('token file contains no token');
  return line;
}

/**
 * Channel bindings come from a JSON file (BDI_BINDINGS_PATH):
 *   [{ "channelId": "<uuid>", "contextGraphId": "<cg>", "promoters": ["<hex-pubkey>", ...] }]
 * One Buzz channel ↔ one Context Graph (SPEC §4.3). The daemon never invents
 * mappings; an unmapped channel is rejected everywhere.
 */
export function parseBindings(raw: string): ChannelBinding[] {
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error('bindings file must be a JSON array');
  const seen = new Set<string>();
  return arr.map((b: any, i: number) => {
    if (!b.channelId || !b.contextGraphId) {
      throw new Error(`bindings[${i}]: channelId and contextGraphId are required`);
    }
    if (seen.has(b.channelId)) throw new Error(`bindings[${i}]: duplicate channelId`);
    seen.add(b.channelId);
    return {
      channelId: String(b.channelId),
      contextGraphId: String(b.contextGraphId),
      promoters: Array.isArray(b.promoters) ? b.promoters.map(String) : [],
    };
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const publishMode = (env.BDI_PUBLISH_MODE ?? 'disabled') as PublishMode;
  if (!['disabled', 'devnet'].includes(publishMode)) {
    // 'mainnet' is not a valid value on purpose — that authority arrives with SPEC §0 D3.
    throw new Error(`BDI_PUBLISH_MODE must be 'disabled' or 'devnet', got '${publishMode}'`);
  }
  const dkgToken =
    env.BDI_DKG_TOKEN ?? parseTokenFile(readFileSync(required('BDI_DKG_TOKEN_PATH'), 'utf8'));
  return {
    relayHttpUrl: (env.BDI_BUZZ_HTTP ?? 'http://127.0.0.1:9440').replace(/\/$/, ''),
    relayWsUrl:
      env.BDI_BUZZ_WS ?? (env.BDI_BUZZ_HTTP ?? 'ws://127.0.0.1:9440').replace(/^http/, 'ws'),
    serviceSecretKeyHex: required('BDI_SERVICE_KEY'),
    mentionHandle: env.BDI_MENTION_HANDLE ?? 'dkg',
    dkgApiUrl: (env.BDI_DKG_API ?? 'http://127.0.0.1:9420').replace(/\/$/, ''),
    dkgToken,
    approvalEmoji: env.BDI_APPROVAL_EMOJI ?? '✅',
    publishMode,
    dbPath: env.BDI_DB_PATH ?? './data/daemon.db',
    bindings: parseBindings(readFileSync(required('BDI_BINDINGS_PATH'), 'utf8')),
  };
}
