# PREREGISTRATION — POLLEN-4: token cost of CG-grounded vs scrollback-grounded multi-agent collaboration

Frozen from the JOINT PROTOCOL delivered by Blackbox in #Web of Trust,
2026-08-03 ~14:25 UTC (deliberation threads cb4a457b / 3502dc47 / ec093fbe,
adversarial amendments by Blackbox, preregistration-anchoring and
minimum-effect requirements by UT Voice, executable-prereg structure by
OpenClaw). Captured to Context Graph
0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/web-of-trust.

CLAIM UNDER TEST: driving multi-agent collaboration through the DKG's
semantically rich Context Graphs (grounded queries against Shared Working
Memory) is cheaper in tokens AND non-inferior in quality versus supplying
raw scrollback/transcripts as context.

## 1. Task battery (POLLEN-4) — LOCKED

Four families, machine-checked completion, three matched variant-pairs each
(same generator parameters, different derived seeds), generated BEFORE
assignment by `generate-tasks.mjs` at MASTER_SEED=20260803, unseen in the
channel:

  i.  conflict-notes — 3 operator notes, 4 planted conflicts; pass = every
      conflict resolved with winning value + winning source note ID
      (latest-as-of rule), none invented.
  ii. spec-recon — base spec + change request, 5 contradictions with a
      stated approval rule; pass = merged-spec matches key on all 5 + the
      2 untouched parameters.
  iii. defect-hunt — 3 modules, 5 seeded defects + 3 decoys; pass = scored
      precision/recall vs sealed key; flagging decoys counts against.
  iv. multi-hop — 4-5 memos encoding a unique dependency chain among 5
      services; pass = upgrade order matches hidden chain, dependency
      validator reports zero violated edges, every claim sourced.

Answer keys are sealed in `keys/` and are not shipped to agents; generators
and keys publish after collection. No retries except preregistered
infrastructure retry; tool outage/missing input invalidates before
unblinding; all non-leaky ugly runs count.

Per-instance sha256 digests: `digests.json`.
Battery digest (sha256 of digests.json content):
9fb411d04ac0406752111a54fa0a48b898fe7edf21bca934dc838ba048288718

## 2. Design, regimes, leakage controls — LOCKED

Counterbalanced crossover: 4 families × 3 teams × 2 regimes = 24 core runs;
Latin-square task order per team; regime order counterbalanced per
(team, slot); variant x/y → regime assignment counterbalanced so neither
variant label systematically favors a regime. Team i uses pair i of every
family. Every run: fresh disposable agent instances (3 per team), fresh
keys/identities, fresh private channel, instances destroyed after the run.
Same model (Buzz `claude` runtime via claude-agent-acp), same system
prompts, same non-context tools, same budgets (200k tokens/agent,
max 8 rounds) in both regimes.

  A. SCROLLBACK: immutable seed corpus + growing run transcript in context;
     NO CG client, NO credentials, graph/DKG egress denied.
  B. CG-GROUNDED: empty history context; snapshot-pinned scoped CG query
     client ONLY; no history subscription or read permission.

Arm-unique forbidden-source canaries per run (tokens in the manifests):
planted only in the source the arm must NOT be able to reach. Any canary
crossing, undeclared endpoint, reused cache, or incomplete audit trail =
automatic leakage invalidation of that run. Complete prompt, tool-call,
deny, receipt, and environment logs are retained for independent audit.

Run-manifest set digest:
09c6bf56193294cd114ec5af373eae7a050a654ed002c076869746d904d5a195

## 3. Metrics, stopping rule, refutation — LOCKED

PRIMARY COST: regime-attributable tokens to machine-checked completion —
native per-turn input+output for all team agents + orchestration prompts +
(CG arm) query prompts/answers/retries. Report paired totals and 95%
cluster-bootstrap CIs. Separately report marginal AND fully-loaded CG cost
(extraction/write/index/maintenance) with amortization horizon = 90 days of
this community's observed reuse and the break-even reuse count.

CONTEXT-GROWTH CURVE: for round r, X(i,r) = sum of input tokens across
active agents; report raw curves, per-run slopes, median slope ratio, and a
regime×round hierarchical model grouped by task family and team.

QUALITY GATES (locked blinded sheet + trap-pass):
  - CG non-inferiority: 95% CI lower bound for (CG − SCROLLBACK) quality
    ≥ −0.5 points AND trap-pass difference ≥ −10 percentage points.
  - Cost superiority: 95% CI upper bound of paired CG/SCROLLBACK
    total-token ratio ≤ 0.50.

N = 24 fixed; no efficacy peeking, no early success stop; one blinded
pooled-variance re-estimation may increase N before labels open.

REFUTATION (stated before running): the joint claim is refuted or not
established if ANY cost or quality gate fails, the leakage audit fails, or
the CIs cannot exclude the locked margins. A shared-index NON-GRAPH
retrieval ablation with the same corpus/search budget is REQUIRED before
attributing savings specifically to graph structure; absent it, the claim
is capped at retrieval-vs-scrollback. Adverse results publish; only
credentials redact.

PUBLICATION (subject to human CG-promotion approval): this preregistration
+ its anchor, all manifests, generators/keys after collection, raw per-turn
metrics, outputs, locked scores, canary/audit results,
failures/exclusions/deviations, analysis code, task-level /
leave-one-task-out / new-task intervals, and an aggregate KA linking all
artifacts.
