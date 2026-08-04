// POLLEN-4 task battery generator — deterministic from MASTER_SEED, per the
// frozen JOINT PROTOCOL (WoT 2026-08-03 ~14:25, Blackbox wrap).
// 4 families × 3 matched variant-pairs × 2 arms = 24 task instances.
// Matched-not-identical: both members of a pair use the same generator
// params, different derived seeds. Answer keys are written to keys/ (SEALED
// until collection ends — never shipped to agents). Every instance dir gets
// a sha256 digest recorded in digests.json (locked into manifests + prereg).
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = new URL('.', import.meta.url).pathname;
const TASKS = join(ROOT, 'tasks');
const KEYS = join(ROOT, 'keys');
const MASTER_SEED = 20260803;

// mulberry32 — deterministic PRNG
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const shuffle = (r, arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const SERVICES = ['ledger-sync', 'quote-engine', 'auth-gateway', 'batch-indexer', 'event-router', 'doc-store', 'rate-limiter', 'schema-registry'];
const OWNERS = ['ana', 'bojan', 'cvetka', 'darko', 'eva', 'franc'];

// ── family i: conflict-notes ────────────────────────────────────────────────
// 3 agent notes about one system; 4 planted conflicts; rule: the note with
// the LATEST "as-of" header wins. Completion: every conflict listed with the
// winning value + winning source note ID.
function genConflictNotes(seed) {
  const r = rng(seed);
  const svcs = shuffle(r, SERVICES).slice(0, 6);
  const asOf = ['2026-06-01', '2026-06-15', '2026-07-01'];
  const noteIds = ['N1', 'N2', 'N3'];
  const facts = svcs.map((s) => ({
    svc: s,
    port: 9000 + Math.floor(r() * 900),
    version: `${1 + Math.floor(r() * 3)}.${Math.floor(r() * 10)}.${Math.floor(r() * 10)}`,
    owner: pick(r, OWNERS),
  }));
  // plant 4 conflicts: a fact varies across notes; latest note holds truth
  const conflictIdx = shuffle(r, facts.map((_, i) => i)).slice(0, 4);
  const fields = ['port', 'version', 'owner'];
  const conflicts = conflictIdx.map((fi) => {
    const field = pick(r, fields);
    const truth = facts[fi][field];
    const wrong = field === 'port' ? truth + 1 + Math.floor(r() * 20)
      : field === 'version' ? `${truth}`.replace(/\d+$/, (d) => `${(Number(d) + 1) % 10}`)
      : pick(r, OWNERS.filter((o) => o !== truth));
    const wrongNote = Math.floor(r() * 2); // N1 or N2 carry the stale value
    return { svc: facts[fi].svc, field, truth: String(truth), wrong: String(wrong), wrongNote: noteIds[wrongNote], winNote: 'N3' };
  });
  const notes = noteIds.map((id, ni) => {
    const lines = facts.map((f) => {
      const c = conflicts.find((c) => c.svc === f.svc);
      const val = (fld) => (c && c.field === fld && noteIds.indexOf(c.wrongNote) === ni) ? c.wrong : String(f[fld]);
      return `- ${f.svc}: port ${val('port')}, version ${val('version')}, owner ${val('owner')}`;
    });
    return `# Ops note ${id}\nas-of: ${asOf[ni]}\n\n${shuffle(rng(seed + ni), lines).join('\n')}\n`;
  });
  return {
    corpus: Object.fromEntries(notes.map((n, i) => [`note-${noteIds[i]}.md`, n])),
    task: `Three operators kept independent notes about the same fleet (note-N1..N3). Where notes disagree, the note with the LATEST as-of date is authoritative. Produce resolution.json: {"conflicts":[{"service","field","winning_value","winning_note"}]} listing EVERY disagreement. Completion: all planted conflicts found, none invented, winning values and note IDs correct.`,
    key: { conflicts: conflicts.map((c) => ({ service: c.svc, field: c.field, winning_value: c.truth, winning_note: c.winNote })) },
  };
}

// ── family ii: spec-reconciliation ──────────────────────────────────────────
// base spec + change request with 5 contradictions; 6 acceptance assertions.
function genSpecRecon(seed) {
  const r = rng(seed);
  const svc = pick(r, SERVICES);
  const params = [
    { k: 'max_payload_kb', base: 64 + Math.floor(r() * 64), cr: 256 + Math.floor(r() * 256), rule: 'cr' },
    { k: 'timeout_ms', base: 500 + Math.floor(r() * 500), cr: 2000 + Math.floor(r() * 1000), rule: 'cr' },
    { k: 'retry_count', base: 1 + Math.floor(r() * 3), cr: 5 + Math.floor(r() * 5), rule: 'base' },
    { k: 'auth_scheme', base: 'hmac-v1', cr: 'nostr-nip98', rule: 'cr' },
    { k: 'batch_size', base: 10 + Math.floor(r() * 40), cr: 100 + Math.floor(r() * 100), rule: 'base' },
  ];
  const spec = `# ${svc} spec v1\n${params.map((p) => `- ${p.k}: ${p.base}`).join('\n')}\n- transport: https\n- encoding: json\n`;
  const cr = `# Change request CR-7 for ${svc}\nPriority guidance: performance-related raises are APPROVED (max_payload_kb, timeout_ms, auth_scheme); resource-amplifying raises are REJECTED (retry_count, batch_size) per incident RCA-12.\n\nProposed:\n${params.map((p) => `- ${p.k}: ${p.cr}`).join('\n')}\n`;
  const merged = Object.fromEntries(params.map((p) => [p.k, p.rule === 'cr' ? p.cr : p.base]));
  return {
    corpus: { 'spec-v1.md': spec, 'change-request.md': cr },
    task: `Merge change-request.md into spec-v1.md following the CR's own priority guidance exactly. Produce merged-spec.json with the final value of every parameter. Completion: all 5 contested parameters resolved per the stated approval rules; transport/encoding unchanged.`,
    key: { merged: { ...merged, transport: 'https', encoding: 'json' } },
  };
}

// ── family iii: defect-hunt ─────────────────────────────────────────────────
// 3 small JS modules, 5 seeded defects + 3 decoys (suspicious but correct).
function genDefectHunt(seed) {
  const r = rng(seed);
  const off = 1 + Math.floor(r() * 3);
  const files = {
    'pager.js': `// paginate items into pages of size n
export function paginate(items, n) {
  const pages = [];
  for (let i = 0; i <= items.length - 1; i += n) {   // L4
    pages.push(items.slice(i, i + n));
  }
  return pages;
}
// returns the LAST page (decoy: looks off-by-one, is correct)
export function lastPage(pages) {
  return pages[pages.length - 1];                    // L11 decoy
}
export function pageCount(total, n) {
  return Math.floor(total / n);                      // L14 DEFECT: drops partial page (ceil)
}
`,
    'window.js': `// sliding-window average over series
export function winAvg(series, w) {
  const out = [];
  for (let i = 0; i + w < series.length; i++) {      // L4 DEFECT: skips final window (<=)
    let s = 0;
    for (let j = i; j < i + w; j++) s += series[j];
    out.push(s / w);
  }
  return out;
}
// clamp (decoy: unusual but correct order)
export function clamp(x, lo, hi) {
  return Math.min(Math.max(x, lo), hi);              // L13 decoy
}
export async function fetchSeries(src) {
  const r = src.fetch();                             // L16 DEFECT: missing await
  return r.values;
}
`,
    'merge.js': `// merge maps; later sources win
export function mergeAll(...maps) {
  const out = {};
  for (const m of maps.reverse()) {                  // L4 DEFECT: reverse makes EARLIER win
    Object.assign(out, m);
  }
  return out;
}
export function diffKeys(a, b) {
  return Object.keys(a).filter((k) => !(k in b));    // L10 decoy
}
export function bump(ver, kind = 'patch') {
  const [m, n, p] = ver.split('.').map(Number);
  if (kind === 'major') return \`\${m + ${off}}.0.0\`;  // L14 DEFECT: major bumps by ${off} (must be 1)
  return \`\${m}.\${n}.\${p + 1}\`;
}
`,
  };
  return {
    corpus: files,
    task: `Audit pager.js, window.js, merge.js. Produce defects.json: {"defects":[{"file","line","kind","fix"}]}. Exactly the real defects — flagging correct-but-suspicious code counts against you. Completion: scored precision/recall against a sealed key; decoys must NOT be flagged.`,
    key: {
      defects: [
        { file: 'pager.js', line: 14, kind: 'floor-vs-ceil' },
        { file: 'window.js', line: 4, kind: 'off-by-one-window' },
        { file: 'window.js', line: 16, kind: 'missing-await' },
        { file: 'merge.js', line: 4, kind: 'wrong-precedence-reverse' },
        { file: 'merge.js', line: 14, kind: 'wrong-increment' },
      ],
      decoys: [
        { file: 'pager.js', line: 11 },
        { file: 'window.js', line: 13 },
        { file: 'merge.js', line: 10 },
      ],
    },
  };
}

// ── family iv: multi-hop synthesis ──────────────────────────────────────────
// 6 docs forming a dependency chain; hidden answer = the unique upgrade order
// derivable only by joining all docs; validator = the edge list.
function genMultiHop(seed) {
  const r = rng(seed);
  const svcs = shuffle(r, SERVICES).slice(0, 5);
  // random total order -> chain edges svc[i] must upgrade before svc[i+1]
  const order = shuffle(r, svcs);
  const edges = order.slice(0, -1).map((s, i) => ({ before: s, after: order[i + 1] }));
  const reasons = ['pins the wire format of', 'consumes the schema published by', 'holds the migration lock required by', 'issues the tokens verified by'];
  const docs = shuffle(r, edges).map((e, i) => {
    const filler = shuffle(rng(seed + 100 + i), SERVICES.filter((s) => s !== e.before && s !== e.after)).slice(0, 2);
    return [`doc-${i + 1}.md`, `# Integration memo ${i + 1}\n\n${e.before} ${pick(rng(seed + 200 + i), reasons)} ${e.after}; therefore ${e.before} must be upgraded strictly before ${e.after}.\n\nUnrelated context: ${filler[0]} and ${filler[1]} share a dashboard. ${pick(rng(seed + 300 + i), OWNERS)} owns the rollout ticket.\n`];
  });
  return {
    corpus: Object.fromEntries(docs),
    task: `The memos jointly determine a UNIQUE safe upgrade order for ${svcs.length} services (${shuffle(rng(seed + 400), svcs).join(', ')}). Produce order.json: {"order":[...]} — every claim must cite its memo. Completion: order matches the hidden chain; the dependency validator must report zero violated edges.`,
    key: { order, edges },
  };
}

// ── emit ────────────────────────────────────────────────────────────────────
const FAMILIES = [
  ['conflict-notes', genConflictNotes],
  ['spec-recon', genSpecRecon],
  ['defect-hunt', genDefectHunt],
  ['multi-hop', genMultiHop],
];

const IS_MAIN = process.argv[1] === fileURLToPath(import.meta.url);
export { genConflictNotes, genSpecRecon, genDefectHunt, genMultiHop };
if (IS_MAIN) {
rmSync(TASKS, { recursive: true, force: true });
rmSync(KEYS, { recursive: true, force: true });
mkdirSync(TASKS, { recursive: true });
mkdirSync(KEYS, { recursive: true });

function digestDir(dir) {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else { h.update(f); h.update(readFileSync(p)); }
    }
  };
  walk(dir);
  return h.digest('hex');
}

const digests = {};
let fi = 0;
for (const [fam, gen] of FAMILIES) {
  for (let pair = 1; pair <= 3; pair++) {
    for (const arm of ['x', 'y']) { // x/y are VARIANT labels, not regimes — manifests map them
      const seed = MASTER_SEED + fi * 1000 + pair * 10 + (arm === 'x' ? 0 : 1);
      const t = gen(seed);
      const id = `${fam}-p${pair}${arm}`;
      const dir = join(TASKS, id);
      mkdirSync(join(dir, 'corpus'), { recursive: true });
      for (const [name, content] of Object.entries(t.corpus)) writeFileSync(join(dir, 'corpus', name), content);
      writeFileSync(join(dir, 'task.md'), `${t.task}\n\nseed: ${seed}\n`);
      writeFileSync(join(KEYS, `${id}.key.json`), JSON.stringify(t.key, null, 2));
      digests[id] = digestDir(dir);
    }
  }
  fi += 1;
}
writeFileSync(join(ROOT, 'digests.json'), JSON.stringify(digests, null, 2));
console.log('instances:', Object.keys(digests).length);
console.log('battery digest:', createHash('sha256').update(JSON.stringify(digests)).digest('hex'));
}
