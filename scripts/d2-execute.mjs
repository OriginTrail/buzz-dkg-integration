// Gate D2 — ONE operator-approved production SWM share, per SPEC Stage D2.
// Approval reference: "D2 approved, receipt posting included — operator in
// session 2026-07-26". Authority: exactly one lifecycle for the approved KA
// (create → write approved quads → finalize → full SWM share → verify) plus
// one in-thread receipt. NOTHING else: no VM publish, no wallet tx, no CG or
// policy changes, no second KA. On ambiguity: narrow read-back, never retry
// into a second name.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const { DkgClient } = await import(join(repo, 'src/dkg/client.ts'));
const { BuzzClient } = await import(join(repo, 'phase0/bridge/lib/nostr.mjs'));
const { snapshotSourceSet, sourceSetDigest } = await import(join(repo, 'src/distill/deterministic.ts'));

// ── approved values (D1 report §6; immutable) ───────────────────────────────
const APPROVED = {
  buzz_channel_id: '56059d1d-77bb-4d94-af79-97bb30547ac8',
  source_thread_root_event_id: '60fe7bc1f5263b06480101d567f06b74518fc69258f3712dfd46ddef6743e5ff',
  operator_approval_reference: 'D2 approved, receipt posting included — operator in session 2026-07-26',
  context_graph_id: '0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026',
  knowledge_asset_name: 'buzz-dkg-8a4599b36c1d',
  root_entity_uri: 'urn:buzz-dkg:decision:8a4599b36c1d845301edbf0cfb66fc598c998caa3d781ffcb53b1c3135194c00',
  source_event_ids: [
    '60fe7bc1f5263b06480101d567f06b74518fc69258f3712dfd46ddef6743e5ff',
    'fb88df35fbe4761a49f13733fe407dfe72706fce9b243e438e5a269b327898b1',
  ],
  source_set_digest: '8a4599b36c1d845301edbf0cfb66fc598c998caa3d781ffcb53b1c3135194c00',
  rdf_payload_sha256: 'bdba39725d73a724d07d80304ab8b8fe700d172fa8cc847ab783adac98228bd9',
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

let out = `# Gate D2 execution transcript\n\nDate: ${new Date().toISOString()}. Approval: ${APPROVED.operator_approval_reference}. Bearer token redacted.\n`;
const log = (s) => { out += s + '\n'; console.log(s); };
const die = (msg) => { log(`\n**NO-GO / ABORT:** ${msg}`); writeFileSync(join(repo, 'docs/gates/d2-transcript.md'), out); process.exit(1); };

// ── preflight (read-only) ───────────────────────────────────────────────────
log('\n## Preflight (read-only)\n');
const st = await dkg.status();
if (st.chain?.chainId !== 'base:8453') die(`unexpected chain ${st.chain?.chainId}`);
log(`- node health: ${st.name} v${st.version}, chain base:8453, peers ${st.connectedPeers}, hasIdentity ${st.hasIdentity} ✔`);

// Narrow routes (the broad list route has a scan budget and 500s — observed live).
const cgEnc = encodeURIComponent(APPROVED.context_graph_id);
const ex = await dkg.request('GET', `/api/context-graph/exists?id=${cgEnc}`);
if (!ex.exists) die('approved context graph not found');
const parts = await dkg.request('GET', `/api/context-graph/${cgEnc}/participants`);
const allowed = parts.allowedAgents ?? [];
if (!allowed.includes('0x633E5a7C5e612d9981538F60D824cC03be97e2Ab')) die('caller wallet no longer an allowed agent');
log(`- target CG exists; caller wallet is among ${allowed.length} allowed agents (curator) ✔`);

let exists = null;
try { exists = await dkg.descriptor(APPROVED.knowledge_asset_name, APPROVED.context_graph_id); } catch (e) { if (e.status !== 404 && e.status !== 400) throw e; }
if (exists && exists.state && exists.state !== 'discarded') die(`KA name already exists (state=${exists.state}) — duplicate prevention`);
log(`- KA name '${APPROVED.knowledge_asset_name}' absent from CG (duplicate prevention) ✔`);

const payload = JSON.parse(readFileSync(join(repo, 'docs/gates/d2-proposed-payload.json'), 'utf8'));
// The D1 report hash (bdba3972…) was computed over the ASCII-escaped compact
// serialization (python json.dumps default); raw UTF-8 serialization of the
// SAME quads yields 0244076d…. Both are equivalent fingerprints of the
// operator-reviewed payload file (git-clean at the approved commit 6d7f38d).
const rawSha = createHash('sha256').update(JSON.stringify(payload.quads), 'utf8').digest('hex');
const asciiSha = createHash('sha256')
  .update(JSON.stringify(payload.quads).replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')), 'utf8')
  .digest('hex');
if (asciiSha !== APPROVED.rdf_payload_sha256) die(`payload hash mismatch: ascii=${asciiSha} raw=${rawSha}`);
log(`- approved payload: ${payload.quads.length} quads; ascii-serialization sha ${asciiSha} matches approval (raw-utf8 form: ${rawSha}) ✔`);

const thread = await service.fetchThread(APPROVED.buzz_channel_id, APPROVED.source_thread_root_event_id);
const snap = snapshotSourceSet(thread, { created_at: Math.floor(Date.now() / 1000), pubkey: 'preflight' }, service.pubkey);
const liveDigest = sourceSetDigest(snap);
if (snap.length !== 2 || liveDigest !== APPROVED.source_set_digest) {
  die(`source thread drifted: ${snap.length} events, digest ${liveDigest} (approved ${APPROVED.source_set_digest})`);
}
const idsOk = APPROVED.source_event_ids.every((id) => snap.some((e) => e.id === id));
if (!idsOk) die('source event ids mismatch');
log(`- source thread re-fetched: 2 events, ids match, authors [${[...new Set(snap.map((e) => e.pubkey.slice(0, 12)))].join(', ')}…], live digest matches approved digest ✔`);
log(`- idempotency state: fresh KA name (digest-derived); no prior D2 operation recorded ✔`);

// ── operation plan (printed before first write, per spec) ───────────────────
log('\n## Operation plan (resolved identifiers, printed before any write)\n');
log(`1. POST /api/knowledge-assets                       {name: ${APPROVED.knowledge_asset_name}, contextGraphId: <CG>}`);
log(`2. POST /api/knowledge-assets/<name>/wm/write       ${payload.quads.length} approved quads (sha ${asciiSha.slice(0, 16)}…)`);
log(`3. POST /api/knowledge-assets/<name>/wm/finalize    seal (merkle root + EIP-712)`);
log(`4. POST /api/knowledge-assets/<name>/swm/share      full-KA atomic share into <CG>`);
log(`5. verify: descriptor state=promoted/SWM + scoped SWM query for root+digest + no VM UAL`);
log(`6. one kind-9 receipt in dkg-test replying to ${APPROVED.source_thread_root_event_id.slice(0, 12)}… (approval covers posting)`);
log(`CG = ${APPROVED.context_graph_id}`);
log(`Expected coordinate = did:dkg:context-graph:${APPROVED.context_graph_id}/assertion/<caller-agent>/${APPROVED.knowledge_asset_name}`);

// ── lifecycle (with read-back on any ambiguity) ─────────────────────────────
log('\n## Lifecycle execution\n');
const readBack = () => dkg.descriptor(APPROVED.knowledge_asset_name, APPROVED.context_graph_id).catch(() => null);
try {
  const created = await dkg.createKa(APPROVED.knowledge_asset_name, APPROVED.context_graph_id);
  log(`- create: ${JSON.stringify(created).slice(0, 220)}`);
  const written = await dkg.write(APPROVED.knowledge_asset_name, APPROVED.context_graph_id, payload.quads);
  log(`- wm/write: ${JSON.stringify(written)}`);
  const fin = await dkg.finalize(APPROVED.knowledge_asset_name, APPROVED.context_graph_id);
  log(`- wm/finalize: assertionUri=${fin.assertionUri} merkleRoot=${fin.merkleRoot} author=${fin.authorAddress}`);
  const shared = await dkg.share(APPROVED.knowledge_asset_name, APPROVED.context_graph_id);
  log(`- swm/share: ${JSON.stringify(shared).slice(0, 300)}`);
} catch (err) {
  log(`- lifecycle call failed/ambiguous: ${String(err.message).slice(0, 200)}`);
  const desc = await readBack();
  if (!desc || desc.state !== 'promoted') die(`read-back after failure: state=${desc?.state ?? 'absent'} — stopping (no blind retry, no second name)`);
  log(`- read-back shows state=promoted — treating as success`);
}

// ── verification ────────────────────────────────────────────────────────────
log('\n## Post-share verification (read-only)\n');
const desc = await readBack();
if (!desc) die('descriptor unreadable after share');
log(`- descriptor: state=${desc.state} layer=${desc.memoryLayer} swmAssertion=${desc.swmCurrentAssertion} events=${(desc.events ?? []).length} shareOpId=${desc.currentShareOperationId ?? 'n/a'}`);
if (desc.state !== 'promoted' || desc.memoryLayer !== 'SWM') die(`unexpected lifecycle state`);
const q = await dkg.query({
  sparql: `SELECT ?digest ?src WHERE { <${APPROVED.root_entity_uri}> <https://w3id.org/buzz-dkg/buzz#sourceSetDigest> ?digest ; <http://www.w3.org/ns/prov#wasDerivedFrom> ?src }`,
  contextGraphId: APPROVED.context_graph_id,
  view: 'shared-working-memory',
});
const b = q.result?.bindings ?? [];
const gotDigest = String((b[0]?.digest)?.value ?? b[0]?.digest ?? '');
if (!b.length || !gotDigest.includes(APPROVED.source_set_digest)) die(`scoped SWM read-back missing root/digest (${b.length} bindings)`);
log(`- scoped SWM query: ${b.length} bindings; root carries the approved digest + prov:wasDerivedFrom chain ✔`);
log(`- no VM publication: descriptor state is 'promoted' (not published/finalized); no UAL minted; reservedUal (pre-publish only): ${desc.reservedUal ?? 'n/a'} ✔`);

// ── receipt (approval covers posting) ───────────────────────────────────────
log('\n## In-thread receipt (content shown, then posted)\n');
const receipt = [
  'Distilled to Shared Working Memory.',
  `assertion: ${desc.assertionGraph ?? `did:dkg:context-graph:${APPROVED.context_graph_id}/assertion/${desc.agentAddress}/${APPROVED.knowledge_asset_name}`}`,
  `ka: ${APPROVED.knowledge_asset_name}`,
  `context-graph: ${APPROVED.context_graph_id}`,
  `source-digest: sha256:${APPROVED.source_set_digest}`,
  `approval: ${APPROVED.operator_approval_reference}`,
  'status: SWM (not published to Verifiable Memory)',
].join('\n');
log('```\n' + receipt + '\n```');
const rec = await service.sendMessage(APPROVED.buzz_channel_id, receipt, { replyTo: APPROVED.source_thread_root_event_id });
log(`- receipt posted: event ${rec.res.event_id} (accepted=${rec.res.accepted})`);

log(`\n**D2 COMPLETE.** Identifiers for a future D3: ka=${APPROVED.knowledge_asset_name}, digest=${APPROVED.source_set_digest}, receipt=${rec.res.event_id}, swmAssertion=${desc.swmCurrentAssertion}.`);
writeFileSync(join(repo, 'docs/gates/d2-transcript.md'), out);
console.log('\ntranscript written to docs/gates/d2-transcript.md');
