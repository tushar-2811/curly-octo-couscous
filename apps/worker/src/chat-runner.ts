import type { Database, Kysely } from '@aiw/db';
import {
  chatEmployees,
  ensureChatSubscription,
  GoogleApiError,
  handleChatEvent,
  noteSubscriptionError,
  type ChatDeps,
  type GoogleTokenBroker,
} from '@aiw/engine';
import type { Logger } from '@aiw/logger';
import { type Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';

const KEEP_ALIVE_MS = 10 * 60_000;
const MAX_PULL = 20;

/**
 * Google Chat in the worker: keeps each employee's Workspace Events subscription alive,
 * pulls Chat events from Pub/Sub, stores the messages and starts a MessageWorkflow for
 * each. Events are acknowledged only after the message is safely stored.
 *
 * Local testing pulls with the first Chat employee's own sign-in (it was given Pub/Sub
 * Subscriber on the subscription). Production would pull with a service account.
 */
export class ChatRunner {
  private stopped = false;
  private keepTimer: NodeJS.Timeout | undefined;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly deps: ChatDeps & {
      broker: GoogleTokenBroker;
      client: Client;
      taskQueue: string;
      logger: Logger;
      db: Kysely<Database>;
    },
  ) {}

  start(): void {
    void this.keepAlive();
    this.keepTimer = setInterval(() => void this.keepAlive(), KEEP_ALIVE_MS);
    this.loop = this.pullLoop();
    this.deps.logger.info({ subscription: this.deps.subscription }, 'chat intake started');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.keepTimer);
    await this.loop;
  }

  /** Create, renew or reactivate each Chat employee's subscription. */
  async keepAlive(): Promise<void> {
    let employees;
    try {
      employees = await chatEmployees(this.deps.db);
    } catch (err) {
      this.deps.logger.error({ err }, 'could not list chat employees');
      return;
    }
    for (const auth of employees) {
      try {
        await ensureChatSubscription(this.deps, auth);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.deps.logger.error(
          {
            err,
            employee_id: auth.employeeId,
            code: err instanceof GoogleApiError ? err.code : 'unknown',
          },
          'chat subscription keep-alive failed',
        );
        await noteSubscriptionError(this.deps, auth, msg).catch(() => undefined);
      }
    }
  }

  private async pullLoop(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      try {
        const employees = await chatEmployees(this.deps.db);
        const puller = employees[0];
        if (!puller) {
          await this.sleep(30_000);
          continue;
        }
        const pulled = await this.deps.google.pull(puller, this.deps.subscription, MAX_PULL);
        failures = 0;
        if (pulled.length === 0) continue;
        const done: string[] = [];
        for (const p of pulled) {
          try {
            const r = await handleChatEvent(
              this.deps,
              p,
              async (auth) =>
                (await this.deps.broker.get(auth.orgId, auth.employeeId)).googleUserId,
            );
            for (const id of r.messageIds) {
              if (r.auth) await this.startWorkflow(r.auth.orgId, id);
            }
            done.push(p.ackId);
          } catch (err) {
            // Not acknowledged: Pub/Sub delivers it again shortly.
            this.deps.logger.error(
              {
                err,
                event_id: p.message.messageId,
                code: err instanceof GoogleApiError ? err.code : 'unknown',
              },
              'chat event failed; it will be delivered again',
            );
          }
        }
        await this.deps.google.ack(puller, this.deps.subscription, done);
      } catch (err) {
        failures++;
        const wait = Math.min(60_000, 1000 * 2 ** Math.min(failures, 6));
        this.deps.logger.error(
          { err, retry_in_ms: wait, code: err instanceof GoogleApiError ? err.code : 'unknown' },
          'pulling chat events failed',
        );
        await this.sleep(wait);
      }
    }
  }

  private async startWorkflow(orgId: string, messageId: string): Promise<void> {
    try {
      await this.deps.client.workflow.start('messageWorkflow', {
        workflowId: `message-${messageId}`,
        taskQueue: this.deps.taskQueue,
        args: [{ orgId, messageId }],
      });
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
