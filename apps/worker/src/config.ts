import { baseEnvSchema, databaseEnvSchema, loadConfig, temporalEnvSchema, z } from '@aiw/config';

export const TASK_QUEUE_WORKFLOWS = 'wf';

export const workerEnvSchema = baseEnvSchema
  .extend(temporalEnvSchema.shape)
  .extend(databaseEnvSchema.shape)
  .extend({
    TEMPORAL_TASK_QUEUE: z.string().default(TASK_QUEUE_WORKFLOWS),
  });

export type WorkerConfig = z.infer<typeof workerEnvSchema>;

export function loadWorkerConfig(env?: Record<string, string | undefined>): WorkerConfig {
  return loadConfig(workerEnvSchema, env);
}
