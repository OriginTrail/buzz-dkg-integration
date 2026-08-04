// Execute the 24 preregistered POLLEN-4 runs sequentially, in manifest
// order. Each run is a child process; an infrastructure failure marks the
// run invalid and continues (per prereg: tool outage invalidates before
// unblinding; no retries except preregistered infrastructure retry — we
// allow exactly ONE retry per run on infra failure, never on outcome).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const summary = [];
for (let run = 1; run <= 24; run++) {
  const outDir = join(ROOT, 'results', `run-${String(run).padStart(2, '0')}`);
  if (existsSync(join(outDir, 'result.json'))) {
    const r = JSON.parse(readFileSync(join(outDir, 'result.json'), 'utf8'));
    summary.push({ run, regime: r.manifest.regime, status: 'already-done', pass: r.score.pass });
    console.log(`run ${run}: already done, skipping`);
    continue;
  }
  let attempt = 0;
  let ok = false;
  while (attempt < 2 && !ok) {
    attempt += 1;
    console.log(`\n===== RUN ${run} (attempt ${attempt}) =====`);
    const res = spawnSync('node', [join(ROOT, 'harness', 'run-one.mjs'), String(run)], {
      stdio: 'inherit', timeout: 25 * 60 * 1000,
    });
    ok = res.status === 0 && existsSync(join(outDir, 'result.json'));
    if (!ok) console.log(`run ${run} attempt ${attempt} FAILED (infra)`);
  }
  if (ok) {
    const r = JSON.parse(readFileSync(join(outDir, 'result.json'), 'utf8'));
    summary.push({ run, regime: r.manifest.regime, family: r.manifest.family, completed: r.completed, pass: r.score.pass, leakage: r.leakageInvalid, tokens: r.tokens.totals, msgs: r.teamMessages });
    console.log(`SUMMARY run ${run}: ${r.manifest.regime} pass=${r.score.pass} leakage=${r.leakageInvalid} in=${r.tokens.totals.input} out=${r.tokens.totals.output}`);
  } else {
    summary.push({ run, status: 'INVALID-INFRA' });
    console.log(`SUMMARY run ${run}: INVALID-INFRA`);
  }
  writeFileSync(join(ROOT, 'results', 'battery-progress.json'), JSON.stringify(summary, null, 2));
  // brief cool-down between runs
  await new Promise((r) => setTimeout(r, 20000));
}
console.log('\nBATTERY COMPLETE:', JSON.stringify(summary.map((s) => ({ run: s.run, pass: s.pass ?? s.status })), null, 0));
