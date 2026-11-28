import type { Database, Kysely } from '@aiw/db';
import {
  chatEmployees,
  ensureChatSubscription,
  ensureGmailWatch,
  gmailEmployees,
  gmailNotification,
  GoogleApiError,
  handleChatEvent,
  handleGmailEvent,
  noteMailboxError,
  noteSubscriptionError,
  syncMailbox,
  type ChatDeps,
  type GoogleTokenBroker,
  type PulledMessage,
} from '@aiw/engine';
import type { Logger } from '@aiw/logger';
import { type Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';

const KEEP_ALIVE_MS = 10 * 60_000;
const MAX_PULL = 20;

type Auth = { orgId: string; employeeId: string };

const codeOf = (err: unknown) => (err instanceof GoogleApiError ? err.code : 'unknown');
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Google Chat and Gmail in the worker. Both publish to the same Pub/Sub topic:
 * - keep-alive (every 10 minutes): each employee's Chat subscription and Gmail watch are
 *   created or renewed, and each inbox is synced in case a notification was missed;
 * - the pull loop reads events, stores the messages and starts a MessageWorkflow for each.
 *   Events are acknowledged only after their messages are safely stored.
 *
 * Local testing pulls with the first linked employee's own sign-in (it was given Pub/Sub
 * Subscriber on the subscription). Production would pull with a service account.
 */
export class GoogleRunner {
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
    this.deps.logger.info(
      { subscription: this.deps.subscription },
      'google chat and gmail intake started',
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.keepTimer);
    await this.loop;
  }

  async keepAlive(): Promise<void> {
    await Promise.all([this.keepChat(), this.keepGmail()]);
  }

  /** Create, renew or reactivate each Chat employee's subscription. */
  private async keepChat(): Promise<void> {
    let employees: Auth[];
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
        this.deps.logger.error(
          { err, employee_id: auth.employeeId, code: codeOf(err) },
          'chat subscription keep-alive failed',
        );
        await noteSubscriptionError(this.deps, auth, messageOf(err)).catch(() => undefined);
      }
    }
  }

  /** Start or renew each Gmail watch, then sync the inbox in case a notification was lost. */
  private async keepGmail(): Promise<void> {
    let employees: Auth[];
    try {
      employees = await gmailEmployees(this.deps.db);
    } catch (err) {
      this.deps.logger.error({ err }, 'could not list gmail employees');
      return;
    }
    for (const auth of employees) {
      try {
        await ensureGmailWatch(this.deps, auth);
        const { messageIds } = await syncMailbox(this.deps, auth);
        for (const id of messageIds) await this.startWorkflow(auth.orgId, id);
      } catch (err) {
        this.deps.logger.error(
          { err, employee_id: auth.employeeId, code: codeOf(err) },
          'gmail keep-alive failed',
        );
        await noteMailboxError(this.deps, auth, messageOf(err)).catch(() => undefined);
      }
    }
  }

  /** Whose sign-in pulls from Pub/Sub: the first Chat employee, else the first Gmail one. */
  private async puller(): Promise<Auth | undefined> {
    return (await chatEmployees(this.deps.db))[0] ?? (await gmailEmployees(this.deps.db))[0];
  }

  private async handle(p: PulledMessage): Promise<{ auth: Auth | null; messageIds: string[] }> {
    const note = gmailNotification(p);
    if (note) return handleGmailEvent(this.deps, note);
    return handleChatEvent(
      this.deps,
      p,
      async (auth) => (await this.deps.broker.get(auth.orgId, auth.employeeId)).googleUserId,
    );
  }

  private async pullLoop(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      try {
        const puller = await this.puller();
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
            const r = await this.handle(p);
            for (const id of r.messageIds) {
              if (r.auth) await this.startWorkflow(r.auth.orgId, id);
            }
            done.push(p.ackId);
          } catch (err) {
            // Not acknowledged: Pub/Sub delivers it again shortly.
            this.deps.logger.error(
              { err, event_id: p.message.messageId, code: codeOf(err) },
              'google event failed; it will be delivered again',
            );
          }
        }
        await this.deps.google.ack(puller, this.deps.subscription, done);
      } catch (err) {
        failures++;
        const wait = Math.min(60_000, 1000 * 2 ** Math.min(failures, 6));
        this.deps.logger.error(
          { err, retry_in_ms: wait, code: codeOf(err) },
          'pulling google events failed',
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
