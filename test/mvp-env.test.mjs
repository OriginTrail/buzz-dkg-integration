import { describe, expect, it } from 'vitest';
import { buildMvpEnvironments } from '../scripts/mvp-env.mjs';
import { assertBuzzCliPrerequisite } from '../scripts/mvp.mjs';

const secrets = Object.fromEntries(
  [
    'POSTGRES_PASSWORD',
    'REDIS_PASSWORD',
    'BUZZ_S3_ACCESS_KEY',
    'BUZZ_S3_SECRET_KEY',
    'BDI_SPIKE_RELAY_KEY',
    'BDI_SPIKE_AUTHOR_KEY',
    'BDI_SPIKE_SERVICE_KEY',
    'BDI_SPIKE_PROMOTER_KEY',
  ].map((name) => [name, `value-${name}`]),
);

function environments() {
  return buildMvpEnvironments({
    processEnv: { PATH: '/bin', BDI_PUBLISH_MODE: 'mainnet' },
    nodePath: '/shim:/bin',
    project: 'test',
    stateDir: '/state',
    dkgRepo: '/dkg',
    dkgDevnetDir: '/state/dkg',
    dkgTokenPath: '/state/dkg/auth.token',
    bindingsPath: '/state/bindings.json',
    daemonDbPath: '/state/daemon.db',
    buzzHttp: 'http://127.0.0.1:9440',
    buzzWs: 'ws://127.0.0.1:9440',
    dkgApi: 'http://127.0.0.1:9420',
    dkgDockerPrefix: 'test-dkg',
    dkgNodes: 6,
    secrets,
  });
}

describe('M0 component environments', () => {
  it('hard-disables publication and preserves one DKG node count', () => {
    const env = environments();
    expect(env.dkg).toMatchObject({ DEVNET_ENABLE_PUBLISHER: '0', NUM_CORE_NODES: '6' });
    expect(env.daemon).toMatchObject({
      BDI_PUBLISH_MODE: 'disabled',
      BDI_MAX_PUBLISHES_PER_DAY: '0',
    });
  });

  it('does not leak daemon or relay credentials into the DKG environment', () => {
    const env = environments();
    expect(env.dkg.BDI_SERVICE_KEY).toBeUndefined();
    expect(env.dkg.POSTGRES_PASSWORD).toBeUndefined();
    expect(env.daemon.POSTGRES_PASSWORD).toBeUndefined();
    expect(env.compose.BDI_SERVICE_KEY).toBeUndefined();
  });

  it('fails the Buzz CLI preflight before lifecycle orchestration', () => {
    expect(() => assertBuzzCliPrerequisite('/definitely/missing/buzz')).toThrow(/Buzz CLI not found/);
  });
});
