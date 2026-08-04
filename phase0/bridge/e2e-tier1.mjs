// Tier-1 e2e: post a thread in Web of Trust as the operator, pin it (clean
// capture trigger, invisible to the conversational agents), then wait for the
// daemon's SWM receipt and assert the new badge + explorer-link format.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const { BuzzClient } = await import('./lib/nostr.mjs');
const { nip19 } = await import('nostr-tools');

const BASE = 'https://macbook-pro-8.tailb02f7e.ts.net';
const CH = '91f4ca95-17bf-4d93-a335-13f51b40fb07';
const DKG_PUB = '181e08ed958919ec4732d0fa4e7daad8f4860bc25986f6db78f28735fec1bab1';
const s = (ms) => new Promise((r) => setTimeout(r, ms));

const userSk = Buffer.from(
  nip19.decode(
    readFileSync(`${homedir()}/Library/Application Support/xyz.block.buzz.app/identity.key`, 'utf8').trim(),
  ).data,
).toString('hex');
const user = new BuzzClient({ baseUrl: BASE, secretKeyHex: userSk });

const root = await user.sendMessage(
  CH,
  'Operational note (control message — no deliberation needed): receipt links are now local-first: each viewer resolves them through their own DKG edge node, and receipts carry ' +
    'explorer links, so every capture in this channel is one click away from its Knowledge Asset ' +
    'graph view. This thread verifies the sovereign resolution path.',
);
const rootId = root.event.id;
console.log('root posted:', rootId);
await s(1500);

const pin = await user.pinMessage(CH, rootId);
console.log('pinned:', pin.event.id);

// Wait for the daemon's receipt reply to this root.
let receipt = null;
for (let i = 0; i < 30 && !receipt; i++) {
  await s(2000);
  const replies = await user.query([
    { kinds: [9], '#h': [CH], '#e': [rootId], authors: [DKG_PUB] },
  ]);
  receipt = replies.find((e) => e.content.includes('Distilled to Shared Working Memory')) ?? null;
}
if (!receipt) {
  console.error('FAIL: no SWM receipt after 60s');
  process.exit(1);
}
console.log('\n── RECEIPT AS POSTED IN CHANNEL ──');
console.log(receipt.content);

const ka = receipt.content.match(/^ka: (\S+)$/m)?.[1];
const link = receipt.content.match(/\[Explore in DKG Explorer\]\((\S+)\)/)?.[1];
const checks = {
  'badge 🟡 leads': receipt.content.startsWith('🟡 '),
  'scope line present': receipt.content.includes("visible to this channel's members, off-chain"),
  'explorer link present': Boolean(link),
  'link targets the local-first explorer': link?.startsWith('http://127.0.0.1:9295/explore?ual=') ?? false,
  'link carries KA name + cg': Boolean(ka && link?.includes(encodeURIComponent(ka)) && link?.includes('cg=')),
};
console.log('\n── CHECKS ──');
let ok = true;
for (const [k, v] of Object.entries(checks)) {
  console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`);
  ok &&= v;
}
console.log(JSON.stringify({ ka, link }));
process.exit(ok ? 0 : 1);
