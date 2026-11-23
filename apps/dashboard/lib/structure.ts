import 'server-only';
import { apiFetch } from './api';
import type { Employee, MemberRow, OrgUnit, RoleTemplate } from './types';

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

export async function listEmployees(status?: string): Promise<Employee[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return (await apiFetch<{ employees: Employee[] }>(`/v1/employees${qs}`)).employees;
}

export async function listRoleTemplates(): Promise<RoleTemplate[]> {
  return (await apiFetch<{ templates: RoleTemplate[] }>('/v1/role-templates')).templates;
}
