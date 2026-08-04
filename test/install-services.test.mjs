import { describe, expect, it } from 'vitest';
import { createInstallContext } from '../scripts/install/context.mjs';
import {
  assertManagedDkgPackageLock,
  assertManagedDkgRegistryMetadata,
  DKG_RELEASE_POLICY,
} from '../scripts/install/dkg-release.mjs';
import { resolveDkgPlan } from '../scripts/install/dkg-plan.mjs';
import { serializeRuntimeEnv } from '../scripts/install/runtime-env.mjs';

describe('installer services', () => {
  it('validates the exact published managed DKG version and integrity', () => {
    // Independent oracle recorded from:
    // npm view @origintrail-official/dkg@10.0.12 version dist.integrity --json
    const published = {
      version: '10.0.12',
      integrity:
        'sha512-AwUiqLXLLrUMuEN8maGSt5ijmAsgFsp2Ur4CZaHWlsxrHIHDk4QBbmQV7GyfD2LPZXknKIL8oIvlXYKxFhdJxA==',
    };
    expect(DKG_RELEASE_POLICY.reusableVersions).toContain(DKG_RELEASE_POLICY.managedVersion);
    expect(DKG_RELEASE_POLICY).toMatchObject({
      managedVersion: published.version,
      managedIntegrity: published.integrity,
    });

    const packageLock = {
      packages: {
        'node_modules/@origintrail-official/dkg': published,
      },
    };
    expect(() => assertManagedDkgPackageLock(packageLock)).not.toThrow();
    expect(() =>
      assertManagedDkgPackageLock({
        packages: {
          'node_modules/@origintrail-official/dkg': {
            ...published,
            integrity: 'sha512-not-the-published-integrity',
          },
        },
      }),
    ).toThrow(/does not match the pinned release integrity/);

    expect(() =>
      assertManagedDkgRegistryMetadata({
        version: published.version,
        dist: { integrity: published.integrity },
      }),
    ).not.toThrow();
    expect(() =>
      assertManagedDkgRegistryMetadata({
        version: published.version,
        dist: { integrity: 'sha512-not-the-published-integrity' },
      }),
    ).toThrow(/registry metadata does not match/);
  });

  it('builds paths from an explicit install context', () => {
    const context = createInstallContext({
      BUZZ_DKG_CONFIG_DIR: '/config',
      BUZZ_DKG_STATE_DIR: '/state',
    });
    expect(context).toMatchObject({
      configDir: '/config',
      stateDir: '/state',
      envPath: '/config/runtime.env',
      managedDkgHome: '/state/dkg',
    });
  });

  it('serializes the stable runtime contract and rejects line injection', () => {
    const values = new Proxy(
      { BDI_PUBLISH_MODE: 'disabled', BDI_MAX_PUBLISHES_PER_DAY: '0' },
      { get: (target, name) => target[name] || '' },
    );
    expect(serializeRuntimeEnv(values)).toContain('BDI_PUBLISH_MODE=disabled\n');
    expect(() =>
      serializeRuntimeEnv({ ...values, BDI_CHANNEL_NAME: 'bad\nINJECTED=value' }),
    ).toThrow(/contains a newline/);
  });

  it('resolves reuse and fresh DKG plans without process environment state', () => {
    expect(
      resolveDkgPlan({
        existingStatus: { nodeRole: 'core', version: '10.0.11', networkId: 'testnet' },
        requestedRole: 'auto',
      }),
    ).toMatchObject({ dkgExisting: true, dkgRole: 'core', network: 'testnet' });
    expect(
      resolveDkgPlan({
        existingStatus: { nodeRole: 'edge', version: '10.0.12', networkId: 'testnet' },
        requestedRole: 'auto',
      }),
    ).toMatchObject({ dkgExisting: true, dkgRole: 'edge', network: 'testnet' });
    expect(() =>
      resolveDkgPlan({ requestedRole: 'edge', unattended: true }),
    ).toThrow(/requires --dkg-network/);
    expect(
      resolveDkgPlan({
        requestedRole: 'auto',
        requestedNetwork: 'testnet',
        unattended: true,
      }),
    ).toMatchObject({ dkgExisting: false, dkgRole: 'edge', network: 'testnet' });
  });
});
