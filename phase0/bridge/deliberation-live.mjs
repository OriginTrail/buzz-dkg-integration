// 5-minute recorded deliberation in Web of Trust with live @dkg distillation.
// Roots three debate threads, then pins any thread with fresh replies every
// ~40s (pins are kind-40004 — invisible to the agents, each pin snapshots the
// thread state into a NEW Knowledge Asset, so the CG visibly grows on camera).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const { BuzzClient } = await import('./lib/nostr.mjs');
const { nip19 } = await import('nostr-tools');

const BASE = 'https://macbook-pro-8.tailb02f7e.ts.net';
const CH = '91f4ca95-17bf-4d93-a335-13f51b40fb07';
const OPENCLAW = 'c8fa1cbbb89f29b229788e88af2a9d258d490868a8d6082c94269dc102beee11';
const HERMES = '61f6b0a99eb318d08fefe166e70c478e4df6dd9ac82bcc59112fce4a64c4eeef';
const UTVOICE = '709214d461f3ebde6356ccbf06205eb793a1584877a3a72f768d4fb4174975ab';
const ALL = [OPENCLAW, HERMES, UTVOICE];
const s = (ms) => new Promise((r) => setTimeout(r, ms));

const userSk = Buffer.from(nip19.decode(readFileSync(homedir() + '/Library/Application Support/xyz.block.buzz.app/identity.key', 'utf8').trim()).data).toString('hex');
const user = new BuzzClient({ baseUrl: BASE, secretKeyHex: userSk });

// 1 — protocol for this session
await user.sendMessage(CH, [
  'LIVE DELIBERATION — RAPID MODE (next ~5 minutes). Welcome UT Voice to this channel!',
  'Rules for this session, replacing the usual cadence:',
  '- THREE question threads follow. Debate ALL of them in parallel, replying inside each thread.',
  '- Keep every message SHORT (2-3 sentences max). Sharp claims, concrete examples, name trade-offs.',
  '- Disagree openly when you disagree — do not converge early. UT Voice: challenge OpenClaw and Hermes from the Umanitek/guardian perspective.',
  '- Hermes: when I post "WRAP", close each thread with a compact JOINT CONCLUSION.',
  '- Ignore pins and receipts as usual (control traffic).',
].join('\n'), { mentions: ALL });
console.log('protocol posted');
await s(2000);

// 2 — three debate threads
const Q = [
  'THREAD 1 — Advisory-only: The Buzz RFC says provider output must NEVER gate identity, trust, or writes. Is "advisory-only forever" actually credible, or does reputation always end up gating things in practice? What breaks first?',
  'THREAD 2 — Economics: Batched Merkle anchoring makes vouches ~1/N cheaper, but is on-chain anchoring even the product? Argue: is SWM-style shared memory the real value and VM anchoring a niche ceremony, or is verifiability-without-trust the whole point?',
  'THREAD 3 — Portability vs privacy: Reputation that follows you across communities is also surveillance that follows you across communities. Where exactly is the line? Propose ONE concrete mechanism the RFC should mandate.',
];
const roots = [];
for (const q of Q) {
  const r = await user.sendMessage(CH, q, { mentions: ALL });
  roots.push(r.event.id);
  console.log('thread rooted:', r.event.id.slice(0, 10));
  await s(1500);
}

// 3 — live pinning loop (~5 min), pin threads with fresh replies
const lastCount = new Map(roots.map((id) => [id, 0]));
const t0 = Date.now();
while (Date.now() - t0 < 5 * 60 * 1000) {
  await s(40000);
  for (const root of roots) {
    try {
      const replies = await user.query([{ kinds: [9], '#h': [CH], '#e': [root] }]);
      if (replies.length > (lastCount.get(root) ?? 0)) {
        lastCount.set(root, replies.length);
        await user.pinMessage(CH, root);
        console.log(`pinned thread ${root.slice(0, 8)} at ${replies.length} replies (t+${Math.round((Date.now() - t0) / 1000)}s)`);
      }
    } catch (e) { console.log('pin loop error:', String(e).slice(0, 80)); }
  }
}

// 4 — wrap
await user.sendMessage(CH, 'WRAP — Hermes, close each of the three threads now with a compact JOINT CONCLUSION (one per thread, inside the thread). OpenClaw and UT Voice: one-line "agreed" or a one-line dissent each.', { mentions: ALL });
console.log('wrap posted');
await s(75000);
for (const root of roots) { try { await user.pinMessage(CH, root); console.log('final pin', root.slice(0, 8)); } catch {} }
console.log('DELIBERATION COMPLETE');
