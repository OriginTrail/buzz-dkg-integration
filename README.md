# buzz-dkg-integration

Reference integration between [Buzz](https://github.com/block/buzz) and
[OriginTrail DKG v10](https://github.com/OriginTrail/dkg): a standalone daemon
that joins a Buzz channel as an external member, turns explicitly signalled
conversations into layered DKG memory (WM → SWM → VM), and answers in-room
questions using evidence exclusively from the room's designated Context Graph.

Canonical specification: [SPEC.md](SPEC.md) · Design: [docs/DESIGN.md](docs/DESIGN.md) ·
Verified interfaces: [INTERFACES.md](INTERFACES.md) · Gate reports: `docs/gates/`.

**Status: all stages executed (A–E), 2026-07-26.** Source audit → isolated
spike → daemon (74 tests, zero-mock acceptance demo) → production validation →
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
    `docs/gates/GATE_D3_REPORT.md`. It is the only mode with node-side
    prerequisites beyond "the node is running": the node must have been set up
    on Base (`dkg init --network mainnet-base` — the DKG default is
    `mainnet-gnosis`, which reports `gnosis:100` and makes this daemon refuse to
    start), and its operational wallet needs funding for gas.

  On success the UAL is posted as a second in-thread receipt. Every rejection
  posts its reason back into the room so a promoter can tell "accepted" from
  "not authorised" / "budget exhausted" / "relay blip". A publish whose outcome
  the node cannot confirm is never announced as anchored: it lands in a terminal
  `publish_unconfirmed` state with an honest in-room note, counts against the
  24h ceiling (gas may already have been spent), and is never auto-retried.
- **Ask**: `@dkg ask <question>` retrieves only from the channel's bound Context
  Graph (server-enforced scoped SPARQL), answers extractively with validated
  citations, and refuses explicitly when evidence is insufficient — no model
  required, no fallback to any other graph. Note the scoping guarantees no
  *other* graph is read, not that only channel-authored content is returned:
  every member of a bound channel is effectively a reader of that Context Graph,
  so bind only graphs whose contents the whole channel may see.

## Prerequisites

- **Node.js ≥ 22.13** for this daemon — it relies on `node:sqlite` (unflagged in
  22.13), `--experimental-strip-types` (22.6) and `--env-file-if-exists` (22.9).
- **A DKG v10 node, ≥ 10.0.8**, running and reachable over HTTP — the version
  this integration is validated against (`docs/gates/GATE_D1_REPORT.md`).
- **A Buzz NIP-29 relay** you can reach, or one built from the pinned checkout
  (see **Run (isolated stack)** below).

### Getting a DKG v10 node

An **edge** node — the default role — is enough: no on-chain node profile, no
staking. The live publication above was made from one.

```bash
npm install -g @origintrail-official/dkg
dkg init      # interactive: network, node name, role, triple store, API port
dkg start     # daemon on http://127.0.0.1:9200
```

`dkg init` defaults to API port **9200**, which is also what `BDI_DKG_API`
defaults to. It also defaults to the **mainnet-gnosis** network — fine for
everything this daemon does by default, but see the `mainnet` note under
**What it does → Approval** before enabling on-chain publishing. To check what
you actually have (public route, no token needed):

```bash
curl -s http://127.0.0.1:9200/api/status    # → version, chain.chainId, nodeRole
```

Wallets are generated during `dkg init` and only need funding for the Verifiable
Memory publish path. Everything the daemon does by default — Working Memory
writes, sealing, Shared Working Memory sharing, and the whole grounded-answering
path — is off-chain and free.

Node docs: [OriginTrail/dkg](https://github.com/OriginTrail/dkg).

## Buzz-first installer preview

The Beta V1a installer starts from a Buzz Relay that is already serving a
community. On a supported Linux relay host, a tagged release is installed and
started with one command:

```bash
curl -fsSL https://github.com/OriginTrail/buzz-dkg-integration/releases/latest/download/install.sh | sudo sh
```

The bootstrap detects `linux/x64` or `linux/arm64`, downloads the corresponding
versioned bundle and checksum, verifies it, atomically activates the CLI under
`/usr/local/bin/buzz-dkg`, and reconnects the guided installer to `/dev/tty`.
The CLI remains available after setup:

```bash
sudo buzz-dkg plan
sudo buzz-dkg status
sudo buzz-dkg logs
sudo buzz-dkg smoke
sudo buzz-dkg remove
```

The guided installer discovers common containerized Buzz Relay deployments or
accepts `--relay wss://community.example.com`. It validates and adopts that
endpoint without replacing the relay process, database, identity, domain, or
TLS configuration. It then reuses a compatible DKG node on `127.0.0.1:9200`,
or invokes the supported DKG npm installer and setup wizard for an Edge
(default) or Core node. Finally it creates the managed Web of Trust channel and
Context Graph, starts the integration sidecar with Verifiable Memory disabled,
and runs an end-to-end smoke check.

For automation or a relay that cannot be inferred from its container metadata:

```bash
sudo buzz-dkg install \
  --relay wss://community.example.com \
  --dkg-role edge
```

`remove` stops only the integration sidecar. It does not delete Buzz history,
integration state, DKG state, or an operator-managed node. Release bundles pin
their own Node runtime; the host does not need Node.js preinstalled. Until the
first installer tag is published, the `releases/latest/download` URL above is
expected to return 404.

## Local one-command M0

The M0 launcher packages a pinned Buzz relay, an isolated one-node DKG 10.0.11
devnet, and this integration into one local lifecycle. It generates stable
identities, creates one `buzz-dkg-canary` channel, creates exactly one
deterministically named Context Graph for that channel, adds the integration as
a bot member, writes the binding, and starts the daemon with VM publication
disabled.

Prerequisites are Docker, pnpm, a compatible Node.js runtime (`>=22.13 <23` or
`>=23.4`), and a sibling DKG checkout named `dkg-v10.0.11`. Override the DKG
checkout or Node binary with `BDI_MVP_DKG_REPO` or `BDI_MVP_NODE` when needed.
Buzz itself runs from an immutable GHCR image pinned in
`deploy/mvp/compose.yml`.

```bash
./buzz-dkg up
./buzz-dkg status
./buzz-dkg smoke
```

`smoke` drives the real relay and node: it posts and pins a synthetic decision,
waits for one SWM receipt, checks that no VM receipt was produced, asks a
supported question and verifies its scoped citation, then checks an unsupported
question is refused. No approval or on-chain publication is attempted.

```bash
./buzz-dkg logs
./buzz-dkg down
```

Secrets and retained runtime state live under `.mvp/` with private permissions
and are ignored by Git. A checkout-wide ignored `.buzz-dkg-m0-control/`
lock/journal safely serializes lifecycle commands even when the state-directory
override is used. `up` is convergent: rerunning it reuses the healthy relay, DKG
node, channel, graph, membership, binding, and daemon. `down` stops only
M0-owned processes and containers and does not delete secrets or Docker
volumes. This is a local development devnet, however, so its Hardhat chain and
graph contents must not be treated as durable production data.

## Deploy against an existing relay + node

This is the deployment the integration advertises: a Buzz NIP-29 relay and a DKG
v10 node you can already reach (see **Prerequisites**), with this daemon running
alongside them.

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

4. **Point at a Context Graph.** Each channel binds to exactly one Context
   Graph, which must already exist on the node — the daemon probes every bound
   graph at startup and refuses to start if one is missing. Creating one is
   free and touches no chain:

   ```bash
   dkg context-graph create my-room        # any name you like
   ```

   The graph is created under **your own** node's agent address: a bare slug is
   auto-prefixed, so the printed `ID:` line comes back as
   `0x<YourAgentAddress>/my-room`. Copy **that** line into `bindings.json` — the
   id is matched as an exact IRI, so the checksummed casing and your full
   address both matter, and an address copied from anywhere else will fail the
   startup probe. `dkg context-graph list` reprints it. (The `devnet-test`
   example below is only valid on the isolated devnet.)

5. **Provide the DKG token.** The node generates a bearer token on first start
   and writes it to `~/.dkg/auth.token` — a comment header plus the token on the
   last line, which is what `BDI_DKG_TOKEN_PATH` expects (the daemon reads the
   last non-comment line). `dkg auth status` prints the path the node actually
   resolved, which differs if you set `DKG_HOME` or run from a monorepo checkout:

   ```bash
   dkg auth status           # → Token file:     /home/you/.dkg/auth.token
   ```

   `BDI_DKG_TOKEN` takes a pasted token instead; prefer the path form so a token
   rotation needs only a daemon restart, not a `.env` edit.

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
Prereqs: Node ≥ 22.13, Docker, pnpm, Rust (for the relay binary).

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
npm run typecheck && npm run lint && npm test    # 74 tests, no network
npm run format
```

Tests use in-memory doubles for the relay and node; the acceptance demo uses
no mocks at all. `phase0/` contains the earlier spike (bridge scripts + real
transcript) that de-risked every interface the daemon relies on.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
