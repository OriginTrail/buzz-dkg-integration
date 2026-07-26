import { RelayClient } from './relay/client.ts';
import { DkgClient } from './dkg/client.ts';
import { Registry } from './registry/store.ts';
import { classify, type Trigger } from './triggers/detect.ts';
import {
  deterministicDistiller,
  kaNameForDigest,
  snapshotSourceSet,
  type Distiller,
} from './distill/deterministic.ts';
import { answerGrounded } from './ask/grounded.ts';
import {
  answerMessage,
  parseReceiptDigest,
  parseReceiptKaName,
  refusalMessage,
  swmReceipt,
  vmReceipt,
} from './receipts/compose.ts';
import { logger } from './log.ts';
import type { DaemonConfig, NostrEvent, OpRecord } from './types.ts';

const CATCHUP_OVERLAP_S = 60;
const DEVNET_CHAIN = 'evm:31337';

export class Daemon {
  readonly config: DaemonConfig;
  readonly registry: Registry;
  readonly relay: RelayClient;
  readonly dkg: DkgClient;
  readonly distiller: Distiller;
  #queue: Promise<void> = Promise.resolve();
  #chainId: string | undefined;

  constructor(
    config: DaemonConfig,
    deps?: { relay?: RelayClient; dkg?: DkgClient; distiller?: Distiller },
  ) {
    this.config = config;
    this.registry = new Registry(config.dbPath);
    this.registry.loadBindings(config.bindings);
    this.relay =
      deps?.relay ??
      new RelayClient({
        httpUrl: config.relayHttpUrl,
        wsUrl: config.relayWsUrl,
        secretKeyHex: config.serviceSecretKeyHex,
        onEvent: (e) => this.enqueue(e),
        onReconnect: () =>
          void this.catchUp().catch((err) => logger.error('catch-up failed', { err: String(err) })),
      });
    this.dkg = deps?.dkg ?? new DkgClient({ baseUrl: config.dkgApiUrl, token: config.dkgToken });
    this.distiller = deps?.distiller ?? deterministicDistiller;
  }

  /** Serialize event handling — ordering and dedup stay deterministic. */
  enqueue(event: NostrEvent): void {
    this.#queue = this.#queue
      .then(() => this.handleEvent(event))
      .catch((err) =>
        logger.error('event handling failed', { eventId: event.id, err: String(err) }),
      );
  }

  /** Wait for all queued events to be processed (tests + shutdown). */
  drain(): Promise<void> {
    return this.#queue;
  }

  async start(): Promise<void> {
    const st = await this.dkg.status();
    this.#chainId = st.chain?.chainId;
    logger.info('dkg node', {
      version: st.version,
      chainId: this.#chainId,
      publishMode: this.config.publishMode,
    });
    if (this.config.publishMode === 'devnet' && this.#chainId !== DEVNET_CHAIN) {
      throw new Error(
        `publishMode=devnet requires chain ${DEVNET_CHAIN}, node reports '${this.#chainId}' — refusing to start`,
      );
    }
    // Verify every bound context graph exists before serving (§7.2 fail early).
    const cgs = new Set((await this.dkg.listContextGraphs()).contextGraphs.map((c) => c.id));
    for (const b of this.config.bindings) {
      if (!cgs.has(b.contextGraphId)) {
        throw new Error(`bound context graph '${b.contextGraphId}' not present on the DKG node`);
      }
    }
    await this.recover();
    await this.catchUp();
    this.subscribe();
    this.relay.connect();
    logger.info('daemon started', {
      servicePubkey: this.relay.pubkey,
      channels: this.config.bindings.length,
    });
  }

  subscribe(): void {
    const channels = this.config.bindings.map((b) => b.channelId);
    const since = Math.max(0, this.registry.cursor - CATCHUP_OVERLAP_S);
    this.relay.subscribe('bdi-msgs', [{ kinds: [9, 40002, 40004], '#h': channels, since }]);
    // Reactions carry no h tag as signed by clients; subscribe by kind and
    // correlate via our own receipt records (relay-style target derivation).
    this.relay.subscribe('bdi-reactions', [{ kinds: [7], since }]);
  }

  /** Replays stored events missed while offline; dedup makes replay safe. */
  async catchUp(): Promise<void> {
    const since = Math.max(0, this.registry.cursor - CATCHUP_OVERLAP_S);
    const channels = this.config.bindings.map((b) => b.channelId);
    const stored = await this.relay.query([
      { kinds: [9, 40002, 40004], '#h': channels, since },
      { kinds: [7], since },
    ]);
    stored.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    logger.info('catch-up', { since, events: stored.length });
    for (const e of stored) this.enqueue(e);
    await this.drain();
  }

  /** Resume pending operations and asks after a crash/restart. */
  async recover(): Promise<void> {
    for (const op of this.registry.pendingOps()) {
      logger.info('recovering op', { opId: op.id, kaName: op.kaName, state: op.state });
      await this.executeOp(op).catch((err) =>
        logger.error('op recovery failed', { opId: op.id, err: String(err) }),
      );
    }
    for (const ask of this.registry.pendingAsks()) {
      logger.info('recovering ask', { askEventId: ask.askEventId });
      const events = await this.relay.query([{ ids: [ask.askEventId] }]);
      const event = events[0];
      if (event) {
        const trigger = classify(event, {
          servicePubkey: this.relay.pubkey,
          mentionHandle: this.config.mentionHandle,
        });
        if (trigger?.type === 'ask')
          await this.executeAsk(trigger.event, trigger.channelId, trigger.question, true);
      }
    }
  }

  async handleEvent(event: NostrEvent): Promise<void> {
    const trigger = classify(event, {
      servicePubkey: this.relay.pubkey,
      mentionHandle: this.config.mentionHandle,
    });
    this.registry.advanceCursor(event.created_at);
    if (!trigger) return;
    switch (trigger.type) {
      case 'pin':
      case 'distill':
        return this.handleCapture(trigger);
      case 'approval':
        return this.handleApproval(trigger);
      case 'ask':
        return this.executeAsk(trigger.event, trigger.channelId, trigger.question, false);
    }
  }

  // ── capture: trigger → snapshot → distill → WM → SWM → receipt ─────────────

  async handleCapture(
    trigger: Extract<Trigger, { type: 'pin' | 'distill' }> & object,
  ): Promise<void> {
    const { event, channelId, targetEventId } = trigger;
    const contextGraphId = this.registry.contextGraphFor(channelId);
    if (!contextGraphId) {
      logger.warn('capture in unmapped channel rejected', { channelId, eventId: event.id });
      return;
    }
    const existing = this.registry.opByTrigger(event.id);
    if (existing) {
      logger.info('trigger dedup', { triggerEventId: event.id, opId: existing.id });
      return;
    }
    const thread = await this.relay.fetchThread(channelId, targetEventId);
    const events = snapshotSourceSet(thread, event, this.relay.pubkey);
    if (!events.length) {
      logger.warn('empty source snapshot; ignoring trigger', { triggerEventId: event.id });
      return;
    }
    const { rootUri, digest } = this.distiller.distill({
      channelId,
      events,
      servicePubkey: this.relay.pubkey,
    });
    const op = this.registry.claimTrigger({
      triggerEventId: event.id,
      triggerKind: event.kind,
      channelId,
      contextGraphId,
      rootEventId: targetEventId,
      digest,
      kaName: kaNameForDigest(digest),
      rootUri,
    });
    if (!op) {
      logger.info('trigger raced; already claimed', { triggerEventId: event.id });
      return;
    }
    await this.executeOp(op, events);
  }

  /**
   * Forward-only executor with read-back recovery. Steps are safe to resume:
   * quads are fully deterministic (identical triples are set-idempotent in the
   * store), finalize/share are skipped when the descriptor already shows
   * 'promoted', and receipts are searched for on the relay before re-posting.
   */
  async executeOp(op: OpRecord, snapshot?: NostrEvent[]): Promise<void> {
    let events = snapshot;
    const ensureSnapshot = async (): Promise<NostrEvent[]> => {
      if (events) return events;
      const triggerEvents = await this.relay.query([{ ids: [op.triggerEventId] }]);
      const trigger = triggerEvents[0];
      if (!trigger) throw new Error(`trigger event ${op.triggerEventId} no longer readable`);
      const thread = await this.relay.fetchThread(op.channelId, op.rootEventId);
      events = snapshotSourceSet(thread, trigger, this.relay.pubkey);
      return events;
    };

    try {
      if (op.state === 'distilled') {
        const { digest, quads } = this.distiller.distill({
          channelId: op.channelId,
          events: await ensureSnapshot(),
          servicePubkey: this.relay.pubkey,
        });
        if (digest !== op.digest) {
          // Source events were deleted/hidden since the trigger (Buzz is not
          // append-only). Fail closed rather than distill something unapproved.
          this.registry.transition(op.id, 'failed', { error: 'source set changed since trigger' });
          return;
        }
        // wm/write auto-creates the KA lifecycle record when absent (verified
        // in routes/knowledge-assets.ts) — no separate create step to recover.
        await this.dkg.write(op.kaName, op.contextGraphId, quads);
        this.registry.transition(op.id, 'wm_written');
        op = this.registry.opByTrigger(op.triggerEventId)!;
      }

      if (op.state === 'wm_written' || op.state === 'finalized') {
        const desc = await this.dkg.descriptor(op.kaName, op.contextGraphId).catch(() => null);
        if (desc && desc.state === 'promoted') {
          // Read-back: a previous run already finalized+shared.
          this.registry.transition(op.id, 'shared', { assertion_uri: desc.assertionGraph ?? null });
        } else {
          if (op.state === 'wm_written') {
            const fin = await this.dkg.finalize(op.kaName, op.contextGraphId);
            this.registry.transition(op.id, 'finalized', { assertion_uri: fin.assertionUri });
          }
          await this.dkg.share(op.kaName, op.contextGraphId);
          this.registry.transition(op.id, 'shared');
        }
        op = this.registry.opByTrigger(op.triggerEventId)!;
      }

      if (op.state === 'shared') {
        // Scoped read-back proof before receipting (§4.6).
        const q = await this.dkg.query({
          sparql: `ASK { <${op.rootUri}> <https://w3id.org/buzz-dkg/buzz#sourceSetDigest> "${op.digest}" }`,
          contextGraphId: op.contextGraphId,
          view: 'shared-working-memory',
        });
        const b = q.result?.bindings ?? [];
        const ok =
          b.length > 0 &&
          Object.values(b[0] ?? {}).some((v: any) => String(v?.value ?? v) === 'true');
        if (!ok) throw new Error('SWM read-back did not confirm the shared digest');

        const receiptId =
          (await this.findExistingReceipt(op)) ??
          (
            await this.relay.sendMessage(
              op.channelId,
              swmReceipt({ ...op, assertionUri: op.assertionUri }),
              {
                replyTo: op.rootEventId,
              },
            )
          ).eventId;
        this.registry.transition(op.id, 'receipted', { receipt_event_id: receiptId });
        logger.info('SWM receipt posted', { opId: op.id, receiptId, kaName: op.kaName });
      }
    } catch (err) {
      logger.error('op execution failed; will retry on next recovery', {
        opId: op.id,
        err: String(err),
      });
      throw err;
    }
  }

  /** Read-back before retry (§9): find a receipt we may have posted pre-crash. */
  async findExistingReceipt(op: OpRecord): Promise<string | null> {
    const mine = await this.relay.query([
      { kinds: [9], '#h': [op.channelId], '#e': [op.rootEventId], authors: [this.relay.pubkey] },
    ]);
    const hit = mine.find((m) => m.content.includes(`trigger: ${op.triggerEventId}`));
    return hit?.id ?? null;
  }

  // ── approval: §6 invariants in code, then (devnet-only) publish ────────────

  async handleApproval(trigger: Extract<Trigger, { type: 'approval' }> & object): Promise<void> {
    const { event, targetEventId, emoji } = trigger;
    if (emoji !== this.config.approvalEmoji) return;
    const op = this.registry.opByReceipt(targetEventId);
    if (!op) return; // reaction to something that is not our receipt (§6.2)

    if (this.registry.approvalOutcome(event.id)) {
      logger.info('approval dedup', { approvalEventId: event.id });
      return;
    }

    const reject = (reason: string): void => {
      this.registry.recordApproval(event.id, op.id, 'rejected', reason);
      logger.warn('approval rejected', { approvalEventId: event.id, opId: op.id, reason });
    };

    // §6.1 reactor authorized for that channel
    if (!this.registry.promotersFor(op.channelId).includes(event.pubkey)) {
      return reject('reactor is not an authorized promoter for this channel');
    }
    // §6.4 channel still maps to the same context graph
    if (this.registry.contextGraphFor(op.channelId) !== op.contextGraphId) {
      return reject('channel↔context-graph mapping changed since capture');
    }
    // §6.3 the receipt identifies the pending KA and digest
    const receiptEvents = await this.relay.query([{ ids: [targetEventId] }]);
    const receipt = receiptEvents[0];
    if (!receipt) return reject('receipt event no longer readable');
    if (
      parseReceiptDigest(receipt.content) !== op.digest ||
      parseReceiptKaName(receipt.content) !== op.kaName
    ) {
      return reject('receipt content does not match recorded KA/digest');
    }
    // §6.5 finalized SWM KA matches the approved digest
    const desc = await this.dkg.descriptor(op.kaName, op.contextGraphId).catch(() => null);
    if (!desc || desc.state !== 'promoted' || desc.memoryLayer !== 'SWM') {
      return reject(
        `KA is not in finalized+shared SWM state (state=${desc?.state ?? 'unreadable'})`,
      );
    }
    // §6.7 not already published
    if (op.state !== 'receipted' || op.ual)
      return reject('KA already published or in publish flow');
    // §6.8 environment permits publication
    if (this.config.publishMode !== 'devnet') {
      return reject(
        `publication disabled (publishMode=${this.config.publishMode}; SPEC stage ABC)`,
      );
    }
    if (this.#chainId !== DEVNET_CHAIN) {
      return reject(`connected chain '${this.#chainId}' is not the devnet chain`);
    }
    // §6.9 stage authorization is the publishMode gate itself: only 'devnet'
    // exists in this codebase; mainnet authority arrives with SPEC §0 D3.

    // §6.6 consume exactly once — the INSERT is the atomic claim.
    if (!this.registry.recordApproval(event.id, op.id, 'consumed')) {
      logger.info('approval already consumed', { approvalEventId: event.id });
      return;
    }

    let ual: string;
    let txHash: string | undefined;
    try {
      const pub = await this.dkg.publish(op.kaName, op.contextGraphId);
      ual = pub.ual;
      txHash = pub.txHash;
    } catch (err) {
      // Ambiguity recovery (§9): read back before treating as failure. Never retry blindly.
      const after = await this.dkg.descriptor(op.kaName, op.contextGraphId).catch(() => null);
      if (
        after &&
        (after.state === 'published' || after.state === 'finalized') &&
        after.reservedUal
      ) {
        ual = after.reservedUal;
        logger.warn('publish response lost; recovered via descriptor read-back', {
          opId: op.id,
          ual,
        });
      } else {
        logger.error('publish failed', { opId: op.id, err: String(err) });
        return;
      }
    }
    this.registry.transition(op.id, 'published', { ual, consumed_approval_id: event.id });

    const updated = this.registry.opByTrigger(op.triggerEventId)!;
    const vmReceiptId = (
      await this.relay.sendMessage(op.channelId, vmReceipt(updated, event.id, event.pubkey), {
        replyTo: op.rootEventId,
      })
    ).eventId;
    this.registry.transition(op.id, 'vm_receipted', { vm_receipt_event_id: vmReceiptId });
    logger.info('VM publish complete', { opId: op.id, ual, txHash, vmReceiptId });
  }

  // ── ask: §7 grounded answering ─────────────────────────────────────────────

  async executeAsk(
    event: NostrEvent,
    channelId: string,
    question: string,
    isRecovery: boolean,
  ): Promise<void> {
    if (!isRecovery && !this.registry.claimAsk(event.id, channelId)) {
      logger.info('ask dedup', { askEventId: event.id });
      return;
    }
    const contextGraphId = this.registry.contextGraphFor(channelId);
    if (!contextGraphId) {
      const { eventId } = await this.relay.sendMessage(
        channelId,
        'This channel has no designated context graph; I cannot answer here.',
        { replyTo: event.id },
      );
      this.registry.resolveAsk(event.id, 'refused', eventId);
      return;
    }
    const result = await answerGrounded(this.dkg, contextGraphId, question);
    if (result.kind === 'refusal') {
      const { eventId } = await this.relay.sendMessage(
        channelId,
        refusalMessage(question, contextGraphId),
        {
          replyTo: event.id,
        },
      );
      this.registry.resolveAsk(event.id, 'refused', eventId);
      logger.info('ask refused (no supporting evidence)', { askEventId: event.id });
      return;
    }
    const { eventId } = await this.relay.sendMessage(
      channelId,
      answerMessage(question, result.text, result.evidence),
      { replyTo: event.id },
    );
    this.registry.resolveAsk(event.id, 'answered', eventId);
    logger.info('ask answered', { askEventId: event.id, citations: result.evidence.length });
  }

  async stop(): Promise<void> {
    this.relay.close();
    await this.drain();
    this.registry.close();
  }
}
