---
title: Buzz × OriginTrail DKG v10 Integration — Spec & Staged Prompts
spec_version: 0.2.0
status: draft
last_updated: 2026-07-26
---

# Buzz × OriginTrail DKG v10 Integration

Single canonical document: product specification and all stage prompts. Supersedes MASTER_SPEC.md v0.1.0 and the prompts/ set.

## §0 Authorization pointer (operator-edited)

```yaml
authorized_stage: "ABC"        # one of: ABC | D1 | D2 | D3 | E | NONE
prior_gate_accepted: "—"       # operator note, e.g. "Gate C accepted 2026-07-27"
```

Claude Code executes only the stage named here, through that stage's section below. This document as a whole is reference context, never blanket execution permission. Earlier reports are evidence, not authority for later side effects. If a stage section conflicts with a locked principle, follow the safer constraint and stop for operator review.

| Stage | Purpose | Maximum authority | Operator sign-off |
|---|---|---|---|
| ABC | Audit → isolated spike → daemon | Read-only on production; full authority in isolated local/test | One, up front; internal gates self-advance |
| D1 | Production readiness + grounded dry run | Production read-only + one designated Buzz test channel | Required |
| D2 | One approved SWM share | Exact approved payload only | Required, per payload |
| D3 | One approved VM publication | Exact publication, spend-capped, 1 attempt | Required, per publication |
| E | Remote repo, push, registry/bounty submission | Named remote operations only | Required |

Rationale for the split: stages ABC are cheap and reversible — momentum matters more than ceremony. From D1 on, actions touch live infrastructure or spend funds — ceremony matters more than momentum.

## §1 Mission

Build the reference integration between [Buzz](https://github.com/block/buzz) and [OriginTrail DKG v10](https://github.com/OriginTrail/dkg): a standalone service that turns selected, signed Buzz room conversations into layered DKG memory (WM → SWM → VM) and answers in-room questions using evidence exclusively from the room's designated Context Graph.

Call it **the integration service** or **the daemon**. Do not invent a product name; in code and docs, name things by what they do.

## §2 Product thesis

Buzz represents conversations and actions as signed Nostr events with one identity model for humans and agents; those events are attributable source material for DKG Knowledge Assets. The integration is a mapping plus triggers, not a protocol bridge: map selected events into structured RDF, preserve the source-event chain, share curated knowledge through a Context Graph, and — only when explicitly approved — publish to Verifiable Memory. Buzz is deliberately not blockchain; the DKG supplies the verification layer it stops short of.

Treat any claim that either system is strictly append-only as a hypothesis until source verification. The required property is a stable, independently checkable chain from signed source events to a DKG Knowledge Asset.

## §3 Canonical terminology and lifecycle hypothesis

- **Working Memory (WM):** editable/local knowledge-asset draft state.
- **Shared (Working) Memory (SWM):** finalized knowledge shared through the Context Graph's collaboration policy.
- **Verifiable Memory (VM):** finalized, shared knowledge published through the DKG's on-chain publication lifecycle.
- **Knowledge Asset (KA):** the named asset and its lifecycle metadata — not a synonym for an arbitrary RDF graph.
- **UAL:** the on-chain identifier returned for a successfully published KA; not a Context Graph ID or local assertion name.

Working hypothesis, subject to Stage A verification: `WM draft → write/import → finalize/seal → full SWM share → VM publish`. Use the exact interfaces Stage A discovers. Do not assume an older `assertion promote` operation, "subgraphs", "finalize/seal" verbs, an Oxigraph store, or `publish_epochs` parameters exist — every mechanism named in this document is a hypothesis until cited to source.

## §4 Locked architecture principles

1. **External Buzz member.** Own Nostr keypair, configurable mention handle (`@dkg` in examples), verified public Buzz/relay interfaces only. Never fork or patch buzz-relay.
2. **Public DKG surface only.** Verified node HTTP API, CLI, or MCP. Never fork or patch the node. `dkg.py` is out of scope: do not use, investigate, or reference it.
3. **One Buzz channel ↔ one Context Graph.** The service stores the mapping; it never re-implements DKG replication or Context Graph access policy.
4. **Human-triggered capture; no firehose mirroring.** A verified pin reaction or `@dkg distill` creates a proposed decision/claim cluster; after validation it becomes one finalized, fully shared SWM KA; an authorized approval reaction may *request* publication of that exact KA to VM.
5. **VM is never the default.** Publication is a separate, explicitly authorized operation.
6. **Receipts close the loop.** In-thread reply after a verified SWM share and after a confirmed VM publication, carrying the assertion identifier or UAL.
7. **Graph-scoped answering.** `@dkg ask` retrieves only from the room's designated Context Graph; missing or insufficient support produces a refusal, enforced in code (§7).
8. **Identity binding via attestations, never shared keys.** Both ecosystems use secp256k1; do not reuse raw keys across Schnorr/ECDSA contexts. Creating a binding KA is a separate publication requiring its own authorization; production acceptance may proceed with binding explicitly deferred.
9. **Minimal ontology.** PROV-O plus a thin `buzz:`/`nostr:` vocabulary; one root decision/claim cluster per KA (single root subject URI).
10. **Production infrastructure is immutable unless separately authorized.** Never initialize, start, stop, restart, update, reconfigure, migrate, fund, or repair the live node — including "helpful" fixes for discovered blockers.

## §5 Source and provenance model

Stage A must verify or define stable RDF URI forms for Nostr events and identities. Intended shape:

- KA root `prov:wasDerivedFrom` each source Nostr event resource;
- distillation activity `prov:used` the source events and `prov:wasAssociatedWith` the service identity;
- source statements `prov:wasAttributedTo` author npub resources;
- KA root `prov:wasGeneratedBy` the distillation activity;
- receipts carry the SWM KA/assertion identifier or confirmed UAL.

Do not embed raw npub values or event IDs as IRIs unless the chosen serialization makes them valid resources. Preserve source event IDs, signatures, author keys, timestamps, relay info, thread ordering, and a deterministic digest of the exact source set.

## §6 Trigger and approval invariants

A capture or publication trigger is valid only when its mechanics are verified against Buzz source and runtime behavior. Reaction support in Nostr does not imply a reaction *workflow trigger* exists in Buzz — verify subscription, target correlation, authorization, dispatch, retry, and deduplication separately.

An approval reaction may initiate VM publication only if **all** hold:

1. reactor pubkey is a configured authorized promoter for that channel;
2. the reaction targets the service's own distillation receipt event;
3. the receipt identifies the pending KA and its immutable digest;
4. the channel maps to the same Context Graph;
5. the finalized SWM KA matches the approved digest;
6. the approval event has not already been consumed;
7. the KA has not already been published;
8. the configured environment permits publication;
9. an operator-approved stage prompt (D3) authorizes that exact publication.

**A Buzz ✅ is an application-level approval signal. It is never authorization for Claude Code to spend funds or mutate production.** Those authorities come only from §0 plus the filled D2/D3 blocks.

## §7 Grounded-answering contract

Enforced in code, not requested from the model:

1. resolve channel → Context Graph; 2. reject missing/ambiguous mapping; 3. explicitly graph-scoped SPARQL and — only if exposed and provably scope-safe — semantic retrieval; 4. evidence as structured records; 5. reject empty/insufficient evidence before generation; 6. the model receives retrieved evidence, not an unrestricted question; 7. every material claim cites a retrieved assertion identifier or UAL; 8. resolve/validate citations before posting; 9. never fall back to a global index or another graph.

The deterministic no-model fallback must produce either an extractive cited answer or an explicit unsupported response, so tests run without a model.

## §8 Production baseline and consequences

Read-only observation, 2026-07-26 (recheck mandatory in D1; treat as stale until reconfirmed):

- node: DKG V10 Base mainnet, chain ID 8453, version 10.0.8;
- **publisher identity absent** (`hasIdentity: false`, identity ID 0); asynchronous publisher disabled, operator action required;
- broad Context Graph listing timed out; narrow searches did **not** unambiguously identify a FIFA graph.

Consequences, explicit:

- **Publisher identity setup is operator infrastructure work outside this plan.** Until the operator resolves it, D3 is NO-GO by default. The daemon and D1/D2 do not depend on it.
- **FIFA Context Graph binding is unproven.** D1 must identify it by ID, name, curator, membership, and caller permissions. If more than one candidate exists or none can be proven, stop that branch NO-GO and present the operator a decision: designate the graph explicitly, approve an alternative existing graph, or defer D2/D3.
- Never infer write authority from discoverability.

## §9 Repository target and quality requirements

Repo `buzz-dkg-integration`, local commits only until Stage E:

```text
src/relay/       Nostr subscriptions, publish, reconnect/backoff, verified auth (NIP-42/98 as applicable)
src/registry/    channel↔ContextGraph and identity mappings; durable SQLite preferred
src/triggers/    pin / mention / approval detection and authorization
src/distill/     thread → claims/decisions → RDF; provider interface + deterministic fallback
src/dkg/         verified node adapter; lifecycle ops incl. bind-to-existing context graph
src/ask/         graph-scoped retrieval and answer validation
src/receipts/    in-thread receipt composition
src/identity/    attestation verification only, publication disabled
ontology/buzz-dkg.ttl
deploy/docker-compose.integration.yml
phase0/          docs/DESIGN.md   docs/PHASE2.md   docs/gates/
INTERFACES.md    WORKLOG.md       README.md
```

Quality bar: TypeScript/Node unless Stage A proves a materially simpler supported path; idempotency keyed by Nostr event ID and operation/digest with unique constraints; transactional state transitions around external calls; ambiguous write/publish timeouts recovered by read-back before retry; crash-safe cursor and pending-operation recovery; secrets via env only with `.env.example` placeholders; no mocked relay or node in acceptance demos; clean lint/typecheck; reproducible transcripts with secrets redacted; README stranger-runnable in under 15 minutes.

## §10 Gate rules

- Execute one stage section at a time; produce its report under `docs/gates/`; stop (ABC's internal gates self-advance but still write their reports).
- Blocked critical-path prerequisites → NO-GO; never work around a safety boundary; environment issues may be parallelized only into work with no prohibited side effects.
- Verify every repository URL, path, command, route, payload, and cited line before recording it as fact; pin commit SHAs for all source citations.
- Stage A owns the **Verified deviations** table (§12) and updates it for every source-proven correction. Locked principles (§4) do not move; mechanics adapt.

---

# Stage prompts

## Stage ABC — Development run (single authorization)

Authorization: read-only against production and upstream repos; full authority inside an isolated disposable local/test stack; local commits in `buzz-dkg-integration` only. No production writes, no Buzz event publication outside the isolated stack, no remote repo/push/registry, no spending, no secret disclosure. Internal gates A→B→C self-advance when their exit criteria are met; each writes its report and WORKLOG entries first.

### A — Interface and production-readiness audit (read-only)

Pin sources (repo URL, default branch, commit SHA, checkout path) for `block/buzz`, `OriginTrail/dkg`, `OriginTrail/dkg-integrations`; cite files as path:lines at those SHAs.

**Buzz:** verify — exact buzz-cli commands and JSON for list/join channels, read thread, post reply, and whether these exist at all or must be done via raw Nostr; event kinds and tags for channels, messages, thread roots/replies, reactions, membership, invitations; how reactions reference targets and emoji normalization; mention resolution (p/e tags, NIP-10 markers, NIP-27 references, Buzz handles); NIP-42 relay auth vs NIP-98 HTTP auth flows for a headless member; how an agent becomes an authorized channel member; buzz-workflow YAML schema and the trigger/action types that are actually implemented; webhook direction, auth, retries, payload; custom-kind acceptance/storage/filtering; relay REST routes and their auth class. Do not assume channel, thread, member, mention, or workflow trigger is a first-class primitive.

**DKG v10:** verify — current KA lifecycle mechanics and names (WM create/write/import, finalize, full SWM share, VM publish); exact HTTP routes, auth, payloads, response fields, idempotency and read-back verification; corresponding CLI verbs/flags; MCP tool names and schemas from current setup; SPARQL route, request shape, result shape, graph/layer scoping and authorization; whether semantic search exists on the public surface and can be constrained to one Context Graph; the precise distinction between KA name, assertion identifier, named graph, Context Graph ID, on-chain KA ID, and UAL; `dkg-integrations` submission format and current bounty Round 1 requirements.

**Production, read-only:** locate the running node without changing it; record endpoint, version, Base chain confirmation, auth mechanism (credentials redacted), publisher identity and enabled/disabled status, wallet readiness as sufficient/insufficient/unknown, Context Graph evidence; attempt unambiguous FIFA CG identification per §8; bounded predicate-focused SPARQL samples of its vocabulary — no broad queries known to time out. If a supposedly read-only command may initialize state, do not run it; document the uncertainty.

**Gate A exit:** `INTERFACES.md` (verified facts vs observed behavior vs unresolved hypotheses) + `docs/gates/GATE_A_REPORT.md` with a GO/ADAPT/SPIKE/NO-GO table covering at least: read thread, publish reply, detect pin, detect authorized approval, headless relay auth, WM write, full SWM share, VM publish, graph-scoped SPARQL, graph-scoped semantic search, FIFA CG identification/access, registry submission. Update §12. Then proceed to B — except: if either of {read thread, WM write} is NO-GO, stop entirely for operator review.

### B — Phase 0 isolated spike

**Isolation preflight (hard requirement):** inventory the production node's ports, processes, home directory, API and store endpoints read-only; create a fresh disposable test home; assign distinct HTTP/store/P2P/relay/Docker ports and volumes; prove the test config shares no paths, ports, stores, token files, wallets, or network state with production; record the map in `phase0/ISOLATION.md`. Never run lifecycle commands against the production home; never stop a process because it holds a wanted port — pick another port. If complete isolation cannot be demonstrated, Gate B is NO-GO.

Prove the smallest real loop using existing verified tools only (no daemon yet): thread signal → retrieve exact source events → deterministic naive distillation → one KA through the verified WM→SWM lifecycle into an isolated test Context Graph → scoped read-back → in-thread receipt → authorized approval signal → test-network VM publish *only if* Stage A marked it GO and the isolated node is funded → UAL verification and receipt. If test VM publication is not operational, report the precise blocker and complete the SWM loop; never fabricate output. Preserve event IDs, signatures, ordering, and the source-set digest; deduplicate trigger events and operation digests; replaying the trigger must produce exactly one receipt.

**Gate B exit:** `phase0/` (ISOLATION.md, workflow or verified equivalent, bridge script, demo.md real transcript, README) + `docs/gates/GATE_B_REPORT.md` incl. environment map, blockers, cleanup instructions; verify production unchanged read-only; clean up only stage-created resources. Proceed to C.

### C — Phase 1 daemon

Build the runnable service per §9: headless member join/subscribe; one-channel↔one-graph registry; distillation into one-root PROV-O clusters; the verified WM→finalize→full-SWM lifecycle; approval recognition bound by §6 invariants with production publication disabled; §7 grounded answering; receipts; retry/restart survival without duplicate writes or replies. Prefer the node HTTP API if Gate A found it stable; add a CLI fallback only for a verified gap; no speculative multi-surface abstractions. Identity attestation publication stays disabled.

Tests, minimum: mapping + missing-map rejection; trigger correlation and normalization; unauthorized and replayed approval rejection; thread ordering and source-set digest determinism; RDF validity, stable URIs, single root, PROV-O chain; idempotent external-op recovery; refusal on empty/insufficient evidence; rejection on missing/mismatched graph scope; citation validation; receipt deduplication; crash/restart recovery from each pending state; one live integration test against the isolated stack behind an env flag. Mocks for unit tests only.

Acceptance demo against the isolated stack: signal a single-decision thread → one verified SWM receipt; replay → no duplicate; authorized test approval → test-network publish path only if available; supported question → cited answer; unsupported question → explicit refusal; daemon restart → cursor/resume proof.

**Gate C exit:** runnable daemon + deploy config; README; docs/DESIGN.md (verified interfaces, state machine, trust boundaries, deviations); docs/PHASE2.md (max one page, no code: n-of-m quorums, canvases as KA drafts, NIP-34 git events → KAs, cross-relay web-of-trust attestations); `docs/gates/GATE_C_REPORT.md` with real test output and demo transcript. Run formatter, lint, typecheck, tests, secret scan. **Stop. Do not connect the daemon to production.** Operator acceptance of Gate C is required before D1.

## Stage D1 — Production read-only validation + designated test channel

Requires: Gate C accepted (§0). Authorizes: read-only inspection of the production node; grounded-query dry runs in no-post mode; and — the sole Buzz write authority in this stage — creating or joining **one operator-designated Buzz test channel** and registering the service as a member there, so later receipts have a home. Channel name/relay must be supplied or approved by the operator in §0's note. Nothing else: no DKG writes, no other Buzz events, no wallet transactions, no node changes.

Recheck everything in §8 live: status, version, Base chain 8453, auth readiness (redacted), publisher identity and availability, wallet readiness via balance reads, FIFA CG exact ID/name/curator/membership/permissions/sync state, available layers, bounded vocabulary samples, citation surfaces; record the exact channel↔graph mapping proposed.

Grounded dry run through the daemon's retrieval and validation pipeline: at least two FIFA-supported questions and one unrelated question, recording for each the graph scope, retrieval query, evidence records, answer or refusal, resolved citations, proof no other graph was queried, proof no Buzz event was posted (beyond the authorized channel setup). The unsupported question must refuse.

**D2 is GO only if:** one FIFA CG identified unambiguously; caller legally and technically able to share a new KA there; operator-approved target location exists; a minimal single-root test payload can be proposed without polluting domain data; read-back verification available; exact test channel and authorized operator npub known; production runtime unchanged. **D3 readiness reported separately** — missing publisher identity, disabled publishing, insufficient balances, or uncertain policy = D3 NO-GO; do not repair; hand the operator the exact prerequisite list instead.

Deliverable: `docs/gates/GATE_D1_REPORT.md` — full redacted transcript, readiness matrix, dry-run evidence, exact proposed target, and the **proposed-but-not-written** KA: name, root URI, complete reviewable RDF payload, source-event set and digest plan, expected side effects. Stop.

## Stage D2 — One operator-approved production SWM share

Requires: Gate D1 accepted and every value below filled by the operator; the complete approved RDF payload must appear in an operator-reviewed appendix of the D1 report — a hash without reviewable payload is insufficient.

```yaml
buzz_channel_id: "REQUIRED"
source_thread_root_event_id: "REQUIRED"
operator_approval_reference: "REQUIRED"        # states whether receipt posting is included
context_graph_id: "REQUIRED"
target_location: "REQUIRED_EXISTING_APPROVED"  # exact verified locus within the CG, per Stage A terms
knowledge_asset_name: "REQUIRED"
root_entity_uri: "REQUIRED"
source_event_ids: []
source_set_digest: "REQUIRED"
rdf_payload_sha256: "REQUIRED"
```

Authority: exactly one lifecycle for this KA — create WM draft → write approved quads → finalize → full SWM share → verify. Not authorized: altering any approved value; creating Context Graphs or locations; changing participants/subscriptions/policies; VM publication; wallet transactions; identity attestation; node changes; a second KA; remote repo operations. Missing values or material drift from D1 state → NO-GO.

Preflight read-only: target CG identity and current permission; target location existence; absence of the KA name/digest (duplicate prevention); payload hash match; source event signatures, thread, authors, digest; daemon idempotency state; node health. Print the full operation plan and resolved identifiers before the first write. On timeout or ambiguity: narrow read-back before any retry; never create a second KA name to route around uncertainty.

Verify after share: lifecycle/history descriptor; scoped SWM query for root and provenance marker; payload/digest comparison where the API permits; confirmation no VM UAL exists. Post one in-thread receipt only if the approval reference covers posting and the receipt content was shown in advance; otherwise prepare without posting.

Deliverable: `docs/gates/GATE_D2_REPORT.md` — approved values, redacted commands and responses, read-back proof, ambiguity handling, receipt event ID if authorized, proof of no VM publication, and the immutable digest and identifiers proposed for D3. Stop.

## Stage D3 — One operator-approved VM publication

Requires: Gate D2 accepted and every value filled:

```yaml
operator_approval_reference: "REQUIRED"
authorized_buzz_approval_event_id: "REQUIRED"
authorized_promoter_npub: "REQUIRED"
context_graph_id: "REQUIRED"
target_location: "REQUIRED"
knowledge_asset_name: "REQUIRED"
root_entity_uri: "REQUIRED"
finalized_swm_digest_or_merkle_root: "REQUIRED"
target_network: "mainnet-base"
target_chain_id: 8453
publication_parameters: "REQUIRED_PER_STAGE_A_TERMS"   # e.g. epochs, only if such a parameter verifiably exists
max_eth_cost: "REQUIRED"
max_trac_cost: "REQUIRED"
publication_attempts_authorized: 1
```

Authority: one publication attempt for this exact finalized, fully shared KA within the spend ceilings. Not authorized: any other KA or attestation; changing/resealing the KA; creating/registering graphs; policy changes; configuring/enabling a publisher or creating an identity; funding, swapping, or bridging; node changes; automatic retry after ambiguity; exceeding either ceiling.

Preflight, read-only, immediately before publishing: §6 invariants 1–9 against the named approval event; KA finalized, fully shared, digest match; not already published; Base 8453; publisher identity and capability already enabled; ETH and TRAC balances sufficient; expected cost within both ceilings; operation cannot implicitly create a graph or change policy. Print a redacted preflight table; any mismatch → NO-GO — do not fix.

Publication: persist the request fingerprint, invoke the Stage-A-verified operation once, classify the result: **confirmed** (success response plus independent UAL resolution/read-back), **tentative/ambiguous** (UAL-like value or timeout without full confirmation), **failed** (explicit failure, no publication evidence). Never auto-retry tentative/timeout/ack-only outcomes: run read-only history, UAL-resolution, and scoped queries, then stop for operator decision.

On confirmed success record: UAL; on-chain KA ID and transaction hash if exposed; resolved network/contract; independent UAL resolution; scoped FIFA CG query showing the published content; consumed approval event and dedup state; actual spend vs ceilings; absence of a second publication. Post the one VM receipt with the UAL only if covered by the approval reference. Deliverable: `docs/gates/GATE_D3_REPORT.md`. Stop.

## Stage E — Remote publication and bounty submission

Requires: operator authorization in §0, naming exactly which of the following are granted: create remote `buzz-dkg-integration` repository; push local history; open the `dkg-integrations` registry submission per the format verified in Stage A (bounty Round 1: WM/SWM focus, VM as promotion path — the D-gates transcripts are the evidence package). Nothing else: no force-pushes over unrelated history, no other repos, no publishing secrets or unredacted transcripts — run the secret scan again before any push. Deliverable: submission links and `docs/gates/GATE_E_REPORT.md`. Stop.

---

## §12 Verified deviations (owned by Stage A)

| Assumption | Verified reality | Adaptation | Evidence (path:lines @ SHA) |
|---|---|---|---|
| Pending Stage A | — | — | — |

## §13 Change log

- **0.2.0 — 2026-07-26:** Consolidated to a single file. Merged v0.1.0's authority model, D-stage safety architecture, approval invariants, isolation preflight, and grounding contract; collapsed A–C into one development authorization with self-advancing internal gates; added the designated Buzz test-channel authority to D1 (closing the receipt-channel gap); added Stage E for remote/bounty operations; flagged publisher-identity setup as an operator prerequisite outside the plan; marked all unverified mechanism names as hypotheses.
- **0.1.0 — 2026-07-26:** Initial gated master specification (external rework).
