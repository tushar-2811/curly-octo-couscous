import { withLogContext, type Logger } from '@aiw/logger';
import { Context } from '@temporalio/activity';
import type {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
  Next,
} from '@temporalio/worker';
import { DefaultLogger, type LogEntry } from '@temporalio/worker';

/**
 * Wrap every activity so its log lines carry workflow_id, run_id, activity and attempt,
 * and so each activity logs one line when it finishes (info) or fails (warn while Temporal
 * will retry, error on the final attempt), with its duration.
 */
export class ActivityLoggingInterceptor implements ActivityInboundCallsInterceptor {
  constructor(private readonly logger: Logger) {}

  async execute(
    input: ActivityExecuteInput,
    next: Next<ActivityInboundCallsInterceptor, 'execute'>,
  ): Promise<unknown> {
    const info = Context.current().info;
    const context = {
      workflow_id: info.workflowExecution?.workflowId,
      run_id: info.workflowExecution?.runId,
      workflow_type: info.workflowType,
      activity: info.activityType,
      attempt: info.attempt,
      task_queue: info.taskQueue,
    };
    return withLogContext(context, async () => {
      const startedAt = performance.now();
      this.logger.debug('activity started');
      try {
        const result = await next(input);
        this.logger.info(
          { duration_ms: Math.round(performance.now() - startedAt) },
          'activity completed',
        );
        return result;
      } catch (err) {
        const maxAttempts = info.retryPolicy?.maximumAttempts ?? 0;
        const willRetry = maxAttempts === 0 || info.attempt < maxAttempts;
        const fields = {
          err,
          duration_ms: Math.round(performance.now() - startedAt),
          will_retry: willRetry,
        };
        if (willRetry) this.logger.warn(fields, 'activity failed; Temporal will retry');
        else this.logger.error(fields, 'activity failed on final attempt');
        throw err;
      }
    });
  }
}

const LEVEL_MAP = {
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
} as const;

/**
 * Route Temporal's own logs (SDK core and workflow `log.*` calls, which include
 * workflowId and runId in their metadata) into our structured logger.
 */
export function createTemporalLogger(
  logger: Logger,
  level: keyof typeof LEVEL_MAP = 'INFO',
): DefaultLogger {
  const child = logger.child({ component: 'temporal' });
  return new DefaultLogger(level, (entry: LogEntry) => {
    const meta = { ...entry.meta } as Record<string, unknown>;
    const fields: Record<string, unknown> = { ...meta };
    if (typeof meta.workflowId === 'string') fields.workflow_id = meta.workflowId;
    if (typeof meta.runId === 'string') fields.run_id = meta.runId;
    child[LEVEL_MAP[entry.level]](fields, entry.message);
  });
}
