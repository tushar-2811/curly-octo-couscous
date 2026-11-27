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
  /** Read-only Jira Cloud. On when the URL, email and API token are all set. */
  JIRA_BASE_URL: z.url().optional(),
  ATLASSIAN_EMAIL: z.email().optional(),
  ATLASSIAN_ACCESS_TOKEN: z.string().trim().optional(),
  /** Comma-separated project keys the employees may read, e.g. "PF". Empty: all. */
  JIRA_PROJECTS: z
    .string()
    .trim()
    .regex(/^([A-Z][A-Z0-9_]*)?(,\s*[A-Z][A-Z0-9_]*)*$/, 'Use project keys like PF,WEB')
    .optional(),
});

/**
 * Google Workspace for AI employees: OAuth client, token encryption, and Chat intake.
 * Chat is on when the project, topic and subscription are set as well.
 */
export const googleEnvSchema = z.object({
  GOOGLE_CLIENT_ID: z.string().trim().optional(),
  GOOGLE_CLIENT_SECRET: z.string().trim().optional(),
  /** Encrypts refresh tokens at rest: 32 random bytes, base64. */
  TOKEN_ENCRYPTION_KEY: z.string().trim().optional(),
  GOOGLE_CLOUD_PROJECT: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, 'Use the project ID, e.g. my-project-123456')
    .optional(),
  /** Pub/Sub topic Chat events are published to (ID within the project). */
  CHAT_EVENTS_TOPIC: z.string().trim().min(1).optional(),
  /** Pull subscription on that topic the worker reads. */
  CHAT_EVENTS_SUBSCRIPTION: z.string().trim().min(1).optional(),
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
