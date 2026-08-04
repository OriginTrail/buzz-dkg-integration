import { describe, expect, it } from 'vitest';
import { createInstallContext } from '../scripts/install/context.mjs';
import { resolveDkgPlan } from '../scripts/install/dkg-plan.mjs';
import { serializeRuntimeEnv } from '../scripts/install/runtime-env.mjs';

describe('installer services', () => {
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
      resolveDkgPlan({ existingStatus: { nodeRole: 'core' }, requestedRole: 'auto' }),
    ).toMatchObject({ dkgExisting: true, dkgRole: 'core', network: 'testnet' });
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
