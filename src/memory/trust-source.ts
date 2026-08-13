const HEX_64 = /^[0-9a-f]{64}$/u;

export type TrustAction = 'vouch' | 'revoke' | 'supersede';
export type TrustActionTagResult =
  | { ok: true; action: TrustAction; subjectPubkey: string }
  | { ok: false; reason: 'label' | 'subject' };

/** Parse the canonical buzz.wot action tag grammar used at ingestion and query time. */
export function parseTrustActionTags(value: unknown): TrustActionTagResult {
  if (
    !Array.isArray(value) ||
    !value.every(
      (tag) =>
        Array.isArray(tag) && tag.length > 0 && tag.every((item) => typeof item === 'string'),
    )
  ) {
    return { ok: false, reason: 'label' };
  }
  const tags = value as string[][];
  const namespaces = tags.filter((tag) => tag[0] === 'L');
  const labels = tags.filter((tag) => tag[0] === 'l');
  const action = labels[0]?.[1];
  if (
    namespaces.length !== 1 ||
    namespaces[0]!.length !== 2 ||
    namespaces[0]![1] !== 'buzz.wot' ||
    labels.length !== 1 ||
    labels[0]!.length !== 3 ||
    (action !== 'vouch' && action !== 'revoke' && action !== 'supersede') ||
    labels[0]![2] !== 'buzz.wot'
  ) {
    return { ok: false, reason: 'label' };
  }
  const subjects = tags.filter((tag) => tag[0] === 'p');
  const subjectPubkey = subjects[0]?.[1]?.toLowerCase();
  if (subjects.length !== 1 || !subjectPubkey || !HEX_64.test(subjectPubkey)) {
    return { ok: false, reason: 'subject' };
  }
  return { ok: true, action, subjectPubkey };
}

/** Accept only the vouch subset when deciding whether graph evidence is scoreable. */
export function parseTrustVouchTags(value: unknown): TrustActionTagResult {
  const parsed = parseTrustActionTags(value);
  return parsed.ok && parsed.action !== 'vouch' ? { ok: false, reason: 'label' } : parsed;
}
