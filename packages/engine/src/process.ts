import {
  withTenant,
  type Database,
  type InboundMessage,
  type Kysely,
  type MemoryItem,
  type MessageDecision,
  type OutboundMessage,
} from '@aiw/db';
import type { Logger } from '@aiw/logger';
import { recordChange } from '@aiw/platform';
import { PROMPT_VERSION, type Classification } from './classification';
import {
  ACK_TEXT,
  ANSWER_PROMPT_VERSION,
  draftReply,
  fallbackReply,
  replyTask,
  type Evidence,
} from './answer';
import { classifyMessage } from './classifier';
import type { Embedder } from './embeddings';
import { loadConversation } from './context';
import { jiraEvidence } from './jira-evidence';
import { orgChartEvidence } from './org-chart';
import type { JiraReader } from './jira';
import { embedQuery, readersFor, rememberMessage, searchMemory } from './memory';
import { decide, DEFAULT_POLICY, type Decision, type DecisionPolicy } from './decide';
import { computeFacts, type AddressingFacts } from './facts';
import { LlmError, type LlmErrorCode, type StructuredLlm, type StructuredResult } from './llm';

export interface EngineDeps {
  db: Kysely<Database>;
  /** Null when no model is configured: messages are stored and decided without one. */
  llm: StructuredLlm | null;
  /** Null when no embedding key is set: memory is searched by words only. */
  embedder?: Embedder | null;
  /** Read-only Jira. Null when not configured: questions that need it say so. */
  jira?: JiraReader | null;
  /** Send a queued reply right away (Chat). Used for "Looking into it…" before slow work. */
  deliverNow?: (reply: OutboundMessage) => Promise<OutboundMessage>;
  logger: Logger;
  policy?: DecisionPolicy;
}

export interface ProcessResult {
  message: InboundMessage;
  decision: MessageDecision;
  facts: AddressingFacts;
  classification: Classification | null;
  corrections: string[];
  /** The memory item saved for this message, when it was worth keeping. */
  memory: MemoryItem | null;
  /** The "looking into it" note and the reply, oldest first. */
  replies: OutboundMessage[];
  /** True when the message had already been decided and nothing ran again. */
  alreadyDecided: boolean;
}

export class EngineError extends Error {
  constructor(
    public readonly code: 'not_found' | 'not_ai_employee',
    message: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

/**
 * Decide what an AI employee does with one received message: work out the addressing
 * facts, classify, apply the rules and save the decision. Safe to call again: a decided
 * message returns its decision; a failed one is tried again.
 */
export async function processMessage(
  deps: EngineDeps,
  orgId: string,
  messageId: string,
): Promise<ProcessResult> {
  const log = deps.logger.child({ message_id: messageId, org_id: orgId });
  const started = performance.now();

  const loaded = await withTenant(deps.db, orgId, async (trx) => {
    const message = await trx
      .selectFrom('conversations.inbound_messages')
      .selectAll()
      .where('id', '=', messageId)
      .executeTakeFirst();
    if (!message) throw new EngineError('not_found', 'Message not found');
    if (message.status === 'decided') {
      const decision = await trx
        .selectFrom('conversations.message_decisions')
        .selectAll()
        .where('message_id', '=', messageId)
        .orderBy('id', 'desc')
        .executeTakeFirstOrThrow();
      const replies = await trx
        .selectFrom('conversations.outbound_messages')
        .selectAll()
        .where('in_reply_to', '=', messageId)
        .orderBy('id')
        .execute();
      return { done: true as const, message, decision, replies };
    }
    const employee = await trx
      .selectFrom('workforce.members as m')
      .innerJoin('workforce.ai_profiles as p', 'p.member_id', 'm.id')
      .select(['m.id', 'm.display_name', 'm.email', 'm.title', 'p.role_key'])
      .where('m.id', '=', message.employee_id)
      .where('m.type', '=', 'ai')
      .executeTakeFirst();
    if (!employee) throw new EngineError('not_ai_employee', 'The recipient is not an AI employee');
    const [org, identities, thread] = await Promise.all([
      trx
        .selectFrom('workforce.organizations')
        .select('domain')
        .where('id', '=', orgId)
        .executeTakeFirstOrThrow(),
      trx
        .selectFrom('workforce.external_identities')
        .select(['email_address', 'provider_user_id'])
        .where('member_id', '=', employee.id)
        .where('connection_status', 'in', ['connected', 'reauth_required'])
        .execute(),
      loadConversation(trx, message, { id: employee.id, name: employee.display_name }),
    ]);
    await trx
      .updateTable('conversations.inbound_messages')
      .set({ status: 'processing' })
      .where('id', '=', messageId)
      .execute();
    return { done: false as const, message, employee, org, identities, thread };
  });

  if (loaded.done) {
    log.info({ action: loaded.decision.action }, 'message already decided');
    return {
      message: loaded.message,
      decision: loaded.decision,
      facts: loaded.decision.facts as unknown as AddressingFacts,
      classification: loaded.decision.classification as Classification | null,
      corrections: [],
      memory: null,
      replies: loaded.replies,
      alreadyDecided: true,
    };
  }

  const { message, employee, org, identities, thread } = loaded;
  const emails = [employee.email, ...identities.map((i) => i.email_address)].filter(
    (e): e is string => Boolean(e),
  );
  const facts = computeFacts(
    {
      source: message.source,
      spaceType: message.space_type,
      senderEmail: message.sender_email,
      body: message.body,
      subject: message.subject,
      mentions: message.mentions,
      to: message.to_addresses,
      cc: message.cc_addresses,
    },
    {
      memberId: employee.id,
      displayName: employee.display_name,
      emails,
      // Chat user ids are Google account ids: users/<sub>.
      chatUserIds: identities.map((i) => `users/${i.provider_user_id}`),
    },
    {
      orgDomain: org.domain,
      senderIsMember: message.sender_member_id !== null,
      inMyThread: thread.some((t) => t.fromEmployee),
    },
  );

  // Skip the model when the rules already decide without it.
  const skipModel = facts.from_self || (!facts.sender_is_member && !facts.sender_in_domain);
  let classification: Classification | null = null;
  let corrections: string[] = [];
  let call: StructuredResult | null = null;
  let errorCode: LlmErrorCode | null = null;
  let retryable = false;
  if (!skipModel && !deps.llm) {
    errorCode = 'not_configured';
    log.warn('no language model configured; deciding without a classification');
  } else if (!skipModel && deps.llm) {
    try {
      const result = await classifyMessage(deps.llm, {
        employee: { name: employee.display_name, role: employee.title ?? employee.role_key },
        message: {
          source: message.source,
          spaceType: message.space_type,
          senderName: message.sender_name ?? message.sender_email,
          subject: message.subject,
          body: message.body,
        },
        facts,
        thread: thread.map((t) => ({ sender: t.sender, text: t.text })),
      });
      ({ classification, corrections, call } = result);
      if (corrections.length > 0) log.info({ corrections }, 'classification corrected by facts');
    } catch (err) {
      if (!(err instanceof LlmError)) {
        await markFailed(deps, orgId, messageId, err);
        throw err;
      }
      errorCode = err.code;
      retryable = err.retryable;
      log.error({ err, code: err.code, retryable: err.retryable }, 'classification failed');
    }
  }

  let decision: Decision = decide(facts, classification, deps.policy ?? DEFAULT_POLICY);
  if (!deps.llm && (decision.action === 'reply' || decision.action === 'acknowledge')) {
    // Without a model nothing can be written; keep it rather than claim a reply.
    decision = {
      ...decision,
      action: 'remember',
      reasons: ['No model is configured, so it cannot reply; kept for memory', ...decision.reasons],
      ackFirst: false,
    };
  }

  const saved = await withTenant(deps.db, orgId, async (trx) => {
    const row = await trx
      .insertInto('conversations.message_decisions')
      .values({
        org_id: orgId,
        message_id: messageId,
        facts: JSON.stringify(facts),
        classification: classification ? JSON.stringify(classification) : null,
        action: decision.action,
        reasons: [...decision.reasons, ...corrections.map((c) => `Corrected: ${c}`)],
        needs: decision.needs,
        model: call?.model ?? (skipModel ? null : (deps.llm?.model ?? null)),
        prompt_version: skipModel ? null : PROMPT_VERSION,
        latency_ms: call?.latencyMs ?? null,
        input_tokens: call?.inputTokens ?? null,
        output_tokens: call?.outputTokens ?? null,
        error_code: errorCode,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const updated = await trx
      .updateTable('conversations.inbound_messages')
      .set({
        // A temporary model failure leaves the message to be tried again.
        status: retryable ? 'failed' : 'decided',
        last_error: errorCode ? `Classification failed: ${errorCode}` : null,
      })
      .where('id', '=', messageId)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (decision.action === 'decline') {
      await recordChange(
        trx,
        { orgId, actorMemberId: null, requestId: null },
        {
          action: 'message.declined',
          resourceType: 'member',
          resourceId: employee.id,
          details: { message_id: messageId, source: message.source, reason: decision.reasons[0] },
        },
      );
    }
    return { row, updated };
  });

  // Memory and the reply. A message left to retry gets them on the next attempt.
  const memoryDeps = { db: deps.db, embedder: deps.embedder ?? null, logger: log };
  const keep = !retryable && decision.action !== 'ignore' && decision.action !== 'decline';
  const wantsReply =
    !retryable &&
    deps.llm !== null &&
    (decision.action === 'reply' || decision.action === 'acknowledge');
  const queryText = [message.subject, message.body].filter(Boolean).join('\n');
  const [memory, vector] = await Promise.all([
    keep
      ? rememberMessage(memoryDeps, orgId, saved.updated).catch((err: unknown) => {
          log.error({ err }, 'could not save the message to memory');
          return null;
        })
      : Promise.resolve(null),
    wantsReply ? embedQuery(memoryDeps, queryText) : Promise.resolve(null),
  ]);

  let replies: OutboundMessage[] = [];
  if (wantsReply && deps.llm) {
    const outStatus: 'draft' | 'queued' = message.source === 'simulated' ? 'draft' : 'queued';
    const base = { org_id: orgId, employee_id: employee.id, in_reply_to: messageId };
    // Slow lookups ahead: save and send "Looking into it…" before doing them.
    // Email gets one complete reply; a separate "looking into it" email would be noise.
    const ackRows =
      decision.ackFirst && message.source !== 'gmail'
        ? await insertReplies(deps, orgId, [
            {
              ...base,
              kind: 'ack',
              body: ACK_TEXT,
              status: outStatus,
              answered: null,
              sources: '[]',
              model: null,
              latency_ms: null,
              input_tokens: null,
              output_tokens: null,
              error_code: null,
            },
          ])
        : [];
    if (deps.deliverNow && ackRows[0]?.status === 'queued') {
      try {
        ackRows[0] = await deps.deliverNow(ackRows[0]);
      } catch (err) {
        log.warn({ err }, 'could not send the "looking into it" note; carrying on with the reply');
      }
    }
    const readers = readersFor(saved.updated);
    const wantsOrgChart = decision.needs.includes('people_directory');
    const [memoryHits, jira, orgChart] = await Promise.all([
      withTenant(deps.db, orgId, (trx) =>
        searchMemory(trx, {
          employeeId: employee.id,
          readers,
          text: queryText,
          vector,
          excludeSourceIds: [messageId],
        }),
      ),
      jiraEvidence(deps.jira ?? null, {
        needed: decision.needs.includes('jira'),
        keys: classification?.references.jira_keys ?? [],
        text: queryText,
        summary: classification?.summary ?? null,
        ignore: employee.display_name.split(/\s+/),
        context: [...thread].reverse().map((t) => t.text),
        logger: log,
      }),
      wantsOrgChart
        ? withTenant(deps.db, orgId, (trx) =>
            orgChartEvidence(trx, {
              employeeId: employee.id,
              senderMemberId: message.sender_member_id,
              people: classification?.references.people ?? [],
              text: queryText,
            }),
          ).catch((err: unknown) => {
            log.error({ err }, 'org chart lookup failed; answering without it');
            return { items: [], notes: ['The org chart could not be read just now.'] };
          })
        : Promise.resolve({ items: [], notes: [] }),
    ]);
    if (wantsOrgChart) {
      log.info(
        {
          people: orgChart.items.filter((i) => i.kind === 'person').length,
          teams: orgChart.items.filter((i) => i.kind === 'team').length,
        },
        'org chart looked up',
      );
    }
    // The org chart and tickets first: they are the current state; memory is what people said.
    const evidence: Evidence[] = [
      ...orgChart.items,
      ...jira.items,
      ...memoryHits.map((h) => ({
        id: h.id,
        source: 'memory' as const,
        kind: h.kind,
        content: h.content,
        occurred_at: h.occurred_at,
      })),
    ];
    const task = replyTask(decision, classification);
    let row: Parameters<typeof insertReplies>[2][number];
    try {
      const draft = await draftReply(deps.llm, {
        employee: { name: employee.display_name, role: employee.title ?? employee.role_key },
        channel: message.source === 'gmail' ? 'email' : 'chat',
        senderName: message.sender_name ?? message.sender_email ?? 'Someone',
        where:
          message.space_type === 'email'
            ? `an email${message.subject ? ` with the subject "${message.subject}"` : ''}`
            : message.space_type === 'direct'
              ? 'direct message to you'
              : (message.space_name ?? 'a shared space'),
        body: queryText,
        thread: thread.map((t) => ({ sender: t.sender, text: t.text })),
        task,
        evidence,
        unavailable: decision.needs.filter(
          (n) => n !== 'memory' && n !== 'people_directory' && !(n === 'jira' && jira.available),
        ),
        notes: [...jira.notes, ...orgChart.notes],
      });
      row = {
        ...base,
        kind: 'reply',
        // Email carries a signature; Chat shows who sent it.
        body:
          message.source === 'gmail' ? `${draft.reply}\n\n${employee.display_name}` : draft.reply,
        status: outStatus,
        answered: draft.answered,
        sources: JSON.stringify(
          draft.used.map((u) => ({
            source: u.source,
            id: u.id,
            ...(u.label ? { label: u.label } : {}),
            ...(u.url ? { url: u.url } : {}),
            snippet: u.content.slice(0, 300),
          })),
        ),
        model: draft.call.model,
        latency_ms: draft.call.latencyMs,
        input_tokens: draft.call.inputTokens,
        output_tokens: draft.call.outputTokens,
        error_code: null,
      };
      log.info(
        {
          task,
          answered: draft.answered,
          evidence: evidence.length,
          jira_tickets: jira.items.length,
          used: draft.used.length,
          model_ms: draft.call.latencyMs,
          input_tokens: draft.call.inputTokens,
          output_tokens: draft.call.outputTokens,
          prompt_version: ANSWER_PROMPT_VERSION,
        },
        'reply drafted',
      );
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      // Say so rather than stay silent; the error code stays on the reply for the logs.
      log.error({ err, code: err.code }, 'could not draft a reply; sending a short fallback');
      const fallback = fallbackReply(err.code);
      row = {
        ...base,
        kind: 'reply',
        body: message.source === 'gmail' ? `${fallback}\n\n${employee.display_name}` : fallback,
        status: outStatus,
        answered: 'no',
        sources: '[]',
        model: deps.llm.model,
        latency_ms: null,
        input_tokens: null,
        output_tokens: null,
        error_code: err.code,
      };
    }
    replies = [...ackRows, ...(await insertReplies(deps, orgId, [row]))];
  }

  log.info(
    {
      employee_id: employee.id,
      source: message.source,
      action: decision.action,
      intent: classification?.intent ?? null,
      addressed: classification?.addressed_to_me ?? null,
      confidence: classification?.confidence ?? null,
      needs: decision.needs,
      model: call?.model ?? null,
      model_ms: call?.latencyMs ?? null,
      input_tokens: call?.inputTokens ?? null,
      output_tokens: call?.outputTokens ?? null,
      error_code: errorCode,
      duration_ms: Math.round(performance.now() - started),
    },
    'message decided',
  );

  return {
    message: saved.updated,
    decision: saved.row,
    facts,
    classification,
    corrections,
    memory,
    replies,
    alreadyDecided: false,
  };
}

async function markFailed(deps: EngineDeps, orgId: string, messageId: string, err: unknown) {
  try {
    await withTenant(deps.db, orgId, (trx) =>
      trx
        .updateTable('conversations.inbound_messages')
        .set({
          status: 'failed',
          last_error: (err instanceof Error ? err.message : String(err)).slice(0, 2000),
        })
        .where('id', '=', messageId)
        .execute(),
    );
  } catch (markErr) {
    deps.logger.error({ err: markErr, message_id: messageId }, 'could not mark message failed');
  }
}

async function insertReplies(
  deps: EngineDeps,
  orgId: string,
  rows: {
    org_id: string;
    employee_id: string;
    in_reply_to: string;
    kind: 'reply' | 'ack';
    body: string;
    status: 'draft' | 'queued' | 'failed';
    answered: 'yes' | 'partly' | 'no' | null;
    sources: string;
    model: string | null;
    latency_ms: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    error_code: string | null;
  }[],
): Promise<OutboundMessage[]> {
  return withTenant(deps.db, orgId, (trx) =>
    trx.insertInto('conversations.outbound_messages').values(rows).returningAll().execute(),
  );
}
