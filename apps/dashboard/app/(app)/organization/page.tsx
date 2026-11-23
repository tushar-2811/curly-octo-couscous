import { Building2 } from 'lucide-react';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Organization' };

export default function Page() {
  return (
    <>
      <PageHeader
        title="Organization"
        description="Departments, teams, people and reporting lines."
      />
      <EmptyState
        icon={Building2}
        title="No organization set up yet"
        description="Register your company and build your org chart: departments, teams, managers and AI employees."
      />
    </>
  );
}
