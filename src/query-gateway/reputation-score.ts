import type {
  ReputationBreakdown,
  ReputationConfidence,
  ReputationSignals,
  TrustNetworkResult,
  TrustVouchSummary,
} from './types.ts';

const NOSTR_EVENT_URI = /^urn:nostr:event:[0-9a-f]{64}$/u;

export interface ReputationAssessment {
  score: number;
  confidence: ReputationConfidence;
  breakdown: ReputationBreakdown;
  signals: ReputationSignals;
  reasons: string[];
  evidence: TrustVouchSummary[];
}

function vouchLineageGroups(vouches: readonly TrustVouchSummary[]): TrustVouchSummary[][] {
  const parent = vouches.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]!]!;
      index = parent[index]!;
    }
    return index;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  const rootOwner = new Map<string, number>();
  for (const [index, vouch] of vouches.entries()) {
    const evidenceRoots =
      vouch.evidence.length > 0 || vouch.evidenceSources.length > 0
        ? [...vouch.evidence, ...vouch.evidenceSources]
        : [vouch.sourceEvent ?? `urn:buzz-dkg:lineage:${vouch.uri}`];
    const roots = [`urn:buzz-dkg:issuer:${vouch.issuer}`, ...evidenceRoots];
    for (const root of roots) {
      const owner = rootOwner.get(root);
      if (owner === undefined) rootOwner.set(root, index);
      else union(index, owner);
    }
  }
  const groups = new Map<number, TrustVouchSummary[]>();
  for (const [index, vouch] of vouches.entries()) {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(vouch);
    groups.set(root, group);
  }
  return [...groups.values()];
}

/** Pure, bounded v2 reputation traversal and scoring over one materialized trust snapshot. */
export function scoreReputation(
  network: TrustNetworkResult,
  subject: string,
  perspective: string,
): ReputationAssessment {
  const active = network.vouches.filter(
    (vouch) =>
      vouch.status === 'active' &&
      vouch.sourceEvent !== null &&
      NOSTR_EVENT_URI.test(vouch.sourceEvent),
  );
  const inbound = active.filter((vouch) => vouch.subject === subject);
  const requesterVouches = new Set(
    active.filter((vouch) => vouch.issuer === perspective).map((vouch) => vouch.subject),
  );
  const inboundIssuers = new Set(inbound.map((vouch) => vouch.issuer));
  const directVouch = inboundIssuers.has(perspective);
  const twoHopIssuers = new Set(
    [...inboundIssuers].filter(
      (issuer) => issuer !== perspective && issuer !== subject && requesterVouches.has(issuer),
    ),
  );
  const person = network.people.find((candidate) => candidate.pubkey === subject);
  const evidenceRecords = person?.contributions ?? 0;
  const verifiableEvidence = person?.contributionLayer === 'VM';
  const lineageGroups = vouchLineageGroups(inbound);
  const directLineages = lineageGroups.filter((group) =>
    group.some((vouch) => vouch.issuer === perspective),
  );
  const twoHopLineages = lineageGroups.filter(
    (group) =>
      !directLineages.includes(group) && group.some((vouch) => twoHopIssuers.has(vouch.issuer)),
  );
  const communityLineages = lineageGroups.filter(
    (group) => !directLineages.includes(group) && !twoHopLineages.includes(group),
  );
  const independentLineages = lineageGroups.length;
  const directTrust = Math.min(
    100,
    (directVouch ? 60 : 0) +
      Math.min(2, independentLineages - (directLineages.length > 0 ? 1 : 0)) * 20,
  );
  const networkTrust = Math.min(100, twoHopLineages.length * 45 + communityLineages.length * 15);
  const demonstratedWork = Math.min(100, Math.round(evidenceRecords * 12.5));
  const evidenceDiversity = Math.min(
    100,
    independentLineages * 20 + Math.min(evidenceRecords, 5) * 8 + (verifiableEvidence ? 20 : 0),
  );
  const score = Math.round(
    directTrust * 0.35 + networkTrust * 0.25 + demonstratedWork * 0.3 + evidenceDiversity * 0.1,
  );
  const confidenceEvidence =
    independentLineages * 2 + Math.min(evidenceRecords, 8) + (verifiableEvidence ? 2 : 0);
  const confidence: ReputationConfidence =
    confidenceEvidence === 0
      ? 'none'
      : confidenceEvidence <= 3
        ? 'low'
        : confidenceEvidence <= 8
          ? 'medium'
          : 'high';

  const reasons: string[] = [];
  if (directVouch) reasons.push('You signed a direct vouch for this person.');
  if (inboundIssuers.size > 0) {
    reasons.push(
      `${inboundIssuers.size} independent contributor${inboundIssuers.size === 1 ? '' : 's'} signed a vouch.`,
    );
  }
  if (inbound.length > independentLineages) {
    reasons.push(
      `${inbound.length} vouches reduce to ${independentLineages} independent evidence lineage${independentLineages === 1 ? '' : 's'}.`,
    );
  }
  if (twoHopIssuers.size > 0) {
    reasons.push(
      `${twoHopIssuers.size} vouch${twoHopIssuers.size === 1 ? '' : 'es'} arrived through a two-hop trust path.`,
    );
  }
  if (evidenceRecords > 0) {
    reasons.push(
      `${evidenceRecords} attributed channel evidence record${evidenceRecords === 1 ? '' : 's'} were found.`,
    );
  }
  if (verifiableEvidence) reasons.push('Verifiable-memory evidence is available.');
  if (network.completeness === 'partial') {
    reasons.push('Evidence discovery reached the channel bound; this score uses a bounded sample.');
  }
  if (reasons.length === 0) reasons.push('No reputation evidence exists in this channel yet.');

  const pathSubjects = new Set(twoHopIssuers);
  const evidenceByUri = new Map<string, TrustVouchSummary>();
  for (const vouch of active) {
    if (
      vouch.subject === subject ||
      (vouch.issuer === perspective && pathSubjects.has(vouch.subject))
    ) {
      evidenceByUri.set(vouch.uri, vouch);
    }
    if (evidenceByUri.size >= 25) break;
  }
  return {
    score,
    confidence,
    breakdown: { directTrust, networkTrust, demonstratedWork, evidenceDiversity },
    signals: {
      directVouch,
      twoHopVouchers: twoHopIssuers.size,
      independentVouchers: inboundIssuers.size,
      independentLineages,
      evidenceRecords,
      verifiableEvidence,
    },
    reasons,
    evidence: [...evidenceByUri.values()],
  };
}
