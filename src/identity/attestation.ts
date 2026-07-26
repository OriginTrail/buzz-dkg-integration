import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';

/**
 * NIP-OA owner attestation VERIFICATION (SPEC §4.8: verification only —
 * publishing a binding KA is a separate, unimplemented authority).
 *
 * Wire format (block/buzz crates/buzz-sdk/src/nip_oa.rs @ dd222a5): an
 * ["auth", owner_pubkey, conditions, sig] tag on the NIP-42 AUTH event, where
 * sig is a BIP-340 Schnorr signature by owner_pubkey over
 * SHA256("nostr:agent-auth:" || agent_pubkey || ":" || conditions).
 */
export function verifyOwnerAttestation(opts: {
  agentPubkey: string;
  ownerPubkey: string;
  conditions: string;
  sigHex: string;
}): boolean {
  const { agentPubkey, ownerPubkey, conditions, sigHex } = opts;
  if (!/^[0-9a-f]{64}$/.test(agentPubkey) || !/^[0-9a-f]{64}$/.test(ownerPubkey)) return false;
  const msg = createHash('sha256')
    .update(`nostr:agent-auth:${agentPubkey}:${conditions}`, 'utf8')
    .digest();
  try {
    return schnorr.verify(sigHex, msg, ownerPubkey);
  } catch {
    return false;
  }
}

/** SPEC §4.8: creating an identity-binding KA is deliberately not implemented in stage ABC. */
export function publishBindingKa(): never {
  throw new Error(
    'identity-binding KA publication is disabled (SPEC §4.8; requires its own authorization)',
  );
}
