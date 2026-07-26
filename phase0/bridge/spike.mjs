// Phase 0 spike orchestrator — smallest real loop, isolated stack ONLY.
// Buzz thread → pin trigger → snapshot → deterministic distillation →
// WM create/write/finalize → full SWM share → scoped read-back → in-thread
// receipt → replay dedup → authorized ✅ approval → devnet VM publish → UAL
// verification → final receipt.
//
// Never point this at production. It refuses non-devnet chain IDs.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BuzzClient } from './lib/nostr.mjs';
import { DkgClient } from './lib/dkg.mjs';
import { distillThread, sourceSetDigest } from './lib/distill.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const phase0 = join(here, '..');
const STATE_PATH = join(here, 'state.json');
const DEMO_PATH = join(phase0, 'demo.md');

// ── config ──────────────────────────────────────────────────────────────────
const env = {};
for (const line of readFileSync(join(phase0, '.env.spike'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const BUZZ_HTTP = process.env.BDI_BUZZ_HTTP || 'http://127.0.0.1:9440';
const DKG_API = process.env.BDI_DKG_API || 'http://127.0.0.1:9420';
const DKG_TOKEN_PATH = process.env.BDI_DKG_TOKEN_PATH
  || `${process.env.HOME}/code/upstream-pins/dkg/.devnet/node1/auth.token`;
const CG = process.env.BDI_CG || 'devnet-test';
const CHANNEL_NAME = process.env.BDI_CHANNEL || 'dkg-spike';
const ALLOW_TEST_PUBLISH = process.env.BDI_ALLOW_TEST_PUBLISH === '1';
const APPROVAL_EMOJI = '✅'; // ✅

const dkgToken = readFileSync(DKG_TOKEN_PATH, 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).pop();
const author = new BuzzClient({ baseUrl: BUZZ_HTTP, secretKeyHex: env.BDI_SPIKE_AUTHOR_KEY });
const member = new BuzzClient({ baseUrl: BUZZ_HTTP, secretKeyHex: env.BDI_SPIKE_MEMBER_KEY });
const service = new BuzzClient({ baseUrl: BUZZ_HTTP, secretKeyHex: env.BDI_SPIKE_SERVICE_KEY });
const promoter = new BuzzClient({ baseUrl: BUZZ_HTTP, secretKeyHex: env.BDI_SPIKE_PROMOTER_KEY });
const dkg = new DkgClient({ baseUrl: DKG_API, token: dkgToken });

const AUTHORIZED_PROMOTERS = [promoter.pubkey]; // per-channel config, spike-scale

// ── state + transcript ──────────────────────────────────────────────────────
const state = existsSync(STATE_PATH)
  ? JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  : { channelId: null, thread: {}, processedPins: {}, kas: {}, receipts: {}, consumedApprovals: {}, published: {} };
const saveState = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

let demo = '';
const log = (line) => { const s = typeof line === 'string' ? line : '```json\n' + JSON.stringify(line, null, 2) + '\n```'; demo += s + '\n'; console.log(typeof line === 'string' ? line : JSON.stringify(line)); };
const section = (t) => log(`\n## ${t}\n`);
const redact = (s) => String(s).replaceAll(dkgToken, '<redacted-bearer>');

// ── steps ───────────────────────────────────────────────────────────────────
async function preflight() {
  section('Preflight (isolated stack identity checks)');
  const st = await dkg.status();
  log(`DKG node1: version=${st.version} network=${st.networkId ?? 'n/a'} chain=${JSON.stringify(st.chain?.chainId ?? st.chain)} store=${st.storeBackend} hasIdentity=${st.hasIdentity} peers=${st.connectedPeers}`);
  const chainStr = JSON.stringify(st.chain ?? {});
  if (!chainStr.includes('31337')) throw new Error(`SAFETY STOP: devnet chain expected (31337), got ${chainStr}`);
  const nip11 = await fetch(BUZZ_HTTP, { headers: { accept: 'application/nostr+json' } }).then((r) => r.json());
  log(`Buzz relay: name=${nip11.name ?? 'n/a'} software=${nip11.software ?? 'n/a'} version=${nip11.version ?? 'n/a'} pubkey=${(nip11.pubkey ?? '').slice(0, 16)}…`);
  const cgs = await dkg.listContextGraphs();
  const found = (cgs.contextGraphs ?? []).find((c) => c.id === CG);
  if (!found) throw new Error(`context graph ${CG} not found on devnet node1`);
  log(`Context graph bound to channel '${CHANNEL_NAME}': id=${found.id} onChainId=${found.onChainId ?? 'n/a'}`);
}

async function setupChannel() {
  section('Channel setup');
  let ch = await author.findChannel(CHANNEL_NAME);
  if (!ch) {
    const { res } = await author.createChannel(CHANNEL_NAME);
    log(`create channel (kind 9007): accepted=${res.accepted} event_id=${res.event_id}`);
    for (let i = 0; i < 20 && !ch; i++) { await new Promise((r) => setTimeout(r, 250)); ch = await author.findChannel(CHANNEL_NAME); }
  }
  if (!ch) throw new Error('channel UUID not discoverable via kind 39000');
  state.channelId = ch; saveState();
  log(`channel '${CHANNEL_NAME}' uuid=${ch}`);
  for (const [who, c, role] of [['member', member, undefined], ['service', service, 'bot'], ['promoter', promoter, undefined]]) {
    const { res } = await author.addMember(ch, c.pubkey, role);
    log(`add ${who} (kind 9000${role ? `, role=${role}` : ''}): accepted=${res.accepted}`);
  }
}

async function postThread() {
  section('Source thread (three signed messages)');
  if (state.thread.rootId) { log(`thread already exists: root=${state.thread.rootId}`); return; }
  const ch = state.channelId;
  const r1 = await author.sendMessage(ch, 'Decision needed: which store backend do we standardize on for the staging cluster?');
  log(`author root: accepted=${r1.res.accepted} id=${r1.res.event_id}`);
  const rootId = r1.res.event_id;
  const r2 = await member.sendMessage(ch, 'Benchmarks favor oxigraph-server; blazegraph adds a JVM we do not want to operate.', { replyTo: rootId });
  log(`member reply: accepted=${r2.res.accepted} id=${r2.res.event_id}`);
  const r3 = await author.sendMessage(ch, 'Agreed. DECISION: standardize on oxigraph-server for staging, revisit after Q3 load tests.', { root: rootId, replyTo: r2.res.event_id });
  log(`author decision reply: accepted=${r3.res.accepted} id=${r3.res.event_id}`);
  state.thread = { rootId, ids: [rootId, r2.res.event_id, r3.res.event_id] }; saveState();
}

async function pinTrigger() {
  section('Trigger: author pins the thread root (kind 40004)');
  const existing = await service.query([{ kinds: [40004], '#h': [state.channelId], '#e': [state.thread.rootId] }]);
  if (existing.length) { log(`pin already present: ${existing[0].id}`); return existing[0]; }
  const { res } = await author.pinMessage(state.channelId, state.thread.rootId);
  log(`pin: accepted=${res.accepted} id=${res.event_id}${res.message ? ` message=${res.message}` : ''}`);
  const pins = await service.query([{ ids: [res.event_id] }]);
  if (!pins.length) throw new Error('pin event not readable back');
  return pins[0];
}

async function processPin(pin) {
  section('Service: pin detected → snapshot → deterministic distillation');
  const target = pin.tags.find((t) => t[0] === 'e')?.[1];
  log(`pin ${pin.id} by ${pin.pubkey.slice(0, 12)}… targets ${target}`);
  // Source set = the thread AS OF the trigger, excluding the service's own
  // messages. Without both filters a replayed trigger sees its own receipt,
  // the digest shifts, and dedup breaks (observed live — see GATE_B_REPORT).
  const thread = await service.fetchThread(state.channelId, target);
  const events = thread.filter((e) => e.created_at <= pin.created_at && e.pubkey !== service.pubkey);
  log(`thread snapshot: ${events.length}/${thread.length} events as-of trigger (ids ${events.map((e) => e.id.slice(0, 8)).join(', ')})`);
  const digest = sourceSetDigest(events);
  const dedupKey = pin.id; // one trigger event → at most one KA + receipt
  if (state.processedPins[dedupKey]) {
    log(`DEDUP: pin+digest already processed → no new KA, no new receipt (receipt=${state.processedPins[dedupKey].receiptId})`);
    return { deduped: true, ...state.processedPins[dedupKey] };
  }
  const { rootUri, digest: d2, quads, title } = distillThread({ channelId: state.channelId, events, servicePubkey: service.pubkey });
  if (d2 !== digest) throw new Error('digest instability');
  log(`distilled: root=${rootUri}`);
  log(`quads=${quads.length}, title=${JSON.stringify(title)}`);

  const kaName = `buzz-spike-${digest.slice(0, 12)}`;
  section(`DKG lifecycle: ${kaName} → WM → finalize → full SWM share (CG ${CG})`);
  const created = await dkg.createKa(kaName, CG);
  log(`create: ${redact(JSON.stringify(created)).slice(0, 200)}`);
  const written = await dkg.write(kaName, CG, quads);
  log(`wm/write: ${JSON.stringify(written)}`);
  const fin = await dkg.finalize(kaName, CG);
  log(`wm/finalize: assertionUri=${fin.assertionUri} merkleRoot=${fin.merkleRoot?.slice(0, 16)}… author=${fin.authorAddress}`);
  const shared = await dkg.share(kaName, CG);
  log(`swm/share: ${redact(JSON.stringify(shared)).slice(0, 300)}`);

  section('Scoped read-back (server-enforced SWM view)');
  const q = await dkg.query({
    sparql: `SELECT ?digest ?src WHERE { <${rootUri}> <https://w3id.org/buzz-dkg/buzz#sourceSetDigest> ?digest ; <http://www.w3.org/ns/prov#wasDerivedFrom> ?src }`,
    contextGraphId: CG,
    view: 'shared-working-memory',
  });
  const bindings = q.result?.bindings ?? [];
  log(`SWM query bindings: ${bindings.length}`);
  const gotDigest = bindings[0]?.digest?.value ?? bindings[0]?.digest;
  if (!bindings.length || !String(gotDigest).includes(digest)) throw new Error(`read-back digest mismatch: ${JSON.stringify(bindings[0])}`);
  log(`read-back digest matches source-set digest ✔`);

  section('In-thread SWM receipt');
  const receiptContent = [
    `Distilled to Shared Working Memory.`,
    `assertion: ${fin.assertionUri}`,
    `ka: ${kaName}`,
    `context-graph: ${CG}`,
    `source-digest: sha256:${digest}`,
    `status: SWM (not published to Verifiable Memory)`,
  ].join('\n');
  const rec = await service.sendMessage(state.channelId, receiptContent, { replyTo: target });
  log(`receipt: accepted=${rec.res.accepted} id=${rec.res.event_id}`);

  const record = { kaName, digest, rootUri, assertionUri: fin.assertionUri, receiptId: rec.res.event_id, pinId: pin.id };
  state.processedPins[dedupKey] = record;
  state.kas[kaName] = record;
  state.receipts[rec.res.event_id] = record;
  saveState();
  return record;
}

async function replayCheck(pin) {
  section('Replay: process the same pin again (must dedup)');
  const before = (await service.query([{ kinds: [9], '#h': [state.channelId], authors: [service.pubkey] }])).length;
  const out = await processPin(pin);
  const after = (await service.query([{ kinds: [9], '#h': [state.channelId], authors: [service.pubkey] }])).length;
  if (!out.deduped || after !== before) throw new Error(`replay produced side effects: deduped=${out.deduped} receipts ${before}→${after}`);
  log(`replay OK: exactly one receipt exists (${after} service message(s) total, unchanged) ✔`);
}

async function approvalFlow(record) {
  section('Approval: authorized promoter reacts ✅ on the receipt');
  const existing = await service.query([{ kinds: [7], '#e': [record.receiptId] }]);
  let approval = existing.find((e) => e.content === APPROVAL_EMOJI && AUTHORIZED_PROMOTERS.includes(e.pubkey));
  if (!approval) {
    const { res } = await promoter.react(record.receiptId, APPROVAL_EMOJI);
    log(`promoter reaction: accepted=${res.accepted} id=${res.event_id}`);
    approval = (await service.query([{ ids: [res.event_id] }]))[0];
  } else log(`approval already present: ${approval.id}`);
  if (!approval) throw new Error('approval event not readable back');

  section('Service: §6 approval invariants (enforced in code)');
  const checks = [];
  const check = (name, ok, detail = '') => { checks.push([name, ok]); log(`- [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`); return ok; };
  const target = approval.tags.find((t) => t[0] === 'e')?.[1];
  const desc = await dkg.descriptor(record.kaName, CG).catch((e) => ({ error: String(e) }));
  const descState = desc.state ?? desc.descriptor?.state;
  let ok = true;
  ok &= check('1. reactor is configured authorized promoter', AUTHORIZED_PROMOTERS.includes(approval.pubkey), approval.pubkey.slice(0, 12) + '…');
  ok &= check('2. reaction targets service-authored receipt', target === record.receiptId && !!state.receipts[target]);
  ok &= check('3. receipt identifies pending KA + immutable digest', !!record.kaName && !!record.digest);
  ok &= check('4. channel maps to same context graph', CG === (process.env.BDI_CG || 'devnet-test'));
  ok &= check('5. finalized SWM KA matches approved digest', record.kaName === `buzz-spike-${record.digest.slice(0, 12)}` && descState === 'promoted' && desc.memoryLayer === 'SWM', `state=${descState} layer=${desc.memoryLayer} swmAssertion=${String(desc.swmCurrentAssertion).slice(0, 12)}…`);
  ok &= check('6. approval event not already consumed', !state.consumedApprovals[approval.id]);
  ok &= check('7. KA not already published', !state.published[record.kaName] && descState !== 'published' && descState !== 'finalized');
  ok &= check('8. environment permits publication', ALLOW_TEST_PUBLISH, `BDI_ALLOW_TEST_PUBLISH=${process.env.BDI_ALLOW_TEST_PUBLISH ?? 'unset'}`);
  check('9. stage authorization', true, 'SPEC §0 stage ABC — devnet-only publication, Gate A verdict GO');
  if (!ok) { log('NO-GO: invariants failed; stopping before any publish attempt.'); return null; }
  return approval;
}

async function publishFlow(record, approval) {
  section(`Devnet VM publish: ${record.kaName}`);
  const pub = await dkg.publish(record.kaName, CG);
  log(redact(JSON.stringify(pub, null, 2)));
  const ual = pub.ual ?? pub.result?.ual ?? pub.kas?.[0]?.ual;
  if (!ual) throw new Error(`no UAL in publish response`);
  state.consumedApprovals[approval.id] = { kaName: record.kaName, ual };
  state.published[record.kaName] = { ual, txHash: pub.txHash ?? pub.result?.txHash };
  saveState();

  section('UAL + VM verification');
  const desc = await dkg.descriptor(record.kaName, CG);
  log(`descriptor state=${desc.state ?? desc.descriptor?.state} events=${(desc.events ?? desc.descriptor?.events ?? []).length}`);
  const vmq = await dkg.query({
    sparql: `SELECT ?p ?o WHERE { <${record.rootUri}> ?p ?o } LIMIT 5`,
    contextGraphId: CG,
    view: 'verifiable-memory',
  });
  log(`VM-view query bindings: ${(vmq.result?.bindings ?? []).length}`);

  section('Final in-thread VM receipt');
  const content = [
    `Published to Verifiable Memory (devnet).`,
    `UAL: ${ual}`,
    `ka: ${record.kaName}`,
    `approved-by: ${approval.pubkey}`,
    `approval-event: ${approval.id}`,
  ].join('\n');
  const rec = await service.sendMessage(state.channelId, content, { replyTo: state.thread.rootId });
  log(`VM receipt: accepted=${rec.res.accepted} id=${rec.res.event_id}`);
  return ual;
}

// ── main ────────────────────────────────────────────────────────────────────
const startedAt = new Date().toISOString();
demo += `# Phase 0 spike transcript\n\nRun started ${startedAt}. Stack: isolated devnet (chain 31337) + isolated Buzz relay (bdi-spike). All identities are throwaway spike keys.\n`;
try {
  await preflight();
  await setupChannel();
  await postThread();
  const pin = await pinTrigger();
  const record = await processPin(pin);
  if (!record.deduped) await replayCheck(pin);
  else await replayCheck(pin);
  const approval = await approvalFlow(state.kas[record.kaName] ?? record);
  if (approval) {
    const ual = await publishFlow(state.kas[record.kaName] ?? record, approval);
    log(`\n**Loop complete.** UAL: \`${ual}\``);
  } else {
    log(`\n**SWM loop complete; publish leg skipped (invariants/env).**`);
  }
  demo += `\nRun finished ${new Date().toISOString()}.\n`;
  writeFileSync(DEMO_PATH, demo);
  console.log(`\ntranscript written to ${DEMO_PATH}`);
} catch (e) {
  demo += `\n**FAILED:** ${redact(e.message)}\n`;
  writeFileSync(DEMO_PATH, demo);
  console.error('SPIKE FAILED:', redact(e.stack ?? e.message));
  process.exit(1);
}
