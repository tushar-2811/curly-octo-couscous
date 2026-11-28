/**
 * Engine (Phase 2): what an AI employee does with the messages it receives. Addressing
 * facts, the classifier, the decision rules and the message store. Memory and answers
 * build on this.
 */
export {
  ADDRESSED,
  CLASSIFICATION_JSON_SCHEMA,
  classificationSchema,
  INTENTS,
  NEEDS,
  PROMPT_VERSION,
  URGENCIES,
  type Addressed,
  type Classification,
  type Intent,
  type Need,
} from './classification';
export { classifyMessage, reconcile } from './classifier';
export { decide, DEFAULT_POLICY, type Decision, type DecisionPolicy } from './decide';
export { computeFacts, directlyAddressed, nameAppears, type AddressingFacts } from './facts';
export {
  LlmError,
  OpenAiLlm,
  type LlmErrorCode,
  type StructuredLlm,
  type StructuredRequest,
  type StructuredResult,
} from './llm';
export {
  listInbox,
  loadProcessed,
  MAX_BODY,
  recordInbound,
  staleMessages,
  type InboundInput,
  type InboxEntry,
} from './messages';
export { createModels, type ModelSettings } from './models';
export { EngineError, processMessage, type EngineDeps, type ProcessResult } from './process';
export {
  ACK_TEXT,
  ANSWER_JSON_SCHEMA,
  ANSWER_PROMPT_VERSION,
  answerPrompt,
  draftReply,
  replyTask,
  type AnswerInput,
  type Evidence,
  type ReplyTask,
} from './answer';
export {
  EmbeddingError,
  toVectorLiteral,
  VoyageEmbedder,
  type Embedder,
  type EmbedResult,
} from './embeddings';
export {
  embedPending,
  embedQuery,
  messageMemoryText,
  readersFor,
  rememberMessage,
  searchMemory,
  wordsQuery,
  type MemoryHit,
  type Readers,
} from './memory';
export {
  adfToText,
  issueEvidenceText,
  JIRA_KEY,
  JiraCloudClient,
  JiraError,
  type JiraIssue,
  type JiraReader,
} from './jira';
export { jiraEvidence } from './jira-evidence';
export {
  conversationsToDigest,
  extractConversationFacts,
  FACT_KINDS,
  listFacts,
  pendingConversations,
  type FactEntry,
  FACT_PROMPT_VERSION,
  type ExtractResult,
  type FactKind,
} from './facts-extract';
export { GoogleApiError, type GoogleErrorCode } from './google/errors';
export { GoogleTokenBroker, type AccessToken } from './google/token-broker';
export {
  GoogleWorkspace,
  type ChatMessage,
  type ChatSpace,
  type Person,
  type PulledMessage,
  type WorkspaceSubscription,
} from './google/workspace';
export {
  ALL_SPACES,
  chatEmployees,
  ensureChatSubscription,
  eventMessageNames,
  handleChatEvent,
  ingestChatMessage,
  MESSAGE_CREATED,
  noteSubscriptionError,
  postChatReply,
  type ChatDeps,
} from './google/chat';
export { sendQueuedReplies, sendReply } from './google/delivery';
export {
  ensureGmailWatch,
  gmailEmployees,
  gmailNotification,
  handleGmailEvent,
  ingestEmail,
  noteMailboxError,
  sendEmailReply,
  syncMailbox,
  type GmailDeps,
} from './google/gmail';
export {
  automatedReason,
  buildReplyMime,
  extractBody,
  parseAddressList,
  stripQuoted,
  OUTBOUND_HEADER,
} from './google/email';
