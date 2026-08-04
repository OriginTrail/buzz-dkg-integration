import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bootstrapExistingRelay,
  channelFromMetadataEvent,
  loadExistingRelayConfig,
} from '../scripts/bootstrap/existing-relay.mjs';

const channelId = '550e8400-e29b-41d4-a716-446655440000';
const ownerPubkey = '1'.repeat(64);
const servicePubkey = '2'.repeat(64);

function harness() {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'bdi-existing-bootstrap-'));
  const calls = { createChannel: 0, addBot: 0, publishProfile: 0, createGraph: 0 };
  const channels = [];
  let membership = { tags: [['p', servicePubkey, 'member']] };
  const profiles = [];
  const graphs = new Set();
  const buzz = {
    async findChannels(name) {
      return channels.filter((channel) => channel.name === name);
    },
    async getChannel(id) {
      return channels.find((channel) => channel.id === id) || null;
    },
    async createChannel(config) {
      calls.createChannel += 1;
      // The relay, not the caller, assigns this UUID.
      channels.push({
        id: channelId,
        name: config.channelName,
        visibility: config.channelVisibility,
        channelType: config.channelType,
        archived: false,
      });
      return { accepted: true };
    },
    async membership() {
      return membership;
    },
    async addBot(_channelId, pubkey) {
      calls.addBot += 1;
      membership = { tags: [['p', pubkey, 'bot']] };
      return { accepted: true };
    },
    async profiles() {
      return profiles;
    },
    async publishProfile(profile) {
      calls.publishProfile += 1;
      profiles.push({ id: `profile-${calls.publishProfile}`, created_at: calls.publishProfile, content: JSON.stringify(profile) });
      return { accepted: true };
    },
  };
  const dkg = {
    async status() {
      return { nodeRole: 'core' };
    },
    async contextGraphExists(id) {
      return { exists: graphs.has(id) };
    },
    async createContextGraph(config) {
      calls.createGraph += 1;
      expect(config).toMatchObject({ accessPolicy: 1 });
      graphs.add(config.id);
      return { id: config.id };
    },
  };
  const config = {
    runtimeDir,
    statePath: join(runtimeDir, 'bootstrap.json'),
    bindingsPath: join(runtimeDir, 'bindings.json'),
    buzzHttp: 'https://community.example.com',
    dkgApi: 'http://127.0.0.1:9200',
    token: 'token',
    ownerKey: '3'.repeat(64),
    serviceKey: '4'.repeat(64),
    ownerPubkey,
    servicePubkey,
    channelName: 'Web of Trust',
    channelType: 'stream',
    channelVisibility: 'open',
    channelDescription: 'test',
    accessPolicy: 1,
    serviceProfile: { name: 'dkg', display_name: 'DKG Memory', about: 'memory' },
  };
  return { runtimeDir, calls, channels, graphs, buzz, dkg, config };
}

describe('existing-relay bootstrap reconciliation', () => {
  it('decodes canonical NIP-29 metadata tags emitted by Buzz', () => {
    expect(
      channelFromMetadataEvent({
        tags: [
          ['d', channelId],
          ['name', 'Web of Trust'],
          ['public'],
          ['closed'],
          ['t', 'stream'],
        ],
      }),
    ).toEqual({
      id: channelId,
      name: 'Web of Trust',
      visibility: 'open',
      channelType: 'stream',
      archived: false,
    });
    expect(
      channelFromMetadataEvent({
        tags: [
          ['d', channelId],
          ['name', 'Private memory'],
          ['private'],
          ['visibility', 'open'],
          ['closed'],
          ['t', 'forum'],
          ['channel_type', 'stream'],
        ],
      }),
    ).toMatchObject({ visibility: 'private', channelType: 'forum' });
  });

  it('binds the relay-assigned channel, upgrades the bot role, and converges', async () => {
    const h = harness();
    const first = await bootstrapExistingRelay(h.config, { buzz: h.buzz, dkg: h.dkg });
    const second = await bootstrapExistingRelay(h.config, { buzz: h.buzz, dkg: h.dkg });
    expect(first).toMatchObject({
      phase: 'complete',
      channelId,
      actions: {
        channel: 'created',
        serviceMembership: 'added',
        serviceProfile: 'published',
        contextGraph: 'created',
      },
    });
    expect(second.actions).toEqual({
      channel: 'existing',
      serviceMembership: 'existing',
      serviceProfile: 'existing',
      contextGraph: 'existing',
    });
    expect(h.calls).toEqual({ createChannel: 1, addBot: 1, publishProfile: 1, createGraph: 1 });
    expect(JSON.parse(readFileSync(h.config.bindingsPath, 'utf8'))[0]).toMatchObject({ channelId });
  });

  it('resumes the provisional identity after a partial DKG failure', async () => {
    const h = harness();
    let failOnce = true;
    const dkg = {
      ...h.dkg,
      async createContextGraph(config) {
        if (failOnce) {
          failOnce = false;
          throw new Error('DKG unavailable');
        }
        return h.dkg.createContextGraph(config);
      },
    };
    await expect(bootstrapExistingRelay(h.config, { buzz: h.buzz, dkg })).rejects.toThrow(/unavailable/);
    expect(JSON.parse(readFileSync(h.config.statePath, 'utf8'))).toMatchObject({ phase: 'provisional', channelId });
    await expect(bootstrapExistingRelay(h.config, { buzz: h.buzz, dkg })).resolves.toMatchObject({ phase: 'complete', channelId });
    expect(h.calls.createChannel).toBe(1);
  });

  it('fails closed when Context Graph creation is not visible on read-back', async () => {
    const h = harness();
    const dkg = { ...h.dkg, createContextGraph: async () => ({ accepted: true }) };
    await expect(bootstrapExistingRelay(h.config, { buzz: h.buzz, dkg })).rejects.toThrow(/not visible/);
  });

  it('rejects a binding conflict before membership, profile, or DKG mutation', async () => {
    const h = harness();
    h.channels.push({
      id: channelId,
      name: h.config.channelName,
      visibility: h.config.channelVisibility,
      channelType: h.config.channelType,
      archived: false,
    });
    writeFileSync(
      h.config.bindingsPath,
      `${JSON.stringify([
        {
          channelId,
          contextGraphId: 'different-context-graph',
          promoters: [ownerPubkey],
        },
      ])}\n`,
    );

    await expect(
      bootstrapExistingRelay(h.config, { buzz: h.buzz, dkg: h.dkg }),
    ).rejects.toThrow(/already bound/);
    expect(h.calls).toEqual({
      createChannel: 0,
      addBot: 0,
      publishProfile: 0,
      createGraph: 0,
    });
  });

  it('rejects a requested graph conflict before creating a Buzz channel', async () => {
    const h = harness();
    h.config.requestedContextGraphId = 'shared-context-graph';
    writeFileSync(
      h.config.bindingsPath,
      `${JSON.stringify([
        {
          channelId: '2e3db7ae-0964-4cbf-88e1-6544a96a134d',
          contextGraphId: 'shared-context-graph',
          promoters: [ownerPubkey],
        },
      ])}\n`,
    );

    await expect(
      bootstrapExistingRelay(h.config, { buzz: h.buzz, dkg: h.dkg }),
    ).rejects.toThrow(/already bound/);
    expect(h.calls).toEqual({
      createChannel: 0,
      addBot: 0,
      publishProfile: 0,
      createGraph: 0,
    });
  });

  it('rejects same-named channel visibility drift before side effects', async () => {
    const h = harness();
    h.channels.push({
      id: channelId,
      name: h.config.channelName,
      visibility: 'private',
      channelType: 'stream',
      archived: false,
    });
    await expect(
      bootstrapExistingRelay(h.config, { buzz: h.buzz, dkg: h.dkg }),
    ).rejects.toThrow(/visibility 'private'.*expected 'open'/);
    expect(h.calls).toEqual({
      createChannel: 0,
      addBot: 0,
      publishProfile: 0,
      createGraph: 0,
    });
  });

  it.each([
    [{ channelType: 'forum', archived: false }, /type 'forum'.*expected 'stream'/],
    [{ channelType: 'stream', archived: true }, /channel is archived/],
  ])('rejects incompatible same-named channel shape before side effects', async (shape, error) => {
    const h = harness();
    h.channels.push({
      id: channelId,
      name: h.config.channelName,
      visibility: h.config.channelVisibility,
      ...shape,
    });
    await expect(
      bootstrapExistingRelay(h.config, { buzz: h.buzz, dkg: h.dkg }),
    ).rejects.toThrow(error);
    expect(h.calls).toEqual({
      createChannel: 0,
      addBot: 0,
      publishProfile: 0,
      createGraph: 0,
    });
  });

  it('rejects an invalid Context Graph access policy before side effects', () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'bdi-existing-config-'));
    const tokenPath = join(runtimeDir, 'auth.token');
    writeFileSync(tokenPath, 'token\n');
    expect(() =>
      loadExistingRelayConfig({
        BDI_RUNTIME_DIR_IN_CONTAINER: runtimeDir,
        BDI_DKG_TOKEN_PATH: tokenPath,
        BDI_BUZZ_HTTP: 'https://community.example.com',
        BDI_BUZZ_OWNER_KEY: '3'.repeat(64),
        BDI_SERVICE_KEY: '4'.repeat(64),
        BDI_CONTEXT_GRAPH_ACCESS_POLICY: 'private',
      }),
    ).toThrow(/must be 0.*or 1/);
  });
});
