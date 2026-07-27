# WORKLOG

## 2026-07-26 — Stage ABC started (authorized_stage: ABC per SPEC.md §0)

### Gate A — source pinning
- Cloned upstream repos to `~/code/upstream-pins/`:
  - `block/buzz` — branch `main` @ `dd222a509b156ba52ed3219e895d7bf1cf322c92` (2026-07-26)
  - `OriginTrail/dkg` — branch `main` @ `bf919a03e0b4a731431932a14637c42ecaec9ab9` (2026-07-22)
  - `OriginTrail/dkg-integrations` — branch `main` @ `c944c9cbf48c227e54592986c0c995059720b8d5` (2026-04-24)
- Existing local checkouts (`~/code/dkg` fork on feature branch with uncommitted work, `~/dkg-node` dev branch, `~/dkg` detached @10.0.5) deliberately NOT used for citation — audits cite the pinned clones only.

### Gate A — production read-only baseline (no state changed)
- Production node home: `~/.dkg-mainnet` (`name: okf-mainnet`, `apiPort: 9200`, `listenPort: 9090`, `nodeRole: edge`, auth enabled, store backend `oxigraph-server`, `lastNetworkConfig: mainnet-base`).
- Node is **not running**: no listener on 9200; `daemon.log` ends `[2026-07-20T20:38:03] ... [oxigraph] server stopped / Stopped.` (operator-requested pause of all local nodes on 2026-07-13/20).
- SPEC §8's 2026-07-26 baseline (v10.0.8, hasIdentity:false, chain 8453) could NOT be independently re-verified live because the node is down; treated as stale-until-D1 exactly as §8 mandates. Version 10.0.8 is corroborated by backup dir `~/.dkg-mainnet.bak-pre-v1008-20260719` (pre-10.0.8 upgrade backup, 2026-07-19).
- Context Graph enumeration impossible while node is down → FIFA CG identification remains UNPROVEN (consistent with §8). Log evidence of `cg 7` sync activity on 2026-07-19.
- Other node homes inventoried read-only (none running): `~/.dkg` (nos-m0-spike, 9201), `~/.dkg-client-gnosis` (client-edge-gnosis, 9210, gnosis — client infra, off-limits), `~/.dkg-curator-test` (curator, 9200), `~/.dkg-member-local` (member-local, 9201).
- **Port landmines for isolation preflight (Gate B):** 9200 (production API), 9201 (historic live-node port), 9090 (production P2P), 9210, 9250 (running dkg-explorer-v10 adapter), 9301+ (prior devnet convention), 8545/8547 (running hardhat instances — do not reuse), 9320/7880/9700 (agent-blackbox stack; 9700 currently listening).

### Gate A — interface audits
- Three parallel audit agents launched over the pinned clones; reports land in `docs/audit/{buzz,dkg,integrations}-audit.md`.

### Gate A — complete
- All three audits done and folded into INTERFACES.md; GATE_A_REPORT.md written with capability verdicts (read thread GO, WM write GO → self-advance to B per spec exit rule).
- SPEC §12 deviations table populated (13 verified corrections/confirmations).
- Container images: `buzz-cli:dd222a5` build running; `buzz-relay:dd222a5` build running (needed brew docker-buildx install — host-level, reversible).

### Gate B — complete (2026-07-26)
- Isolated stacks: bdi-spike (postgres/redis/minio containers + native pinned buzz-relay on 127.0.0.1:9440) and 6-node devnet (9420-9425, hardhat 8655/31337, fresh blazegraph on 19999). ISOLATION.md proves disjointness; production re-verified untouched at exit.
- Full loop proven end-to-end incl. devnet VM publish: UAL did:dkg:evm:31337/0x71cfc9b0…/3, tx 0x88965ebb…, 3 StorageACKs; scoped SWM/VM read-backs; in-thread receipts; replay dedup.
- Live findings → Gate C: as-of-trigger snapshot excluding service events (dedup bug observed + fixed), RELAY_URL community seeding, BUZZ_AUTO_MIGRATE, NIP-98 replay guard, descriptor ?contextGraphId + reservedUal, storage-ack quorum failure mode.
- Fixed relay-image OOM (2 GB Docker VM) by native host build; minimal Dockerfile kept for container deployments.

### Gate C — complete (2026-07-26)
- Daemon built per §9 (TypeScript strict, node:sqlite registry/state machine, WS NIP-42 + NIP-98 HTTP relay client, deterministic distiller behind provider seam, §6 invariants + §7 grounding in code, NIP-OA verify-only identity).
- publishMode disabled|devnet only; mainnet unimplemented until D-stages; devnet double-checks chain evm:31337.
- 48 tests green (unit + integration with mocks); acceptance demo with ZERO mocks against live isolated stacks: SWM receipt, restart dedup, §6 approve→devnet publish (UAL did:dkg:evm:31337/0x71cf…/7), unauthorized approval rejected, cited answer, refusal, cursor proof. docs/acceptance-transcript.md.
- Live defects found+fixed: kind-7 live fan-out needs #h-scoped subscription; NIP-98 nonce tag instead of monotonic timestamps.
- lint/typecheck/format/secret-scan clean. STOP per spec: no production connection; awaiting operator acceptance for D1.

### Post-Gate-C live demo + recordings (2026-07-26)
- Live run on channel dkg-live-demo (daemon in devnet publish mode): pin→SWM receipt→✅→VM publish (UAL …/8)→ask answered with citation→refusal. Recorded to docs/media/buzz-dkg-live-loop.gif (channel viewer) + buzz-dkg-node-ui.gif (DKG node UI: pipeline, DecisionCluster KA, provenance trail).
- Demo tooling added: scripts/viewer (read-only live channel page + NIP-98 proxy), scripts/live-demo-steps.mjs.
- Fixes found via live run: (1) evidence retrieval now spans VM+SWM views — published KAs migrate out of the SWM view (observed live); citations validate in their own view; (2) §7.5 support gate accepts one highly-specific term (≥7 chars) — no stemmer, so morphology (retention/retain) must not starve supported answers. 48 tests green.

### Gate D1 — partial (2026-07-26)
- Operator accepted Gate C in session; SPEC §0 → D1, test channel dkg-test.
- Authorized write done: channel dkg-test (56059d1d-77bb-4d94-af79-97bb30547ac8) created on local relay, service is owner-member; zero other Buzz events.
- Production recheck + FIFA dry run NO-GO: okf-mainnet still stopped (verified live, read-only); not started per §4.10/D1 authority. Ready-to-run recheck command list + proposed KA (digest plan) in GATE_D1_REPORT.md.
- D2 NO-GO pending node up + FIFA CG designation; D3 NO-GO (publisher identity) unchanged.

### Gate D1 — COMPLETE (2026-07-26)
- Operator authorized node start + delegated FIFA designation + discretionary thread/promoter. okf-mainnet resumed per documented recipe (proxy-first held), healthy: v10.0.8, base:8453, 5 peers.
- §8 recheck confirmed live: hasIdentity=false, publisher disabled (D3 NO-GO stands); wallets read (0x633E… 0.0035 ETH / 113 TRAC).
- FIFA CG unambiguous among 494: 0x633E…e2Ab/fifa-world-cup-2026, onChainId 7 (matches Gate A "cg 7"), public, synced, caller=curator+allowed → designated.
- Dry run (no-post): 2 FIFA answers with resolved VM citations (Result: Argentina 2-0 Austria ← urn:wc2026:result:537399), 1 refusal; 9/9 queries scoped to the one CG. Retriever generalized: optional description w/ name fallback, two-pass conjunctive retrieval, unquoting (48 tests green).
- dkg-test: author+promoter members added; 2-message test thread posted (root 60fe7bc1…); concrete D2 payload (37 quads) in docs/gates/d2-proposed-payload.json; digest 8a4599b3…, payload sha bdba3972….
- D2 GO pending operator approval reference. Stopped per spec.

### Publisher identity (2026-07-26, operator-ordered)
- createProfile via node's own adapter (stakeAmount 0): tx 0x8fe764cf…, block 49142839, success; ambiguous receipt recovered by read-back. identityId 65; daemon wired via /api/identity/ensure → hasIdentity true. D3 identity blocker cleared.

### Gate D2 — COMPLETE (2026-07-26)
- Operator approved (receipt posting included). Preflight all-green (narrow CG routes after broad-list 500; payload hash serialization equivalence proven via git before proceeding — first run correctly NO-GO'd).
- One lifecycle executed on production: buzz-dkg-8a4599b36c1d → 37 quads → finalize (merkle 0x1a87d6c0…) → full SWM share into FIFA CG (shareOp ms1vxxmo-1lfilj, publishReady). Verified: descriptor promoted/SWM, scoped SWM query shows root+digest+prov chain, NO VM UAL.
- Receipt posted in dkg-test: b02446d7…. D3 identifier block recorded in GATE_D2_REPORT.md. Stopped per spec.

### D3 preparation (2026-07-26)
- Live read-only cost quote: avgAsk 8e14, est publicByteSize 7,641 B → 0.0716 TRAC @ 12 epochs; gas ≈ 0.0000072 ETH (6e6 wei gasPrice). Balances 113 TRAC / 0.0033 ETH → ample.
- Promoter ✅ posted on D2 receipt: event bf724457… by fc11ee86…. Full D3 block proposed to operator; awaiting explicit approval (spend ceilings) before the single publish attempt.

### D3 attempt #1 — FAILED cleanly (2026-07-26)
- All 9 §6 invariants PASS; single vm/publish attempt refused server-side: LU-5 access-policy UNKNOWN (liveness probe timeout, 2.5s budget, node mid sync-storm + proxy contention). No spend, no publication, approval unconsumed.
- Verified on-chain directly: slot 7 nameHash matches FIFA CG (binding valid), accessPolicy public/open; TRAC 113.24 intact (daemon balances glitch showed 0). Diagnosis in d3-transcript.md. Awaiting operator decision on a fresh single attempt.

### Gate D3 — CONFIRMED (2026-07-26)
- Operator-authorized retry succeeded: UAL did:dkg:base:8453/0x633e…/2201, tx 0x6daf3e0b… (block 49145748, status 1), KA NFT minted. Spend 0.00000465 ETH / 0 TRAC (both far under ceilings; only Transfer in tx is the NFT mint). Approval bf724457… consumed. Descriptor state=published/VM; scoped VM query returns root content. VM receipt f713ee3e… posted in dkg-test.
- Full production loop closed: Buzz thread → SWM (D2) → ✅ → VM publish with UAL (D3) + receipts. Stage E awaits separate authorization.

### Gate E — COMPLETE (2026-07-26)
- Secret scan clean → repo published: github.com/Zigoljube/buzz-dkg-integration (full history). Registry PR: OriginTrail/dkg-integrations#20 (entry validated with upstream CI scripts: 0 errors; expected Round-1 VM warning justified). No npm publish (install.kind manual). ALL SPEC STAGES DONE.

### FIFA production demo + recording (2026-07-26 evening)
- Channel fifa-worldcup-chat bound to the PRODUCTION FIFA CG; daemon in publishMode=disabled (SWM-only). Live capture: buzz-dkg-4e1b84a2b4f4 shared into the real FIFA graph; asks answered from real on-chain data (Result: Argentina 2-0 Austria ← urn:wc2026:result:537399; Norway top-scorer ← urn:wc2026:player:38101); wifi question refused. Recorded both surfaces → docs/media/fifa-buzz-dkg-integration-demo.gif (34 frames).
- Production-hardening fixes shipped: CG-exists narrow probe at startup (broad list 500s), reconnect timer no longer unref'd (daemon silently exited during relay outage), SWM read-back = subject-scoped SELECT + bounded retry (constant custom predicate in SWM view 500s "fetch failed" on prod; store flaky under sync). Relay Redis-pool flap fixed by relay restart; NIP-09 delete used to clean a duplicate from a rate-limited retry. 48 tests green.

### Mainnet publish mode + announcement recordings (2026-07-27)
- Added publishMode 'mainnet' (requires base:8453 at startup+approval; rolling-24h budget BDI_MAX_PUBLISHES_PER_DAY, default 5). Retired devnet as the production posture. 51 tests green.
- Daemon run against production FIFA CG in mainnet mode; live captured a new context (buzz-dkg-bdb56196d8e4, Brazil-Croatia decision) into SWM.
- Recordings (docs/media/): buzz-ui-fifa-integration.gif (Buzz-style chat POV: pin→capture receipt WRITE + grounded @dkg ask READ + refusal, header shows CG binding to Base mainnet), dkg-fifa-context-graph-explorer.gif (edge-node FIFA context graph POV: rich provenance graph over real node data, WM/SWM/VM layers, signed-event Schnorr verification, grounded reads with UAL citations).
- PRIVACY: a full-screen ffmpeg capture of the native Buzz desktop app inadvertently recorded the user's WhatsApp (personal contacts/messages); deleted immediately, not delivered. Buzz-side recording redone privacy-safe as a browser-only chat view. Node UI graph browser currently blocked by node-side 'listContextGraphs budget' 500 under load (494 CGs) — not patched (production).
