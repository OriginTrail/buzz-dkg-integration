# Gate B report — Phase 0 isolated spike

Date: 2026-07-26. Authorization: SPEC.md §0 stage ABC. Everything ran against the isolated stack proven disjoint in `phase0/ISOLATION.md`; production (`~/.dkg-mainnet` et al.) verified unchanged at exit (no 9200 listener; config mtime 2026-07-13, daemon.log unchanged since the 2026-07-20 stop).

## Result: the smallest real loop is PROVEN, including the test-network VM leg

Real transcript: `phase0/demo.md`. Bridge: `phase0/bridge/` (no daemon — existing verified surfaces only: raw signed Nostr events + NIP-98 HTTP bridge on the Buzz side; daemon HTTP API on the DKG side).

| Step | Evidence |
|---|---|
| Channel + membership (kinds 9007/9000, relay-assigned UUID via 39000) | channel `dkg-spike-2` = `7948e466-5c6c-4d86-a192-1c704429c2a4`; service added with role `bot` |
| 3-message signed thread (kind 9, NIP-10 markers) | root `6f5f42ad…` |
| Pin trigger (kind 40004, `e`+`h` tags) | pin `e69c4ff0…` accepted by relay — 40004 tag convention works |
| Snapshot + deterministic digest | 3 events as-of trigger; sha256 `1cb4a74e49cd…` |
| Deterministic distillation (no model) | 50 quads, PROV-O + `buzz:`/`nostr:` vocab, single root `urn:buzz-dkg:decision:1cb4a74e…` |
| WM create → write → finalize (seal) | `status:"draft-open"` → `{written:50}` → merkleRoot `0x3d4ec35c…`, EIP-712 author `0x71Cfc9B0…` |
| Full SWM share | `{swmShared:true, promotedCount:50, sealed:true, publishReady:true, shareOperationId:"ms1lcnb8-muaupo"}` |
| Scoped SWM read-back | server-scoped query (view=shared-working-memory, CG devnet-test) returns the digest triple; matches source digest |
| In-thread SWM receipt (kind 9 reply) | `41b098e5…` — carries assertion coordinate + KA name + CG + digest |
| **Replay dedup** | same pin reprocessed twice → `DEDUP`, zero new KAs, exactly one service receipt (verified by count) |
| Authorized ✅ approval (kind 7 on the receipt) | `29f958af…` by the configured promoter key |
| §6 invariants in code | all 9 PASS (transcript shows the earlier fail-closed NO-GO when invariant 5 couldn't be evaluated — the gate refuses on uncertainty, as designed) |
| Devnet VM publish (chain 31337) | `status:"confirmed"`, **UAL `did:dkg:evm:31337/0x71cfc9b0…/3`**, tx `0x88965ebb…`, block 2495, 3 StorageACK peers |
| UAL verification | descriptor `state=published` (2 lifecycle events); VM-view scoped query returns 5 bindings |
| Final in-thread VM receipt | `5cad5cc3…` with UAL + approval event id |
| buzz-cli JSON contract (Gate A open question) | native-built `buzz` @ dd222a5: `channels list` / `messages thread` return the documented JSON shapes; thread read shows our receipt in place |

## Environment map (as run)

Buzz: relay = native host binary from the pinned checkout (Docker VM 2 GB OOMs on the upstream multi-binary image; minimal-image Dockerfile kept at `phase0/Dockerfile.buzz-relay-min`), bind 127.0.0.1:9440, health 9442, metrics 9443; Postgres/Redis/minio containers (compose project `bdi-spike`) on loopback 15442/15443/15444. DKG: 6-node devnet (4 core + 2 edge) from the pinned clone, API 9420-9425, Hardhat 8655 (chain evm:31337), oxigraph 7921/7922, fresh `devnet-blazegraph` container on 19999, external-oxigraph containers 7931/7932, UI 5573.

## Findings that feed Gate C (beyond Gate A's)

1. **Trigger snapshot must be as-of-trigger and exclude service-authored events.** Observed live: the SWM receipt is itself a thread reply, so a replayed trigger saw a changed source set → new digest → dedup miss → a second KA + receipt (would loop). Fix proven: source set = `created_at <= trigger.created_at` ∧ `author ≠ service`; dedup keyed on the trigger event id.
2. **Buzz relay is multi-tenant fail-closed by Host header.** A community must be seeded for the exact authority clients use; the relay seeds it at startup from `RELAY_URL` (not `BUZZ_RELAY_URL`). Wrong/absent mapping → generic 404 `no community is configured for this host`.
3. **`BUZZ_AUTO_MIGRATE=1` is required** for first-boot schema; the relay starts and listens even with an unmigrated DB (errors surface per-request).
4. **Buzz NIP-98 has a replay guard**: two byte-identical same-second auth events → 401 `NIP-98: replay detected`. Clients need per-request-unique auth events (monotonic `created_at` in the bridge; the daemon must do the same or serialize).
5. **DKG descriptor route requires `?contextGraphId=`**; response carries `state/memoryLayer/events/…` plus **`reservedUal` before publish** — useful for receipts, but only the post-publish UAL is authoritative.
6. **StorageACK quorum is real in practice**: with 4 cores, losing 2 stores (Blazegraph container OOM-exited in the 2 GB Docker VM) → `storage_ack_insufficient got 1/3` and publish fails cleanly, recoverable by restoring the store and retrying the same KA (no duplicate was created — same name, same seal).
7. Buzz write responses return `{event_id, accepted, message}` exactly as Gate A predicted; sig-stripped reads confirmed.

## Cleanup state

Left RUNNING intentionally for Gate C (acceptance demo needs the same isolated stack): devnet (9420-9425), bdi-spike containers, host relay (pid on 9440). Full teardown commands are in `phase0/README.md`. Spike debris (2 test channels; 4 spike KAs incl. 3 from the pre-fix dedup experiments, one published to devnet VM) lives only in disposable devnet/relay stores.

**Gate B exit criteria met → proceeding to Gate C.**
