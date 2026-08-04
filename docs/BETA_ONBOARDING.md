# Buzz + DKG Beta Operator Guide

This beta adds private OriginTrail DKG memory to an existing Buzz community.
It adopts the relay in place, creates or reuses a **Web of Trust** channel and
its Context Graph, and runs the integration as a separate sidecar. It does not
replace the relay, move its database, or enable on-chain publication.

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

A successful setup prints the managed channel ID and Context Graph ID. In a
Buzz client, connect to the community's normal public relay URL and join the
**Web of Trust** channel. Then test a thread with:

```text
@dkg distill
@dkg ask <a question answered by the distilled thread>
```

The smoke check performs the same real relay-to-DKG path with a synthetic
decision, verifies its Shared Working Memory receipt and citation, and confirms
that unsupported questions are refused. Verifiable Memory publication remains
disabled, so the beta does not spend gas or write on-chain.

## Operate or stop it

```bash
sudo buzz-dkg status
sudo buzz-dkg logs
sudo buzz-dkg smoke
sudo buzz-dkg remove
```

`remove` stops only the integration sidecar. It retains Buzz history, DKG
state, integration state, credentials, the channel, and the Context Graph.
Rerunning `install` converges on the managed objects instead of creating new
ones.

Configuration is stored in `/etc/buzz-dkg`; retained integration state is in
`/var/lib/buzz-dkg`. Treat both locations as sensitive and include them in the
host's protected backup policy.

## Beta acceptance checklist

- The existing relay remains healthy and clients use its unchanged public URL.
- `buzz-dkg status` reports the expected relay and DKG role/version.
- `buzz-dkg smoke` passes.
- A Buzz user can join **Web of Trust**, distill a thread, and ask a grounded
  question with a Context Graph citation.
- Restarting the host and rerunning `buzz-dkg install` do not create duplicate
  channels or graphs.
- `buzz-dkg remove` stops only the sidecar and leaves relay/DKG data intact.

When reporting a beta problem, include the command that failed, the non-secret
output of `sudo buzz-dkg status`, and relevant lines from `sudo buzz-dkg logs`.
Never share `/etc/buzz-dkg/runtime.env`, DKG `auth.token`, Nostr secret keys, or
private relay event data.
