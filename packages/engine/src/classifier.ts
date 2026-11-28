import {
  CLASSIFICATION_JSON_SCHEMA,
  CLASSIFIER_INSTRUCTIONS,
  classificationSchema,
  classifierPrompt,
  type Classification,
  type ClassifierInput,
} from './classification';
import { LlmError, type StructuredLlm, type StructuredResult } from './llm';

export interface ClassifyResult {
  classification: Classification;
  /** Where code overrode the model because the facts say otherwise. */
  corrections: string[];
  call: StructuredResult;
}

/**
 * Classify one message (Phase 2 plan, step 3). The JSON is checked again with Zod, then
 * reconciled with the facts code worked out: the model cannot claim a mention that did not
 * happen, or miss one that did.
 */
export async function classifyMessage(
  llm: StructuredLlm,
  input: ClassifierInput,
): Promise<ClassifyResult> {
  const call = await llm.generate({
    name: 'classification',
    instructions: CLASSIFIER_INSTRUCTIONS,
    input: classifierPrompt(input),
    schema: CLASSIFICATION_JSON_SCHEMA,
    // Includes reasoning tokens.
    maxOutputTokens: 2000,
    effort: 'low',
  });
  let json: unknown;
  try {
    json = JSON.parse(call.text);
  } catch {
    throw new LlmError('invalid_output', 'The classifier did not return JSON');
  }
  const parsed = classificationSchema.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues
      .slice(0, 3)
      .map((i) => i.path.join('.') || '(root)')
      .join(', ');
    throw new LlmError(
      'invalid_output',
      `The classifier's JSON did not match the schema (${where})`,
    );
  }
  const { classification, corrections } = reconcile(parsed.data, input.facts);
  return { classification, corrections, call };
}

export function reconcile(
  c: Classification,
  facts: ClassifierInput['facts'],
): { classification: Classification; corrections: string[] } {
  const corrections: string[] = [];
  let addressed = c.addressed_to_me;
  const factual = facts.explicitly_mentioned
    ? 'explicit_mention'
    : // An email with the employee in To is a direct message too.
      facts.direct_message || facts.recipient_role === 'to'
      ? 'direct_message'
      : null;
  if (factual && addressed !== factual) {
    corrections.push(`addressed_to_me ${addressed} → ${factual} (facts)`);
    addressed = factual;
  } else if (!factual && (addressed === 'explicit_mention' || addressed === 'direct_message')) {
    corrections.push(`addressed_to_me ${addressed} → implicit (no mention or direct message)`);
    addressed = 'implicit';
  }
  return {
    classification: {
      ...c,
      addressed_to_me: addressed,
      needs: [...new Set(c.needs)],
    },
    corrections,
  };
}
