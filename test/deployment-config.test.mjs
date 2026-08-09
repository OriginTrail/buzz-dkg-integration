import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(new URL('..', import.meta.url).pathname);

describe('deployment artifacts', () => {
  it('includes every local Dockerfile COPY input in the build context', () => {
    const dockerfile = readFileSync(
      resolve(repo, 'deploy/existing-core/Dockerfile.integration'),
      'utf8',
    );
    const sources = [...dockerfile.matchAll(/^COPY\s+(\S+)\s+\S+$/gm)].map((match) => match[1]);
    expect(sources).toContain('scripts/bootstrap');
    for (const source of sources) expect(existsSync(resolve(repo, source))).toBe(true);
  });

  it.skipIf(spawnSync('docker', ['compose', 'version']).status !== 0)(
    'renders the default and tools Compose profiles',
    () => {
      const env = {
        ...process.env,
        BDI_RUNTIME_DIR: '/tmp/buzz-dkg-runtime',
        BDI_RUNTIME_UID: '1000',
        BDI_RUNTIME_GID: '1000',
        BDI_DKG_TOKEN_PATH: '/tmp/dkg-auth.token',
        BDI_BUZZ_HTTP: 'http://127.0.0.1:9440',
        BDI_BUZZ_WS: 'ws://127.0.0.1:9440',
        BDI_SERVICE_KEY: '1'.repeat(64),
        BDI_BUZZ_OWNER_KEY: '2'.repeat(64),
        BDI_SPIKE_RELAY_KEY: '4'.repeat(64),
        POSTGRES_PASSWORD: 'postgres-secret',
        REDIS_PASSWORD: 'redis-secret',
        BUZZ_S3_ACCESS_KEY: 'buzz-access',
        BUZZ_S3_SECRET_KEY: 'buzz-secret',
        BUZZ_RELAY_PRIVATE_KEY: '3'.repeat(64),
        BUZZ_DKG_APP_DIR: repo,
        BUZZ_DKG_STATE_DIR: '/tmp/buzz-dkg-v1a-state',
        BUZZ_DKG_RUNTIME_UID: '1000',
        BUZZ_DKG_RUNTIME_GID: '1000',
        BUZZ_DKG_RELAY_CONTAINER: 'buzz-relay-test',
      };
      for (const profileArgs of [[], ['--profile', 'tools']]) {
        const result = spawnSync(
          'docker',
          ['compose', ...profileArgs, '-f', 'deploy/existing-core/compose.yml', 'config'],
          { cwd: repo, env, encoding: 'utf8' },
        );
        expect(result.status, result.stderr).toBe(0);
      }
      const mvp = spawnSync('docker', ['compose', '-f', 'deploy/mvp/compose.yml', 'config'], {
        cwd: repo,
        env,
        encoding: 'utf8',
      });
      expect(mvp.status, mvp.stderr).toBe(0);

      for (const profileArgs of [[], ['--profile', 'tools'], ['--profile', 'bridge-relay']]) {
        const v1a = spawnSync(
          'docker',
          ['compose', ...profileArgs, '-f', 'deploy/v1a/compose.yml', 'config'],
          { cwd: repo, env, encoding: 'utf8' },
        );
        expect(v1a.status, v1a.stderr).toBe(0);
      }
      const bridgeServices = spawnSync(
        'docker',
        [
          'compose',
          '--profile',
          'bridge-relay',
          '-f',
          'deploy/v1a/compose.yml',
          'config',
          '--services',
        ],
        { cwd: repo, env, encoding: 'utf8' },
      );
      expect(bridgeServices.status, bridgeServices.stderr).toBe(0);
      expect(bridgeServices.stdout.split(/\s+/u)).toEqual(
        expect.arrayContaining(['daemon', 'host-query-bridge', 'relay-query-bridge']),
      );
    },
  );

  it.skipIf(spawnSync('docker', ['info']).status !== 0)(
    'builds the existing-relay integration image',
    () => {
      const result = spawnSync(
        'docker',
        [
          'build',
          '--tag',
          'buzz-dkg-integration:deployment-validation',
          '--file',
          'deploy/existing-core/Dockerfile.integration',
          '.',
        ],
        { cwd: repo, encoding: 'utf8', timeout: 120_000 },
      );
      expect(result.status, result.stderr).toBe(0);
      const smokeDependency = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--entrypoint',
          'test',
          'buzz-dkg-integration:deployment-validation',
          '-r',
          '/app/scripts/smoke-command.mjs',
        ],
        { cwd: repo, encoding: 'utf8', timeout: 30_000 },
      );
      expect(smokeDependency.status, smokeDependency.stderr).toBe(0);
    },
    125_000,
  );
});
