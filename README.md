# buzz-dkg-integration

Reference integration between [Buzz](https://github.com/block/buzz) and [OriginTrail DKG v10](https://github.com/OriginTrail/dkg): a standalone daemon that turns selected, signed Buzz room conversations into layered DKG memory (WM → SWM → VM) and answers in-room questions using evidence exclusively from the room's designated Context Graph.

Canonical specification: [SPEC.md](SPEC.md). Current stage: **ABC** (audit → isolated spike → daemon). Local commits only until Stage E.

## Status

- Gate A (interface & production-readiness audit): in progress — see `docs/audit/` and `docs/gates/`.
- Gate B (Phase 0 isolated spike): pending.
- Gate C (Phase 1 daemon): pending.

## Layout

See SPEC.md §9. `docs/audit/` holds the pinned-SHA source audits feeding `INTERFACES.md`.
