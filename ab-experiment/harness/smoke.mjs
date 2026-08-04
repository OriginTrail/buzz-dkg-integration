// Plumbing smoke test (NOT a protocol run): 1 disposable agent, 1 fresh
// channel, 1 trivial turn. Validates: channel create, member add, standalone
// buzz-acp spawn with a fresh key, agent reply, kind-44200 metric decrypt.
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  addMember, addRelayMember, channelMessages, collectMetrics, createRunChannel,
  mintAgent, operator, sendToChannel, spawnAgent,
} from './lib-run.mjs';

const t0 = Math.floor(Date.now() / 1000) - 5;
// Dedicated metrics-owner key for the run (we hold sk → we can decrypt 44200).
const ownerSk = generateSecretKey();
const ownerPk = getPublicKey(ownerSk);

const channelId = await createRunChannel(`pollen4-smoke-${Date.now() % 100000}`);
console.log('channel:', channelId);

const agent = mintAgent('smoke-a1');
await addRelayMember(agent.pubkey);
await addMember(channelId, agent.pubkey);
await addMember(channelId, ownerPk);
console.log('agent:', agent.pubkey.slice(0, 12));

const running = spawnAgent({ extraEnv: { RUST_LOG: 'debug' },
  agent, channelId, ownerPubkey: ownerPk, ownerSk,
  systemPrompt: 'You are a test agent in a plumbing smoke test. Reply to any task message with exactly: SMOKE-OK <one short sentence about what the task asked>. Nothing else.',
});
running.child.on('exit', (c) => console.log('acp exited', c));

// give the harness time to connect + subscribe
await new Promise((r) => setTimeout(r, 12000));
await sendToChannel(channelId, 'Task: confirm you can read this channel and reply.', [agent.pubkey]);
console.log('task posted; waiting for reply…');

let reply = null;
for (let i = 0; i < 24 && !reply; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const msgs = await channelMessages(channelId, t0);
  reply = msgs.find((m) => m.pubkey === agent.pubkey);
}
console.log('reply:', reply ? reply.content.slice(0, 120) : 'NONE (timeout)');

// metrics
await new Promise((r) => setTimeout(r, 8000));
const metrics = await collectMetrics({ ownerSk, agentPubkeys: [agent.pubkey], since: t0 });
console.log('metrics events:', metrics.length);
for (const m of metrics) {
  console.log('  metric:', JSON.stringify(m).slice(0, 400));
}

running.child.kill();
console.log(reply && metrics.length > 0 ? 'SMOKE PASS' : 'SMOKE PARTIAL — see above');
console.log('--- acp owner/usage/metric log lines ---');
for (const l of running.logs.join('').split('\n')) if (/goose|usage|metric|notif|unknown/i.test(l)) console.log(' ', l.slice(0, 200));
process.exit(0);
