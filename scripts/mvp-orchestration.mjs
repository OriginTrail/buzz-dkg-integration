/**
 * Cross-component phase boundary: all fallible local DKG preparation completes
 * before Compose is allowed to mutate the host.
 */
export async function startBuzzDependencies({ prepareDkg, startBuzz, waitForBuzz }) {
  prepareDkg();
  startBuzz();
  await waitForBuzz();
}
