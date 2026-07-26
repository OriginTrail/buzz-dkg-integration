import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1';
import { publishBindingKa, verifyOwnerAttestation } from '../src/identity/attestation.ts';

describe('NIP-OA owner attestation (verification only, §4.8)', () => {
  const ownerSk = schnorr.utils.randomPrivateKey();
  const ownerPk = Buffer.from(schnorr.getPublicKey(ownerSk)).toString('hex');
  const agentPk = 'a'.repeat(64);
  const conditions = 'channels=*;expires=never';
  const msg = createHash('sha256')
    .update(`nostr:agent-auth:${agentPk}:${conditions}`, 'utf8')
    .digest();
  const sigHex = Buffer.from(schnorr.sign(msg, ownerSk)).toString('hex');

  it('verifies a valid owner attestation', () => {
    expect(
      verifyOwnerAttestation({ agentPubkey: agentPk, ownerPubkey: ownerPk, conditions, sigHex }),
    ).toBe(true);
  });

  it('rejects a wrong signer, tampered conditions, and malformed keys', () => {
    const otherPk = Buffer.from(schnorr.getPublicKey(schnorr.utils.randomPrivateKey())).toString(
      'hex',
    );
    expect(
      verifyOwnerAttestation({ agentPubkey: agentPk, ownerPubkey: otherPk, conditions, sigHex }),
    ).toBe(false);
    expect(
      verifyOwnerAttestation({
        agentPubkey: agentPk,
        ownerPubkey: ownerPk,
        conditions: 'channels=none',
        sigHex,
      }),
    ).toBe(false);
    expect(
      verifyOwnerAttestation({ agentPubkey: 'nope', ownerPubkey: ownerPk, conditions, sigHex }),
    ).toBe(false);
  });

  it('binding-KA publication is hard-disabled in stage ABC', () => {
    expect(() => publishBindingKa()).toThrow(/disabled/);
  });
});
