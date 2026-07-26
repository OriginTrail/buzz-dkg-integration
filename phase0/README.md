# Phase 0 — isolated spike

Proves the smallest real loop with existing verified tools only (no daemon):
pinned Buzz thread → snapshot → deterministic distillation → one KA through
WM → finalize → full SWM share into an isolated devnet Context Graph → scoped
read-back → in-thread receipt → replay dedup → authorized ✅ approval →
devnet VM publish → UAL verification → final receipt.

Everything runs against a disposable stack; see `ISOLATION.md` for the
port/path/store disjointness proof. **Never point any of this at production.**
The orchestrator hard-stops unless the DKG node reports chain 31337.

## Prerequisites

- Docker (with buildx), Node ≥ 22, pnpm.
- Pinned clones (SHAs in ../INTERFACES.md):
  - `~/code/upstream-pins/buzz` @ dd222a5 — build images:
    `docker build -t buzz-relay:dd222a5 .` and
    `docker build -t buzz-cli:dd222a5 -f <this repo>/phase0/Dockerfile.buzz-cli .`
  - `~/code/upstream-pins/dkg` @ bf919a0 — `pnpm install && pnpm run build`.

## Run

```bash
# 1. Spike identities (throwaway; never reuse):
node - <<'EOF'
// regenerates phase0/.env.spike — see .env.spike.example for the shape
EOF

# 2. Isolated Buzz stack (relay on 127.0.0.1:9440):
set -a; source phase0/.env.spike; set +a
BDI_SPIKE_RELAY_KEY=$BDI_SPIKE_RELAY_KEY \
  docker compose -f phase0/docker-compose.spike.yml up -d

# 3. Isolated DKG devnet (6 nodes on 9420-9425, hardhat 8655):
cd ~/code/upstream-pins/dkg
API_PORT_BASE=9420 LIBP2P_PORT_BASE=10401 HARDHAT_PORT=8655 \
DEVNET_OXIGRAPH_BASE=7920 DEVNET_BLAZEGRAPH_PORT=19999 \
DEVNET_OXIGRAPH_SERVER_PORT_5=7931 DEVNET_OXIGRAPH_SERVER_PORT_6=7932 \
UI_PORT=5573 DEVNET_ENABLE_PUBLISHER=1 ./scripts/devnet.sh start 6

# 4. The loop:
cd <this repo>/phase0/bridge
BDI_ALLOW_TEST_PUBLISH=1 node spike.mjs
```

The real transcript of a successful run is `demo.md`. Bridge state (dedup
keys, receipts, consumed approvals) is `bridge/state.json` — delete it plus
`demo.md` for a fresh run.

## Teardown

```bash
docker compose -p bdi-spike down -v
cd ~/code/upstream-pins/dkg && ./scripts/devnet.sh stop && ./scripts/devnet.sh clean
```
