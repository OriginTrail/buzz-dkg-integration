import { existsSync, readFileSync } from 'node:fs';

/** Bind checkout-wide Compose/DKG resources to exactly one state directory. */
export function ensureActiveStateDirectory({ markerPath, stateDir, project, repo, atomicWrite }) {
  if (!existsSync(markerPath)) {
    atomicWrite(
      markerPath,
      `${JSON.stringify({ version: 1, owner: project, repo, stateDir })}\n`,
      0o600,
    );
    return;
  }
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch {
    throw new Error(`invalid active M0 state marker: ${markerPath}`);
  }
  if (marker.version !== 1 || marker.owner !== project || marker.repo !== repo) {
    throw new Error(`active M0 state marker does not belong to this checkout: ${markerPath}`);
  }
  if (marker.stateDir !== stateDir) {
    throw new Error(
      `this checkout's M0 runtime is bound to ${marker.stateDir}; refusing state override ${stateDir}`,
    );
  }
}
