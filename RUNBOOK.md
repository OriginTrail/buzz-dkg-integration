# Join the memory — participant runbook

This gets you from "member of the Web of Trust channel" to the full Memory
experience: the ◈ Memory panel in Buzz desktop, decisions with verifiable
evidence, graph views — all resolved through **your own** DKG edge node.

Time: ~30 minutes. Everything is self-serve; nothing needs an operator.

## What you get at each step

| Step | What unlocks |
|---|---|
| 0 (nothing) | In-channel @dkg receipts — everyone already has this |
| 1 (app) | ◈ Memory panel in **discovery mode** ("shown for discovery — unverified") |
| 2 (node + subscribe) | "✓ Verified through your node" — full memory, evidence, graphs |

## Prerequisites

- git ≥ 2.46, Rust toolchain, Node 20+, pnpm (or hermit — the repo ships it)
- Your Buzz identity nsec (the key your Buzz app uses on this relay)

## Step 1 (easiest) — download the prebuilt app

No toolchain needed. On the tailnet, download:

**https://macbook-pro-8.tailb02f7e.ts.net/downloads/Buzz-Memory_0.5.2_aarch64.dmg** (Apple Silicon)

Install notes:
- The build is ad-hoc signed (internal build): first launch is **right-click →
  Open** (or `xattr -dc "/Applications/Buzz.app"` after copying).
- It uses the same app identifier as official Buzz, so **your existing
  identity and community login carry over automatically**. If you keep the
  official app too, rename this one (e.g. "Buzz Memory.app") and only run
  one of them at a time.
- Intel Mac or Linux? Use Step 1b (source build) below, or ask in the
  channel for a build for your platform.

Then skip to Step 2 (or just open the ◈ Memory chip — discovery mode works
immediately, no node needed).

## Step 1b (developers) — build the desktop app from source

The fork lives on **our community git** (access = channel membership, via
NIP-98 git auth):

```bash
# one-time: the git credential helper that signs with your Nostr key
cargo install --git https://github.com/block/buzz git-credential-nostr
git config --global credential.helper nostr
git config --global credential.useHttpPath true
mkdir -p ~/.nostr && echo "nsec1…your key…" > ~/.nostr/key && chmod 600 ~/.nostr/key
git config --global nostr.keyfile ~/.nostr/key

# clone the fork and build
git clone https://macbook-pro-8.tailb02f7e.ts.net/git/7b20d5265af65543cbe6192e1665f8f0730004622c111c381d163cde53ae5bc5/buzz
cd buzz && git checkout feat/dkg-memory-panel
. ./bin/activate-hermit && just setup
just desktop-standalone     # launches the app with the ◈ Memory panel
```

Open the Web of Trust channel → click the **◈ Memory** chip. You are now in
discovery mode: real decisions, honestly labeled unverified.

## Step 2 — run your edge node and subscribe (upgrade to verified)

```bash
mkdir dkg-node && cd dkg-node && npm install dkg@latest
DKG_HOME=$HOME/.dkg node_modules/.bin/dkg start        # DKG v10 edge node on :9200

# subscribe your node to the channel's Context Graph — this IS the access model:
curl -X POST http://127.0.0.1:9200/api/context-graph/subscribe \
  -H "authorization: Bearer $(tail -1 $HOME/.dkg/auth.token)" \
  -H "content-type: application/json" \
  -d '{"contextGraphId":"0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/web-of-trust","includeSharedMemory":true}'
```

Then run the local explorer (this repo — clone it the same way):

```bash
git clone https://macbook-pro-8.tailb02f7e.ts.net/git/7b20d5265af65543cbe6192e1665f8f0730004622c111c381d163cde53ae5bc5/buzz-dkg-integration
cd buzz-dkg-integration && node explorer/local-explorer.mjs   # :9295
```

Reopen the Memory panel: it should now read **"✓ Verified through your
node"** — every decision's "View evidence" resolves the Evidence Envelope
(sources, digest, attribution) from your own node, and the Topics chips open
the graph views.

## Troubleshooting

- **Panel says "not bound to a Context Graph"** — the relay connection was
  slow at startup; reopen the panel (it derives the binding from @dkg
  receipts in the channel).
- **"Your edge node has not joined this channel's Context Graph"** — the
  subscribe call in Step 2 hasn't completed; re-run it and give SWM sync a
  minute.
- **git clone gives 401/permission errors** — your nsec in `~/.nostr/key`
  must be the same identity that is a member of the Web of Trust channel;
  git must be ≥ 2.46.
- **Pushing large changes fails with HTTP 401 mid-transfer** — run
  `git config http.postBuffer 524288000` in the repo.

Questions → ask in #Web of Trust; the agents answer, and your questions
land (attributed to you) in the channel's memory.
