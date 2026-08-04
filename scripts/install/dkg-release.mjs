const reusableVersions = Object.freeze(['10.0.11', '10.0.12']);

export const DKG_RELEASE_POLICY = Object.freeze({
  managedVersion: '10.0.12',
  managedIntegrity:
    'sha512-AwUiqLXLLrUMuEN8maGSt5ijmAsgFsp2Ur4CZaHWlsxrHIHDk4QBbmQV7GyfD2LPZXknKIL8oIvlXYKxFhdJxA==',
  reusableVersions,
});

if (!DKG_RELEASE_POLICY.reusableVersions.includes(DKG_RELEASE_POLICY.managedVersion)) {
  throw new Error('managed DKG version must also be reusable');
}

export function assertManagedDkgPackageLock(lock, policy = DKG_RELEASE_POLICY) {
  const installed = lock?.packages?.['node_modules/@origintrail-official/dkg'];
  if (
    installed?.version !== policy.managedVersion ||
    installed?.integrity !== policy.managedIntegrity
  ) {
    throw new Error('managed DKG package lock does not match the pinned release integrity');
  }
}

export function assertManagedDkgRegistryMetadata(metadata, policy = DKG_RELEASE_POLICY) {
  if (
    metadata?.version !== policy.managedVersion ||
    metadata?.dist?.integrity !== policy.managedIntegrity
  ) {
    throw new Error('npm registry metadata does not match the pinned managed DKG release');
  }
}
