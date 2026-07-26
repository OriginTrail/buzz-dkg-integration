# Buzz Source Audit (for DKG integration spec)

Repo: `/Users/zigadrev/code/upstream-pins/buzz`, pinned at `dd222a509b156ba52ed3219e895d7bf1cf322c92` (branch `main`, "Refine mobile settings and themes (#2844)"). All citations are `path:lines @ dd222a5`. Read-only audit; nothing was built or run.

Classification legend: **VERIFIED** = cited source read directly; **OBSERVED** = runtime behavior seen (none in this audit — no code was executed); **HYPOTHESIS/UNRESOLVED** = could not confirm from source.

## Summary

Buzz (by Block) is a Rust **Nostr relay** (`buzz-relay`) speaking **NIP-29 relay-based groups** natively, plus a Tauri desktop app, Flutter mobile app, an **agent-first CLI (`buzz-cli`, binary `buzz`)**, an ACP agent harness, and a **server-side YAML workflow engine with a real reaction-added trigger**. Channels are relay-side DB rows (Postgres) identified by UUID and referenced on the wire via NIP-29 `h` tags; threads, membership, and reactions are all first-class and relay-enforced. A headless bot is a fully supported pattern (in-repo `countdown-bot` example): hold a secp256k1/Schnorr Nostr key, answer NIP-42 over WebSocket (or sign NIP-98 for the HTTP bridge), subscribe with `#h` filters, publish kind:9 messages. **Key constraint: the relay rejects any event kind not in its hardcoded registry** — arbitrary/custom kinds cannot be stored (`restricted: unknown event kind`). Deletion is soft (NIP-09 self-delete + admin kind:9005 set `deleted_at`); the event store is not append-only in an enforceable sense.

## Repo layout

Top level (observed via `ls` at dd222a5): `crates/` (26 Rust crates — the whole backend + CLI + SDK), `desktop/` (Tauri 2 + React 19), `mobile/` (Flutter), `web/` (browser client served by relay), `admin-web/`, `migrations/` (SQL, auto-applied on relay startup), `examples/` (`countdown-bot`, `meadow-core`), `docs/` (incl. `docs/nips/` custom NIP drafts), `Justfile`, `docker-compose.yml`, `.env.example`, `NOSTR.md`, `ARCHITECTURE.md`, `AGENTS.md` (symlinked as `CLAUDE.md`).

Key crates (directory listing + `AGENTS.md` "Repo Structure"):

| Crate | Role |
|---|---|
| `buzz-relay` | WebSocket relay server, HTTP routes, git + huddle audio |
| `buzz-core` | Event verification, filter matching, **kind registry** (`crates/buzz-core/src/kind.rs`) |
| `buzz-db` | Postgres event store (channels, members, threads, reactions tables) |
| `buzz-auth` | NIP-42 (`nip42.rs`), NIP-98 (`nip98.rs`, `nip98_replay.rs`), scopes |
| `buzz-cli` | Agent-first CLI (`buzz`) |
| `buzz-sdk` | Typed Nostr event builders + mention helpers |
| `buzz-workflow` | YAML workflow engine (evalexpr conditions) |
| `buzz-acp` | ACP harness bridging Buzz events to AI agents |
| `buzz-agent`, `buzz-persona`, `buzz-dev-mcp`, `sprig` | agent runtime surface |
| `buzz-ws-client` | shared NIP-42 WebSocket client (connect, auth, publish) |
| `buzz-admin` | operator CLI (relay membership) |
| `buzz-test-client` | E2E suite (`tests/e2e_nostr_interop.rs` etc.) |

## Findings

### 1. What Buzz is; how channels/rooms are modeled — VERIFIED

- "Buzz is a Nostr relay that speaks NIP-29 (relay-based groups) natively" — `NOSTR.md:3 @ dd222a5`. Components: relay + desktop + mobile + CLI + agent harness (AGENTS.md "Repo Structure"; crate listing above). Languages: Rust (relay/CLI/SDK/agents), TypeScript/React (desktop, web), Dart/Flutter (mobile).
- **Channel = first-class relay-side entity**: Postgres `channels` table with `id` (UUID), visibility, `archived_at`, `deleted_at`, canvas, etc. — `crates/buzz-db/src/channel.rs:43,280-322 @ dd222a5`. On the wire a channel is the NIP-29 `h` tag whose value is the channel UUID: `extract_channel_id()` parses `"h"` tag content as `Uuid` — `crates/buzz-relay/src/handlers/ingest.rs:307-319 @ dd222a5`. AGENTS.md "Key Patterns": "Channels use `h` tags (NIP-29 group tag), not `e` tags."
- **Thread = first-class**: relay materializes `thread_metadata` (root id, depth, counters) at ingest from NIP-10 `e` tags — `resolve_nip10_thread_meta()` at `crates/buzz-relay/src/handlers/ingest.rs:563-660 @ dd222a5` (parses `root`/`reply` markers at lines 580-581, enforces "root tag does not match thread ancestry" and "thread depth limit exceeded", rejects unknown parents at line 610). Thread counters `reply_count`/`descendant_count` are materialized on roots (AGENTS.md "Thread counters"; `crates/buzz-db/src/event.rs:792-797` updates counters transactionally on delete).
- **Member = first-class**: `channel_members` table with roles (`crates/buzz-db/src/channel.rs:449` "Remove a member from a channel (soft delete)"); plus relay-level `relay_members` (NIP-43) — `crates/buzz-relay/src/config.rs:109-112 @ dd222a5`.
- **Mention = NOT a first-class relay primitive.** Mentions are `p` tags computed client-side (see #5). No relay-side mention table/kind found.
- **Workflow trigger = first-class**: workflow definitions are kind 30620 events (`crates/buzz-core/src/kind.rs:381-382`), evaluated server-side per ingested event (see #8).
- Multi-tenant note: the relay host/domain determines the community; `#h` values are checked against the host-derived community — `NOSTR.md:5-20 @ dd222a5`; `crates/buzz-relay/src/tenant.rs`.

### 2. buzz-cli — VERIFIED (commands exist; exact flags cited)

`buzz` is the agent-first CLI (`crates/buzz-cli`, binary built with `cargo build --release -p buzz-cli`, per AGENTS.md "Agent CLI"). Env: `BUZZ_RELAY_URL`, `BUZZ_PRIVATE_KEY`, `BUZZ_AUTH_TAG` (AGENTS.md). Transport: **HTTP bridge (`POST /events`, `/query`, `/count`) with NIP-98 signed Authorization headers**, not WebSocket, for all normal reads/writes — `crates/buzz-cli/src/client.rs:78-84 (sign_nip98), 767-790 (query), 863-895 (submit_event) @ dd222a5`; WebSocket + NIP-42 used only for ephemeral events (`client.rs:1068`). Built-in retry on 502/429 with relay `retry in Ns` hints (`client.rs:1880-1910` tests).

The four operations asked about:

- **List channels**: `buzz channels list [--visibility open|private] [--member] [--limit N]` — `crates/buzz-cli/src/lib.rs:502-517 @ dd222a5`.
- **Join channel**: `buzz channels join --channel <UUID>` — `lib.rs:610-615`; implementation publishes a **kind 9021 NIP-29 join-request** built by `buzz_sdk::build_join` — `crates/buzz-cli/src/commands/channels.rs:896-900` and `crates/buzz-sdk/src/builders.rs:702-705 @ dd222a5`.
- **Read a thread**: `buzz messages thread --channel <UUID> --event <hex64> [--limit N] [--depth-limit N]` — `lib.rs:457-471`; implementation issues two OR'd filters over `POST /query` (replies: `{"kinds":[9,40002,40003,40008,45003],"#h":[channel],"#e":[event]}`; root: `{"ids":[event]}`), sorts by `created_at`, prints normalized JSON — `crates/buzz-cli/src/commands/messages.rs:304-338 @ dd222a5`.
- **Post a reply**: `buzz messages send --channel <UUID> --content "..." --reply_to <hex64>` (`--reply-to` flag; also `--kind`, `--broadcast`, `--file`) — `lib.rs:349-372`.
- Reactions: `buzz reactions add --event <hex64> --emoji '👍' [--emoji-url <url>]`, `remove`, `get` — `lib.rs:697-726`.

**JSON output contract** (VERIFIED): all writes are normalized to `{"event_id": "...", "accepted": bool, "message": "..."}` — `normalize_write_response()` at `crates/buzz-cli/src/client.rs:1420-1432 @ dd222a5`; reads print sig-stripped JSON arrays (AGENTS.md "Agent CLI"; `commands/messages.rs:333-336` `normalize_events`/`format_events`). Exit codes 0..5 documented in AGENTS.md ("0=ok, 1=input error, 2=network/relay, 3=auth, 4=other, 5=write conflict (NIP-33 LWW)"). Global flag ordering gotcha: `buzz --format compact channels list` (flag before subcommand). Exact byte-level JSON output was **not executed** (no build allowed), so field ordering is HYPOTHESIS; the shapes above are VERIFIED from source.

Raw Nostr fallback is fully supported too — `NOSTR.md:150-186` gives working `nak` recipes for every operation (kind 9 + `h` tag; NIP-10 reply `["e","<parent>","","reply"]`; kind 7 reaction; kind 9007 create).

### 3. Nostr event kinds and tags — VERIFIED

Authoritative registry: `crates/buzz-core/src/kind.rs` (955 lines; "This module is the authoritative source for Buzz kind numbers", lines 1-5). Key kinds:

| Purpose | Kind | Citation (kind.rs @ dd222a5) |
|---|---|---|
| Channel/group create | 9007 (`name` tag; opt. `visibility`, `channel_type`) | :282-283; `NOSTR.md:53` |
| Edit group metadata | 9002 (`name`/`about` admin; `topic`/`purpose` any member) | :278-279; `NOSTR.md:56`; archived-tag scope split `ingest.rs:267-278` |
| Group delete | 9008 | :284-285 |
| Group metadata state (relay-signed) | 39000 (`d`=UUID, `name`, `closed`, `about`, `private`, `hidden`) | :361-362; `NOSTR.md:104-126` |
| Group admins / members / roles | 39001 / 39002 / 39003 (39003 defined but **not emitted**, `NOSTR.md:82`) | :363-368 |
| Chat message | **9** (`KIND_STREAM_MESSAGE`), requires `h` tag | :414-419; h-required `NOSTR.md:336` |
| Rich message / edit / pin / bookmark / scheduled / reminder / diff | 40002/40003/40004/40005/40006/40007/40008 | :421-433 |
| Thread root/reply | kind 9 (or 40002 etc.) + NIP-10 `e` tags with `root`/`reply` markers | `ingest.rs:563-660` |
| Reaction | **7** (NIP-25), target via `e` tag | :57-58; `builders.rs:463-472` |
| Deletion | 5 (NIP-09, self-authored) + 9005 (admin) | :55-56, 280-281; `NOSTR.md:51,57` |
| Add/remove user to channel | 9000 / 9001 (`p` tag target, `h` tag channel) | :274-277; countdown-bot self-add `examples/countdown-bot/src/main.rs:173-175` |
| Join / leave | 9021 / 9022 | :288-291 |
| Create invite | 9009 — accepted+stored, side-effect handler **deferred no-op** | :286-287; `NOSTR.md:81` |
| Membership notifications (relay-signed) | 44100 added / 44101 removed (`p` target, `h` channel; p-gated) | :470-476; `NOSTR.md:128-148` |
| Relay membership (NIP-43) | commands 9030/9031/9032/9033; announcements 8000/8001; roster snapshot 13534 | :327-344 |
| Profiles | 0 | :8-9 |
| DMs | 1059 gift wrap (NIP-17) + Buzz 41010/41011/41012/41001 | :59-60, 445-453 |
| Workflow def / lifecycle | 30620 def; 46001-46012 lifecycle; 46020 trigger; 46030/46031 approvals | :381-382, 496-522 |
| Presence / typing (ephemeral) | 20001 / 20002 | :401-407 |
| Forum | 45001 post / 45002 vote / 45003 comment | :487-494 |
| Agent surface | 10100 agent profile, 30174 engram, 30175 persona, 30176 team, 30177 managed agent, 44200 turn metric | :85-94, 158-259, 478-485 |
| Auth (never stored) | 22242 NIP-42, 27235 NIP-98, 24242 Blossom | :76-83 |

### 4. Reactions: targeting and emoji normalization — VERIFIED

- Wire format: kind 7, content = emoji char or `+`/`-`; target referenced by **`e` tag** (last valid 64-hex `e` tag wins). The relay **derives the channel from the target event's stored channel via the `e` tag and ignores client `h` tags**; reactions to unknown targets are rejected fail-closed — `derive_reaction_channel()` at `crates/buzz-relay/src/handlers/ingest.rs:329-365 @ dd222a5`; `NOSTR.md:50,337`. Reactions are also written to a dedicated relational row (`insert_reaction_event_with_thread_metadata`, `ingest.rs:2324`).
- SDK builder: `build_reaction()` — max 64 chars content, single `e` tag — `crates/buzz-sdk/src/builders.rs:463-472`. Custom emoji: `build_custom_emoji_reaction()` → content `:shortcode:` + NIP-30 `["emoji", shortcode, url]` tag, with `normalize_custom_emoji_shortcode()` applied — `builders.rs:479-492`.
- Reaction removal = **NIP-09 kind 5 deletion of your own kind-7 event** (`build_remove_reaction`, `builders.rs:494-498`; CLI finds your reaction by `{"kinds":[7],"#e":[target],"authors":[me]}` then deletes it — `crates/buzz-cli/src/commands/reactions.rs:34-79`).
- Emoji normalization: only custom-emoji **shortcodes** are normalized (SDK). Workflow `reaction_added` emoji filter does an **exact string compare** of trigger `emoji` config vs reaction content — no unicode↔shortcode mapping — `crates/buzz-workflow/src/lib.rs:811-824 @ dd222a5`. So a trigger configured `emoji: "👍"` matches content `👍`; `"thumbsup"` would only match a custom-emoji reaction whose content is literally `:thumbsup:`… actually exact compare against content, so config must be the literal content string. (Schema doc comment says "Emoji name (e.g. `thumbsup`)" — `schema.rs:114-117` — which does NOT match how the comparison works against content; treat the literal-content compare as authoritative.)

### 5. Mention resolution — VERIFIED

- **On the wire a mention is a `p` tag.** `@name` syntax is resolved to pubkeys client-side (or by the workflow engine server-side) before publish; nothing relay-side parses `@name` at ingest.
- SDK helpers (pure, no network): `extract_at_names` / `extract_at_mentions_with_known` (`@` must be at start or after whitespace; name chars `[A-Za-z0-9._-]`; multi-word display names via known-names longest-first), `extract_nostr_uris` for **NIP-27 `nostr:npub1…`** inline refs (code regions stripped), `match_names_to_profiles` against channel member kind-0 profiles, merged into p-tags with `MENTION_CAP = 50` — `crates/buzz-sdk/src/mentions.rs:1-120 @ dd222a5`.
- Workflow-emitted messages: `resolve_mention_pubkeys()` in the relay reverse-parses `@Name` against destination-channel member display names (exact, greedy-longest, ambiguous → no tag) to attach `p` tags — `crates/buzz-relay/src/workflow_sink.rs:22-50 @ dd222a5`.
- NIP-10 markers are for **threading**, not mentions (`ingest.rs:580-581`).
- **How a headless bot detects a mention**: check the incoming event's `p` tags for its own pubkey. That is exactly what both in-repo consumers do: countdown-bot `event_mentions_bot()` scans tags for `["p", <bot-hex>]` — `examples/countdown-bot/src/main.rs:279-286 @ dd222a5`; the ACP harness `require_mention` rule: "a `p` tag matching `agent_pubkey_hex`" — `crates/buzz-acp/src/filter.rs:352, 390-396 @ dd222a5`.

### 6. Relay auth: NIP-42 vs NIP-98 — VERIFIED (both implemented)

- **NIP-42 (WebSocket)**: `crates/buzz-auth/src/nip42.rs:1-83 @ dd222a5` — relay proactively sends `["AUTH", <challenge>]` immediately on connect (`crates/buzz-relay/src/connection.rs:116, 157-195`; `AUTH_TIMEOUT` 5s at line 27); client signs kind 22242 with `challenge` + `relay` tags; verification checks kind, Schnorr sig, challenge, normalized relay URL, ±60s timestamp. Optional gates: `BUZZ_PUBKEY_ALLOWLIST` (fail-closed DB allowlist, `NOSTR.md:85-99`), `BUZZ_REQUIRE_RELAY_MEMBERSHIP` (`relay_members` check, `config.rs:109-112,483`).
- **NIP-98 (HTTP)**: kind 27235 signed events in `Authorization: Nostr <base64>` headers for the HTTP bridge — verified server-side in `crates/buzz-relay/src/api/bridge.rs:58-111` via `buzz_auth::verify_nip98_event` (`crates/buzz-auth/src/nip98.rs`), with replay prevention (`state.rs:576-582 nip98_replay`). Routes using it: `POST /events`, `/query`, `/count`, moderation reads, invites (`router.rs:70-117`).
- **Headless flow (two equivalent options)**:
  1. *WebSocket*: connect `ws://relay:3000` → receive AUTH challenge → reply signed 22242 → `REQ` with `{"kinds":[9],"#h":["<uuid>"]}` → `EVENT` kind 9. Reference implementation: `examples/countdown-bot/src/main.rs` (subscribe at :191-196, publish reply at :238-248); shared client crate `buzz-ws-client` ("Shared NIP-42 WebSocket client — connect, auth, publish", AGENTS.md).
  2. *HTTP bridge*: sign NIP-98 per request; `POST /query` for reads, `POST /events` for writes — this is what `buzz-cli` does (`client.rs:767-895`).
- Caveat for global subscriptions: REQs matching p-gated kinds (44100/44101/1059/…) must carry `#p` = your own pubkey, and queries should always specify `kinds` or they hit the p-gate 403 — `crates/buzz-core/src/kind.rs:146-156`; `NOSTR.md:141-148`; AGENTS.md gotcha #2.

### 7. Agent authorization / membership — VERIFIED

Three layers, all **relay-enforced** (not client-side):

1. **Relay admission**: pubkey allowlist (`pubkey_allowlist` table) and/or NIP-43 relay membership (`relay_members`; managed via `buzz-admin` CLI or kinds 9030-9032; `NOSTR.md:202-297`). Alternative for bots/agents: **NIP-OA owner attestation** — the NIP-42 AUTH event carries an `["auth", owner_pubkey, conditions, sig]` tag (BIP-340 sig over `SHA256("nostr:agent-auth:"||agent_pubkey||":"||conditions)`) so an owner who is a member vouches for the agent key — `crates/buzz-sdk/src/nip_oa.rs:1-27 @ dd222a5`; both auth paths demonstrated in `examples/countdown-bot/README.md` ("Standalone" vs "Owner-attested").
2. **HTTP invite flow**: `POST /api/invites` (mint; NIP-98; owner/admin only) returns `{code, expires_at, url}`; `POST /api/invites/claim` (NIP-98 signed by the joining pubkey, exempt from the membership gate, rate-limited) — `crates/buzz-relay/src/api/invites.rs:230-307 @ dd222a5`. (NIP-29 kind 9009 invites are stored but their side-effect handler is a no-op — `NOSTR.md:81`.)
3. **Channel membership**: kind 9000 add (open channels: self-add allowed subject to target's `channel_add_policy`; private: owner/admin only — `NOSTR.md:54`), kind 9021 join request (open channels only — `NOSTR.md:73`), or `buzz channels add-member`. Write enforcement is at ingest: e.g. joins to private channels rejected `"restricted: channel is private"` — `crates/buzz-relay/src/handlers/ingest.rs:2169-2171 @ dd222a5`; revoked private-channel members cannot mutate old messages (`ingest.rs:811`). Note: `closed` tag on 39000 reflects the membership model, but **open channels remain readable/writable by non-members at runtime** — `NOSTR.md:109`.

**Key material**: one Nostr secp256k1 keypair (nsec/hex) per agent; optionally an owner-signed NIP-OA auth tag (`BUZZ_AUTH_TAG` env, auto-injected by the ACP harness — AGENTS.md "Agent CLI").

### 8. buzz-workflow — VERIFIED

- YAML authored, stored as canonical JSON in kind 30620 events (`d` = workflow UUID, `#h` = channel) published via `buzz workflows create --channel <uuid> --yaml <file|- >` — `crates/buzz-workflow/src/schema.rs:1-27 @ dd222a5`; `crates/buzz-cli/src/commands/workflows.rs:101-131, 219-226`.
- **Triggers actually implemented** (`TriggerDef`, `schema.rs:38-68`): `message_posted` (optional evalexpr `filter`), **`reaction_added` (optional `emoji`) — YES, a reaction-based trigger exists**, `diff_posted`, `schedule` (cron|interval), `webhook`. Serde tag is `on:` (`schema.rs:33-37`).
- **Actions actually implemented** (`ActionDef`, `schema.rs:92-147`; execution in `executor.rs`): `send_message`, `send_dm`, `set_channel_topic`, `add_reaction`, `call_webhook`, `request_approval`, `delay`. Steps support `if:` evalexpr conditions and `timeout_secs` (`schema.rs:71-87`).
- **Dispatch**: on every persisted channel event the relay calls `workflow_engine.on_event()` (`crates/buzz-relay/src/handlers/event.rs:520-545`), which skips events without `channel_id` and workflow-execution kinds, then matches `trigger_matches_event` (`reaction_added` ⇔ kind 7 only — `lib.rs:959`) and `should_fire_workflow` (exact emoji compare — `lib.rs:811-824`). Reaction trigger context: `text` = emoji char, `message_id` = the **target** message id from the reaction's `e` tag — `lib.rs:877-934`.
- **Webhook inbound** (trigger): `POST /hooks/{id}`, authenticated by a **shared secret** (`x-webhook-secret` header preferred, `?secret=` fallback; no NIP-98; fail-closed if no secret stored; host-derived tenant binding, generic 404 on cross-tenant probes) — `crates/buzz-relay/src/api/bridge.rs:1780-1841 @ dd222a5`; `router.rs:119-120`.
- **Webhook outbound** (`call_webhook` action): reqwest POST (method overridable), 10s timeout, SSRF guard (DNS-resolve + private-IP block + pinned-IP client, no proxy, no redirects), 1 MiB response cap, result `{status, body}` exposed to later steps — `crates/buzz-workflow/src/executor.rs:744-870 @ dd222a5`. **No retry logic** for outbound webhooks (single attempt; grep for retry in executor/lib found none). Payload/body is a free-form template string (`schema.rs:128-130`).
- Caveat: the `add_reaction` action posts to `POST /api/messages/{message_id}/reactions` (`executor.rs:886-892`) — **no such route exists in the relay router** (`router.rs:55-140`; repo-wide grep for `api/messages` in buzz-relay found nothing). HYPOTHESIS: the AddReaction action is dead/broken against the current relay; the reaction *trigger* is unaffected.

### 9. Custom event kinds — VERIFIED: relay rejects unknown kinds

`required_scope_for_kind()` is an exhaustive allowlist over registered kinds; the fallthrough is `_ => Err("restricted: unknown event kind")` and "Returns `Err` for unknown kinds — the relay rejects them" — `crates/buzz-relay/src/handlers/ingest.rs:195-303 @ dd222a5` (fallthrough at :303). Ephemeral range 20000-29999 is Redis-fan-out only, never stored (`kind.rs:396-399`). Project convention: new features must add a kind to `buzz-core/src/kind.rs` and a relay handler (AGENTS.md "Event kinds"). **Consequence for integration: you cannot publish arbitrary DKG-specific kinds; you must ride existing kinds (e.g. kind 9 content/tags) or fork/extend the registry.**

### 10. Relay HTTP routes and auth classes — VERIFIED

`crates/buzz-relay/src/router.rs:55-140 @ dd222a5`:

| Route | Auth |
|---|---|
| `GET /` (NIP-11 or WS upgrade), `/info`, `/.well-known/nostr.json`, `/health`, `/_liveness`, `/_readiness` | none |
| `POST /events`, `POST /query`, `POST /count` | NIP-98 (dev-mode `X-Pubkey` fallback — `bridge.rs:58-80`) |
| `GET /moderation/reports`, `/moderation/audit`, `/moderation/restricted` | NIP-98 + mod-authz gate |
| `POST /api/invites` (mint) | NIP-98, owner/admin role |
| `POST /api/invites/claim`, `/api/invites/accept-policy`; `GET /api/join-policy*` | NIP-98 by joining key (claim exempt from membership gate) |
| `POST /hooks/{id}` | webhook shared secret (no NIP-98) |
| `/operator/communities*` | operator NIP-98 (origin-pinned `u` tag — `config.rs:153`) |
| `/media/*` (Blossom BUD-01/02), git smart HTTP, `/huddle/{id}/audio`, `/api/admin/v1` (separate admin host) | own routers merged at `router.rs:135-140`; Blossom auth kind 24242 (`kind.rs:78-79`) |

1 MiB request-body limit on the API router (`router.rs:131-132`).

### 11. Append-only? — VERIFIED: No

Deletion is real but **soft**: NIP-09 kind 5 (self-authored only, `e` tag required) and admin kind 9005 set `deleted_at = NOW()` via `soft_delete_event()` / `soft_delete_by_coordinate()` / `soft_delete_event_and_update_thread()` — `crates/buzz-db/src/event.rs:739-797 @ dd222a5`; all read paths filter `deleted_at IS NULL` (`event.rs:227,364,373,623,629`). NIP-33 replaceable kinds are last-write-wins. So rows persist physically (tombstoned, not erased) but the *visible* store is mutable; there is no enforceable append-only guarantee at the protocol surface. A separate hash-chain audit log exists (`buzz-audit` crate, kind 48001 `kind.rs:527-528`) — its integration depth was not audited (UNRESOLVED).

### 12. Identity model — VERIFIED

- Everyone — human, bot, agent, and the relay itself — is a Nostr secp256k1 keypair using **BIP-340 Schnorr signatures** (rust-nostr `Event::verify_signature` via `buzz_core::verify_event` — `crates/buzz-core/src/verification.rs:11-26 @ dd222a5`; NIP-OA explicitly uses `nostr::secp256k1::schnorr::Signature`, `nip_oa.rs:17-25`).
- Humans: kind 0 profiles synced to a `users` table (`NOSTR.md:52`); NIP-05 handles canonicalized to the relay domain.
- Agents: same key type plus agent-specific kinds — kind 10100 agent profile (`kind.rs:86-87`), kind 30177 managed-agent record (owner-authored, explicitly must never carry the agent's secret key — `kind.rs:252-259`), kind 30175 persona, NIP-OA owner attestation binding agent key → owner key (`nip_oa.rs`). Channel-member roles include `bot` (`lib.rs:655` role list; countdown-bot self-adds with `role=bot`, `examples/countdown-bot/README.md`).
- The relay signs system/discovery events with `BUZZ_RELAY_PRIVATE_KEY` (`NOSTR.md:326`); client-submitted relay-only kinds (44100/44101) are rejected (`NOSTR.md:339`).

### 13. Running headless bots/agents — VERIFIED

- **Minimal bot**: `examples/countdown-bot` (437-line single file) — "Any process that can hold a Nostr key, answer NIP-42 auth, publish a kind 0 profile, subscribe to events, and publish kind 9 channel messages can be a bot" (`examples/countdown-bot/README.md`). Env: `BUZZ_RELAY_URL`, `BUZZ_CHANNEL_ID`, `BUZZ_BOT_PRIVATE_KEY`, `BUZZ_BOT_AUTH_MODE=standalone|owner-attested` (+`BUZZ_OWNER_PRIVATE_KEY`). Subscribes `{"kinds":[9],"#h":[channel]}` (`main.rs:191-196`), detects mentions via `p` tags (`main.rs:279-286`), replies with signed kind 9 `EVENT` (`main.rs:238-248`).
- **AI-agent stack**: `buzz-acp` (ACP harness with per-channel subscription rules incl. `require_mention` — `filter.rs:93,352,390-396`), `buzz-agent`, `buzz-persona`, `buzz-dev-mcp`, bundled as `sprig` (AGENTS.md). The harness injects `BUZZ_RELAY_URL`/`BUZZ_PRIVATE_KEY`/`BUZZ_AUTH_TAG` into managed agent subprocesses, which then use `buzz-cli`. Shutdown convention: owner sends kind 9 `"!shutdown"` with `p` tag of the agent (`kind.rs:414-418`).
- **SDK**: `buzz-sdk` typed builders for every write (messages, reactions, joins, workflow defs, NIP-OA) — `crates/buzz-sdk/src/builders.rs`.

## Running an isolated local stack

All VERIFIED from source (not executed):

- Toolchain: `. ./bin/activate-hermit` (hermit-pinned Rust/Node), `cp .env.example .env`, `just setup` (AGENTS.md "Getting Started").
- Infra: `docker compose up -d` starts `buzz-postgres` (postgres:17-alpine, host **5432**, user/pass/db `buzz`/`buzz_dev`/`buzz`), `buzz-redis` (**6379**), adminer (**8082**), keycloak (**8180**), minio (**9000/9001**), prometheus (**9090**) — `docker-compose.yml:5-157 @ dd222a5`. Postgres data in named volume `postgres-data`.
- Relay: `just relay` = `cargo run -p buzz-relay` after bootstrap + auto-migrations (`Justfile:366-371`); binds `BUZZ_BIND_ADDR` default `0.0.0.0:3000` (`.env.example:47`); `DATABASE_URL=postgres://buzz:buzz_dev@localhost:5432/buzz`, `REDIS_URL=redis://localhost:6379` (`.env.example:21,33`). Health port default 8080, metrics 9102 (`Justfile:416-419`). Migrations auto-apply from `migrations/` on startup (AGENTS.md).
- **Isolation knobs for a disposable spike**: override `BUZZ_BIND_ADDR` (e.g. `127.0.0.1:9401` — avoid 3000 if anything else runs), `DATABASE_URL`/`REDIS_URL` to throwaway containers on non-default ports (compose file hardcodes 5432/6379 host ports, so for true isolation run your own postgres/redis containers or edit a copy of compose), set `BUZZ_RELAY_PRIVATE_KEY` to a fixed test key (default is random per boot — `NOSTR.md:326`), leave `BUZZ_PUBKEY_ALLOWLIST=false` and `BUZZ_REQUIRE_RELAY_MEMBERSHIP` unset for open dev auth. `docker-compose.harness.yml` exists for the test harness. E2E reference: `crates/buzz-test-client/tests/e2e_nostr_interop.rs`.
- CLI: `cargo build --release -p buzz-cli` → `./target/release/buzz`; set `BUZZ_PRIVATE_KEY` + `BUZZ_RELAY_URL=ws://localhost:<port>`.

## Open questions

1. **Custom kinds are rejected** (`ingest.rs:303`) — the integration must either encode DKG payloads inside existing kinds (kind 9/40002 content + tags) or carry a patch adding kinds to `buzz-core/src/kind.rs` + a handler. Which path is acceptable is a spec decision, not a code question.
2. Workflow `add_reaction` action targets a nonexistent REST route (`executor.rs:886-892` vs `router.rs`) — likely dead; needs a live test to confirm (OBSERVED-pending).
3. Workflow `reaction_added` `emoji:` config semantics: doc says "emoji name" but code compares literally against reaction content (`lib.rs:811-824` vs `schema.rs:114-117`). Confirm with a live workflow in the spike.
4. Exact CLI JSON field bytes/ordering for `channels list` / `messages thread` — verify by running the built CLI in the spike (source-level shapes are cited in #2).
5. Depth of `buzz-audit` hash-chain coverage (does it cover soft-deletes?) — not audited.
6. `docs/nips/` contains many Buzz-specific NIP drafts (NIP-OA, NIP-AE, NIP-AM, NIP-WP, NIP-ER, …) worth reading before finalizing the spec; only those needed for the 13 questions were opened.
