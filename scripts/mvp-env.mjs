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
export function buildMvpEnvironments(input) {
  const {
    processEnv,
    nodePath,
    project,
    stateDir,
    dkgRepo,
    dkgDevnetDir,
    dkgTokenPath,
    bindingsPath,
    daemonDbPath,
    buzzHttp,
    buzzWs,
    dkgApi,
    dkgDockerPrefix,
    dkgNodes,
  } = input;
  const base = {
    ...processEnv,
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
  if (!input.secrets) return { base, dkg };

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
