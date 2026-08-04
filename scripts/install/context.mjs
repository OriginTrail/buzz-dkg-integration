import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export function createInstallContext(env = process.env) {
  const appDir = fileURLToPath(new URL('../..', import.meta.url));
  const configDir = env.BUZZ_DKG_CONFIG_DIR || '/etc/buzz-dkg';
  const stateDir = env.BUZZ_DKG_STATE_DIR || '/var/lib/buzz-dkg';
  const managedDkgRoot = join(stateDir, 'dkg-cli');
  const managedDkgHome = join(stateDir, 'dkg');
  return Object.freeze({
    env,
    appDir,
    configDir,
    stateDir,
    envPath: join(configDir, 'runtime.env'),
    composePath: join(appDir, 'deploy', 'v1a', 'compose.yml'),
    managedDkgRoot,
    managedDkgHome,
    managedDkgBin: join(managedDkgRoot, 'node_modules', '.bin', 'dkg'),
    invokingHome: homedir(),
  });
}
