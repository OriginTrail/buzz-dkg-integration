import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bindingMappingKey,
  bootstrap,
  contextGraphCreatePayload,
  defaultContextGraphId,
  mergeBinding,
  parseTokenFile,
} from '../scripts/mvp-bootstrap.mjs';

const createdDirs = [];

function tempDir() {
  const path = mkdtempSync(join(tmpdir(), 'bdi-mvp-bootstrap-'));
  createdDirs.push(path);
  return path;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    createdDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('M0 bootstrap', () => {
  it('derives a stable relay+channel graph identity', () => {
    const channel = '550e8400-e29b-41d4-a716-446655440000';
    expect(bindingMappingKey('HTTP://LOCALHOST:80/', channel)).toBe(
      bindingMappingKey('http://localhost', channel.toUpperCase()),
    );
    expect(defaultContextGraphId('http://localhost', channel)).toMatch(/^buzz-[0-9a-f]{64}$/);
  });

  it('parses the last non-comment DKG token line', () => {
    expect(parseTokenFile('# generated\n\nold\nnew-token\n')).toBe('new-token');
  });

  it('creates an off-chain-only Context Graph payload', () => {
    expect(
      contextGraphCreatePayload('buzz-test', {
        channelName: 'canary',
        channelId: '550e8400-e29b-41d4-a716-446655440000',
        channelVisibility: 'private',
      }),
    ).toMatchObject({
      id: 'buzz-test',
      accessPolicy: 1,
      publishPolicy: 0,
      register: false,
    });
  });

  it('rejects a context graph already assigned to another channel', () => {
    expect(() =>
      mergeBinding(
        [
          {
            channelId: '550e8400-e29b-41d4-a716-446655440000',
            contextGraphId: 'buzz/existing',
            promoters: [],
          },
        ],
        {
          channelId: '11111111-1111-4111-8111-111111111111',
          contextGraphId: 'buzz/existing',
          promoters: [],
        },
      ),
    ).toThrow(/already bound to another channel/);
  });

  it('converges a private channel with bot, promoter, and one context graph', async () => {
    const stateDir = tempDir();
    const channelId = '550e8400-e29b-41d4-a716-446655440000';
    const ownerPubkey = '1'.repeat(64);
    const servicePubkey = '2'.repeat(64);
    const promoterPubkey = '3'.repeat(64);
    const calls = { channelCreate: 0, addBot: 0, addMember: 0, graphCreate: 0 };
    const channels = [];
    const members = [];
    const graphs = new Set();

    const buzz = {
      async searchExact() {
        return channels;
      },
      async getChannel(id) {
        return channels.find((channel) => channel.channel_id === id) ?? null;
      },
      async createChannel() {
        calls.channelCreate += 1;
        channels.push({
          channel_id: channelId,
          name: 'buzz-dkg-canary',
          channel_type: 'stream',
          visibility: 'private',
          archived: false,
        });
        return { accepted: true, channel_id: channelId };
      },
      async members() {
        return members;
      },
      async addBot(_id, pubkey) {
        calls.addBot += 1;
        members.push({ pubkey, role: 'bot' });
        return { accepted: true };
      },
      async addMember(_id, pubkey) {
        calls.addMember += 1;
        members.push({ pubkey, role: 'member' });
        return { accepted: true };
      },
    };
    const dkg = {
      async status() {
        return { version: '10.0.11' };
      },
      async contextGraphExists(id) {
        return { id, exists: graphs.has(id) };
      },
      async createContextGraph(payload) {
        calls.graphCreate += 1;
        graphs.add(payload.id);
        return { created: payload.id };
      },
    };
    const config = {
      stateDir,
      statePath: join(stateDir, 'bootstrap.json'),
      bindingsPath: join(stateDir, 'bindings.json'),
      buzzHttp: 'http://127.0.0.1:9440',
      ownerPubkey,
      servicePubkey,
      promoterPubkeys: [promoterPubkey],
      channelName: 'buzz-dkg-canary',
      channelType: 'stream',
      channelVisibility: 'private',
      channelDescription: 'test',
      requestedContextGraphId: 'my-cg',
    };

    const first = await bootstrap(config, { buzz, dkg });
    const second = await bootstrap(config, { buzz, dkg });

    expect(first.actions).toMatchObject({
      channel: 'created',
      serviceMembership: 'added',
      promoterMemberships: [{ pubkey: promoterPubkey, action: 'added' }],
      contextGraph: 'created',
    });
    expect(second.actions).toMatchObject({
      channel: 'existing',
      serviceMembership: 'existing',
      promoterMemberships: [{ pubkey: promoterPubkey, action: 'existing' }],
      contextGraph: 'existing',
    });
    expect(calls).toEqual({ channelCreate: 1, addBot: 1, addMember: 1, graphCreate: 1 });
    expect(JSON.parse(readFileSync(config.bindingsPath, 'utf8'))).toEqual([
      {
        channelId,
        contextGraphId: 'my-cg',
        promoters: [promoterPubkey],
      },
    ]);
    expect(JSON.parse(readFileSync(config.statePath, 'utf8'))).toEqual({
      channelId,
      contextGraphId: 'my-cg',
      ownerPubkey,
      servicePubkey,
      promoterPubkeys: [promoterPubkey],
    });
  });

  it('rejects a requested graph collision before creating or mutating Buzz state', async () => {
    const stateDir = tempDir();
    const calls = { search: 0, createChannel: 0, addBot: 0, graph: 0 };
    const bindingsPath = join(stateDir, 'bindings.json');
    writeFileSync(
      bindingsPath,
      `${JSON.stringify([
        {
          channelId: '11111111-1111-4111-8111-111111111111',
          contextGraphId: 'my-cg',
          promoters: [],
        },
      ])}\n`,
    );
    const config = {
      stateDir,
      statePath: join(stateDir, 'bootstrap.json'),
      bindingsPath,
      buzzHttp: 'http://127.0.0.1:9440',
      ownerPubkey: '1'.repeat(64),
      servicePubkey: '2'.repeat(64),
      promoterPubkeys: [],
      channelName: 'buzz-dkg-canary',
      channelType: 'stream',
      channelVisibility: 'open',
      channelDescription: 'test',
      requestedContextGraphId: 'my-cg',
    };
    const buzz = {
      async searchExact() {
        calls.search += 1;
        return [];
      },
      async createChannel() {
        calls.createChannel += 1;
        return { accepted: true };
      },
      async addBot() {
        calls.addBot += 1;
        return { accepted: true };
      },
    };
    const dkg = {
      async status() {
        calls.graph += 1;
        return {};
      },
    };

    await expect(bootstrap(config, { buzz, dkg })).rejects.toThrow(/already bound/);
    expect(calls).toEqual({ search: 1, createChannel: 0, addBot: 0, graph: 0 });
  });
});
