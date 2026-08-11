# Beta query and agent-memory gateway

The daemon can expose loopback-only query and agent-memory HTTP endpoints for a
trusted Buzz authorization front. They are disabled by default. The V1a
installer enables them on `127.0.0.1:9296` and creates a separate 64-hex bearer
token. The relay remains the public authorization boundary; clients never
receive this token or DKG credentials.

## Environment

```dotenv
BDI_QUERY_GATEWAY_ENABLED=true
BDI_QUERY_GATEWAY_BIND=127.0.0.1
BDI_QUERY_GATEWAY_PORT=9296
BDI_QUERY_GATEWAY_TOKEN=<32-to-512-character-secret>
```

Only literal `127.0.0.1` and `::1` binds are accepted. Optional bounded
settings are `BDI_QUERY_GATEWAY_MAX_BODY_BYTES`,
`BDI_QUERY_GATEWAY_MAX_RESULT_BYTES`, `BDI_QUERY_GATEWAY_MAX_QUERY_BYTES`,
`BDI_QUERY_GATEWAY_TIMEOUT_MS`, `BDI_QUERY_GATEWAY_DKG_TIMEOUT_MS`, and
`BDI_QUERY_GATEWAY_MAX_CONCURRENT`.

The installer uses a 120-second end-to-end gateway deadline. Individual DKG
lifecycle calls use a 180-second deadline. Memory submission returns HTTP `202`
after the signed envelope and operation intent are durably recorded; slow
finalize/share work continues on the crash-recoverable daemon queue rather than
holding the agent's HTTP request open.

A same-host Buzz authorization front should use:

```dotenv
BUZZ_DKG_QUERY_URL=http://127.0.0.1:9296/v1/query
BUZZ_DKG_QUERY_TOKEN=<same secret as BDI_QUERY_GATEWAY_TOKEN>
BUZZ_DKG_MEMORY_ENABLED=true
```

The relay derives the companion memory endpoint from that URL and forwards to
`/v1/memory` with the same token. `BUZZ_DKG_MEMORY_ENABLED` is deliberately
separate from query configuration: set it only when the integration supports
`/v1/memory`. A compatible relay advertises both `buzz-dkg-memory-v1` and
`buzz-dkg-memory-v2` through NIP-11, plus a `dkg_memory` descriptor containing
the supported schema versions, ontology profiles, adapter profiles, proposal
kind, and fixed query operations. Agents use v2 only when both the extension
and descriptor agree; v1 remains a compatibility path.

If an adopted relay remains on a Docker bridge, its `127.0.0.1` is not the
host-networked daemon's loopback. The query bridge supports two bounded
transports without weakening the gateway bind.

On hosts that allow container-to-host-gateway traffic, bind the bridge to the
Docker network's private host-gateway address and point the relay at it:

```dotenv
BDI_QUERY_BRIDGE_BIND=172.18.0.1
BDI_QUERY_BRIDGE_PORT=9297
BUZZ_DKG_QUERY_URL=http://172.18.0.1:9297/v1/query
```

The bridge binds only the explicit RFC1918 address, carries no credential, and
forwards opaque TCP to the loopback gateway. The relay still supplies the
dedicated bearer token and the gateway still enforces it. Discover the actual
gateway with `docker network inspect`; do not assume the example address.

On hosts whose firewall blocks that traffic, use a shared Unix socket and two
credential-free bridge processes. The host-networked process listens on the
socket and forwards to the gateway; the second process shares the relay's
network namespace, listens only on that namespace's loopback, and forwards to
the socket:

```dotenv
# host-networked bridge
BDI_QUERY_BRIDGE_LISTEN_SOCKET=/runtime/query-gateway.sock
BDI_QUERY_GATEWAY_PORT=9296

# bridge sharing the relay network namespace
BDI_QUERY_BRIDGE_BIND=127.0.0.1
BDI_QUERY_BRIDGE_PORT=9297
BDI_QUERY_BRIDGE_TARGET_SOCKET=/runtime/query-gateway.sock

# relay
BUZZ_DKG_QUERY_URL=http://127.0.0.1:9297/v1/query
BUZZ_DKG_MEMORY_ENABLED=true
```

Mount the same private runtime directory into both bridge processes and run
them as the runtime directory owner. The listener refuses to replace a
non-socket path and creates the socket with mode `0660`.

## Request contract

Send `POST /v1/query`, `Content-Type: application/json`, and
`Authorization: Bearer <token>`. The request object has exactly these fields:

```json
{
  "channelId": "channel-one",
  "operation": "channel_memory",
  "arguments": {},
  "requesterPubkey": "<64-hex-pubkey>"
}
```

The operation and its exact arguments are:

| operation               | arguments                                       | result                                                                                                                        |
| ----------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `channel_memory`        | `{}`                                            | `{ layers: { WM: null, SWM, VM }, decisions, contributors, subgraphs }`                                                       |
| `contributor_trail`     | `{ pubkey }`                                    | `{ pubkey, trail }`                                                                                                           |
| `software_contributors` | `{ repository, componentName, componentType? }` | `{ repository, componentName, componentType, contributors }`                                                                  |
| `decision_trace`        | `{ repository, commitSha, componentName }`      | `{ repository, commitSha, componentName, decisions }`                                                                         |
| `trust_network`         | `{}`                                            | `{ completeness, people, vouches }`, including signed source-event provenance and no aggregate trust score                    |
| `reputation_summary`    | `{ pubkey }`                                    | A channel-contextual score, confidence, four-part breakdown, reasons, signals, and bounded source evidence                     |
| `subgraph_graph`        | `{ name }`                                      | `{ subgraph, nodes, edges }`                                                                                                  |
| `subgraph_triples`      | `{ name }`                                      | `{ subgraph, triples }`                                                                                                       |
| `evidence`              | `{ uri }`                                       | `{ found, claimId, name, status, trustState, memoryLayer, attribution, digest, asOf, sources, relations, receiptUal, graph }` |

A successful response is:

```json
{
  "ok": true,
  "channelId": "channel-one",
  "cg": "did:dkg:otp/0xabc/42",
  "operation": "channel_memory",
  "result": {}
}
```

`cg` is returned for transparency but is always resolved from the daemon's
configured channel bindings. Requests cannot supply a Context Graph, DKG URL,
SPARQL, token, or write operation. Unknown fields are rejected. Retrieval is
limited to shared working memory and verifiable memory; working memory is never
queried and is represented as `null`.

Errors use `{ "ok": false, "error": { "code": "...", "message": "..." } }`.
Responses and structured audit logs never include gateway or DKG credentials or
raw upstream failures.

`repository` is a canonical HTTPS clone-page URL such as
`https://github.com/acme/api`. The relay and sidecar normalize GitHub casing,
an optional `.git` suffix, and trailing slashes. Requiring repository scope
prevents two unrelated projects' identically named functions from being
combined by a competency query.

## Agent-memory write contract

Only the relay calls `POST /v1/memory`. Its exact envelope contains a channel
UUID, authenticated requester pubkey, one fully signed kind-`40009` proposal,
and the fully signed source events referenced by that proposal. The sidecar
independently verifies every signature and ID, exact `h` channel tags, source
markers, requester/author equality, source-set equality, semantic bounds, and
that the agent authored at least one source. It does not trust the relay to
construct RDF.

Schema v2 always selects `dkg-memory@1` and may add `dkg-software@1` or
`dkg-trust@1`. The Buzz adapter attaches `buzz-nostr@1`; agents cannot select
it. The sidecar validates all profile types, relation predicates, literal
attributes, locators, and bounds before minting RDF identifiers. Direct edges
support ordinary SPARQL joins, while reified assertion nodes carry confidence
and signed evidence. Schema v1 still compiles through its unchanged legacy
graph path.

`dkg-trust@1` is a stricter human-action path, not an agent inference profile.
It accepts one channel-scoped NIP-32 kind-`1985` event in the `buzz.wot`
namespace, signed by the requester and naming exactly one `p`-tag subject. The
projected issuer, subject, explanation, active state, and channel scope must
match that source event exactly. Self-vouches and altered projections are
rejected. The graph therefore records contextual evidence that clients can
inspect; it deliberately does not mint a universal trust score.

### Contextual reputation lens

`reputation_summary` is a calculated, non-authoritative view over that evidence.
The channel is the context and the authenticated requester is the perspective.
The gateway first executes the same bounded SPARQL reads as `trust_network`
(maximum 200 people and 400 vouches across SWM and VM), then traverses the
returned graph in memory for at most two trust hops. No recursive SPARQL or
client-authored query is accepted.

Methodology `dkg-reputation-v1` returns four 0–100 dimensions:

- direct trust: 60 points for the requester's vouch plus 20 for each of at most
  two other independent issuers;
- network trust: 45 per distinct two-hop issuer and 15 per other independent
  community issuer;
- demonstrated work: 12.5 per attributed channel evidence record, capped at
  eight records;
- evidence diversity: bounded issuer, evidence-record, and verifiable-memory
  signals.

The displayed score is `35% direct + 25% network + 30% work + 10% diversity`.
Confidence is reported separately from the score, and every reason links back
to the bounded evidence set. This beta score is advisory: it never changes
relay membership, write access, moderation, or agent authorization.

For a valid proposal the sidecar deterministically creates or reuses that
channel's private Context Graph, compiles provenance-bearing RDF, writes Working
Memory, promotes it to Shared Working Memory, and records a terminal local
operation. The proposal event ID is the idempotency key, so retries do not
duplicate graph state. This beta performs no Verifiable Memory publication and
emits no relay chat event for the background write.

The normative beta profiles, SHACL shapes, lifelike fixture, and executable
competency queries ship in the installer under `ontology/`. The acceptance
suite proves queries including “who edited this function?” and “what decisions
behind this commit affected this component?” as well as non-software tasks and
cross-profile evidence traces.
