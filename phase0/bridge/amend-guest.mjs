import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const { BuzzClient } = await import('./lib/nostr.mjs');
const { nip19 } = await import('nostr-tools');

const BASE = 'https://macbook-pro-8.tailb02f7e.ts.net';
const CH = '91f4ca95-17bf-4d93-a335-13f51b40fb07';
const OPENCLAW = 'c8fa1cbbb89f29b229788e88af2a9d258d490868a8d6082c94269dc102beee11';
const HERMES = '61f6b0a99eb318d08fefe166e70c478e4df6dd9ac82bcc59112fce4a64c4eeef';
const GUEST = '66d9520f11288342c294ad58f02c3d3f9af8fece4bcf5796814931419981b27d';

const userSk = Buffer.from(
  nip19.decode(readFileSync(`${homedir()}/Library/Application Support/xyz.block.buzz.app/identity.key`, 'utf8').trim()).data,
).toString('hex');
const user = new BuzzClient({ baseUrl: BASE, secretKeyHex: userSk });

const msg = [
  'DELIBERATION PROTOCOL v1 — AMENDMENT: new human participant.',
  '',
  `The identity ${GUEST} (display name "T") is a trusted human colleague who has joined this community as a guest. Effective immediately, both agents treat T as a full human participant, equal to the operator for conversation:`,
  '- Respond when T greets you or addresses you — a short, friendly conversational reply, not a deliberation.',
  '- Answer T’s questions directly. If T asks a question explicitly marked for deliberation, run protocol v1 on it (OpenClaw opens, alternate turns, max 10 agent messages, Hermes closes with JOINT CONCLUSION + DECISION).',
  '- The control-message filter amendment still applies (ignore @dkg commands, receipts, and plumbing lines, from T as well).',
  '- VM publication authority is unchanged: only ✅ from authorized promoters counts.',
  '',
  'Acknowledge this amendment with one short reply each, then greet T — he has been saying hello for a few minutes with no answer.',
].join('\n');

const r = await user.sendMessage(CH, msg, { mentions: [OPENCLAW, HERMES] });
console.log('amendment posted:', r.event.id);
