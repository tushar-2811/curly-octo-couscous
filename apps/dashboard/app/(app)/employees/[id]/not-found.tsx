import { Bot } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/ui/states';

export default function EmployeeNotFound() {
  return (
    <EmptyState
      icon={Bot}
      title="AI employee not found"
      description="The link may be wrong."
      action={
        <Link
          href="/employees"
          className="inline-flex h-9 items-center rounded-md bg-black px-4 text-sm font-medium text-white hover:bg-gray-600"
        >
          Back to AI employees
        </Link>
      }
    />
  );
}
