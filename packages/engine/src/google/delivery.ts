import { withTenant, type Database, type Kysely, type OutboundMessage } from '@aiw/db';
import type { Logger } from '@aiw/logger';
import { postChatReply } from './chat';
import { GoogleApiError } from './errors';
import { sendEmailReply } from './gmail';
import type { GoogleWorkspace } from './workspace';

type DeliveryDeps = { db: Kysely<Database>; google: GoogleWorkspace; logger: Logger };

const CHANNEL = { google_chat: 'chat', gmail: 'email' } as const;

/**
 * Send one queued reply where its message came from: Chat or email. Safe to repeat (each
 * channel finds a reply it already sent). Retryable failures throw; others mark the reply
 * failed. Test messages and replies already sent are left as they are.
 */
export async function sendReply(
  deps: DeliveryDeps,
  orgId: string,
  replyId: string,
): Promise<OutboundMessage> {
  const { reply, inbound } = await withTenant(deps.db, orgId, async (trx) => {
    const reply = await trx
      .selectFrom('conversations.outbound_messages')
      .selectAll()
      .where('id', '=', replyId)
      .executeTakeFirstOrThrow();
    const inbound = await trx
      .selectFrom('conversations.inbound_messages')
      .select([
        'source',
        'space_name',
        'space_type',
        'reply_thread',
        'sender_email',
        'sender_name',
        'subject',
        'email_message_id',
        'email_references',
      ])
      .where('id', '=', reply.in_reply_to)
      .executeTakeFirstOrThrow();
    return { reply, inbound };
  });
  if (reply.status !== 'queued' || inbound.source === 'simulated') return reply;
  const channel = CHANNEL[inbound.source];
  const auth = { orgId, employeeId: reply.employee_id };
  const started = performance.now();
  try {
    const out =
      inbound.source === 'gmail'
        ? await sendEmailReply(deps, auth, reply, inbound)
        : await postChatReply(deps, auth, reply, inbound);
    const sent = await withTenant(deps.db, orgId, (trx) =>
      trx
        .updateTable('conversations.outbound_messages')
        .set({ status: 'sent', sent_at: new Date(), external_id: out.externalId, error_code: null })
        .where('id', '=', reply.id)
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
    deps.logger.info(
      {
        reply_id: reply.id,
        kind: reply.kind,
        channel,
        external_id: out.externalId,
        already_sent: out.alreadySent,
        send_ms: Math.round(performance.now() - started),
      },
      `reply sent by ${channel}`,
    );
    return sent;
  } catch (err) {
    const code = err instanceof GoogleApiError ? err.code : 'unknown';
    deps.logger.error(
      { err, reply_id: reply.id, channel, code },
      `sending reply by ${channel} failed`,
    );
    if (err instanceof GoogleApiError && err.retryable) throw err;
    return withTenant(deps.db, orgId, (trx) =>
      trx
        .updateTable('conversations.outbound_messages')
        .set({ status: 'failed', error_code: `${channel}_${code}` })
        .where('id', '=', reply.id)
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }
}

/** Send every queued reply for a message, oldest first. */
export async function sendQueuedReplies(
  deps: DeliveryDeps,
  orgId: string,
  messageId: string,
): Promise<{ sent: number; failed: number }> {
  const queued = await withTenant(deps.db, orgId, (trx) =>
    trx
      .selectFrom('conversations.outbound_messages')
      .select('id')
      .where('in_reply_to', '=', messageId)
      .where('status', '=', 'queued')
      .orderBy('id')
      .execute(),
  );
  let sent = 0;
  let failed = 0;
  for (const q of queued) {
    const r = await sendReply(deps, orgId, q.id);
    if (r.status === 'sent') sent++;
    else if (r.status === 'failed') failed++;
  }
  return { sent, failed };
}
