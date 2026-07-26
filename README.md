# buzz-dkg-integration

Reference integration between [Buzz](https://github.com/block/buzz) and
[OriginTrail DKG v10](https://github.com/OriginTrail/dkg): a standalone daemon
that joins Buzz rooms as an external member, turns explicitly signalled
conversations into layered DKG memory (WM → SWM → VM), and answers in-room
questions using evidence exclusively from the room's designated Context Graph.

Canonical specification: [SPEC.md](SPEC.md) · Design: [docs/DESIGN.md](docs/DESIGN.md) ·
Verified interfaces: [INTERFACES.md](INTERFACES.md) · Gate reports: `docs/gates/`.

**Status: all stages executed (A–E), 2026-07-26.** Source audit → isolated
spike → daemon (48 tests, zero-mock acceptance demo) → production validation →
one operator-approved SWM share → one operator-approved on-chain publication.

## Live evidence (Base mainnet)

- **UAL:** `did:dkg:base:8453/0x633e5a7c5e612d9981538f60d824cc03be97e2ab/2201`
  — tx `0x6daf3e0bad8cba13f7508f69c5550750a30294e997bf5e7fdffe9a24170dbb38`
  (block 49145748), published from a signed Buzz thread through the full
  WM → finalize → SWM → ✅-approval → VM lifecycle into the "FIFA World Cup
  2026" Context Graph (on-chain id 7).
- Screen recordings: `docs/media/buzz-dkg-live-loop.gif` (the live channel:
  thread → pin → SWM receipt → ✅ → VM receipt → grounded Q&A + refusal) and
  `docs/media/buzz-dkg-node-ui.gif` (the node UI: knowledge pipeline,
  DecisionCluster KA, provenance trail).
- Every stage gate has a report + transcript under `docs/gates/` (A through E),
  including the §6 approval-invariant preflights and spend accounting.

## What it does

- **Capture**: a pin (kind 40004) or `@dkg distill` mention snapshots the
  thread *as of the trigger* (full signed events), distills it
  deterministically into one PROV-O decision cluster, walks it through
  `create → write → finalize (seal) → full SWM share`, verifies with a scoped
  read-back, and replies in-thread with a receipt (assertion coordinate,
  KA name, source digest).
- **Approval**: an authorized promoter's ✅ on that receipt is validated
  against the nine SPEC §6 invariants in code. Publication is mode-gated:
  `disabled` (default) or `devnet` (requires chain evm:31337). On success the
  UAL is posted as a second in-thread receipt.
- **Ask**: `@dkg ask <question>` retrieves only from the room's Context Graph
  (server-enforced scoped SPARQL), answers extractively with validated
  citations, and refuses explicitly when evidence is insufficient — no model
  required, no fallback to any other graph.

## Run (isolated stack) — ~10 minutes

Prereqs: Node ≥ 22.5, Docker, pnpm, Rust (for the relay binary).

```bash
# 1. Isolated stacks (full details + port map: phase0/ISOLATION.md, phase0/README.md)
#    Buzz: postgres/redis/minio containers + relay built from the pinned checkout
cd phase0 && docker compose -f docker-compose.spike.yml up -d postgres redis minio minio-init
./run-relay-host.sh &          # needs phase0/.env.spike (see .env.spike.example)
#    DKG devnet (from the pinned OriginTrail/dkg clone):
API_PORT_BASE=9420 LIBP2P_PORT_BASE=10401 HARDHAT_PORT=8655 \
DEVNET_OXIGRAPH_BASE=7920 DEVNET_BLAZEGRAPH_PORT=19999 \
DEVNET_OXIGRAPH_SERVER_PORT_5=7931 DEVNET_OXIGRAPH_SERVER_PORT_6=7932 \
UI_PORT=5573 DEVNET_ENABLE_PUBLISHER=1 ./scripts/devnet.sh start 6

# 2. Daemon
npm install
cp .env.example .env           # fill BDI_SERVICE_KEY, BDI_DKG_TOKEN_PATH, bindings
npm start

# 3. Everything at once, self-checking (the Gate C acceptance demo):
node scripts/acceptance.mjs    # writes docs/acceptance-transcript.md
```

`bindings.json` (one channel ↔ one Context Graph, per SPEC §4.3):

```json
[{ "channelId": "<uuid>", "contextGraphId": "devnet-test", "promoters": ["<hex-pubkey>"] }]
```

## Development

```bash
npm run typecheck && npm run lint && npm test    # 48 tests, no network
npm run format
```

Tests use in-memory doubles for the relay and node; the acceptance demo uses
no mocks at all. `phase0/` contains the earlier spike (bridge scripts + real
transcript) that de-risked every interface the daemon relies on.
