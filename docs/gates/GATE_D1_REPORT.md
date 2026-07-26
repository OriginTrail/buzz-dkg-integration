# Gate D1 report — production read-only validation + designated test channel

Date: 2026-07-26 (completed same day; the earlier partial version of this report is superseded — history in git). Authorization: SPEC §0 `authorized_stage: D1`; operator additionally authorized in session: (1) starting the okf-mainnet node, (2) FIFA CG designation delegated to me contingent on unambiguous identification, (3) test-thread posting + promoter designation at my discretion.

**Status: COMPLETE. D2 is GO pending only the operator approval block.**

## 1. Node resume (separately authorized operator action, executed by me)

Preflight verified before start: rpc-proxy healthy on 127.0.0.1:8547 (config's only RPC URL — proxy-first rule held); zero dkg/oxigraph production processes; no stale `daemon.pid`; the only running oxigraph instances belonged to the isolated devnet. Started per the documented recipe: `~/dkg-v1008` worktree, `DKG_HOME=~/.dkg-mainnet DKG_NO_BLUE_GREEN=1 caffeinate -dimsu node packages/cli/dist/cli.js start --foreground`, detached. Node healthy on first probe. **No config, store, wallet, or policy was changed — the start itself was the only mutation, and it was explicitly ordered.**

## 2. §8 live recheck (read-only; bearer token redacted throughout)

| Item | Live value (2026-07-26) | §8 baseline | Verdict |
|---|---|---|---|
| Node | okf-mainnet, **v10.0.8** @ 68bf2e70, role edge, store oxigraph-server | v10.0.8 | ✔ confirmed |
| Chain | `base:8453`, configured, hub configured, 1 RPC endpoint (the local proxy) | 8453 | ✔ confirmed |
| Peers | 5 connected shortly after start | — | healthy |
| Publisher identity | `identityId: "0"`, `hasIdentity: false` | absent | ✔ confirmed — **D3 prerequisite still missing** |
| Async publisher | `available: false, reason: publisher_disabled, operatorActionRequired: true` | disabled | ✔ confirmed |
| Wallets (redacted) | `0x633E…e2Ab`: **0.00353 ETH / 113.24 TRAC**; `0x092A…949E`: 0.00039 ETH / ~0.004 TRAC; `0x33ac…b43c`: 0/0 | unknown | Balances readable. Sufficient for SWM (no spend). For D3-scale publish: TRAC likely sufficient for a tiny KA, ETH thin — recheck against a live quote in D3 preflight. |
| Auth | Bearer enabled; token file `~/.dkg-mainnet/auth.token` (value never logged) | — | ✔ |

## 3. FIFA context-graph identification — UNAMBIGUOUS

Full CG listing (494 graphs) filtered for fifa/wc2026/world-cup: **exactly one hit.**

| Field | Value |
|---|---|
| id | `0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026` |
| URI | `did:dkg:context-graph:0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026` |
| Name / created | "FIFA World Cup 2026" (IPTC Sport Schema) / 2026-07-04 |
| onChainId | **7** — independently corroborated by the Gate A daemon-log evidence (`cg 7` sync entries) |
| accessPolicy | public |
| Curator | `0x633E5a…e2Ab` — **this node's own funded operational wallet**; creator DID = this node's peerId |
| Members | 3 allowed agents incl. the curator (join policy: manual) |
| Sync | `subscribed: true, synced: true`; no pending catch-up job |
| Caller authority | `callerInvolved: true`; caller is curator AND allowed agent ⇒ **legally + technically able to share a new KA** |

Per the delegated designation: **the FIFA CG above is the designated D2 target.** Vocabulary (bounded samples, both layers): sportschema.org Athlete/TeamParticipation/Event/Team/CompetitionPhase, schema.org Claim, `urn:wc2026:vocab#` records; literal surface dominated by `schema:name` (1187) — no `schema:description` on domain entities (adaptation below).

## 4. Grounded dry run — no-post mode (full transcript: `d1-dryrun-transcript.md`)

Executed through the daemon's own retrieval/validation pipeline (`answerGrounded`), deterministic no-model path, zero Buzz traffic (no relay client imported):

| Question | Result | Citations (resolved in their own scoped view) |
|---|---|---|
| "what was the result of Argentina vs Austria?" | **ANSWER**: `Result: Argentina 2-0 Austria [1]` | `urn:wc2026:result:537399` (+537401, 537427), verifiable-memory |
| "which teams played in the FIFA World Cup tournament?" | **ANSWER**: `FIFA World Cup [1]` | `urn:wc2026:tournament:2000` (VM) + a SWM player record |
| "what is the office wifi password?" | **REFUSAL** before generation | — |

Scope proof: 9/9 queries carried exactly the designated CG id and a view — no other graph, no global index (plus server-side scope enforcement verified in Gate A). Buzz proof: no relay client in the dry-run process; the only Buzz writes this stage were the authorized channel setup + operator-approved thread (below).

Pipeline adaptations made for domain data (regression-covered, 48 tests green): `schema:description` now OPTIONAL with `schema:name` fallback (mirrors the node's own memory-search surface); two-pass retrieval (conjunctive term-pairs, then single-term fallback) so arbitrary-LIMIT subsets can't drown multi-term-supported records; literal quoting stripped.

## 5. Designated test channel + approved source thread

- Channel `dkg-test` = `56059d1d-77bb-4d94-af79-97bb30547ac8` on the local relay `127.0.0.1:9440` (recorded in §0); service `181e08ed…` is owner-member; members added: author `7b20d526…`, promoter `fc11ee86…`.
- Source thread posted under the operator's discretionary approval (test-data-labeled, 2 messages, author-key authored):
  - root `60fe7bc1f5263b06480101d567f06b74518fc69258f3712dfd46ddef6743e5ff`
  - reply `fb88df35fbe4761a49f13733fe407dfe72706fce9b243e438e5a269b327898b1`
- **Designated promoter** (my discretion, operator may override in the D2 block): `fc11ee8605a0bca53185867f1982334c61dd9249c752ab2532c07312acc294d6` (the test promoter identity used throughout Gates B/C).

## 6. Proposed KA — concrete, complete, NOT written

Full reviewable RDF payload (37 quads): **`docs/gates/d2-proposed-payload.json`** — deterministic distiller output over the two source events; single root DecisionCluster + PROV-O chain + full signed event snapshots.

Filled D2 block proposal (operator supplies only the approval reference):

```yaml
buzz_channel_id: "56059d1d-77bb-4d94-af79-97bb30547ac8"
source_thread_root_event_id: "60fe7bc1f5263b06480101d567f06b74518fc69258f3712dfd46ddef6743e5ff"
operator_approval_reference: "REQUIRED — state whether in-thread receipt posting is included"
context_graph_id: "0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026"
target_location: "CG root (no sub-graph); assertion coordinate did:dkg:context-graph:0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026/assertion/<caller-agent-address>/buzz-dkg-8a4599b36c1d"
knowledge_asset_name: "buzz-dkg-8a4599b36c1d"
root_entity_uri: "urn:buzz-dkg:decision:8a4599b36c1d845301edbf0cfb66fc598c998caa3d781ffcb53b1c3135194c00"
source_event_ids:
  - "60fe7bc1f5263b06480101d567f06b74518fc69258f3712dfd46ddef6743e5ff"
  - "fb88df35fbe4761a49f13733fe407dfe72706fce9b243e438e5a269b327898b1"
source_set_digest: "8a4599b36c1d845301edbf0cfb66fc598c998caa3d781ffcb53b1c3135194c00"
rdf_payload_sha256: "bdba39725d73a724d07d80304ab8b8fe700d172fa8cc847ab783adac98228bd9"
```

Integrity note: the digest is over the exact two-event source set; any further message in that thread before capture changes it — the thread must stay untouched, or these values get recomputed and re-approved. Pollution check: the KA is a clearly-labeled test decision cluster in our own `buzz:`/`nostr:`/PROV vocabulary — disjoint from the FIFA domain vocabulary; name `buzz-dkg-8a4599b36c1d` verified absent from the CG (fresh digest-derived name). Expected side effects of the D2 lifecycle: one WM draft (+write, finalize/seal) and one full SWM share in the designated CG; optional single in-thread receipt in `dkg-test` iff the approval reference covers posting. **No VM publication, no wallet transactions, no CG/policy changes.**

## 7. Gate assessment

**D2: GO** — every §Stage-D2 prerequisite is met: CG unambiguously identified; caller share-capable (curator + allowed agent); operator-approved target location proposed (CG root); minimal non-polluting single-root payload prepared and reviewable; read-back available (descriptor + scoped query verified live); test channel + promoter known; production runtime unchanged beyond the ordered start. Awaiting only the operator-filled `operator_approval_reference` (and any overrides to the proposed values).

**D3: NO-GO (reported separately, unchanged).** Live-confirmed blockers, all operator-side: publisher identity absent (`hasIdentity:false`, identityId 0) — `POST /api/identity/ensure` or `dkg publisher enable` path is operator work per §8; async publisher disabled (`operatorActionRequired`); ETH balance thin (0.0035 ETH) — verify against a live cost quote once identity exists. I repaired none of these.
