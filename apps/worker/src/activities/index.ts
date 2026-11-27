import { withTenant, type Database, type Kysely } from '@aiw/db';
import {
  EngineError,
  extractConversationFacts,
  GoogleApiError,
  processMessage,
  sendQueuedReplies,
  sendReply,
  type GoogleWorkspace,
  type Embedder,
  type JiraReader,
  type StructuredLlm,
} from '@aiw/engine';
import type { Logger } from '@aiw/logger';
import { ApplicationFailure } from '@temporalio/common';
import { continueOnboarding } from '@aiw/workforce';

export interface ActivityDeps {
  logger: Logger;
  /** Absent in tests that only exercise ping. */
  db?: Kysely<Database>;
  /** Message engine models; null when their keys are not set. */
  llm?: StructuredLlm | null;
  embedder?: Embedder | null;
  jira?: JiraReader | null;
  /** Google Chat, when set up: replies are posted as the employee. */
  google?: GoogleWorkspace | null;
}

export interface MessageOutcome {
  action: string;
  status: string;
  replies: number;
  alreadyDecided: boolean;
}

/** Activities get their dependencies injected, so tests can pass fakes. */
export function createActivities(deps: ActivityDeps) {
  const requireDb = () => {
    if (!deps.db) throw new Error('Database is not configured for this worker');
    return deps.db;
  };
  return {
    async ping(message: string): Promise<string> {
      deps.logger.info({ message }, 'ping activity');
      return `pong: ${message}`;
    },

    /**
     * Move a linked employee on to connecting its tools (identity_connected →
     * integrations_pending). Idempotent, so Temporal can retry it safely.
     */
    async continueOnboarding(input: { orgId: string; memberId: string }): Promise<string> {
      const state = await withTenant(requireDb(), input.orgId, (trx) =>
        continueOnboarding(
          trx,
          { orgId: input.orgId, actorMemberId: null, requestId: null },
          input.memberId,
        ),
      );
      deps.logger.info({ employee_id: input.memberId, state }, 'onboarding continued');
      return state;
    },

    /**
     * Classify, decide, remember and draft a reply for one received message. Safe to run
     * again: a decided message returns its decision. A temporary model failure throws, so
     * Temporal retries with backoff; the message stays "failed" (needs review) meanwhile.
     */
    async processInboundMessage(input: {
      orgId: string;
      messageId: string;
    }): Promise<MessageOutcome> {
      try {
        const result = await processMessage(
          {
            db: requireDb(),
            llm: deps.llm ?? null,
            embedder: deps.embedder ?? null,
            jira: deps.jira ?? null,
            logger: deps.logger,
            ...(deps.google
              ? {
                  deliverNow: (reply) =>
                    sendReply(
                      { db: requireDb(), google: deps.google!, logger: deps.logger },
                      input.orgId,
                      reply.id,
                    ),
                }
              : {}),
          },
          input.orgId,
          input.messageId,
        );
        if (result.message.status === 'failed') {
          throw ApplicationFailure.retryable(
            result.message.last_error ?? 'Message processing failed',
            'MessageRetry',
          );
        }
        return {
          action: result.decision.action,
          status: result.message.status,
          replies: result.replies.length,
          alreadyDecided: result.alreadyDecided,
        };
      } catch (err) {
        if (err instanceof EngineError) {
          // Retrying cannot fix a missing message or a recipient that is not an AI employee.
          throw ApplicationFailure.nonRetryable(err.message, `Engine:${err.code}`);
        }
        throw err;
      }
    },

    /**
     * Pull decisions, action items and other durable facts out of a quiet conversation.
     * A model failure throws so Temporal retries; the cursor only moves on success.
     */
    async extractFacts(input: {
      orgId: string;
      employeeId: string;
      conversationKey: string;
    }): Promise<{ read: number; added: number; superseded: number }> {
      if (!deps.llm) {
        throw ApplicationFailure.nonRetryable('No language model is configured', 'NoModel');
      }
      const result = await extractConversationFacts(
        { db: requireDb(), llm: deps.llm, embedder: deps.embedder ?? null, logger: deps.logger },
        input.orgId,
        input.employeeId,
        input.conversationKey,
      );
      return { read: result.read, added: result.added.length, superseded: result.superseded };
    },

    /**
     * Post a message's queued replies to Chat. Safe to retry: each reply is sent with its
     * own id as Chat's requestId. Temporary failures throw so Temporal tries again.
     */
    async sendReplies(input: {
      orgId: string;
      messageId: string;
    }): Promise<{ sent: number; failed: number }> {
      if (!deps.google) return { sent: 0, failed: 0 };
      try {
        return await sendQueuedReplies(
          { db: requireDb(), google: deps.google, logger: deps.logger },
          input.orgId,
          input.messageId,
        );
      } catch (err) {
        if (err instanceof GoogleApiError && !err.retryable) {
          throw ApplicationFailure.nonRetryable(err.message, `Google:${err.code}`);
        }
        throw err;
      }
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
