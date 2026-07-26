# Gate D1 report — production read-only validation + designated test channel

Date: 2026-07-26. Authorization: SPEC §0 `authorized_stage: D1` (Gate C accepted by the operator in session; designated test channel: **dkg-test**).

**Status: PARTIAL — one branch complete, one branch NO-GO pending an operator infrastructure action.** Per §10, the blocked branch was not worked around.

## 1. Authorized Buzz write — COMPLETE

The sole write authority in D1 was exercised, and nothing else:

| Item | Value |
|---|---|
| Channel | `dkg-test`, uuid `56059d1d-77bb-4d94-af79-97bb30547ac8` |
| Relay | `127.0.0.1:9440` (the local pinned-build relay — the only Buzz relay in this deployment; §0 note records this designation) |
| Creation event | kind 9007 `9a33bdfa…a96c207a`, accepted=true |
| Service membership | service pubkey `181e08ed…ec1bab1` is the channel creator (owner-member) |
| Other Buzz events posted | **none** — no messages, no invitations, no reactions |

Note on durability: the relay currently runs as a session-started host process (`phase0/run-relay-host.sh`), not a system service. Fine for D-stage tests; worth a launchd unit before anything longer-lived.

## 2. Production read-only recheck (§8) — NO-GO, node not running

Live recheck attempted 2026-07-26: **no listener on 9200; no API response; `~/.dkg-mainnet/daemon.log` unchanged, last line `[2026-07-20T20:38:03.728Z] Stopped.`** The okf-mainnet node has been stopped since the operator paused all local nodes (2026-07-13/20).

Consequently NOT verifiable live, and therefore still stale: node version (10.0.8 claimed), Base chain 8453 confirmation, auth readiness, **publisher identity** (`hasIdentity:false` claimed), wallet balances, **FIFA context-graph identification** (id/name/curator/membership/permissions/sync state), available layers, vocabulary samples, citation surfaces.

**I did not start the node and will not: D1 grants "read-only inspection… no node changes", and locked principle §4.10 reserves node lifecycle to the operator.** (Separate authority note: my 2026-07-13 pause notes record the agreed resume order — network proxy first, then nodes — if you want to bring it up yourself; alternatively an explicit instruction to start it would be a new, separate authorization outside this D1 run.)

### Ready-to-run recheck (one command each, all read-only, once the node is up)

```
GET /api/status                      # version, chain 8453, hasIdentity, identityId, asyncPublisher
GET /api/wallets/balances            # wallet readiness (sufficient/insufficient)
GET /api/context-graph/list          # FIFA CG candidates → id/onChainId
GET /api/context-graph/{id}/participants ; GET .../join-policy   # curator/membership/permissions
GET /api/sync/catchup-status?contextGraphId={id}                 # sync state
POST /api/query (bounded, predicate-focused samples; no broad scans)
```

## 3. Grounded dry run (FIFA questions) — BLOCKED by the same prerequisite

The daemon's §7 pipeline (channel→CG resolve, scoped retrieval, evidence gate, citation validation, refusal; no-post mode) is implemented and was exercised end-to-end against the isolated stack in Gates B/C, including refusal behavior. The D1-required dry run **against the production FIFA CG** cannot run with the node down. To be executed immediately after the recheck above: two FIFA-supported questions + one unrelated question, recording graph scope, retrieval queries, evidence records, citations resolved, and proof of no cross-graph access and no Buzz posts.

## 4. Proposed channel↔graph mapping and proposed-but-not-written KA

Proposed mapping (pending FIFA CG identification): `dkg-test (56059d1d-77bb-4d94-af79-97bb30547ac8)` ↔ `<FIFA CG id — to be proven in the recheck>`; authorized promoter npub(s): **operator to designate** (D2 block field).

Proposed source thread (2 messages, clearly labeled test data — **not posted**; posting is outside D1 authority and awaits operator approval or D2):

1. root: `D2 test capture: verifying the Buzz→DKG SWM path on the production context graph. This thread is integration test data.`
2. reply: `DECISION: buzz-dkg-integration D2 test payload — confirm one KA reaches Shared Working Memory with full provenance, then stop.`

Proposed KA (all values deterministic once the thread exists — the "digest plan"):

- name: `buzz-dkg-<first 12 hex of sha256(canonical source set)>`
- root URI: `urn:buzz-dkg:decision:<full source-set sha256>`
- payload: exactly the deterministic distiller output (`src/distill/deterministic.ts`, regression-locked byte-identical) over the two events — ~36 quads: root DecisionCluster (`rdf:type prov:Entity, buzz:DecisionCluster; schema:name/description = the DECISION line; buzz:channel <urn:buzz:channel:56059d1d-…>; buzz:sourceSetDigest; buzz:sourceEventCount 2; prov:wasGeneratedBy; 2× prov:wasDerivedFrom`), one `buzz:Distillation` activity (`prov:used ×2, prov:wasAssociatedWith urn:nostr:pubkey:181e08ed…`), two `nostr:Event` snapshots (kind/createdAt/content/sig/tags/threadIndex, `prov:wasAttributedTo`), author + service agent nodes. Reviewable concretely in `docs/acceptance-transcript.md` and `phase0/demo.md`, which show this exact shape rendered from live threads.
- expected side effects of the D2 lifecycle: one WM draft + finalize (seal) + one full SWM share in the approved CG; one in-thread receipt in `dkg-test` **only if** the D2 approval reference covers posting; **no VM publication, no wallet transactions, no CG/policy changes**.

## 5. D2 / D3 gate assessment

**D2: NO-GO for now.** Unmet: FIFA CG unambiguously identified (blocked, node down); caller share permission verified; operator-approved target location; reviewable payload appendix (template ready; concrete after the thread exists); read-back availability confirmed live. Met: test channel exists; service member known; production runtime untouched.

**D3: NO-GO (unchanged, reported separately per spec).** Last-known publisher identity absent (`hasIdentity:false`), async publisher disabled — operator prerequisites: create the on-chain profile/identity, enable publishing, ensure ETH+TRAC balances. Not repaired by me; recheck live once the node runs.

## Operator decision needed to complete D1

1. **Start the okf-mainnet node** (your action, or explicitly authorize me — that authorization is outside the current D1 grant). Everything in §2–§3 then runs read-only within minutes.
2. After the recheck: **designate the FIFA CG** (or an alternative existing CG, or defer D2/D3) — §8 requires an explicit operator decision if identification is ambiguous.
3. Optionally approve posting the two-message source thread in `dkg-test`, and name the authorized promoter npub(s) for the D2 block.
