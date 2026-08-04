// Deliberation: repurposing the ACTUAL DKG node-ui code for the Buzz graph
// view. Grounded in the OriginTrail/dkg repo (now mirrored on our community
// git). 25-min window, live pinning, targeted human pings at mid-point,
// wrap by Hermes. Capture: wot-autocapture daemon (SWM + per-agent subgraphs).
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
const JURIJ = '478c55f3790b78f36015d4fa7e5e523e5106263144dac64e4863035807af755c';
const BRANA = '21c430b77577d55fb665582a5162ffbac97a431536d98359472b63376923053a';
const AGENTS = [OPENCLAW, HERMES, UTVOICE, FIZZ, BLACKBOX];
const HUMANS = [T, JURIJ, BRANA];
const ALL = [...AGENTS, ...HUMANS];
const DKGPUB = '181e08ed958919ec4732d0fa4e7daad8f4860bc25986f6db78f28735fec1bab1';
const s = (ms) => new Promise((r) => setTimeout(r, ms));
const userSk = Buffer.from(nip19.decode(readFileSync(homedir() + '/Library/Application Support/xyz.block.buzz.app/identity.key', 'utf8').trim()).data).toString('hex');
const user = new BuzzClient({ baseUrl: BASE, secretKeyHex: userSk });

await user.sendMessage(CH, [
  'NODE-UI REPURPOSE DELIBERATION — round 2 on the graph view, now grounded in the ACTUAL DKG code. Objective from the operator: the Buzz graph view should REFLECT the DKG node UI — check the repository and repurpose the code that powers its Web of Trust CG subgraph/layer views.',
  '',
  'THE CODE (read it — mirrored on OUR community git at ' + BASE + '/git/7b20d5265af65543cbe6192e1665f8f0730004622c111c381d163cde53ae5bc5/dkg, or github.com/OriginTrail/dkg):',
  '• packages/graph-viz — `@origintrail-official/dkg-graph-viz`: RDF-native renderer, hexagonal nodes, d3-force layout, focus-filter (auto-focus high-degree nodes), reification-collapser, declarative ViewConfig JSON, palette themes, React wrapper (`RdfGraph`).',
  '• packages/node-ui views/project/components/graph.tsx — the node UI graph tab: lazy-loads RdfGraph, feeds it layer-scoped triples via useMemoryEntities + useLayerTriples, colors per-agent via useSwmAttributions (agent palette!), TRUST_COLORS + LAYER_CONFIG, and a "singleton shelf" for degree-0 nodes so the canvas never hairballs.',
  '• packages/node-ui SubGraphBar.tsx — subgraph chips w/ profile icon/color + counts from /api/sub-graph/list, scoping the WHOLE view; MemoryStackView/MemoryLayerView = the 3-layer regime; views/project/components/{entities,ka,layer-widgets}.tsx = entity detail + KA cards.',
  '',
  'TENSION TO RESOLVE: our last wrap CUT force-directed — but node-UI parity means graph-viz, which IS force-directed hexagons. graph-viz answers the audit objections differently: focus-filter, singleton shelf, reification collapsing, deterministic seeds. Does parity win, does the spine stay, or do both live at different zoom levels?',
  '',
  'T, Jurij, Brana — you have seen the real node UI. Your read on "which of its views actually helped you" counts double. Three threads follow; wrap in ~25 minutes.',
].join('\n'), { mentions: ALL });
await s(1500);

const Q = [
  'REPURPOSE THREAD 1 — Strategy. Options: (A) DEPEND: add `@origintrail-official/dkg-graph-viz` as a dependency in Buzz desktop, mount RdfGraph in the Memory panel expansion, feed it triples from the local explorer — smallest diff, upstream fixes flow in; (B) VENDOR: copy graph-viz core + the ProjectView graph-tab glue from the mirror into desktop/src, adapt freely — control, no upstream coupling; (C) HYBRID: depend on graph-viz, but port the node-ui GLUE (useSwmAttributions agent palette, TRUST_COLORS, LAYER_CONFIG, singleton shelf, layer scoping) as our own adapter code. Pick one, name the license/maintenance trade-off, and say what happens to our v1 decision-spine canvas.',
  'REPURPOSE THREAD 2 — Fidelity map. Walk the node UI\'s CG view piece by piece and mark each KEEP-AS-IS / ADAPT / SKIP for Buzz: (1) SubGraphBar chips w/ icon+color+counts; (2) WM/SWM/VM MemoryStackView layer regime + per-layer scoping of the graph; (3) hexagonal RdfGraph canvas w/ per-agent attribution colors (useSwmAttributions); (4) singleton shelf; (5) entity detail / KA cards w/ provenance (OnChainProvenanceCard); (6) ViewConfig JSON declarative styling. What is the ONE piece whose absence would make a node-UI user feel Buzz is "not the same thing"?',
  'REPURPOSE THREAD 3 — Data + reconciliation. The node UI reads its own node (/api/query per view, /api/sub-graph/list, SSE events). Buzz reads the local explorer (:9295) today. Options: point the Buzz canvas straight at the node APIs (:9200, same origin the deep link uses) vs keep the explorer proxy as the adapter. AND: reconcile with the previous wrap — does the decision spine survive as the "catch up" first paint with RdfGraph as the expanded topology mode (scale picks the layout), or does hexagon parity replace it outright? Name what you CUT.',
];
const roots = [];
for (const q of Q) {
  const r = await user.sendMessage(CH, q, { mentions: ALL });
  roots.push(r.event.id);
  console.log('rooted:', r.event.id.slice(0, 10));
  await s(1500);
}

const lastCount = new Map(roots.map((id) => [id, 0]));
const humanPosted = new Set();
const t0 = Date.now();
let mid = false;
let humanPing = false;
while (Date.now() - t0 < 25 * 60 * 1000) {
  await s(45000);
  const el = Math.round((Date.now() - t0) / 1000);
  for (const root of roots) {
    try {
      const replies = await user.query([{ kinds: [9], '#h': [CH], '#e': [root] }]);
      for (const e of replies) if (HUMANS.includes(e.pubkey)) humanPosted.add(e.pubkey);
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
    await user.sendMessage(CH, 'Repurpose provocation: open the mirror and READ packages/node-ui/src/ui/views/project/components/graph.tsx before your next reply — cite one concrete function/prop you would keep verbatim and one you would delete. Proposals that do not cite the code are opinions, not engineering.', { mentions: AGENTS });
    console.log('provocation posted');
  }
  if (!humanPing && el > 12 * 60) {
    humanPing = true;
    const silent = HUMANS.filter((h) => !humanPosted.has(h));
    if (silent.length > 0) {
      await user.sendMessage(CH, 'Humans — T, Jurij, Brana — this decision shapes the UI you will actually use. One sentence is enough: when you open a channel\'s memory, do you want to land on the node-UI-style hexagon graph, the decision list, or a summary? Your one sentence outweighs a thousand agent tokens here.', { mentions: silent });
      console.log('human ping posted to', silent.length, 'silent humans');
    }
  }
}
await user.sendMessage(CH, 'REPURPOSE WRAP — @Hermes: JOINT RECOMMENDATION per thread (1: depend/vendor/hybrid + spine fate, 2: fidelity map KEEP/ADAPT/SKIP list + the one indispensable piece, 3: data path + first-paint reconciliation), each with strongest dissent. Cite file paths. This becomes the build spec. OpenClaw, UT Voice: flag anything load-bearing it drops.', { mentions: [HERMES, OPENCLAW, UTVOICE] });
console.log('wrap posted');
await s(240000);
for (const root of roots) { try { await user.pinMessage(CH, root); console.log('final pin', root.slice(0, 8)); } catch {} }
const silentAtEnd = HUMANS.filter((h) => !humanPosted.has(h));
console.log('HUMANS WHO POSTED:', [...humanPosted].map((p) => p.slice(0, 8)).join(',') || 'none');
console.log('HUMANS SILENT:', silentAtEnd.map((p) => p.slice(0, 8)).join(',') || 'none');
console.log('NODE-UI REPURPOSE DELIBERATION COMPLETE');
