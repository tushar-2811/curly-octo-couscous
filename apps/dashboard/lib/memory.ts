import 'server-only';
import { apiFetch } from './api';

export const FACT_KINDS = [
  'decision',
  'action_item',
  'requirement',
  'technical_fact',
  'person_fact',
] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export interface Fact {
  id: string;
  kind: FactKind;
  content: string;
  confidence: number;
  status: 'active' | 'superseded';
  scope: 'direct' | 'space' | 'org';
  space_name: string | null;
  occurred_at: string;
  created_at: string;
  sources: { id: string; sender: string | null; sent_at: string; snippet: string }[];
}

export interface MemoryPage {
  facts: Fact[];
  next_cursor: string | null;
  pending_conversations: number;
  can_extract_now: boolean;
}

export function getMemory(employeeId: string, params: URLSearchParams): Promise<MemoryPage> {
  return apiFetch<MemoryPage>(`/v1/employees/${employeeId}/memory?${params.toString()}`);
}
