import type { Logger } from '@aiw/logger';
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowFailedError,
} from '@temporalio/client';

/**
 * Hands a received message to the MessageWorkflow in the worker (apps/worker/src/workflows/
 * message.ts). The name and id format must match it. One workflow per message.
 */
export interface MessageDispatcher {
  /**
   * Start processing and wait up to `waitMs` for it. "done" when the workflow finished
   * (even if it gave up), "pending" when it is still running. Throws if Temporal is down.
   */
  process(orgId: string, messageId: string, waitMs: number): Promise<'done' | 'pending'>;
}

export const MESSAGE_WORKFLOW = 'messageWorkflow';
export const messageWorkflowId = (messageId: string) => `message-${messageId}`;

export class TemporalMessageDispatcher implements MessageDispatcher {
  private client: Promise<Client> | null = null;

  constructor(
    private readonly options: { address: string; namespace: string; taskQueue: string },
    private readonly logger: Logger,
  ) {}

  private getClient(): Promise<Client> {
    this.client ??= Connection.connect({
      address: this.options.address,
      connectTimeout: '5 seconds',
    })
      .then((connection) => new Client({ connection, namespace: this.options.namespace }))
      .catch((err: unknown) => {
        this.client = null;
        throw err;
      });
    return this.client;
  }

  async process(orgId: string, messageId: string, waitMs: number): Promise<'done' | 'pending'> {
    const client = await this.getClient();
    const workflowId = messageWorkflowId(messageId);
    let handle;
    try {
      handle = await client.workflow.start(MESSAGE_WORKFLOW, {
        workflowId,
        taskQueue: this.options.taskQueue,
        args: [{ orgId, messageId }],
      });
      this.logger.info(
        { message_id: messageId, workflow_id: workflowId },
        'message workflow started',
      );
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
      handle = client.workflow.getHandle(workflowId);
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'pending'>((resolve) => {
      timer = setTimeout(() => resolve('pending'), waitMs);
    });
    try {
      return await Promise.race([
        handle.result().then(
          () => 'done' as const,
          (err: unknown) => {
            if (err instanceof WorkflowFailedError) return 'done' as const;
            throw err;
          },
        ),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
