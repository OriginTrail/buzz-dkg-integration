// 30-minute extension: web-research round + continued debate, live pinning of
// all four threads so @dkg ingests everything into the Web of Trust CG.
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
const ROOTS = [
  '610014f1ebac8509e29bef89e64b5bc603224014fed8953ab03b1d9acfb40bb9',
  'b88c58e2b4daf9037a9b3a6157da67d77639834ae64352ca6ac47c5d2f985326',
  '200eb7582e8505d8d788fbea361f9b678c6c4148370127f43bdeaaa624ff8a8f',
];
const s = (ms) => new Promise((r) => setTimeout(r, ms));
const userSk = Buffer.from(nip19.decode(readFileSync(homedir() + '/Library/Application Support/xyz.block.buzz.app/identity.key', 'utf8').trim()).data).toString('hex');
const user = new BuzzClient({ baseUrl: BASE, secretKeyHex: userSk });

// THREAD 4 — web research round
const r4 = { event: { id: '7e40be289bee1d16a9394f1ac14234279a611b07fffad00ebc892f87aa6beed8' } }; const _skip = [
  'THREAD 4 — RESEARCH ROUND (use your web access!): Each of you, go search the web NOW for real systems similar to what we are designing — web-of-trust, decentralized knowledge graphs, or Nostr-adjacent reputation. Candidates to investigate or beat: PGP web of trust, Secure Scuttlebutt, Bluesky/ATProto labelers, Ethereum Attestation Service, Gitcoin Passport, Ceramic/IPLD, SourceCred, TrustNet, Vertex/NIP-85 services.',
  'Bring back 2-3 CONCRETE findings each, with source URLs, and say specifically what our Buzz RFC + DKG design should STEAL from them and where ours is stronger. Post findings as replies in THIS thread; keep debating the other three threads in parallel.',
].join('\n'), { mentions: ALL });
const roots = [...ROOTS, r4.event.id];
console.log('research thread rooted:', r4.event.id.slice(0, 10));

// Pin loop: 30 minutes, all four threads; provocations at 8/16/24 min.
const lastCount = new Map(roots.map((id) => [id, 0]));
const t0 = Date.now();
const provocations = [
  { at: 2 * 60, text: 'Provocation: whichever external system you just researched — argue it FAILED at adoption and explain the one design choice that killed it. Does our RFC repeat that mistake? Stay in the threads.' },
  { at: 9 * 60, text: 'Provocation: UT Voice — attack the RFC from a guardian/abuse angle using anything you found on the web. OpenClaw + Hermes — defend or amend, citing your own research findings.' },
  { at: 16 * 60, text: 'Last stretch: each agent posts their single strongest cross-thread synthesis — one concrete change to the RFC, justified by both the debate and a researched source.' },
];
let pi = 0;
while (Date.now() - t0 < 22 * 60 * 1000) {
  await s(45000);
  const el = Math.round((Date.now() - t0) / 1000);
  for (const root of roots) {
    try {
      const replies = await user.query([{ kinds: [9], '#h': [CH], '#e': [root] }]);
      const fresh = replies.filter((e) => e.pubkey !== user.pubkey && e.pubkey !== '181e08ed958919ec4732d0fa4e7daad8f4860bc25986f6db78f28735fec1bab1').length;
      if (fresh > (lastCount.get(root) ?? 0)) {
        lastCount.set(root, fresh);
        await user.pinMessage(CH, root);
        console.log(`pinned ${root.slice(0, 8)} at ${fresh} replies (t+${el}s)`);
      }
    } catch (e) { console.log('loop err:', String(e).slice(0, 60)); }
  }
  if (pi < provocations.length && el > provocations[pi].at) {
    await user.sendMessage(CH, provocations[pi].text, { mentions: ALL });
    console.log(`provocation ${pi + 1} posted (t+${el}s)`);
    pi++;
  }
}

await user.sendMessage(CH, 'FINAL WRAP — Hermes: JOINT CONCLUSION per thread (all four, inside each thread), each citing at least one researched source where relevant. OpenClaw + UT Voice: agreed/dissent one-liners.', { mentions: ALL });
console.log('final wrap posted');
await s(180000);
for (const root of roots) { try { await user.pinMessage(CH, root); console.log('final pin', root.slice(0, 8)); } catch {} }
console.log('EXTENSION COMPLETE');
