import 'server-only';
import { apiFetch } from './api';

export interface AuditEntry {
  id: string;
  occurred_at: string;
  actor: {
    type: 'member' | 'system';
    id: string | null;
    name: string | null;
    kind: string | null;
  };
  action: string;
  resource: { type: string; id: string | null; name: string | null; kind: string | null };
  outcome: 'success' | 'denied' | 'failure';
  request_id: string | null;
  details: Record<string, unknown>;
}

export interface AuditPage {
  entries: AuditEntry[];
  next_cursor: string | null;
}

export interface AuditFilters {
  actors: { id: string; name: string; kind: string }[];
  actions: string[];
}

export function searchAudit(params: URLSearchParams): Promise<AuditPage> {
  return apiFetch<AuditPage>(`/v1/audit?${params.toString()}`);
}

export function getAuditFilters(): Promise<AuditFilters> {
  return apiFetch<AuditFilters>('/v1/audit/filters');
}
