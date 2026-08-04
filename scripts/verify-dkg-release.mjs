#!/usr/bin/env node

import {
  assertManagedDkgRegistryMetadata,
  DKG_RELEASE_POLICY,
} from './install/dkg-release.mjs';

const packageName = '@origintrail-official/dkg';
const version = DKG_RELEASE_POLICY.managedVersion;
const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
const response = await fetch(registryUrl, { signal: AbortSignal.timeout(15_000) });
if (!response.ok) {
  throw new Error(`npm registry returned HTTP ${response.status} for ${packageName}@${version}`);
}
assertManagedDkgRegistryMetadata(await response.json());
console.log(`Verified ${packageName}@${version} against npm registry metadata.`);
