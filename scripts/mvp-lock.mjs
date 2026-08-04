import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

function statMaybe(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function atomicJson(path, value) {
  const temp = join(dirname(path), `.owner-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}

/** Testable, path-independent lifecycle lock with PID-reuse protection. */
export function createLifecycleLockManager(options) {
  const {
    lockDir,
    ownerPath,
    project,
    repo,
    pid = process.pid,
    processAlive,
    processIdentity,
    readRecovery = () => null,
    recover = () => false,
    now = () => new Date().toISOString(),
  } = options;

  function readOwner({ allowInvalid = false } = {}) {
    const lockStat = statMaybe(lockDir);
    const ownerStat = statMaybe(ownerPath);
    if (
      !lockStat?.isDirectory() ||
      lockStat.isSymbolicLink() ||
      !ownerStat?.isFile() ||
      ownerStat.isSymbolicLink()
    ) {
      if (allowInvalid) return null;
      throw new Error(`lifecycle lock has no valid owner record: ${ownerPath}`);
    }
    let owner;
    try {
      owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    } catch {
      if (allowInvalid) return null;
      throw new Error(`invalid lifecycle lock owner: ${ownerPath}`);
    }
    if (
      ![1, 2].includes(owner.version) ||
      owner.owner !== project ||
      owner.repo !== repo ||
      !Number.isInteger(owner.pid) ||
      owner.pid < 1
    ) {
      if (allowInvalid) return null;
      throw new Error('lifecycle lock does not belong to this checkout');
    }
    return owner;
  }

  function ownerIsLive(owner) {
    if (!owner || !processAlive(owner.pid)) return false;
    return owner.version === 1 || processIdentity(owner.pid) === owner.processIdentity;
  }

  function clearDirectory() {
    const entries = readdirSync(lockDir);
    const recoverable = (entry) => entry === 'owner.json' || /^\.owner-\d+-\d+\.tmp$/.test(entry);
    if (entries.some((entry) => !recoverable(entry))) {
      throw new Error(`refusing to clear lifecycle lock with unexpected contents: ${entries.join(', ')}`);
    }
    for (const entry of entries) {
      const path = join(lockDir, entry);
      const stat = statMaybe(path);
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        throw new Error(`refusing to clear unsafe lifecycle lock entry: ${entry}`);
      }
      unlinkSync(path);
    }
    rmdirSync(lockDir);
  }

  function assertRecoverySafe(staleOwner) {
    const recovery = readRecovery();
    if (!recovery) return;
    if (processAlive(recovery.ownerPid)) {
      throw new Error(`DKG recovery owner PID ${recovery.ownerPid} is still active`);
    }
    if (staleOwner && recovery.ownerPid !== staleOwner.pid) {
      throw new Error('stale lifecycle lock and DKG recovery record have different owners');
    }
    if (recovery.childPid !== null && processAlive(recovery.childPid)) {
      throw new Error(`DKG recovery child PID ${recovery.childPid} is still active`);
    }
  }

  function release(expected) {
    const current = readOwner();
    if (current.pid !== expected.pid || current.startedAt !== expected.startedAt) {
      throw new Error('lifecycle lock owner changed while it was being released');
    }
    clearDirectory();
  }

  function acquire(command) {
    if (existsSync(lockDir)) {
      const staleOwner = readOwner({ allowInvalid: true });
      if (ownerIsLive(staleOwner)) {
        throw new Error(
          `another buzz-dkg ${staleOwner.command || 'lifecycle command'} is active (PID ${staleOwner.pid})`,
        );
      }
      assertRecoverySafe(staleOwner);
      clearDirectory();
    }
    try {
      mkdirSync(lockDir, { mode: 0o700 });
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error('another buzz-dkg lifecycle command acquired the lock');
      throw error;
    }
    const owner = {
      version: 2,
      owner: project,
      repo,
      pid,
      command,
      startedAt: now(),
      processIdentity: processIdentity(pid),
    };
    try {
      atomicJson(ownerPath, owner);
    } catch (error) {
      rmdirSync(lockDir);
      throw error;
    }
    return () => release(owner);
  }

  function unlock() {
    if (!existsSync(lockDir)) {
      recover();
      return false;
    }
    const owner = readOwner({ allowInvalid: true });
    if (ownerIsLive(owner)) {
      throw new Error(`lifecycle lock owner PID ${owner.pid} is still active; unlock refused`);
    }
    assertRecoverySafe(owner);
    clearDirectory();
    recover();
    return true;
  }

  return { acquire, readOwner, unlock };
}
