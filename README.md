# buzz-dkg-integration

Reference integration between [Buzz](https://github.com/block/buzz) and
[OriginTrail DKG v10](https://github.com/OriginTrail/dkg): a standalone daemon
that joins Buzz rooms as an external member, turns explicitly signalled
conversations into layered DKG memory (WM → SWM → VM), and answers in-room
questions using evidence exclusively from the room's designated Context Graph.

Canonical specification: [SPEC.md](SPEC.md) · Design: [docs/DESIGN.md](docs/DESIGN.md) ·
Verified interfaces: [INTERFACES.md](INTERFACES.md) · Gate reports: `docs/gates/`.

**Status: all stages executed (A–E), 2026-07-26.** Source audit → isolated
spike → daemon (51 tests, zero-mock acceptance demo) → production validation →
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
  against the nine SPEC §6 invariants in code (including a re-read of the
  shared graph's source-set digest at approval time). Publication is
  mode-gated by `BDI_PUBLISH_MODE`:
  - `disabled` (default) — approvals are recognised and the §6 invariants are
    evaluated, but publication is refused;
  - `devnet` — publishes only when the node reports chain `evm:31337`;
  - `mainnet` — publishes only when the node reports `base:8453`, additionally
    bounded by `BDI_MAX_PUBLISHES_PER_DAY` (a rolling-24h ceiling; a
    non-numeric value fails startup). **`mainnet` spends real ETH and writes
    irreversibly to Base** — measured cost per publish is recorded in
    `docs/gates/GATE_D3_REPORT.md`.

  On success the UAL is posted as a second in-thread receipt. Every rejection
  posts its reason back into the room so a promoter can tell "accepted" from
  "not authorised" / "budget exhausted" / "relay blip".
- **Ask**: `@dkg ask <question>` retrieves only from the room's Context Graph
  (server-enforced scoped SPARQL), answers extractively with validated
  citations, and refuses explicitly when evidence is insufficient — no model
  required, no fallback to any other graph.

## Deploy against an existing relay + node

This is the deployment the integration advertises: you already run (or can
reach) a Buzz NIP-29 relay and a DKG v10 edge node. Prereqs: **Node ≥ 22.9**
(the daemon uses `--experimental-strip-types`, a 22.6+ feature, and
`--env-file-if-exists`, 22.9+).

1. **Install and configure**

   ```bash
   npm install
   cp .env.example .env      # then edit — every var is documented inline
   ```

2. **Generate the bot's member identity** (`BDI_SERVICE_KEY`) — a fresh Nostr
   secret key, never reused from the spike:

   ```bash
   node -e "import('nostr-tools/pure').then(n=>{const sk=n.generateSecretKey();\
   console.log('BDI_SERVICE_KEY=', Buffer.from(sk).toString('hex'));\
   console.log('service pubkey =', n.getPublicKey(sk))})"
   ```

   Put the hex secret in `.env` as `BDI_SERVICE_KEY`. The printed **pubkey** is
   the identity a channel admin must add (next step); it is also logged as
   `servicePubkey` in the `daemon started` line.

3. **Get the bot into the channel.** The daemon only *subscribes* to bound
   channels — it never self-adds. A NIP-29 channel admin must add the bot's
   service pubkey as a member of the target channel. The **channelId** is the
   channel's NIP-29 group id (the `h` tag on its messages / the id in the Buzz
   channel URL).

4. **Point at a Context Graph.** Create (or choose) a Context Graph on your DKG
   node and note its production id form — `0x<CuratorAddress>/<name>`, e.g.
   `0x633E…/fifa-world-cup-2026` (the `devnet-test` example below is only valid
   on the isolated devnet). The node must already hold the graph; the daemon
   verifies each bound graph exists at startup.

5. **Provide the DKG token.** The node writes its bearer token to
   `<DKG_HOME>/auth.token`; set `BDI_DKG_TOKEN_PATH` to it (the daemon reads the
   last non-comment line) or paste the raw token as `BDI_DKG_TOKEN`.

6. **Bind and run.** Write `bindings.json` (see below) and start:

   ```bash
   npm start                 # loads .env via --env-file-if-exists
   ```

   Publication stays `disabled` until you deliberately set `BDI_PUBLISH_MODE`
   (see **What it does → Approval**). Common first-run silent failures: the bot
   isn't a channel member (starts clean, sees no events); `BDI_DKG_API` points
   at the wrong port (`ECONNREFUSED`); a promoter pubkey in the wrong format
   (npub is accepted and decoded; anything else fails fast at startup).

## Run (isolated stack) — ~10 minutes

Reproduces the full demo end-to-end with no external dependencies.
Prereqs: Node ≥ 22.9, Docker, pnpm, Rust (for the relay binary).

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
[{ "channelId": "<uuid>", "contextGraphId": "devnet-test", "promoters": ["<hex-pubkey-or-npub>"] }]
```

- `contextGraphId` is `devnet-test` **only** on the isolated devnet; against a
  real node use the production form `0x<CuratorAddress>/<name>` (see Deploy §4).
- `promoters` accept a 64-char hex pubkey or an `npub1…` (decoded at load); any
  other format fails fast at startup rather than silently ignoring approvals.

## Development

```bash
npm run typecheck && npm run lint && npm test    # 51 tests, no network
npm run format
```

Tests use in-memory doubles for the relay and node; the acceptance demo uses
no mocks at all. `phase0/` contains the earlier spike (bridge scripts + real
transcript) that de-risked every interface the daemon relies on.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
