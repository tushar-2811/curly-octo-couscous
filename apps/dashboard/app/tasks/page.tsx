import { ListChecks } from 'lucide-react';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Tasks' };

export default function Page() {
  return (
    <>
      <PageHeader
        title="Tasks"
        description="Work your AI employees are doing, waiting on, or have finished."
      />
      <EmptyState
        icon={ListChecks}
        title="No tasks yet"
        description="Tasks are created when someone assigns work to an AI employee in Google Chat."
      />
    </>
  );
}
