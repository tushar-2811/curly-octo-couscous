import { Settings } from 'lucide-react';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Settings' };

export default function Page() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Integrations, policies and limits for your organization."
      />
      <EmptyState
        icon={Settings}
        title="Nothing to configure yet"
        description="Integrations (Google Workspace, Jira, GitHub, Figma), approval policies and usage limits will be managed here."
      />
    </>
  );
}
