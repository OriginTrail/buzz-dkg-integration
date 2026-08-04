# Change request CR-7 for ledger-sync
Priority guidance: performance-related raises are APPROVED (max_payload_kb, timeout_ms, auth_scheme); resource-amplifying raises are REJECTED (retry_count, batch_size) per incident RCA-12.

Proposed:
- max_payload_kb: 316
- timeout_ms: 2509
- retry_count: 9
- auth_scheme: nostr-nip98
- batch_size: 153
