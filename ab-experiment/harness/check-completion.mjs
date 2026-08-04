// Machine completion checkers for POLLEN-4 — scores a run's FINAL artifact
// against the sealed key. Pass criteria locked here, pre-first-run, per the
// preregistration. Defect-hunt thresholds: recall ≥ 0.8 AND precision ≥ 0.8
// AND zero decoys flagged (the "meets the locked key" clause made concrete).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

export function scoreArtifact(taskId, artifact, familyOverride) {
  const key = JSON.parse(readFileSync(join(ROOT, 'keys', `${taskId}.key.json`), 'utf8'));
  const family = familyOverride ?? taskId.split('-p')[0];
  if (family === 'conflict-notes') return scoreConflicts(key, artifact);
  if (family === 'spec-recon') return scoreSpec(key, artifact);
  if (family === 'defect-hunt') return scoreDefects(key, artifact);
  if (family === 'multi-hop') return scoreMultiHop(key, artifact);
  throw new Error(`unknown family ${family}`);
}

const norm = (v) => String(v ?? '').trim().toLowerCase();

function scoreConflicts(key, artifact) {
  const found = Array.isArray(artifact?.conflicts) ? artifact.conflicts : [];
  const keySet = key.conflicts.map((c) => `${norm(c.service)}|${norm(c.field)}|${norm(c.winning_value)}|${norm(c.winning_note)}`);
  const foundSet = found.map((c) => `${norm(c.service)}|${norm(c.field)}|${norm(c.winning_value)}|${norm(c.winning_note)}`);
  const hits = keySet.filter((k) => foundSet.includes(k)).length;
  const invented = foundSet.filter((f) => !keySet.some((k) => k.startsWith(f.split('|').slice(0, 2).join('|')))).length;
  const pass = hits === keySet.length && invented === 0 && found.length === keySet.length;
  return { pass, detail: { required: keySet.length, correct: hits, invented, reported: found.length } };
}

function scoreSpec(key, artifact) {
  const merged = artifact?.merged ?? artifact ?? {};
  const entries = Object.entries(key.merged);
  const correct = entries.filter(([k, v]) => norm(merged[k]) === norm(v)).length;
  return { pass: correct === entries.length, detail: { required: entries.length, correct } };
}

function scoreDefects(key, artifact) {
  const found = Array.isArray(artifact?.defects) ? artifact.defects : [];
  const keyDefs = key.defects.map((d) => `${norm(d.file)}|${d.line}`);
  const decoys = key.decoys.map((d) => `${norm(d.file)}|${d.line}`);
  const foundIds = found.map((d) => `${norm(d.file)}|${Number(d.line)}`);
  // ±1 line tolerance for defect matching
  const matches = (id) => foundIds.some((f) => {
    const [ff, fl] = f.split('|'); const [kf, kl] = id.split('|');
    return ff === kf && Math.abs(Number(fl) - Number(kl)) <= 1;
  });
  const tp = keyDefs.filter(matches).length;
  const decoyFlagged = decoys.filter((d) => foundIds.some((f) => {
    const [ff, fl] = f.split('|'); const [df, dl] = d.split('|');
    return ff === df && Math.abs(Number(fl) - Number(dl)) <= 1;
  })).length;
  const fp = foundIds.length - tp;
  const recall = tp / keyDefs.length;
  const precision = foundIds.length ? tp / foundIds.length : 0;
  const pass = recall >= 0.8 && precision >= 0.8 && decoyFlagged === 0;
  return { pass, detail: { recall: +recall.toFixed(2), precision: +precision.toFixed(2), decoyFlagged, tp, fp } };
}

function scoreMultiHop(key, artifact) {
  const order = Array.isArray(artifact?.order) ? artifact.order.map(norm) : [];
  const want = key.order.map(norm);
  const exact = order.length === want.length && order.every((s, i) => s === want[i]);
  // dependency validator: zero violated edges
  const violated = key.edges.filter((e) => {
    const bi = order.indexOf(norm(e.before)); const ai = order.indexOf(norm(e.after));
    return bi === -1 || ai === -1 || bi >= ai;
  }).length;
  return { pass: exact && violated === 0, detail: { exactOrder: exact, violatedEdges: violated } };
}

// CLI: node check-completion.mjs <taskId> <artifact.json>
if (process.argv[2] && process.argv[3]) {
  const artifact = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  console.log(JSON.stringify(scoreArtifact(process.argv[2], artifact), null, 2));
}
