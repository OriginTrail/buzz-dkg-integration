import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDkgDeploymentRecovery } from '../scripts/mvp-dkg-recovery.mjs';

describe('DKG checkout artifact recovery', () => {
  it('restores exact bytes and mode after devnet startup fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bdi-dkg-recovery-'));
    const dkgRepo = join(root, 'dkg');
    const scriptsDir = join(dkgRepo, 'scripts');
    const deploymentPath = join(root, 'localhost_contracts.json');
    const backupPath = join(root, 'deployment.backup');
    const metadataPath = join(root, 'deployment.backup.json');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(deploymentPath, '{"original":true}\n', { mode: 0o640 });
    writeFileSync(
      join(scriptsDir, 'devnet.sh'),
      '#!/bin/sh\nprintf \'changed\\n\' > "$DEPLOYMENT_PATH"\nchmod 600 "$DEPLOYMENT_PATH"\nexit 7\n',
    );
    chmodSync(join(scriptsDir, 'devnet.sh'), 0o755);
    const recovery = createDkgDeploymentRecovery({
      deploymentPath,
      backupPath,
      metadataPath,
      dkgRepo,
      dkgNodes: 1,
      processAlive: () => false,
      assertStateOwnership: () => {},
      assertControlOwnership: () => {},
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      log: () => {},
    });

    try {
      await expect(
        recovery.runDevnetStart({ ...process.env, DEPLOYMENT_PATH: deploymentPath }),
      ).rejects.toThrow(/status 7/);
      expect(readFileSync(deploymentPath, 'utf8')).toBe('{"original":true}\n');
      expect(statSync(deploymentPath).mode & 0o777).toBe(0o640);
      expect(existsSync(metadataPath)).toBe(false);
      expect(existsSync(backupPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
