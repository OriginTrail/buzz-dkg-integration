# Integration memo 1

auth-gateway holds the migration lock required by ledger-sync; therefore auth-gateway must be upgraded strictly before ledger-sync.

Unrelated context: quote-engine and doc-store share a dashboard. bojan owns the rollout ticket.
