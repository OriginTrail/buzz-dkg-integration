// FIFA demo steps — paced actions for the screen recording.
//   node demo-fifa/steps.mjs thread|pin|ask1|ask2|ask3
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = join(repo, 'demo-fifa');
const statePath = join(dir, 'state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

const { BuzzClient } = await import(join(repo, 'phase0/bridge/lib/nostr.mjs'));
const env = {};
for (const line of readFileSync(join(repo, 'phase0/.env.spike'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const HTTP = 'http://127.0.0.1:9440';
const author = new BuzzClient({ baseUrl: HTTP, secretKeyHex: env.BDI_SPIKE_AUTHOR_KEY });
const member = new BuzzClient({ baseUrl: HTTP, secretKeyHex: env.BDI_SPIKE_MEMBER_KEY });
const service = new BuzzClient({ baseUrl: HTTP, secretKeyHex: env.BDI_SPIKE_SERVICE_KEY });
const CH = JSON.parse(readFileSync(join(dir, 'bindings.json'), 'utf8'))[0].channelId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const steps = {
  async thread() {
    const r1 = await author.sendMessage(CH, 'Match thread: Argentina vs Austria, group stage. What did we take away?');
    state.rootId = r1.res.event_id; save();
    await sleep(1600);
    await member.sendMessage(CH, 'Argentina bossed the midfield. Clean 2-0 — a goal either side of half-time, Austria never really threatened.', { replyTo: state.rootId });
    await sleep(1600);
    await author.sendMessage(CH, 'DECISION: record Argentina 2-0 Austria as the match takeaway — Argentina unbeaten and yet to concede in the group.', { root: state.rootId, replyTo: state.rootId });
    console.log('thread', state.rootId);
  },
  async pin() {
    const { res } = await author.pinMessage(CH, state.rootId);
    console.log('pin', res.event_id);
  },
  async ask1() {
    const { res } = await author.sendMessage(CH, '@dkg ask what was the result of Argentina vs Austria?', { mentions: [service.pubkey] });
    console.log('ask1', res.event_id);
  },
  async ask2() {
    const { res } = await member.sendMessage(CH, '@dkg ask who is Norway’s all-time top scorer?', { mentions: [service.pubkey] });
    console.log('ask2', res.event_id);
  },
  async ask3() {
    const { res } = await member.sendMessage(CH, '@dkg ask what is the wifi password in the press box?', { mentions: [service.pubkey] });
    console.log('ask3', res.event_id);
  },
};
const step = process.argv[2];
if (!steps[step]) { console.error('usage: steps.mjs ' + Object.keys(steps).join('|')); process.exit(1); }
await steps[step]();
