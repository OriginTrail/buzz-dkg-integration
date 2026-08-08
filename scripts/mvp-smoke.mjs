#!/usr/bin/env node

// Local M0 smoke test. It drives the real Buzz relay and the real integration
// daemon, but deliberately never approves a VM publication.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askCommand } from './smoke-command.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const stateDir = process.env.BDI_MVP_STATE_DIR || join(repo, '.mvp');

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const split = line.indexOf('=');
    if (split < 1) continue;
    const key = line.slice(0, split).trim();
    let value = line.slice(split + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const secretEnv = parseEnvFile(join(stateDir, 'secrets.env'));
const env = { ...secretEnv, ...process.env };
const required = (name) => {
  const value = env[name];
  if (!value) throw new Error(`missing ${name}; run ./buzz-dkg up first`);
  return value;
};

const bindingsPath = env.BDI_BINDINGS_PATH || join(stateDir, 'bindings.json');
if (!existsSync(bindingsPath)) throw new Error(`missing ${bindingsPath}; run ./buzz-dkg up first`);
const bindings = JSON.parse(readFileSync(bindingsPath, 'utf8'));
if (!Array.isArray(bindings) || bindings.length !== 1 || !bindings[0]?.channelId) {
  throw new Error('M0 smoke requires exactly one generated channel binding');
}

const channelId = String(bindings[0].channelId);
const buzzHttp = (env.BDI_BUZZ_HTTP || 'http://127.0.0.1:9440').replace(/\/$/, '');
const ownerKey = required('BDI_BUZZ_OWNER_KEY');
const serviceKey = required('BDI_SERVICE_KEY');
const { BuzzClient } = await import(join(repo, 'phase0/bridge/lib/nostr.mjs'));
const owner = new BuzzClient({ baseUrl: buzzHttp, secretKeyHex: ownerKey });
const service = new BuzzClient({ baseUrl: buzzHttp, secretKeyHex: serviceKey });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(label, fn, timeoutMs = 90_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(750);
  }
  throw new Error(
    `timed out waiting for ${label}${lastError ? `: ${String(lastError).slice(0, 180)}` : ''}`,
  );
}

// Fail early with a useful relay error instead of timing out on the first
// receipt query.
await owner.query([{ kinds: [39000], '#d': [channelId], limit: 1 }]);

const runId = `${new Date().toISOString()}-${Math.random().toString(16).slice(2, 10)}`;
console.log(`M0 smoke: channel=${channelId} run=${runId}`);
const agentMemoryOnly = env.BDI_SMOKE_AGENT_MEMORY_ONLY === 'true';
let rootId = null;
let receipt = null;
let answer = null;
let refusal = null;

const serviceReplies = async (targetId) =>
  (
    await owner.query([
      { kinds: [9], '#h': [channelId], '#e': [targetId], authors: [service.pubkey] },
    ])
  ).sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));

if (!agentMemoryOnly) {
  const root = await owner.sendMessage(
    channelId,
    `M0 canary ${runId}: which authentication methods should the Buzz-DKG service support?`,
  );
  rootId = root.res.event_id;
  await owner.sendMessage(
    channelId,
    'DECISION: the Buzz-DKG service supports NIP-42 for WebSockets and NIP-98 for HTTP.',
    { root: rootId, replyTo: rootId },
  );
  const pin = await owner.pinMessage(channelId, rootId);
  if (!pin.res.accepted) throw new Error('relay rejected the canary pin');

  receipt = await waitFor('one SWM receipt', async () => {
    const replies = await serviceReplies(rootId);
    return replies.find((event) => event.content.includes('Distilled to Shared Working Memory.'));
  });
  await sleep(1_500);
  const captureReplies = await serviceReplies(rootId);
  const duplicateReceipts = captureReplies.filter((event) =>
    event.content.includes('Distilled to Shared Working Memory.'),
  );
  if (duplicateReceipts.length !== 1) {
    throw new Error(`expected one SWM receipt, found ${duplicateReceipts.length}`);
  }
  if (captureReplies.some((event) => event.content.includes('Published to Verifiable Memory.'))) {
    throw new Error('unexpected VM publication receipt while M0 publication is disabled');
  }
  console.log(`✓ capture receipt ${receipt.id.slice(0, 12)}… (no duplicate, no VM receipt)`);

  const ask = await owner.sendMessage(
    channelId,
    askCommand('what authentication methods did we decide the service should support?', env),
    { mentions: [service.pubkey] },
  );
  answer = await waitFor('grounded answer', async () => {
    const replies = await serviceReplies(ask.res.event_id);
    return replies[0];
  });
  if (
    !answer.content.includes('Cited (context-graph-scoped):') ||
    !/^\[1\] urn:buzz-dkg:decision:[0-9a-f]{64}\b/m.test(answer.content)
  ) {
    throw new Error('grounded answer did not include a context-graph-scoped citation');
  }
  console.log(`✓ grounded answer ${answer.id.slice(0, 12)}… includes a scoped citation`);

  const unsupportedAsk = await owner.sendMessage(
    channelId,
    askCommand('what is the office Wi-Fi password?', env),
    { mentions: [service.pubkey] },
  );
  refusal = await waitFor('unsupported-question refusal', async () => {
    const replies = await serviceReplies(unsupportedAsk.res.event_id);
    return replies[0];
  });
  if (!/can't answer/i.test(refusal.content)) {
    throw new Error('unsupported question was not explicitly refused');
  }
  console.log(`✓ unsupported question refused ${refusal.id.slice(0, 12)}…`);
}

let agentMemory = null;
const relayInfo = await fetch(`${buzzHttp}/info`, {
  headers: { accept: 'application/nostr+json' },
}).then((response) => (response.ok ? response.json() : null));
if (relayInfo?.supported_extensions?.includes('buzz-dkg-memory-v1')) {
  const source = await owner.sendMessage(
    channelId,
    `Agent-memory canary ${runId}: use signed semantic proposals after every agent turn.`,
  );
  const proposal = await owner.proposeDkgMemory(channelId, [source.event.id], {
    schemaVersion: 1,
    summary: `Agent-native memory canary ${runId}`,
    items: [
      {
        kind: 'decision',
        text: 'Buzz agents submit signed semantic memory proposals after normal chat turns.',
      },
    ],
    model: 'installer-smoke',
    promptVersion: 'agent-memory-v1',
  });
  if (proposal.res?.ok !== true || !['accepted', 'duplicate'].includes(proposal.res?.outcome)) {
    throw new Error('agent memory proposal was not durably accepted');
  }
  await waitFor(
    'agent memory in the scoped Buzz query proxy',
    async () => {
      const memory = await owner.postAuthed('/api/dkg/query', {
        channelId,
        operation: 'channel_memory',
        arguments: {},
      });
      return memory?.result?.decisions?.some(
        (decision) => decision.name === `Agent-native memory canary ${runId}`,
      );
    },
    6 * 60_000,
  );
  agentMemory = {
    proposalEventId: proposal.event.id,
    kaName: proposal.res.kaName,
    contextGraphId: proposal.res.contextGraphId,
  };
  console.log(`✓ signed agent memory ${proposal.event.id.slice(0, 12)}… is queryable through Buzz`);
} else {
  console.log('○ agent-memory smoke skipped (relay does not advertise buzz-dkg-memory-v1)');
}

mkdirSync(stateDir, { recursive: true });
const result = {
  ok: true,
  completedAt: new Date().toISOString(),
  channelId,
  contextGraphId: String(bindings[0].contextGraphId),
  rootEventId: rootId,
  receiptEventId: receipt?.id ?? null,
  answerEventId: answer?.id ?? null,
  refusalEventId: refusal?.id ?? null,
  publicationMode: 'disabled',
  agentMemory,
};
writeFileSync(join(stateDir, 'smoke.json'), `${JSON.stringify(result, null, 2)}\n`, {
  mode: 0o600,
});
console.log('M0 smoke passed.');
