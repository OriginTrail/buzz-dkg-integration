export const SUPPORTED_DKG_NETWORKS = ['mainnet-gnosis', 'mainnet-base', 'testnet'];

export function resolveDkgPlan({
  existingStatus,
  requestedRole = 'auto',
  requestedNetwork,
  priorNetwork,
  unattended = false,
}) {
  const dkgRole = existingStatus?.nodeRole || (requestedRole === 'auto' ? 'edge' : requestedRole);
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
    network: requestedNetwork || priorNetwork || 'testnet',
    dkgExisting: Boolean(existingStatus),
    dkgStatus: existingStatus,
  };
}
