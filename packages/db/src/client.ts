import type { Logger } from '@aiw/logger';
import { Kysely, PostgresDialect, type LogEvent } from 'kysely';
import pg from 'pg';
import type { Database } from './schema';

export interface CreateDbOptions {
  connectionString: string;
  poolMax?: number;
  logger: Logger;
  /** Queries slower than this are logged as warnings. */
  slowQueryMs?: number;
}

/**
 * Create the shared Kysely instance. Query text is logged for errors and slow queries;
 * parameters are never logged because they can hold personal data or secrets.
 */
export function createDb(options: CreateDbOptions): Kysely<Database> {
  const slowQueryMs = options.slowQueryMs ?? 500;
  const log = options.logger.child({ component: 'db' });
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.poolMax ?? 10,
    application_name: 'ai-workforce',
  });
  pool.on('error', (err) => log.error({ err }, 'postgres pool error on idle client'));

  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    log(event: LogEvent) {
      const durationMs = Math.round(event.queryDurationMillis);
      if (event.level === 'error') {
        log.error(
          { err: event.error, sql: event.query.sql, duration_ms: durationMs },
          'database query failed',
        );
      } else if (durationMs >= slowQueryMs) {
        log.warn({ sql: event.query.sql, duration_ms: durationMs }, 'slow database query');
      }
    },
  });
}

/** Cheap connectivity check for readiness probes. */
export async function pingDb(db: Kysely<Database>): Promise<void> {
  await db.selectNoFrom((eb) => eb.lit(1).as('ok')).execute();
}
