// Run manifests per the frozen JOINT PROTOCOL: 4 tasks × 3 teams × 2 regimes
// = 24 core runs, counterbalanced crossover, Latin-square ordering. Variant
// x/y → regime assignment counterbalanced per team so neither variant label
// systematically favors a regime. Canary tokens are arm-unique per run.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = new URL('.', import.meta.url).pathname;
const digests = JSON.parse(readFileSync(join(ROOT, 'digests.json'), 'utf8'));
const FAMILIES = ['conflict-notes', 'spec-recon', 'defect-hunt', 'multi-hop'];
const TEAMS = ['T1', 'T2', 'T3'];
const REGIMES = ['SCROLLBACK', 'CG'];

// Latin square over task order per team (rows = teams, cols = execution slots)
const ORDER = [
  [0, 1, 2, 3],
  [1, 2, 3, 0],
  [2, 3, 0, 1],
];
// Regime order per (team, task-slot): alternate, offset per team → each team
// does each regime first exactly twice; each family sees each regime first
// at least once across teams.
const MANI = join(ROOT, 'manifests');
rmSync(MANI, { recursive: true, force: true });
mkdirSync(MANI, { recursive: true });

const runs = [];
let runNo = 0;
for (let ti = 0; ti < TEAMS.length; ti++) {
  for (let slot = 0; slot < 4; slot++) {
    const fam = FAMILIES[ORDER[ti][slot]];
    const pair = ti + 1; // team i uses pair i of every family (fresh variants per team)
    const firstRegime = (ti + slot) % 2; // counterbalanced
    for (let leg = 0; leg < 2; leg++) {
      const regime = REGIMES[(firstRegime + leg) % 2];
      // variant assignment counterbalanced: even (team+slot) → x to SCROLLBACK
      const xToScroll = (ti + slot) % 2 === 0;
      const variant = (regime === 'SCROLLBACK') === xToScroll ? 'x' : 'y';
      const taskId = `${fam}-p${pair}${variant}`;
      runNo += 1;
      const canary = `CANARY-${regime === 'SCROLLBACK' ? 'CGONLY' : 'TRANSCRIPT'}-${createHash('sha256').update(`canary|${runNo}|${taskId}`).digest('hex').slice(0, 12)}`;
      runs.push({
        run: runNo,
        team: TEAMS[ti],
        slot: slot + 1,
        leg: leg + 1,
        family: fam,
        taskId,
        taskDigest: digests[taskId],
        regime,
        model: 'claude (Buzz claude runtime via claude-agent-acp; identical for every run)',
        teamSize: 3,
        maxRounds: 8,
        tokenBudgetPerAgent: 200000,
        isolation: 'fresh disposable agent instances + fresh keys + fresh private channel per run; instances destroyed after run',
        armConfig: regime === 'SCROLLBACK'
          ? { context: 'immutable seed corpus + growing run transcript', cgAccess: 'DENIED (no client, no credentials, graph egress blocked)' }
          : { context: 'empty history; snapshot-pinned scoped CG query client only', transcriptAccess: 'DENIED (no history subscription/read)' },
        canaryToken: canary,
        canaryPlacement: regime === 'SCROLLBACK'
          ? 'planted only in the CG snapshot — its appearance in any output/log = leakage invalidation'
          : 'planted only in the channel transcript pre-seed — its appearance in any output/log = leakage invalidation',
        accountingBoundary: 'native per-turn input+output tokens for all team agents + orchestration prompts + (CG arm) query prompts/answers/retries; CG build cost accounted separately as marginal vs fully-loaded per prereg §3',
      });
    }
  }
}
for (const r of runs) writeFileSync(join(MANI, `run-${String(r.run).padStart(2, '0')}.json`), JSON.stringify(r, null, 2));
const manifestDigest = createHash('sha256').update(JSON.stringify(runs)).digest('hex');
writeFileSync(join(ROOT, 'manifest-digest.txt'), manifestDigest + '\n');
console.log('runs:', runs.length, '| manifest-set digest:', manifestDigest);
// sanity: regime balance per family and team
const bal = {};
for (const r of runs) { const k = `${r.family}|${r.regime}`; bal[k] = (bal[k] ?? 0) + 1; }
console.log('balance:', JSON.stringify(bal));
