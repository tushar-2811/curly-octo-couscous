import { z } from 'zod';

/**
 * Environment settings shared by every backend process (web, worker, egress).
 * Each process extends this with its own fields and calls `loadConfig` once at startup.
 * A bad or missing value stops the process with a message that names every problem.
 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['local', 'dev', 'staging', 'prod']).default('local'),
  SERVICE_VERSION: z.string().default('0.0.0-local'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** "pretty" for humans in local dev, "json" everywhere else. */
  LOG_FORMAT: z.enum(['pretty', 'json']).optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
});

export const databaseEnvSchema = z.object({
  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
});

export const temporalEnvSchema = z.object({
  TEMPORAL_ADDRESS: z.string().default('localhost:7233'),
  TEMPORAL_NAMESPACE: z.string().default('default'),
});

/** Models for the message engine (Phase 2). Each is off until its key is set. */
export const aiEnvSchema = z.object({
  /** Classifies messages and drafts replies. */
  OPENAI_API_KEY: z.string().trim().optional(),
  OPENAI_MODEL: z.string().trim().min(1).default('gpt-6-luna'),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
  /** Embeddings for memory search. Without it, memory is searched by words only. */
  VOYAGE_API_KEY: z.string().trim().optional(),
  VOYAGE_MODEL: z.string().trim().min(1).default('voyage-4'),
});

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly issues: string[],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Parse `env` with `schema`. Throws a ConfigError listing every invalid variable,
 * without echoing the values (they may be secrets).
 */
export function loadConfig<S extends z.ZodTypeAny>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid configuration: ${issues.join('; ')}`, issues);
  }
  return result.data;
}

export { z };
