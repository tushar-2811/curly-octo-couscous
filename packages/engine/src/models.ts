import { VoyageEmbedder, type Embedder } from './embeddings';
import { JiraCloudClient, type JiraReader } from './jira';
import { OpenAiLlm, type StructuredLlm } from './llm';

export interface ModelSettings {
  OPENAI_API_KEY?: string | undefined;
  OPENAI_MODEL: string;
  LLM_TIMEOUT_MS: number;
  VOYAGE_API_KEY?: string | undefined;
  VOYAGE_MODEL: string;
  JIRA_BASE_URL?: string | undefined;
  ATLASSIAN_EMAIL?: string | undefined;
  ATLASSIAN_ACCESS_TOKEN?: string | undefined;
  /** Comma-separated project keys the employee may read, e.g. "PF". Empty: all. */
  JIRA_PROJECTS?: string | undefined;
}

/** The language model and embedder from settings; each is null until its key is set. */
export function createModels(settings: ModelSettings): {
  llm: StructuredLlm | null;
  embedder: Embedder | null;
  jira: JiraReader | null;
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
    jira:
      settings.JIRA_BASE_URL && settings.ATLASSIAN_EMAIL && settings.ATLASSIAN_ACCESS_TOKEN
        ? new JiraCloudClient({
            baseUrl: settings.JIRA_BASE_URL,
            email: settings.ATLASSIAN_EMAIL,
            apiToken: settings.ATLASSIAN_ACCESS_TOKEN,
            projects: (settings.JIRA_PROJECTS ?? '').split(','),
          })
        : null,
  };
}
