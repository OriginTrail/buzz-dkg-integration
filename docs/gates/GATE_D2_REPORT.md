# Gate D2 report — one operator-approved production SWM share

Date: 2026-07-26. Approval: **"D2 approved, receipt posting included — operator in session 2026-07-26"** against the D1 report §6 block. Full redacted execution transcript: `d2-transcript.md`. Executor (frozen approved values inline): `scripts/d2-execute.mjs`.

## Approved values (as executed — zero drift)

Exactly the D1 §6 block: channel `56059d1d-…7ac8`, thread root `60fe7bc1…e5ff`, CG `0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026`, KA `buzz-dkg-8a4599b36c1d`, root `urn:buzz-dkg:decision:8a4599b3…4c00`, 2 source events, digest `8a4599b3…4c00`, payload sha `bdba3972…8bd9`.

## Preflight (all read-only, all passed before any write)

1. Node healthy: v10.0.8, base:8453, 8 peers, hasIdentity true.
2. Target CG exists (narrow `exists` route — the broad list route 500s on a scan budget, observed live and avoided); caller wallet among the 3 allowed agents (curator).
3. Duplicate prevention: KA name absent from the CG.
4. Payload integrity: file git-clean at the approved commit; sha matches. (Discrepancy note, resolved before execution: the D1 value `bdba3972…` is the ASCII-escaped compact serialization; the raw-UTF-8 serialization of the *same bytes-identical file* is `0244076d…` — the payload contains an em-dash. The executor verifies the approved ASCII form and records both. First run correctly NO-GO'd on this until the equivalence was proven.)
5. Source thread re-fetched live: exactly 2 events, ids match, single author, recomputed digest == approved digest.
6. Idempotency: fresh digest-derived name, no prior operation.

The full operation plan with resolved identifiers was printed before the first write (in the transcript).

## Lifecycle (exactly one, as authorized)

| Step | Result |
|---|---|
| create | WM draft opened, `alreadyExists: false`, WM slot `…/_working_memory/0x633e…/2201` |
| wm/write | `{written: 37}` — the approved quads, nothing else |
| wm/finalize | assertion coordinate `did:dkg:context-graph:0x633E…/fifa-world-cup-2026/assertion/0x633E5a7C…/buzz-dkg-8a4599b36c1d`; merkle root `0x1a87d6c07b95ac0a406c6462b9f49cff875031db5693ee24603c2b464e3f65e3`; EIP-712 author `0x633E5a7C…e2Ab` |
| swm/share | `{swmShared: true, promotedCount: 37, sealed: true, publishReady: true, shareOperationId: "ms1vxxmo-1lfilj"}` |

## Post-share verification (read-only)

- Descriptor: `state=promoted`, `memoryLayer=SWM`, swmAssertion `1a87d6c0…` (== merkle root), 2 lifecycle events, share op id matches.
- Scoped SWM query in the target CG: root entity carries the approved `sourceSetDigest` and its `prov:wasDerivedFrom` chain.
- **No VM publication**: state is `promoted` (not published/finalized), no UAL minted; `reservedUal did:dkg:base:8453/0x633e…/2201` is the pre-publish reservation only.

## Receipt (authorized by the approval reference; content shown in transcript before posting)

Posted in `dkg-test` as a reply to the source thread root: event **`b02446d78c594a25403d6d0bdf0de53dd59fb4b616e4d836b873b218ecbd0b06`** — carries the assertion coordinate, KA name, CG, source digest, the approval reference, and the explicit "not published to Verifiable Memory" status. This receipt is the anchor a D3 approval reaction must target (§6.2).

## Ambiguity handling

One transient encountered and handled per spec: the broad CG-list preflight route returned 500 (scan budget) → replaced with narrow per-CG reads; no write had occurred. The hash-serialization mismatch NO-GO'd the first run before any write; resolved by proving file identity via git, not by altering any approved value. No lifecycle call was ambiguous; no retry was needed; no second KA name exists.

## Immutable identifiers proposed for D3

```yaml
knowledge_asset_name: "buzz-dkg-8a4599b36c1d"
root_entity_uri: "urn:buzz-dkg:decision:8a4599b36c1d845301edbf0cfb66fc598c998caa3d781ffcb53b1c3135194c00"
finalized_swm_digest_or_merkle_root: "0x1a87d6c07b95ac0a406c6462b9f49cff875031db5693ee24603c2b464e3f65e3"
context_graph_id: "0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026"
swm_receipt_event_id: "b02446d78c594a25403d6d0bdf0de53dd59fb4b616e4d836b873b218ecbd0b06"
reserved_ual_preview: "did:dkg:base:8453/0x633e5a7c5e612d9981538f60d824cc03be97e2ab/2201"
target_network: "mainnet-base"; target_chain_id: 8453
```

D3 additionally requires (per SPEC): the operator-filled D3 block (approval reference, authorized Buzz approval event + promoter npub, `publishEpochs`, `max_eth_cost`, `max_trac_cost`, 1 attempt); §6 invariants 1–9 verified against the named ✅ event; live cost quote within both ceilings (identity 65 now exists; balances at last read ~0.0033 ETH / 113.24 TRAC).

**Stop.**
