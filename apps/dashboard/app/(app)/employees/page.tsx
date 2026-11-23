import { Bot } from 'lucide-react';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'AI employees' };

export default function Page() {
  return (
    <>
      <PageHeader title="AI employees" description="Hire, onboard and manage your AI employees." />
      <EmptyState
        icon={Bot}
        title="No AI employees yet"
        description="Hire your first AI engineer from a role template, link its Google Workspace account and grant it access to repositories and Chat spaces."
      />
    </>
  );
}
