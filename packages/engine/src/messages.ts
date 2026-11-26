import type { InboundMessage, MessageDecision, MessageSource, SpaceType, Tx } from '@aiw/db';

export interface InboundInput {
  orgId: string;
  employeeId: string;
  source: MessageSource;
  externalId: string;
  threadKey: string | null;
  spaceName: string | null;
  spaceType: SpaceType | null;
  senderEmail: string | null;
  senderName: string | null;
  subject: string | null;
  body: string;
  mentions: string[];
  to: string[];
  cc: string[];
  sentAt: Date;
}

/** Longest body kept, in characters. Longer emails are cut and marked. */
export const MAX_BODY = 100_000;

/**
 * Store a received message once. A second delivery of the same provider id returns the
 * stored row with `duplicate: true` and changes nothing.
 */
export async function recordInbound(
  trx: Tx,
  input: InboundInput,
): Promise<{ message: InboundMessage; duplicate: boolean }> {
  const body =
    input.body.length > MAX_BODY
      ? `${input.body.slice(0, MAX_BODY - 20)}\n[…message cut]`
      : input.body;
  const senderEmail = input.senderEmail?.trim().toLowerCase() || null;
  const sender = senderEmail
    ? await trx
        .selectFrom('workforce.members')
        .select('id')
        .where('email', '=', senderEmail)
        .executeTakeFirst()
    : undefined;
  const inserted = await trx
    .insertInto('conversations.inbound_messages')
    .values({
      org_id: input.orgId,
      employee_id: input.employeeId,
      source: input.source,
      external_id: input.externalId,
      thread_key: input.threadKey,
      space_name: input.spaceName,
      space_type: input.spaceType,
      sender_email: senderEmail,
      sender_name: input.senderName,
      sender_member_id: sender?.id ?? null,
      subject: input.subject,
      body,
      mentions: input.mentions,
      to_addresses: input.to.map((a) => a.trim().toLowerCase()),
      cc_addresses: input.cc.map((a) => a.trim().toLowerCase()),
      sent_at: input.sentAt,
      last_error: null,
    })
    .onConflict((oc) => oc.columns(['employee_id', 'source', 'external_id']).doNothing())
    .returningAll()
    .executeTakeFirst();
  if (inserted) return { message: inserted, duplicate: false };
  const existing = await trx
    .selectFrom('conversations.inbound_messages')
    .selectAll()
    .where('employee_id', '=', input.employeeId)
    .where('source', '=', input.source)
    .where('external_id', '=', input.externalId)
    .executeTakeFirstOrThrow();
  return { message: existing, duplicate: true };
}

export interface InboxEntry {
  message: InboundMessage;
  decision: MessageDecision | null;
}

/** Newest first, keyset paging on the id, each with its latest decision. */
export async function listInbox(
  trx: Tx,
  employeeId: string,
  options: { before?: string; limit: number },
): Promise<{ entries: InboxEntry[]; nextCursor: string | null }> {
  let query = trx
    .selectFrom('conversations.inbound_messages')
    .selectAll()
    .where('employee_id', '=', employeeId);
  if (options.before) query = query.where('id', '<', options.before);
  const rows = await query
    .orderBy('id', 'desc')
    .limit(options.limit + 1)
    .execute();
  const page = rows.slice(0, options.limit);
  const decisions =
    page.length === 0
      ? []
      : await trx
          .selectFrom('conversations.message_decisions')
          .selectAll()
          .where(
            'message_id',
            'in',
            page.map((m) => m.id),
          )
          .orderBy('id', 'asc')
          .execute();
  const latest = new Map(decisions.map((d) => [d.message_id, d] as const));
  return {
    entries: page.map((message) => ({ message, decision: latest.get(message.id) ?? null })),
    nextCursor: rows.length > options.limit ? (page.at(-1)?.id ?? null) : null,
  };
}
