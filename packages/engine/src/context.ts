import type { InboundMessage, Tx } from '@aiw/db';

/** One earlier line of the conversation, oldest first. */
export interface ContextLine {
  sender: string;
  text: string;
  at: Date;
  /** Written by the employee (one of its replies). */
  fromEmployee: boolean;
}

const MAX_MESSAGES = 8;
const WINDOW_MS = 2 * 60 * 60 * 1000;
const SNIPPET = 500;

const clip = (t: string) => (t.length > SNIPPET ? `${t.slice(0, SNIPPET)}…` : t);

/**
 * What came just before this message in the same conversation, so "this ticket" or "it"
 * can be understood: the same thread when there is one, otherwise the same space, or the
 * same direct conversation with this sender, over the last two hours. Includes the
 * employee's own replies. Only the conversation itself, so nothing crosses spaces.
 */
export async function loadConversation(
  trx: Tx,
  message: InboundMessage,
  employee: { id: string; name: string },
): Promise<ContextLine[]> {
  const since = new Date(new Date(message.received_at).getTime() - WINDOW_MS);
  let query = trx
    .selectFrom('conversations.inbound_messages')
    .select(['id', 'sender_name', 'sender_email', 'sender_member_id', 'body', 'received_at'])
    .where('employee_id', '=', employee.id)
    .where('id', '<', message.id)
    .where('received_at', '>=', since);
  if (message.thread_key) {
    query = query.where('thread_key', '=', message.thread_key);
  } else if (message.space_type === 'direct') {
    query = query.where('space_type', '=', 'direct');
    query = message.sender_member_id
      ? query.where('sender_member_id', '=', message.sender_member_id)
      : query.where('sender_email', '=', message.sender_email ?? '');
  } else if (message.space_name) {
    query = query.where('space_name', '=', message.space_name);
  } else {
    return [];
  }
  const earlier = (await query.orderBy('id', 'desc').limit(MAX_MESSAGES).execute()).reverse();
  if (earlier.length === 0) return [];

  const replies = await trx
    .selectFrom('conversations.outbound_messages')
    .select(['in_reply_to', 'body', 'created_at'])
    .where(
      'in_reply_to',
      'in',
      earlier.map((m) => m.id),
    )
    .where('kind', '=', 'reply')
    .where('status', '<>', 'failed')
    .execute();

  const lines: ContextLine[] = [];
  for (const m of earlier) {
    lines.push({
      sender: m.sender_name ?? m.sender_email ?? 'Someone',
      text: clip(m.body),
      at: new Date(m.received_at),
      fromEmployee: m.sender_member_id === employee.id,
    });
    for (const r of replies.filter((x) => x.in_reply_to === m.id)) {
      lines.push({
        sender: employee.name,
        text: clip(r.body),
        at: new Date(r.created_at),
        fromEmployee: true,
      });
    }
  }
  return lines;
}
