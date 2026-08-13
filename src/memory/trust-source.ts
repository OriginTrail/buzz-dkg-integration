const HEX_64 = /^[0-9a-f]{64}$/u;

export type TrustVouchTagResult =
  { ok: true; subjectPubkey: string } | { ok: false; reason: 'label' | 'subject' };

/** Parse the one canonical buzz.wot vouch tag grammar used at ingestion and query time. */
export function parseTrustVouchTags(value: unknown): TrustVouchTagResult {
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
  if (
    namespaces.length !== 1 ||
    namespaces[0]!.length !== 2 ||
    namespaces[0]![1] !== 'buzz.wot' ||
    labels.length !== 1 ||
    labels[0]!.length !== 3 ||
    labels[0]![1] !== 'vouch' ||
    labels[0]![2] !== 'buzz.wot'
  ) {
    return { ok: false, reason: 'label' };
  }
  const subjects = tags.filter((tag) => tag[0] === 'p');
  const subjectPubkey = subjects[0]?.[1]?.toLowerCase();
  if (subjects.length !== 1 || !subjectPubkey || !HEX_64.test(subjectPubkey)) {
    return { ok: false, reason: 'subject' };
  }
  return { ok: true, subjectPubkey };
}
