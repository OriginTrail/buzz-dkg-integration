import { verifyEvent, type VerifiedEvent } from 'nostr-tools';
import { logger } from '../log.ts';
import type { Registry } from '../registry/store.ts';
import type { RelayClient } from '../relay/client.ts';
import {
  DKG_MEMORY_PROPOSAL_KIND,
  type AgentMemoryIngestResult,
  type CommunityMemoryConfig,
  type NostrEvent,
} from '../types.ts';
import type { CommunityMemoryExtractor } from './community-worker.ts';

type EnabledCommunityMemoryConfig = Extract<CommunityMemoryConfig, { enabled: true }>;
type SubmitCommunityMemory = (
  envelope: unknown,
  sourceEventIds: readonly string[],
) => AgentMemoryIngestResult;

/** Owns the opt-in human-conversation capture policy and extraction lifecycle.
 * The daemon only dispatches events and provides the durable proposal callback. */
export class CommunityMemoryService {
  readonly #config: EnabledCommunityMemoryConfig;
  readonly #registry: Registry;
  readonly #relay: RelayClient;
  readonly #extractor: CommunityMemoryExtractor;
  readonly #submit: SubmitCommunityMemory;
  #timer: NodeJS.Timeout | null = null;

  constructor(args: {
    config: EnabledCommunityMemoryConfig;
    registry: Registry;
    relay: RelayClient;
    extractor: CommunityMemoryExtractor;
    submit: SubmitCommunityMemory;
  }) {
    this.#config = args.config;
    this.#registry = args.registry;
    this.#relay = args.relay;
    this.#extractor = args.extractor;
    this.#submit = args.submit;
  }

  messageFilters(since: number): Record<string, unknown>[] {
    if (this.#config.channels === '*') return [{ kinds: [9, 40002], since }];
    return this.#config.channels.length > 0
      ? [{ kinds: [9, 40002], '#h': this.#config.channels, since }]
      : [];
  }

  /** Validate privacy and integrity before durable queueing or model exposure. */
  queue(event: NostrEvent): boolean {
    const channelId = this.channelFor(event);
    if (!channelId) return false;
    const queued = this.#registry.queueCommunityMemoryEvent(event, channelId);
    if (queued) {
      logger.debug('community memory evidence queued', { eventId: event.id, channelId });
    }
    return queued;
  }

  start(scheduleFlush: () => void): void {
    if (this.#timer) return;
    const intervalMs = Math.max(1_000, Math.min(this.#config.debounceMs, 5_000));
    this.#timer = setInterval(scheduleFlush, intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  async flush(now = Date.now()): Promise<void> {
    const config = this.#config;
    for (const channelId of this.#registry.communityMemoryReadyChannels(now, config.debounceMs)) {
      const events = this.#registry.communityMemoryBatch(
        channelId,
        config.maxEvents,
        config.maxInputChars,
        now,
      );
      if (events.length === 0) continue;
      const eventIds = events.map((event) => event.id);
      try {
        const extraction = await this.#extractor.extract(channelId, events);
        if (extraction.type === 'no_memory') {
          this.#registry.resolveCommunityMemoryEvents(eventIds, 'no_memory');
          logger.debug('community memory batch contained no durable memory', {
            channelId,
            events: events.length,
            reason: extraction.reason,
          });
          continue;
        }
        const proposalEvent = this.#relay.sign({
          kind: DKG_MEMORY_PROPOSAL_KIND,
          tags: [
            ['h', channelId],
            ...eventIds.map((eventId) => ['e', eventId, '', 'source']),
            ['t', 'dkg-memory-proposal'],
          ],
          content: JSON.stringify(extraction.proposal),
        });
        const accepted = this.#submit(
          {
            channelId,
            requesterPubkey: this.#relay.pubkey,
            proposalEvent,
            sourceEvents: events,
          },
          eventIds,
        );
        logger.info('community memory accepted', {
          channelId,
          proposalEventId: accepted.proposalEventId,
          events: events.length,
        });
      } catch (error) {
        const attempt = this.#registry.communityMemoryAttempt(eventIds[0]!) + 1;
        const delay = Math.min(config.retryBaseMs * 2 ** Math.min(attempt - 1, 8), 15 * 60_000);
        this.#registry.retryCommunityMemoryEvents(eventIds, String(error), now + delay);
        logger.warn('community memory extraction deferred', {
          channelId,
          events: events.length,
          attempt,
          retryInMs: delay,
          err: String(error),
        });
      }
    }
  }

  private channelFor(event: NostrEvent): string | null {
    if (![9, 40002].includes(event.kind)) return null;
    if (event.pubkey === this.#relay.pubkey || !event.content.trim()) return null;
    if (event.content.length > this.#config.maxInputChars) return null;
    // Verify a fresh object so a cached nostr-tools verification symbol on an
    // upstream mutable event cannot survive later field tampering.
    if (
      !verifyEvent({
        id: event.id,
        pubkey: event.pubkey,
        created_at: event.created_at,
        kind: event.kind,
        tags: event.tags.map((tag) => [...tag]),
        content: event.content,
        sig: event.sig,
      } as VerifiedEvent)
    )
      return null;
    const channels = event.tags.filter((tag) => tag[0] === 'h' && tag[1]).map((tag) => tag[1]!);
    if (channels.length !== 1) return null;
    const channelId = channels[0]!;
    if (this.#config.channels !== '*' && !this.#config.channels.includes(channelId)) return null;
    return channelId;
  }
}
