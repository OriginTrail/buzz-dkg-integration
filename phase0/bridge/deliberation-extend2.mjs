import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const { BuzzClient } = await import('./lib/nostr.mjs');
const { nip19 } = await import('nostr-tools');
const BASE = 'https://macbook-pro-8.tailb02f7e.ts.net';
const CH = '91f4ca95-17bf-4d93-a335-13f51b40fb07';
const OPENCLAW = 'c8fa1cbbb89f29b229788e88af2a9d258d490868a8d6082c94269dc102beee11';
const HERMES = '61f6b0a99eb318d08fefe166e70c478e4df6dd9ac82bcc59112fce4a64c4eeef';
const UTVOICE = '709214d461f3ebde6356ccbf06205eb793a1584877a3a72f768d4fb4174975ab';
const DKGPUB = '181e08ed958919ec4732d0fa4e7daad8f4860bc25986f6db78f28735fec1bab1';
const ALL = [OPENCLAW, HERMES, UTVOICE];
const ROOTS = [
  '610014f1ebac8509e29bef89e64b5bc603224014fed8953ab03b1d9acfb40bb9',
  'b88c58e2b4daf9037a9b3a6157da67d77639834ae64352ca6ac47c5d2f985326',
  '200eb7582e8505d8d788fbea361f9b678c6c4148370127f43bdeaaa624ff8a8f',
  '7e40be289bee1d16a9394f1ac14234279a611b07fffad00ebc892f87aa6beed8',
];
const s = (ms) => new Promise((r) => setTimeout(r, ms));
const userSk = Buffer.from(nip19.decode(readFileSync(homedir() + '/Library/Application Support/xyz.block.buzz.app/identity.key', 'utf8').trim()).data).toString('hex');
const user = new BuzzClient({ baseUrl: BASE, secretKeyHex: userSk });

const lastCount = new Map();
// Seed counters from current state so we don't re-pin unchanged threads.
for (const root of ROOTS) {
  const replies = await user.query([{ kinds: [9], '#h': [CH], '#e': [root] }]);
  lastCount.set(root, replies.filter((e) => e.pubkey !== user.pubkey && e.pubkey !== DKGPUB).length);
}
console.log('counters seeded:', [...lastCount.values()].join(','));

const provocations = [
  { at: 2 * 60, text: 'Provocation: whichever external system you researched — argue it FAILED at adoption and name the one design choice that killed it. Does our RFC repeat that mistake? Stay in the threads.' },
  { at: 9 * 60, text: 'Provocation: UT Voice — attack the RFC from a guardian/abuse angle using anything you found on the web. OpenClaw + Hermes — defend or amend, citing your researched sources.' },
  { at: 15 * 60, text: 'Last stretch: each agent posts their single strongest cross-thread synthesis — ONE concrete change to the RFC, justified by both the debate and a researched source. Post it in the most relevant thread.' },
];
let pi = 0;
const t0 = Date.now();
while (Date.now() - t0 < 20 * 60 * 1000) {
  await s(45000);
  const el = Math.round((Date.now() - t0) / 1000);
  for (const root of ROOTS) {
    try {
      const replies = await user.query([{ kinds: [9], '#h': [CH], '#e': [root] }]);
      const fresh = replies.filter((e) => e.pubkey !== user.pubkey && e.pubkey !== DKGPUB).length;
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
await user.sendMessage(CH, 'FINAL WRAP — Hermes: JOINT CONCLUSION per thread (all four, inside each thread), citing at least one researched source where relevant. OpenClaw + UT Voice: agreed/dissent one-liners per thread.', { mentions: ALL });
console.log('final wrap posted');
await s(240000);
for (const root of ROOTS) { try { await user.pinMessage(CH, root); console.log('final pin', root.slice(0, 8)); } catch {} }
console.log('EXTENSION COMPLETE');
