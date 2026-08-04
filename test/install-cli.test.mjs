import { describe, expect, it } from 'vitest';
import { parseArgs, relayEndpoints } from '../scripts/install.mjs';

describe('Buzz-first installer CLI', () => {
  it('derives matching HTTP and WebSocket relay origins', () => {
    expect(relayEndpoints('wss://community.example.com/some/path?ignored=1')).toEqual({
      http: 'https://community.example.com',
      ws: 'wss://community.example.com',
    });
    expect(relayEndpoints('http://127.0.0.1:9440')).toEqual({
      http: 'http://127.0.0.1:9440',
      ws: 'ws://127.0.0.1:9440',
    });
  });

  it('accepts explicit Buzz and DKG selections', () => {
    expect(
      parseArgs([
        'install',
        '--relay',
        'wss://community.example.com',
        '--dkg-role',
        'edge',
        '--dkg-api',
        'http://127.0.0.1:9200',
        '--yes',
      ]),
    ).toEqual({
      command: 'install',
      relay: 'wss://community.example.com',
      dkgRole: 'edge',
      dkgApi: 'http://127.0.0.1:9200',
      yes: true,
    });
  });

  it('rejects unsupported node roles and relay protocols', () => {
    expect(() => parseArgs(['install', '--dkg-role', 'validator'])).toThrow(
      '--dkg-role must be auto, edge, or core',
    );
    expect(() => relayEndpoints('ftp://community.example.com')).toThrow(
      'unsupported Buzz Relay URL protocol',
    );
  });
});
