import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-busy>
      <span className="sr-only">Loading people</span>
      <Skeleton className="h-8 w-40" />
      <Skeleton className="mt-2 h-4 w-80" />
      <Skeleton className="mt-8 h-9 w-full" />
      <div className="mt-4 space-y-px">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-none" />
        ))}
      </div>
    </div>
  );
}
