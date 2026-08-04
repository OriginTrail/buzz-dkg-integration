#!/usr/bin/env node

// Deployment-profile wrapper. Reconciliation is profile-neutral so V1a and
// existing-node deployments execute exactly the same convergence contract.
import { runExistingRelayBootstrap } from '../../scripts/bootstrap/existing-relay.mjs';

runExistingRelayBootstrap().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
  process.exitCode = 1;
});
