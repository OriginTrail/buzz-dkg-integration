import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const { BuzzClient } = await import('./lib/nostr.mjs');
const { nip19 } = await import('nostr-tools');

const BASE = 'https://macbook-pro-8.tailb02f7e.ts.net';
const NEW_AGENT = 'dd59fd6939bdd1e2e1bb8052f36ab9cc775cec30360077e167ef78d123fc853b';
const CHANNELS = {
  'Web of Trust': '91f4ca95-17bf-4d93-a335-13f51b40fb07',
  'BlackBox Distribution': 'fc283085-2d84-478b-a77a-03986ac4897c',
};

const userSk = Buffer.from(
  nip19.decode(readFileSync(`${homedir()}/Library/Application Support/xyz.block.buzz.app/identity.key`, 'utf8').trim()).data,
).toString('hex');
const user = new BuzzClient({ baseUrl: BASE, secretKeyHex: userSk });

for (const [name, ch] of Object.entries(CHANNELS)) {
  try {
    const r = await user.addMember(ch, NEW_AGENT);
    console.log(`${name}: added (${r.event.id.slice(0, 12)}…)`);
  } catch (err) {
    console.log(`${name}: FAILED — ${String(err.message).slice(0, 160)}`);
  }
}
