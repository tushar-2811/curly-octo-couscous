import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-busy>
      <span className="sr-only">Loading resources</span>
      <Skeleton className="h-8 w-40" />
      <Skeleton className="mt-2 h-4 w-96 max-w-full" />
      <Skeleton className="mt-8 h-9 w-full" />
      <Skeleton className="mt-4 h-64 w-full" />
    </div>
  );
}
