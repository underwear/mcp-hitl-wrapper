import pino from 'pino';

// Always write to stderr (fd 2) — stdout is used by MCP stdio transport
const logger = pino({
  level: 'info',
  transport: { target: 'pino/file', options: { destination: 2 } },
});

export function configureLogger(opts: { level?: string; format?: string }) {
  // Mutate the existing logger instance so all child loggers inherit the change
  logger.level = opts.level ?? 'info';
}

export function getLogger(name?: string) {
  return name ? logger.child({ component: name }) : logger;
}

export { logger };
