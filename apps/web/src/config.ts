import { baseEnvSchema, databaseEnvSchema, loadConfig, z } from '@aiw/config';

export const webEnvSchema = baseEnvSchema.extend(databaseEnvSchema.shape).extend({
  WEB_HOST: z.string().default('0.0.0.0'),
  WEB_PORT: z.coerce.number().int().positive().default(4000),
  /** Requests per minute per IP for the public client-log endpoint. */
  CLIENT_LOG_RATE_LIMIT: z.coerce.number().int().positive().default(120),
});

export type WebConfig = z.infer<typeof webEnvSchema>;

export function loadWebConfig(env?: Record<string, string | undefined>): WebConfig {
  return loadConfig(webEnvSchema, env);
}
