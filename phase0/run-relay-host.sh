#!/usr/bin/env bash
# Host-process variant of the spike relay (see ISOLATION.md; container variant
# in docker-compose.spike.yml). Binary: pinned checkout target/release/buzz-relay.
set -euo pipefail
PHASE0="$(cd "$(dirname "$0")" && pwd)"
set -a; source "$PHASE0/.env.spike"; set +a
export DATABASE_URL="postgres://buzz:bdi_spike_pg@127.0.0.1:15442/buzz"
export REDIS_URL="redis://127.0.0.1:15443"
export BUZZ_REDIS_POOL_SIZE=64
export BUZZ_RATE_LIMIT_HUMAN_API_CALLS_PER_MIN=100000
export BUZZ_RATE_LIMIT_HUMAN_MESSAGES_PER_MIN=100000
export BUZZ_BIND_ADDR="0.0.0.0:9440"
export RELAY_URL="wss://macbook-pro-8.tailb02f7e.ts.net"
export BUZZ_HEALTH_PORT="9442"
export BUZZ_METRICS_PORT="9443"
export BUZZ_AUTO_MIGRATE="1"
export BUZZ_S3_ENDPOINT="http://127.0.0.1:15444"
export BUZZ_S3_ACCESS_KEY="buzz_dev"
export BUZZ_S3_SECRET_KEY="bdi_spike_minio"
export BUZZ_RELAY_PRIVATE_KEY="$BDI_SPIKE_RELAY_KEY"
exec "$HOME/code/upstream-pins/buzz/target/release/buzz-relay"
