# Gate A report — interface and production-readiness audit

Date: 2026-07-26. Authorization: SPEC.md §0 `authorized_stage: ABC`. Everything in this stage was read-only against production and upstream repos; nothing was started, stopped, or modified outside `~/buzz-dkg-integration` and `~/code/upstream-pins/` (fresh clones).

## Pinned sources

| Repo | Branch | SHA | Checkout |
|---|---|---|---|
| block/buzz | main | `dd222a509b156ba52ed3219e895d7bf1cf322c92` (2026-07-26) | `~/code/upstream-pins/buzz` |
| OriginTrail/dkg | main | `bf919a03e0b4a731431932a14637c42ecaec9ab9` (2026-07-22, monorepo v10.0.9) | `~/code/upstream-pins/dkg` |
| OriginTrail/dkg-integrations | main | `c944c9cbf48c227e54592986c0c995059720b8d5` (2026-04-24, still upstream HEAD) | `~/code/upstream-pins/dkg-integrations` |

Full cited audits: `docs/audit/buzz-audit.md`, `docs/audit/dkg-audit.md`, `docs/audit/integrations-audit.md`. Condensed verified facts: `INTERFACES.md`.

## Capability verdict table

| Capability | Verdict | Basis (citations in audits) |
|---|---|---|
| Read thread | **GO** | `buzz messages thread --channel U --event E` over NIP-98 HTTP bridge; two OR'd filters (replies by `#h`+`#e`, root by id); relay materializes thread metadata from NIP-10 markers. Raw-Nostr fallback documented. |
| Publish reply | **GO** | `buzz messages send --channel U --content … --reply-to E` (kind 9 + NIP-10 `reply` marker + `h` tag); write response `{event_id, accepted, message}`. |
| Detect pin | **ADAPT** | Pin is a first-class kind **40004** (not a reaction). Subscribe `{"kinds":[40004],"#h":[channel]}` and correlate via `e` tag. Semantics (who may pin, tag shape) verified in source at kind level only — exact tag layout to be confirmed live in Gate B. |
| Detect authorized approval | **GO (daemon-side)** | Reaction = kind 7, target via `e` tag, relay derives channel from target fail-closed. Our daemon subscribes to kind 7 directly and enforces §6 invariants itself — we do NOT depend on buzz-workflow. (The relay-side `reaction_added` trigger also exists and matches emoji literally vs content; its `add_reaction` action is dead code — not used by us.) |
| Headless relay auth | **GO** | NIP-42 WS (relay proactively challenges; 5s timeout) and NIP-98 HTTP bridge both implemented and verified; in-repo `countdown-bot` is a working reference; NIP-OA owner attestation available for agent-key vouching. |
| WM write | **GO** | `POST /api/knowledge-assets` + `.../wm/write` (quads JSON) + `.../wm/finalize` (seal, EIP-712) verified in route handlers; read-back `GET .../wm/quads`. |
| Full SWM share | **GO** | `POST .../swm/share` verified; full-KA atomic (subset → 400 `KA_ATOMIC_SHARE_REQUIRED`) — exactly the §4.4 model. `awaitCuratorAck` supported; async variant with job read-back. |
| VM publish | **GO (isolated devnet) / NO-GO (production, by default)** | Routes + params (`epochs` default 12, cost quote, UAL format) verified; devnet publishes end-to-end in upstream's own greenfield suite. Production stays NO-GO per §8: publisher identity absent (operator prerequisite), and the node is currently stopped. |
| Graph-scoped SPARQL | **GO** | `POST /api/query` enforces scope server-side: caller `FROM`/out-of-scope `GRAPH` → 400 `Scoped query violation`; server wraps patterns in allowed GRAPH blocks; mutations rejected. |
| Graph-scoped semantic search | **ADAPT** | `POST /api/memory/search` requires `contextGraphId` and filters by CG+layer by construction → scope-safe. Vector arm needs configured `embeddingProvider` (OpenAI); without it only the SPARQL substring arm runs. Daemon treats it as optional enrichment; §7 evidence comes from scoped SPARQL. |
| FIFA CG identification/access | **NO-GO (deferred to D1, as §8 anticipates)** | Production node (`~/.dkg-mainnet`, okf-mainnet, apiPort 9200, Base mainnet, oxigraph-server) is stopped (clean stop 2026-07-20T20:38Z per daemon.log; operator paused all nodes). CG enumeration impossible while down; log evidence of `cg 7` sync only. No blocker for ABC — B/C run fully isolated. |
| Registry submission | **GO (Stage E only)** | Submission = one schema-validated metadata JSON in `integrations/`; code in our repo + npm. Round 1 is WM/SWM-scoped in CI code (VM routes hard-flagged out-of-scope), matching this integration's design; VM appears as required `promotionPath` prose. |

## Gate A exit rule

Neither {read thread, WM write} is NO-GO → per SPEC §Stage-ABC, self-advance to Gate B.

## Key adaptations feeding Gates B/C (recorded in SPEC §12)

1. **Buzz relay rejects unregistered event kinds** → all service output (receipts included) rides ordinary kind-9 thread replies with structured tags + human-readable content. No custom kinds, no relay fork.
2. **Buzz is not append-only** (NIP-09/9005 soft deletes) → the service snapshots complete source events (id, pubkey, sig, tags, content, created_at) at capture time; the provenance chain embeds the snapshot digest rather than assuming later re-fetch.
3. **Pin trigger** = kind 40004 (first-class), not a "pin reaction".
4. **DKG share is full-KA atomic** — validates the spec's one-cluster-per-KA model; no partial shares to design around.
5. **No transport idempotency on DKG HTTP** → dedup and transactional state transitions are wholly the daemon's job (already required by §9); async publish `intentKey` + `job-by-intent` used for D3-style recovery patterns.
6. **Port landmines on this machine** for the isolated stack: 9200/9201 (production/historic API), 9090 (P2P), 8545/8547 (running hardhats), 5173 (running Vite), 9999 (running Java — possible Blazegraph), 5432/6379 (Buzz compose defaults), 9250, 9210, 9320/7880/9700. Gate B assigns from fresh ranges and proves disjointness in `phase0/ISOLATION.md`.

## Production baseline (read-only observations, 2026-07-26)

See `INTERFACES.md` "Production baseline". Summary: node home `~/.dkg-mainnet` (okf-mainnet, edge, Base mainnet, auth enabled, oxigraph-server backend, apiPort 9200) — **not running**, stopped cleanly 2026-07-20. §8 claims (v10.0.8, `hasIdentity:false`, async publisher disabled) could not be re-verified live and remain stale-until-D1; 10.0.8 corroborated by `~/.dkg-mainnet.bak-pre-v1008-20260719`. Nothing under `~/.dkg*` was modified; no lifecycle command was run against any production home.

## Open questions carried into Gate B

- Exact `POST /api/knowledge-assets` create body (canonical contract = `GET /.well-known/skill.md` on the running devnet node — read it there).
- Pin (kind 40004) tag layout and authorization semantics — observe live.
- Workflow `reaction_added` emoji literal-compare semantics — confirm live only if we end up using relay-side triggers at all (current design: we don't).
- Buzz CLI exact JSON field bytes — observe from built `buzz-cli:dd222a5` image.
- Devnet node 3-6 store backends probe Blazegraph :9999 / external Oxigraph 7878-7879 — Gate B must either keep N≤2 or verify the probe cannot latch onto the pre-existing local Java process on :9999 / production oxigraph defaults.
