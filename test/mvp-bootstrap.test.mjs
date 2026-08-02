import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bindingMappingKey,
  bootstrap,
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

  it('converges on one channel, one bot membership, and one context graph', async () => {
    const stateDir = tempDir();
    const channelId = '550e8400-e29b-41d4-a716-446655440000';
    const ownerPubkey = '1'.repeat(64);
    const servicePubkey = '2'.repeat(64);
    const promoterPubkey = '3'.repeat(64);
    const calls = { channelCreate: 0, addBot: 0, graphCreate: 0 };
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
          visibility: 'public',
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
    };
    const dkg = {
      async status() {
        return { version: '10.0.11' };
      },
      async exists(id) {
        return { id, exists: graphs.has(id) };
      },
      async create(id) {
        calls.graphCreate += 1;
        graphs.add(id);
        return { created: id };
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
      channelVisibility: 'open',
      channelDescription: 'test',
    };

    const first = await bootstrap(config, { buzz, dkg });
    const second = await bootstrap(config, { buzz, dkg });

    expect(first.actions).toMatchObject({
      channel: 'created',
      serviceMembership: 'added',
      contextGraph: 'created',
    });
    expect(second.actions).toMatchObject({
      channel: 'existing',
      serviceMembership: 'existing',
      contextGraph: 'existing',
    });
    expect(calls).toEqual({ channelCreate: 1, addBot: 1, graphCreate: 1 });
    expect(JSON.parse(readFileSync(config.bindingsPath, 'utf8'))).toEqual([
      {
        channelId,
        contextGraphId: defaultContextGraphId(config.buzzHttp, channelId),
        promoters: [promoterPubkey],
      },
    ]);
    expect(JSON.parse(readFileSync(config.statePath, 'utf8'))).toEqual({
      channelId,
      contextGraphId: defaultContextGraphId(config.buzzHttp, channelId),
      ownerPubkey,
      servicePubkey,
      promoterPubkeys: [promoterPubkey],
    });
  });
});
