# Gate D1 grounded dry-run transcript

Date: 2026-07-26T10:54:59.178Z. Node: okf-mainnet 127.0.0.1:9200 (Base mainnet). Graph scope for ALL retrieval: `0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026`. Mode: no-post (no Buzz client imported; zero relay traffic). Bearer token redacted.

## FIFA-supported #1

Q: what was the result of Argentina vs Austria?

Result: **ANSWER**

Answer text (extractive, deterministic, no model):

> Result: Argentina 2-0 Austria [1]

Evidence records (citations, resolved in their own scoped view before acceptance):
- `urn:wc2026:result:537399` (verifiable-memory) — Result: Argentina 2-0 Austria
- `urn:wc2026:result:537401` (verifiable-memory) — Result: Jordan 1-3 Argentina
- `urn:wc2026:result:537427` (verifiable-memory) — Result: Argentina 3-2 Cape Verde Islands

Queries issued for this question (5):
- view=`verifiable-memory` cg=`0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026` — `SELECT ?root ?name ?desc ?digest WHERE { ?root <http://schema.org/name> ?name . OPTIONAL { ?root <http://schema.org/description> ?desc } OPTIONAL { ?root <https://w3id.org/buzz-dkg/buzz#sourceSetDigest> ?digest } BIND(CO`
- view=`shared-working-memory` cg=`0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026` — `SELECT ?root ?name ?desc ?digest WHERE { ?root <http://schema.org/name> ?name . OPTIONAL { ?root <http://schema.org/description> ?desc } OPTIONAL { ?root <https://w3id.org/buzz-dkg/buzz#sourceSetDigest> ?digest } BIND(CO`
- view=`verifiable-memory` cg=`0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026` — `ASK { <urn:wc2026:result:537399> ?p ?o }`
- view=`verifiable-memory` cg=`0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026` — `ASK { <urn:wc2026:result:537401> ?p ?o }`
- view=`verifiable-memory` cg=`0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026` — `ASK { <urn:wc2026:result:537427> ?p ?o }`

## FIFA-supported #2

Q: which teams played in the FIFA World Cup tournament?

Result: **ANSWER**

Answer text (extractive, deterministic, no model):

> FIFA World Cup [1]

Evidence records (citations, resolved in their own scoped view before acceptance):
- `urn:wc2026:tournament:2000` (verifiable-memory) — FIFA World Cup
- `urn:wc2026:player:38101` (shared-working-memory) — Norwegian striker; Norway all-time top scorer (62 goals / 54 caps, senior debut 2019-09-05

Queries issued for this question (4):
- view=`verifiable-memory` cg=`0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026` — `SELECT ?root ?name ?desc ?digest WHERE { ?root <http://schema.org/name> ?name . OPTIONAL { ?root <http://schema.org/description> ?desc } OPTIONAL { ?root <https://w3id.org/buzz-dkg/buzz#sourceSetDigest> ?digest } BIND(CO`
- view=`shared-working-memory` cg=`0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026` — `SELECT ?root ?name ?desc ?digest WHERE { ?root <http://schema.org/name> ?name . OPTIONAL { ?root <http://schema.org/description> ?desc } OPTIONAL { ?root <https://w3id.org/buzz-dkg/buzz#sourceSetDigest> ?digest } BIND(CO`
- view=`verifiable-memory` cg=`0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026` — `ASK { <urn:wc2026:tournament:2000> ?p ?o }`
- view=`shared-working-memory` cg=`0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026` — `ASK { <urn:wc2026:player:38101> ?p ?o }`

## Unrelated (must refuse)

Q: what is the office wifi password?

Result: **REFUSAL**

The pipeline refused before any generation (insufficient scoped evidence).

Queries issued for this question (4):
- view=`verifiable-memory` cg=`0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026` — `SELECT ?root ?name ?desc ?digest WHERE { ?root <http://schema.org/name> ?name . OPTIONAL { ?root <http://schema.org/description> ?desc } OPTIONAL { ?root <https://w3id.org/buzz-dkg/buzz#sourceSetDigest> ?digest } BIND(CO`
- view=`shared-working-memory` cg=`0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026` — `SELECT ?root ?name ?desc ?digest WHERE { ?root <http://schema.org/name> ?name . OPTIONAL { ?root <http://schema.org/description> ?desc } OPTIONAL { ?root <https://w3id.org/buzz-dkg/buzz#sourceSetDigest> ?digest } BIND(CO`
- view=`verifiable-memory` cg=`0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026` — `SELECT ?root ?name ?desc ?digest WHERE { ?root <http://schema.org/name> ?name . OPTIONAL { ?root <http://schema.org/description> ?desc } OPTIONAL { ?root <https://w3id.org/buzz-dkg/buzz#sourceSetDigest> ?digest } BIND(CO`
- view=`shared-working-memory` cg=`0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026` — `SELECT ?root ?name ?desc ?digest WHERE { ?root <http://schema.org/name> ?name . OPTIONAL { ?root <http://schema.org/description> ?desc } OPTIONAL { ?root <https://w3id.org/buzz-dkg/buzz#sourceSetDigest> ?digest } BIND(CO`

## Scope proof

Total queries: 13. Distinct contextGraphId values queried: `0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/fifa-world-cup-2026` — exactly the designated graph, nothing else ✔.
Server-side enforcement note: /api/query rejects caller FROM clauses and out-of-scope GRAPH patterns with 400 (Gate A verified).
Buzz proof: this script imports no relay client; no Buzz events were created.
