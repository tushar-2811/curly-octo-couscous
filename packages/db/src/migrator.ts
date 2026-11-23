import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

const migrationFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export function createMigrator(db: Kysely<unknown>): Migrator {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder }),
    migrationTableSchema: 'platform',
    migrationTableName: 'schema_migrations',
    migrationLockTableName: 'schema_migrations_lock',
  });
}
