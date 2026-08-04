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
