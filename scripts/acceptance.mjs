// Gate C acceptance demo — runs the REAL daemon against the isolated stacks
// (Buzz relay on 127.0.0.1:9440, devnet node1 on 127.0.0.1:9420; see
// phase0/ISOLATION.md). No mocks anywhere.
//
// Sequence (SPEC Stage C):
//   1. fresh channel + members; bindings.json written
//   2. daemon started (publishMode=devnet)
//   3. thread posted; root pinned → exactly one SWM receipt
//   4. daemon restarted → catch-up replay → still exactly one receipt (dedup)
//   5. authorized ✅ on the receipt → devnet VM publish → VM receipt with UAL
//   6. @dkg ask (supported) → cited answer; @dkg ask (unrelated) → refusal
//   7. restart → cursor/resume proof
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const phase0 = join(repo, 'phase0');
const demoDir = join(repo, 'demo-acceptance');
rmSync(demoDir, { recursive: true, force: true });
mkdirSync(demoDir, { recursive: true });

const { BuzzClient } = await import(join(phase0, 'bridge/lib/nostr.mjs'));

const env = {};
for (const line of readFileSync(join(phase0, '.env.spike'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const BUZZ_HTTP = 'http://127.0.0.1:9440';
const CHANNEL_NAME = process.env.BDI_DEMO_CHANNEL || 'dkg-daemon-demo';

const author = new BuzzClient({ baseUrl: BUZZ_HTTP, secretKeyHex: env.BDI_SPIKE_AUTHOR_KEY });
const member = new BuzzClient({ baseUrl: BUZZ_HTTP, secretKeyHex: env.BDI_SPIKE_MEMBER_KEY });
const service = new BuzzClient({ baseUrl: BUZZ_HTTP, secretKeyHex: env.BDI_SPIKE_SERVICE_KEY });
const promoter = new BuzzClient({ baseUrl: BUZZ_HTTP, secretKeyHex: env.BDI_SPIKE_PROMOTER_KEY });

let transcript = `# Gate C acceptance demo transcript\n\nStarted ${new Date().toISOString()}. Real daemon, real isolated stacks, no mocks.\n`;
const log = (s) => {
  transcript += s + '\n';
  console.log(s);
};
const section = (t) => log(`\n## ${t}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  log(`\n**FAILED:** ${msg}`);
  writeFileSync(join(repo, 'docs/acceptance-transcript.md'), transcript);
  process.exit(1);
};

async function waitFor(desc, fn, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) fail(`timeout waiting for ${desc}`);
    await sleep(500);
  }
}

// ── 1. channel + members ─────────────────────────────────────────────────────
section('1. Channel setup');
let channelId = await author.findChannel(CHANNEL_NAME);
if (!channelId) {
  await author.createChannel(CHANNEL_NAME);
  channelId = await waitFor('channel uuid', () => author.findChannel(CHANNEL_NAME));
}
log(`channel '${CHANNEL_NAME}' uuid=${channelId}`);
for (const [who, c, role] of [
  ['member', member, undefined],
  ['service', service, 'bot'],
  ['promoter', promoter, undefined],
]) {
  const { res } = await author.addMember(channelId, c.pubkey, role);
  log(`add ${who}: accepted=${res.accepted}`);
}
const bindingsPath = join(demoDir, 'bindings.json');
writeFileSync(
  bindingsPath,
  JSON.stringify([{ channelId, contextGraphId: 'devnet-test', promoters: [promoter.pubkey] }], null, 2),
);
log(`bindings.json: channel → devnet-test, promoter=${promoter.pubkey.slice(0, 12)}…`);

// ── daemon control ───────────────────────────────────────────────────────────
let daemon = null;
let daemonLog = '';
function startDaemon() {
  daemonLog = '';
  daemon = spawn(process.execPath, ['--experimental-strip-types', join(repo, 'src/index.ts')], {
    env: {
      ...process.env,
      BDI_BUZZ_HTTP: BUZZ_HTTP,
      BDI_BUZZ_WS: 'ws://127.0.0.1:9440',
      BDI_SERVICE_KEY: env.BDI_SPIKE_SERVICE_KEY,
      BDI_DKG_API: 'http://127.0.0.1:9420',
      BDI_DKG_TOKEN_PATH: `${process.env.HOME}/code/upstream-pins/dkg/.devnet/node1/auth.token`,
      BDI_BINDINGS_PATH: bindingsPath,
      BDI_PUBLISH_MODE: 'devnet',
      BDI_DB_PATH: join(demoDir, 'daemon.db'),
      BDI_LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stdout.on('data', (d) => { daemonLog += String(d); appendFileSync(join(demoDir, 'daemon.log'), String(d)); });
  daemon.stderr.on('data', (d) => { daemonLog += String(d); appendFileSync(join(demoDir, 'daemon.log'), String(d)); });
}
async function stopDaemon() {
  if (!daemon) return;
  daemon.kill('SIGTERM');
  await sleep(1500);
  if (daemon.exitCode === null) daemon.kill('SIGKILL');
  daemon = null;
}
const serviceReplies = async (rootId) =>
  (await author.query([{ kinds: [9], '#h': [channelId], '#e': [rootId], authors: [service.pubkey] }])).sort(
    (a, b) => a.created_at - b.created_at,
  );

// ── 2-3. daemon up; thread + pin → one SWM receipt ──────────────────────────
section('2. Daemon start (publishMode=devnet, isolated chain check)');
startDaemon();
await waitFor('daemon started', async () => daemonLog.includes('daemon started'));
log('daemon started: ' + (daemonLog.match(/"message":"dkg node"[^\n]*/)?.[0] ?? ''));

section('3. Signal a single-decision thread → one verified SWM receipt');
const r1 = await author.sendMessage(channelId, 'Which relay auth do we require for service bots?');
const rootId = r1.res.event_id;
await member.sendMessage(channelId, 'NIP-42 for websockets; NIP-98 for the HTTP bridge.', { replyTo: rootId });
await author.sendMessage(channelId, 'DECISION: service bots must support both NIP-42 and NIP-98.', {
  root: rootId,
  replyTo: rootId,
});
log(`thread root=${rootId}`);
const { res: pinRes } = await author.pinMessage(channelId, rootId);
log(`pin accepted=${pinRes.accepted} id=${pinRes.event_id}`);
const receipts1 = await waitFor('SWM receipt', async () => {
  const r = await serviceReplies(rootId);
  return r.length >= 1 ? r : null;
});
if (receipts1.length !== 1) fail(`expected exactly 1 receipt, got ${receipts1.length}`);
log(`SWM receipt (${receipts1[0].id}):`);
log('```\n' + receipts1[0].content + '\n```');
if (!/^assertion: did:dkg:context-graph:devnet-test/m.test(receipts1[0].content)) fail('receipt missing assertion');

// ── 4. restart → replay → no duplicate ──────────────────────────────────────
section('4. Daemon restart → catch-up replay → no duplicate receipt');
await stopDaemon();
startDaemon();
await waitFor('daemon restarted', async () => daemonLog.includes('daemon started'));
await sleep(3000);
const receipts2 = await serviceReplies(rootId);
if (receipts2.length !== 1) fail(`replay produced duplicates: ${receipts2.length} receipts`);
log(`after restart + catch-up: still exactly 1 receipt ✔ (cursor resume: ${daemonLog.match(/"message":"catch-up"[^\n]*/)?.[0] ?? 'n/a'})`);

// ── 5. authorized approval → devnet VM publish → UAL receipt ────────────────
section('5. Authorized ✅ approval → devnet VM publish → VM receipt');
const { res: apprRes } = await promoter.react(receipts1[0].id, '✅');
log(`promoter ✅ accepted=${apprRes.accepted} id=${apprRes.event_id}`);
const vmReceipt = await waitFor(
  'VM receipt',
  async () => (await serviceReplies(rootId)).find((r) => r.content.startsWith('Published to Verifiable Memory')),
  90000,
);
log(`VM receipt (${vmReceipt.id}):`);
log('```\n' + vmReceipt.content + '\n```');
const ual = vmReceipt.content.match(/^UAL: (.+)$/m)?.[1];
if (!ual || !ual.startsWith('did:dkg:evm:31337/')) fail('VM receipt missing devnet UAL');

// unauthorized approval must not publish anything new
const { res: badAppr } = await member.react(receipts1[0].id, '✅');
await sleep(3000);
const afterBad = await serviceReplies(rootId);
if (afterBad.filter((r) => r.content.startsWith('Published')).length !== 1) fail('unauthorized approval had effect');
log(`unauthorized ✅ by non-promoter (${badAppr.event_id.slice(0, 12)}…): correctly no effect ✔`);

// ── 6. grounded ask: supported + unsupported ────────────────────────────────
section('6. Grounded answering');
const ask1 = await author.sendMessage(channelId, `@dkg ask what did we decide about relay auth for service bots?`, {
  mentions: [service.pubkey],
});
const answer = await waitFor('grounded answer', async () => {
  const r = await author.query([{ kinds: [9], '#h': [channelId], '#e': [ask1.res.event_id], authors: [service.pubkey] }]);
  return r[0] ?? null;
});
log(`Q: what did we decide about relay auth for service bots?`);
log('```\n' + answer.content + '\n```');
if (!answer.content.includes('Evidence')) fail('answer carries no citations');

const ask2 = await author.sendMessage(channelId, `@dkg ask who won the 1998 world cup final?`, {
  mentions: [service.pubkey],
});
const refusal = await waitFor('refusal', async () => {
  const r = await author.query([{ kinds: [9], '#h': [channelId], '#e': [ask2.res.event_id], authors: [service.pubkey] }]);
  return r[0] ?? null;
});
log(`Q: who won the 1998 world cup final?`);
log('```\n' + refusal.content + '\n```');
if (!/can't answer/.test(refusal.content)) fail('unsupported question was not refused');

// ── 7. final restart proof ──────────────────────────────────────────────────
section('7. Final restart → cursor/resume proof');
await stopDaemon();
startDaemon();
await waitFor('daemon restarted', async () => daemonLog.includes('daemon started'));
await sleep(3000);
const finalReplies = await serviceReplies(rootId);
log(`service replies to the thread after final restart: ${finalReplies.length} (1 SWM receipt + 1 VM receipt) — unchanged ✔`);
if (finalReplies.length !== 2) fail(`unexpected reply count ${finalReplies.length}`);
await stopDaemon();

log(`\n**Acceptance demo complete.** UAL: \`${ual}\``);
transcript += `\nFinished ${new Date().toISOString()}.\n`;
writeFileSync(join(repo, 'docs/acceptance-transcript.md'), transcript);
console.log('\ntranscript written to docs/acceptance-transcript.md');
