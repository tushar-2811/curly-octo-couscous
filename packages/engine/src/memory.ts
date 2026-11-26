import {
  sql,
  withTenant,
  type Database,
  type InboundMessage,
  type Kysely,
  type MemoryItem,
  type Tx,
} from '@aiw/db';
import type { Logger } from '@aiw/logger';
import { EmbeddingError, toVectorLiteral, type Embedder } from './embeddings';

/**
 * Who will read an answer. A search only returns memory every reader could already see:
 * - direct: a one-to-one conversation (or email) with these people. They can see items
 *   whose audience includes them, and items from Chat spaces they are in.
 * - space: a reply in a shared space is visible to everyone there, so only items from that
 *   space (and organization-wide items) can be used. Never anything from a direct message.
 */
export type Readers =
  { kind: 'direct'; memberIds: string[] } | { kind: 'space'; spaceName: string };

export interface MemoryHit {
  id: string;
  kind: MemoryItem['kind'];
  content: string;
  occurred_at: Date;
  scope: MemoryItem['scope'];
  space_name: string | null;
  source_id: string;
  score: number;
  matched_by: ('meaning' | 'words')[];
}

const MAX_CONTENT = 8000;

/** Readers for a reply to this message. */
export function readersFor(message: InboundMessage): Readers {
  if (message.space_type === 'space' || message.space_type === 'group') {
    return { kind: 'space', spaceName: message.space_name ?? `thread:${message.thread_key}` };
  }
  return { kind: 'direct', memberIds: message.sender_member_id ? [message.sender_member_id] : [] };
}

function where(message: InboundMessage): string {
  if (message.space_type === 'direct') return 'direct message';
  if (message.space_type === 'email') return 'email';
  return message.space_name ?? 'a space';
}

/** The text stored and embedded for a message: who said it, where, when, and what. */
export function messageMemoryText(message: InboundMessage): string {
  const who = message.sender_name ?? message.sender_email ?? 'Someone';
  const when = new Date(message.sent_at).toISOString().slice(0, 10);
  const subject = message.subject ? `${message.subject} — ` : '';
  const text = `${who} (${where(message)}, ${when}): ${subject}${message.body}`;
  return text.length > MAX_CONTENT ? `${text.slice(0, MAX_CONTENT - 1)}…` : text;
}

export interface MemoryDeps {
  db: Kysely<Database>;
  embedder: Embedder | null;
  logger: Logger;
}

async function embedOne(
  deps: MemoryDeps,
  text: string,
  purpose: 'document' | 'query',
): Promise<{ literal: string | null; model: string | null }> {
  if (!deps.embedder) return { literal: null, model: null };
  try {
    const out = await deps.embedder.embed([text], purpose);
    const vector = out.vectors[0];
    if (!vector) return { literal: null, model: null };
    deps.logger.debug({ purpose, tokens: out.tokens, embed_ms: out.latencyMs }, 'embedded');
    return { literal: toVectorLiteral(vector), model: deps.embedder.model };
  } catch (err) {
    // Words search still works; the item is embedded later by embedPending.
    deps.logger.warn(
      { err, code: err instanceof EmbeddingError ? err.code : 'unknown', purpose },
      'embedding failed; continuing without it',
    );
    return { literal: null, model: null };
  }
}

/** The vector for a search, or null when embeddings are off or failing. */
export async function embedQuery(deps: MemoryDeps, text: string): Promise<string | null> {
  return (await embedOne(deps, text.slice(0, MAX_CONTENT), 'query')).literal;
}

/** Save a received message as memory, once. Returns null if it was already saved. */
export async function rememberMessage(
  deps: MemoryDeps,
  orgId: string,
  message: InboundMessage,
): Promise<MemoryItem | null> {
  const content = messageMemoryText(message);
  const { literal, model } = await embedOne(deps, content, 'document');
  const readers = readersFor(message);
  return withTenant(deps.db, orgId, async (trx) => {
    const row = await trx
      .insertInto('knowledge.memory_items')
      .values({
        org_id: orgId,
        employee_id: message.employee_id,
        kind: 'message',
        content,
        source_type: 'inbound_message',
        source_id: message.id,
        scope: readers.kind === 'space' ? 'space' : 'direct',
        space_name: readers.kind === 'space' ? readers.spaceName : null,
        audience: readers.kind === 'direct' ? [...readers.memberIds, message.employee_id] : [],
        author_member_id: message.sender_member_id,
        occurred_at: message.sent_at,
        embedding: literal,
        embedding_model: model,
      })
      .onConflict((oc) =>
        oc
          .columns(['employee_id', 'source_type', 'source_id', 'kind'])
          .where('kind', '=', 'message')
          .doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
    return row ?? null;
  });
}

/** Embed items saved while embeddings were off or failing. Returns how many were done. */
export async function embedPending(deps: MemoryDeps, orgId: string, limit = 100): Promise<number> {
  if (!deps.embedder) return 0;
  const pending = await withTenant(deps.db, orgId, (trx) =>
    trx
      .selectFrom('knowledge.memory_items')
      .select(['id', 'content'])
      .where('embedding', 'is', null)
      .where('status', '=', 'active')
      .orderBy('id')
      .limit(limit)
      .execute(),
  );
  if (pending.length === 0) return 0;
  const out = await deps.embedder.embed(
    pending.map((p) => p.content),
    'document',
  );
  await withTenant(deps.db, orgId, async (trx) => {
    for (const [i, item] of pending.entries()) {
      const vector = out.vectors[i];
      if (!vector) continue;
      await trx
        .updateTable('knowledge.memory_items')
        .set({ embedding: toVectorLiteral(vector), embedding_model: deps.embedder!.model })
        .where('id', '=', item.id)
        .execute();
    }
  });
  deps.logger.info({ count: pending.length, tokens: out.tokens }, 'memory embedded');
  return pending.length;
}

/** Words for full-text search, joined with OR so one matching term is enough. */
export function wordsQuery(text: string): string | null {
  const words = [
    ...new Set(
      (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,40}/gu) ?? []).map((w) =>
        w.replace(/[^\p{L}\p{N}]/gu, ' ').trim(),
      ),
    ),
  ]
    .flatMap((w) => w.split(/\s+/))
    .filter((w) => w.length >= 2)
    .slice(0, 24);
  return words.length > 0 ? words.join(' | ') : null;
}

export interface SearchInput {
  employeeId: string;
  readers: Readers;
  text: string;
  /** pgvector literal from embedQuery; null searches by words only. */
  vector: string | null;
  limit?: number;
  /** Source ids to leave out, e.g. the message being answered. */
  excludeSourceIds?: string[];
  /** Ignore meaning matches less similar than this (cosine similarity). */
  minSimilarity?: number;
}

const RRF_K = 60;
const CANDIDATES = 20;

/**
 * Hybrid search: by meaning (vector) and by words (full-text), merged with reciprocal
 * rank fusion. The reader filter runs in SQL, before ranking, so nothing the readers could
 * not see can reach the answer.
 */
export async function searchMemory(trx: Tx, input: SearchInput): Promise<MemoryHit[]> {
  const limit = input.limit ?? 8;
  const exclude = input.excludeSourceIds ?? [];
  const r = input.readers;
  if (r.kind === 'direct' && r.memberIds.length === 0) return [];
  const visible =
    r.kind === 'space'
      ? sql`(mi.scope = 'org' or (mi.scope = 'space' and mi.space_name = ${r.spaceName}))`
      : sql`(mi.scope = 'org' or (${sql.join(
          r.memberIds.map(
            (id) => sql`(${id}::uuid = any(mi.audience) or (mi.scope = 'space' and exists (
              select 1 from knowledge.space_members sm
              where sm.employee_id = mi.employee_id and sm.space_name = mi.space_name
                and sm.member_id = ${id}::uuid)))`,
          ),
          sql` and `,
        )}))`;
  const base = sql`mi.employee_id = ${input.employeeId}::uuid and mi.status = 'active'
    and not (mi.source_id = any(${exclude}::uuid[])) and ${visible}`;

  type Row = {
    id: string;
    kind: MemoryItem['kind'];
    content: string;
    occurred_at: Date;
    scope: MemoryItem['scope'];
    space_name: string | null;
    source_id: string;
    similarity?: number;
  };
  const cols = sql`mi.id, mi.kind, mi.content, mi.occurred_at, mi.scope, mi.space_name, mi.source_id`;

  const byMeaning: Row[] = [];
  if (input.vector) {
    await sql`set local hnsw.iterative_scan = relaxed_order`.execute(trx);
    const rows = await sql<Row>`
      select ${cols}, 1 - (mi.embedding <=> ${input.vector}::vector) as similarity
      from knowledge.memory_items mi
      where ${base} and mi.embedding is not null
      order by mi.embedding <=> ${input.vector}::vector
      limit ${CANDIDATES}
    `.execute(trx);
    const floor = input.minSimilarity ?? 0.25;
    byMeaning.push(...rows.rows.filter((row) => Number(row.similarity) >= floor));
  }

  const words = wordsQuery(input.text);
  const byWords = words
    ? (
        await sql<Row>`
          select ${cols}
          from knowledge.memory_items mi
          where ${base} and mi.tsv @@ to_tsquery('english', ${words})
          order by ts_rank_cd(mi.tsv, to_tsquery('english', ${words})) desc, mi.id desc
          limit ${CANDIDATES}
        `.execute(trx)
      ).rows
    : [];

  const merged = new Map<string, MemoryHit>();
  const add = (rows: Row[], how: 'meaning' | 'words') =>
    rows.forEach((row, rank) => {
      const hit = merged.get(row.id) ?? {
        id: row.id,
        kind: row.kind,
        content: row.content,
        occurred_at: new Date(row.occurred_at),
        scope: row.scope,
        space_name: row.space_name,
        source_id: row.source_id,
        score: 0,
        matched_by: [],
      };
      hit.score += 1 / (RRF_K + rank + 1);
      hit.matched_by.push(how);
      merged.set(row.id, hit);
    });
  add(byMeaning, 'meaning');
  add(byWords, 'words');
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
