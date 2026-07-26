# Audit: OriginTrail/dkg-integrations (registry) — for a chat/messaging → DKG integration

- **Audited clone:** `/Users/zigadrev/code/upstream-pins/dkg-integrations`, pinned at `c944c9cbf48c227e54592986c0c995059720b8d5` (main, 2026-04-24). Read-only; nothing modified.
- **Citation convention:** `path:lines @ c944c9c` = verified in the pinned clone. Web-sourced facts are flagged explicitly with URL + access date 2026-07-26.

---

## 1. What this repo is

A **metadata-only registry** — "the official catalog of integrations for the OriginTrail Decentralized Knowledge Graph v10" (`README.md:1-5 @ c944c9c`). It contains **no integration code**: "Integration code lives in each contributor's own repository, and this registry pins to a specific commit and published version" (`README.md:13 @ c944c9c`). Entries are consumed by `dkg integration search / info / install / upgrade / uninstall` in the node CLI and the node dashboard's Integrations tab (`README.md:9-10, 19-33 @ c944c9c`).

### Repository layout (`README.md:88-105 @ c944c9c`, confirmed on disk)

```
integrations/
  <slug>.json               # ONE file per integration — this is the entire submission
  TEMPLATE.json             # copy to start
  dkg-hello-world.json      # seed entry 1 (CLI, WM-only)
  cursor-mcp-dkg.json       # seed entry 2 (MCP, WM+SWM)
schema/integration.schema.json   # JSON Schema 2020-12 — canonical contract
scripts/validate.mjs             # structural checks
scripts/security-checks.mjs      # npm-package checks (read-only, registry HTTP API)
.github/workflows/validate.yml   # CI wiring
.github/PULL_REQUEST_TEMPLATE.md # submission checklist
CONTRIBUTING.md / README.md / CODEOWNERS
```

### What a submission looks like

A submission is **a single JSON file** at `integrations/<slug>.json` (`README.md:46 @ c944c9c`). There is no per-integration directory, no README requirement inside this repo — docs, design brief, demo, and tests live in the contributor's own repo and are **linked** from the entry.

Required fields (`schema/integration.schema.json:8-24 @ c944c9c`):
`schemaVersion, slug, name, description, category, maintainer, repo, commit, license, memoryLayers, v10PrimitivesUsed, publicInterfacesUsed, install, security, trustTier`. `additionalProperties: false` (`schema/integration.schema.json:7`).

Key field semantics:

| Field | Contract | Cite @ c944c9c |
|---|---|---|
| `slug` | `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, 3–60 chars, unique, filename must be `<slug>.json`; "look-before-mint" normalization (lowercase → ASCII-fold → strip stopwords the/a/an/of/for/and/or/to/in/on/with → hyphenate) | `schema:35-41`, `CONTRIBUTING.md:17-27`, `README.md:117` |
| `commit` | full 40-char SHA of the contributor repo; "latest is not a pin"; updates = new small registry PR | `schema:93-97`, `CONTRIBUTING.md:52-59` |
| `memoryLayers` | 1–3 of `WM / SWM / VM` | `schema:108-117` |
| `v10PrimitivesUsed` | enum: UAL, KnowledgeAsset, KnowledgeCollection, ContextGraph, SubGraph, Assertion, Integration, Curator, Entity | `schema:118-136` |
| `publicInterfacesUsed` | what the integration **consumes** from the node: `http-api` / `cli` / `mcp`; anything else "is a scope violation (see bounty doc Section 5)" | `schema:137-146` |
| `targetAgents` | enum incl. OpenClaw, ElizaOS, Hermes, AutoResearch, Cursor, Claude Code/Desktop, generic-MCP/HTTP/CLI | `schema:147-164` |
| `install` | exactly one kind: `mcp` (command/args/supportedClients), `service` (docker \| npm-global \| binary), `cli` (package/version/binary), `agent-plugin` (framework: openclaw/elizaos/hermes/autoresearch), `manual` (docsUrl) | `schema:165-174, 228-351`, `CONTRIBUTING.md:29-39` |
| `security` | contract, not marketing: `networkEgress` (every external host; local node excluded), `writeAuthority` (every mutating DKG endpoint/CLI cmd; Curator ops PUBLISH/SHARE/endorse/verify must appear), `credentialsHandled` (3rd-party creds only, NOT the DKG token), `notes`. "Lying here is grounds for removal and, for bounty submissions, disqualification" | `schema:175-201`, `CONTRIBUTING.md:41-48` |
| `trustTier` | submit as `community`; committee may upgrade to `verified`/`featured` | `schema:202-205`, `README.md:54-64` |
| `designBrief`, `demo`, `promotionPath`, `fitNotes` | bounty-oriented optional fields; `promotionPath` = how WM/SWM artifacts mature toward Verified Memory + oracle consumption, "Required for bounty evaluation (Section 9, criterion 4)" | `schema:206-225`, `integrations/TEMPLATE.json:43-46` |

Note the schema enum includes `VM` in `memoryLayers` and the template's `envRequired` docs use `SLACK_BOT_TOKEN` as the canonical example of a handled credential (`schema/integration.schema.json:192-194 @ c944c9c`); the registry-entry issue template's example slug is `slack-shared-memory` (`.github/ISSUE_TEMPLATE/registry-entry-issue.md:9 @ c944c9c`) — chat/messaging is clearly an anticipated shape.

---

## 2. Submission process

From `CONTRIBUTING.md:7-14, 61-83 @ c944c9c` and `README.md:43-50`:

1. Ship the integration in **your own repository**; publish a release to **npm** (or docker for `service`) at a pinned version. No install scripts (`preinstall`/`install`/`postinstall`) in the published package; provenance (`npm publish --provenance`) is a warning if absent, **required for verified/featured tier** (`README.md:78-81`).
2. Fork the registry, copy `integrations/TEMPLATE.json` → `integrations/<your-slug>.json`, fill it out.
3. Open a PR. **Title:** `Add <your-integration-name>` (or `Update <slug> to v<version>`). Include the auto-applied checklist, plus **for bounty submissions**: a link to the design brief and a link to a demo (recorded walkthrough or live endpoint) (`CONTRIBUTING.md:61-68`).
4. CI runs `scripts/validate.mjs` + `scripts/security-checks.mjs` on changed entries (`.github/workflows/validate.yml:29-46 @ c944c9c`).
5. Committee review decides fit, quality, and tier; CODEOWNERS routes every change to `@OriginTrail/core-developers` (`CODEOWNERS:1-9 @ c944c9c`). "Awards are disbursed on registry acceptance (not on integration code merging anywhere)" (`README.md:48`).

### PR checklist (binding content of `.github/PULL_REQUEST_TEMPLATE.md @ c944c9c`)

- **Scope & faithfulness** (lines 15-20): only supported public interfaces (HTTP API, `dkg` CLI, MCP); no internal DKG package imports, no patching node source, no direct SPARQL writes bypassing assertion lifecycle/Curator; `memoryLayers`/`v10PrimitivesUsed` accurate; v10 vocabulary used exactly (Context Graph, Sub-graph, Assertion, Knowledge Asset, Knowledge Collection, Curator, Entity, WM/SWM/VM).
- **Security declarations "(Section 8a)"** (lines 22-29): egress, write authority (Curator ops explicit), credentials, no install scripts, provenance, pinned SHA = exact build commit.
- **Contributor attestation** (lines 31-36): own/licensed work, no undeclared exfiltration, delisting for misrepresentation, and **"minimum 6-month maintenance window post-acceptance (bounty submissions)"**.

### Automated review criteria (CI)

`README.md:68-84 @ c944c9c` + implementation in `scripts/validate.mjs:80-162` and `scripts/security-checks.mjs:1-20 @ c944c9c`:
schema validation; filename=slug; slug uniqueness; SWM-write ⇒ `SWM` declared and VM-write ⇒ `VM` declared (hard errors, `validate.mjs:113-134`); **Round-1 scope guard** — any `writeAuthority` matching `/publish|/endorse|/verify|/update` warns *"Round 1 of the bounty is Working/Shared-only; this integration may be out of scope unless explicitly justified"* (`validate.mjs:136-143`); Curator ops require a ≥50-char `security.notes` (`validate.mjs:146-153`); npm package exists at declared version, no install scripts, license match, `npm audit` soft signal, docker digest resolution (`security-checks.mjs:2-14`).

Human review still decides fit, quality, tier (`README.md:84`).

---

## 3. Bounty program — Round 1

### Repo-verified facts (@ c944c9c)

- The repo repeatedly references a **binding external bounty document** with numbered sections: "Read the bounty call (Sections 5–8a) first… the bounty document is the binding scope" (`CONTRIBUTING.md:3`); design brief/demo per "bounty doc Section 8" (`schema:206-215`); promotionPath per "Section 9, criterion 4" (`schema:216-220`, `TEMPLATE.json:45`); LLM-Wiki/autoresearch fit per "Section 9, criterion 1" (`TEMPLATE.json:46`); scope violations per "bounty doc Section 5" (`schema:138`).
- **Round 1 = WM/SWM-only** is encoded in CI: the "Round-1-scope guard (VM operations flagged as out-of-scope)" (`README.md:77`; `scripts/validate.mjs:136-143`).
- VM as promotion path (not a Round-1 write surface) is baked into the seed entries: hello-world's `promotionPath` describes WM → SWM (`/promote`) → publish-as-KA for context oracles (`integrations/dkg-hello-world.json:41`); cursor-mcp-dkg "Does not call PUBLISH (VM promotion) by default" (`integrations/cursor-mcp-dkg.json:45`).
- Governance: "for bounty submissions, the DKG v10 bounty committee. Decisions and rationales are published alongside the accepted or declined PR" (`README.md:117`).
- **Gotcha:** the README's bounty link is literally truncated in the source — `[DKG v10 bounty program](https://github.com/OriginTrail/dkg-v9/…)` (`README.md:41 @ c944c9c`). The repo never states pool size, award amounts, deadlines, or the submission tag. Those are **not verifiable from this repo**.

### Web-sourced facts (clearly separated)

Source: `docs/active-now/dkg-v10-bounty.md` in `OriginTrail/dkg-v9` (the truncated README link's repo), fetched via GitHub API 2026-07-26; file last modified upstream 2026-06-10 (commit `36d9dae`). URL: https://github.com/OriginTrail/dkg-v9/blob/main/docs/active-now/dkg-v10-bounty.md

- **"Round 1 — Call for Integrations"**, status **Open**. Theme: DKG v10 Working Memory & Shared Memory × Karpathy's LLM-Wiki / autoresearch agents (§header, §1).
- **Pool:** 150,000 TRAC across 3 rounds; up to **10,000 TRAC per accepted contribution**, Round 1 capped at **50,000 TRAC**. Tiers (§10): Flagship 8k–10k + spotlight; High-quality 3k–7k; Experimental 1k–3k ("half-completed solutions are not eligible" — must be fully working). Awards disbursed on merge of the PR; TRAC paid on NeuroWeb, Base, or Gnosis.
- **In scope (§5):** reads/writes WM or SWM through HTTP API / dkg CLI / MCP, respecting v10 primitives, connected to an LLM-Wiki/autoresearch-advancing product. Priority targets: **OpenClaw** (Telegram-based agent environment), **Hermes**, Claude Code sub-agents/Agent Teams, Cursor-like IDEs, notebook kernels, RAG pipelines.
- **Out of scope (§6):** VM-only/chain-anchoring integrations (Round 2); endorsement/voting UI buttons (consensus is conversational); Conviction/staking UX; v9-only work; Curator-bypass; importing internal `@origintrail-official/dkg-*` packages.
- **Illustrative builds (§4)** — directly relevant to chat/messaging: "ChatGPT / Claude plugin or MCP server that writes to Working Memory" and **"Slack threads → Shared Memory. An agent that watches a channel, identifies substantive exchanges (not chitchat), and shares them into Shared Memory and team Context Graph membership."**
- **Submission requirements (§8):** registry PR + design brief (Markdown, 1–3 pages, with explicit **promotion path** section) + working demo (screenshots insufficient) + proportionate tests incl. integration tests against a local v10 node + security notes + 6-month maintenance commitment. **§14: tag the submission `cfi-dkgv10-r1`.**
- **Evaluation (§9), in weight order:** 1) LLM-Wiki/autoresearch fit, 2) adoption potential ("credible first user"), 3) faithfulness to the v10 memory model, 4) **forward-compatibility with Verifiable Memory and context oracles** — WM/SWM as upstream of VM, promotion a natural next step not a rewrite; documented promotion path scores higher, 5) agent-surface quality, 6) engineering quality; plus documentation.
- **Roadmap (§12):** Round 1 WM/SWM (open now) → Round 2 Verifiable Memory & context oracles (planned; follow-on eligibility for Round 1 contributors) → Round 3 agent-ready analytics & user support. §11: Round 1 work with a credible promotion path is well-positioned for later rounds; eligibility not automatic.
- **Timeline (§13):** rolling review; round closes when the 50k pool is exhausted or Round 2 opens. Review cut-offs announced on the official channel only.
- (Distinct program, same folder: `dkg-v10-premainnet-bounty.md` is a separate 300,000-TRAC smart-contract bug bounty — not the integrations call.)

---

## 4. Templates most similar to a chat/messaging → DKG integration

### In the pinned repo (@ c944c9c) — only two entries exist

1. **`integrations/cursor-mcp-dkg.json` (1-52)** — the best structural template for anything WM+SWM. `memoryLayers: ["WM","SWM"]`, `publicInterfacesUsed: ["http-api"]`, `install.kind: "mcp"` via `npx` with version pinned in args (line 30), `writeAuthority` covering the full WM/SWM surface: `POST /api/assertion/create`, `/api/assertion/{name}/write`, `/api/assertion/{name}/promote`, `/api/shared-memory/write`, `/api/context-graph/create`, `/api/context-graph/subscribe` (lines 36-43), Curator ops gated behind user confirmation (line 45), promotionPath WM → SWM → published KAs for oracles (line 50).
2. **`integrations/dkg-hello-world.json` (1-43)** — the minimal WM-only CLI shape (`install.kind: "cli"`, `envRequired: ["DKG_API_URL","DKG_AUTH_TOKEN"]`); its fitNotes call it the "~150-line starting point" template (line 42). Contributor repo: https://github.com/OriginTrail/dkg-hello-world.

For a messaging integration that runs a bot/daemon, the schema's `service` kind (docker or npm-global, with `envRequired`, `portsOpened`) is the relevant install shape (`schema:254-304 @ c944c9c`), and `agent-plugin` with `framework: "openclaw"` targets the Telegram-based OpenClaw environment (`schema:328-339`).

### In open PRs (web-sourced, GitHub 2026-07-26, none merged yet)

Closest analogs to chat/messaging → DKG among the 16 open PRs on OriginTrail/dkg-integrations:

- **PR #9 — `tracabot`** (Telegram + OpenClaw anti-scam agent; the closest chat→DKG precedent). Entry: `install.kind: "service"` / `runtime: "npm-global"`, `memoryLayers: ["WM","SWM"]`, `envRequired: ["TELEGRAM_BOT_TOKEN","DKG_NODE_URL","TRACABOT_ADMINS"]`, `networkEgress: ["api.telegram.org", …]`, tagged for `cfi-dkgv10-r1`. Source: https://github.com/OriginTrail/dkg-integrations/pull/9 and raw entry at brxtrac/dkg-integrations branch add-tracabot.
- **PR #3 — `dkg-wm-bridge`** `[cfi-dkgv10-r1]` (OpenClaw & Hermes artifacts → WM with schema.org provenance, promote to SWM; sensitivity classes + promotion guard; 147 tests) — the pattern for message/artifact ingestion with promotion discipline.
- **PR #11 — `openclaw-working-memory`**; **PR #16 — Claude Code Research Memory**; **PR #10 — `github-dkg`** `[cfi-dkgv10-r1]` (event-stream → WM ingestion, structurally like a message stream); **PR #4 — `langchain-dkg`** `[cfi-dkgv10-r1]`.
- **No Slack/Discord/generic-chat entry exists or is pending** — the bounty doc's "Slack threads → Shared Memory" suggestion (§4) and the repo's own `slack-shared-memory` / `SLACK_BOT_TOKEN` examples remain unclaimed as of 2026-07-26.

---

## 5. Staleness assessment

- **The pinned commit is NOT stale relative to upstream code:** `gh api repos/OriginTrail/dkg-integrations/commits` (2026-07-26) shows `c944c9c` (2026-04-24, merge of PR #1) is still the **HEAD of main**. Zero registry entries have been merged since the two seeds.
- **But the ecosystem has moved around it:** 16 PRs total, **14 open** (2026-04-26 → 2026-06-18), several tagged `[cfi-dkgv10-r1]`, none yet merged — the review committee has a backlog, and the earliest community submissions have waited ~3 months. Open PRs incl. #19 DKG Contestation Protocol, #18 memorygraph-dkg, #17 Obsidian, #16 Claude Code memory, #15 The Triad, #14 agience-flare, #13 PharmAgent, #12 RepNet, #11 openclaw-working-memory, #10 github-dkg, #9 TRACaBot, #8 Polymarket, #6 DKG arXiv, #4 langchain-dkg, #3 dkg-wm-bridge, #2 (OriginTrail's own hello-world pin bump — also unmerged). No issues open or closed.
- **Bounty terms are maintained elsewhere and are newer than the pin:** the binding doc `docs/active-now/dkg-v10-bounty.md` in OriginTrail/dkg-v9 was last modified **2026-06-10**, ~7 weeks after the registry pin. Repo-side facts (schema, CI, checklist) are current; treat award amounts/timeline/scope details as governed by that living document, and re-check it (plus the official OriginTrail channel, per §13/§16) before submitting.

## Practical takeaways for a chat/messaging submission

1. Deliverable to this repo = one `integrations/<slug>.json`; everything else (code, DESIGN.md brief, demo, tests) lives in your repo, published to npm with provenance and no install scripts.
2. Model the entry on `cursor-mcp-dkg.json` (WM+SWM writeAuthority set, promotion language) and TRACaBot's PR (service kind, chat-platform egress/credentials).
3. Stay WM/SWM-only in `writeAuthority` (no `/publish`, `/endorse`, `/verify`, `/update` — CI flags them out-of-scope for Round 1); express VM strictly as `promotionPath` prose.
4. Title `Add <name>`, tag `cfi-dkgv10-r1`, link design brief + recorded demo, attest 6-month maintenance.
5. The "Slack threads → Shared Memory" slot from the bounty's own suggestion list is still unclaimed; expect slow review (3-month-old PRs pending) and rolling cut-offs until the 50k TRAC Round-1 pool exhausts.
