# Beta query gateway

The daemon can expose a loopback-only, read-only HTTP API for a trusted Buzz
authorization front. It is disabled by default. The V1a installer enables it
on `127.0.0.1:9296` and creates a separate 64-hex bearer token.

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

A same-host Buzz authorization front should use:

```dotenv
BUZZ_DKG_QUERY_URL=http://127.0.0.1:9296/v1/query
BUZZ_DKG_QUERY_TOKEN=<same secret as BDI_QUERY_GATEWAY_TOKEN>
```

The `deploy/existing-core` relay is bridge-networked, so its `127.0.0.1` is not
the host-networked daemon's loopback. That deployment intentionally does not
wire these `BUZZ_DKG_QUERY_*` variables into the relay.

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

| operation           | arguments    | result                                                                                                                        |
| ------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `channel_memory`    | `{}`         | `{ layers: { WM: null, SWM, VM }, decisions, contributors, subgraphs }`                                                       |
| `contributor_trail` | `{ pubkey }` | `{ pubkey, trail }`                                                                                                           |
| `subgraph_graph`    | `{ name }`   | `{ subgraph, nodes, edges }`                                                                                                  |
| `subgraph_triples`  | `{ name }`   | `{ subgraph, triples }`                                                                                                       |
| `evidence`          | `{ uri }`    | `{ found, claimId, name, status, trustState, memoryLayer, attribution, digest, asOf, sources, relations, receiptUal, graph }` |

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
