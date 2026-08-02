import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const { BuzzClient } = await import('./lib/nostr.mjs');
const { nip19 } = await import('nostr-tools');

const env = {};
for (const l of readFileSync('/Users/zigadrev/buzz-dkg-integration/phase0/.env.spike', 'utf8').split('\n')) {
  const m = l.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const BASE = 'https://macbook-pro-8.tailb02f7e.ts.net';
const CH = process.argv[2] || '91f4ca95-17bf-4d93-a335-13f51b40fb07';
const DKG_PUB = '181e08ed958919ec4732d0fa4e7daad8f4860bc25986f6db78f28735fec1bab1';
const DRY = process.argv.includes('--dry');
const s = (ms) => new Promise((r) => setTimeout(r, ms));

// Post as the operator so the distill triggers carry human authority.
const userSk = Buffer.from(
  nip19.decode(readFileSync(`${homedir()}/Library/Application Support/xyz.block.buzz.app/identity.key`, 'utf8').trim()).data,
).toString('hex');
const user = new BuzzClient({ baseUrl: BASE, secretKeyHex: userSk });

const all = await user.query([{ kinds: [9], '#h': [CH], limit: 500 }]);
all.sort((a, b) => a.created_at - b.created_at);
console.log('channel events:', all.length);

// Group into threads: root = event with no e tag; replies attach to their root.
const eTagOf = (e) =>
  e.tags.find((t) => t[0] === 'e' && t[3] === 'root')?.[1] ??
  e.tags.find((t) => t[0] === 'e' && t[3] === 'reply')?.[1] ??
  e.tags.find((t) => t[0] === 'e')?.[1] ??
  null;

const byId = new Map(all.map((e) => [e.id, e]));
const threads = new Map(); // rootId -> {root, replies[]}
for (const e of all) {
  const parent = eTagOf(e);
  if (!parent) { if (!threads.has(e.id)) threads.set(e.id, { root: e, replies: [] }); continue; }
  // walk up to the topmost ancestor present in this channel
  let cur = parent, guard = 0;
  while (guard++ < 20) { const p = byId.get(cur); const up = p ? eTagOf(p) : null; if (!up) break; cur = up; }
  const rootEv = byId.get(cur);
  if (!rootEv) continue;
  if (!threads.has(cur)) threads.set(cur, { root: rootEv, replies: [] });
  threads.get(cur).replies.push(e);
}

// Skip threads that are only daemon receipts, and threads already captured.
const isReceipt = (c) => /^(Captured|Published|Distilled to Shared Working Memory)/.test(c) || /^source-digest:/m.test(c);
const already = new Set(
  all.filter((e) => e.pubkey === DKG_PUB && /^trigger: /m.test(e.content))
     .map((e) => e.content.match(/^trigger: (\S+)$/m)?.[1]).filter(Boolean),
);

const targets = [...threads.values()].filter(({ root, replies }) => {
  if (root.pubkey === DKG_PUB && isReceipt(root.content)) return false;
  const humanish = [root, ...replies].filter((e) => !(e.pubkey === DKG_PUB && isReceipt(e.content)));
  return humanish.length > 0;
});

console.log('threads found:', threads.size, '| capture targets:', targets.length);
for (const { root, replies } of targets) {
  console.log(` - ${root.id.slice(0, 8)} (${replies.length} replies) "${root.content.slice(0, 55).replace(/\n/g, ' ')}"`);
}
if (DRY) { console.log('\n(dry run — nothing posted)'); process.exit(0); }

let n = 0;
for (const { root } of targets) {
  try {
    // Pin (kind 40004) rather than a visible "@dkg distill" chat message: the
    // daemon honours a pin as a capture trigger, but it is not a chat event, so
    // conversational agents never ingest it as input and their deliberation
    // context stays clean.
    const r = await user.pinMessage(CH, root.id);
    n++;
    console.log('pinned (capture trigger)', root.id.slice(0, 8), '->', (r.res?.event_id ?? '').slice(0, 10));
  } catch (e) {
    console.log('distill FAILED for', root.id.slice(0, 8), String(e).slice(0, 90));
  }
  await s(20000); // spacing so the daemon completes each capture serially
}
console.log('distill triggers sent:', n);
