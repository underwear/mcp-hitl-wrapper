import pino from 'pino';

let logger = pino({
  level: 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino/file', options: { destination: 2 } }
      : undefined,
});

export function configureLogger(opts: { level?: string; format?: string }) {
  logger = pino({
    level: opts.level ?? 'info',
    ...(opts.format === 'pretty'
      ? { transport: { target: 'pino-pretty', options: { destination: 2 } } }
      : {}),
  });
}

export function getLogger(name?: string) {
  return name ? logger.child({ component: name }) : logger;
}

export { logger };
