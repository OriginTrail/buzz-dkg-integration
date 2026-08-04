// Resume for graphview-deliberation.mjs (original orchestrator was killed
// ~t+2min). Reuses the already-rooted threads; continues pinning, posts the
// provocation and wrap on the remaining schedule.
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

// Roots from the killed run (full IDs resolved from prefixes at startup).
const PREFIXES = ['93dbbcb4ee', '46fde69baf', '02568faa31'];
const recent = await user.query([{ kinds: [9], '#h': [CH], limit: 200 }]);
const roots = PREFIXES.map((p) => recent.find((e) => e.id.startsWith(p))?.id).filter(Boolean);
console.log('resolved roots:', roots.map((r) => r.slice(0, 8)).join(', '));
if (roots.length !== 3) { console.log('WARNING: expected 3 roots, got', roots.length); }

const lastCount = new Map(roots.map((id) => [id, 0]));
// Original t0 was ~7 min before this resume starts; schedule accordingly:
// provocation at +2 min from now (~t+9), wrap at +13 min from now (~t+20).
const t0 = Date.now();
let mid = false;
while (Date.now() - t0 < 10 * 60 * 1000) {
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
  if (false) { // provocation already posted
    mid = true;
    await user.sendMessage(CH, 'Graph provocation: draw your proposal as ASCII or describe the exact first paint — what is on screen 500ms after the user clicks "open as graph" on the `openclaw` subgraph chip (32 KAs)? If your answer needs a legend to parse, simplify. Second: does your layout still work when a decision is CONTESTED — where does the counter-claim edge go?', { mentions: ALL });
    console.log('provocation posted');
  }
}
await user.sendMessage(CH, 'HUMANIZE WRAP — @UT Voice: JOINT RECOMMENDATION (1: final naming table incl. layer names, 2: humanized panel order top-to-bottom + what goes behind disclosure, 3: the agent/human seam + what agents gain), each with strongest dissent. Concrete strings only — this goes straight into the build. Hermes, OpenClaw: flag anything load-bearing it drops.', { mentions: [UTVOICE, HERMES, OPENCLAW] });
console.log('wrap posted');
await s(240000);
for (const root of roots) { try { await user.pinMessage(CH, root); console.log('final pin', root.slice(0, 8)); } catch {} }
console.log('GRAPH VIEW DELIBERATION COMPLETE');
