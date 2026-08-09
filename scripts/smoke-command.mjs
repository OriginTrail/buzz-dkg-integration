/** Build the exact mention command understood by the configured daemon. */
export function askCommand(question, env = process.env) {
  const handle = String(env.BDI_MENTION_HANDLE || 'dkg').trim() || 'dkg';
  return `@${handle} ask ${question}`;
}

/** Decide whether the optional/full or required/targeted memory canary may run. */
export function agentMemoryCapability(relayInfo, required = false) {
  const enabled = agentMemorySchema(relayInfo) !== null;
  if (required && !enabled) {
    throw new Error('agent-memory-only smoke requires a relay advertising buzz-dkg-memory-v1');
  }
  return enabled;
}

/** Prefer profile-aware v2 only when both its extension and descriptor agree. */
export function agentMemorySchema(relayInfo) {
  const extensions = relayInfo?.supported_extensions;
  const descriptor = relayInfo?.dkg_memory;
  if (
    extensions?.includes('buzz-dkg-memory-v2') === true &&
    descriptor?.schema_versions?.includes(2) === true &&
    descriptor?.profiles?.includes('dkg-memory@1') === true
  ) {
    return 2;
  }
  return extensions?.includes('buzz-dkg-memory-v1') === true ? 1 : null;
}
