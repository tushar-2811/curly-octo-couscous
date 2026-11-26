/**
 * Turning text into vectors for memory search. Behind an interface so the provider can
 * change and tests can use a fake. Document and query vectors must come from the same model.
 */
export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], purpose: 'document' | 'query'): Promise<EmbedResult>;
}

export interface EmbedResult {
  vectors: number[][];
  tokens: number | null;
  latencyMs: number;
}

export type EmbeddingErrorCode =
  'auth' | 'rate_limited' | 'timeout' | 'unavailable' | 'bad_request' | 'invalid_output';

export class EmbeddingError extends Error {
  readonly retryable: boolean;
  constructor(
    public readonly code: EmbeddingErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'EmbeddingError';
    this.retryable = code === 'rate_limited' || code === 'timeout' || code === 'unavailable';
  }
}

/** The vector in pgvector's text form. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

export interface VoyageOptions {
  apiKey: string;
  model?: string;
  dimensions?: 256 | 512 | 1024 | 2048;
  timeoutMs?: number;
  /** Extra attempts after a 429 or 5xx. */
  maxRetries?: number;
  baseUrl?: string;
}

const MAX_BATCH = 128;

/** Voyage AI embeddings over REST (POST /v1/embeddings). */
export class VoyageEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseUrl: string;

  constructor(options: VoyageOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'voyage-4';
    this.dimensions = options.dimensions ?? 1024;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.baseUrl = options.baseUrl ?? 'https://api.voyageai.com';
  }

  async embed(texts: string[], purpose: 'document' | 'query'): Promise<EmbedResult> {
    const started = performance.now();
    const vectors: number[][] = [];
    let tokens = 0;
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const batch = texts.slice(i, i + MAX_BATCH);
      const out = await this.request(batch, purpose);
      vectors.push(...out.vectors);
      tokens += out.tokens;
    }
    return { vectors, tokens, latencyMs: Math.round(performance.now() - started) };
  }

  private async request(input: string[], purpose: 'document' | 'query') {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(input, purpose);
      } catch (err) {
        if (!(err instanceof EmbeddingError) || !err.retryable || attempt >= this.maxRetries) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 250));
      }
    }
  }

  private async once(input: string[], purpose: 'document' | 'query') {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          input,
          model: this.model,
          input_type: purpose,
          output_dimension: this.dimensions,
          truncation: true,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new EmbeddingError('timeout', 'The embedding service did not answer in time');
      }
      throw new EmbeddingError('unavailable', 'Could not reach the embedding service');
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      const s = response.status;
      if (s === 401 || s === 403)
        throw new EmbeddingError('auth', `Voyage rejected the API key: ${detail}`, s);
      if (s === 429) throw new EmbeddingError('rate_limited', `Voyage rate limit: ${detail}`, s);
      if (s >= 500) throw new EmbeddingError('unavailable', `Voyage error ${s}: ${detail}`, s);
      throw new EmbeddingError('bad_request', `Voyage rejected the request: ${detail}`, s);
    }
    const body = (await response.json().catch(() => null)) as {
      data?: { embedding?: unknown; index?: number }[];
      usage?: { total_tokens?: number };
    } | null;
    const data = body?.data;
    if (!Array.isArray(data) || data.length !== input.length) {
      throw new EmbeddingError('invalid_output', 'Voyage returned the wrong number of vectors');
    }
    const vectors: number[][] = new Array(input.length);
    for (const item of data) {
      const v = item.embedding;
      if (
        typeof item.index !== 'number' ||
        !Array.isArray(v) ||
        v.length !== this.dimensions ||
        !v.every((x) => typeof x === 'number' && Number.isFinite(x))
      ) {
        throw new EmbeddingError('invalid_output', 'Voyage returned a malformed vector');
      }
      vectors[item.index] = v as number[];
    }
    return { vectors, tokens: body?.usage?.total_tokens ?? 0 };
  }
}
