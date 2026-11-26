import { baseEnvSchema, databaseEnvSchema, loadConfig, temporalEnvSchema, z } from '@aiw/config';

export const webEnvSchema = baseEnvSchema
  .extend(databaseEnvSchema.shape)
  .extend(temporalEnvSchema.shape)
  .extend({
    TEMPORAL_TASK_QUEUE: z.string().default('wf'),
    /** Where people open the dashboard. Google redirects back to it after sign-in. */
    DASHBOARD_URL: z.url().default('http://localhost:3000'),
    /** OAuth client from Google Cloud (Web application). Linking is off until both are set. */
    GOOGLE_CLIENT_ID: z.string().trim().optional(),
    GOOGLE_CLIENT_SECRET: z.string().trim().optional(),
    /** Encrypts refresh tokens at rest: 32 random bytes, base64. */
    TOKEN_ENCRYPTION_KEY: z.string().trim().optional(),
    /** Language model for classifying messages (Phase 2). Off until the key is set. */
    OPENAI_API_KEY: z.string().trim().optional(),
    OPENAI_MODEL: z.string().trim().min(1).default('gpt-6-luna'),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
    WEB_HOST: z.string().default('0.0.0.0'),
    WEB_PORT: z.coerce.number().int().positive().default(4000),
    /** Requests per minute per IP for the public client-log endpoint. */
    CLIENT_LOG_RATE_LIMIT: z.coerce.number().int().positive().default(120),
    /** Signs session cookies. At least 32 random characters; rotate by redeploying. */
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
    /** Email-only sign-in for local development. Refused outside APP_ENV=local. */
    AUTH_DEV_LOGIN: z.stringbool().default(false),
  })
  .superRefine((env, ctx) => {
    const google = Boolean(env.GOOGLE_CLIENT_ID) || Boolean(env.GOOGLE_CLIENT_SECRET);
    if (google && !env.GOOGLE_CLIENT_ID) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_CLIENT_ID'],
        message: 'Set it with GOOGLE_CLIENT_SECRET',
      });
    }
    if (google && !env.GOOGLE_CLIENT_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_CLIENT_SECRET'],
        message: 'Set it with GOOGLE_CLIENT_ID',
      });
    }
    if (google && Buffer.from(env.TOKEN_ENCRYPTION_KEY ?? '', 'base64').length !== 32) {
      ctx.addIssue({
        code: 'custom',
        path: ['TOKEN_ENCRYPTION_KEY'],
        message: 'Needed with Google sign-in: 32 random bytes, base64 (openssl rand -base64 32)',
      });
    }
    if (env.AUTH_DEV_LOGIN && env.APP_ENV !== 'local') {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_DEV_LOGIN'],
        message: 'Development sign-in can only be enabled when APP_ENV=local',
      });
    }
  });

export type WebConfig = z.infer<typeof webEnvSchema>;

export function loadWebConfig(env?: Record<string, string | undefined>): WebConfig {
  return loadConfig(webEnvSchema, env);
}
