import { createHash } from 'node:crypto';
import { conversationsToDigest, staleMessages } from '@aiw/engine';
import type { Database, Kysely } from '@aiw/db';
import type { Logger } from '@aiw/logger';
import { type Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { WorkflowIdReusePolicy } from '@temporalio/common';

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

/**
 * Start a FactsWorkflow for each conversation that has been quiet for `quietSeconds` and
 * has messages fact extraction has not read. The id includes the newest message, so the
 * same batch is never read twice, even after a failure; a new message gives a new id.
 */
export async function sweepConversations(deps: {
  db: Kysely<Database>;
  client: Client;
  taskQueue: string;
  logger: Logger;
  quietSeconds: number;
}): Promise<number> {
  const ready = await conversationsToDigest(deps.db, deps.quietSeconds, 50);
  let started = 0;
  for (const c of ready) {
    const key = createHash('sha256').update(c.conversation_key).digest('hex').slice(0, 16);
    try {
      await deps.client.workflow.start('factsWorkflow', {
        workflowId: `facts-${c.employee_id}-${key}-${c.last_message_id}`,
        taskQueue: deps.taskQueue,
        args: [{ orgId: c.org_id, employeeId: c.employee_id, conversationKey: c.conversation_key }],
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      });
      started++;
    } catch (err) {
      if (err instanceof WorkflowExecutionAlreadyStartedError) continue;
      deps.logger.error({ err, employee_id: c.employee_id }, 'could not start facts workflow');
    }
  }
  if (started > 0) deps.logger.info({ ready: ready.length, started }, 'fact extraction sweep');
  return started;
}
