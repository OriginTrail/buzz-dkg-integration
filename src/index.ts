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
  logger.error('daemon failed to start', { err: String(err) });
  process.exit(1);
});
