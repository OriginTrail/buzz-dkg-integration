/** Build the exact mention command understood by the configured daemon. */
export function askCommand(question, env = process.env) {
  const handle = String(env.BDI_MENTION_HANDLE || 'dkg').trim() || 'dkg';
  return `@${handle} ask ${question}`;
}

/** Decide whether the optional/full or required/targeted memory canary may run. */
export function agentMemoryCapability(relayInfo, required = false) {
  const enabled = relayInfo?.supported_extensions?.includes('buzz-dkg-memory-v1') === true;
  if (required && !enabled) {
    throw new Error('agent-memory-only smoke requires a relay advertising buzz-dkg-memory-v1');
  }
  return enabled;
}
