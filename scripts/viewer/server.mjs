// Read-only live channel viewer for demos: serves a single page on
// 127.0.0.1:9460 and proxies relay reads (NIP-98-signed) so the browser can
// watch a Buzz channel without holding any keys. Localhost + throwaway spike
// identities only.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const phase0 = join(here, '../../phase0');
const { BuzzClient } = await import(join(phase0, 'bridge/lib/nostr.mjs'));

const env = {};
for (const line of readFileSync(join(phase0, '.env.spike'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const client = new BuzzClient({
  baseUrl: process.env.BDI_BUZZ_HTTP || 'http://127.0.0.1:9440',
  secretKeyHex: env.BDI_SPIKE_SERVICE_KEY,
});

const NAMES = {
  [env.BDI_SPIKE_AUTHOR_PUB]: { name: 'Alice (author)', color: '#7aa2f7' },
  [env.BDI_SPIKE_MEMBER_PUB]: { name: 'Bob (member)', color: '#9ece6a' },
  [env.BDI_SPIKE_PROMOTER_PUB]: { name: 'Petra (promoter)', color: '#e0af68' },
  [env.BDI_SPIKE_SERVICE_PUB]: { name: '@dkg (integration daemon)', color: '#bb9af7' },
};

const html = readFileSync(join(here, 'index.html'));

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(html);
    }
    if (url.pathname === '/api/channel') {
      const channel = url.searchParams.get('id');
      const msgs = await client.query([{ kinds: [9, 40002, 40004], '#h': [channel], limit: 200 }]);
      const ids = msgs.map((e) => e.id);
      const reactions = ids.length ? await client.query([{ kinds: [7], '#e': ids }]) : [];
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ events: [...msgs, ...reactions], names: NAMES }));
    }
    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(e.message) }));
  }
}).listen(9460, '127.0.0.1', () => console.log('viewer on http://127.0.0.1:9460/?id=<channel-uuid>'));
