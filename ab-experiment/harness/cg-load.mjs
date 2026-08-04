// Load a task instance's corpus into a run-scoped WM subgraph of the CG.
// WM-only (write + finalize, NO swm/share): node-local, queryable through the
// working-memory view, never synced to community subscribers — run isolation
// without polluting Shared Working Memory.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const NODE = 'http://127.0.0.1:9200';
export const CG = '0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/web-of-trust';
const TOKEN = readFileSync(`${os.homedir()}/.dkg-mainnet/auth.token`, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).pop().trim();
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SCHEMA = 'http://schema.org/';
const BUZZ = 'https://w3id.org/buzz-dkg/buzz#';

async function node(path, body, t = 180000) {
  const r = await fetch(`${NODE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(t) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status}: ${txt.slice(0, 120)}`);
  try { return JSON.parse(txt); } catch { return txt; }
}

const lit = (s) => JSON.stringify(String(s).slice(0, 3800));

/**
 * Load corpus docs (and optional canary) for one run.
 * Each doc becomes one KA: schema:name = filename, schema:text = content,
 * plus per-line statement KAs so graph search hits individual facts AS
 * STATED (conflicts preserved — same information as the scrollback arm,
 * different access structure).
 */
export async function loadRunCorpus({ subgraph, taskDir, canaryToken }) {
  try { await node('/api/sub-graph/create', { contextGraphId: CG, subGraphName: subgraph }); }
  catch (e) { if (!/already|exists/i.test(String(e))) throw e; }

  const corpusDir = join(taskDir, 'corpus');
  const docs = readdirSync(corpusDir).sort();
  for (const doc of docs) {
    const content = readFileSync(join(corpusDir, doc), 'utf8');
    const kaName = `${subgraph}-${doc.replace(/[^a-zA-Z0-9]/g, '-')}`.toLowerCase();
    const u = `urn:pollen4:${subgraph}:doc:${doc}`;
    const quads = [
      { subject: u, predicate: `${RDF}type`, object: `${BUZZ}Document` },
      { subject: u, predicate: `${SCHEMA}name`, object: lit(doc) },
      { subject: u, predicate: `${SCHEMA}text`, object: lit(content) },
    ];
    // per-line statements for graph-granular retrieval
    content.split('\n').forEach((line, i) => {
      const t = line.trim();
      if (t.length < 8) return;
      const su = `${u}:l${i + 1}`;
      quads.push({ subject: su, predicate: `${RDF}type`, object: `${BUZZ}Statement` });
      quads.push({ subject: su, predicate: `${SCHEMA}text`, object: lit(`${doc}:${i + 1}: ${t}`) });
      quads.push({ subject: su, predicate: `${SCHEMA}isPartOf`, object: u });
    });
    await node(`/api/knowledge-assets/${kaName}/wm/write`, { quads, contextGraphId: CG, subGraphName: subgraph });
    await node(`/api/knowledge-assets/${kaName}/wm/finalize`, { contextGraphId: CG, subGraphName: subgraph });
  }
  if (canaryToken) {
    const u = `urn:pollen4:${subgraph}:canary`;
    const quads = [
      { subject: u, predicate: `${RDF}type`, object: `${BUZZ}Document` },
      { subject: u, predicate: `${SCHEMA}name`, object: lit('ops-addendum.md') },
      { subject: u, predicate: `${SCHEMA}text`, object: lit(`Supplementary operations note: reference code ${canaryToken} applies to this fleet.`) },
    ];
    await node(`/api/knowledge-assets/${subgraph}-canary/wm/write`, { quads, contextGraphId: CG, subGraphName: subgraph });
    await node(`/api/knowledge-assets/${subgraph}-canary/wm/finalize`, { contextGraphId: CG, subGraphName: subgraph });
  }
  return docs.length;
}

// CLI: node cg-load.mjs <subgraph> <taskDir> [canaryToken]
if (process.argv[2] && process.argv[3]) {
  const n = await loadRunCorpus({ subgraph: process.argv[2], taskDir: process.argv[3], canaryToken: process.argv[4] });
  console.log('loaded docs:', n);
}
