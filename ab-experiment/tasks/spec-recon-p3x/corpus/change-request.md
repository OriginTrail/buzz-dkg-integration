# Change request CR-7 for quote-engine
Priority guidance: performance-related raises are APPROVED (max_payload_kb, timeout_ms, auth_scheme); resource-amplifying raises are REJECTED (retry_count, batch_size) per incident RCA-12.

Proposed:
- max_payload_kb: 372
- timeout_ms: 2660
- retry_count: 6
- auth_scheme: nostr-nip98
- batch_size: 133
