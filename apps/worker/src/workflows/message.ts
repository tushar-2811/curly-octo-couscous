/**
 * MessageWorkflow: one per received message, id `message-<messageId>`, so a message is
 * never processed twice at once. Retries temporary model and database failures with
 * backoff; after the last attempt the message stays "needs review" and the sweep may
 * start it again later (apps/worker/src/sweep.ts).
 */
import { ActivityFailure, ApplicationFailure, log, proxyActivities } from '@temporalio/workflow';
import type { Activities, MessageOutcome } from '../activities';

const { sendReplies } = proxyActivities<Activities>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '3 seconds',
    backoffCoefficient: 2,
    maximumInterval: '1 minute',
    maximumAttempts: 8,
  },
});

const { processInboundMessage } = proxyActivities<Activities>({
  // Classification, embeddings and a reply draft, each with its own timeout.
  startToCloseTimeout: '2 minutes',
  retry: {
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    maximumInterval: '2 minutes',
    maximumAttempts: 6,
    nonRetryableErrorTypes: ['Engine:not_found', 'Engine:not_ai_employee'],
  },
});

export interface MessageInput {
  orgId: string;
  messageId: string;
}

export type MessageResult = MessageOutcome | { failed: true; reason: string };

export const messageWorkflowId = (messageId: string) => `message-${messageId}`;

export async function messageWorkflow(input: MessageInput): Promise<MessageResult> {
  try {
    const outcome = await processInboundMessage(input);
    log.info('message processed', { message_id: input.messageId, ...outcome });
    if (outcome.replies > 0) {
      const sent = await sendReplies(input);
      log.info('replies sent', { message_id: input.messageId, ...sent });
    }
    return outcome;
  } catch (err) {
    const cause = err instanceof ActivityFailure ? err.cause : err;
    const reason =
      cause instanceof ApplicationFailure
        ? `${cause.type ?? 'error'}: ${cause.message}`
        : String(cause);
    log.error('message processing gave up', { message_id: input.messageId, reason });
    return { failed: true, reason };
  }
}
