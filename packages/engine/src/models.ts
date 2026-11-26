import { VoyageEmbedder, type Embedder } from './embeddings';
import { OpenAiLlm, type StructuredLlm } from './llm';

export interface ModelSettings {
  OPENAI_API_KEY?: string | undefined;
  OPENAI_MODEL: string;
  LLM_TIMEOUT_MS: number;
  VOYAGE_API_KEY?: string | undefined;
  VOYAGE_MODEL: string;
}

/** The language model and embedder from settings; each is null until its key is set. */
export function createModels(settings: ModelSettings): {
  llm: StructuredLlm | null;
  embedder: Embedder | null;
} {
  return {
    llm: settings.OPENAI_API_KEY
      ? new OpenAiLlm({
          apiKey: settings.OPENAI_API_KEY,
          model: settings.OPENAI_MODEL,
          timeoutMs: settings.LLM_TIMEOUT_MS,
        })
      : null,
    embedder: settings.VOYAGE_API_KEY
      ? new VoyageEmbedder({ apiKey: settings.VOYAGE_API_KEY, model: settings.VOYAGE_MODEL })
      : null,
  };
}
