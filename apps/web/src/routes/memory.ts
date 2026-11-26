import { withTenant } from '@aiw/db';
import {
  extractConversationFacts,
  FACT_KINDS,
  listFacts,
  LlmError,
  pendingConversations,
} from '@aiw/engine';
import type { Logger } from '@aiw/logger';
import { getEmployee } from '@aiw/workforce';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireMember, type AuthDeps } from '../auth';
import { AppError } from '../errors';

const idParam = z.object({ id: z.uuid('Invalid id') });
const listQuery = z.object({
  kind: z.enum(FACT_KINDS).optional(),
  status: z.enum(['active', 'all']).default('active'),
  cursor: z.uuid('Invalid page').optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Most conversations read per "Extract now", so the request stays short. */
const MAX_EXTRACT = 8;

/**
 * What an AI employee remembers (Phase 2, fact extraction): the facts it pulled out of
 * conversations and the messages each came from. Admins and security admins only.
 */
export function registerMemoryRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { db } = deps;
  const engine = deps.engine ?? { llm: null, allowTestMessages: false };

  async function requireReader(request: FastifyRequest) {
    const session = await requireMember(request, db);
    const role = session.member.person_role;
    if (role !== 'admin' && role !== 'security_admin') {
      throw new AppError(
        403,
        'forbidden',
        'Only admins can read an AI employee’s memory',
        'Ask an admin or security admin of your organization.',
      );
    }
    return session;
  }

  app.get('/v1/employees/:id/memory', async (request) => {
    const { ctx } = await requireReader(request);
    const { id } = idParam.parse(request.params);
    const q = listQuery.parse(request.query);
    const { page, pending } = await withTenant(db, ctx.orgId, async (trx) => {
      await getEmployee(trx, id);
      const [page, pending] = await Promise.all([
        listFacts(trx, id, {
          limit: q.limit,
          includeSuperseded: q.status === 'all',
          ...(q.kind ? { kind: q.kind } : {}),
          ...(q.cursor ? { before: q.cursor } : {}),
        }),
        pendingConversations(trx, id),
      ]);
      return { page, pending };
    });
    return {
      facts: page.entries.map(({ item, sources }) => ({
        id: item.id,
        kind: item.kind,
        content: item.content,
        confidence: item.confidence,
        status: item.status,
        scope: item.scope,
        space_name: item.space_name,
        occurred_at: new Date(item.occurred_at).toISOString(),
        created_at: new Date(item.created_at).toISOString(),
        sources: sources.map((s) => ({ ...s, sent_at: s.sent_at.toISOString() })),
      })),
      next_cursor: page.nextCursor,
      pending_conversations: pending.length,
      can_extract_now: engine.allowTestMessages && engine.llm !== null,
    };
  });

  app.post(
    '/v1/employees/:id/memory/extract',
    { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async (request) => {
      const { ctx } = await requireReader(request);
      const { id } = idParam.parse(request.params);
      if (!engine.allowTestMessages) {
        throw new AppError(
          404,
          'not_found',
          'Extracting now is off',
          'Facts are extracted automatically after a conversation is quiet for a while.',
        );
      }
      if (!engine.llm) {
        throw new AppError(
          409,
          'no_model',
          'No language model is set up',
          'Add OPENAI_API_KEY to .env and restart.',
        );
      }
      const conversations = await withTenant(db, ctx.orgId, async (trx) => {
        await getEmployee(trx, id);
        return pendingConversations(trx, id);
      });
      const started = performance.now();
      let read = 0;
      let added = 0;
      let superseded = 0;
      const failed: string[] = [];
      for (const key of conversations.slice(0, MAX_EXTRACT)) {
        try {
          const r = await extractConversationFacts(
            {
              db,
              llm: engine.llm,
              embedder: engine.embedder ?? null,
              logger: request.log as unknown as Logger,
            },
            ctx.orgId,
            id,
            key,
          );
          read += r.read;
          added += r.added.length;
          superseded += r.superseded;
        } catch (err) {
          if (!(err instanceof LlmError)) throw err;
          failed.push(err.code);
          request.log.warn({ err, code: err.code }, 'fact extraction failed for a conversation');
        }
      }
      request.log.info(
        {
          employee_id: id,
          conversations: Math.min(conversations.length, MAX_EXTRACT),
          read,
          added,
          superseded,
          failed: failed.length,
          duration_ms: Math.round(performance.now() - started),
        },
        'facts extracted on request',
      );
      return {
        conversations: Math.min(conversations.length, MAX_EXTRACT),
        remaining: Math.max(conversations.length - MAX_EXTRACT, 0),
        messages_read: read,
        facts_added: added,
        facts_superseded: superseded,
        failed: failed.length,
      };
    },
  );
}
