// Humanize-the-memory-module deliberation, seeded with the operator's real
// phone photo of the clipped panel (uploaded to relay Blossom). 3 threads,
// ~25-min window, live pinning, human ping, UT Voice wrap (language lane).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { finalizeEvent } from 'nostr-tools/pure';
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
const skBytes = nip19.decode(readFileSync(homedir() + '/Library/Application Support/xyz.block.buzz.app/identity.key', 'utf8').trim()).data;
const userSk = Buffer.from(skBytes).toString('hex');
const user = new BuzzClient({ baseUrl: BASE, secretKeyHex: userSk });

// ── Blossom upload of the operator's screenshot ─────────────────────────────
const IMG = '/private/tmp/claude-501/-Users-zigadrev/b3553d11-de3a-4d68-a6f4-e0ec4243ea44/scratchpad/memory-panel-clipped.jpg';
const blob = readFileSync(IMG);
const sha = createHash('sha256').update(blob).digest('hex');
const authEv = finalizeEvent({
  kind: 24242,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['t', 'upload'], ['x', sha], ['expiration', String(Math.floor(Date.now() / 1000) + 300)]],
  content: 'upload memory panel screenshot',
}, skBytes);
const up = await fetch(`${BASE}/upload`, {
  method: 'PUT',
  headers: {
    authorization: `Nostr ${Buffer.from(JSON.stringify(authEv)).toString('base64')}`,
    'content-type': 'image/jpeg',
  },
  body: blob,
});
const upBody = await up.text();
console.log('upload:', up.status, upBody.slice(0, 200));
let mediaUrl = `${BASE}/media/${sha}.jpg`;
try { const j = JSON.parse(upBody); if (j.url) mediaUrl = j.url; } catch { /* keep constructed */ }
console.log('media url:', mediaUrl);

// ── Brief + threads ─────────────────────────────────────────────────────────
await user.sendMessage(CH, [
  'MEMORY HUMANIZATION DELIBERATION — the operator opened the Memory panel on his own machine and sent this photo:',
  mediaUrl,
  '',
  'Two operator observations drive this round:',
  '1. The panel top was CUT OFF under the channel header (that layout bug is already fixed — panel now starts below the header). Treat it as evidence of the deeper problem: we have been designing for ourselves.',
  '2. "WM / SWM / VM" mean nothing to innocent eyes. Neither do SUBGRAPHS, CONTRIBUTORS as raw pubkey chips, or DECISIONS as truncated thread titles.',
  '',
  'THE MANDATE: the memory module must serve AGENTS maximally (grounded queries, addressable claims, machine-readable receipts — none of that regresses) while wearing a HUMANIZED form a first-time human reads without a glossary. Prior settled constraints still bind: layer semantics are never erased, only progressively disclosed (fidelity-map wrap); trust copy stays honest ("provenance checked by your node", "recorded attribution, not verification").',
  '',
  'T, Jurij, Brana — this round exists BECAUSE a human hit the wall. Your "I would/wouldn\'t understand X" beats any agent argument. Three threads; wrap in ~25 minutes.',
].join('\n'), { mentions: ALL });
await s(1500);

const Q = [
  'HUMANIZE THREAD 1 — Nomenclature. Propose the human-facing names for the three layers (WM = node-local drafts, SWM = synced to channel participants, VM = anchored on-chain) and for SUBGRAPHS / CONTRIBUTORS / DECISIONS. Rules: names must be honest (no overclaiming), self-explanatory to a first-time human, and the technical term (WM/SWM/VM) stays reachable on hover/expanded per the settled progressive-disclosure rule. Give your full naming table in one message.',
  'HUMANIZE THREAD 2 — First 30 human seconds. The current panel opens on counts + chips + a list. What should a first-time HUMAN see first: a one-sentence plain-language summary ("This channel has decided X things, is debating Y")? The latest decision in full? Contributor chips as names/avatars instead of hex? Sketch the top-to-bottom order of the humanized panel and name what moves behind a disclosure. Keep every capability agents rely on reachable.',
  'HUMANIZE THREAD 3 — One module, two audiences. Name what agents need MAXIMALLY that the panel does not yet expose (grounded query box? engram links? receipt anchors?) and how the machine surface (APIs, receipts, UALs, digests) stays first-class while the human surface hides it by default. Rule of the round: nothing that serves agents may be removed to serve humans — only re-layered. Name the seam.',
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
  if (!mid && el > 9 * 60) {
    mid = true;
    await user.sendMessage(CH, [
      'String-rewrite provocation. These are the EXACT strings the panel shows today. Reply with your replacement for each, verbatim, or defend keeping it:',
      '• "◈ Memory" (the chip)',
      '• "✓ Verified through your node"',
      '• "WM — node-local drafts" / "SWM — synced to participants" / "VM — anchored on-chain"',
      '• "SUBGRAPHS" / "CONTRIBUTORS" / "DECISIONS (n)"',
      '• "Shown for discovery — unverified (via relay receipts). Run a local node to verify."',
      '• "This channel is not bound to a Context Graph yet. Pin a thread or use @dkg distill…"',
      '• graph view: "spine | ⬡ topology", "provenance checked by your node", "colors = recorded attribution, not verification", "Standalone entities", "evidence not yet feeding a decision"',
      'A proposal without concrete strings is an opinion, not a spec.',
    ].join('\n'), { mentions: AGENTS });
    console.log('provocation posted');
  }
  if (!humanPing && el > 13 * 60) {
    humanPing = true;
    const silent = HUMANS.filter((h) => !humanPosted.has(h));
    if (silent.length > 0) {
      await user.sendMessage(CH, 'T, Jurij, Brana — one sentence each: look at the photo above. What is the FIRST thing you did not understand? That sentence rewrites our naming table.', { mentions: silent });
      console.log('human ping posted to', silent.length);
    }
  }
}
await user.sendMessage(CH, 'HUMANIZE WRAP — @UT Voice: JOINT RECOMMENDATION (1: final naming table incl. layer names, 2: humanized panel order top-to-bottom + what goes behind disclosure, 3: the agent/human seam + what agents gain), each with strongest dissent. Concrete strings only — this goes straight into the build. Hermes, OpenClaw: flag anything load-bearing it drops.', { mentions: [UTVOICE, HERMES, OPENCLAW] });
console.log('wrap posted');
await s(240000);
for (const root of roots) { try { await user.pinMessage(CH, root); console.log('final pin', root.slice(0, 8)); } catch {} }
const silentAtEnd = HUMANS.filter((h) => !humanPosted.has(h));
console.log('HUMANS WHO POSTED:', [...humanPosted].map((p) => p.slice(0, 8)).join(',') || 'none');
console.log('HUMANS SILENT:', silentAtEnd.map((p) => p.slice(0, 8)).join(',') || 'none');
console.log('HUMANIZE DELIBERATION COMPLETE');
