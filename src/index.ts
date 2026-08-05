import { loadConfig } from './config.ts';
import { Daemon } from './daemon.ts';
import { logger } from './log.ts';
import { QueryGateway } from './query-gateway/server.ts';

const config = loadConfig();
const daemon = new Daemon(config);
const queryGateway = config.queryGateway?.enabled
  ? new QueryGateway(config.queryGateway, config.bindings, daemon.dkg)
  : null;
let daemonStarted = false;
let shuttingDown = false;

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

async function shutdown(sig: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { sig });
  try {
    await queryGateway?.stop();
    await daemon.stop();
    process.exit(0);
  } catch (err) {
    logger.error('shutdown failed', { err: String(err) });
    process.exit(1);
  }
}

async function start(): Promise<void> {
  await daemon.start();
  daemonStarted = true;
  await queryGateway?.start();
}

start().catch(async (err) => {
  // `fetch failed` hides the real cause; surface err.cause.code (e.g.
  // ECONNREFUSED for a wrong BDI_DKG_API port) so the log matches the docs.
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  logger.error('daemon failed to start', {
    err: String(err),
    cause: cause?.code ?? cause?.message,
  });
  if (daemonStarted) await daemon.stop().catch(() => undefined);
  process.exit(1);
});
