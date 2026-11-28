import 'server-only';
import { apiFetch } from './api';

export type DecisionAction =
  'ignore' | 'remember' | 'reply' | 'acknowledge' | 'decline' | 'needs_review';

export interface InboxMessage {
  id: string;
  source: 'google_chat' | 'gmail' | 'simulated';
  space_type: 'direct' | 'group' | 'space' | 'email' | null;
  space_name: string | null;
  thread_key: string | null;
  sender: { member_id: string | null; name: string | null; email: string | null };
  subject: string | null;
  body: string;
  mentions: string[];
  sent_at: string;
  received_at: string;
  status: 'received' | 'processing' | 'decided' | 'failed';
  last_error: string | null;
}

export interface Classification {
  intent: string;
  addressed_to_me: string;
  should_respond: boolean;
  urgency: string;
  needs: string[];
  references: { jira_keys: string[]; repos: string[]; people: string[]; urls: string[] };
  summary: string;
  confidence: number;
  reason: string;
}

export interface InboxDecision {
  id: string;
  action: DecisionAction;
  reasons: string[];
  needs: string[];
  facts: Record<string, boolean | string | null>;
  classification: Classification | null;
  model: string | null;
  prompt_version: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  error_code: string | null;
  created_at: string;
}

export interface InboxReply {
  id: string;
  kind: 'reply' | 'ack';
  body: string;
  status: 'draft' | 'queued' | 'sent' | 'failed';
  answered: 'yes' | 'partly' | 'no' | null;
  /** Older drafts only have memory_id. */
  sources: {
    source?: 'memory' | 'jira' | 'org_chart';
    id?: string;
    memory_id?: string;
    label?: string;
    url?: string;
    snippet: string;
  }[];
  model: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  error_code: string | null;
  created_at: string;
}

export interface InboxEntry {
  message: InboxMessage;
  decision: InboxDecision | null;
  replies: InboxReply[];
}

export interface InboxPage {
  entries: InboxEntry[];
  next_cursor: string | null;
  classifier: { model: string } | null;
  embeddings: { model: string } | null;
  jira: { site: string } | null;
  test_messages: boolean;
}

export function getInbox(employeeId: string, cursor?: string): Promise<InboxPage> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return apiFetch<InboxPage>(`/v1/employees/${employeeId}/inbox${qs}`);
}
