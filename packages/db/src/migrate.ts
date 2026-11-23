/**
 * Migration CLI: `pnpm db:migrate` (up to latest), `pnpm db:migrate:down` (one step back),
 * `pnpm db:migrate:status`. Every step is logged; a failure exits non-zero.
 */
import { baseEnvSchema, databaseEnvSchema, loadConfig } from '@aiw/config';
import { createLogger, resolveLogFormat } from '@aiw/logger';
import { sql, type Kysely } from 'kysely';
import type { MigrationResultSet } from 'kysely/migration';
import { createDb } from './client';
import { createMigrator } from './migrator';

const config = loadConfig(baseEnvSchema.extend(databaseEnvSchema.shape));
const logger = createLogger({
  service: 'migrate',
  version: config.SERVICE_VERSION,
  env: config.APP_ENV,
  level: config.LOG_LEVEL,
  format: resolveLogFormat(config.LOG_FORMAT, config.NODE_ENV),
});

const command = process.argv[2] ?? 'up';

async function main(): Promise<void> {
  const db = createDb({ connectionString: config.DATABASE_URL, logger }) as Kysely<unknown>;
  try {
    // The migration table lives in the platform schema, which the first migration creates.
    await sql`create schema if not exists platform`.execute(db);
    const migrator = createMigrator(db);

    if (command === 'status') {
      const migrations = await migrator.getMigrations();
      for (const m of migrations) {
        logger.info(
          { migration: m.name, executed_at: m.executedAt ?? null },
          m.executedAt ? 'applied' : 'pending',
        );
      }
      return;
    }

    let resultSet: MigrationResultSet;
    if (command === 'up') resultSet = await migrator.migrateToLatest();
    else if (command === 'down') resultSet = await migrator.migrateDown();
    else throw new Error(`Unknown command "${command}". Use up, down or status.`);

    for (const result of resultSet.results ?? []) {
      const fields = { migration: result.migrationName, direction: result.direction };
      if (result.status === 'Success') logger.info(fields, 'migration applied');
      else if (result.status === 'Error') logger.error(fields, 'migration failed');
      else logger.warn(fields, 'migration not executed');
    }
    if (resultSet.error) throw resultSet.error;
    if (!resultSet.results?.length) logger.info('database already up to date');
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  logger.fatal({ err, command }, 'migration command failed');
  process.exitCode = 1;
});
