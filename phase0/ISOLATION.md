# Phase 0 isolation preflight

Date: 2026-07-26. Requirement: SPEC.md Stage B — prove the test stack shares no paths, ports, stores, token files, wallets, or network state with production before starting anything.

## 1. Production inventory (read-only)

| Asset | Value | State |
|---|---|---|
| Production node home | `~/.dkg-mainnet` (okf-mainnet, Base mainnet) | **stopped** since 2026-07-20T20:38Z; untouched |
| Production API port | 9200 (`config.json apiPort`) | not listening; reserved — never used by us |
| Production P2P port | 9090 (`listenPort`) | reserved |
| Production store | daemon-managed `oxigraph-server` (production default port 7878) | down; 7878/7879 reserved anyway |
| Other node homes | `~/.dkg` (9201), `~/.dkg-client-gnosis` (9210, client infra), `~/.dkg-curator-test` (9200), `~/.dkg-member-local` (9201) | all stopped; all reserved; never referenced |
| Historic live-node port | 9201 (also devnet default `API_PORT_BASE`) | reserved — devnet default overridden |
| Pre-existing external Blazegraph | Java pid 7766, `-Djetty.port=9999 blazegraph.jar` — NOT ours | **hazard**: devnet's `start_blazegraph` adopts any external Blazegraph answering on its port → `DEVNET_BLAZEGRAPH_PORT=19999` forces a fresh Docker container instead |
| Other listeners at preflight | 8545/8547 (hardhat, `~/code/dkg` fork), 5173/5183/5184 (Vite), 9250 (dkg-explorer-v10 adapter), 9700 (agent-blackbox), 8787, 8080-adjacent Chrome, 4321, 3005 | all avoided |
| Buzz upstream compose defaults | postgres 5432, redis 6379, adminer 8082, keycloak 8180, minio 9000/9001, prometheus 9090 | upstream compose NOT used; own compose with no default host ports |
| Wallets / token files | production `wallets.json`, `auth.token` under `~/.dkg-mainnet` etc. | never read or copied; devnet generates its own under `.devnet/` (Hardhat mnemonic + fresh op wallets, chain 31337 only) |

## 2. Test stack assignment (all ports verified free at preflight)

**DKG side** — devnet from the pinned clone `~/code/upstream-pins/dkg` (bf919a0), 6 nodes (4 core + 2 edge — 4 cores are the verified minimum for the 3-of-N StorageACK publish quorum; devnet pins `minimumRequiredSignatures=3`):

| Component | Setting | Value |
|---|---|---|
| Node homes + chain state | `DEVNET_DIR` (default) | `~/code/upstream-pins/dkg/.devnet/node{1..6}` — fresh, disposable, gitignored |
| HTTP API | `API_PORT_BASE=9420` | nodes on 9420–9425 |
| libp2p | `LIBP2P_PORT_BASE=10401` | 10401–10406 |
| Hardhat chain | `HARDHAT_PORT=8655` | chainId 31337, in-memory, throwaway keys |
| Oxigraph (nodes 1–2, daemon-managed) | `DEVNET_OXIGRAPH_BASE=7920` | 7921, 7922 |
| Blazegraph (nodes 3–4) | `DEVNET_BLAZEGRAPH_PORT=19999` | fresh Docker container `devnet-blazegraph`-prefixed; never the external :9999 instance |
| External Oxigraph (nodes 5–6) | `DEVNET_OXIGRAPH_SERVER_PORT_5=7931`, `_6=7932` | fresh Docker containers |
| node-ui | `UI_PORT=5573` | avoids running Vite instances on 5173/5183/5184 |
| Auth | default (enabled) | devnet-generated bearer token in `.devnet/node1/auth.token` — distinct file, distinct value from any production token |
| Async publisher | `DEVNET_ENABLE_PUBLISHER=1` | devnet-generated publisher wallets, funded only on Hardhat 31337 |

**Buzz side** — own compose project `bdi-spike` (file `phase0/docker-compose.spike.yml`), images built from the pinned checkout (`buzz-relay:dd222a5`, `buzz-cli:dd222a5`):

| Component | Value |
|---|---|
| Compose project/network | `bdi-spike` / `bdi-spike-net` (fresh bridge network) |
| Postgres | postgres:17-alpine, **no host port**, fresh named volume `bdi-spike-pg` |
| Redis | redis:7-alpine, **no host port** |
| Relay | `buzz-relay` built from the pinned checkout. Two equivalent variants: container `buzz-relay:dd222a5` (`127.0.0.1:9440 → 3000`) or host process (`run-relay-host.sh`: bind 127.0.0.1:9440, health 9442, metrics 9443, DB/Redis via loopback 15442/15443). The host variant exists because the 2 GB Docker VM OOMs on the upstream multi-binary image build. |
| Postgres/Redis loopback publish (host-relay variant) | `127.0.0.1:15442 → 5432`, `127.0.0.1:15443 → 6379` (both in the verified-free set) |
| Relay key | fixed throwaway `BUZZ_RELAY_PRIVATE_KEY` (generated for the spike, never reused, committed nowhere) |
| Buzz identities | fresh throwaway Nostr keypairs for: human author, second member, service bot, authorized promoter — generated for the spike only |

## 3. Disjointness proof

- **Ports:** every assigned port (9420-9425, 10401-10406, 8655, 7921-7922, 7931-7932, 19999, 9440, 5573) was probed free immediately before assignment; none appears in the production/reserved list above.
- **Paths:** all DKG state under `~/code/upstream-pins/dkg/.devnet/`; all Buzz state in fresh Docker volumes of project `bdi-spike`; the integration repo itself at `~/buzz-dkg-integration`. No path under `~/.dkg*` is read or written.
- **Stores:** nodes 1-2 oxigraph-server on 7921/7922 (production default 7878 untouched); nodes 3-4 fresh Blazegraph container on 19999 (external :9999 instance explicitly bypassed); nodes 5-6 fresh oxigraph containers on 7931/7932.
- **Wallets/funds:** Hardhat 31337 only — well-known mnemonic + freshly generated op wallets funded with devnet ETH/TRAC; no mainnet key material is present anywhere in the stack.
- **Network state:** devnet peers only over local libp2p ports 10401+ with `relay: none`; Buzz relay bound to 127.0.0.1. No production multiaddrs, no public relays.
- **Lifecycle rule honored:** no lifecycle command was or will be run against any production home; no process was stopped to free a port (fresh ports chosen instead — including declining to touch the foreign Blazegraph on :9999).

## 4. Cleanup

`devnet.sh stop && devnet.sh clean` (removes `.devnet/` + devnet containers); `docker compose -p bdi-spike down -v`; images `buzz-relay:dd222a5`/`buzz-cli:dd222a5` retained for Gate C (removable via `docker rmi`).
