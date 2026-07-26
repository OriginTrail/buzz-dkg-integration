# Gate D3 report — one operator-approved VM publication

Date: 2026-07-26. Approval: operator "continue" on the presented D3 block (ceilings 0.5 TRAC / 0.0005 ETH, publishEpochs 12, receipt included); failed first attempt explicitly re-authorized by operator "retry now". Full transcript: `d3-transcript.md`; intent fingerprint: `d3-intent.json`; executor: `scripts/d3-execute.mjs`.

## Result: CONFIRMED

| Field | Value |
|---|---|
| **UAL** | `did:dkg:base:8453/0x633e5a7c5e612d9981538f60d824cc03be97e2ab/2201` |
| KA | `buzz-dkg-8a4599b36c1d` — root `urn:buzz-dkg:decision:8a4599b3…4c00` |
| On-chain KA id | `44889141037903562332952506196618667997020641015855049512546017105846827223193` (packed author‖number form) |
| Tx | `0x6daf3e0bad8cba13f7508f69c5550750a30294e997bf5e7fdffe9a24170dbb38` — status 1, block 49145748, 12 logs incl. the KA NFT mint |
| Network | Base mainnet (`base:8453`), hub `0x99Aa…1d13` |
| Publisher | wallet `0x633E…e2Ab`, node identity **65** |
| Actual spend | **0.00000465 ETH** gas (ceiling 0.0005) · **0 TRAC** (ceiling 0.5) — verified on-chain: the tx's only Transfer event is the KA NFT mint; no ERC-20 movement; wallet TRAC unchanged at 113.23878669 |
| Approval consumed | ✅ event `bf724457…0c12` by promoter `fc11ee86…94d6`; attempts: 1 chain-effective |
| VM receipt | posted in `dkg-test`: event `f713ee3e97166c0b90bc6571ca5337c98683eac72f0c7207699f0cfe8a0c6738` (content shown in transcript before posting) |

Independent verification (beyond the success response): descriptor re-read `state=published, memoryLayer=VM`; scoped verifiable-memory query in the FIFA CG returns the root entity's content (5 bindings); tx receipt fetched directly from the chain. Note: the descriptor `events` array records only `created`/`promoted` — publication is reflected in `state`; single-publication proof = state transition + exactly one publish tx.

## §6 invariants — all nine PASS at preflight (both attempts)

Reactor = designated promoter · reaction targets the service's D2 receipt · receipt carries KA + digest · channel↔CG mapping intact · KA `promoted`/SWM with merkle root `0x1a87d6c0…` matching · approval unconsumed · not already published · chain `base:8453` with identity 65 · operator-approved block authorizes exactly this publication.

## Attempt history (no auto-retry — spec honored)

1. **Attempt 1 — FAILED cleanly, zero spend, pre-chain.** The v10.0.8 LU-5 guard refused: the live on-chain access-policy proof timed out (2.5 s budget) while the node was mid catch-up after 6 days offline. Post-failure read-only diagnosis proved the on-chain state was perfect all along (slot 7 name-hash matches the CG id; accessPolicy public, publishPolicy open) and TRAC intact (the preflight's "0 TRAC" was a loaded-daemon balances-route glitch). Stopped for operator decision per spec.
2. **Attempt 2 — operator-authorized retry → CONFIRMED** (this report).

## Loop closure

The full SPEC §1 mission is now demonstrated end-to-end **on production**: signed Buzz thread (`dkg-test`) → operator-approved capture → WM → finalize (seal) → full SWM share into the FIFA Context Graph (D2) → authorized ✅ approval → **on-chain Verifiable Memory publication with UAL** → in-thread receipts for both layers. Grounded answering against the same CG was proven in D1.

**Stop.** Stage E (remote repository, push, `dkg-integrations` registry/bounty submission) requires its own §0 authorization naming exactly which remote operations are granted.
