#!/usr/bin/env node
// Snapshot-pinned scoped CG query client for the CG-GROUNDED arm — exposed
// to agents as an MCP stdio server (spawned by buzz-acp via
// BUZZ_ACP_MCP_COMMAND). Scope: ONLY the run's WM subgraph (RUN_SUBGRAPH
// env). Read-only. This is regime B's sole data access; regime A never gets
// this server.
import { readFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';

const NODE = 'http://127.0.0.1:9200';
const CG = '0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/web-of-trust';
const SUB = process.env.RUN_SUBGRAPH;
const QLOG = process.env.RUN_QUERY_LOG; // audit trail per protocol
const TOKEN = readFileSync(`${os.homedir()}/.dkg-mainnet/auth.token`, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).pop().trim();

async function sparql(query) {
  const r = await fetch(`${NODE}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ contextGraphId: CG, view: 'working-memory', sparql: query }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`query ${r.status}`);
  return (await r.json()).result?.bindings ?? [];
}
const term = (raw) => {
  if (typeof raw !== 'string') return String(raw);
  if (raw.startsWith('"')) { const c = raw.lastIndexOf('"'); return raw.slice(1, c).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\'); }
  return raw;
};
const esc = (s) => s.toLowerCase().replace(/[\\"]/g, '');

async function cgSearch(query) {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1).slice(0, 6);
  if (words.length === 0) return 'Empty query.';
  const filters = words.map((w) => `CONTAINS(LCASE(?t), "${esc(w)}")`).join(' && ');
  const rows = await sparql(
    `SELECT ?t WHERE { GRAPH ?g { ?s <http://schema.org/text> ?t .
       ?s a <https://w3id.org/buzz-dkg/buzz#Statement> . FILTER(${filters}) }
       FILTER(CONTAINS(STR(?g), "/${SUB}/")) } LIMIT 20`);
  if (rows.length === 0) {
    // fall back to any-word match
    const anyF = words.map((w) => `CONTAINS(LCASE(?t), "${esc(w)}")`).join(' || ');
    const rows2 = await sparql(
      `SELECT ?t WHERE { GRAPH ?g { ?s <http://schema.org/text> ?t .
         ?s a <https://w3id.org/buzz-dkg/buzz#Statement> . FILTER(${anyF}) }
         FILTER(CONTAINS(STR(?g), "/${SUB}/")) } LIMIT 20`);
    if (rows2.length === 0) return 'No matching statements in team memory.';
    return rows2.map((r) => term(r.t)).join('\n');
  }
  return rows.map((r) => term(r.t)).join('\n');
}

async function cgListDocs() {
  const rows = await sparql(
    `SELECT ?n WHERE { GRAPH ?g { ?s a <https://w3id.org/buzz-dkg/buzz#Document> ;
       <http://schema.org/name> ?n } FILTER(CONTAINS(STR(?g), "/${SUB}/")) } LIMIT 50`);
  return [...new Set(rows.map((r) => term(r.n)))].join('\n') || 'No documents.';
}

async function cgRead(doc) {
  const rows = await sparql(
    `SELECT ?t WHERE { GRAPH ?g { ?s a <https://w3id.org/buzz-dkg/buzz#Document> ;
       <http://schema.org/name> "${doc.replace(/[\\"]/g, '')}" ;
       <http://schema.org/text> ?t } FILTER(CONTAINS(STR(?g), "/${SUB}/")) } LIMIT 1`);
  return rows.length ? term(rows[0].t) : `No document named ${doc}. Use cg_list_docs first.`;
}

const TOOLS = [
  { name: 'cg_search', description: 'Search the team memory graph for statements matching keywords. Returns matching statements with their source doc and line.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'keywords' } }, required: ['query'] } },
  { name: 'cg_list_docs', description: 'List the documents available in team memory.', inputSchema: { type: 'object', properties: {} } },
  { name: 'cg_read', description: 'Read one full document from team memory by exact name.', inputSchema: { type: 'object', properties: { doc: { type: 'string' } }, required: ['doc'] } },
];

let buf = '';
process.stdin.on('data', async (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    try {
      if (msg.method === 'initialize') {
        reply({ protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cg-query', version: '1.0.0' } });
      } else if (msg.method === 'tools/list') {
        reply({ tools: TOOLS });
      } else if (msg.method === 'tools/call') {
        const { name, arguments: args = {} } = msg.params;
        if (QLOG) appendFileSync(QLOG, JSON.stringify({ at: Date.now(), name, args }) + '\n');
        let text;
        if (name === 'cg_search') text = await cgSearch(args.query ?? '');
        else if (name === 'cg_list_docs') text = await cgListDocs();
        else if (name === 'cg_read') text = await cgRead(args.doc ?? '');
        else text = `Unknown tool ${name}`;
        reply({ content: [{ type: 'text', text }] });
      } else if (msg.id !== undefined) {
        reply({});
      }
    } catch (e) {
      if (msg.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(e).slice(0, 200) } }) + '\n');
    }
  }
});
