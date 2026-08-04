#!/usr/bin/env node
// Usage shim: claude-agent-acp <-> buzz-acp.
//
// buzz-acp publishes kind-44200 NIP-AM turn metrics only from the goose-style
// `_goose/unstable/session/update` usage notification, which claude-agent-acp
// never emits — it returns usage inside the session/prompt RESPONSE instead.
// This stdio middleman spawns the real adapter, passes everything through
// byte-faithfully, and whenever a prompt response carries usage it FIRST
// injects the equivalent usage_update notification (cumulative semantics per
// crates/buzz-acp/src/usage.rs) so the standard 44200 pipeline fires.
//
// Provider-reported counts only — no self-report anywhere in the path.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { appendFileSync } from 'node:fs';
const DBG = process.env.SHIM_DEBUG;

const REAL = process.env.CLAUDE_ACP_REAL ?? `${homedir()}/.local/bin/claude-agent-acp`;
const child = spawn(REAL, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'inherit'] });

// stdin (buzz-acp -> adapter): pass through, but remember prompt request ids.
const promptSessions = new Map(); // request id -> sessionId
let inBuf = '';
process.stdin.on('data', (d) => {
  child.stdin.write(d);
  inBuf += d.toString();
  let nl;
  while ((nl = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, nl); inBuf = inBuf.slice(nl + 1);
    try {
      const m = JSON.parse(line);
      if (m.method === 'session/prompt' && m.id !== undefined) {
        promptSessions.set(m.id, m.params?.sessionId ?? null);
      }
    } catch { /* partial/non-JSON */ }
  }
});
process.stdin.on('end', () => child.stdin.end());

// stdout (adapter -> buzz-acp): inject usage notifications before responses.
const cum = new Map(); // sessionId -> {in, out, cached}
let outBuf = '';
child.stdout.on('data', (d) => {
  outBuf += d.toString();
  let nl;
  while ((nl = outBuf.indexOf('\n')) >= 0) {
    const line = outBuf.slice(0, nl); outBuf = outBuf.slice(nl + 1);
    let injected = null;
    try {
      const m = JSON.parse(line);
      if (DBG && m.id !== undefined && promptSessions.has(m.id)) appendFileSync(DBG, 'PROMPT-RESP: ' + line.slice(0, 600) + '\n');
      if (m.id !== undefined && promptSessions.has(m.id) && m.result && m.result.usage) {
        const sid = promptSessions.get(m.id);
        promptSessions.delete(m.id);
        const u = m.result.usage;
        const c = cum.get(sid) ?? { in: 0, out: 0, cached: 0 };
        // NIP-AM inputTokens is "inclusive of cache reads/writes" — sum all
        // input-side provider counts; cachedRead also reported separately.
        c.in += (u.inputTokens ?? 0) + (u.cachedReadTokens ?? 0) + (u.cachedWriteTokens ?? 0);
        c.out += u.outputTokens ?? 0;
        c.cached += u.cachedReadTokens ?? 0;
        cum.set(sid, c);
        injected = JSON.stringify({
          jsonrpc: '2.0',
          method: '_goose/unstable/session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'usage_update',
              accumulatedInputTokens: c.in,
              accumulatedOutputTokens: c.out,
              accumulatedCachedInputTokens: c.cached,
              accumulatedCost: null,
              model: m.result.modelId ?? m.result.model ?? 'claude',
            },
          },
        });
      }
    } catch { /* pass through untouched */ }
    if (injected) process.stdout.write(injected + '\n');
    process.stdout.write(line + '\n');
  }
});
child.on('exit', (code) => process.exit(code ?? 0));
