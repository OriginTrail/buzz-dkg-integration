// Retroactively populate the `decisions` and `forge` subgraphs of the
// web-of-trust CG (operator mandate 2026-08-01).
//  • decisions: mirror every DecisionCluster already in SWM (deduped by
//    label, newest kept) into subGraphName 'decisions' — same subjects, so
//    existing prov links keep resolving.
//  • forge: one entity per commit of every repo hosted on the community git
//    (wot-knowledge-ui + the dkg mirror's mirror-event), typed buzz#Commit,
//    attributed to the matching participant subgraph.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import os from 'node:os';

const NODE = 'http://127.0.0.1:9200';
const CG = '0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/web-of-trust';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SCHEMA = 'http://schema.org/';
const PROV = 'http://www.w3.org/ns/prov#';
const BUZZ = 'https://w3id.org/buzz-dkg/buzz#';
const NODE_TOKEN = readFileSync(`${os.homedir()}/.dkg-mainnet/auth.token`, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).pop().trim();
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function node(path, body, timeout = 180000) {
  const r = await fetch(`${NODE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${NODE_TOKEN}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status}: ${t.slice(0, 140)}`);
  try { return JSON.parse(t); } catch { return t; }
}
async function sparql(view, query) {
  const res = await node('/api/query', { contextGraphId: CG, view, sparql: query });
  return res.result?.bindings ?? [];
}
function term(raw) {
  if (typeof raw !== 'string') return String(raw);
  if (raw.startsWith('"')) {
    const close = raw.lastIndexOf('"');
    return raw.slice(1, close).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  }
  return raw;
}
async function writeKA(kaName, subGraphName, quads) {
  await node(`/api/knowledge-assets/${kaName}/wm/write`, { quads, contextGraphId: CG, subGraphName });
  await node(`/api/knowledge-assets/${kaName}/wm/finalize`, { contextGraphId: CG, subGraphName });
  await node(`/api/knowledge-assets/${kaName}/swm/share`, { contextGraphId: CG, subGraphName }, 300000);
}
const lit = (s) => JSON.stringify(String(s).slice(0, 500));
const dateLit = (unix) => `"${new Date(unix * 1000).toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`;

// ── decisions ────────────────────────────────────────────────────────────────
const rows = await sparql('shared-working-memory',
  `SELECT ?d ?name ?digest ?t ?ev WHERE { GRAPH ?g {
     ?d a <${BUZZ}DecisionCluster> .
     OPTIONAL { ?d <${SCHEMA}name> ?name }
     OPTIONAL { ?d <${BUZZ}sourceSetDigest> ?digest }
     OPTIONAL { ?d <${PROV}endedAtTime> ?t }
     OPTIONAL { ?d <${PROV}wasDerivedFrom> ?ev }
   } } LIMIT 10000`);
const byUri = new Map();
for (const r of rows) {
  const uri = term(r.d);
  if (!byUri.has(uri)) {
    byUri.set(uri, {
      uri,
      name: r.name ? term(r.name) : null,
      digest: r.digest ? term(r.digest) : null,
      at: r.t ? term(r.t) : null,
      evs: new Set(),
    });
  }
  if (r.ev) byUri.get(uri).evs.add(term(r.ev));
}
// Dedupe versioned re-captures by name, keep newest.
const byName = new Map();
for (const d of byUri.values()) {
  const key = d.name ?? d.uri;
  const prev = byName.get(key);
  if (!prev || (d.at ?? '') > (prev.at ?? '')) byName.set(key, d);
}
const decisions = [...byName.values()];
log(`decisions: ${byUri.size} cluster rows -> ${decisions.length} deduped`);

const dq = [];
const add = (arr) => (s, p, o) => arr.push({ subject: s, predicate: p, object: o });
const dAdd = add(dq);
for (const d of decisions) {
  dAdd(d.uri, `${RDF}type`, `${BUZZ}DecisionCluster`);
  if (d.name) dAdd(d.uri, `${SCHEMA}name`, lit(d.name));
  if (d.digest) dAdd(d.uri, `${BUZZ}sourceSetDigest`, lit(d.digest));
  if (d.at) dAdd(d.uri, `${PROV}endedAtTime`, `"${d.at}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`);
  for (const ev of [...d.evs].slice(0, 30)) dAdd(d.uri, `${PROV}wasDerivedFrom`, ev);
}
const stamp = Math.floor(Date.now() / 1000);
if (dq.length > 0) {
  await writeKA(`decisions-retro-${stamp}`, 'decisions', dq);
  log(`decisions subgraph <- ${decisions.length} entities (${dq.length} quads)`);
}

// ── forge ────────────────────────────────────────────────────────────────────
const AUTHOR_SG = {
  blackbox: 'blackbox', hermes: 'hermes', openclaw: 'openclaw',
  'ziga drev': 'ziga', 'žiga': 'ziga', fizz: 'fizz', 'ut voice': 'utvoice',
};
const fq = [];
const fAdd = add(fq);
const repoUri = 'urn:buzz-dkg:repo:wot-knowledge-ui';
fAdd(repoUri, `${RDF}type`, `${BUZZ}Repository`);
fAdd(repoUri, `${SCHEMA}name`, lit('wot-knowledge-ui (community git)'));
fAdd(repoUri, `${SCHEMA}url`, lit('https://macbook-pro-8.tailb02f7e.ts.net/git/7b20d5265af65543cbe6192e1665f8f0730004622c111c381d163cde53ae5bc5/wot-knowledge-ui'));
const gitLog = execSync(
  `git -C ${os.homedir()}/buzz-dkg-integration/wot-knowledge-ui-clone log --format='%H|%an|%at|%s'`,
  { encoding: 'utf8' },
).trim().split('\n');
let commits = 0;
for (const line of gitLog) {
  const [sha, author, at, ...subj] = line.split('|');
  if (!sha) continue;
  const u = `urn:git:commit:${sha}`;
  const sg = AUTHOR_SG[author.toLowerCase()] ?? null;
  fAdd(u, `${RDF}type`, `${BUZZ}Commit`);
  fAdd(u, `${SCHEMA}name`, lit(subj.join('|')));
  fAdd(u, `${SCHEMA}dateCreated`, dateLit(Number(at)));
  fAdd(u, `${PROV}atLocation`, repoUri);
  if (sg) fAdd(u, `${PROV}wasAttributedTo`, `urn:buzz-dkg:participant:${sg}`);
  commits += 1;
}
// The dkg mirror itself, and the Buzz-side graph-view build, as forge facts.
const mirrorUri = 'urn:buzz-dkg:repo:dkg-mirror';
fAdd(mirrorUri, `${RDF}type`, `${BUZZ}Repository`);
fAdd(mirrorUri, `${SCHEMA}name`, lit('OriginTrail/dkg mirror (community git, auto-synced from upstream main every 10 min)'));
fAdd(mirrorUri, `${SCHEMA}url`, lit('https://macbook-pro-8.tailb02f7e.ts.net/git/7b20d5265af65543cbe6192e1665f8f0730004622c111c381d163cde53ae5bc5/dkg'));
fAdd(mirrorUri, `${PROV}wasAttributedTo`, 'urn:buzz-dkg:participant:ziga');
const gvUri = 'urn:buzz-dkg:build:dkg-memory-graph-view-v1';
fAdd(gvUri, `${RDF}type`, `${BUZZ}Commit`);
fAdd(gvUri, `${SCHEMA}name`, lit('buzz-desktop dkg-memory graph view v1: deterministic decision-spine canvas + GraphOverlay (panel expansion), 3-layer node tagging, /api/subgraph-graph explorer endpoint — per graph-view deliberation'));
fAdd(gvUri, `${SCHEMA}dateCreated`, dateLit(stamp));
fAdd(gvUri, `${PROV}wasAttributedTo`, 'urn:buzz-dkg:participant:ziga');
await writeKA(`forge-retro-${stamp}`, 'forge', fq);
log(`forge subgraph <- ${commits} commits + 2 repos + 1 build (${fq.length} quads)`);
log('RETRO POPULATION DONE');
