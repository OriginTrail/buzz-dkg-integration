#!/bin/bash
# Oxigraph-storm watchdog: if the WoT CG query is slow/failing, snapshot
# evidence and kickstart the node. Runs every 10 min via launchd.
set -u
TOKEN=$(grep -v '^#' "$HOME/.dkg-mainnet/auth.token" | tail -1)
CG="0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/web-of-trust"
LOG=/tmp/node-watchdog.log
ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

T=$(curl -s -m 15 -X POST http://127.0.0.1:9200/api/query \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"contextGraphId":"'"$CG"'","view":"shared-working-memory","sparql":"SELECT (COUNT(*) AS ?n) WHERE {?s ?p ?o}"}' \
  -o /dev/null -w '%{http_code} %{time_total}')
CODE=${T%% *}; SECS=${T##* }
SLOW=$(python3 -c "print(1 if float('$SECS' or 0) > 8 else 0)" 2>/dev/null || echo 1)

if [ "$CODE" = "200" ] && [ "$SLOW" = "0" ]; then
  echo "$(ts) ok ${SECS}s" >> "$LOG"
  exit 0
fi

# Preserve evidence before the restart wipes the hot state.
SNAP="/tmp/storm-evidence-$(date +%s).log"
{ echo "=== watchdog trigger $(ts): code=$CODE t=${SECS}s ==="
  tail -200 /tmp/okf-node-10010.log 2>/dev/null; } > "$SNAP"
echo "$(ts) STORM code=$CODE t=${SECS}s -> kickstart (evidence: $SNAP)" >> "$LOG"
launchctl kickstart -k "gui/$(id -u)/ai.tracelabs.nos.node"
