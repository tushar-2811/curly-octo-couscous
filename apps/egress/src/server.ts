/**
 * egress: the only network path out of sandboxes. It will verify the execution JWT, apply
 * the allowlist, inject credentials per request and deny write routes (Core Orchestrator
 * design §19.5). Until Phase 3 it only reports health, so deployments and probes can be
 * set up now.
 */
import { createServer } from 'node:http';
import { baseEnvSchema, loadConfig, z } from '@aiw/config';
import { createLogger, resolveLogFormat } from '@aiw/logger';

const config = loadConfig(
  baseEnvSchema.extend({ EGRESS_PORT: z.coerce.number().int().positive().default(4100) }),
);
const logger = createLogger({
  service: 'egress',
  version: config.SERVICE_VERSION,
  env: config.APP_ENV,
  level: config.LOG_LEVEL,
  format: resolveLogFormat(config.LOG_FORMAT, config.NODE_ENV),
});

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    return;
  }
  logger.warn({ method: req.method, url: req.url }, 'egress route not implemented');
  res.writeHead(501, { 'content-type': 'application/json' }).end('{"code":"not_implemented"}');
});

server.listen(config.EGRESS_PORT, () =>
  logger.info({ port: config.EGRESS_PORT }, 'egress listening'),
);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down egress');
    server.close(() => logger.info('egress stopped'));
  });
}
