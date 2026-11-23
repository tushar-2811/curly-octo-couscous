import { baseEnvSchema, databaseEnvSchema, loadConfig, z } from '@aiw/config';

export const webEnvSchema = baseEnvSchema
  .extend(databaseEnvSchema.shape)
  .extend({
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
