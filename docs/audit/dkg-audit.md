# DKG v10 Source Audit (for integration spec)

Repo: `/Users/zigadrev/code/upstream-pins/dkg` (OriginTrail/dkg), pinned @ `bf919a03e0b4a731431932a14637c42ecaec9ab9` (branch main, monorepo version **10.0.9** — `package.json:3`).
All citations are `path:lines @ bf919a0`. Classification: **VERIFIED** (read in source), **OBSERVED** (from repo docs/comments, not traced to executing code), **HYPOTHESIS/UNRESOLVED**.

## Summary

- The three memory layers are REAL protocol terms: **Working Memory (WM) → Shared Working Memory (SWM) → Verifiable Memory (VM)** (`packages/core/src/memory-model.ts:13-17`, `CONTEXT.md:28-38`).
- The real lifecycle verbs are **create → write → finalize (seal) → share (WM→SWM) → publish (SWM→VM)**. "Finalize" is the seal verb (merkle root + EIP-712 author attestation); "share" is the old "promote"; "publish" is the on-chain finality op. Assertion states: `created → promoted → published → finalized` (`memory-model.ts:65-87`).
- Primary machine surface is the daemon **HTTP API** (default port **9200**, Bearer-token auth); the CLI (`dkg`) and MCP server (`dkg-mcp`) are both thin clients over it. **The HTTP API is the more stable integration surface**: the repo's own docs call the daemon-generated `GET /.well-known/skill.md` "the canonical route contract" (`docs/references/api.md:9-13`), while the CLI carries deprecation churn (`dkg assertion` aliases, deprecated flags) and renames.
- **Graph-scoped SPARQL IS enforceable server-side**: `POST /api/query` resolves view+CG to an allowed named-graph set, rejects caller `FROM` clauses and out-of-scope explicit `GRAPH <iri>` patterns with `Scoped query violation` (400), and wraps the pattern in server-chosen `GRAPH` blocks.
- Devnet: `./scripts/devnet.sh start [N]` — Hardhat chain :8545 + N nodes. **DEFAULT `API_PORT_BASE=9201` — collides with this machine's historical live-node port; always override (e.g. `API_PORT_BASE=9301`).**
- v10 on-chain publish still takes `epochs` (default 12) and `tokenAmount`; Base mainnet (8453) and Base Sepolia (84532) are first-class network configs.
- UAL template (VERIFIED): `did:dkg:{chainId}/{contractOrAuthorAddress}/{kaId}` — 3-part, built by `buildKnowledgeAssetUal` (`packages/chain/src/chain-adapter.ts:161-168`); the v6-style 4-part `<contract>/<collection>/<token>` form does not exist in v10.
- Idempotency: no HTTP idempotency header; async VM publish dedupes on an **`intentKey`** (409 + `existingJobId` on conflict) and `GET /api/publisher/job-by-intent` is the documented lost-202 recovery/read-back route.

## Repo layout — VERIFIED

pnpm/turbo monorepo, workspaces = `packages/*` + `demo` + `devnet/*` suites (`pnpm-workspace.yaml:1-34`).

| Package | npm name | Role |
|---|---|---|
| `packages/cli` | `@origintrail-official/dkg` (bin **`dkg`** → `dist/cli.js`) | **The node.** CLI + the daemon itself: HTTP server, all `/api/*` routes live in `packages/cli/src/daemon/routes/*.ts`. There is no separate "node" package. |
| `packages/core` | `@origintrail-official/dkg-core` | Protocol core: memory model, named-graph URI grammar, gossip topics, crypto/seal (`assertion-seal.ts`) |
| `packages/agent` | `@origintrail-official/dkg-agent` | `DKGAgent` runtime (WM/SWM ops, query, CG membership) |
| `packages/publisher` | `@origintrail-official/dkg-publisher` | Sync + async VM publish pipeline (lift jobs) |
| `packages/chain` | `@origintrail-official/dkg-chain` | EVM adapters (publish tx, identity/profile, PCA) |
| `packages/query` | `@origintrail-official/dkg-query` | SPARQL engine, read-only guard, view→graph scoping |
| `packages/storage` | `@origintrail-official/dkg-storage` | Triple-store backends (oxigraph, oxigraph-server, blazegraph, sparql-http) |
| `packages/mcp-dkg` | `@origintrail-official/dkg-mcp` (bin **`dkg-mcp`**) | **MCP server exists** — "exposes the local DKG daemon (projects, sub-graphs, activity, chat) to Cursor, Claude Code…" (`packages/mcp-dkg/package.json` description) |
| `packages/node-ui` | dashboard UI | Vite web UI served by the daemon |
| others | `evm-module` (contracts+hardhat), `network-sim`, `epcis`, `okf`, `adapter-{elizaos,hermes,openclaw}`, `kafka-plugin`, `graph-viz`, `random-sampling`, `rdf-utils` | |

Top-level: `scripts/devnet.sh` (devnet), `devnet/` (per-scenario vitest suites), `network/*.json` (chain configs), `docs/` (canonical concept + reference docs), `ARCHITECTURE.md`, `CONTEXT.md` (project vocabulary).

## Lifecycle & naming (the real WM/SWM/VM verbs) — VERIFIED

Canonical vocabulary (`CONTEXT.md:28-38`):
- **Working Memory** — "local editable layer where a Knowledge Asset draft is created and written before it is shared or published".
- **Shared Working Memory** — "replicated pre-publication layer where receiving nodes apply, validate, and acknowledge KA data before publication is finalized".
- **Verifiable Memory** — "confirmed KA layer populated after successful publication or chain-driven reconciliation".

Memory model (`packages/core/src/memory-model.ts`):
- `MemoryLayer { WorkingMemory='WM', SharedWorkingMemory='SWM', VerifiableMemory='VM' }` (:13-17); layer slugs `_working_memory` / `_shared_memory` / `_verifiable_memory` (:24-33).
- Assertion lifecycle states: `created (WM) → promoted (SWM) → published (VM) → finalized`; `discarded` terminal from `created` only (:65-87).
- Transitions strictly forward-only WM→SWM→VM (:183-190).
- VM trust gradient `TrustLevel { SelfAttested=0, Endorsed=1, PartiallyVerified=2, ConsensusVerified=3 }` (:39-44).

**The real verbs** (VERIFIED in CLI `packages/cli/src/commands/knowledge-asset.ts` and docs `docs/use-dkg/knowledge-asset-lifecycle.md:11-69`, `docs/how-dkg-works/memory-layers.md`):

1. **create** — open a WM draft: `dkg ka create <name> -c <cg>` / `POST /api/knowledge-assets`.
2. **write** — append RDF quads to the draft (additive): `dkg ka write` / `POST /api/knowledge-assets/{name}/wm/write`. Also `import-file` (document extraction into WM).
3. **finalize** — **the exact seal verb.** "Finalize seals the draft with an EIP-712 author attestation over its merkle root" (`docs/how-dkg-works/memory-layers.md`, "Finalize (seal)"). `dkg ka finalize` / `POST /api/knowledge-assets/{name}/wm/finalize`. MCP: `dkg_knowledge_asset_finalize`.
4. **share** — WM→SWM ("the operation formerly called promote", memory-layers.md). `dkg ka share` / `POST /api/knowledge-assets/{name}/swm/share` (+ `share-async` job variant). **v10 share is full-KA atomic only** — selective/subset shares are deprecated no-ops (`packages/mcp-dkg/src/tools/assertions.ts:499-500`; `knowledge-asset.ts:162-167` `assertSharePromotedContent`). Legacy alias: `dkg assertion promote`.
5. **publish** — SWM→VM on-chain finality: `dkg ka publish` (sync) / `dkg ka publish-async` / `POST /api/knowledge-assets/{name}/vm/publish[-async]`. "Publishing is not a normal save operation; it is a finality operation" (memory-layers.md).

Supporting verbs: `pull-from --layer swm|vm` (seed a fresh WM draft from SWM/VM — the edit-loop primitive), `discard`, `query` (WM quads), `history` (lifecycle descriptor). The network-level replication of an already-published KA is a distinct diagnostic lifecycle: "Published KA Sync Lifecycle" (`CONTEXT.md:11-14`). ACK taxonomy during publish: SWM Share ACK, Storage ACK (signs the publish commitment), Sender Key Package ACK (`CONTEXT.md:56-70`).

"Lift" is only an internal async-publisher job term (`packages/publisher/src/lift-job-states.ts`), not an operator verb.

## HTTP API reference (verified)

Server: bare Node `node:http` server (no framework) created at `packages/cli/src/daemon/lifecycle.ts:3435`, `server.listen(apiPort, apiHost)` at :3685 with `apiPort = config.apiPort || 0`, `apiHost = config.apiHost || "127.0.0.1"` (:3666-3667). Default `apiPort: 9200` (`packages/cli/src/config.ts:958`); bound port persisted to `<DKG_HOME>/api.port` (lifecycle.ts:3689). Request pipeline: rate-limit → admission control → CORS → `httpAuthGuard` (:3489) → SSE `/api/events` (:3524) → node-ui handler (:3609) → central router `handleRequest` (`packages/cli/src/daemon/handle-request.ts:342-414`; route groups status, agent-chat, openclaw, hermes, memory, publisher, context-graph, knowledge-assets, kc-chain-metadata, file-serving, query, local-agents, epcis, pca, operational-wallets, notifications, plugins; 404 fall-through :413). Route plugins from `config.routePlugins` may add routes at runtime.

### Auth — VERIFIED
- Enabled by default: `const authEnabled = config.auth?.enabled !== false` (`packages/cli/src/daemon/lifecycle.ts:3298`); disable via `{"auth":{"enabled":false}}` in config.
- Token: **`Authorization: Bearer <token>`** header (`packages/cli/src/auth.ts:824-838` `httpAuthGuard`, `extractBearerToken` :717 accepts bare token too). Admin token auto-generated at first boot into **`<DKG_HOME>/auth.token`** (`auth.ts:32,43-80`); `dkg auth show|rotate|status`.
- **Localhost is NOT exempt from auth.** Loopback exemption exists only for rate limiting (`http-utils.ts` `isLoopbackClientIp`/`shouldBypassRateLimitForLoopbackTraffic`). Public (no-token) paths: GET `/api/status`, `/api/chain/rpc-health`, `/.well-known/skill.md`, `/.well-known/skill-importer.md`, `/ui`, prefixes `/ui/`, `/apps/` (`auth.ts:729-748`).
- Optional signed-request mode (opt-in per request): `x-dkg-timestamp` + `x-dkg-nonce` + `x-dkg-signature` HMAC bound to token+body, with freshness window and nonce replay rejection (`auth.ts:849-940`). SSE `/api/events` accepts `?token=` query param.
- Idempotency note (VERIFIED comment `auth.ts:743-770`): there is **no transport-layer replay defence for plain Bearer** callers; "they must handle idempotence at the application layer or upgrade to signed requests".

### KA lifecycle routes — VERIFIED in handlers (`packages/cli/src/daemon/routes/knowledge-assets.ts`, `PREFIX = "/api/knowledge-assets"` :85)

| Step | Route | Handler |
|---|---|---|
| Create WM draft | `POST /api/knowledge-assets` | knowledge-assets.ts:768 |
| Write quads | `POST /api/knowledge-assets/{name}/wm/write` | :1163 |
| Import document (multipart) | `POST /api/knowledge-assets/{name}/wm/import-file` | :1141 |
| Extraction status | `GET /api/knowledge-assets/{name}/wm/extraction-status` | :1106 |
| Finalize/seal | `POST /api/knowledge-assets/{name}/wm/finalize` | :1205 |
| Share WM→SWM | `POST /api/knowledge-assets/{name}/swm/share` | :1274 |
| Async share | `POST .../{name}/swm/share-async` :1354; jobs `GET /api/knowledge-assets/swm/share-jobs[/{jobId}]` :654,671, `DELETE .../{jobId}` :681, `POST .../{jobId}/recover` :658 |
| Publish SWM→VM (sync) | `POST /api/knowledge-assets/{name}/vm/publish` | :1474 |
| Async VM publish | `POST /api/knowledge-assets/{name}/vm/publish-async` | :1407 |
| Seed WM from SWM/VM | `POST /api/knowledge-assets/{name}/wm/pull-from` | :1242 |
| Discard draft | `POST /api/knowledge-assets/{name}/wm/discard` | :1231 |
| **Read-back WM quads** | `GET /api/knowledge-assets/{name}/wm/quads` | :1076 |
| **Read-back lifecycle descriptor** | `GET /api/knowledge-assets/{identifier}` (:1066); per-layer status `GET .../{id}/{wm,swm,vm}` (:1114) |
| Import artifacts / semantic enrichment | `POST /api/knowledge-assets/import-artifact/{resolve,read,read-markdown}` :634-636; `POST .../semantic-enrichment/write` :637 |

**Removed route**: `POST /api/knowledge-assets/publish` → 404 code `DIRECT_PUBLISH_ROUTE_REMOVED` (:698-704). There is no bare "shared_memory_write" route; the only WM→SWM lift is `swm/share[-async]`.

**Verified request/response schemas** (all knowledge-assets.ts):
- `wm/write` req `{quads: [{subject,predicate,object,graph?}], contextGraphId, subGraphName?}` → 200 `{written: <count>}` (:1163-1203).
- `wm/finalize` → 200 `{assertionUri, merkleRoot, authorAddress, schemeVersion, chainId, kav10Address, eip712Digest}` (:1221-1228).
- `swm/share` req `{contextGraphId, subGraphName?, awaitCuratorAck?, skipSeal?:false}`; an array `entities` is rejected 400 `KA_ATOMIC_SHARE_REQUIRED` (:1278-1301) — full-KA atomic share confirmed at the HTTP layer; internally calls `agent.assertion.promote(...)` (:1303).
- `swm/share-async` → 200 `{jobId, state:"queued"}`; conflict 409 `{error, existingJobId}` (`PromoteJobConflictError`, :1384-1391).
- `vm/publish-async` → **202** `{jobId, status:"accepted", contextGraphId, name, shareOperationId, contentScopeVersion, kaUal, assertionVersion, publicTripleCount, privateTripleCount, sealMerkleRoot, intentKey, subGraphName?}` (:1435-1449); duplicate intent → 409 `AsyncLiftJobConflictError` with `existingJobId` (:1451-1455).
- `vm/publish` (sync) calls `agent.publishFromFinalizedAssertion(...)` (:1497), auto-registers the CG on `CG_NOT_REGISTERED` and retries (:1503-1513), status 200/207/502 via `classifyVmPublish` (:1515). Both publish routes accept `options.publisherNodeIdentityIdOverride` ("0" = no-attribution) (`docs/references/api.md:46`).

**Publisher job routes** (`routes/publisher.ts`): `GET /api/publisher/jobs?status=` :410, `GET /api/publisher/job?id=` :422 (→ `{job}`), `GET /api/publisher/job-payload?id=` :434, **`GET /api/publisher/job-by-intent`** :450-456 — documented as read-only durable-admission recovery "keyed on the lifecycle facts a client always retains (the lost 202 also loses jobId + intentKey)", `GET /api/publisher/journal` :462 (append-only journal), `/stats` :492, `POST /cancel|retry|clear` :498-531.

**Idempotency / read-back after timeout — VERIFIED**: no `Idempotency-Key` header exists; transport-layer Bearer replay dedupe was deliberately removed (`auth.ts:766-800`). Dedupe is application-layer: async VM publish `intentKey` (409 + `existingJobId`), async share job conflict 409. After a lost response: (a) `GET /api/knowledge-assets/{name}` → `AssertionDescriptor` state ∈ created/promoted/published/finalized/discarded + events incl. `kcUal`, `shareOperationId` (`memory-model.ts:89-107`); (b) `GET /api/publisher/job-by-intent` from lifecycle facts; (c) on-chain: `resolvePublishByTxHash` (`packages/chain/src/evm-adapter-publish.ts:429-518`). Pull-from conflicts 409 `WM_DRAFT_CONFLICT`; `discard` is idempotent (`packages/mcp-dkg/src/tools/assertions.ts:747,753-782`).

### Query & other core routes — VERIFIED in handlers
- `POST /api/query` — see SPARQL section. (`packages/cli/src/daemon/routes/query.ts:394-645`)
- `POST /api/query-remote` — `{peerId, lookupType, contextGraphId?, ual?, entityUri?, rdfType?, sparql?, limit?, timeout?}` P2P remote query (`routes/query.ts:835-902`).
- `GET /api/sync/catchup-status?contextGraphId=|jobId=` (`routes/query.ts:904-931`).
- `POST /api/verify` — `{contextGraphId, verifiableMemoryId, batchId, timeoutMs?, requiredSignatures?}` → M-of-N verification; 200 `status:"verified"` or 409 partial/no_quorum (`routes/query.ts:933-1033`).
- `POST /api/endorse` — `{contextGraphId, ual}`; endorser identity comes from the bearer token, body `agentAddress` must match (`routes/query.ts:1035-1097`).
- `POST /api/memory/search` — semantic search, see below (`routes/memory.ts:1752+`).
- `POST /api/shared-memory/catchup`, `/api/shared-memory/host-catchup`, `GET /api/shared-memory/host-mode/stats`, `POST /api/shared-memory/host-mode/subscribe`, `POST /api/shared-memory/verify-batch`, `POST /api/attestation/mint|verify`, `POST /api/memory/turn` (`routes/memory.ts:674-1752`).
- `GET /api/status` — public; response fields include `name, version, commit, commitShort, buildTime, distTag, installMode, peerId, nodeRole, networkId, storeBackend, storeQuads, uptimeMs, connectedPeers, multiaddrs, identityId, hasIdentity, asyncPublisher, chain{chainId, configured, hubConfigured, rpcEndpointCount,…}` (`routes/status.ts:632-771`). **This is the node-version surface** (`version: nodeVersion` :693). `POST /api/identity/ensure` creates the on-chain profile and returns updated `hasIdentity` (`routes/status.ts:1085-1102`).
- CCL policy family `/api/ccl/policy/{publish,approve,revoke,list,resolve}`, `/api/ccl/eval`, `/api/ccl/results` (`routes/query.ts:1099-1277`).
- The daemon self-documents its route contract at `GET /.well-known/skill.md` (generated Node Skill; `docs/references/api.md:9-13`) — treat that as the canonical machine-readable contract on a running node.

### Context-graph routes — VERIFIED (`packages/cli/src/daemon/routes/context-graph.ts`)
- `POST /api/context-graph/create` :529 — req `{id|contextGraphId, name (required), description?, allowedAgents?, allowedPeers?, participantAgents?, publishPolicy? 0|1, accessPolicy?, register?, pcaAccountId?}` (:547-562); legacy `participantIdentityIds`/`requiredSignatures` → 400 `DEPRECATED_CONTEXT_GRAPH_FIELDS` (:532-541).
- `POST /api/context-graph/register` :708 — body `{"id","accessPolicy":0|1,"publishPolicy":0|1}` → `{onChainId}`; "already registered" on repeat; runs `agent.registerContextGraph` → contract `ContextGraphs.createContextGraph(participantAgents, metadataBatchId, accessPolicy, publishPolicy, publishAuthority, publishAuthorityAccountId)`, reads `ContextGraphCreated`, writes `dkg:onChainId` + `status="registered"` to `_meta` (`scripts/devnet.sh:1670-1723` exercises it end-to-end).
- Membership/join: `POST /api/context-graph/{id}/add-participant` :952, `remove-participant` :977, `GET .../participants` :1002, `POST .../request-join` :1017, `GET|PUT .../join-policy` :1109/:1124, `GET .../join-requests` :1177, `POST .../approve-join` :1198, `.../reject-join` :1274, `.../sign-join` :1313, `.../redeliver-approval` :1233, `GET /api/context-graphs/pending-redeliveries` :1263.
- Sub-graphs: `POST /api/sub-graph/create` :835, `GET /api/sub-graph/list` :883.
- Subscribe/bind: `POST /api/context-graph/subscribe` (alias `/api/subscribe`) :1682, `unsubscribe` :1939, `GET|DELETE /api/context-graph/subscriptions` :1961/:2000.
- Misc: `POST .../invite` :798 (deprecated), `manifest/{publish,plan-install,install}` :1364-1564, `reconcile` :1645, `recover-shared-memory` :1657, `rename` :2024, `GET /api/context-graph/list` :2060 (→ `{contextGraphs:[{id, onChainId,…}]}`), `GET /api/context-graph/exists` :2070.

### Other route families (verified handler sites)
Status/identity: `GET /api/info` :794, `/api/connections` :827, `/api/wallet(s)` :962, `/api/wallets/balances` :971, `/api/chain/rpc-health` :1042, `GET /api/identity` :1077, `POST /api/identity/ensure` :1086, `/api/random-sampling/status` :1110, `POST /api/shutdown` :1331 (all `routes/status.ts`). Agents/chat: `/api/agents` , `/api/chat`, `/api/messages`, `/api/invoke-skill`, `POST /api/update` (KA on-chain update w/ `precomputedUpdateAttestation`) — `routes/agent-chat.ts:450-969`. Files: `GET /api/file/{hash}` (`routes/file-serving.ts:27`). KC metadata: `GET /api/kc/{id}/author` (`routes/kc-chain-metadata.ts:15,51`). EPCIS `/api/epcis/*`, PCA `/api/pca/*`, operational wallets `/api/operational-wallets`, notifications, local-agent integrations, SSE `GET /api/events`, shared-memory TTL settings `GET|PUT /api/settings/shared-memory-ttl` (lifecycle.ts:3540-3584).

## CLI reference (verified)

Binary: **`dkg`** (`packages/cli/package.json` bin → `dist/cli.js`; source `packages/cli/src/cli.ts:37-64`). Docs: `docs/references/cli.md`. The CLI is an HTTP client of the local daemon (`packages/cli/src/api-client.ts`).

### Daemon
`dkg init [--role edge|core --network <name> --store <backend>]`, `dkg start [-f]`, `dkg stop`, `dkg status`, `dkg logs` (`packages/cli/src/commands/lifecycle.ts:125-305`). No `dkg daemon` verb; `start` spawns a detached supervisor.

### KA lifecycle (`dkg knowledge-asset` = `dkg ka`, `packages/cli/src/commands/knowledge-asset.ts:230-599`)
```
dkg ka create <name> -c <cg> [--input-file f.ttl] [--no-finalize] [--share] [--await-curator-ack]
dkg ka write <name> -c <cg> --input-file f.ttl        # or --triples <json> / --subject/--predicate/--object
dkg ka import-file <name> -c <cg> -f <doc> [--content-type t] [--ontology-ref uri]
dkg ka extraction-status <name> -c <cg>
dkg ka finalize <name> -c <cg> [--author-agent-address a] [--pre-signed-author-attestation ..]
dkg ka share <name> -c <cg> [--await-curator-ack]      # WM→SWM (full-KA atomic)
dkg ka share-async <name> -c <cg>; ka share-jobs|share-job <id>|cancel-share-job|recover-share-job
dkg ka publish <name> -c <cg>                          # sync SWM→VM; prints KA ID / UAL / Tx hash
dkg ka publish-async <name> -c <cg> [--publisher-node-identity-id 0]
dkg ka pull-from <name> -c <cg> --layer swm|vm [--on-conflict reject|replace]
dkg ka discard | ka query | ka history <name> -c <cg>
```
One-shot: `dkg ka create notes -c my-project --input-file notes.ttl --share` (create+write+finalize+share, no VM publish). `dkg assertion …` = compat aliases (`import-file`, `promote` = share).

### Context graphs (`packages/cli/src/commands/context-graph.ts:104-572`)
```
dkg context-graph create <id> [-n name] [--access-policy 0|1] [--allowed-agent addr]... [--private] [--subscribe]
dkg context-graph register <id> [--access-policy 0|1] [--publish-policy 0|1] [--pca-account-id id]   # on-chain, unlocks VM
dkg context-graph list | info <id> | agents <id> | catchup-status <id>
dkg context-graph add-agent <id> --agent <addr> | remove-agent <id> --agent <addr>
dkg context-graph create-sub-graph <id> <subGraphName>
dkg context-graph join-policy status|open|manual <id> [--max-members N --max-approvals-per-hour N]
```
**Bind to an EXISTING context graph** — two distinct mechanisms, both VERIFIED:
1. **Membership (curated CGs)** — delegation handshake, off-chain:
   `dkg context-graph request-join <cgId> <curatorPeerId>` (signs a join delegation and forwards it over P2P; curator peer id comes from the V10 invite `"<cgId>\n<peerId>"`) → curator runs `dkg context-graph approve-join <cgId> --agent <addr>` (or `reject-join`); `sign-join` produces the delegation without forwarding for out-of-band handoff; `join-requests` lists pending (`context-graph.ts:319-432`).
2. **Subscription (read/sync, no membership)** — `dkg subscribe <cgId>` (alias `dkg knowledge subscribe`), MCP `dkg_subscribe`, or listing the CG in config `contextGraphs: [...]` (auto-subscribed at startup as "explicit operator intent", `docs/references/cli.md:104-118`). Every node auto-subscribes to control-plane CGs `agents` and `ontology`.

### Other groups
`dkg query [cg] -q "<sparql>"`, `dkg query-remote <peer>`, `dkg verify <batchId>`, `dkg endorse <ual>`, `dkg publisher {enable,publish-async,jobs,stats,…}`, `dkg pca {create,register-agent,funds,settle,info}`, `dkg wallet`, `dkg set-ask`, `dkg auth {show,rotate,status}`, `dkg mcp {serve,setup}`, `dkg epcis`, `dkg okf`, `dkg ccl`, `dkg doctor`, `dkg update/rollback` (`packages/cli/src/cli.ts:37-64`; `docs/references/cli.md`).

## MCP server tools — VERIFIED (`packages/mcp-dkg`, bin `dkg-mcp`; also `dkg mcp serve` = stdio passthrough, `packages/cli/src/commands/mcp.ts:106-136`)

Server bootstrap `packages/mcp-dkg/src/index.ts:43-66`. Every tool takes an implicit `projectId` (= contextGraphId) default from workspace `.dkg/config.yaml`. Tools are thin wrappers over the daemon HTTP API (`packages/mcp-dkg/src/client.ts`).

Read (`src/tools.ts`): `dkg_list_context_graphs` (:87, `scope?: mine|all`), `dkg_sub_graph_list` (:134), `dkg_query` (:185 — `sparql, projectId?, subGraphName?, view?, includeSharedMemory?, limit?` → `POST /api/query`), `dkg_get_entity` (:240), `dkg_get_entity_sources` (:362 — per-fact KA grounding), `dkg_list_activity` (:529), `dkg_get_agent` (:637).

KA lifecycle (`src/tools/assertions.ts`): `dkg_knowledge_asset_create` (:167 — `name, quads?, alsoShareSwm?`; one-shot create→write→seal→share), `…_write` (:353), `…_finalize` (:431 — seal), `…_share` (:492 — atomic seal+share WM→SWM), `…_publish` (:556 — SWM→VM, `publishEpochs?, publisherNodeIdentityIdOverride?, registerIfNeeded?, accessPolicy?`; returns UAL/kaId/txHash), `…_pull_from` (:701), `…_discard` (:753), `…_query` (:785), `…_import_file` (:949), `…_history` (:1062), plus import-artifact resolve/read-markdown (:829/:859) and `…_semantic_enrichment_write` (:891).

Setup (`src/tools/setup.ts`): `dkg_context_graph_create` (:69 — `name, id?, sharing?: open|invite-only, contribution?: open|curators-only`), `dkg_context_graph_register` (:167 — on-chain), `dkg_subscribe` (:232 — **the MCP bind-to-existing-CG path**, `contextGraphId, includeSharedMemory?`), `dkg_sub_graph_create` (:285). `dkg_request_hosting` deliberately NOT registered (:317-337).

Health (`src/tools/health.ts`): `dkg_status` (:37), `dkg_peer_info` (:72), `dkg_wallet_balances` (:106). Search: `dkg_memory_search` (`src/tools/memory-search.ts:173`, trust-weighted VM>SWM>WM). Chat: `dkg_send_message` (`src/tools/chat.ts:121`), `dkg_check_inbox` (:223). Operator CLI inside dkg-mcp: `dkg-mcp join <invite-code>` (workspace install + subscribe), `dkg-mcp status` (`src/cli/index.ts:37-95`).

## Context Graphs

- **Concept** (VERIFIED docs `docs/how-dkg-works/context-graphs.md`): a CG is a scoped knowledge domain ("project" in UI); contains sub-graphs (`chat`, `code`, `tasks`, `decisions`, `meta`, …).
- **Identity** (VERIFIED): locally a CG is a **string id** — non-empty, ≤256 chars, charset `^[\w:/.@\-]+$` (`packages/core/src/constants.ts:582-587` `validateContextGraphId`); new ids additionally forbid `_`-prefixed segments (`:598-609`). Convention for user CGs is wallet-scoped `<curatorAddress>/<name>` (curator derivable from the id, `constants.ts:611-626`); bare ids in `context-graph create` are auto-prefixed with the agent address (`commands/context-graph.ts:143-146`). System CGs are bare: `agents`, `ontology` (`packages/core/src/genesis.ts:9-10,95-108`). **On-chain**: `ContextGraphs` contract mints a `bigint` id (`packages/chain/src/chain-adapter.ts:491-493`), surfaced as `onChainId`/`v10Id` and gossiped as the `dkg:contextGraphOnChainId` triple (`scripts/devnet.sh:1670-1755`); the name-registry path uses `nameHash = keccak256(utf8(name))` (`packages/chain/src/evm-adapter-context-graph.ts:204,216-235`), also used to derive the SWM gossip topic for hosting cores (`chain-adapter.ts:471-488`).
- **Policies** (VERIFIED): two orthogonal dials on `CreateOnChainContextGraphParams` (`packages/chain/src/chain-adapter.ts:462-489`): `accessPolicy` **0 = public/discoverable, 1 = private/curated**; `publishPolicy` **0 = curated publishing, 1 = open publishing**. RDF semantics in `packages/core/src/genesis.ts:253-265`: publishPolicy `"0" → curators-only (only allowedAgents may publish to VM)`, `"1" → open (any wallet may publish to VM)`. On-chain uint8 readable via `ContextGraphStorage.getPublishPolicy(uint256)` (`scripts/devnet.sh:1728-1746`). MCP maps `sharing: open|invite-only` → accessPolicy, `contribution: open|curators-only` → publishPolicy (`packages/mcp-dkg/src/tools/setup.ts:69-229`). PCA-tied registration checks `pcaAccountId` ownership.
- **Roles/membership** (VERIFIED): projected from the CG `_meta` graph — `curator(s)`, `allowedAgents[]`, `participantAgents[]`, `participantIdentityIds[]`, `revokedAgents[]` (`packages/agent/src/context-graph-meta-projection.ts:40-48`; predicates `DKG_CURATOR`, `DKG_ALLOWED_AGENT`, `DKG_REVOKED_AGENT`, `DKG_PARTICIPANT_AGENT` in `genesis.ts:267,365,377`). `allowedAgents` = local access control for private CGs; `participantAgents` = on-chain registration metadata (`packages/agent/src/dkg-agent-context-graph.ts:461-464`).
- **Join/admission** (VERIFIED): join-policy modes `'manual' | 'open'` with hard bounds `OPEN_ENROLLMENT_MAX_MEMBERS=10_000`, `MAX_APPROVALS_PER_HOUR=1_000`, parser fails closed to manual (`packages/core/src/context-graph-join-policy.ts:7-11,43-84`); open enrollment only for private CGs (`packages/agent/src/dkg-agent-join.ts:729-733`); admission engine verifies the signed `SignedAgentDelegation`, capacity+rate reservation, member-cap recheck, durable audit (`packages/agent/src/context-graph-join-admission.ts:246,531-710`).
- **Permission checks** (VERIFIED): HTTP callers resolve bearer token → agent address; endorse forces token identity (`routes/query.ts:1049-1078`); CCL policy mgmt 403 for non-owners (`routes/query.ts:1147-1153`); WM reads fail-closed per agent (RFC-29 gate, `routes/query.ts:407-580`). Read/sync auth for private CGs: `authorizePrivateSyncRequest` recovers the EIP signer and checks participant/peer/agent gates (`packages/agent/src/sync/auth/request-authorize.ts:90-252`); query-time private-CG graph filtering in `packages/agent/src/dkg-agent-query.ts:595-603,676,756`. VM publish: CG must be registered on-chain; publishPolicy 0 restricts to curator + allowedAgents/registered PCA agents (`dkg-agent-context-graph.ts:1121,1254-1279,1315,1401`; on-chain check `packages/publisher/src/publish-handler.ts:411`).
- **Replication/sync** (VERIFIED): (1) live gossip — per-CG GossipSub topics `dkg/context-graph/<id>/shared-memory|finalization|update|app|sessions` (`packages/core/src/constants.ts:237-262`); (2) **durable sync** — pull-based, paged, merkle-verified, resumable catch-up (`packages/agent/src/sync/requester/durable-sync.ts` + checkpoint/session modules); the assertion seal travels via durable sync, not gossip (`packages/core/src/assertion-seal.ts:134-136`). Plus SWM catch-up on peer connect (`syncSharedMemoryOnConnect`, devnet.sh:614-619), `/api/sync/catchup-status`, host-mode for core-hosted public CGs, and the periodic `discoverContextGraphsFromChain` sweep. Edge nodes treat discovered CGs as catalogue entries (`subscribed:false`) until explicit subscribe/join; core nodes still auto-subscribe (compat until #1611) (`docs/references/cli.md:104-127`).

## SPARQL & retrieval scoping — VERIFIED

Route: **`POST /api/query`** (`packages/cli/src/daemon/routes/query.ts:394-645`). Body (JSON, not query-param):
```json
{ "sparql": "...",                    // required; read-only (SELECT|CONSTRUCT|ASK|DESCRIBE)
  "contextGraphId": "...",            // scope to one CG
  "view": "working-memory" | "shared-working-memory" | "verifiable-memory",
  "subGraphName": "...", "assertionName": "...",
  "agentAddress": "0x...",            // required for working-memory view
  "includeSharedMemory": bool,        // (alias includeWorkspace)
  "includeContextGraphPartitions": bool,
  "verifiedGraph": "...", "graphSuffix": "...",
  "minTrust": "ConsensusVerified"|0..3  // verifiable-memory view only
}
```
Response: `{ result: { bindings: [...] , quads?: [...] }, phases: { execute, serverTotal } }` (`routes/query.ts:607-610`; ASK surfaces through bindings — `packages/query/src/sparql-guard.ts:46-56`).

**Scoping IS enforced server-side** (all in `packages/query/src/dkg-query-engine.ts`):
- `resolveViewGraphs(view, contextGraphId, opts)` maps view+CG(+subGraph/assertion/agent) to an explicit allowed set of named graphs / graph prefixes (:63-140).
- Caller dataset clauses are rejected: `assertNoCallerDatasetClauses` throws `Scoped query violation: FROM clauses are not allowed on scoped local queries` (:1295-1300).
- Explicit `GRAPH <iri>` patterns outside the allowed set throw `Scoped query violation: GRAPH <…> is outside the allowed graph set` (`assertExplicitGraphIrisAllowed` :1352-1360).
- The engine itself wraps the pattern in server-chosen `GRAPH <g> { … }` blocks / UNION branches (:2585-2683). Mutation SPARQL is rejected outright (read-only guard, `sparql-guard.ts:1-80`). HTTP maps these to 400 (`routes/query.ts:614-641`).
- WM view additionally enforces per-agent isolation: cross-agent WM reads require admin token or agent-scoped auth, else 403/empty (fail-closed, `routes/query.ts:496-580`).

**Graph layers/URIs that exist** (see Identifiers below): per-CG root `did:dkg:context-graph:<id>`, `/_meta`, `/_private`, `/_shared_memory[ _meta]`, `/_working_memory/...`, `/_verifiable_memory/<id>[/_meta]`, `/assertion/<addr>/<name>`, sub-graph variants `<id>/<sub>/…`. SWM reads use the OT-RFC-46 "read-both" filter spanning the bucket and per-KA layer graphs excluding `/staging/` (`packages/core/src/constants.ts:293-313`).

## Semantic/vector search — VERIFIED

Yes, on the public HTTP surface: **`POST /api/memory/search`** (`packages/cli/src/daemon/routes/memory.ts:1752-1880`). Body: `{ query: string, contextGraphId: REQUIRED, limit?: <=100 (default 20), memoryLayers?: ["wm","swm","vm"] }`. Hybrid fan-out: (1) vector search via `VectorStore.search(embedding, {contextGraphId, memoryLayers, minSimilarity:0.3})` — only when an `embeddingProvider` is configured (OpenAI embeddings, `packages/cli/src/vector-store.ts`); (2) SPARQL substring search over schema.org name/description, graph-filtered by CG+layer prefixes (:1812-1846). **So yes — it is constrained to exactly one Context Graph by construction.** Results: `{entityUri, label, sources:["vector"|"sparql"], similarity, sourceFile, snippet, memoryLayer}`. MCP wrapper: `dkg_memory_search` (trust-weighted VM>SWM>WM, `packages/mcp-dkg/src/tools/memory-search.ts:173+`).

## Identifiers (KA name vs assertion vs UAL…) — VERIFIED

All URI builders in `packages/core/src/constants.ts:268-360`:

| Identifier | Form | Where |
|---|---|---|
| **KA name** | operator-chosen slug, IRI-safe ≤256 chars, unique per (CG, agent, subGraph) | `validateAssertionName` (dkg-core); `dkg ka create <name>` |
| **Assertion identifier / coordinate** | named graph `did:dkg:context-graph:<cgId>[/<sub>]/assertion/<agentAddress>/<name>` | built `contextGraphAssertionUri` (:329-333), parsed `parseContextGraphAssertionUri` (:349-368); agentAddress = lowercase 0x EVM addr (`canonicalKnowledgeAssetAgentAddress` :392-397) |
| **Named graph URIs (layers)** | CG data `did:dkg:context-graph:<id>`; meta `…/_meta`; private `…/_private`; SWM bucket `…/_shared_memory` (+`_meta`); WM per-KA `…/_working_memory/<addr>/<number>`; VM `…/_verifiable_memory/<vmId>` (+`/_meta`) | :268-320; uniform per-KA layout `…/{_working_memory|_shared_memory|_verifiable_memory}/{addr}/{number}` (`memory-model.ts:19-33`) |
| **Context Graph ID** | local string id (regex `^[\w:/.@\-]+$`, convention `<curatorAddr>/<name>`); on-chain bigint id or keccak256 nameHash | see Context Graphs section |
| **On-chain KA id** | packed `kaId = (uint160(author) << 96) \| uint96(number)` — pack/unpack `packages/agent/src/ka-identity.ts:11-28`; legacy sequential ids have `kaId >> 96 === 0` (:44-50); `batchId` = knowledge-collection id; `startKAId`/`endKAId` range from `KnowledgeAssetCreated` | `packages/chain/src/evm-adapter-base.ts:3642-3693` (`OnChainPublishResult`) |
| **UAL** | **VERIFIED template**: `` did:dkg:${chainId}/${knowledgeAssetsContract.toLowerCase()}/${kaId} `` — `buildKnowledgeAssetUal`, `packages/chain/src/chain-adapter.ts:161-168`. Deterministic/rootless v10 form: `did:dkg:{chainId}/{0x-authorAddress}/{kaNumber}` (`ka-identity.ts:39-64`), parsed by regex `^did:dkg:([^/]+)\/(0x[0-9a-fA-F]{40})\/([0-9]+)$` (`packages/core/src/ka-content-scope.ts:72,86-116`). `chainId` is CAIP-like, e.g. `base:8453`. **3-part; the v6-era 4-part collection/token UAL does not exist in this tree.** Canonical operator-facing id (`CONTEXT.md:16-18`) |
| Merkle root / assertion version | 32-byte root stored as `xsd:hexBinary` without `0x` (`assertionMerkleRoot`, `packages/core/src/assertion-seal.ts:39-40,175-176`); one-based `assertionVersion` (:67-68); private side `privateMerkleRoot` (:72); seal binds EIP-712 author attestation + `reservedKaId=(author<<96)\|number` (:53-60) | `V10PublishParams.merkleRoot` (`chain-adapter.ts:613`) |

The local write identity of a KA is a graph-scoped content scope `{ual, chainId, agentAddress, kaNumber, assertionVersion}` (`packages/core/src/ka-content-scope.ts:21-35`); the human "name" is only the trailing segment of the assertion-coordinate `_meta` subject and the route param.

A successful **sync VM publish** returns KA ID, UAL, tx hash and status (CLI prints these, `knowledge-asset.ts:463-487`; HTTP `vm/publish` → `{ual, kaId, txHash, status, kas}` per MCP handler `assertions.ts:556-698`). An **async** publish 202 returns `{jobId, intentKey, kaUal, shareOperationId, sealMerkleRoot, …}` (`routes/knowledge-assets.ts:1435-1449`); terminal job state carries `finalization: { ual, batchId, finalizedAt }` (`memory-model.ts:143-162`). Post-publish receipts written to `_meta` as `publishedAtTx`/`publishedAtBlock` (`assertion-seal.ts:104-108`).

## Publish & chain — VERIFIED (agent-audited, citations spot-checkable)

- **`epochs` still exists in v10.** `V10PublishParams { contextGraphId: bigint, merkleRoot, knowledgeAssetsAmount, byteSize, epochs, tokenAmount, isImmutable, merkleLeafCount, publisherNodeIdentityId, author (EIP-712), ackSignatures, reservedKaId, catalogRoot/catalogLeafCount }` (`packages/chain/src/chain-adapter.ts:602-694`). Submitted in `createKnowledgeAssets` (`packages/chain/src/evm-adapter-base.ts:3398-3543`).
- Default `DEFAULT_PUBLISH_EPOCHS = 12` (`packages/publisher/src/publisher.ts:6`); overridable per publish (`publishEpochs`, `publisher.ts:352-355`; MCP `publishEpochs` param).
- **Cost estimation**: `quoteRequiredPublishTokenAmount = stakeWeightedAverageAsk * publicByteSize * epochs / 1024` (`packages/chain/src/evm-adapter-publish.ts:33-46`; exposed as `getRequiredPublishTokenAmount` :399-402). PCA (Publishing Conviction Account) vs direct-TRAC-spend plan resolution: `packages/chain/src/publisher-plan.ts:117-182`.
- **Chains** (`network/*.json`): Base mainnet `"chainId":"base:8453"`, hub `0x99Aa571fD5e681c2D27ee08A7b7989DB02541d13` (`network/mainnet-base.json:14-29`); Base Sepolia `"base:84532"`, hub `0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6` (`network/testnet.json:22-36`); Gnosis 100, NeuroWeb 2043; local hardhat chainId 31337 (`packages/evm-module/hardhat.node.config.ts:35-59`), devnet config `"chainId": "evm:31337"` (`scripts/devnet.sh:648-653`).
- **Publisher identity**: on-chain profile via `Profile.createProfile(adminAddr, [], nodeName, nodeId, 0)` + V10 stake `DKGStakingConvictionNFT.createConviction` (`packages/chain/src/evm-adapter-identity.ts:286-383`); admin wallet (`adminPrivateKey`) mandatory for profile creation; operational wallets registered via `Profile.addOperationalWallets` signed by admin (:17-147); publish-time wallet selection needs native gas + TRAC ≥ quote, else `InsufficientPublisherFundsError` (`evm-adapter-publish.ts:120-153`, `evm-adapter-base.ts:2173-2205`).
- **`hasIdentity`**: `/api/status` reports `identityId` and `hasIdentity: identityId > 0n` (`routes/status.ts:755-756`); RPC failure → `{identityId:"0", hasIdentity:false}` (:1097-1101); `POST /api/identity/ensure` creates it. Ops needing a profile throw "node has no on-chain profile (create a profile first)" (`evm-adapter-identity.ts:116-118`). Publisher-wallet identity 0 = allowed "no-attribution mode" for VM publish (`docs/use-dkg/knowledge-asset-lifecycle.md:41-43`).
- **Publish result & finality**: `OnChainPublishResult { kaId/batchId, startKAId, endKAId, knowledgeAssetsContract, txHash, blockNumber, txIndex, blockTimestamp, publisherAddress, authorAddress, gasUsed, gasCostWei, tokenAmount, convictionCostCovered? }` (`evm-adapter-base.ts:3676-3693`). Async job states: `accepted → claimed → validated → broadcast → included → finalized | failed` (`packages/publisher/src/lift-job-states.ts:1-41`; mirrored as `PublicationState` in `memory-model.ts:134-141`).

## Isolated devnet how-to — VERIFIED (`scripts/devnet.sh`, 2171 lines)

```bash
cd /path/to/dkg && pnpm run build          # devnet auto-builds if dist missing (devnet.sh:138-143)
API_PORT_BASE=9301 ./scripts/devnet.sh start [N]   # default N=6: 4 core + 2 edge
./scripts/devnet.sh status | logs [N] | stop | clean
# npm aliases: pnpm devnet:start / devnet:stop / devnet:status / devnet:clean (package.json)
```

What `start` does: launches a **Hardhat chain** (from `packages/evm-module`, config `hardhat.devnet.config.ts`, 1s interval mining — devnet.sh:57-77), deploys contracts (hub address → `.devnet/hardhat/hub_address`; token/contract addresses → `packages/evm-module/deployments/localhost_contracts.json`), generates per-node homes `.devnet/node<N>/` with `config.json` + `wallets.json` (admin = well-known Hardhat mnemonic key, 3 random op wallets funded 100 ETH + 1M minted TRAC — devnet.sh:96-107, 660-707), then starts each node via `DKG_HOME=$node_dir DKG_NO_BLUE_GREEN=1 DKG_WALLETS_NO_MIGRATE=1 node packages/cli/dist/cli.js start` (devnet.sh:929-956), waits on `GET /api/status`, stakes core nodes, and **registers two context graphs on-chain via node 1's API**: `POST /api/context-graph/register` with `{"id":"devnet-test","accessPolicy":0,"publishPolicy":1}` and `devnet-isolation` (devnet.sh:1684-1723). Every node's config pre-binds `"contextGraphs": ["devnet-test","devnet-isolation"]` + `localBootstrapContextGraphs` (devnet.sh:640-641), so a test CG exists out of the box.

**Ports (defaults — LANDMINE FLAGGED):**
| What | Env var | Default |
|---|---|---|
| HTTP API, node i | `API_PORT_BASE` + i − 1 | **9201, 9202, …** (`devnet.sh:47`) — **9201 was a live production node port on this machine; 9200 is the production default apiPort. ALWAYS run devnet with `API_PORT_BASE=9301` (or similar) here.** |
| libp2p, node i | `LIBP2P_PORT_BASE` + i − 1 | 10001… (:48) |
| Hardhat RPC | `HARDHAT_PORT` | 8545 (:46) |
| Triple stores | — | nodes 1-2: daemon-managed `oxigraph-server` on 7901/7902 (`DEVNET_OXIGRAPH_BASE`+n, :575-580); nodes 3-4: Blazegraph docker :9999 else in-process oxigraph (:581-591); nodes 5-6: external Oxigraph docker 7878/7879 via `sparql-http` else managed (:592-599). Production default backend = `oxigraph-server` on 7878 (:558-566) |
| node-ui Vite | `UI_PORT` | 5173 (:49) |

Other env knobs: `DEVNET_DIR` (default `<repo>/.devnet`), `NUM_CORE_NODES` (4), `DEVNET_NO_AUTH=1` (writes `"auth":{"enabled":false}}`, :604-607 — otherwise devnet uses a shared bearer token in `.devnet/node1/auth.token`, :966-972), `DEVNET_ENABLE_PUBLISHER=1` (async publisher + publisher-wallets.json, :608-612 — required for `pnpm test:devnet:ka-lifecycle-cli`), `DEVNET_EPCIS_CONTEXT_GRAPH`, `DEVNET_SWM_SYNC_ON_CONNECT=0`, `HARDHAT_BLOCK_INTERVAL_MS`, mixed-version knobs. Node config template (apiPort/listenPort/nodeRole/relay/store/contextGraphs/publisher/chain `{type:"evm", rpcUrl:"http://127.0.0.1:8545", hubAddress, chainId:"evm:31337"}`): devnet.sh:631-655.

Ready-made suites: `pnpm test:devnet:v10-core-flows | v10-e2e | greenfield-10min | ka-lifecycle-cli | …` (root `package.json`; suites in `devnet/*/automated.test.ts` — e.g. greenfield gate does `dkg ka create --share` + `dkg ka publish` into `devnet-test`, then `/api/update`, staking, random sampling — `devnet/greenfield-10min/README.md`). Everything is isolated to `.devnet/` + Hardhat 31337; the ONLY host-port risks are the API/libp2p/store/UI ports above.

## Open questions / UNRESOLVED

1. **`POST /api/knowledge-assets` (create) request schema** — handler at `routes/knowledge-assets.ts:768` verified as the create route; its exact field-by-field body (beyond `{name, contextGraphId, quads?, subGraphName?, share?}` implied by CLI/MCP mappings) was not transcribed. The self-generated `GET /.well-known/skill.md` on a running daemon is the canonical machine contract for all request bodies.
2. **`intentKey` derivation** — dedupe behavior VERIFIED (409 + `existingJobId`; recovery via `/api/publisher/job-by-intent`), but the exact derivation function of `intentKey` from lifecycle facts was not read.
3. **Selective share** — `--entity <uri...>` still parses on `dkg ka share`, but the HTTP layer rejects array `entities` with 400 `KA_ATOMIC_SHARE_REQUIRED` (`knowledge-assets.ts:1278-1301`) and MCP marks subsets deprecated no-ops. Treat v10 share as full-KA atomic.
4. `includeContextGraphPartitions` and `graphSuffix` query options — accepted by `/api/query` (`routes/query.ts:400-404`) but semantics not traced in this pass.
5. **MCP dynamic adapters** — `loadAdapters(server, client, config)` (`packages/mcp-dkg/src/index.ts:62`) can register additional tools at runtime; the static tool list (see CLI/MCP section) is complete only for the built-ins.
6. Vector search config surface — `/api/memory/search` vector arm requires a configured `embeddingProvider` (OpenAI); which config key enables it (`config.llm`? dedicated embeddings key?) was not pinned.
