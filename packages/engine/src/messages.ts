import {
  asApp,
  sql,
  type Database,
  type InboundMessage,
  type Kysely,
  type MessageDecision,
  type MessageSource,
  type OutboundMessage,
  type SpaceType,
  type Tx,
} from '@aiw/db';

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
  if (inserted) {
    // Who is in which space decides what a reply there may use (memory.ts).
    if (
      inserted.sender_member_id &&
      (inserted.space_type === 'space' || inserted.space_type === 'group')
    ) {
      await trx
        .insertInto('knowledge.space_members')
        .values({
          org_id: input.orgId,
          employee_id: input.employeeId,
          space_name: inserted.space_name ?? `thread:${inserted.thread_key}`,
          member_id: inserted.sender_member_id,
        })
        .onConflict((oc) =>
          oc
            .columns(['employee_id', 'space_name', 'member_id'])
            .doUpdateSet({ last_seen_at: new Date() }),
        )
        .execute();
    }
    return { message: inserted, duplicate: false };
  }
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
  replies: OutboundMessage[];
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
  const replies =
    page.length === 0
      ? []
      : await trx
          .selectFrom('conversations.outbound_messages')
          .selectAll()
          .where(
            'in_reply_to',
            'in',
            page.map((m) => m.id),
          )
          .orderBy('id', 'asc')
          .execute();
  const latest = new Map(decisions.map((d) => [d.message_id, d] as const));
  return {
    entries: page.map((message) => ({
      message,
      decision: latest.get(message.id) ?? null,
      replies: replies.filter((r) => r.in_reply_to === message.id),
    })),
    nextCursor: rows.length > options.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** A message with its latest decision and its replies. */
export async function loadProcessed(trx: Tx, messageId: string): Promise<InboxEntry | null> {
  const message = await trx
    .selectFrom('conversations.inbound_messages')
    .selectAll()
    .where('id', '=', messageId)
    .executeTakeFirst();
  if (!message) return null;
  const [decision, replies] = await Promise.all([
    trx
      .selectFrom('conversations.message_decisions')
      .selectAll()
      .where('message_id', '=', messageId)
      .orderBy('id', 'desc')
      .executeTakeFirst(),
    trx
      .selectFrom('conversations.outbound_messages')
      .selectAll()
      .where('in_reply_to', '=', messageId)
      .orderBy('id')
      .execute(),
  ]);
  return { message, decision: decision ?? null, replies };
}

/** Messages to (re)process across all organizations: see migration 0012. */
export async function staleMessages(
  db: Kysely<Database>,
  max: number,
): Promise<{ org_id: string; message_id: string }[]> {
  return asApp(db, async (trx) => {
    const result = await sql<{ org_id: string; message_id: string }>`
      select org_id, message_id from app.stale_inbound_messages(${max})
    `.execute(trx);
    return result.rows;
  });
}
