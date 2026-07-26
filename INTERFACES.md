# INTERFACES.md — verified interface facts

Classification: **VERIFIED** (cited to pinned source `path:lines @ SHA`), **OBSERVED** (runtime behavior seen read-only on this machine), **HYPOTHESIS/UNRESOLVED** (not yet confirmed — do not build on it).

Pinned sources:

| Repo | Branch | SHA | Checkout |
|---|---|---|---|
| block/buzz | main | `dd222a509b156ba52ed3219e895d7bf1cf322c92` | `~/code/upstream-pins/buzz` |
| OriginTrail/dkg | main | `bf919a03e0b4a731431932a14637c42ecaec9ab9` | `~/code/upstream-pins/dkg` |
| OriginTrail/dkg-integrations | main | `c944c9cbf48c227e54592986c0c995059720b8d5` | `~/code/upstream-pins/dkg-integrations` |

Detailed audits: `docs/audit/buzz-audit.md`, `docs/audit/dkg-audit.md`, `docs/audit/integrations-audit.md`.

## Production baseline (OBSERVED, read-only, 2026-07-26)

- Node home `~/.dkg-mainnet`; config: `name: okf-mainnet`, `apiPort: 9200`, `listenPort: 9090`, `nodeRole: edge`, HTTP auth enabled, store backend `oxigraph-server`, `lastNetworkConfig: mainnet-base`.
- **Node not running** (stopped cleanly 2026-07-20T20:38Z per `daemon.log`; operator paused all local nodes). No listener on 9200. Nothing was started, stopped, or modified.
- SPEC §8 claims (v10.0.8, Base 8453, `hasIdentity: false`, async publisher disabled) could not be re-verified live; version 10.0.8 corroborated by backup dir `~/.dkg-mainnet.bak-pre-v1008-20260719`. All §8 items remain **stale-until-D1**.
- FIFA Context Graph identification: **impossible while node is down** → UNRESOLVED, exactly as §8 anticipates. Daemon log (2026-07-19) references sync of `cg 7`.
- Port reservations to respect in all test stacks: 9200/9201/9090/9210/9250/9301+/8545/8547/9320/7880/9700 (production + historic + currently-listening local services).

## Buzz (VERIFIED @ dd222a5 — details & citations in docs/audit/buzz-audit.md)

- **Architecture:** Rust NIP-29 Nostr relay (`buzz-relay`, Postgres+Redis) + desktop/mobile/web clients + agent-first CLI (`buzz-cli`, binary `buzz`) + `buzz-workflow` YAML engine + ACP agent harness. Channels are relay-side Postgres rows keyed by UUID, referenced on the wire by NIP-29 `h` tags. Threads, members, reactions are first-class and **relay-enforced**.
- **Headless member: fully supported.** One secp256k1/Schnorr keypair; NIP-42 over WebSocket (relay proactively sends AUTH challenge) or NIP-98-signed HTTP bridge (`POST /events|/query|/count`). Reference: `examples/countdown-bot` (subscribe `{"kinds":[9],"#h":[channel]}`, detect own pubkey in `p` tags, reply kind 9). `buzz-ws-client` and `buzz-sdk` crates exist for exactly this.
- **CLI ops verified:** `buzz channels list|join`, `buzz messages thread --channel U --event E`, `buzz messages send --channel U --content ... --reply-to E`, `buzz reactions add|remove|get`. Writes return `{event_id, accepted, message}`; reads return sig-stripped JSON arrays. Transport = HTTP bridge with NIP-98.
- **Kinds that matter to us:** message kind **9** (`h` tag required), thread roots/replies via NIP-10 `e` tags with `root`/`reply` markers (relay materializes thread metadata and rejects broken ancestry); reaction kind **7** targeting via `e` tag — relay derives the channel from the *target* event, fail-closed; pin = kind **40004**; channel create 9007; membership add 9000 / join-request 9021; relay-signed membership notices 44100/44101 (p-gated).
- **Reaction workflow trigger EXISTS:** `buzz-workflow` `TriggerDef::ReactionAdded` with optional `emoji` config compared **literally against reaction content**; dispatch is server-side on every persisted event. Actions include `send_message` and `call_webhook` (SSRF-guarded, 10s timeout, **no retries** — the daemon must not rely on webhook delivery). Inbound `POST /hooks/{id}` uses a shared secret, not NIP-98. The `add_reaction` action appears dead (targets a nonexistent route).
- **Custom kinds REJECTED** by the relay (exhaustive kind allowlist; `restricted: unknown event kind`). ⇒ Receipts and any DKG metadata must ride ordinary kind-9 replies (content + tags). Never fork the relay (§4.1), so no registry patch.
- **Not append-only:** NIP-09 kind-5 self-delete + admin kind-9005 soft-delete hide events from all reads. ⇒ The service must snapshot full source events (id, sig, author, tags, content, created_at) at capture time; re-fetch later may fail legitimately.
- **Membership/authorization:** relay admission via pubkey allowlist / NIP-43 relay membership / NIP-OA owner attestation (owner vouches for agent key in the NIP-42 AUTH event — this is Buzz's native answer to §4.8 identity binding); channel membership via kind 9000/9021 or HTTP invite mint/claim (kind 9009 invites are a no-op).
- **Mentions:** `p` tags, resolved client-side; bot detects mention = own pubkey in `p` tags. `@handle` text is a client convention.
- **Isolated stack:** relay binds `BUZZ_BIND_ADDR` (default 0.0.0.0:3000), needs Postgres (5432) + Redis (6379); migrations auto-apply; fixed `BUZZ_RELAY_PRIVATE_KEY` recommended; allowlist/membership gates off for dev. Official image `ghcr.io/block/buzz` exists but lags our pin by 103 relay-relevant commits → we build `buzz-relay:dd222a5` and `buzz-cli:dd222a5` images locally from the pinned checkout.

## dkg-integrations / bounty (VERIFIED @ c944c9c — details in docs/audit/integrations-audit.md)

- Registry is **metadata-only**: one JSON file `integrations/<slug>.json` per submission (schema-validated in CI); code/design/demo live in our own repo, published to npm (pinned version, provenance, no install scripts).
- Required fields include `memoryLayers` (WM/SWM/VM), `v10PrimitivesUsed`, `publicInterfacesUsed` (http-api/cli/mcp only — matches §4.2), `security.networkEgress` + `security.writeAuthority`, `trustTier: community` on submit.
- **Round 1 is WM/SWM-scoped in CI code**: validate.mjs hard-flags VM write routes (`/publish`, `/endorse`, `/verify`, `/update`) as out-of-scope; VM appears only as required `promotionPath` prose. Web-sourced (2026-07-26): 50k TRAC pool, ≤10k/submission, tag `cfi-dkgv10-r1`; "chat threads → Shared Memory" is an explicitly suggested build.
- Nearest templates: `cursor-mcp-dkg.json`; pending PRs #9 (Telegram bot), #3 (dkg-wm-bridge). No Slack/Discord/Buzz entry exists or is pending.

## DKG v10 (VERIFIED @ bf919a0, monorepo v10.0.9 — details & citations in docs/audit/dkg-audit.md)

- **WM/SWM/VM are official protocol terms** (`packages/core/src/memory-model.ts`, `CONTEXT.md`). Assertion states: `created → promoted → published → finalized`, strictly forward-only.
- **Real lifecycle verbs:** `create → write → finalize → share → publish`. `finalize` = seal (merkle root + EIP-712 author attestation). `share` = WM→SWM (formerly "promote") and is **full-KA atomic** — subset shares rejected 400 `KA_ATOMIC_SHARE_REQUIRED`, which matches §4.4's "one finalized, fully shared SWM KA" exactly. `publish` = SWM→VM on-chain finality.
- **Primary surface: daemon HTTP API** (default 127.0.0.1:9200; `GET /.well-known/skill.md` on a running node is the canonical route contract). CLI (`dkg`) and MCP (`dkg-mcp`) are thin clients. → the daemon integrates against HTTP, CLI only as verified-gap fallback (per Stage C guidance).
- **Auth:** `Authorization: Bearer <token>` from `<DKG_HOME>/auth.token`; on by default; **localhost NOT exempt**; public routes: `GET /api/status` (carries `version`, `hasIdentity`, `identityId`), `/api/chain/rpc-health`, `/.well-known/*`, `/ui`.
- **Lifecycle routes:** `POST /api/knowledge-assets` (create WM draft); `POST .../{name}/wm/write` (`{quads:[{subject,predicate,object,graph?}], contextGraphId}` → `{written:n}`); `.../wm/finalize` (→ `{assertionUri, merkleRoot, authorAddress, eip712Digest,…}`); `.../swm/share[-async]` (`{contextGraphId, awaitCuratorAck?}`); `.../vm/publish[-async]` (async → 202 `{jobId, intentKey, kaUal, sealMerkleRoot,…}`, duplicate intent → 409 `existingJobId`). Read-back: `GET /api/knowledge-assets/{name}` (lifecycle descriptor), `.../wm/quads`, per-layer `GET .../{id}/{wm|swm|vm}`.
- **Idempotency:** no transport-layer replay defence for Bearer callers (source comment says handle idempotence at application layer) — our daemon owns dedup keyed by Nostr event ID + operation/digest (§9). Timeout recovery: descriptor read-back, `GET /api/publisher/job-by-intent`, on-chain `resolvePublishByTxHash`.
- **Graph-scoped SPARQL enforceable server-side:** `POST /api/query` `{sparql, contextGraphId, view: working-memory|shared-working-memory|verifiable-memory, …}`; caller `FROM` clauses and out-of-scope `GRAPH <iri>` throw 400 `Scoped query violation`; engine wraps patterns in server-chosen GRAPH blocks; mutation SPARQL rejected. This satisfies §7 point 3.
- **Semantic search exists and is CG-scoped by construction:** `POST /api/memory/search` `{query, contextGraphId (required), memoryLayers?}`; vector arm needs a configured `embeddingProvider` (OpenAI), SPARQL substring arm always works.
- **Identifiers:** assertion coordinate = named graph `did:dkg:context-graph:<cgId>[/<sub>]/assertion/<agentAddress>/<name>`; layer graphs `…/{_working_memory|_shared_memory|_verifiable_memory}/…`; CG id = string (`<curatorAddr>/<name>` convention) + on-chain bigint id; **UAL = 3-part `did:dkg:{chainId}/{contract-or-author}/{kaId}`** (e.g. `did:dkg:base:8453/0x…/N`).
- **Publish params:** `epochs` EXISTS in v10 (default 12); cost = stake-weighted avgAsk × publicBytes × epochs / 1024; Base mainnet `base:8453` hub `0x99Aa…1d13`. Publisher identity: on-chain profile + conviction stake; `hasIdentity:false` blocks attribution; identity 0 = "no-attribution mode" exists but D3 remains operator-gated.
- **Bind to existing CG:** membership via `request-join <cg> <curatorPeerId>` → curator `approve-join` (signed delegation, off-chain); read/sync via `subscribe` or config `contextGraphs:[…]`. Policies: `accessPolicy` 0 public/1 private; `publishPolicy` 0 curated/1 open.
- **Isolated devnet VERIFIED:** `API_PORT_BASE=9301 ./scripts/devnet.sh start [N]` — Hardhat 31337 (`HARDHAT_PORT`, default 8545 — **in use on this machine, must override**), N nodes under `.devnet/`, funded wallets (100 ETH + 1M TRAC minted), auto-registers CGs `devnet-test`/`devnet-isolation` on-chain, `DEVNET_NO_AUTH=1` and `DEVNET_ENABLE_PUBLISHER=1` knobs. Default `API_PORT_BASE=9201` collides with historic live-node port — always override. `UI_PORT` default 5173 also in use locally.

## dkg-integrations / bounty (pending Gate A audit — see docs/audit/integrations-audit.md)

_To be filled from the audit._
