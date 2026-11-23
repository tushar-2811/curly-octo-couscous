import { UserX } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/ui/states';

export default function PersonNotFound() {
  return (
    <EmptyState
      icon={UserX}
      title="Person not found"
      description="They may have been removed, or the link is wrong."
      action={
        <Link
          href="/people"
          className="inline-flex h-9 items-center rounded-md bg-black px-4 text-sm font-medium text-white hover:bg-gray-600"
        >
          Back to people
        </Link>
      }
    />
  );
}
