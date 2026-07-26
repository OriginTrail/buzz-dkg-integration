// Step driver for the recorded live demo: each invocation performs one human
// action against the isolated stack, so a screen recording can pace the flow.
//   node scripts/live-demo-steps.mjs setup|thread|pin|approve|ask|ask2|status
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const phase0 = join(repo, 'phase0');
const demoDir = join(repo, 'demo-live');
mkdirSync(demoDir, { recursive: true });
const statePath = join(demoDir, 'state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

const { BuzzClient } = await import(join(phase0, 'bridge/lib/nostr.mjs'));
const env = {};
for (const line of readFileSync(join(phase0, '.env.spike'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const HTTP = 'http://127.0.0.1:9440';
const author = new BuzzClient({ baseUrl: HTTP, secretKeyHex: env.BDI_SPIKE_AUTHOR_KEY });
const member = new BuzzClient({ baseUrl: HTTP, secretKeyHex: env.BDI_SPIKE_MEMBER_KEY });
const service = new BuzzClient({ baseUrl: HTTP, secretKeyHex: env.BDI_SPIKE_SERVICE_KEY });
const promoter = new BuzzClient({ baseUrl: HTTP, secretKeyHex: env.BDI_SPIKE_PROMOTER_KEY });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CH = 'dkg-live-demo';

const steps = {
  async setup() {
    let ch = await author.findChannel(CH);
    if (!ch) {
      await author.createChannel(CH);
      for (let i = 0; i < 20 && !ch; i++) { await sleep(300); ch = await author.findChannel(CH); }
    }
    for (const [c, role] of [[member], [service, 'bot'], [promoter]]) await author.addMember(ch, c.pubkey, role);
    state.channelId = ch; save();
    writeFileSync(
      join(demoDir, 'bindings.json'),
      JSON.stringify([{ channelId: ch, contextGraphId: 'devnet-test', promoters: [promoter.pubkey] }], null, 2),
    );
    console.log(ch);
  },
  async thread() {
    const r1 = await author.sendMessage(state.channelId, 'Team — we need to lock the data-retention policy for customer telemetry. Proposals?');
    state.rootId = r1.res.event_id; save();
    await sleep(1500);
    await member.sendMessage(state.channelId, '90 days raw, 13 months aggregated. That satisfies both the audit and the storage budget.', { replyTo: state.rootId });
    await sleep(1500);
    await author.sendMessage(state.channelId, 'DECISION: retain raw telemetry 90 days, aggregated 13 months. Effective next sprint.', { root: state.rootId, replyTo: state.rootId });
    console.log('thread', state.rootId);
  },
  async pin() {
    const { res } = await author.pinMessage(state.channelId, state.rootId);
    console.log('pin', res.event_id);
  },
  async approve() {
    const receipts = await service.query([{ kinds: [9], '#h': [state.channelId], '#e': [state.rootId], authors: [service.pubkey] }]);
    const receipt = receipts.find((r) => r.content.startsWith('Distilled to Shared Working Memory'));
    if (!receipt) throw new Error('no SWM receipt yet');
    const { res } = await promoter.react(receipt.id, '✅');
    console.log('approval', res.event_id, 'on receipt', receipt.id);
  },
  async ask() {
    const { res } = await author.sendMessage(state.channelId, '@dkg ask what retention policy did we decide for telemetry?', { mentions: [service.pubkey] });
    console.log('ask', res.event_id);
  },
  async ask2() {
    const { res } = await author.sendMessage(state.channelId, '@dkg ask what is our office wifi password?', { mentions: [service.pubkey] });
    console.log('ask2', res.event_id);
  },
  async status() {
    console.log(JSON.stringify(state, null, 2));
  },
};

const step = process.argv[2];
if (!steps[step]) { console.error(`usage: live-demo-steps.mjs ${Object.keys(steps).join('|')}`); process.exit(1); }
await steps[step]();
