import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

/** Process ownership and supervision for the integration daemon only. */
export function createMvpDaemonManager(options) {
  const {
    repo,
    pidPath,
    logPath,
    bindingsPath,
    processAlive,
    run,
    atomicWrite,
    waitUntil,
    tailText,
    spawnImpl = spawn,
  } = options;

  function readPid() {
    if (!existsSync(pidPath)) return null;
    const raw = readFileSync(pidPath, 'utf8').trim();
    return /^\d+$/.test(raw) ? Number(raw) : null;
  }

  function daemonOwned(pid) {
    if (!processAlive(pid)) return false;
    const result = run('ps', ['-p', String(pid), '-o', 'command='], {
      capture: true,
      allowFailure: true,
    });
    return result.status === 0 && result.stdout.includes(join(repo, 'src', 'index.ts'));
  }

  async function start(env) {
    const existing = readPid();
    if (daemonOwned(existing)) {
      console.log(`[buzz-dkg] integration daemon already running (PID ${existing})`);
      return;
    }
    if (processAlive(existing)) {
      throw new Error(`daemon PID file points to unrelated live PID ${existing}; refusing to replace it`);
    }
    rmSync(pidPath, { force: true });
    if (!existsSync(bindingsPath)) throw new Error(`bootstrap did not create ${bindingsPath}`);
    const offset = existsSync(logPath) ? statSync(logPath).size : 0;
    const fd = openSync(logPath, 'a', 0o600);
    const child = spawnImpl(
      process.execPath,
      ['--experimental-strip-types', join(repo, 'src', 'index.ts')],
      { cwd: repo, env, detached: true, stdio: ['ignore', fd, fd] },
    );
    closeSync(fd);
    child.unref();
    if (!child.pid) throw new Error('integration daemon did not return a PID');
    atomicWrite(pidPath, `${child.pid}\n`, 0o600);
    await waitUntil(
      'integration daemon',
      () => {
        if (!processAlive(child.pid)) {
          const tail = tailText(logPath, 8).join('\n');
          throw new Error(`daemon exited during startup${tail ? `; see ${logPath}` : ''}`);
        }
        const appended = readFileSync(logPath, 'utf8').slice(offset);
        return appended.includes('"message":"daemon started"');
      },
      30_000,
      250,
    );
    console.log(`[buzz-dkg] integration daemon ready (PID ${child.pid}, publish mode disabled)`);
  }

  async function stop() {
    const pid = readPid();
    if (!pid) return;
    if (!processAlive(pid)) {
      rmSync(pidPath, { force: true });
      return;
    }
    if (!daemonOwned(pid)) throw new Error(`refusing to stop unrelated PID ${pid} from ${pidPath}`);
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 10_000;
    while (processAlive(pid) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    if (processAlive(pid) && daemonOwned(pid)) process.kill(pid, 'SIGKILL');
    rmSync(pidPath, { force: true });
  }

  return { readPid, daemonOwned, start, stop };
}
