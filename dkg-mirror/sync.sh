#!/bin/bash
# Sync the OriginTrail/dkg mirror on the Buzz relay with upstream GitHub.
# Fetches upstream, then pushes changed/new heads+tags to the relay in small
# batches (the relay's pre-receive hook has a 30s HMAC TTL — huge ref batches
# time it out and fail closed). refs/pull/* is never mirrored.
# Known-skipped ref: refs/heads/test/842+841-devnet ('+' fails the relay's
# path allowlist with HTTP 400).
set -u
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
MIRROR="$HOME/buzz-dkg-integration/dkg-mirror/dkg.git"
URL="https://macbook-pro-8.tailb02f7e.ts.net/git/7b20d5265af65543cbe6192e1665f8f0730004622c111c381d163cde53ae5bc5/dkg"
LOG="$HOME/buzz-dkg-integration/dkg-mirror/sync.log"
cd "$MIRROR" || exit 1

echo "[$(date -u +%FT%TZ)] fetch upstream" >> "$LOG"
git fetch --prune origin '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*' >> "$LOG" 2>&1

# Diff local heads+tags against the relay; push only what changed.
git ls-remote "$URL" 2>/dev/null | grep -v '\^{}' | awk '{print $1 "\t" $2}' | sort > /tmp/dkg-mirror-remote.txt
git for-each-ref --format='%(objectname)	%(refname)' refs/heads refs/tags | sort > /tmp/dkg-mirror-local.txt
changed=$(comm -23 /tmp/dkg-mirror-local.txt /tmp/dkg-mirror-remote.txt | cut -f2 | grep -v '^refs/heads/test/842+841-devnet$')
count=$(echo "$changed" | grep -c . || true)
cut -f2 /tmp/dkg-mirror-local.txt | sort > /tmp/dkg-mirror-local-names.txt
cut -f2 /tmp/dkg-mirror-remote.txt | sort > /tmp/dkg-mirror-remote-names.txt
deleted=$(comm -13 /tmp/dkg-mirror-local-names.txt /tmp/dkg-mirror-remote-names.txt | grep -E '^refs/(heads|tags)/' || true)
if [ "$count" -eq 0 ] && [ -z "$deleted" ]; then
  echo "[$(date -u +%FT%TZ)] up to date" >> "$LOG"
  exit 0
fi
echo "[$(date -u +%FT%TZ)] pushing $count changed ref(s)" >> "$LOG"
i=0; batch=""
for r in $changed; do
  batch="$batch $r:$r"; i=$((i+1))
  if [ $((i % 15)) -eq 0 ]; then
    git push "$URL" $batch >> "$LOG" 2>&1 || echo "[$(date -u +%FT%TZ)] batch failed" >> "$LOG"
    batch=""
  fi
done
[ -n "$batch" ] && { git push "$URL" $batch >> "$LOG" 2>&1 || echo "[$(date -u +%FT%TZ)] final batch failed" >> "$LOG"; }
# Propagate upstream deletions of branches/tags (prune mirrors them locally).
for r in $deleted; do
  git push "$URL" ":$r" >> "$LOG" 2>&1 || true
done
echo "[$(date -u +%FT%TZ)] sync done" >> "$LOG"
tail -400 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
