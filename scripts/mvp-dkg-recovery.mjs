import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

function atomicWrite(path, content, mode) {
  const temp = join(dirname(path), `.${process.pid}-${Date.now()}.tmp`);
  const fd = openSync(temp, 'wx', mode);
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

function lstatMaybe(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function redactDevnetLine(line) {
  return line
    .replace(/(Shared devnet auth token:\s*)\S+/u, '$1<redacted>')
    .replace(/(Auth token:\s*)\S+/u, '$1<redacted>')
    .replace(/(Authorization: Bearer\s+)[^'"\s]+/gu, '$1<redacted>');
}

/**
 * Own the complete snapshot → child record → restore transaction for the one
 * tracked artifact the upstream devnet rewrites in a sibling checkout.
 */
export function createDkgDeploymentRecovery(options) {
  const {
    deploymentPath,
    backupPath,
    metadataPath,
    dkgRepo,
    dkgNodes,
    processAlive,
    assertStateOwnership,
    assertControlOwnership,
    ownerPid = process.pid,
    spawnImpl = spawn,
    stdout = process.stdout,
    stderr = process.stderr,
    log = (message) => console.log(message),
  } = options;

  function snapshotFile() {
    if (!existsSync(deploymentPath)) return { existed: false };
    const fileStat = lstatSync(deploymentPath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error(`refusing to replace non-regular DKG deployment path: ${deploymentPath}`);
    }
    return {
      existed: true,
      contents: readFileSync(deploymentPath),
      mode: fileStat.mode & 0o777,
    };
  }

  function restoreFile(snapshot) {
    if (snapshot.existed) {
      atomicWrite(deploymentPath, snapshot.contents, snapshot.mode);
      return;
    }
    if (!existsSync(deploymentPath)) return;
    const fileStat = lstatSync(deploymentPath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error(`refusing to remove non-regular generated DKG deployment path: ${deploymentPath}`);
    }
    unlinkSync(deploymentPath);
  }

  function readMetadata() {
    assertControlOwnership();
    const metaStat = lstatMaybe(metadataPath);
    if (!metaStat) return null;
    if (!metaStat.isFile() || metaStat.isSymbolicLink()) {
      throw new Error(`invalid DKG deployment recovery metadata: ${metadataPath}`);
    }
    let meta;
    try {
      meta = JSON.parse(readFileSync(metadataPath, 'utf8'));
    } catch {
      throw new Error(`invalid DKG deployment recovery metadata: ${metadataPath}`);
    }
    if (
      meta.version !== 2 ||
      meta.path !== deploymentPath ||
      typeof meta.existed !== 'boolean' ||
      !Number.isInteger(meta.ownerPid) ||
      meta.ownerPid < 1 ||
      !(meta.childPid === null || (Number.isInteger(meta.childPid) && meta.childPid > 0))
    ) {
      throw new Error('DKG deployment recovery metadata does not match this checkout');
    }
    return meta;
  }

  function persistSnapshot() {
    assertStateOwnership();
    assertControlOwnership();
    if (existsSync(metadataPath)) {
      throw new Error(`pending DKG deployment recovery exists at ${metadataPath}`);
    }
    const snapshot = snapshotFile();
    let sha256 = null;
    if (snapshot.existed) {
      sha256 = createHash('sha256').update(snapshot.contents).digest('hex');
      atomicWrite(backupPath, snapshot.contents, 0o600);
    }
    atomicWrite(
      metadataPath,
      `${JSON.stringify({
        version: 2,
        path: deploymentPath,
        existed: snapshot.existed,
        mode: snapshot.mode ?? null,
        sha256,
        ownerPid,
        childPid: null,
      })}\n`,
      0o600,
    );
  }

  function recordChild(childPid) {
    const meta = readMetadata();
    if (!meta || meta.ownerPid !== ownerPid || meta.childPid !== null) {
      throw new Error('cannot attach the DKG devnet child to its recovery record');
    }
    atomicWrite(metadataPath, `${JSON.stringify({ ...meta, childPid })}\n`, 0o600);
  }

  function recover(options = {}) {
    const meta = readMetadata();
    if (!meta) return false;
    assertStateOwnership();
    const currentOwner = options.currentOwner === true && meta.ownerPid === ownerPid;
    if (!currentOwner && processAlive(meta.ownerPid)) {
      throw new Error(`DKG deployment snapshot belongs to active launcher PID ${meta.ownerPid}; recovery refused`);
    }
    if (meta.childPid === null && !currentOwner) {
      throw new Error('stale DKG recovery has no recorded devnet child PID; recovery is indeterminate and refused');
    }
    const childConfirmedDead =
      options.completedChildPid !== undefined && options.completedChildPid === meta.childPid;
    if (meta.childPid !== null && !childConfirmedDead && processAlive(meta.childPid)) {
      throw new Error(`DKG deployment snapshot belongs to active devnet child PID ${meta.childPid}; recovery refused`);
    }
    let snapshot = { existed: false };
    if (meta.existed) {
      const backupStat = lstatMaybe(backupPath);
      if (!backupStat?.isFile() || backupStat.isSymbolicLink()) {
        throw new Error('DKG deployment recovery backup is missing or unsafe');
      }
      const contents = readFileSync(backupPath);
      const digest = createHash('sha256').update(contents).digest('hex');
      if (digest !== meta.sha256 || !Number.isInteger(meta.mode)) {
        throw new Error('DKG deployment recovery backup failed integrity validation');
      }
      snapshot = { existed: true, contents, mode: meta.mode };
    }
    restoreFile(snapshot);
    unlinkSync(metadataPath);
    if (existsSync(backupPath)) unlinkSync(backupPath);
    log('[buzz-dkg] restored the sibling DKG checkout deployment artifact');
    return true;
  }

  async function runDevnetStart(env) {
    persistSnapshot();
    let completedChildPid;
    try {
      await new Promise((resolveRun, rejectRun) => {
        const child = spawnImpl(join(dkgRepo, 'scripts', 'devnet.sh'), ['start', String(dkgNodes)], {
          cwd: dkgRepo,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (child.pid) recordChild(child.pid);
        const forward = (source, destination) => {
          let buffered = '';
          source.setEncoding('utf8');
          source.on('data', (chunk) => {
            buffered += chunk;
            const lines = buffered.split('\n');
            buffered = lines.pop() || '';
            for (const line of lines) destination.write(`${redactDevnetLine(line)}\n`);
          });
          source.on('end', () => {
            if (buffered) destination.write(redactDevnetLine(buffered));
          });
        };
        forward(child.stdout, stdout);
        forward(child.stderr, stderr);
        child.once('error', (error) => rejectRun(new Error(`could not start DKG devnet: ${error.message}`)));
        child.once('close', (code, signal) => {
          completedChildPid = child.pid;
          if (code === 0) resolveRun();
          else rejectRun(new Error(`DKG devnet exited with ${signal ? `signal ${signal}` : `status ${code ?? 'unknown'}`}`));
        });
      });
    } finally {
      recover({ currentOwner: true, completedChildPid });
    }
  }

  return { readMetadata, persistSnapshot, recordChild, recover, runDevnetStart };
}
