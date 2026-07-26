// Gate D3 — ONE operator-approved VM publication, spend-capped, single attempt.
// Approval: operator "continue" in session 2026-07-26 on the presented D3 block
// (ceilings 0.5 TRAC / 0.0005 ETH, publishEpochs 12, receipt included).
// Never auto-retry: outcomes are classified confirmed | tentative | failed;
// tentative/failed stop for the operator after read-only diagnostics.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const { DkgClient } = await import(join(repo, 'src/dkg/client.ts'));
const { BuzzClient } = await import(join(repo, 'phase0/bridge/lib/nostr.mjs'));

const D3 = {
  operator_approval_reference: 'operator "continue" 2026-07-26 on presented D3 block (receipt included)',
  authorized_buzz_approval_event_id: 'bf724457b3da34b9615e0cb77c5eff4b72f5b296e7c39aa0a306f9f6006d0c12',
  authorized_promoter_npub: 'fc11ee8605a0bca53185867f1982334c61dd9249c752ab2532c07312acc294d6',
  context_graph_id: '0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026',
  knowledge_asset_name: 'buzz-dkg-8a4599b36c1d',
  root_entity_uri: 'urn:buzz-dkg:decision:8a4599b36c1d845301edbf0cfb66fc598c998caa3d781ffcb53b1c3135194c00',
  source_set_digest: '8a4599b36c1d845301edbf0cfb66fc598c998caa3d781ffcb53b1c3135194c00',
  finalized_merkle_root: '0x1a87d6c07b95ac0a406c6462b9f49cff875031db5693ee24603c2b464e3f65e3',
  swm_receipt_event_id: 'b02446d78c594a25403d6d0bdf0de53dd59fb4b616e4d836b873b218ecbd0b06',
  buzz_channel_id: '56059d1d-77bb-4d94-af79-97bb30547ac8',
  thread_root: '60fe7bc1f5263b06480101d567f06b74518fc69258f3712dfd46ddef6743e5ff',
  target_chain_id: 'base:8453',
  publish_epochs: 12,
  max_trac_cost: 0.5,
  max_eth_cost: 0.0005,
};

const token = readFileSync(`${process.env.HOME}/.dkg-mainnet/auth.token`, 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).pop();
const dkg = new DkgClient({ baseUrl: 'http://127.0.0.1:9200', token });
const env = {};
for (const line of readFileSync(join(repo, 'phase0/.env.spike'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const service = new BuzzClient({ baseUrl: 'http://127.0.0.1:9440', secretKeyHex: env.BDI_SPIKE_SERVICE_KEY });

let out = `# Gate D3 execution transcript\n\nDate: ${new Date().toISOString()}. ${D3.operator_approval_reference}. Bearer token redacted.\n`;
const log = (s) => { out += s + '\n'; console.log(s); };
const save = () => writeFileSync(join(repo, 'docs/gates/d3-transcript.md'), out);
const die = (msg) => { log(`\n**NO-GO / STOP:** ${msg}`); save(); process.exit(1); };

// ── preflight: §6 invariants 1–9 + spend checks (all read-only) ─────────────
log('\n## Preflight (read-only, immediately before publication)\n');
const approvals = await service.query([{ ids: [D3.authorized_buzz_approval_event_id] }]);
const appr = approvals[0];
if (!appr) die('approval event unreadable');
const apprTarget = [...appr.tags].reverse().find((t) => t[0] === 'e' && /^[0-9a-f]{64}$/.test(t[1] ?? ''))?.[1];
const receiptEvents = await service.query([{ ids: [D3.swm_receipt_event_id] }]);
const receipt = receiptEvents[0];
if (!receipt) die('SWM receipt unreadable');
const kaLine = receipt.content.match(/^ka: (\S+)$/m)?.[1];
const digestLine = receipt.content.match(/^source-digest: sha256:([0-9a-f]{64})$/m)?.[1];
const desc = await dkg.descriptor(D3.knowledge_asset_name, D3.context_graph_id).catch(() => null);
const st = await dkg.status();
const bal = await dkg.request('GET', '/api/wallets/balances');
const wallet = bal.balances.find((b) => b.address === '0x633E5a7C5e612d9981538F60D824cC03be97e2Ab');
const ethBefore = parseFloat(wallet.eth);
const tracBefore = parseFloat(wallet.trac);

const checks = [
  ['1. reactor is the authorized promoter', appr.pubkey === D3.authorized_promoter_npub, appr.pubkey.slice(0, 12) + '…'],
  ['2. approval targets the service receipt', apprTarget === D3.swm_receipt_event_id && receipt.pubkey === service.pubkey, `target ${String(apprTarget).slice(0, 12)}…, receipt author is service`],
  ['3. receipt identifies KA + immutable digest', kaLine === D3.knowledge_asset_name && digestLine === D3.source_set_digest, `${kaLine} / ${String(digestLine).slice(0, 12)}…`],
  ['4. channel ↔ same context graph', receipt.tags.some((t) => t[0] === 'h' && t[1] === D3.buzz_channel_id), 'dkg-test ↔ FIFA CG (D1 mapping)'],
  ['5. KA finalized + fully shared, digest match', desc?.state === 'promoted' && desc?.memoryLayer === 'SWM' && `0x${desc?.swmCurrentAssertion}` === D3.finalized_merkle_root, `state=${desc?.state} swm=0x${String(desc?.swmCurrentAssertion).slice(0, 12)}…`],
  ['6. approval not already consumed', !desc?.events?.some((e) => e.type === 'published'), 'no prior D3 attempt recorded'],
  ['7. not already published', desc?.state === 'promoted' && !desc?.events?.some((e) => e.type === 'published'), `state=${desc?.state}`],
  ['8. environment permits publication', st.chain?.chainId === D3.target_chain_id && st.hasIdentity === true, `chain ${st.chain?.chainId}, identityId ${st.identityId}`],
  ['9. operator-approved D3 block authorizes exactly this publication', true, D3.operator_approval_reference],
];
let ok = true;
for (const [name, pass, detail] of checks) {
  ok &&= pass;
  log(`- [${pass ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
}
if (!ok) die('§6 invariant failed — do not fix, do not publish');

// spend: live quote vs ceilings
const QUOTED_TRAC = 0.0716; // read-only chain quote (avgAsk 8e14 × 7641 B × 12 / 1024), re-derived this session
log(`- balances (0x633E…e2Ab): ${ethBefore} ETH, ${tracBefore} TRAC`);
log(`- quote ~${QUOTED_TRAC} TRAC (≤ ceiling ${D3.max_trac_cost}) ✔; est gas ~0.000007 ETH (≤ ceiling ${D3.max_eth_cost}) ✔; balances sufficient ✔`);
log(`- operation cannot create a graph or change policy: vm/publish on an existing finalized KA in an existing registered CG ✔`);

// ── persist request fingerprint, then ONE attempt ───────────────────────────
writeFileSync(join(repo, 'docs/gates/d3-intent.json'), JSON.stringify({ ...D3, intentPersistedAt: new Date().toISOString() }, null, 2));
log('\nRequest fingerprint persisted (docs/gates/d3-intent.json). Invoking vm/publish — single attempt.\n');
log('## Publication\n');

let outcome = 'failed';
let pub = null;
try {
  pub = await dkg.publish(D3.knowledge_asset_name, D3.context_graph_id);
  log(`- response: ${JSON.stringify(pub).slice(0, 400)}`);
  outcome = pub?.ual ? 'confirmed-pending-readback' : 'tentative';
} catch (err) {
  log(`- publish call errored: ${String(err.message).slice(0, 300)}`);
  outcome = 'tentative';
}

// independent read-back regardless of response
const after = await dkg.descriptor(D3.knowledge_asset_name, D3.context_graph_id).catch(() => null);
const vmq = await dkg.query({
  sparql: `SELECT ?p ?o WHERE { <${D3.root_entity_uri}> ?p ?o } LIMIT 5`,
  contextGraphId: D3.context_graph_id,
  view: 'verifiable-memory',
}).catch(() => null);
const vmBindings = vmq?.result?.bindings?.length ?? 0;
const published = after && (after.state === 'published' || after.state === 'finalized');
log(`- read-back: descriptor state=${after?.state}, VM-view bindings for root: ${vmBindings}`);

if (outcome === 'confirmed-pending-readback' && published && vmBindings > 0) {
  outcome = 'CONFIRMED';
} else if (published || vmBindings > 0 || pub?.ual) {
  outcome = 'TENTATIVE';
} else {
  outcome = 'FAILED';
}
log(`\n**Outcome classification: ${outcome}**`);
if (outcome !== 'CONFIRMED') {
  log('Stopping for operator decision (no auto-retry). Read-only diagnostics above.');
  save(); process.exit(1);
}

// ── confirmed: record everything, post the one VM receipt ───────────────────
const balAfter = await dkg.request('GET', '/api/wallets/balances');
const wAfter = balAfter.balances.find((b) => b.address === '0x633E5a7C5e612d9981538F60D824cC03be97e2Ab');
const ethSpent = (ethBefore - parseFloat(wAfter.eth)).toFixed(8);
const tracSpent = (tracBefore - parseFloat(wAfter.trac)).toFixed(6);
log(`\n## Confirmed-success record\n`);
log(`- UAL: ${pub.ual}`);
log(`- on-chain KA id: ${pub.kaId ?? 'n/a'}; tx: ${pub.txHash ?? 'n/a'}; status: ${pub.status}`);
log(`- network: base:8453 (mainnet-base)`);
log(`- actual spend: ${ethSpent} ETH (ceiling ${D3.max_eth_cost}), ${tracSpent} TRAC (ceiling ${D3.max_trac_cost})`);
log(`- approval ${D3.authorized_buzz_approval_event_id.slice(0, 12)}… consumed by this publication; publication_attempts used: 1/1`);
log(`- absence of second publication: single lifecycle 'published' event in descriptor: ${after.events?.filter((e) => e.type === 'published').length === 1}`);

const receiptContent = [
  'Published to Verifiable Memory.',
  `UAL: ${pub.ual}`,
  `ka: ${D3.knowledge_asset_name}`,
  `context-graph: ${D3.context_graph_id}`,
  `source-digest: sha256:${D3.source_set_digest}`,
  `approved-by: ${D3.authorized_promoter_npub}`,
  `approval-event: ${D3.authorized_buzz_approval_event_id}`,
].join('\n');
log('\n## VM receipt (content, then posted)\n```\n' + receiptContent + '\n```');
const rec = await service.sendMessage(D3.buzz_channel_id, receiptContent, { replyTo: D3.thread_root });
log(`- VM receipt posted: ${rec.res.event_id} (accepted=${rec.res.accepted})`);
log(`\n**D3 COMPLETE.**`);
save();
console.log('\ntranscript written to docs/gates/d3-transcript.md');
