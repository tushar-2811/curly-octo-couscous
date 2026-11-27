import {
  withTenant,
  type InboundMessage,
  type MessageDecision,
  type OutboundMessage,
} from '@aiw/db';
import { EngineError, listInbox, loadProcessed, processMessage, recordInbound } from '@aiw/engine';
import type { Logger } from '@aiw/logger';
import { getEmployee } from '@aiw/workforce';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireMember, type AuthDeps } from '../auth';
import { AppError } from '../errors';

const idParam = z.object({ id: z.uuid('Invalid id') });

const listQuery = z.object({
  cursor: z.uuid('Invalid page').optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const testBody = z.object({
  body: z.string().trim().min(1, 'Write a message').max(4000, 'Use at most 4,000 characters'),
  /** Who the message is from: a person in the organization. Defaults to you. */
  sender_id: z.uuid('Choose someone from the list').nullable().default(null),
  space_type: z.enum(['direct', 'space']).default('space'),
  mention: z.boolean().default(false),
  /** Messages with the same thread are read together, as in a Chat thread. */
  thread: z
    .string()
    .trim()
    .max(80)
    .regex(/^[\w .-]*$/, 'Use letters, numbers, spaces, dots or dashes')
    .default(''),
});

function messageDto(m: InboundMessage) {
  return {
    id: m.id,
    source: m.source,
    space_type: m.space_type,
    space_name: m.space_display_name ?? m.space_name,
    thread_key: m.thread_key,
    sender: { member_id: m.sender_member_id, name: m.sender_name, email: m.sender_email },
    subject: m.subject,
    body: m.body,
    mentions: m.mentions,
    sent_at: new Date(m.sent_at).toISOString(),
    received_at: new Date(m.received_at).toISOString(),
    status: m.status,
    last_error: m.last_error,
  };
}

function decisionDto(d: MessageDecision | null) {
  if (!d) return null;
  return {
    id: d.id,
    action: d.action,
    reasons: d.reasons,
    needs: d.needs,
    facts: d.facts,
    classification: d.classification,
    model: d.model,
    prompt_version: d.prompt_version,
    latency_ms: d.latency_ms,
    input_tokens: d.input_tokens,
    output_tokens: d.output_tokens,
    error_code: d.error_code,
    created_at: new Date(d.created_at).toISOString(),
  };
}

function replyDto(r: OutboundMessage) {
  return {
    id: r.id,
    kind: r.kind,
    body: r.body,
    status: r.status,
    answered: r.answered,
    sources: r.sources,
    model: r.model,
    latency_ms: r.latency_ms,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    error_code: r.error_code,
    sent_at: r.sent_at ? new Date(r.sent_at).toISOString() : null,
    created_at: new Date(r.created_at).toISOString(),
  };
}

/**
 * An AI employee's inbox (Phase 2, slice 3): every message it received and what it decided.
 * Message text is private, so only admins and security admins can read it for now.
 */
export function registerInboxRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { db } = deps;
  const engine = deps.engine ?? { llm: null, embedder: null, allowTestMessages: false };

  async function requireInboxReader(request: FastifyRequest) {
    const session = await requireMember(request, db);
    const role = session.member.person_role;
    if (role !== 'admin' && role !== 'security_admin') {
      throw new AppError(
        403,
        'forbidden',
        'Only admins can read an AI employee’s messages',
        'Ask an admin or security admin of your organization.',
      );
    }
    return session;
  }

  app.get('/v1/employees/:id/inbox', async (request) => {
    const { ctx } = await requireInboxReader(request);
    const { id } = idParam.parse(request.params);
    const q = listQuery.parse(request.query);
    const page = await withTenant(db, ctx.orgId, async (trx) => {
      await getEmployee(trx, id);
      return listInbox(trx, id, { limit: q.limit, ...(q.cursor ? { before: q.cursor } : {}) });
    });
    return {
      entries: page.entries.map((e) => ({
        message: messageDto(e.message),
        decision: decisionDto(e.decision),
        replies: e.replies.map(replyDto),
      })),
      next_cursor: page.nextCursor,
      classifier: engine.llm ? { model: engine.llm.model } : null,
      embeddings: engine.embedder ? { model: engine.embedder.model } : null,
      jira: engine.jira ? { site: engine.jira.site } : null,
      test_messages: engine.allowTestMessages,
    };
  });

  app.post(
    '/v1/employees/:id/inbox/test',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { ctx, member } = await requireInboxReader(request);
      if (!engine.allowTestMessages) {
        throw new AppError(
          404,
          'not_found',
          'Test messages are off',
          'They are only available in local and dev environments.',
        );
      }
      const { id } = idParam.parse(request.params);
      const body = testBody.parse(request.body);
      const { message, employee } = await withTenant(db, ctx.orgId, async (trx) => {
        const employee = await getEmployee(trx, id);
        const sender = body.sender_id
          ? await trx
              .selectFrom('workforce.members')
              .select(['id', 'display_name', 'email'])
              .where('id', '=', body.sender_id)
              .where('type', '=', 'human')
              .executeTakeFirst()
          : { id: member.id, display_name: member.display_name, email: member.email };
        if (!sender) {
          throw new AppError(422, 'invalid_sender', 'Choose someone from the list', undefined, {
            errors: [{ path: 'sender_id', message: 'Choose someone from the list' }],
          });
        }
        const recorded = await recordInbound(trx, {
          orgId: ctx.orgId,
          employeeId: id,
          source: 'simulated',
          externalId: `test-${randomUUID()}`,
          threadKey: body.thread ? `test:${body.thread}` : null,
          spaceName: body.space_type === 'direct' ? null : 'Test space',
          spaceType: body.space_type,
          senderEmail: sender.email,
          senderName: sender.display_name,
          subject: null,
          body: body.body,
          mentions: body.mention && employee.email ? [employee.email] : [],
          to: [],
          cc: [],
          sentAt: new Date(),
        });
        return { message: recorded.message, employee };
      });
      request.log.info(
        {
          employee_id: id,
          message_id: message.id,
          space_type: body.space_type,
          mention: body.mention,
        },
        'test message received',
      );
      // Normally the worker processes it; without Temporal, this request does.
      let outcome: 'done' | 'pending' = 'done';
      let via: 'worker' | 'request' = 'request';
      if (engine.dispatcher) {
        try {
          outcome = await engine.dispatcher.process(ctx.orgId, message.id, 45_000);
          via = 'worker';
        } catch (err) {
          request.log.warn(
            { err, message_id: message.id },
            'Temporal unavailable; processing the message in this request',
          );
        }
      }
      if (via === 'request') {
        try {
          await processMessage(
            {
              db,
              llm: engine.llm,
              embedder: engine.embedder ?? null,
              jira: engine.jira ?? null,
              logger: request.log as unknown as Logger,
            },
            ctx.orgId,
            message.id,
          );
        } catch (err) {
          if (err instanceof EngineError) {
            throw new AppError(err.code === 'not_found' ? 404 : 422, err.code, err.message);
          }
          throw err;
        }
      }
      const processed = await withTenant(db, ctx.orgId, (trx) => loadProcessed(trx, message.id));
      if (!processed) throw new AppError(404, 'not_found', 'Message not found');
      request.log.info(
        {
          message_id: message.id,
          processed_by: via,
          pending: outcome === 'pending',
          action: processed.decision?.action ?? null,
        },
        'test message processed',
      );
      return reply.status(outcome === 'pending' ? 202 : 201).send({
        message: messageDto(processed.message),
        decision: decisionDto(processed.decision),
        replies: processed.replies.map(replyDto),
        processed_by: via,
        pending: outcome === 'pending',
        employee: { id: employee.id, name: employee.display_name },
      });
    },
  );
}
