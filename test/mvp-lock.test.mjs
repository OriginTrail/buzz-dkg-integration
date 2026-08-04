import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLifecycleLockManager } from '../scripts/mvp-lock.mjs';

function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bdi-mvp-lock-'));
  const lockDir = join(root, 'lock');
  const ownerPath = join(lockDir, 'owner.json');
  const alive = new Set(overrides.alive || []);
  let recovery = overrides.recovery || null;
  let recovered = 0;
  const manager = createLifecycleLockManager({
    lockDir,
    ownerPath,
    project: 'buzz-dkg-m0',
    repo: '/repo',
    pid: 100,
    processAlive: (pid) => alive.has(pid),
    processIdentity: (pid) => `identity-${pid}`,
    readRecovery: () => recovery,
    recover: () => {
      recovered += 1;
      recovery = null;
    },
    now: () => '2026-08-04T00:00:00.000Z',
  });
  const writeOwner = (owner) => {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);
  };
  return { lockDir, ownerPath, manager, writeOwner, recovered: () => recovered };
}

describe('M0 lifecycle lock', () => {
  it('recovers an empty crash-window lock directory', () => {
    const f = fixture();
    mkdirSync(f.lockDir);
    const release = f.manager.acquire('up');
    expect(f.manager.readOwner()).toMatchObject({ pid: 100, command: 'up', version: 2 });
    release();
  });

  it('refuses a live owner and detects PID reuse by process identity', () => {
    const live = fixture({ alive: [42] });
    live.writeOwner({
      version: 2,
      owner: 'buzz-dkg-m0',
      repo: '/repo',
      pid: 42,
      command: 'up',
      startedAt: 'then',
      processIdentity: 'identity-42',
    });
    expect(() => live.manager.acquire('down')).toThrow(/PID 42/);

    const reused = fixture({ alive: [42] });
    reused.writeOwner({
      version: 2,
      owner: 'buzz-dkg-m0',
      repo: '/repo',
      pid: 42,
      command: 'up',
      startedAt: 'then',
      processIdentity: 'old-process',
    });
    const release = reused.manager.acquire('down');
    release();
  });

  it('refuses unlock while a recorded DKG child is alive', () => {
    const f = fixture({ alive: [77], recovery: { ownerPid: 41, childPid: 77 } });
    mkdirSync(f.lockDir);
    expect(() => f.manager.unlock()).toThrow(/child PID 77/);
  });

  it('clears a corrupt owner and runs recovery only after safety checks', () => {
    const f = fixture({ recovery: { ownerPid: 41, childPid: null } });
    mkdirSync(f.lockDir);
    writeFileSync(f.ownerPath, '{partial');
    expect(f.manager.unlock()).toBe(true);
    expect(f.recovered()).toBe(1);
  });

  it('clears a stale atomic-owner temp file but still rejects unknown entries', () => {
    const stale = fixture();
    mkdirSync(stale.lockDir);
    writeFileSync(join(stale.lockDir, '.owner-123-456.tmp'), '{"partial":true}\n');
    expect(stale.manager.unlock()).toBe(true);
    expect(existsSync(stale.lockDir)).toBe(false);

    const unsafe = fixture();
    mkdirSync(unsafe.lockDir);
    writeFileSync(join(unsafe.lockDir, 'foreign-file'), 'do not remove');
    expect(() => unsafe.manager.unlock()).toThrow(/unexpected contents/);
  });
});
