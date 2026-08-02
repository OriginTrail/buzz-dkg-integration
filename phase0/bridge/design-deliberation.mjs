// Design deliberation: Buzz-native DKG memory UI. 3 threads + brief, 18-min
// window with live pinning, then wrap. Humans explicitly invited.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const { BuzzClient } = await import('./lib/nostr.mjs');
const { nip19 } = await import('nostr-tools');
const BASE = 'https://macbook-pro-8.tailb02f7e.ts.net';
const CH = '91f4ca95-17bf-4d93-a335-13f51b40fb07';
const OPENCLAW = 'c8fa1cbbb89f29b229788e88af2a9d258d490868a8d6082c94269dc102beee11';
const HERMES = '61f6b0a99eb318d08fefe166e70c478e4df6dd9ac82bcc59112fce4a64c4eeef';
const UTVOICE = '709214d461f3ebde6356ccbf06205eb793a1584877a3a72f768d4fb4174975ab';
const T = '66d9520f11288342c294ad58f02c3d3f9af8fece4bcf5796814931419981b27d';
const COLLEAGUE = '478c55f3790b78f36015d4fa7e5e523e5106263144dac64e4863035807af755c';
const ALL = [OPENCLAW, HERMES, UTVOICE, T, COLLEAGUE];
const DKGPUB = '181e08ed958919ec4732d0fa4e7daad8f4860bc25986f6db78f28735fec1bab1';
const s = (ms) => new Promise((r) => setTimeout(r, ms));
const userSk = Buffer.from(nip19.decode(readFileSync(homedir() + '/Library/Application Support/xyz.block.buzz.app/identity.key', 'utf8').trim()).data).toString('hex');
const user = new BuzzClient({ baseUrl: BASE, secretKeyHex: userSk });

await user.sendMessage(CH, [
  'DESIGN DELIBERATION — Buzz-native DKG memory UI (prototype decision). Humans welcome and wanted: T, and our new colleague — your views count double here.',
  '',
  'CONTEXT: We are building the DKG memory experience INTO the Buzz desktop app, subsuming the Edge Node UI’s three-memory-layer section (WM / SWM / VM) including SUBGRAPHS. The subgraph view matters most: it must give a view into decisions, code/knowledge commits, and each agent’s individual contributions. Conceptual frame: the "Judgement Layer" — claims with issuer, evidence, confidence, lifecycle, rendered where the conversation happens.',
  '',
  'Three design threads follow. Debate all three; short concrete takes; sketch UI in words. Wrap in ~18 minutes.',
].join('\n'), { mentions: ALL });
await s(1500);

const Q = [
  'DESIGN THREAD A — Placement & shape. Three candidates: (1) SIDE PANEL: a per-channel "Memory" section in the right rail (mirrors Buzz’s agent-memory MemorySection pattern) — always visible next to chat; (2) CENTER TAB: a full "Memory" tab per channel subsuming the node-ui ProjectView (layer bar + subgraph bar + entity detail) — richer but leaves the conversation; (3) MESSAGE-ANCHORED: receipts expand inline into live KA cards, memory browsable from the timeline itself. Which single direction ships as prototype, and why? Hybrids allowed only if you name what gets CUT.',
  'DESIGN THREAD B — The subgraph view. Subgraphs must reveal: decision clusters, code/knowledge commits, and per-agent contribution trails. Debate the primary lens: (a) BY-AGENT (each agent’s contributions as a filterable trail), (b) BY-TYPE (decisions vs commits vs claims), (c) BY-TIME (session/epoch slices), (d) GRAPH-VIZ (force graph) vs LIST/TREE. Which lens is default, which are secondary, and what does a subgraph ROW/NODE show at a glance (provenance? confidence? layer badge?)',
  'DESIGN THREAD C — Data source & trust. The local-first mandate says memory resolves through the VIEWER’S OWN edge node (subscription = access). But most Buzz users won’t run a node on day one. Options: (1) hard local-first (panel shows install/subscribe gate, like our explorer); (2) relay-proxied read-only fallback with a visible "unverified via relay" badge, local node upgrades to verified; (3) desktop bundles a light node. Pick one for the prototype and defend the trust trade-off honestly.',
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
while (Date.now() - t0 < 18 * 60 * 1000) {
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
  if (!mid && el > 8 * 60) {
    mid = true;
    await user.sendMessage(CH, 'Design provocation: whatever you proposed — now argue what a FIRST-TIME Buzz user (no DKG knowledge) sees in their first 30 seconds with your design. If the answer is "a wall of jargon", fix your proposal. Also: name the ONE thing to cut from the prototype.', { mentions: ALL });
    console.log('provocation posted');
  }
}
await user.sendMessage(CH, 'DESIGN WRAP — Hermes: JOINT RECOMMENDATION per thread (A: placement, B: subgraph lens & row anatomy, C: data source), each with the single strongest dissent noted. These feed directly into the prototype build decision.', { mentions: ALL });
console.log('wrap posted');
await s(210000);
for (const root of roots) { try { await user.pinMessage(CH, root); console.log('final pin', root.slice(0, 8)); } catch {} }
console.log('DESIGN DELIBERATION COMPLETE');
