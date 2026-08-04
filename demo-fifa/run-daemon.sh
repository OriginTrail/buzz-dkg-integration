#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source phase0/.env.spike; set +a
export BDI_POLL_INTERVAL_S=15
export BDI_BUZZ_HTTP=https://macbook-pro-8.tailb02f7e.ts.net
export BDI_BUZZ_WS=wss://macbook-pro-8.tailb02f7e.ts.net
export BDI_SERVICE_KEY=$BDI_SPIKE_SERVICE_KEY
export BDI_DKG_API=http://127.0.0.1:9200
export BDI_DKG_TOKEN_PATH=$HOME/.dkg-mainnet/auth.token
export BDI_BINDINGS_PATH=demo-fifa/bindings.json
export BDI_PUBLISH_MODE=mainnet
export BDI_MAX_PUBLISHES_PER_DAY=5
export BDI_DB_PATH=demo-fifa/daemon.db
exec node --experimental-strip-types src/index.ts
