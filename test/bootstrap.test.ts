import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '..');
const bootstrap = join(repo, 'install.sh');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'buzz-dkg-bootstrap-test-'));
  roots.push(root);
  return root;
}

function fixture(
  root: string,
  version = '0.1.0',
): { release: string; installRoot: string; binDir: string; ghLog: string } {
  const release = join(root, 'release');
  const payload = join(root, 'payload');
  const fakeBin = join(root, 'fake-bin');
  const installRoot = join(root, 'lib', 'buzz-dkg');
  const binDir = join(root, 'bin');
  const ghLog = join(root, 'gh-call.log');
  mkdirSync(join(payload, 'runtime', 'bin'), { recursive: true });
  mkdirSync(release, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });

  writeFileSync(join(payload, 'VERSION'), `${version}\n`);
  writeFileSync(join(payload, 'buzz-dkg'), '#!/bin/sh\nprintf "fixture-cli\\n"\n');
  writeFileSync(join(payload, 'runtime', 'bin', 'node'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(payload, 'buzz-dkg'), 0o755);
  chmodSync(join(payload, 'runtime', 'bin', 'node'), 0o755);

  const asset = join(release, 'buzz-dkg-linux-x64.tar.gz');
  const packed = spawnSync('tar', ['-czf', asset, '-C', payload, '.'], { encoding: 'utf8' });
  expect(packed.status, packed.stderr).toBe(0);
  const digest = createHash('sha256').update(readFileSync(asset)).digest('hex');
  writeFileSync(`${asset}.sha256`, `${digest}  buzz-dkg-linux-x64.tar.gz\n`);

  writeFileSync(
    join(fakeBin, 'uname'),
    '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; *) echo Linux;; esac\n',
  );
  chmodSync(join(fakeBin, 'uname'), 0o755);
  writeFileSync(
    join(fakeBin, 'gh'),
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$GH_CALL_LOG"\n[ "${GH_ATTESTATION_FAIL:-0}" != 1 ]\n',
  );
  chmodSync(join(fakeBin, 'gh'), 0o755);

  return { release, installRoot, binDir, ghLog };
}

function runBootstrap(paths: ReturnType<typeof fixture>, envOverrides: NodeJS.ProcessEnv = {}) {
  const testBootstrap = join(dirname(paths.release), 'install.test.sh');
  const source = readFileSync(bootstrap, 'utf8').replace(
    'release_base=https://github.com/$repo/releases/latest/download',
    `release_base=file://${paths.release}`,
  );
  writeFileSync(testBootstrap, source);
  return spawnSync('sh', [testBootstrap], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(dirname(paths.release), 'fake-bin')}:${process.env.PATH}`,
      BUZZ_DKG_INSTALL_ROOT: paths.installRoot,
      BUZZ_DKG_BIN_DIR: paths.binDir,
      BUZZ_DKG_SKIP_LAUNCH: '1',
      GH_CALL_LOG: paths.ghLog,
      ...envOverrides,
    },
  });
}

describe('one-line release bootstrap', () => {
  it('verifies and installs a versioned bundle, then leaves a reusable CLI', () => {
    const paths = fixture(tempRoot());
    const result = runBootstrap(paths);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Installed buzz-dkg 0.1.0');
    expect(result.stdout).toContain('Run: sudo buzz-dkg install');
    const attestationArgs = readFileSync(paths.ghLog, 'utf8').trim().split('\n');
    expect(attestationArgs).toEqual([
      'attestation',
      'verify',
      expect.stringMatching(/buzz-dkg-linux-x64\.tar\.gz$/),
      '--repo',
      'OriginTrail/buzz-dkg-integration',
    ]);

    const command = join(paths.binDir, 'buzz-dkg');
    expect(lstatSync(command).isSymbolicLink()).toBe(true);
    expect(readlinkSync(command)).toBe(join(paths.installRoot, 'current', 'buzz-dkg'));
    expect(existsSync(join(paths.installRoot, 'releases', '0.1.0', 'VERSION'))).toBe(true);

    const cli = spawnSync(command, [], { encoding: 'utf8' });
    expect(cli.status).toBe(0);
    expect(cli.stdout).toBe('fixture-cli\n');

    const rerun = runBootstrap(paths);
    expect(rerun.status, rerun.stderr).toBe(0);
  });

  it('fails closed when the release checksum does not match', () => {
    const paths = fixture(tempRoot());
    writeFileSync(
      join(paths.release, 'buzz-dkg-linux-x64.tar.gz.sha256'),
      `${'0'.repeat(64)}  buzz-dkg-linux-x64.tar.gz\n`,
    );
    const result = runBootstrap(paths);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('checksum verification failed');
    expect(existsSync(join(paths.binDir, 'buzz-dkg'))).toBe(false);
  });

  it('fails closed when GitHub provenance verification fails', () => {
    const paths = fixture(tempRoot());
    const result = runBootstrap(paths, { GH_ATTESTATION_FAIL: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('release provenance verification failed');
    expect(readFileSync(paths.ghLog, 'utf8')).toContain('attestation\nverify\n');
    expect(existsSync(join(paths.binDir, 'buzz-dkg'))).toBe(false);
    expect(existsSync(join(paths.installRoot, 'releases'))).toBe(false);
  });

  it('does not overwrite an unrelated command', () => {
    const paths = fixture(tempRoot());
    mkdirSync(paths.binDir, { recursive: true });
    writeFileSync(join(paths.binDir, 'buzz-dkg'), 'operator-owned\n');
    const result = runBootstrap(paths);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('is not a symlink');
    expect(readFileSync(join(paths.binDir, 'buzz-dkg'), 'utf8')).toBe('operator-owned\n');
  });

  it('rejects archive symlinks before root extraction', () => {
    const root = tempRoot();
    const paths = fixture(root);
    const payload = join(root, 'linked-payload');
    mkdirSync(payload, { recursive: true });
    symlinkSync('/etc', join(payload, 'escape'));
    const asset = join(paths.release, 'buzz-dkg-linux-x64.tar.gz');
    const packed = spawnSync('tar', ['-czf', asset, '-C', payload, '.'], { encoding: 'utf8' });
    expect(packed.status, packed.stderr).toBe(0);
    const digest = createHash('sha256').update(readFileSync(asset)).digest('hex');
    writeFileSync(`${asset}.sha256`, `${digest}  buzz-dkg-linux-x64.tar.gz\n`);
    const result = runBootstrap(paths);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unsafe path or entry type');
  });
});
