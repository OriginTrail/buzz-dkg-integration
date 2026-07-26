# Phase 0 spike transcript

Run started 2026-07-26T09:26:47.479Z. Stack: isolated devnet (chain 31337) + isolated Buzz relay (bdi-spike). All identities are throwaway spike keys.

## Preflight (isolated stack identity checks)

DKG node1: version=10.0.9 network=7449c543ff04a550b2dafa999fe8ee577a00b212023bb4d4244e8d58a4792c7b chain="evm:31337" store=oxigraph-server hasIdentity=true peers=5
Buzz relay: name=Buzz Relay software=https://github.com/block/buzz version=0.2.0 pubkey=…
Context graph bound to channel 'dkg-spike-2': id=devnet-test onChainId=1

## Channel setup

channel 'dkg-spike-2' uuid=7948e466-5c6c-4d86-a192-1c704429c2a4
add member (kind 9000): accepted=true
add service (kind 9000, role=bot): accepted=true
add promoter (kind 9000): accepted=true

## Source thread (three signed messages)

thread already exists: root=6f5f42ad91da937ae3de9b414f3b3a5342db2853059dc90c7d8b7efbad2f4dbe

## Trigger: author pins the thread root (kind 40004)

pin already present: e69c4ff0081086970e2975ba4b413e02b99c745f15b033c5bb7c7858e1ab34bf

## Service: pin detected → snapshot → deterministic distillation

pin e69c4ff0081086970e2975ba4b413e02b99c745f15b033c5bb7c7858e1ab34bf by 7b20d5265af6… targets 6f5f42ad91da937ae3de9b414f3b3a5342db2853059dc90c7d8b7efbad2f4dbe
thread snapshot: 3/4 events as-of trigger (ids 6f5f42ad, 988b19e0, df06c85b)
DEDUP: pin+digest already processed → no new KA, no new receipt (receipt=41b098e5191de90e33402881bf568ae667799d9f6e82a010e4682be8d830ae1c)

## Replay: process the same pin again (must dedup)


## Service: pin detected → snapshot → deterministic distillation

pin e69c4ff0081086970e2975ba4b413e02b99c745f15b033c5bb7c7858e1ab34bf by 7b20d5265af6… targets 6f5f42ad91da937ae3de9b414f3b3a5342db2853059dc90c7d8b7efbad2f4dbe
thread snapshot: 3/4 events as-of trigger (ids 6f5f42ad, 988b19e0, df06c85b)
DEDUP: pin+digest already processed → no new KA, no new receipt (receipt=41b098e5191de90e33402881bf568ae667799d9f6e82a010e4682be8d830ae1c)
replay OK: exactly one receipt exists (1 service message(s) total, unchanged) ✔

## Approval: authorized promoter reacts ✅ on the receipt

approval already present: 29f958afe107593ba0528602e0271435ad1d347c4c9e2d77c4db6094f00378f8

## Service: §6 approval invariants (enforced in code)

- [PASS] 1. reactor is configured authorized promoter — fc11ee8605a0…
- [PASS] 2. reaction targets service-authored receipt
- [PASS] 3. receipt identifies pending KA + immutable digest
- [PASS] 4. channel maps to same context graph
- [PASS] 5. finalized SWM KA matches approved digest — state=promoted layer=SWM swmAssertion=3d4ec35cb349…
- [PASS] 6. approval event not already consumed
- [PASS] 7. KA not already published
- [PASS] 8. environment permits publication — BDI_ALLOW_TEST_PUBLISH=1
- [PASS] 9. stage authorization — SPEC §0 stage ABC — devnet-only publication, Gate A verdict GO

## Devnet VM publish: buzz-spike-1cb4a74e49cd

{
  "kaId": "51478481255135138826825346551398810057896882236804231022141093915265735852035",
  "status": "confirmed",
  "ual": "did:dkg:evm:31337/0x71cfc9b0fef62d15b5fb6a6d6de7921231c0e91d/3",
  "txHash": "0x88965ebbab1b6cd91bbd55eb2b9eaaf8381739f15c7b9fc1fac9511c584c651f",
  "assertionUri": "did:dkg:context-graph:devnet-test/assertion/0x71Cfc9B0fef62D15b5Fb6a6D6De7921231C0e91d/buzz-spike-1cb4a74e49cd",
  "authorAddress": "0x71Cfc9B0fef62D15b5Fb6a6D6De7921231C0e91d",
  "merkleRoot": "0x3d4ec35cb3496d9a93b1cdd1425e535b4a4f51639b5acb25894481a840dc38ed",
  "blockNumber": 2495,
  "storageAckPeerIds": [
    "12D3KooWRUzSPvHbFdaNQSBFGX3GSJD6od4o9beAv2zx8u29P5JB",
    "12D3KooWFa5VVcvGcpLAq36X8JLBPTyV4ojD116TLLDK8eTNCSpN",
    "12D3KooWLy5i8kzZ7QfxkHDnTheVcvSYij9VZ2tuecRRjGfKuhq2"
  ]
}

## UAL + VM verification

descriptor state=published events=2
VM-view query bindings: 5

## Final in-thread VM receipt

VM receipt: accepted=true id=5cad5cc36f35524a3ae7c14b5b4479d91bac5d72de0701cf53292a1128ef232c

**Loop complete.** UAL: `did:dkg:evm:31337/0x71cfc9b0fef62d15b5fb6a6d6de7921231c0e91d/3`

Run finished 2026-07-26T09:26:49.778Z.
