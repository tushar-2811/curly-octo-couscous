import type { DecisionAction } from '@/lib/inbox';

export const ACTION_LABELS: Record<DecisionAction, string> = {
  reply: 'Will reply',
  acknowledge: 'Will acknowledge',
  remember: 'Remembered, no reply',
  ignore: 'Ignored',
  decline: 'Declined',
  needs_review: 'Needs review',
};

export const INTENT_LABELS: Record<string, string> = {
  question: 'Question',
  work_request: 'Work request',
  status_check: 'Status check',
  fyi: 'For information',
  social: 'Social',
  feedback: 'Feedback',
  unclear: 'Unclear',
};

export const ADDRESSED_LABELS: Record<string, string> = {
  explicit_mention: '@mentioned',
  direct_message: 'Direct message',
  implicit: 'Meant for it, not mentioned',
  not_addressed: 'Not meant for it',
};

export const NEED_LABELS: Record<string, string> = {
  memory: 'Memory',
  jira: 'Jira',
  code: 'Code',
  people_directory: 'People directory',
};

export const FACT_LABELS: Record<string, string> = {
  explicitly_mentioned: '@mentioned',
  direct_message: 'Direct message',
  recipient_role: 'Email recipient',
  name_in_text: 'Name in the text',
  in_my_thread: 'Its thread',
  sender_is_member: 'Sender is in the organization',
  sender_in_domain: 'Sender on the company domain',
  from_self: 'Its own message',
};

export const ERROR_LABELS: Record<string, string> = {
  not_configured: 'No language model is set up (OPENAI_API_KEY)',
  auth: 'The model provider rejected the API key',
  rate_limited: 'The model provider is rate limiting; it will be tried again',
  timeout: 'The model did not answer in time; it will be tried again',
  unavailable: 'The model provider could not be reached; it will be tried again',
  bad_request: 'The model provider rejected the request',
  refused: 'The model refused to classify this message',
  incomplete: 'The model stopped before finishing',
  invalid_output: 'The model returned JSON that did not match the schema',
};
