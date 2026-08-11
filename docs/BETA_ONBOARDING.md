# Buzz + DKG Beta Operator Guide

This beta adds private OriginTrail DKG memory to an existing Buzz community.
It adopts the relay in place, creates or reuses a **Web of Trust** seed channel,
and lazily creates an isolated private Context Graph for every channel where a
Buzz agent proposes memory. The integration runs as a separate sidecar. It
does not move the relay database or enable on-chain publication.

## Before you start

Use a 64-bit Linux host (`x86_64` or `aarch64`) with:

- a running Buzz Relay;
- Docker and the Docker Compose plugin;
- GitHub CLI (`gh`); no GitHub account, login, or token is required; and
- `sudo` access.

The relay should be published from Docker on a host port. If it is not, have a
host-reachable HTTP or WebSocket URL ready. The installer can reuse a DKG Core
or Edge node running v10.0.11 or v10.0.12. If it finds no DKG node, it can
install a managed v10.0.12 Edge node by default, or a Core node when requested.

## Install

The shortest path is one command:

```bash
curl -fsSL https://github.com/OriginTrail/buzz-dkg-integration/releases/latest/download/install.sh | sudo sh
```

The command downloads the bundle for the host architecture plus its checksum
and signed attestation bundle, verifies its SHA-256 checksum and GitHub build
provenance locally without signing in, installs `buzz-dkg`, and opens the guided
setup. Review the displayed plan before accepting it.

Use a Buzz Relay build that advertises `buzz-dkg-memory-v1` and
`buzz-dkg-memory-v2` plus the `dkg_memory` profile descriptor in NIP-11. The v1
extension remains present for older agents. On a discovered local Docker
Compose deployment, the installer writes a mode-`0600` relay override containing
the private proxy URL and generated bearer token plus the explicit
memory-capability flag, performs one controlled restart of only the relay, and
starts two credential-free loopback/Unix-socket bridge processes. It
preserves the relay identity, database, public URL, and TLS configuration. For
an operator-managed relay on the same host, it prints the two values that its
operator must apply and leaves that relay untouched. A remote relay cannot use
the host's loopback gateway: deploy the integration beside that relay instead
of exposing the bearer-protected gateway over the network.

When the discovered Buzz container has relay membership enabled, that plan
also shows one native Buzz administration step. The installer generates a
separate DKG channel-owner identity and DKG Memory service identity, then adds
both as ordinary relay members with `/usr/local/bin/buzz-admin`. The command is
idempotent and does not require your Buzz/Nostr private key or write directly
to the relay database. The public keys and retained
credentials belong only to the integration.

To install only the CLI and inspect the plan first:

```bash
curl -fsSL https://github.com/OriginTrail/buzz-dkg-integration/releases/latest/download/install.sh | sudo env BUZZ_DKG_SKIP_LAUNCH=1 sh
sudo buzz-dkg plan
sudo buzz-dkg install
```

Container discovery preserves the relay's advertised community URL for tenant
routing and NIP-98 authentication. It uses a loopback host mapping only for
readiness and NIP-11 probes, avoiding hairpin TLS or private-network identity
failures without changing the community authority. If discovery cannot identify
the relay, pass its existing community URL explicitly:

```bash
sudo buzz-dkg install --relay wss://community.example.com
```

If a discovered closed relay does not expose the native CLI, the installer
stops before bootstrap and prints both stable public keys. You can print them
again without exposing their private keys:

```bash
sudo buzz-dkg identities
```

Enroll both public keys through that relay's supported administration path.
Then explicitly confirm that prerequisite:

```bash
sudo buzz-dkg install \
  --relay wss://community.example.com \
  --relay-members-enrolled
```

Do not use `--relay-members-enrolled` as a bypass: bootstrap still authenticates
both identities and fails if they cannot reach the relay.

For a remote closed relay, the plan reports membership as external/unknown and
does not attempt administration. If bootstrap reports a membership denial, run
`sudo buzz-dkg identities`, enroll both public keys on that relay, and rerun
with `--relay-members-enrolled`.

For an existing DKG node on a non-default API port or token path:

```bash
sudo buzz-dkg install \
  --relay wss://community.example.com \
  --dkg-api http://127.0.0.1:9200 \
  --dkg-token-path /home/relay-operator/.dkg/auth.token
```

For a new unattended installation, select the DKG network explicitly:

```bash
sudo buzz-dkg install \
  --relay wss://community.example.com \
  --dkg-role edge \
  --dkg-network testnet \
  --yes
```

Use `testnet` for the first community trial. An existing node's role and network
are detected and must match any explicit selection.

## Confirm the installation

Run:

```bash
sudo buzz-dkg status
sudo buzz-dkg smoke
```

A successful setup prints the seed channel ID and Context Graph ID. In a Buzz
client, connect to the community's unchanged public relay URL. A compatible
Buzz agent detects the relay capability and, after each normal channel turn,
privately submits a signed semantic proposal referencing the exact signed chat
events it used. The relay verifies authentication, membership, channel access,
proposal signature, and source-event binding. The integration then creates the
channel's private Context Graph if needed and promotes the proposal through
Working Memory into Shared Working Memory without posting another chat message.
The authenticated request returns as soon as the proposal is durably accepted;
the bounded DKG lifecycle continues in the background and is crash-recoverable.

No `@dkg distill` command is required for these agent turns. Human-only chats
keep the existing explicit workflow in the seeded **Web of Trust** channel
during the beta:

```text
@dkg distill
@dkg ask <a question answered by the distilled thread>
```

The smoke check performs the existing command path and, when the relay
advertises agent memory, also submits a real signed kind-`40009` proposal through
the authenticated relay endpoint and reads the resulting channel memory back.
Verifiable Memory publication remains disabled, so the beta does not spend gas
or write on-chain.

For a targeted agent-memory canary that skips the older explicit-distill
checks, run the smoke service with `BDI_SMOKE_AGENT_MEMORY_ONLY=true`.

Agents can also submit explicitly through the installed Buzz CLI:

```bash
buzz memory propose \
  --channel <channel-uuid> \
  --source <signed-source-event-id> \
  --input proposal.json
```

The proposal contains a short summary plus typed decisions, claims, questions,
tasks, and relationships. It contains no hidden reasoning, secrets, or raw tool
traces. Multiple agents may contribute to the same channel graph; the signed
proposal and source events preserve who asserted what.

Profile-aware agents always use the general `dkg-memory@1` vocabulary and add
`dkg-software@1` only for software evidence. The trusted integration mints
stable, repository-scoped DKG identifiers for repositories, commits, packages,
files, and symbols; the LLM emits only compact local IDs, canonical locators,
and allowlisted terms. The same repository or code symbol therefore converges
on the same URI across authorized communities and Context Graphs, while the
same symbol name in another repository remains distinct. In the Buzz Memory
panel, **Software knowledge** exposes two beta questions through the
authenticated relay:

- “Who changed it?” for a repository URL and named function; and
- “Why this commit?” for a repository URL, commit SHA, and affected component.

These are fixed query operations. The app cannot submit SPARQL, a Context Graph
ID, a DKG endpoint, or credentials.

The Web of Trust beta adds a capability-gated **Trust** tab to the same Memory
panel. A member selects a person, writes what they directly observed, and
clicks **Sign vouch**. Buzz publishes a channel-scoped NIP-32 vouch and submits
that exact signed event for `dkg-trust@1` projection. Other members see the
person's contribution evidence, received/given vouches, explanation, time,
memory layer, and source-event identifier. This is evidence discovery, not a
leaderboard: the beta calculates no global trust score, and agents cannot vouch
on a human's behalf.

## Operate or stop it

```bash
sudo buzz-dkg status
sudo buzz-dkg logs
sudo buzz-dkg smoke
sudo buzz-dkg remove
```

`remove` stops only the integration sidecar. It retains Buzz history, DKG
state, integration state, credentials, relay memberships, the channel, and the
Context Graph.
Rerunning `install` converges on the managed objects instead of creating new
ones.

Configuration is stored in `/etc/buzz-dkg`; retained integration state is in
`/var/lib/buzz-dkg`. Treat both locations as sensitive and include them in the
host's protected backup policy.

## Beta acceptance checklist

- The existing relay remains healthy and clients use its unchanged public URL.
- On a closed relay, both managed identities appear exactly once in the relay
  membership list after installation and after a rerun.
- `buzz-dkg status` reports the expected relay and DKG role/version.
- `buzz-dkg status` reports the agent memory proxy and automatic private channel
  graphs as enabled.
- `buzz-dkg smoke` passes.
- On a v2 relay, smoke proves both the contributor and commit-decision queries
  against RDF created by its signed canary proposal.
- A Buzz agent can answer normally in any channel and its signed proposal
  appears only in that channel's Context Graph without a second chat message.
- A Buzz user can query grounded channel memory through the authenticated relay
  proxy; direct DKG credentials are never exposed to the app.
- Restarting the host and rerunning `buzz-dkg install` do not create duplicate
  channels or graphs.
- `buzz-dkg remove` stops only the sidecar and leaves relay/DKG data intact.

When reporting a beta problem, include the command that failed, the non-secret
output of `sudo buzz-dkg status`, and relevant lines from `sudo buzz-dkg logs`.
Never share `/etc/buzz-dkg/runtime.env`, DKG `auth.token`, Nostr secret keys, or
private relay event data.
