// Gate D1 grounded dry run — production node, READ-ONLY, no-post mode.
// Runs the daemon's retrieval/validation pipeline (answerGrounded) against the
// designated FIFA context graph. No Buzz client is even imported: posting is
// impossible by construction. Every DKG query is logged with its scope.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const { DkgClient } = await import(join(repo, 'src/dkg/client.ts'));
const { answerGrounded } = await import(join(repo, 'src/ask/grounded.ts'));

const CG = '0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026';
const token = readFileSync(`${process.env.HOME}/.dkg-mainnet/auth.token`, 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).pop();

const dkg = new DkgClient({ baseUrl: 'http://127.0.0.1:9200', token });
const queryLog = [];
const origQuery = dkg.query.bind(dkg);
dkg.query = (opts) => {
  queryLog.push({ contextGraphId: opts.contextGraphId, view: opts.view, sparql: opts.sparql.replace(/\s+/g, ' ').trim().slice(0, 220) });
  return origQuery(opts);
};

let out = `# Gate D1 grounded dry-run transcript\n\nDate: ${new Date().toISOString()}. Node: okf-mainnet 127.0.0.1:9200 (Base mainnet). Graph scope for ALL retrieval: \`${CG}\`. Mode: no-post (no Buzz client imported; zero relay traffic). Bearer token redacted.\n`;
const questions = [
  ['FIFA-supported #1', 'what was the result of Argentina vs Austria?'],
  ['FIFA-supported #2', 'which teams played in the FIFA World Cup tournament?'],
  ['Unrelated (must refuse)', 'what is the office wifi password?'],
];

for (const [label, q] of questions) {
  const before = queryLog.length;
  const res = await answerGrounded(dkg, CG, q);
  const used = queryLog.slice(before);
  out += `\n## ${label}\n\nQ: ${q}\n\n`;
  out += `Result: **${res.kind.toUpperCase()}**\n\n`;
  if (res.kind === 'answer') {
    out += `Answer text (extractive, deterministic, no model):\n\n> ${res.text}\n\nEvidence records (citations, resolved in their own scoped view before acceptance):\n`;
    for (const e of res.evidence) out += `- \`${e.rootUri}\` (${e.view}) — ${e.description.slice(0, 90)}\n`;
  } else {
    out += `The pipeline refused before any generation (insufficient scoped evidence).\n`;
  }
  out += `\nQueries issued for this question (${used.length}):\n`;
  for (const u of used) out += `- view=\`${u.view}\` cg=\`${u.contextGraphId}\` — \`${u.sparql}\`\n`;
}

const scopes = new Set(queryLog.map((q) => q.contextGraphId));
out += `\n## Scope proof\n\nTotal queries: ${queryLog.length}. Distinct contextGraphId values queried: ${[...scopes].map((s) => `\`${s}\``).join(', ')} — ${scopes.size === 1 && scopes.has(CG) ? 'exactly the designated graph, nothing else ✔' : 'VIOLATION'}.\nServer-side enforcement note: /api/query rejects caller FROM clauses and out-of-scope GRAPH patterns with 400 (Gate A verified).\nBuzz proof: this script imports no relay client; no Buzz events were created.\n`;
writeFileSync(join(repo, 'docs/gates/d1-dryrun-transcript.md'), out);
console.log(out);
