// Focused deliberation: the on-demand GRAPH VIEW for the Buzz-native DKG
// memory UI. Follow-up to the design deliberation (JOINT RECOMMENDATION B:
// rows default, "on-demand graph view"; dissent: rows conceal topology).
// 3 threads, ~20-min window, live pinning, wrap by OpenClaw (G2 IA lead).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const { BuzzClient } = await import('./lib/nostr.mjs');
const { nip19 } = await import('nostr-tools');
const BASE = 'https://macbook-pro-8.tailb02f7e.ts.net';
const CH = '91f4ca95-17bf-4d93-a335-13f51b40fb07';
const OPENCLAW = 'c8fa1cbbb89f29b229788e88af2a9d258d490868a8d6082c94269dc102beee11';
const HERMES = '61f6b0a99eb318d08fefe166e70c478e4df6dd9ac82bcc59112fce4a64c4eeef';
const UTVOICE = '709214d461f3ebde6356ccbf06205eb793a1584877a3a72f768d4fb4174975ab';
const FIZZ = '1bb386989054b75cd1f537b6063d7ac91777b61a70fe847d8c1d3f0af24ba12a';
const BLACKBOX = 'f9c41f6a154e9d865d642969c570667080607230f39db31ed46eb59f09a8deb5';
const T = '66d9520f11288342c294ad58f02c3d3f9af8fece4bcf5796814931419981b27d';
const COLLEAGUE = '478c55f3790b78f36015d4fa7e5e523e5106263144dac64e4863035807af755c';
const ALL = [OPENCLAW, HERMES, UTVOICE, FIZZ, BLACKBOX, T, COLLEAGUE];
const DKGPUB = '181e08ed958919ec4732d0fa4e7daad8f4860bc25986f6db78f28735fec1bab1';
const s = (ms) => new Promise((r) => setTimeout(r, ms));
const userSk = Buffer.from(nip19.decode(readFileSync(homedir() + '/Library/Application Support/xyz.block.buzz.app/identity.key', 'utf8').trim()).data).toString('hex');
const user = new BuzzClient({ baseUrl: BASE, secretKeyHex: userSk });

await user.sendMessage(CH, [
  'GRAPH VIEW DELIBERATION — the on-demand graph rendering we deferred. Humans welcome: T, Jurij — your read on "would you actually open this?" counts double.',
  '',
  'CONTEXT: The design deliberation settled B as "compact subgraph rows … with an ON-DEMAND graph view", and the recorded dissent stands: "rows can conceal topology and causal structure better exposed by a graph." Thread G2 separately placed a graph view inside the future first-class Knowledge sidebar section. Nothing yet decides WHERE the graph opens, HOW it is drawn, or WHAT clicking it does. Live scale to design for: this channel alone has ~168 SWM graphs, 124 decision clusters, and 8 per-agent subgraphs.',
  '',
  'Three threads follow. Short concrete takes, sketch in words, name your cuts. Wrap in ~20 minutes.',
].join('\n'), { mentions: ALL });
await s(1500);

const Q = [
  'GRAPH THREAD 1 — WHERE it opens. Candidates: (1) PANEL EXPANSION: the "◈ Memory" side panel’s full-screen inspection state gains a graph mode — closest to the conversation, ships soonest; (2) G2 KNOWLEDGE SECTION: graph lives only as a tab in the future first-class sidebar section — one home, no duplicate; (3) BOTH, same component: panel expansion embeds the identical graph canvas the Knowledge section will use. And: when (if ever) does the current edge-node-UI deep link stop being the topology answer? Pick one shipping order and name what gets CUT.',
  'GRAPH THREAD 2 — LAYOUT & encoding. Force-directed is good for topology, weak for audit (OpenClaw, last round). Alternatives: (a) layered CAUSAL DAG — time/lifecycle flows one axis, decisions as spine, evidence hangs off; (b) CLUSTER MAP — decision clusters as super-nodes that expand on demand; (c) classic FORCE graph with clustering. Also settle visual encoding: what distinguishes decision / commit / claim nodes, how are typed evidence edges drawn, is agent identity color or a lens filter, where do layer (WM/SWM/VM) and confidence badges go — and what is the level-of-detail strategy at 124+ decisions so first paint is readable, not hairball?',
  'GRAPH THREAD 3 — INTERACTIONS & trust. Entry points: "open as graph" on a subgraph row? on an agent chip? on a receipt? Node click: focus the evidence trail in the panel, jump to source message, or open entity in the node UI? Do filters (agent/time/type) stay shared state with the list lens so switching lens never loses the selection? How does graph mode render "shown for discovery — unverified" vs "verified through your node" — per-node, or gate the whole canvas? Name the ONE interaction to cut from v1.',
];
const roots = [];
for (const q of Q) {
  const r = await user.sendMessage(CH, q, { mentions: ALL });
  roots.push(r.event.id);
  console.log('rooted:', r.event.id.slice(0, 10));
  await s(1500);
}

const lastCount = new Map(roots.map((id) => [id, 0]));
const t0 = Date.now();
let mid = false;
while (Date.now() - t0 < 20 * 60 * 1000) {
  await s(45000);
  const el = Math.round((Date.now() - t0) / 1000);
  for (const root of roots) {
    try {
      const replies = await user.query([{ kinds: [9], '#h': [CH], '#e': [root] }]);
      const fresh = replies.filter((e) => e.pubkey !== user.pubkey && e.pubkey !== DKGPUB).length;
      if (fresh > (lastCount.get(root) ?? 0)) {
        lastCount.set(root, fresh);
        await user.pinMessage(CH, root);
        console.log(`pinned ${root.slice(0, 8)} at ${fresh} (t+${el}s)`);
      }
    } catch (e) { console.log('err:', String(e).slice(0, 50)); }
  }
  if (!mid && el > 9 * 60) {
    mid = true;
    await user.sendMessage(CH, 'Graph provocation: draw your proposal as ASCII or describe the exact first paint — what is on screen 500ms after the user clicks "open as graph" on the `openclaw` subgraph chip (32 KAs)? If your answer needs a legend to parse, simplify. Second: does your layout still work when a decision is CONTESTED — where does the counter-claim edge go?', { mentions: ALL });
    console.log('provocation posted');
  }
}
await user.sendMessage(CH, 'GRAPH WRAP — @OpenClaw: JOINT RECOMMENDATION per thread (1: where + shipping order, 2: layout & encoding + LOD strategy, 3: interactions & trust rendering), each with the single strongest dissent noted. This decides the graph-view build. Hermes, UT Voice: flag anything the recommendation drops that you consider load-bearing.', { mentions: ALL });
console.log('wrap posted');
await s(210000);
for (const root of roots) { try { await user.pinMessage(CH, root); console.log('final pin', root.slice(0, 8)); } catch {} }
console.log('GRAPH VIEW DELIBERATION COMPLETE');
