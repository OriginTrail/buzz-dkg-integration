import type { NostrEvent } from '../types.ts';

export type Trigger =
  | { type: 'pin'; event: NostrEvent; channelId: string; targetEventId: string }
  | { type: 'distill'; event: NostrEvent; channelId: string; targetEventId: string }
  | { type: 'approval'; event: NostrEvent; targetEventId: string; emoji: string }
  | { type: 'ask'; event: NostrEvent; channelId: string; question: string }
  | null;

const firstTag = (e: NostrEvent, name: string): string | undefined =>
  e.tags.find((t) => t[0] === name)?.[1];

/** Last valid 64-hex e tag wins — mirrors the relay's reaction targeting. */
const lastETag = (e: NostrEvent): string | undefined =>
  [...e.tags].reverse().find((t) => t[0] === 'e' && /^[0-9a-f]{64}$/.test(t[1] ?? ''))?.[1];

const mentionsPubkey = (e: NostrEvent, pubkey: string): boolean =>
  e.tags.some((t) => t[0] === 'p' && t[1] === pubkey);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Hard cap on question length. Retrieval builds O(n²) term pairs and
 * interpolates them into a SPARQL FILTER (see grounded.ts), so an unbounded
 * question is a DoS vector; capping at the trigger keeps it from ever reaching
 * the retriever. Generous for a natural-language question.
 */
export const MAX_QUESTION_CHARS = 512;

/**
 * Classify an incoming relay event against the trigger grammar (SPEC §4.4/§6):
 *  - kind 40004 pin  → capture trigger (target from e tag, channel from h tag)
 *  - kind 9 "@<handle> distill" mentioning the service → capture trigger for
 *    the thread the message replies to (or itself as root)
 *  - kind 7 reaction → approval candidate (§6 validation happens later,
 *    against registry state — this stage only extracts shape)
 *  - kind 9 "@<handle> ask <question>" → grounded question
 * Anything else → null. Never trust client h tags on reactions (relay derives
 * the channel from the target; so do we — via our own receipt records).
 */
export function classify(
  event: NostrEvent,
  opts: { servicePubkey: string; mentionLabels: readonly string[] },
): Trigger {
  if (event.pubkey === opts.servicePubkey) return null; // never self-trigger

  if (event.kind === 40004) {
    const channelId = firstTag(event, 'h');
    const target = lastETag(event);
    if (!channelId || !target) return null;
    return { type: 'pin', event, channelId, targetEventId: target };
  }

  if (event.kind === 7) {
    const target = lastETag(event);
    if (!target) return null;
    return { type: 'approval', event, targetEventId: target, emoji: event.content };
  }

  if (event.kind === 9 && mentionsPubkey(event, opts.servicePubkey)) {
    const channelId = firstTag(event, 'h');
    if (!channelId) return null;
    // Buzz renders one of the configured labels into message content while the
    // signed p tag carries the authoritative identity. Interior whitespace is
    // presentation-tolerant; every non-whitespace character remains literal.
    const names = opts.mentionLabels
      .map((name) => String(name).trim())
      .filter(Boolean)
      .map(escapeRegExp)
      .map((name) => name.replace(/\s+/g, '\\s+'))
      .join('|');
    if (!names) return null;
    const re = new RegExp(`@(?:${names})(?=\\s)\\s+(distill|ask)\\b\\s*(.*)`, 'is');
    const m = event.content.match(re);
    if (!m) return null;
    const verb = m[1]!.toLowerCase();
    if (verb === 'distill') {
      // Distill the thread this message references: NIP-10 root marker if
      // present, else the replied-to event, else any e tag. A bare `@dkg
      // distill` with NO referenced event is a no-op — falling back to the
      // command message itself would distill and SWM-share the literal text
      // "@dkg distill" as a decision.
      const root =
        event.tags.find((t) => t[0] === 'e' && t[3] === 'root')?.[1] ??
        event.tags.find((t) => t[0] === 'e' && t[3] === 'reply')?.[1] ??
        event.tags.find((t) => t[0] === 'e')?.[1];
      if (!root) return null;
      return { type: 'distill', event, channelId, targetEventId: root };
    }
    const question = (m[2] ?? '').trim();
    if (!question || question.length > MAX_QUESTION_CHARS) return null;
    return { type: 'ask', event, channelId, question };
  }

  return null;
}
