// NIP-17 DM to silent human participants: progress update + encouragement
// (operator mandate). Usage: node dm-humans.mjs <pubkeyHex>[,<pubkeyHex>…]
// Sends a gift-wrapped DM to each recipient plus a self-wrap so the
// operator's own client shows the sent thread.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { createRumor, createSeal, createWrap } from 'nostr-tools/nip59';
import { generateSecretKey } from 'nostr-tools/pure';

const BASE = 'https://macbook-pro-8.tailb02f7e.ts.net';
const sk = nip19.decode(readFileSync(homedir() + '/Library/Application Support/xyz.block.buzz.app/identity.key', 'utf8').trim()).data;
const me = getPublicKey(sk);

const NAMES = {
  '66d9520f': 'T',
  '478c55f3': 'Jurij',
  '21c430b7': 'Brana',
};

const MESSAGE = [
  'Quick update from the Web of Trust workroom — the memory module just became a lot more human, and your fingerprints are the missing piece.',
  '',
  'What changed today (based on a photo Žiga took of the confusing panel):',
  '• The cut-off panel header is fixed.',
  '• The jargon is gone from the surface: WM/SWM/VM are now "Draft — only on this node", "Channel Memory — shared with channel members", and "Anchored Record — integrity anchor on-chain". SUBGRAPHS became "Topics", CONTRIBUTORS became "People & agents" — and it now shows your names instead of hex codes.',
  '• Full decision record: https://macbook-pro-8.tailb02f7e.ts.net/media/0f0f2d8a40f9706564f18e64db265d4c34048ee5444787f4ba9246f625b5f99d.jpg was the exhibit; the agents settled a full naming table and panel redesign in #Web of Trust.',
  '',
  'The ask stays small: next time you open the Memory panel, reply here with the first thing that still confuses you. One sentence from a human outweighs pages of agent debate — and it lands attributed to you in the Context Graph.',
  '— Žiga (via the workroom automation)',
].join('\n');

const recipients = (process.argv[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (recipients.length === 0) {
  console.error('usage: node dm-humans.mjs <pubkeyHex>[,<pubkeyHex>…]');
  process.exit(1);
}

// kind 1059 is WebSocket-only on the Buzz relay: NIP-42 auth then EVENT.
const WS_URL = BASE.replace(/^https/, 'wss');
function publish(ev) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => { ws.close(); reject(new Error('ws timeout')); }, 15000);
    let authed = false;
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg[0] === 'AUTH' && !authed) {
        authed = true;
        const authEv = finalizeEvent({
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['relay', WS_URL], ['challenge', msg[1]]],
          content: '',
        }, sk);
        ws.send(JSON.stringify(['AUTH', authEv]));
        setTimeout(() => ws.send(JSON.stringify(['EVENT', ev])), 300);
      } else if (msg[0] === 'OK' && msg[1] === ev.id) {
        clearTimeout(timer);
        ws.close();
        resolve({ status: msg[2] ? 'accepted' : 'rejected', body: msg[3] ?? '' });
      }
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error(String(e.message ?? 'ws error'))); };
  });
}

async function restamp(wrap, recipientPk) {
  // createWrap signs with an ephemeral key we no longer hold, so rebuild the
  // outer event at the current time with a fresh ephemeral key, reusing the
  // already-encrypted... not possible — nip44 key differs per ephemeral key.
  // Instead: re-create the whole wrap via createWrap but overwrite created_at
  // BEFORE signing is not exposed; so we re-encrypt manually here.
  const v2 = (await import('nostr-tools/nip44')).v2; const getConversationKey = v2.utils.getConversationKey; const encrypt = v2.encrypt;
  const ephSk = generateSecretKey();
  const sealJson = wrap.__seal;
  const ck = getConversationKey(ephSk, recipientPk);
  return finalizeEvent({
    kind: 1059,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', recipientPk]],
    content: encrypt(JSON.stringify(sealJson), ck),
  }, ephSk);
}

for (const pk of recipients) {
  const name = NAMES[pk.slice(0, 8)] ?? pk.slice(0, 8);
  // NIP-59 randomizes wrap timestamps into the past; the relay enforces a
  // freshness window, so re-stamp the OUTER wrap to now (privacy loss is
  // acceptable on our single private relay).
  const rumor = createRumor({ kind: 14, content: MESSAGE, tags: [['p', pk]] }, sk);
  const seal = createSeal(rumor, sk, pk);
  const wrap = { __seal: seal };
  const res = await publish(await restamp(wrap, pk));
  console.log(`DM -> ${name}: ${res.status} ${res.body}`);
  // Self-wrap so the sender's client shows the thread.
  try {
    const selfSeal = createSeal(rumor, sk, me);
    await publish(await restamp({ __seal: selfSeal }, me));
  } catch { /* non-fatal */ }
}
console.log('DM RUN DONE');
