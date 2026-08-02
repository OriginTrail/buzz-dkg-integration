import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const { BuzzClient } = await import('./lib/nostr.mjs');
const { nip19 } = await import('nostr-tools');

const BASE = 'https://macbook-pro-8.tailb02f7e.ts.net';
const WOT = '91f4ca95-17bf-4d93-a335-13f51b40fb07';
const FIFA = 'adba7d76-2379-4034-b562-d4eb64f4680c';
const BB = 'fc283085-2d84-478b-a77a-03986ac4897c';
const OPENCLAW = 'c8fa1cbbb89f29b229788e88af2a9d258d490868a8d6082c94269dc102beee11';
const HERMES = '61f6b0a99eb318d08fefe166e70c478e4df6dd9ac82bcc59112fce4a64c4eeef';

const userSk = Buffer.from(
  nip19.decode(readFileSync(`${homedir()}/Library/Application Support/xyz.block.buzz.app/identity.key`, 'utf8').trim()).data,
).toString('hex');
const user = new BuzzClient({ baseUrl: BASE, secretKeyHex: userSk });

const rebuild = [
  'LOOP UPDATE + PROTOCOL AMENDMENT — new channel "BlackB🔴x Distribution".',
  '',
  'You are both members of a new channel. Rebuild your polling loop NOW so every cycle also queries it:',
  `query([{"kinds":[9,7],"#h":["${FIFA}","${WOT}","${BB}"],"since":<cursor>}])`,
  `Then fetch that channel's full history (since=0): channel id ${BB}.`,
  '',
  'Conduct in BlackB🔴x Distribution (differs from deliberation channels):',
  '- Reply to EVERYONE: any human member who posts a message or question gets a direct, helpful reply — not only the operator.',
  '- Conversational mode by default; run DELIBERATION protocol v1 only when a message explicitly asks for a deliberation.',
  '- The control-message filter still applies (ignore @dkg commands, receipts, plumbing lines).',
  '- Keep replies concise; one agent answering is enough unless the other has a material addition.',
  '',
  'Acknowledge here with one short reply each, then post a short introduction of yourselves in BlackB🔴x Distribution.',
].join('\n');

const r1 = await user.sendMessage(WOT, rebuild, { mentions: [OPENCLAW, HERMES] });
console.log('rebuild+amendment posted in WoT:', r1.event.id);

const rule = [
  'CHANNEL RULE (operator): the agents OpenClaw and Hermes reply to everyone in this channel — ask them anything directly.',
  'Conversational replies by default; say "deliberate:" before a question to trigger their formal deliberation protocol.',
].join('\n');
const r2 = await user.sendMessage(BB, rule, { mentions: [OPENCLAW, HERMES] });
console.log('rule posted in BlackBox:', r2.event.id);
