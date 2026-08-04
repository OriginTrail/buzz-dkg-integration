// Round 2: goad agents into the three existing threads, run capture loop on a
// 12-minute clock matched to real agent cadence, then wrap.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const { BuzzClient } = await import('./lib/nostr.mjs');
const { nip19 } = await import('nostr-tools');
const BASE = 'https://macbook-pro-8.tailb02f7e.ts.net';
const CH = '91f4ca95-17bf-4d93-a335-13f51b40fb07';
const BB = 'fc283085-2d84-478b-a77a-03986ac4897c';
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

// Bring UT Voice's polling to WoT via the channel it already watches.
await user.sendMessage(BB, 'UT Voice: you have been added to the "Web of Trust" channel (id 91f4ca95-17bf-4d93-a335-13f51b40fb07). Add it to your polling loop NOW, fetch its recent history, and join the three-thread deliberation there — reply INSIDE each thread. Short, sharp takes from the Umanitek/guardian perspective.', { mentions: [UTVOICE] });
console.log('UT Voice summoned');

// Goad first takes in each thread (reply inside the threads so agents thread correctly).
const goads = [
  'GO — OpenClaw, Hermes, UT Voice: your opening take on THIS thread, right now, 2-3 sentences each. Take a definite position; at least one of you must argue advisory-only is a fiction that will not survive contact with moderation reality.',
  'GO — opening takes here too, 2-3 sentences. UT Voice: argue from guardian/safety economics. Someone must defend the heresy that VM anchoring is a ceremony and SWM is the product.',
  'GO — opening takes, 2-3 sentences. Each of you must propose ONE concrete mechanism (name it) for the portability/privacy line — no abstract hand-waving.',
];
for (let i = 0; i < ROOTS.length; i++) {
  await user.sendMessage(CH, goads[i], { root: ROOTS[i], replyTo: ROOTS[i], mentions: ALL });
  await s(1200);
}
console.log('goads posted');

// Capture loop: 12 minutes, pin any thread with new replies every 40s.
const lastCount = new Map(ROOTS.map((id) => [id, 0]));
const t0 = Date.now();
let mid = false;
while (Date.now() - t0 < 12 * 60 * 1000) {
  await s(40000);
  const el = Math.round((Date.now() - t0) / 1000);
  for (const root of ROOTS) {
    try {
      const replies = await user.query([{ kinds: [9], '#h': [CH], '#e': [root] }]);
      const fresh = replies.filter((e) => ![user.pubkey].includes(e.pubkey)).length;
      if (fresh > (lastCount.get(root) ?? 0)) {
        lastCount.set(root, fresh);
        await user.pinMessage(CH, root);
        console.log(`pinned ${root.slice(0, 8)} at ${fresh} replies (t+${el}s)`);
      }
    } catch (e) { console.log('loop err:', String(e).slice(0, 60)); }
  }
  // Mid-debate provocation to keep it lively.
  if (!mid && el > 5 * 60) {
    mid = true;
    await user.sendMessage(CH, 'Halfway provocation: each of you, pick the OTHER agent’s weakest claim so far and attack it directly (quote it, then refute in 2 sentences). Stay in the relevant threads.', { mentions: ALL });
    console.log('mid provocation posted');
  }
}

await user.sendMessage(CH, 'WRAP — Hermes: compact JOINT CONCLUSION per thread, posted inside each thread. OpenClaw + UT Voice: one-line agreed/dissent per thread.', { mentions: ALL });
console.log('wrap posted');
await s(120000);
for (const root of ROOTS) { try { await user.pinMessage(CH, root); console.log('final pin', root.slice(0, 8)); } catch {} }
console.log('ROUND 2 COMPLETE');
