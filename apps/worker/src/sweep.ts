import { staleMessages } from '@aiw/engine';
import type { Database, Kysely } from '@aiw/db';
import type { Logger } from '@aiw/logger';
import { type Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';

/**
 * Start a MessageWorkflow for messages that never got one, or failed and are worth another
 * try. Runs every few minutes in the worker. Workflow ids make it safe to overlap with the
 * web process starting the same message.
 */
export async function sweepMessages(deps: {
  db: Kysely<Database>;
  client: Client;
  taskQueue: string;
  logger: Logger;
}): Promise<number> {
  const stale = await staleMessages(deps.db, 100);
  let started = 0;
  for (const m of stale) {
    try {
      await deps.client.workflow.start('messageWorkflow', {
        workflowId: `message-${m.message_id}`,
        taskQueue: deps.taskQueue,
        args: [{ orgId: m.org_id, messageId: m.message_id }],
      });
      started++;
    } catch (err) {
      if (err instanceof WorkflowExecutionAlreadyStartedError) continue;
      deps.logger.error({ err, message_id: m.message_id }, 'could not start message workflow');
    }
  }
  if (stale.length > 0) {
    deps.logger.info({ found: stale.length, started }, 'message sweep');
  }
  return started;
}
