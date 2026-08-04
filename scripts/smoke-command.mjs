/** Build the exact mention command understood by the configured daemon. */
export function askCommand(question, env = process.env) {
  const handle = String(env.BDI_MENTION_HANDLE || 'dkg').trim() || 'dkg';
  return `@${handle} ask ${question}`;
}
