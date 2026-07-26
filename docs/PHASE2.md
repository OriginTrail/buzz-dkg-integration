# Phase 2 directions (one page, no code)

**n-of-m approval quorums.** Today one authorized promoter's ✅ requests
publication. Phase 2 generalizes the promoter set to a quorum policy per
channel (e.g. 2-of-3 named npubs within a validity window), evaluated over the
same kind-7 stream with the same exactly-once consumption semantics — each
approval event is consumed against a quorum record instead of directly
triggering publish. Natural extension: map the quorum onto the DKG's own
M-of-N verification (`/api/verify` requiredSignatures) so social approval and
network verification share one story.

**Canvases as KA drafts.** Buzz channels carry a canvas (relay-side document
state). A canvas maps more naturally onto an *editable* WM draft than a chat
thread does: canvas edit events become `wm/write` appends to a long-lived
draft, and an explicit "seal" gesture (pin or command) finalizes and shares a
version. This exercises the WM edit-loop (`pull-from --layer swm`) that the
thread flow never needs.

**NIP-34 git events → KAs.** Buzz's relay speaks git smart-HTTP and the
ecosystem has NIP-34 (git patches/issues as events). A repository decision
trail (patch, review discussion, merge) is a provenance chain the DKG
represents well: patch events become source events, the merge decision becomes
the decision cluster, and the commit hash joins the digest material — linking
code history to conversational history in one graph.

**Cross-relay web-of-trust attestations.** NIP-OA already binds agent keys to
owner keys within one relay. Phase 2 extends verification (not publication)
across relays: the service verifies owner attestations from federated/mesh
relays and records *verification results* as SWM metadata, building a
web-of-trust view over which agents' messages entered which KAs. Publishing
identity-binding KAs remains a separately authorized operation, as in §4.8.
