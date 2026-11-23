import { FileQuestion } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/ui/states';

export default function NotFound() {
  return (
    <EmptyState
      icon={FileQuestion}
      title="Page not found"
      description="The page you're looking for doesn't exist or has moved."
      action={
        <Link
          href="/"
          className="inline-flex h-9 items-center rounded-md bg-black px-4 text-sm font-medium text-white hover:bg-gray-600"
        >
          Back to overview
        </Link>
      }
    />
  );
}
