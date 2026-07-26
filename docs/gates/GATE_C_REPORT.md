# Gate C report — Phase 1 daemon

Date: 2026-07-26. Authorization: SPEC.md §0 stage ABC. The daemon was built and
accepted entirely against the isolated stack from Gate B; **it has never been
pointed at production**, and no production-capable publish path exists in the
code (see Authority posture below).

## Deliverables

- Runnable daemon per SPEC §9 layout (`src/relay|registry|triggers|distill|dkg|ask|receipts|identity`),
  TypeScript strict, zero native deps (SQLite via `node:sqlite`).
- `deploy/docker-compose.integration.yml`; `.env.example`; stranger-runnable `README.md`.
- `docs/DESIGN.md` (verified interfaces, state machine, trust boundaries, deviations),
  `docs/PHASE2.md` (one page, no code).
- Test suite + acceptance demo (below); `ontology/buzz-dkg.ttl`.

## Authority posture (locked principles §4, §6.8/§6.9)

`BDI_PUBLISH_MODE` ∈ {`disabled` (default), `devnet`}. A mainnet mode is
**not implemented** — that authority arrives only with SPEC §0 D-stages.
`devnet` refuses to start, and refuses again at publish time, unless the
connected node reports chain `evm:31337`. Identity-binding KA publication is a
hard `throw` (§4.8). The daemon never runs node lifecycle operations.

## Quality gates (all clean, 2026-07-26)

- `npm run typecheck` — clean (tsc strict).
- `npm run lint` — clean (eslint + typescript-eslint recommended).
- `npm run format:check` — clean (prettier).
- Secret scan — no key or token material in tracked files (spike keys and the
  devnet token grepped verbatim against the git index; 64-hex survey shows
  only public event ids/digests; runtime state files untracked).

## Tests — real output

```
✓ test/registry.test.ts (7 tests)   mapping + missing-map rejection, cursor persistence,
                                    forward-only transitions, trigger/approval/ask dedup, recovery listing
✓ test/ask.test.ts (7 tests)        empty-evidence refusal, insufficient-support refusal,
                                    cited extractive answer, citation-validation refusal,
                                    every-query-scoped assertion, term extraction, evidence records
✓ test/triggers.test.ts (8 tests)   pin/approval/distill/ask classification, last-valid-e-tag
                                    targeting, NIP-10 root resolution, no self-trigger, malformed rejects
✓ test/distill.test.ts (6 tests)    byte-identical determinism, digest sensitivity, as-of-trigger
                                    snapshot rule, single-root + full PROV chain, term validity, DECISION title
✓ test/identity.test.ts (3 tests)   NIP-OA verify pos/neg, binding publication hard-disabled
✓ test/daemon.test.ts (17 tests)    capture happy path, trigger replay dedup, mention capture,
                                    unmapped-channel rejection, soft-delete fail-closed,
                                    mid-lifecycle crash resume (no dup writes/receipts),
                                    pre-crash receipt rediscovery, §6 approve→publish-once→VM receipt,
                                    approval replay consumed once, unauthorized/wrong-emoji/wrong-target
                                    rejections, publishMode=disabled refusal, lost-publish-response
                                    read-back recovery, ask answer+dedup, ask refusal,
                                    non-devnet-chain start refusal, missing-CG start refusal, cursor replay
Test Files  6 passed (6) · Tests  48 passed (48)
```

Mocks are used in unit tests only; the acceptance demo has none.

## Acceptance demo — real daemon, real isolated stacks

Full transcript: `docs/acceptance-transcript.md` (channel `dkg-daemon-demo3`).

1. Pin on a single-decision thread → exactly one SWM receipt carrying the
   assertion coordinate `did:dkg:context-graph:devnet-test/assertion/0x71Cf…/buzz-dkg-3b16f94a5441`
   and source digest.
2. Daemon restart → catch-up replay of the same events → still exactly one
   receipt (cursor + dedup proof in the transcript).
3. Authorized promoter ✅ → all §6 invariants pass → one devnet publish →
   VM receipt with **UAL `did:dkg:evm:31337/0x71cf…/7`** and the consumed
   approval event id. An unauthorized member's ✅ recorded as rejected, zero effect.
4. `@dkg ask` (supported) → extractive answer citing scoped decision-cluster
   URIs; `@dkg ask` (unrelated) → explicit refusal naming the scoped graph.
5. Final restart → reply count unchanged (1 SWM + 1 VM receipt).

## Defects found live during acceptance (both fixed + regression-covered)

1. **buzz-relay live fan-out only consults channel-scoped subscription
   indexes** (`subscription.rs fan_out_scoped @ dd222a5`): a kinds-only kind-7
   REQ silently receives nothing. Reactions must be subscribed with `#h`; the
   relay's filter matcher then maps the reaction to its derived channel
   (`buzz-core/src/filter.rs` fallback). INTERFACES-relevant; recorded in DESIGN.
2. **NIP-98 burst uniqueness**: monotonic `created_at` bumping (the Gate B
   workaround for the relay's replay guard) drifts outside the ±60 s freshness
   window under fast request bursts. Correct scheme: honest timestamp + random
   `nonce` tag.

## Stop condition

Per SPEC: **the daemon is not connected to production.** The isolated stacks
remain up only as the demo environment. Operator acceptance of this gate is
required before Stage D1; D1 additionally needs an operator-designated Buzz
test channel and a live recheck of every §8 item (production node currently
stopped; publisher identity absent ⇒ D3 remains NO-GO by default).
