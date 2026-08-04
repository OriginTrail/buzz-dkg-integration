// WoT auto-capture v2 — three lanes, per the graph-engineering model:
//  1. PIN lane: pins every substantive thread -> @dkg daemon distills a joint
//     thread KA (root graph; the shared "decisions" record).
//  2. TRACE lane: writes ONE contribution KA per (author, thread) into that
//     participant's SUBGRAPH (ziga/openclaw/hermes/fizz/blackbox/utvoice/
//     jurij/t) — typed as buzz:AgentRun PRODUCED buzz:Claim, DERIVED_FROM the
//     exact Nostr events. This is the per-agent trace that answers WHY.
//  3. FORGE lane: NIP-34 events (patches 1617, issues 1621, statuses 1630-33)
//     -> KAs in the `forge` subgraph, linking commits to authors.
// Invariants (paper §Appendix): every claim carries its source events; every
// artifact carries its authoring run; superseded versions stay addressable.
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';

const HTTP = 'https://macbook-pro-8.tailb02f7e.ts.net';
const NODE = 'http://127.0.0.1:9200';
const CH = '91f4ca95-17bf-4d93-a335-13f51b40fb07';
const CG = '0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/web-of-trust';
const SERVICE = '181e08ed958919ec4732d0fa4e7daad8f4860bc25986f6db78f28735fec1bab1';
const STATE = `${os.homedir()}/buzz-dkg-integration/wot-autocapture-state.json`;
const POLL_MS = 30000, DEBOUNCE_S = 60, MIN_LEN = 25, LIT_CAP = 3800;

const SUBGRAPH = {
  '7b20d5265af65543': 'ziga', c8fa1cbbb89f29b2: 'openclaw', '61f6b0a99eb318d0': 'hermes',
  '1bb386989054b75c': 'fizz', f9c41f6a154e9d86: 'blackbox', '709214d461f3ebde': 'utvoice',
  '478c55f3790b78f3': 'jurij', '66d9520f11288342': 't',
  '21c430b77577d55f': 'brana', b4edf98fbc3b9557: 'fizz',
};
const sgOf = (pk) => Object.entries(SUBGRAPH).find(([p]) => pk.startsWith(p))?.[1] ?? null;

const sk = nip19.decode(readFileSync(`${os.homedir()}/Library/Application Support/xyz.block.buzz.app/identity.key`, 'utf8').trim()).data;
const NODE_TOKEN = readFileSync(`${os.homedir()}/.dkg-mainnet/auth.token`, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).pop().trim();
const log = (...a) => console.log(new Date().toISOString(), ...a);

function authHeader(url, method, body) {
  const now = Math.floor(Date.now() / 1000);
  const tags = [['u', url], ['method', method.toUpperCase()],
    ['nonce', createHash('sha256').update(`${Math.random()}${process.hrtime.bigint()}`).digest('hex').slice(0, 16)],
    ['payload', createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex')]];
  return `Nostr ${Buffer.from(JSON.stringify(finalizeEvent({ kind: 27235, created_at: now, tags, content: '' }, sk)), 'utf8').toString('base64')}`;
}
async function relay(path, body) {
  const url = `${HTTP}${path}`;
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: authHeader(url, 'post', body) }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status}: ${t.slice(0, 100)}`);
  try { return JSON.parse(t); } catch { return t; }
}
async function node(path, body, timeout = 120000) {
  const r = await fetch(`${NODE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${NODE_TOKEN}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status}: ${t.slice(0, 140)}`);
  try { return JSON.parse(t); } catch { return t; }
}
const rootOf = (e) => {
  let root, any;
  for (const t of e.tags || []) if (t[0] === 'e' && /^[0-9a-f]{64}$/.test(t[1] || '')) { any = any || t[1]; if (t[3] === 'root') root = t[1]; }
  return root || any || e.id;
};
const lit = (s) => JSON.stringify(String(s).slice(0, LIT_CAP));
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', SCHEMA = 'http://schema.org/', PROV = 'http://www.w3.org/ns/prov#', BUZZ = 'https://w3id.org/buzz-dkg/buzz#';

let state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
state.cursor ??= Math.floor(Date.now() / 1000) - 60;
state.forgeCursor ??= Math.floor(Date.now() / 1000) - 60;
state.roots ??= {}; state.traces ??= {}; state.forge ??= {};
const save = () => writeFileSync(STATE, JSON.stringify(state));

/** KA lifecycle into a subgraph: write -> finalize -> share. Idempotent upserts. */
async function writeKA(kaName, subGraphName, quads) {
  await node(`/api/knowledge-assets/${kaName}/wm/write`, { quads, contextGraphId: CG, subGraphName });
  await node(`/api/knowledge-assets/${kaName}/wm/finalize`, { contextGraphId: CG, subGraphName });
  await node(`/api/knowledge-assets/${kaName}/swm/share`, { contextGraphId: CG, subGraphName }, 180000);
}

/** TRACE lane: contribution KA for one (author, thread) — into the author's subgraph. */
async function writeTrace(sg, root, msgs) {
  const key = `${sg}:${root}`;
  const newest = Math.max(...msgs.map((m) => m.created_at));
  if ((state.traces[key] || 0) >= newest) return false;
  // Versioned: finalized assertions are sealed, so each debounced update is a
  // new addressable version (paper invariant: superseded objects remain addressable).
  const ka = `trace-${sg}-${root.slice(0, 10)}-${newest}`;
  const runU = `urn:buzz-dkg:run:${sg}:${root.slice(0, 12)}`;
  const q = [];
  const add = (s, p, o) => q.push({ subject: s, predicate: p, object: o });
  add(runU, `${RDF}type`, `${BUZZ}AgentRun`);
  add(runU, `${PROV}wasAssociatedWith`, `urn:buzz-dkg:participant:${sg}`);
  add(runU, `${BUZZ}thread`, `urn:nostr:event:${root}`);
  add(runU, `${BUZZ}messageCount`, `"${msgs.length}"^^<http://www.w3.org/2001/XMLSchema#integer>`);
  msgs.sort((a, b) => a.created_at - b.created_at).forEach((m, i) => {
    const cU = `urn:buzz-dkg:claim:${m.id.slice(0, 16)}`;
    add(runU, `${PROV}generated`, cU);
    add(cU, `${RDF}type`, `${BUZZ}Claim`);
    add(cU, `${SCHEMA}text`, lit(m.content));
    add(cU, `${SCHEMA}position`, `"${i}"^^<http://www.w3.org/2001/XMLSchema#integer>`);
    add(cU, `${PROV}wasDerivedFrom`, `urn:nostr:event:${m.id}`);
    add(cU, `${SCHEMA}dateCreated`, `"${new Date(m.created_at * 1000).toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`);
  });
  await writeKA(ka, sg, q);
  state.traces[key] = newest;
  log(`trace ${sg} <- ${msgs.length} claims (thread ${root.slice(0, 8)})`);
  return true;
}

/** FORGE lane: NIP-34 event -> KA in the `forge` subgraph. */
async function writeForge(e) {
  if (state.forge[e.id]) return false;
  const sg = sgOf(e.pubkey) || 'forge';
  const kindName = { 1617: 'Patch', 1621: 'Issue', 1630: 'StatusOpen', 1631: 'StatusApplied', 1632: 'StatusClosed', 1633: 'StatusDraft' }[e.kind] || `Kind${e.kind}`;
  const subj = (e.content.match(/^Subject: (.+)$/m)?.[1]) || e.content.slice(0, 120);
  const commit = e.content.match(/^From ([0-9a-f]{40})/m)?.[1];
  const u = `urn:buzz-dkg:forge:${e.id.slice(0, 16)}`;
  const q = [
    { subject: u, predicate: `${RDF}type`, object: `${BUZZ}${kindName}` },
    { subject: u, predicate: `${SCHEMA}name`, object: lit(subj) },
    { subject: u, predicate: `${PROV}wasAttributedTo`, object: `urn:buzz-dkg:participant:${sg}` },
    { subject: u, predicate: `${PROV}wasDerivedFrom`, object: `urn:nostr:event:${e.id}` },
    { subject: u, predicate: `${SCHEMA}dateCreated`, object: `"${new Date(e.created_at * 1000).toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>` },
  ];
  if (commit) q.push({ subject: u, predicate: `${BUZZ}commit`, object: `urn:git:commit:${commit}` });
  await writeKA(`forge-${e.id.slice(0, 12)}`, 'forge', q);
  state.forge[e.id] = 1;
  log(`forge <- ${kindName} by ${sg} ${subj.slice(0, 40)}`);
  return true;
}

async function tick() {
  const now = Math.floor(Date.now() / 1000);
  // ── chat lanes ──
  let events = [];
  try { events = await relay('/query', [{ kinds: [9, 40002], '#h': [CH], since: Math.max(0, state.cursor - 10) }]); } catch (e) { log('query err', String(e).slice(0, 80)); }
  const byRoot = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    if (e.pubkey === SERVICE) continue;
    const r = rootOf(e);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(e);
    if (e.created_at > state.cursor) state.cursor = e.created_at;
  }
  for (const [root, msgs] of byRoot) {
    const newest = Math.max(...msgs.map((m) => m.created_at));
    if (now - newest < DEBOUNCE_S) continue;
    const substantive = msgs.some((m) => (m.content || '').trim().length >= MIN_LEN);
    if (!substantive) continue;
    // PIN lane (joint record via daemon)
    if (newest > (state.roots[root] || 0)) {
      try {
        const ev = finalizeEvent({ kind: 40004, created_at: now, tags: [['h', CH], ['e', root]], content: '' }, sk);
        const res = await relay('/events', ev);
        if (res?.accepted) { state.roots[root] = newest; log('pinned', root.slice(0, 10)); }
      } catch (e) { log('pin err', String(e).slice(0, 60)); }
    }
    // TRACE lane (per-author subgraph)
    const byAuthor = new Map();
    for (const m of msgs) { const sg = sgOf(m.pubkey); if (!sg) continue; if (!byAuthor.has(sg)) byAuthor.set(sg, []); byAuthor.get(sg).push(m); }
    for (const [sg, ams] of byAuthor) {
      try { await writeTrace(sg, root, ams); } catch (e) {
        const msg = String(e);
        log('trace err', sg, msg.slice(0, 90));
        // A sealed/duplicate assertion means this exact (sg, root, newest)
        // version already exists — mark it consumed instead of retrying
        // forever on an immutable object.
        if (/500.*[Aa]ssert/.test(msg) || /already/i.test(msg)) {
          state.traces[`${sg}:${root}`] = Math.max(...ams.map((m) => m.created_at));
          log('trace skip (sealed)', sg, root.slice(0, 8));
        }
      }
    }
  }
  // ── forge lane ──
  try {
    const fe = await relay('/query', [{ kinds: [1617, 1621, 1630, 1631, 1632, 1633], since: Math.max(0, state.forgeCursor - 10) }]);
    for (const e of Array.isArray(fe) ? fe : []) {
      if (e.created_at > state.forgeCursor) state.forgeCursor = e.created_at;
      try { await writeForge(e); } catch (err) { log('forge err', String(err).slice(0, 90)); }
    }
  } catch (e) { log('forge query err', String(e).slice(0, 60)); }
  // ── decisions lane: mirror new DecisionClusters into the decisions subgraph ──
  try { await mirrorDecisions(); } catch (e) { log('decisions err', String(e).slice(0, 90)); }
  save();
}

/**
 * DECISIONS lane (operator mandate 2026-08-01): the daemon distills pinned
 * threads into DecisionClusters in the root SWM; mirror any cluster the
 * `decisions` subgraph has not seen yet (same subjects, so prov links keep
 * resolving). Runs at most once per DECISIONS_EVERY_MS.
 */
const DECISIONS_EVERY_MS = 5 * 60 * 1000;
let lastDecisionsRun = 0;
async function mirrorDecisions() {
  const nowMs = Date.now();
  if (nowMs - lastDecisionsRun < DECISIONS_EVERY_MS) return;
  lastDecisionsRun = nowMs;
  state.decisionsSeen ??= {};
  const q = async (view, sparqlQ) => {
    const res = await node('/api/query', { contextGraphId: CG, view, sparql: sparqlQ });
    return res.result?.bindings ?? [];
  };
  const term = (raw) => {
    if (typeof raw !== 'string') return String(raw);
    if (raw.startsWith('"')) { const c = raw.lastIndexOf('"'); return raw.slice(1, c).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\'); }
    return raw;
  };
  const SCHEMA = 'http://schema.org/', PROV = 'http://www.w3.org/ns/prov#';
  const rows = await q('shared-working-memory',
    `SELECT ?d ?name ?digest ?t ?ev WHERE { GRAPH ?g {
       ?d a <${BUZZ}DecisionCluster> .
       OPTIONAL { ?d <${SCHEMA}name> ?name }
       OPTIONAL { ?d <${BUZZ}sourceSetDigest> ?digest }
       OPTIONAL { ?d <${PROV}endedAtTime> ?t }
       OPTIONAL { ?d <${PROV}wasDerivedFrom> ?ev }
     } FILTER(!CONTAINS(STR(?g), "/decisions/")) } LIMIT 10000`);
  const byUri = new Map();
  for (const r of rows) {
    const uri = term(r.d);
    if (state.decisionsSeen[uri]) continue;
    if (!byUri.has(uri)) byUri.set(uri, { uri, name: r.name ? term(r.name) : null, digest: r.digest ? term(r.digest) : null, at: r.t ? term(r.t) : null, evs: new Set() });
    if (r.ev) byUri.get(uri).evs.add(term(r.ev));
  }
  if (byUri.size === 0) return;
  const quads = [];
  const addQ = (s, p, o) => quads.push({ subject: s, predicate: p, object: o });
  for (const d of byUri.values()) {
    addQ(d.uri, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `${BUZZ}DecisionCluster`);
    if (d.name) addQ(d.uri, `${SCHEMA}name`, lit(d.name));
    if (d.digest) addQ(d.uri, `${BUZZ}sourceSetDigest`, lit(d.digest));
    if (d.at) addQ(d.uri, `${PROV}endedAtTime`, `"${d.at}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`);
    for (const ev of [...d.evs].slice(0, 30)) addQ(d.uri, `${PROV}wasDerivedFrom`, ev);
  }
  const ka = `decisions-sync-${Math.floor(nowMs / 1000)}`;
  await writeKA(ka, 'decisions', quads);
  for (const uri of byUri.keys()) state.decisionsSeen[uri] = 1;
  log(`decisions <- ${byUri.size} new cluster(s) mirrored (${ka})`);
}

log(`WoT auto-capture v2 (pin+trace+forge) — signer ${getPublicKey(sk).slice(0, 12)}…`);
(async function loop() { for (;;) { try { await tick(); } catch (e) { log('tick err', String(e).slice(0, 100)); } await new Promise((r) => setTimeout(r, POLL_MS)); } })();
