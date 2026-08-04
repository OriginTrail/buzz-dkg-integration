const REQUIRED_SECRET_NAMES = [
  'POSTGRES_PASSWORD',
  'REDIS_PASSWORD',
  'BUZZ_S3_ACCESS_KEY',
  'BUZZ_S3_SECRET_KEY',
  'BDI_SPIKE_RELAY_KEY',
  'BDI_SPIKE_AUTHOR_KEY',
  'BDI_SPIKE_SERVICE_KEY',
  'BDI_SPIKE_PROMOTER_KEY',
];

const SAFE_HOST_ENV_NAMES = new Set([
  'CI',
  'COLORTERM',
  'COREPACK_HOME',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_HOST',
  'FORCE_COLOR',
  'HOME',
  'LANG',
  'LOGNAME',
  'NO_COLOR',
  'PATH',
  'PNPM_HOME',
  'SHELL',
  'TERM',
  'TMP',
  'TMPDIR',
  'TEMP',
  'USER',
]);

function safeHostEnvironment(processEnv) {
  return Object.fromEntries(
    Object.entries(processEnv).filter(
      ([name]) => SAFE_HOST_ENV_NAMES.has(name) || name.startsWith('LC_'),
    ),
  );
}

function requireSecrets(secrets) {
  for (const name of REQUIRED_SECRET_NAMES) {
    if (!secrets?.[name]) throw new Error(`M0 secrets are missing ${name}`);
  }
  return secrets;
}

/**
 * Build explicit environments for each M0 component. Keeping these separate
 * prevents read/stop paths from accidentally inheriting daemon credentials or
 * publication settings from one all-purpose environment object.
 */
export function buildBaseMvpEnvironments(input) {
  const {
    host: { processEnv, nodePath, project, stateDir, dkgRepo },
    dkg: { dkgDevnetDir, dkgDockerPrefix, dkgNodes },
  } = input;
  const base = {
    ...safeHostEnvironment(processEnv),
    PATH: nodePath,
    COMPOSE_PROJECT_NAME: project,
    BDI_MVP_STATE_DIR: stateDir,
    BDI_MVP_DKG_REPO: dkgRepo,
  };
  const dkg = {
    ...base,
    DEVNET_DIR: dkgDevnetDir,
    DEVNET_DOCKER_NAME_PREFIX: dkgDockerPrefix,
    DEVNET_ENABLE_PUBLISHER: '0',
    NUM_CORE_NODES: String(dkgNodes),
    API_PORT_BASE: '9420',
    LIBP2P_PORT_BASE: '10401',
    HARDHAT_PORT: '8655',
    DEVNET_OXIGRAPH_BASE: '7920',
    DEVNET_BLAZEGRAPH_PORT: '19999',
    DEVNET_OXIGRAPH_SERVER_PORT_5: '7931',
    DEVNET_OXIGRAPH_SERVER_PORT_6: '7932',
    UI_PORT: '5573',
  };
  return { base, dkg };
}

export function buildCredentialedMvpEnvironments(input) {
  const {
    integration: {
      processEnv,
      dkgTokenPath,
      bindingsPath,
      daemonDbPath,
      buzzHttp,
      buzzWs,
      dkgApi,
      buzzCli,
    },
  } = input;
  const { base, dkg } = buildBaseMvpEnvironments(input.base);

  const secrets = requireSecrets(input.secrets);
  const integration = {
    ...base,
    BDI_BUZZ_HTTP: buzzHttp,
    BDI_BUZZ_WS: buzzWs,
    BDI_DKG_API: dkgApi,
    BDI_DKG_TOKEN_PATH: dkgTokenPath,
    BDI_BINDINGS_PATH: bindingsPath,
    BDI_SERVICE_KEY: secrets.BDI_SPIKE_SERVICE_KEY,
    BDI_PUBLISH_MODE: 'disabled',
    BDI_MAX_PUBLISHES_PER_DAY: '0',
    BDI_DB_PATH: daemonDbPath,
    BDI_LOG_LEVEL: processEnv.BDI_LOG_LEVEL || 'info',
  };
  return {
    base,
    compose: { ...base, ...secrets },
    dkg,
    bootstrap: {
      ...integration,
      BDI_BUZZ_CLI: buzzCli,
      BDI_BUZZ_OWNER_KEY: secrets.BDI_SPIKE_AUTHOR_KEY,
      BDI_PROMOTER_KEY: secrets.BDI_SPIKE_PROMOTER_KEY,
    },
    daemon: integration,
    smoke: {
      ...integration,
      BDI_BUZZ_OWNER_KEY: secrets.BDI_SPIKE_AUTHOR_KEY,
    },
  };
}
