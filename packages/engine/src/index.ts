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
export { listInbox, MAX_BODY, recordInbound, type InboundInput, type InboxEntry } from './messages';
export { EngineError, processMessage, type EngineDeps, type ProcessResult } from './process';
