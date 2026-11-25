import 'server-only';
import { apiFetch } from './api';
import type { AccessCatalog, EmployeeAccess, Resource, ResourceType } from './types';

export async function getAccessCatalog(): Promise<AccessCatalog> {
  return apiFetch<AccessCatalog>('/v1/access/catalog');
}

export async function listResources(type?: ResourceType): Promise<Resource[]> {
  const qs = type ? `?type=${encodeURIComponent(type)}` : '';
  return (await apiFetch<{ resources: Resource[] }>(`/v1/resources${qs}`)).resources;
}

export async function getEmployeeAccess(id: string, history = false): Promise<EmployeeAccess> {
  return apiFetch<EmployeeAccess>(
    `/v1/employees/${id}/access${history ? '?include_revoked=true' : ''}`,
  );
}
