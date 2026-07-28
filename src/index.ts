import { loadConfig } from './config.ts';
import { Daemon } from './daemon.ts';
import { logger } from './log.ts';

const daemon = new Daemon(loadConfig());

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

async function shutdown(sig: string): Promise<void> {
  logger.info('shutting down', { sig });
  await daemon.stop();
  process.exit(0);
}

daemon.start().catch((err) => {
  // `fetch failed` hides the real cause; surface err.cause.code (e.g.
  // ECONNREFUSED for a wrong BDI_DKG_API port) so the log matches the docs.
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  logger.error('daemon failed to start', {
    err: String(err),
    cause: cause?.code ?? cause?.message,
  });
  process.exit(1);
});
