export const SUPPORTED_DKG_NETWORKS = ['mainnet-gnosis', 'mainnet-base', 'testnet'];
export const SUPPORTED_DKG_VERSION = '10.0.11';

function detectedNetwork(status) {
  const named = status?.networkId || status?.network || status?.chain?.network;
  if (SUPPORTED_DKG_NETWORKS.includes(named)) return named;
  const chainId = String(status?.chain?.chainId || '').toLowerCase();
  if (['base:8453', 'eip155:8453', '8453'].includes(chainId)) return 'mainnet-base';
  if (['gnosis:100', 'eip155:100', '100'].includes(chainId)) return 'mainnet-gnosis';
  if (status && chainId) throw new Error(`existing DKG node uses unsupported chain '${chainId}'`);
  return null;
}

export function resolveDkgPlan({
  existingStatus,
  requestedRole = 'auto',
  requestedNetwork,
  priorNetwork,
  unattended = false,
}) {
  const dkgRole = existingStatus?.nodeRole || (requestedRole === 'auto' ? 'edge' : requestedRole);
  const selectedNetwork = requestedNetwork || priorNetwork;
  let existingNetwork = null;
  if (existingStatus) {
    const version = String(existingStatus.version || '').replace(/^v/, '');
    if (version !== SUPPORTED_DKG_VERSION) {
      throw new Error(
        `existing DKG node version ${version || 'unknown'} is incompatible; expected ${SUPPORTED_DKG_VERSION}`,
      );
    }
    existingNetwork = detectedNetwork(existingStatus);
    if (!existingNetwork) {
      throw new Error('existing DKG node status does not identify its network');
    }
    if (selectedNetwork && existingNetwork !== selectedNetwork) {
      throw new Error(
        `existing DKG node network ${existingNetwork} does not match requested ${selectedNetwork}`,
      );
    }
  }
  if (existingStatus && requestedRole !== 'auto' && existingStatus.nodeRole !== requestedRole) {
    throw new Error(
      `DKG node is ${existingStatus.nodeRole}, but ${requestedRole} was requested`,
    );
  }
  if (!existingStatus && unattended && !requestedNetwork && !priorNetwork) {
    throw new Error(
      'a fresh unattended DKG install requires --dkg-network testnet|mainnet-gnosis|mainnet-base',
    );
  }
  return {
    dkgRole,
    network: existingNetwork || selectedNetwork || 'testnet',
    dkgExisting: Boolean(existingStatus),
    dkgStatus: existingStatus,
  };
}
