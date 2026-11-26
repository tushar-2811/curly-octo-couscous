import OpenAI from 'openai';

/**
 * The language-model call the engine needs: one prompt in, JSON that matches a schema out.
 * Behind an interface so the provider can change (OpenAI today, Claude later) and tests can
 * use a fake.
 */
export interface StructuredRequest {
  /** Short name for logs and the provider, e.g. "classification". */
  name: string;
  instructions: string;
  input: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  effort?: 'none' | 'low' | 'medium' | 'high';
  timeoutMs?: number;
}

export interface StructuredResult {
  /** The raw JSON text; the caller validates it. */
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

export interface StructuredLlm {
  readonly model: string;
  generate(request: StructuredRequest): Promise<StructuredResult>;
}

export type LlmErrorCode =
  | 'not_configured'
  | 'auth'
  | 'rate_limited'
  | 'timeout'
  | 'unavailable'
  | 'bad_request'
  | 'refused'
  | 'incomplete'
  | 'invalid_output';

const RETRYABLE: ReadonlySet<LlmErrorCode> = new Set(['rate_limited', 'timeout', 'unavailable']);

export class LlmError extends Error {
  readonly retryable: boolean;
  constructor(
    public readonly code: LlmErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
    this.retryable = RETRYABLE.has(code);
  }
}

export interface OpenAiLlmOptions {
  apiKey: string;
  model: string;
  /** Per request. */
  timeoutMs?: number;
  /** The SDK retries 429 and 5xx with backoff. */
  maxRetries?: number;
  baseURL?: string;
}

/** OpenAI Responses API with strict structured outputs. Nothing is stored at OpenAI. */
export class OpenAiLlm implements StructuredLlm {
  readonly model: string;
  private readonly client: OpenAI;
  private readonly timeoutMs: number;

  constructor(options: OpenAiLlmOptions) {
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      maxRetries: options.maxRetries ?? 2,
      timeout: this.timeoutMs,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  async generate(request: StructuredRequest): Promise<StructuredResult> {
    const started = performance.now();
    let response: OpenAI.Responses.Response;
    try {
      response = await this.client.responses.create(
        {
          model: this.model,
          instructions: request.instructions,
          input: request.input,
          max_output_tokens: request.maxOutputTokens,
          store: false,
          ...(request.effort ? { reasoning: { effort: request.effort } } : {}),
          text: {
            format: {
              type: 'json_schema',
              name: request.name,
              schema: request.schema,
              strict: true,
            },
          },
        },
        { timeout: request.timeoutMs ?? this.timeoutMs },
      );
    } catch (err) {
      throw toLlmError(err);
    }
    const latencyMs = Math.round(performance.now() - started);
    for (const item of response.output ?? []) {
      if (item.type !== 'message') continue;
      for (const part of item.content) {
        if (part.type === 'refusal') {
          throw new LlmError('refused', `The model refused: ${part.refusal.slice(0, 200)}`);
        }
      }
    }
    if (response.status === 'incomplete') {
      throw new LlmError(
        'incomplete',
        `The model stopped early (${response.incomplete_details?.reason ?? 'unknown reason'})`,
      );
    }
    if (response.status !== 'completed' || !response.output_text) {
      throw new LlmError(
        'invalid_output',
        `The model returned no answer (status ${response.status})`,
      );
    }
    return {
      text: response.output_text,
      model: response.model ?? this.model,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      latencyMs,
    };
  }
}

function toLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new LlmError('timeout', 'The model did not answer in time');
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new LlmError('unavailable', 'Could not reach the model provider');
  }
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    // The provider's message can include request details but never the key.
    const detail = err.message.slice(0, 300);
    if (status === 401 || status === 403)
      return new LlmError('auth', `The API key was rejected: ${detail}`, status);
    if (status === 429) return new LlmError('rate_limited', `Rate limited: ${detail}`, status);
    if (status !== undefined && status >= 500)
      return new LlmError('unavailable', `Provider error: ${detail}`, status);
    return new LlmError('bad_request', `Request rejected: ${detail}`, status);
  }
  return new LlmError('unavailable', err instanceof Error ? err.message : String(err));
}
