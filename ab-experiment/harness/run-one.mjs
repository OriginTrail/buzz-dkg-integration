// Execute ONE preregistered POLLEN-4 run from its manifest. Usage:
//   node run-one.mjs <runNumber>
// Creates the disposable world (channel, 3 fresh agent identities), seeds the
// arm-appropriate context, lets the team collaborate to a FINAL artifact,
// collects native token metrics + canary audit, scores completion, and writes
// everything to results/run-XX/. Instances are destroyed at the end.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  addMember, addRelayMember, channelMessages, collectMetrics,
  createRunChannel, mintAgent, sendToChannel, spawnAgent,
} from './lib-run.mjs';
import { loadRunCorpus } from './cg-load.mjs';
import { scoreArtifact } from './check-completion.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const runNo = Number(process.argv[2]);
if (!Number.isInteger(runNo)) { console.error('usage: node run-one.mjs <runNumber>'); process.exit(1); }
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifests', `run-${String(runNo).padStart(2, '0')}.json`), 'utf8'));
const taskDir = join(ROOT, 'tasks', manifest.taskId);
const outDir = join(ROOT, 'results', `run-${String(runNo).padStart(2, '0')}`);
mkdirSync(outDir, { recursive: true });

const HARD_TIMEOUT_MS = 18 * 60 * 1000;
const t0 = Math.floor(Date.now() / 1000) - 5;
console.log(`RUN ${runNo}: ${manifest.taskId} ${manifest.regime} team=${manifest.team}`);

// ── world setup ─────────────────────────────────────────────────────────────
const ownerSk = generateSecretKey();
const ownerPk = getPublicKey(ownerSk);
const channelId = await createRunChannel(`pollen4-r${String(runNo).padStart(2, '0')}`);
console.log('channel:', channelId);
const persistState = (extra = {}) => writeFileSync(join(outDir, 'state.json'), JSON.stringify({
  run: runNo, channelId, ownerSkHex: Buffer.from(ownerSk).toString('hex'), startedAt: t0, ...extra,
}, null, 2));
persistState();

const subgraph = `exp-r${String(runNo).padStart(2, '0')}`;
if (manifest.regime === 'CG') {
  const n = await loadRunCorpus({ subgraph, taskDir });
  console.log(`CG corpus loaded: ${n} docs into ${subgraph}`);
} else {
  // SCROLLBACK: canary lives ONLY in the CG (which this arm cannot reach)
  await loadRunCorpus({ subgraph, taskDir, canaryToken: manifest.canaryToken });
  console.log(`canary planted in CG subgraph ${subgraph}`);
}

// ── channel seeding ─────────────────────────────────────────────────────────
if (manifest.regime === 'CG') {
  // canary ONLY in transcript history (agents run with zero history context)
  await sendToChannel(channelId, `Ops note (archive): reference code ${manifest.canaryToken} applies to this fleet.`);
} else {
  const corpusDir = join(taskDir, 'corpus');
  for (const doc of readdirSync(corpusDir).sort()) {
    await sendToChannel(channelId, `📄 ${doc}\n\n${readFileSync(join(corpusDir, doc), 'utf8')}`);
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log('corpus posted to channel');
}

// ── team spawn ──────────────────────────────────────────────────────────────
const NAMES = ['a1', 'a2', 'a3'];
const COMMON = `You are agent {NAME} on a three-agent team ({TEAM}) solving one task together in this channel. Collaborate via short messages. Divide the work, verify each other, and CONVERGE. When the team agrees on the answer, exactly ONE of you posts the final artifact as:
FINAL
\`\`\`json
{...artifact matching the task's required schema...}
\`\`\`
Post FINAL only once and only when checked. Keep every message under 150 words. Maximum ${manifest.maxRounds} messages each.`;
const ARM = manifest.regime === 'CG'
  ? 'You have NO channel history. Your ONLY source for task data is the team memory graph via the cg_search / cg_list_docs / cg_read tools. Always cite which statement/document supports each claim.'
  : 'All task materials were posted in this channel (📄 messages). The full channel transcript is your context — read it carefully. You have no other data source.';

const team = NAMES.map((n) => mintAgent(`${manifest.team}-${n}`));
for (const a of team) { await addRelayMember(a.pubkey); await addMember(channelId, a.pubkey); }
await addMember(channelId, ownerPk);

const queryLog = join(outDir, 'cg-queries.jsonl');
const running = team.map((a, i) => spawnAgent({
  agent: a, channelId, ownerPubkey: ownerPk, ownerSk,
  systemPrompt: COMMON.replace('{NAME}', NAMES[i]).replace('{TEAM}', manifest.team) + '\n\n' + ARM,
  extraEnv: manifest.regime === 'CG'
    ? { BUZZ_ACP_CONTEXT_MESSAGE_LIMIT: '0', BUZZ_ACP_MCP_COMMAND: join(ROOT, 'harness', 'cg-query-mcp.mjs'), RUN_SUBGRAPH: subgraph, RUN_QUERY_LOG: queryLog }
    : { BUZZ_ACP_CONTEXT_MESSAGE_LIMIT: '100' },
}));
persistState({ agents: team.map((a) => a.pubkey) });
console.log('team spawned:', team.map((a) => a.pubkey.slice(0, 8)).join(','));
await new Promise((r) => setTimeout(r, 15000));

// ── task ────────────────────────────────────────────────────────────────────
const taskText = readFileSync(join(taskDir, 'task.md'), 'utf8').split('\nseed:')[0].trim();
await sendToChannel(channelId, `TASK for team ${manifest.team}:\n\n${taskText}`, team.map((a) => a.pubkey));
console.log('task posted; watching for FINAL…');

// ── watch loop ──────────────────────────────────────────────────────────────
const start = Date.now();
let artifact = null;
let finalBy = null;
const teamPks = new Set(team.map((a) => a.pubkey));
while (Date.now() - start < HARD_TIMEOUT_MS && !artifact) {
  await new Promise((r) => setTimeout(r, 10000));
  const msgs = await channelMessages(channelId, t0);
  for (const m of msgs) {
    if (!teamPks.has(m.pubkey)) continue;
    if (/FINAL/.test(m.content)) {
      const jm = /```json\s*([\s\S]*?)```/.exec(m.content);
      if (jm) { try { artifact = JSON.parse(jm[1]); finalBy = m.pubkey; } catch { /* malformed — keep waiting */ } }
    }
  }
  const teamMsgCount = msgs.filter((m) => teamPks.has(m.pubkey)).length;
  if (teamMsgCount > manifest.maxRounds * 3 + 6) { console.log('round cap reached'); break; }
}
for (const r of running) r.child.kill();
console.log(artifact ? `FINAL received from ${finalBy?.slice(0, 8)}` : 'NO FINAL (timeout/cap)');

// ── collection ──────────────────────────────────────────────────────────────
await new Promise((r) => setTimeout(r, 10000));
const msgs = await channelMessages(channelId, t0);
const metrics = await collectMetrics({ ownerSk, agentPubkeys: team.map((a) => a.pubkey), since: t0 });

// canary audit: token must not appear in any TEAM-authored message
const leakage = msgs.filter((m) => teamPks.has(m.pubkey) && m.content.includes(manifest.canaryToken));

// per-agent cumulative totals (last cumulative wins per agent)
const perAgent = {};
for (const m of metrics.sort((a, b) => a.at - b.at)) {
  if (m.cumulative) perAgent[m.agent] = { input: m.cumulative.inputTokens, output: m.cumulative.outputTokens, cachedRead: m.cumulative.cachedReadTokens ?? null, turns: (perAgent[m.agent]?.turns ?? 0) + 1 };
}
const totals = Object.values(perAgent).reduce((s, a) => ({ input: s.input + (a.input ?? 0), output: s.output + (a.output ?? 0) }), { input: 0, output: 0 });

let score;
try {
  score = artifact ? scoreArtifact(manifest.taskId, artifact, manifest.family) : { pass: false, detail: { reason: 'no FINAL artifact' } };
} catch (e) { score = { pass: false, detail: { scorerError: String(e).slice(0, 120) } }; }

const result = {
  run: runNo, manifest, channelId, subgraph,
  agents: team.map((a) => a.pubkey),
  startedAt: t0, endedAt: Math.floor(Date.now() / 1000),
  completed: Boolean(artifact), score,
  leakageInvalid: leakage.length > 0,
  teamMessages: msgs.filter((m) => teamPks.has(m.pubkey)).length,
  tokens: { perAgent, totals, metricEvents: metrics.length },
};
writeFileSync(join(outDir, 'result.json'), JSON.stringify(result, null, 2));
writeFileSync(join(outDir, 'messages.json'), JSON.stringify(msgs.map((m) => ({ at: m.created_at, from: m.pubkey.slice(0, 8), content: m.content })), null, 2));
writeFileSync(join(outDir, 'metrics.json'), JSON.stringify(metrics, null, 2));
if (artifact) writeFileSync(join(outDir, 'artifact.json'), JSON.stringify(artifact, null, 2));
console.log(JSON.stringify({ run: runNo, regime: manifest.regime, pass: score.pass, leakage: leakage.length, tokens: totals, msgs: result.teamMessages }, null, 2));
