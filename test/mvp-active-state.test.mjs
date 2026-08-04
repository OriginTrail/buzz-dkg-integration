import { closeSync, mkdtempSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureActiveStateDirectory } from '../scripts/mvp-active-state.mjs';

function atomicWrite(path, content, mode) {
  const temp = join(dirname(path), '.active-state.tmp');
  const fd = openSync(temp, 'w', mode);
  writeFileSync(fd, content);
  closeSync(fd);
  renameSync(temp, path);
}

describe('M0 active state ownership', () => {
  it('refuses a second state directory for checkout-wide runtime resources', () => {
    const root = mkdtempSync(join(tmpdir(), 'bdi-active-state-'));
    const markerPath = join(root, 'active-state.json');
    const options = { markerPath, project: 'buzz-dkg-m0', repo: '/repo', atomicWrite };
    ensureActiveStateDirectory({ ...options, stateDir: '/state/a' });
    expect(() =>
      ensureActiveStateDirectory({ ...options, stateDir: '/state/b' }),
    ).toThrow(/bound to \/state\/a/);
  });
});
