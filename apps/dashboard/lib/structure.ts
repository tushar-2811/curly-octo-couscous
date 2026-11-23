import 'server-only';
import { apiFetch } from './api';
import type { MemberRow, OrgUnit } from './types';

export async function listUnits(): Promise<OrgUnit[]> {
  return (await apiFetch<{ units: OrgUnit[] }>('/v1/org-units')).units;
}

export async function listPeople(
  params: Record<string, string | undefined> = {},
): Promise<MemberRow[]> {
  const qs = new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => Boolean(e[1])),
  ).toString();
  return (await apiFetch<{ members: MemberRow[] }>(`/v1/members${qs ? `?${qs}` : ''}`)).members;
}
