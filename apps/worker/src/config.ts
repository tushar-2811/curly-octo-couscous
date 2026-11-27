import {
  aiEnvSchema,
  baseEnvSchema,
  databaseEnvSchema,
  googleEnvSchema,
  loadConfig,
  temporalEnvSchema,
  z,
} from '@aiw/config';

export const TASK_QUEUE_WORKFLOWS = 'wf';

export const workerEnvSchema = baseEnvSchema
  .extend(temporalEnvSchema.shape)
  .extend(databaseEnvSchema.shape)
  .extend(aiEnvSchema.shape)
  .extend(googleEnvSchema.shape)
  .extend({
    TEMPORAL_TASK_QUEUE: z.string().default(TASK_QUEUE_WORKFLOWS),
    /** How often to look for messages that were never processed or should be retried. */
    MESSAGE_SWEEP_SECONDS: z.coerce.number().int().min(10).max(3600).default(120),
    /** A conversation quiet this long gets its facts extracted. */
    FACT_QUIET_MINUTES: z.coerce.number().int().min(1).max(1440).default(10),
  });

export type WorkerConfig = z.infer<typeof workerEnvSchema>;

export function loadWorkerConfig(env?: Record<string, string | undefined>): WorkerConfig {
  return loadConfig(workerEnvSchema, env);
}
