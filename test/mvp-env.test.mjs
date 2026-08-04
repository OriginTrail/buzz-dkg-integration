import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildBaseMvpEnvironments,
  buildCredentialedMvpEnvironments,
} from '../scripts/mvp-env.mjs';
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

function input() {
  return {
    base: {
      host: {
        processEnv: {
          PATH: '/bin',
          BDI_PUBLISH_MODE: 'mainnet',
          BDI_DKG_TOKEN: 'ambient-production-token',
          DKG_HOME: '/production/dkg',
          DEVNET_NO_AUTH: '1',
        },
        nodePath: '/shim:/bin',
        project: 'test',
        stateDir: '/state',
        dkgRepo: '/dkg',
      },
      dkg: {
        dkgDevnetDir: '/state/dkg',
        dkgDockerPrefix: 'test-dkg',
        dkgNodes: 6,
      },
    },
    integration: {
      processEnv: { BDI_LOG_LEVEL: 'debug' },
      dkgTokenPath: '/state/dkg/auth.token',
      bindingsPath: '/state/bindings.json',
      daemonDbPath: '/state/daemon.db',
      buzzHttp: 'http://127.0.0.1:9440',
      buzzWs: 'ws://127.0.0.1:9440',
      dkgApi: 'http://127.0.0.1:9420',
      buzzCli: '/opt/buzz/bin/buzz',
    },
    secrets,
  };
}

function environments() {
  return buildCredentialedMvpEnvironments(input());
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
    expect(env.bootstrap.BDI_DKG_TOKEN).toBeUndefined();
    expect(env.daemon.BDI_DKG_TOKEN).toBeUndefined();
    expect(env.daemon.DKG_HOME).toBeUndefined();
    expect(env.dkg.DEVNET_NO_AUTH).toBeUndefined();
    expect(env.bootstrap.BDI_DKG_TOKEN_PATH).toBe('/state/dkg/auth.token');
  });

  it('has an explicit non-credentialed environment contract', () => {
    const env = buildBaseMvpEnvironments(input().base);
    expect(Object.keys(env).sort()).toEqual(['base', 'dkg']);
    expect(env.base.BDI_DKG_TOKEN).toBeUndefined();
    expect(env.dkg.BDI_DKG_TOKEN_PATH).toBeUndefined();
  });

  it('carries an explicitly preflighted Buzz CLI into bootstrap only', () => {
    const env = environments();
    expect(env.bootstrap.BDI_BUZZ_CLI).toBe('/opt/buzz/bin/buzz');
    expect(env.base.BDI_BUZZ_CLI).toBeUndefined();
    expect(env.dkg.BDI_BUZZ_CLI).toBeUndefined();
    expect(env.daemon.BDI_BUZZ_CLI).toBeUndefined();
  });

  it('rejects missing and non-zero Buzz CLI executables', () => {
    expect(() => assertBuzzCliPrerequisite('/definitely/missing/buzz')).toThrow(/Buzz CLI not found/);
    expect(() => assertBuzzCliPrerequisite('/bin/false')).toThrow(/Buzz CLI not found/);
  });

  it('runs the up preflight before creating lifecycle state', () => {
    const root = mkdtempSync(join(tmpdir(), 'buzz-dkg-preflight-'));
    const stateDir = join(root, 'state');
    try {
      const result = spawnSync(process.execPath, ['scripts/mvp.mjs', 'up'], {
        cwd: new URL('..', import.meta.url),
        env: {
          ...process.env,
          BDI_BUZZ_CLI: join(root, 'missing-buzz'),
          BDI_MVP_STATE_DIR: stateDir,
        },
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Buzz CLI not found/);
      expect(existsSync(stateDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
