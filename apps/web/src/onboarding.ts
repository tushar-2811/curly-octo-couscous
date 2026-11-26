import type { Logger } from '@aiw/logger';
import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';

/**
 * Tells the OnboardingWorkflow (in worker) what happened. Names must match
 * apps/worker/src/workflows/onboarding.ts. One workflow per employee.
 */
export interface OnboardingSignals {
  identityLinked(orgId: string, memberId: string): Promise<void>;
  identityDisconnected(memberId: string): Promise<void>;
}

export const ONBOARDING_WORKFLOW = 'onboardingWorkflow';
export const onboardingWorkflowId = (memberId: string) => `onboarding-${memberId}`;

export class TemporalOnboardingSignals implements OnboardingSignals {
  private client: Promise<Client> | null = null;

  constructor(
    private readonly options: { address: string; namespace: string; taskQueue: string },
    private readonly logger: Logger,
  ) {}

  private getClient(): Promise<Client> {
    // Connect on first use, and again after a failed attempt.
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

  async identityLinked(orgId: string, memberId: string): Promise<void> {
    const client = await this.getClient();
    // Starts the workflow if it is not running, then delivers the signal.
    const handle = await client.workflow.signalWithStart(ONBOARDING_WORKFLOW, {
      workflowId: onboardingWorkflowId(memberId),
      taskQueue: this.options.taskQueue,
      args: [{ orgId, memberId }],
      signal: 'identityLinked',
      signalArgs: [],
    });
    this.logger.info(
      { employee_id: memberId, workflow_id: handle.workflowId },
      'onboarding workflow signalled: identity linked',
    );
  }

  async identityDisconnected(memberId: string): Promise<void> {
    const client = await this.getClient();
    try {
      await client.workflow
        .getHandle(onboardingWorkflowId(memberId))
        .signal('identityDisconnected');
      this.logger.info({ employee_id: memberId }, 'onboarding workflow signalled: disconnected');
    } catch (err) {
      // No running workflow: nothing to tell.
      if (err instanceof WorkflowNotFoundError) return;
      throw err;
    }
  }
}
