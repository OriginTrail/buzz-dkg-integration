# Running the Buzz–DKG integration (memory layers built in)

Two paths: **download a prebuilt client** (fastest) or **build it from source**
with the patch in this repository. Either way, the server side comes from this
repository.

---

## A. Prebuilt client (fastest)

Unsigned test builds (macOS Apple Silicon `.dmg`, Windows x64 `.exe`) are
attached to this repository's **Releases**. Install one, then jump to
[§ C. Server side](#c-server-side-relay--node--provider).

- macOS says *"damaged"* on unsigned builds → drag to Applications, then run
  `xattr -cr /Applications/Buzz.app` in Terminal (right-click → Open does
  **not** bypass this variant).
- Windows SmartScreen → *More info → Run anyway*.

## B. Build the client from source

The memory feature is maintained as one consolidated patch against
[`block/buzz`](https://github.com/block/buzz).

```bash
git clone https://github.com/block/buzz.git && cd buzz
git checkout 63496cc1d          # the base the patch is maintained against
git apply /path/to/patches/buzz-desktop-dkg-memory-gateway.patch

. ./bin/activate-hermit          # toolchain (Rust, Node, pnpm)
cd desktop && pnpm install

# Point the client at YOUR community provider (the patch ships a
# placeholder host). Either edit GATEWAY_EXPLORER in
# src/features/dkg-memory/api.ts, or set it at runtime per user via
# localStorage key `dkg-memory-explorer-url`.

pnpm tauri build --no-sign --bundles dmg    # macOS
pnpm tauri build --bundles nsis             # Windows
```

Newer `block/buzz` commits usually apply cleanly too; the pinned base is the
tested one.

### What the patch adds

- `desktop/src/features/dkg-memory/` — the ◈ Memory panel: three memory layers
  (WM/SWM/VM), decisions with evidence trails, contributors, per-participant
  sub-graphs; **Traces** (decision timeline) and **Graph** (the knowledge graph
  in the DKG node's own visual idiom — hexagons, entity-type colors, node
  inspector) views.
- A one-line mount in `ChannelPane.tsx` and the e2e spec covering all three
  resolution modes.
- Resolution chain: **local node → community DKG provider → discovery**, with
  the trust boundary labeled per OT-RFC-67 (green / blue / amber).

## C. Server side (relay + node + provider)

On the community host (one machine can run all of it):

1. **Buzz relay** — your existing relay is adopted as-is; nothing changes for
   members.
2. **DKG Edge node** (v10) — `npm i @origintrail-official/dkg && dkg start`,
   participating in (or creating) the community's Context Graph.
3. **Projector** — [`wot-autocapture.mjs`](../../wot-autocapture.mjs) (or the
   `@dkg` daemon) follows the channel and distills events into the graph,
   posting receipts that carry the `context-graph:` binding.
4. **Community provider** — [`explorer/local-explorer.mjs`](../../explorer/local-explorer.mjs):

   ```bash
   # loopback (per-viewer resolution, default):
   node explorer/local-explorer.mjs
   # community-provider mode (members without a node read your view):
   EXPLORER_BIND=0.0.0.0 node explorer/local-explorer.mjs
   ```

   Publish it to members over a private network (e.g. Tailscale) behind TLS,
   and keep [`node-watchdog.sh`](../../node-watchdog.sh) on a timer so the
   provider self-heals.

Members then: install the client → add your relay → open the Web of Trust
channel → click **◈ Memory**. No DKG node needed on their devices; the panel
resolves through the community provider (blue label), or their own node if
they run one (green).

See [reference-instance.md](reference-instance.md) for a running example of
this exact topology, with screenshots and OT-RFC-67 acceptance mapping.
