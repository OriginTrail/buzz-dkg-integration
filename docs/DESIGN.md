# Design

A standalone daemon that joins Buzz channels as an external member and turns
explicitly signalled conversations into layered DKG memory, per SPEC.md. All
interface facts below are source-verified (`INTERFACES.md`, `docs/audit/` —
pinned SHAs dd222a5 / bf919a0 / c944c9c) or observed live in Gates B/C.

## Surfaces (verified; nothing else is used)

- **Buzz**: NIP-98-signed HTTP bridge (`POST /events|/query`) for reads and
  writes; WebSocket + NIP-42 for live subscriptions. The daemon is an ordinary
  channel member with a `bot` role — buzz-relay is never forked or patched.
- **DKG v10**: daemon HTTP API with Bearer auth. Lifecycle verbs
  `create→write→finalize→share→publish` on `/api/knowledge-assets/*`; scoped
  `POST /api/query`; descriptor read-back `GET /api/knowledge-assets/{name}?contextGraphId=`.
  The HTTP API was chosen over CLI/MCP because upstream marks it the canonical
  contract (`/.well-known/skill.md`) and the CLI carries deprecation churn.

## Component map (SPEC §9 layout)

| Module | Responsibility |
|---|---|
| `src/relay/` | WS NIP-42 subscribe (reconnect + exponential backoff), NIP-98 HTTP publish/query, thread fetch |
| `src/registry/` | SQLite (`node:sqlite`): channel↔CG bindings, promoters, cursor, op state machine, approval/ask dedup |
| `src/triggers/` | classify pin (40004) / `@dkg distill` / kind-7 approval / `@dkg ask`; relay-style last-valid-`e`-tag targeting; never self-triggers |
| `src/distill/` | `Distiller` provider seam; deterministic no-model distiller (single-root PROV-O cluster, canonical source-set digest) |
| `src/dkg/` | verified node adapter; publish surface exists but is mode-gated |
| `src/ask/` | §7 grounded answering: scoped retrieval, evidence gate, citation validation, refusal |
| `src/receipts/` | kind-9 receipt composition/parsing (machine-readable lines; no custom kinds — relay rejects them) |
| `src/identity/` | NIP-OA owner-attestation verification ONLY; binding-KA publication throws |

## State machine (one trigger → one KA → one receipt)

```
distilled → wm_written → finalized → shared → receipted ─(✅+§6)→ published → vm_receipted
     └────────────────────────── failed (terminal, with reason) ──────────────────┘
```

Forward-only, enforced in SQL-backed `Registry.transition`. Dedup keys:
`ops.trigger_event_id` UNIQUE, `approvals.approval_event_id` UNIQUE (consumed
exactly once), `asks.ask_event_id` UNIQUE.

**Crash recovery** (every step resumable, verified by tests + live demo):
- quads are fully deterministic → re-`write` is set-idempotent in the store;
  `wm/write` auto-creates the KA (create() is destructive on live drafts —
  upstream source comment — so it is never called separately);
- finalize/share skipped when the descriptor already reads `promoted`;
- receipts searched on the relay (`trigger: <id>` line) before re-posting;
- publish ambiguity: never blind-retry — descriptor read-back; `published` +
  `reservedUal` ⇒ success recovered.
- restart: cursor (max seen `created_at`) − 60 s overlap → `/query` replay;
  dedup absorbs the overlap. Live reconnect re-REQs and replays the same way.

## Source snapshot rule (Gate B finding, load-bearing)

Source set = thread events with `created_at ≤ trigger.created_at` and
`author ≠ service`. Digest = sha256 over id-sorted canonical event forms
including signatures. Without this exact rule the service's own receipt shifts
the digest and trigger replay stops deduplicating (observed live before the
rule existed). If the recovery-time snapshot digest ≠ claimed digest (source
soft-deleted — Buzz is not append-only), the op fails closed.

## §6 approval invariants — where each is enforced

1 promoter allowlist per channel (registry) · 2 reaction must target a
service-authored receipt (op lookup by receipt id) · 3 receipt carries
KA+digest (parsed back and compared) · 4 channel↔CG unchanged · 5 descriptor
`promoted`/SWM · 6 approval consumed exactly once (SQL UNIQUE claim) ·
7 not already published (op state + descriptor) · 8 `publishMode` gate ·
9 stage authority: `publishMode` ∈ `disabled|devnet|mainnet`. `disabled`
(default) refuses all publication; `devnet` requires chain `evm:31337`;
`mainnet` requires chain `base:8453` AND stays under a rolling-24h publication
budget (`maxPublishesPerDay`). The mode↔chain agreement is checked at startup
AND again in the approval gate. `mainnet` was enabled after the D-gates proved
the on-chain path end-to-end (real UAL) and the operator granted standing
authority (2026-07-27); it is the single-node production posture, so the
devnet scaffolding was retired.

## §7 grounded answering — where each clause lives

Channel→CG resolution + unmapped rejection: daemon; scoped SPARQL with
server-side enforcement: DKG `/api/query` (caller `FROM`/foreign `GRAPH` are
400s upstream — verified); evidence as structured records, ≥2-term support
gate BEFORE composing text, citation ASK-validation in the same scoped view,
extractive no-model answer, explicit refusal: `src/ask/grounded.ts`. There is
no code path that queries without a CG or falls back to another graph.

## Trust boundaries

- Relay input is untrusted: sigs are relay-verified on write, but the daemon
  additionally snapshots full signed events into the KA so claims remain
  independently checkable (soft-delete resistance).
- Client-supplied `h` tags on reactions are ignored (relay derives channel
  from target; the daemon correlates via its own receipt records).
- DKG bearer token: env/file only; redaction in logs is the caller's contract
  (the daemon never logs the token).
- Identity binding across ecosystems: NIP-OA verification only (§4.8);
  secp256k1 keys are never reused across Schnorr/ECDSA contexts.

## Notable verified deviations absorbed by the design

See SPEC §12. The live-fan-out one is new in Gate C: buzz-relay only matches
channel-scoped subscription indexes for channel-derived events, so the
reaction subscription MUST carry `#h` (its filter matcher falls back to the
stored channel for kind 7/5 — `buzz-core/src/filter.rs`). A kinds-only kind-7
REQ receives nothing, silently. Also: NIP-98 burst-uniqueness needs a nonce
tag, not a monotonic timestamp (drifts out of the relay's ±60 s window).
