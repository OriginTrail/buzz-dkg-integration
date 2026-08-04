// POLLEN-4 run harness core: fresh channels, disposable agents, native
// token-metric collection (kind 44200, NIP-44 to the run's metrics owner).
// Key material never leaves this process (spawn env objects, no shell).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { v2 as nip44 } from 'nostr-tools/nip44';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

const { BuzzClient } = await import('../../phase0/bridge/lib/nostr.mjs');

export const BASE = 'https://macbook-pro-8.tailb02f7e.ts.net';
export const WS = 'wss://macbook-pro-8.tailb02f7e.ts.net';
const ACP_BIN = `${homedir()}/code/upstream-pins/buzz/desktop/src-tauri/binaries/buzz-acp-aarch64-apple-darwin`;

const opSk = nip19.decode(readFileSync(`${homedir()}/Library/Application Support/xyz.block.buzz.app/identity.key`, 'utf8').trim()).data;
export const operator = new BuzzClient({ baseUrl: BASE, secretKeyHex: Buffer.from(opSk).toString('hex') });

/** Create a fresh channel; returns channel id parsed from the relay OK payload. */
export async function createRunChannel(name) {
  const { res } = await operator.publish({ kind: 9007, tags: [['name', name]], content: '' });
  const m = /\{.*\}/.exec(res?.message ?? '');
  if (m) { const j = JSON.parse(m[0]); if (j.channel_id ?? j.group_id) return j.channel_id ?? j.group_id; }
  // fallback: newest 39000 with our name
  await new Promise((r) => setTimeout(r, 1500));
  const metas = await operator.query([{ kinds: [39000], limit: 10 }]);
  for (const ev of metas.sort((a, b) => b.created_at - a.created_at)) {
    if (ev.tags.some((t) => t[0] === 'name' && t[1] === name)) return ev.tags.find((t) => t[0] === 'd')?.[1];
  }
  throw new Error(`channel id not found for ${name}: ${JSON.stringify(res).slice(0, 200)}`);
}

export async function addMember(channelId, pubkey) {
  await operator.publish({ kind: 9000, tags: [['h', channelId], ['p', pubkey]], content: '' });
}

/** NIP-43 relay membership — required for GLOBAL events (e.g. kind-44200
 * turn metrics); channel membership alone only covers h-scoped kinds. */
export async function addRelayMember(pubkey) {
  await operator.publish({ kind: 9030, tags: [['p', pubkey]], content: '' });
}

/** NIP-OA auth tag: owner attests the agent. Preimage per buzz-sdk nip_oa:
 * "nostr:agent-auth:<agent_pubkey_hex>:<conditions>", sha256, BIP-340. The
 * relay materializes the (agent -> owner) registration from this tag on the
 * agent's first authed request — required for kind-44200 turn metrics. */
export function computeAuthTag(ownerSk, agentPubkey, conditions = '') {
  const ownerPk = getPublicKey(ownerSk);
  const preimage = `nostr:agent-auth:${agentPubkey}:${conditions}`;
  const digest = sha256(new TextEncoder().encode(preimage));
  const sig = Buffer.from(schnorr.sign(digest, ownerSk)).toString('hex');
  return JSON.stringify(['auth', ownerPk, conditions, sig]);
}

/** Mint a disposable agent identity. */
export function mintAgent(label) {
  const sk = generateSecretKey();
  return { label, sk, pubkey: getPublicKey(sk), nsec: nip19.nsecEncode(sk) };
}

/**
 * Spawn a disposable buzz-acp agent bound to one channel.
 * regime='CG' agents get the scoped query tool via MCP later; for now both
 * arms share the base spawn — arm-specific context is injected via channel
 * seeding and system prompt.
 */
export function spawnAgent({ agent, channelId, ownerPubkey, ownerSk, systemPrompt, extraEnv = {} }) {
  const env = {
    ...process.env,
    PATH: `${homedir()}/.local/bin:${process.env.PATH}`,
    BUZZ_RELAY_URL: WS,
    BUZZ_PRIVATE_KEY: agent.nsec,
    BUZZ_ACP_AGENT_OWNER: ownerPubkey,
    ...(ownerSk ? { BUZZ_AUTH_TAG: computeAuthTag(ownerSk, agent.pubkey) } : {}),
    BUZZ_ACP_AGENT_COMMAND: `${homedir()}/buzz-dkg-integration/ab-experiment/harness/claude-acp-usage-shim.mjs`,
    BUZZ_ACP_CHANNELS: channelId,
    BUZZ_ACP_SYSTEM_PROMPT: systemPrompt,
    BUZZ_ACP_AGENTS: '1',
    SHIM_DEBUG: process.env.SHIM_DEBUG ?? '',
    ...extraEnv,
  };
  const child = spawn(ACP_BIN, ['--respond-to', 'anyone', '--no-mention-filter'], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  return { child, logs, agent };
}

/** Collect + decrypt kind-44200 turn metrics authored by the given agents.
 * 44200 is p-gated: the query must be signed by the p-tagged owner and carry
 * a #p filter matching that pubkey. */
export async function collectMetrics({ ownerSk, agentPubkeys, since }) {
  const ownerPk = getPublicKey(ownerSk);
  const ownerClient = new BuzzClient({ baseUrl: BASE, secretKeyHex: Buffer.from(ownerSk).toString('hex') });
  const evs = await ownerClient.query([{ kinds: [44200], authors: agentPubkeys, '#p': [ownerPk], since, limit: 500 }]);
  const out = [];
  for (const ev of evs) {
    try {
      const ck = nip44.utils.getConversationKey(ownerSk, ev.pubkey);
      const payload = JSON.parse(nip44.decrypt(ev.content, ck));
      out.push({ agent: ev.pubkey, at: ev.created_at, ...payload });
    } catch (e) { out.push({ agent: ev.pubkey, at: ev.created_at, decryptError: String(e).slice(0, 80) }); }
  }
  return out;
}

export async function sendToChannel(channelId, text, mentions = []) {
  return operator.sendMessage(channelId, text, mentions.length ? { mentions } : undefined);
}

export async function channelMessages(channelId, since) {
  const evs = await operator.query([{ kinds: [9], '#h': [channelId], since, limit: 200 }]);
  return evs.sort((a, b) => a.created_at - b.created_at);
}
