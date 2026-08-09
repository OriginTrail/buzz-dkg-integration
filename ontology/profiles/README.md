# DKG semantic memory profiles

Status: beta specification, version 1

This directory defines the ontology profiles used by agent-authored semantic
memory. A profile is a versioned set of allowed RDF classes and properties; it
is not a classification of the whole conversation. Every proposal uses the
general `dkg-memory@1` profile and may add domain or adapter profiles.

The profiles deliberately reuse the DKG v10 coding-project namespaces and URI
conventions. In particular, `code:`, `github:`, `decisions:`, `tasks:`, and the
`urn:dkg:code:*` / `urn:dkg:github:*` identifiers match the canonical DKG
coding-project ontology and code-graph convergence ADR. This integration must
not introduce a parallel `buzz-code:` namespace.

## Profile composition

| Profile | Selected by | Purpose |
| --- | --- | --- |
| `dkg-memory@1` | Always | General decisions, claims, questions, tasks, relationships, evidence, and provenance |
| `dkg-software@1` | Agent when software evidence is present | Repositories, commits, pull requests, issues, packages, files, symbols, builds, tests, and deployments |
| `buzz-nostr@1` | Buzz integration, never the LLM | Buzz channel and signed Nostr source-event provenance |

Profiles are additive. A coding agent discussing an event or assigning a task
can emit only general terms. A turn that connects an architectural decision to
a commit uses both general and software terms. Unknown domain concepts fall
back to `memory:Entity`; agents must not invent namespace IRIs.

## Namespaces

```text
memory:    http://dkg.io/ontology/memory/
code:      http://dkg.io/ontology/code/
github:    http://dkg.io/ontology/github/
decisions: http://dkg.io/ontology/decisions/
tasks:     http://dkg.io/ontology/tasks/
agent:     http://dkg.io/ontology/agent/
buzz:      https://w3id.org/buzz-dkg/buzz#
nostr:     https://w3id.org/buzz-dkg/nostr#
```

External terms come from RDF/RDFS/OWL/XSD, Schema.org, PROV-O, Dublin Core,
SKOS, DOAP, and SPDX. External vocabularies are reused rather than copied.

## Proposal schema v2

Schema v2 separates entity recognition from relationships. The agent emits
compact local identifiers; the trusted integration validates every type and
predicate and deterministically mints RDF identifiers.

```json
{
  "schemaVersion": 2,
  "profiles": ["dkg-memory@1", "dkg-software@1"],
  "summary": "Short-lived JWT access tokens were implemented in the auth gateway",
  "entities": [
    {
      "id": "auth-gateway",
      "type": "code:Package",
      "name": "Authentication gateway",
      "locator": {
        "kind": "code",
        "repository": "acme/api",
        "path": "packages/auth"
      }
    },
    {
      "id": "verify-token",
      "type": "code:Function",
      "name": "verifyToken",
      "locator": {
        "kind": "code",
        "repository": "acme/api",
        "commit": "a1b2c3d4",
        "path": "packages/auth/src/token.ts",
        "symbol": "verifyToken",
        "symbolKind": "function"
      }
    },
    {
      "id": "jwt-decision",
      "type": "decisions:Decision",
      "name": "Use short-lived JWT access tokens",
      "description": "Use 15-minute access tokens and rotate refresh tokens"
    },
    {
      "id": "commit-a1b2c3d4",
      "type": "github:Commit",
      "name": "Implement JWT rotation",
      "locator": {
        "kind": "github",
        "repository": "acme/api",
        "resource": "commit",
        "id": "a1b2c3d4"
      }
    }
  ],
  "relations": [
    {
      "subject": "commit-a1b2c3d4",
      "predicate": "github:affects",
      "object": "verify-token"
    },
    {
      "subject": "jwt-decision",
      "predicate": "decisions:implementedBy",
      "object": "commit-a1b2c3d4"
    },
    {
      "subject": "jwt-decision",
      "predicate": "decisions:affects",
      "object": "auth-gateway"
    }
  ],
  "model": "provider/model",
  "promptVersion": "agent-memory-v2"
}
```

### Bounds

- 1 to 3 profile identifiers; `dkg-memory@1` is required.
- 1 to 100 entities and 0 to 200 relations.
- Local IDs match `[a-z][a-z0-9-]{0,63}` and are unique.
- Types and predicates must be in the selected profiles' allowlists.
- Every relation endpoint must resolve to an entity in the proposal.
- An optional relation confidence is a decimal from 0 through 1.
- Text remains bounded by the existing 64 KiB proposal-event limit.
- No hidden reasoning, credentials, tool traces, or unsigned evidence enters
  the semantic payload.

## Deterministic identity

The compiler, not the LLM, owns identifiers.

| Locator | Canonical identifier |
| --- | --- |
| GitHub repository | `urn:dkg:github:repo:<owner>/<repo>` |
| Pull request | `urn:dkg:github:pr:<owner>/<repo>/<number>` |
| Issue | `urn:dkg:github:issue:<owner>/<repo>/<number>` |
| Commit | `urn:dkg:github:commit:<owner>/<repo>/<sha>` |
| Code package | `urn:dkg:code:package:<repository-or-package>` |
| Code file | `urn:dkg:code:file:<repository-or-package>/<encoded-path>` |
| Code symbol | canonical file identifier plus `#<kind>:<encoded-symbol>` |
| Explicit external URI | exact URI after scheme and profile validation |
| Local/general entity | `urn:buzz-dkg:entity:<source-set-digest>:<local-id>` |

Code paths identify the evolving logical file or symbol. A `github:Commit`
provides the immutable revision and links to affected entities through
`github:affects`. This matches existing DKG code-graph identity rather than
creating one function URI per commit.

## RDF compilation contract

For each accepted proposal the compiler:

1. Creates one `memory:Memory` root and one PROV activity.
2. Emits every proposal entity with its validated RDF type and `schema:name`.
3. Emits relations as direct RDF edges so ordinary SPARQL joins work.
4. Creates a `memory:Assertion` node for each relation so confidence and
   evidence can be attached without RDF-star support.
5. Links the root, entities, and assertion nodes to the exact signed Buzz
   events with `prov:wasDerivedFrom`.
6. Adds `buzz-nostr@1` event snapshots and proposing-agent attribution.
7. Writes and promotes the complete Knowledge Asset through WM to SWM.

The direct edge is the query surface; the reified assertion is the evidence
surface.

## Competency questions

The profile is accepted only when executable tests answer these questions from
lifelike data:

1. Who edited a given function, through which commits, and when?
2. What decisions were implemented by a commit that affected a named component?
3. Which source messages and agent generated a decision?
4. What open tasks follow from a decision and who owns them?
5. Which tests support a commit or component change?
6. Can a non-software task/event be queried without using software terms?
7. Can a mixed general/software turn be queried across both profiles?
8. Can the same queries stay scoped to one Context Graph and SWM/VM view?

Executable SPARQL lives under `ontology/queries/`; fixtures and assertions live
in `test/ontology-competency.test.ts`.

## Profile negotiation

The relay advertises the capability and supported profile IDs in NIP-11. The
Buzz ACP harness supplies the compact v2 schema to agents only when the relay
advertises it. Community policy may restrict optional profiles. The agent may
choose among allowed domain profiles, but the Buzz adapter profile is attached
by the integration and is not agent-controlled.

Unsupported profiles or vocabulary terms reject the memory proposal without
retracting the agent's already-published chat response. Schema v1 remains
accepted and compiles through the legacy compatibility path.

